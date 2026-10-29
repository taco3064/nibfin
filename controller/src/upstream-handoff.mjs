import {createHash,randomUUID} from 'node:crypto';
import {mkdir,lstat,readFile,writeFile,link,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {binding,canonical,digest} from './core.mjs';
import {Store} from './store.mjs';
import {projectUnit,unitId} from './dynamic.mjs';
import {candidateContract,safeCandidatePath} from './candidate-contract.mjs';

// These are data limits, never an excuse to omit an input and start an Agent.
const limits={files:10000,fileBytes:64*1024*1024,totalBytes:256*1024*1024};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const gitBlob=bytes=>createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
const fail=(code,reason)=>{throw Object.assign(new Error(reason),{code});};
const requireThat=(ok,reason)=>{if(!ok)fail('UPSTREAM_HANDOFF_UNAVAILABLE',reason);};
const oid=value=>/^[a-f0-9]{40}$/.test(value||'');
const hash=value=>/^[a-f0-9]{64}$/.test(value||'');
const safePath=value=>typeof value==='string'&&value.length>0&&!/[\x00-\x1f\x7f\\:]/.test(value)&&!value.startsWith('/')&&value.split('/').every(p=>p&&!['.','..','.git'].includes(p.toLowerCase()));
const blobPath=(root,id)=>join(root,'upstream-input-blobs',id);
async function readBounded(path,expectedSize){
 let stat;try{stat=await lstat(path);}catch(e){if(e.code==='ENOENT')fail('UPSTREAM_HANDOFF_UNAVAILABLE','Required upstream input bytes are missing');throw e;}
 requireThat(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=limits.fileBytes&&(expectedSize===undefined||stat.size===expectedSize),'Missing, oversized or nonregular upstream input');
 const bytes=await readFile(path);
 requireThat(bytes.length===stat.size,'Upstream input changed while reading');return bytes;
}
async function retain(root,bytes){
 requireThat(bytes.length<=limits.fileBytes,'Upstream input exceeds the per-file data bound');
 const id=sha(bytes);await mkdir(join(root,'upstream-input-blobs'),{recursive:true,mode:0o700});
 const temporary=blobPath(root,id)+'.'+randomUUID()+'.tmp';
 await writeFile(temporary,bytes,{flag:'wx',mode:0o400});
 try{try{await link(temporary,blobPath(root,id));}catch(e){if(e.code!=='EEXIST')throw e;}}finally{await unlink(temporary);}
 requireThat(sha(await readBounded(blobPath(root,id),bytes.length))===id,'Retained upstream input differs');return{id,bytes:bytes.length};
}
const subject=(grant,issue)=>({repository:issue.repository,repositoryId:issue.repositoryId,issueId:issue.id,unitId:grant.manifest.id,scopeHash:issue.scopeHash,authority:binding(grant.manifest,grant.policy)});
export function validateUpstreamHandoff(record){
 const {handoffHash,...payload}=record||{};
 requireThat(payload.schemaVersion===1&&payload.kind==='cross-repository-handoff'&&hash(handoffHash)&&digest(payload)===handoffHash&&Array.isArray(payload.producers)&&Array.isArray(payload.files),'Upstream handoff manifest integrity differs');
 const folders=new Set(payload.producers.map(p=>p.directory));
 requireThat(folders.size===payload.producers.length&&[...folders].every(hash),'Invalid upstream producer directories');
 let total=0;const names=new Set();
 requireThat(payload.files.length<=limits.files,'Too many upstream inputs');
 for(const f of payload.files){
  requireThat(safePath(f.name)&&folders.has(f.name.split('/')[0])&&!names.has(f.name)&&hash(f.sha256)&&Number.isSafeInteger(f.bytes)&&f.bytes>=0&&f.bytes<=limits.fileBytes&&['100644','100755'].includes(f.mode),'Invalid upstream input manifest');
  names.add(f.name);total+=f.bytes;
 }
 requireThat(total<=limits.totalBytes,'Upstream handoff exceeds total data bound');return record;
}
async function producerProof(runtime,parent,producer){
 const projected=projectUnit(parent,producer),issue=projected.manifest.issues[0],id=unitId(parent,producer),state=await new Store(runtime.config.stateDirectory,id).read(),stored=state.issues?.[producer.id];
 requireThat(state.completion?.status==='COMPLETE'&&hash(state.completion.completionHash)&&!state.pending&&stored?.merge?.verified&&oid(stored.merge.commit)&&oid(stored.candidate?.tree)&&stored.shape?.bodyHash===digest(stored.shape.body),`${producer.repository} #${producer.number}: current verified completion, Candidate and Shape are required`);
 const receipt=state.actionReceipts?.findLast(r=>['close','mark-delivered'].includes(r.operation));
 if(parent.policy.executionMode==='actions-v1')requireThat(receipt&&state.completion.receiptHash===digest(receipt),`${producer.repository} #${producer.number}: completion receipt differs`);
 const obligations=candidateContract(stored.shape.body);
 requireThat(canonical(obligations)===canonical(stored.candidate.obligations)&&canonical(obligations.artifacts.map(a=>({path:a.path,purpose:a.purpose})))===canonical((stored.candidate.artifacts||[]).map(a=>({path:a.path,purpose:a.purpose}))),`${producer.repository} #${producer.number}: accepted artifact inventory differs from Shape`);
 return{projected,issue,state,stored,proof:{repository:producer.repository,repositoryId:producer.repositoryId,issueId:producer.id,number:producer.number,unitId:id,scopeHash:issue.scopeHash,shapeHash:stored.shape.bodyHash,mergeCommit:stored.merge.commit,tree:stored.candidate.tree,candidateHash:digest(stored.candidate),completionHash:state.completion.completionHash,receiptHash:state.completion.receiptHash||null,directory:digest({repository:producer.repository,issueId:producer.id})}};
}

// Called while the consumer's stable Issue and unit execution leases are held.
// Owner-project consumers bind their input once, before the first Shape call.
export async function prepareUpstreamHandoff(runtime,parent,consumer,childGrant,state,store,operation){
 if(parent.policy.controlMode!=='owner-project')return null;
 const current=state.upstreamHandoff;
 if(!current&&operation!=='shape')return null; // Pre-rollout approved Shapes retain their original evidence.
 const dependencies=await runtime.github.dependencies(consumer),ids=dependencies.map(d=>d.node_id);
 requireThat(ids.every(id=>typeof id==='string')&&new Set(ids).size===ids.length,'Invalid native dependency identities');
 const producers=[];
 for(const id of ids){const producer=parent.manifest.issues.find(i=>i.id===id);requireThat(producer,'Upstream dependency is outside the authenticated parent');if(producer.repository!==consumer.repository)producers.push(producer);}
 producers.sort((a,b)=>a.id.localeCompare(b.id));
 const consumerView=childGrant.manifest.issues[0],identity=subject(childGrant,consumerView),resolved=[];
 for(const p of producers)resolved.push(await producerProof(runtime,parent,p));
 const proofs=resolved.map(r=>r.proof);
 if(current){
  validateUpstreamHandoff(current);
  if(canonical(current.consumer)!==canonical(identity)||canonical(current.producers)!==canonical(proofs))fail('UPSTREAM_HANDOFF_CHANGED','Cross-repository inputs changed since Shape; preserve the old handoff and reconcile a new Shape cycle before execution');
  for(const f of current.files)requireThat(sha(await readBounded(blobPath(runtime.config.stateDirectory,f.sha256),f.bytes))===f.sha256,'Frozen upstream input is missing or corrupt');
  return current;
 }
 const root=runtime.config.stateDirectory,files=[];let total=0;
 const add=async(name,bytes,extra={})=>{total+=bytes.length;requireThat(files.length<limits.files&&total<=limits.totalBytes,'Upstream input exceeds bounded snapshot capacity');const held=await retain(root,bytes);files.push({name,sha256:held.id,bytes:held.bytes,mode:'100644',...extra});};
 for(const r of resolved){
  const {proof,stored}=r,merged=await runtime.github.api(`/repos/${proof.repository}/git/commits/${proof.mergeCommit}`);
  requireThat(merged.tree?.sha===proof.tree,`${proof.repository} #${proof.number}: merged tree differs from accepted Candidate`);
  // Dedicated controller-only Git checkout; neither producer nor consumer Agent mounts it.
  const source=runtime.workspaceFactory(join(root,'upstream-source-cache',digest(proof)),r.issue);
  await new Store(root,'upstream-source:'+digest(proof)).lease(async()=>{
   await source.prepare(proof.mergeCommit);const observed=await source.provenance(proof.mergeCommit);
   requireThat(observed.tree===proof.tree&&Array.isArray(observed.entries),`${proof.repository}: immutable source observation differs`);
   for(const entry of observed.entries){
    requireThat(safePath(entry.path)&&entry.type==='blob'&&['100644','100755'].includes(entry.mode)&&oid(entry.oid),'Unsupported upstream source path or Git entry');
    const bytes=await readBounded(join(source.work,entry.path));requireThat(gitBlob(bytes)===entry.oid,'Upstream source differs from its immutable Git blob');
    await add(`${proof.directory}/source/${entry.path}`,bytes,{mode:entry.mode,gitBlob:entry.oid});
   }
  },{waitMs:120000});
  await add(`${proof.directory}/scope.md`,Buffer.from(r.issue.scopeBody));
  await add(`${proof.directory}/shape.md`,Buffer.from(stored.shape.body));
  const accepted=runtime.workspace(r.projected,r.issue,stored);
  for(const artifact of stored.candidate.artifacts||[]){
   requireThat(safeCandidatePath(artifact.path)&&hash(artifact.sha256)&&Number.isSafeInteger(artifact.size),'Invalid accepted upstream artifact');
   const bytes=await readBounded(join(accepted.root,'artifacts',artifact.sha256),artifact.size);requireThat(sha(bytes)===artifact.sha256,`${proof.repository}: accepted artifact bytes differ`);
   await add(`${proof.directory}/artifacts/${artifact.path}`,bytes,{purpose:artifact.purpose,producerPath:artifact.path});
  }
 }
 files.sort((a,b)=>a.name.localeCompare(b.name));
 const latestIds=(await runtime.github.dependencies(consumer)).map(d=>d.node_id).sort();
 if(canonical([...ids].sort())!==canonical(latestIds))fail('UPSTREAM_HANDOFF_CHANGED','Native dependencies changed while preparing the Shape handoff; retry against the current graph');
 for(let n=0;n<producers.length;n++)if(canonical((await producerProof(runtime,parent,producers[n])).proof)!==canonical(proofs[n]))fail('UPSTREAM_HANDOFF_CHANGED','Producer completion changed while preparing the Shape handoff; retry with current evidence');
 const payload={schemaVersion:1,kind:'cross-repository-handoff',consumer:identity,producers:proofs,files},record=validateUpstreamHandoff({...payload,handoffHash:digest(payload)});
 state.upstreamHandoff=record;state.revision=(await runtime.save(store,state)).revision;
 return record;
}

export async function waitForUpstreamHandoff(runtime,state,store,decision,error){
 if(!['UPSTREAM_HANDOFF_UNAVAILABLE','UPSTREAM_HANDOFF_CHANGED'].includes(error.code))throw error;
 const wait={code:error.code,reason:error.message,operation:decision.operation,issueId:decision.issueId,at:new Date().toISOString()};
 state.upstreamHandoffWait=wait;state.pending=null;state.events.push({...wait,kind:'upstream-input-wait'});
 state.revision=(await runtime.save(store,state)).revision;return wait;
}

// Hash-derived blobs become a fresh read-only mount, outside every writable mount.
export async function materializeUpstreamHandoff(root,executionId,record){
 if(!record)return null;validateUpstreamHandoff(record);if(!record.producers.length)return null;
 requireThat(/^[a-f0-9-]{36}$/.test(executionId),'Invalid upstream snapshot execution identity');
 const directory=join(root,'upstream-input-snapshots',executionId);await mkdir(directory,{recursive:true,mode:0o700});
 for(const f of record.files){
  const bytes=await readBounded(blobPath(root,f.sha256),f.bytes);requireThat(sha(bytes)===f.sha256,'Upstream snapshot blob differs');
  const path=join(directory,...f.name.split('/'));await mkdir(join(path,'..'),{recursive:true,mode:0o700});await writeFile(path,bytes,{flag:'wx',mode:f.mode==='100755'?0o500:0o400});
 }
 await writeFile(join(directory,'manifest.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o400});
 return{directory,receipt:{handoffHash:record.handoffHash,manifest:'/upstream/manifest.json',producers:record.producers.map(p=>({...p,source:`/upstream/${p.directory}/source`,artifacts:`/upstream/${p.directory}/artifacts`,scope:`/upstream/${p.directory}/scope.md`,shape:`/upstream/${p.directory}/shape.md`})),boundary:'Read-only producer evidence; not execution authority or a replacement for consumer Scope/Shape. Verify manifest identities; adapt the consumer loader through normal implementation, never substitute an old pinned package.'}};
}
