import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,unlink,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fixture,SHA} from './fixtures.mjs';
import {digest} from '../src/core.mjs';
import {Store} from '../src/store.mjs';
import {projectUnit,unitId,childRuntime} from '../src/dynamic.mjs';
import {prepareUpstreamHandoff,materializeUpstreamHandoff,validateUpstreamHandoff} from '../src/upstream-handoff.mjs';
import {CodexAgent} from '../src/agent.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const blob=b=>createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');
const execution='11111111-1111-4111-8111-111111111111';
async function setup(t){
 const root=await mkdtemp(join(tmpdir(),'kairo-upstream-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const {manifest,policy}=fixture();Object.assign(manifest,{schemaVersion:2,scheduling:'native-dependencies',membership:'fixed-approved-set',proposalHash:digest('fixture proposal')});Object.assign(policy,{controlMode:'owner-project',executionMode:'actions-v1',stateDirectory:root,maxParallel:2});
 for(const i of manifest.issues){i.repositoryId=i.repository==='example/one'?'100':'101';i.scopeBody='Scope '+i.id;i.scopeHash=digest(i.scopeBody);policy.repositories[i.repository].repositoryId=i.repositoryId;}
 const parent={recordId:'authorized',manifest,policy,approval:{verified:true}},consumer=manifest.issues[1],producer=manifest.issues[0],child=projectUnit(parent,consumer),store=new Store(root,child.manifest.id),sourceFiles={'src/index.mjs':Buffer.from('export const observeRunners = () => true;\n'),'docs/interface.md':Buffer.from('Existing upstream public contract\n'),'fixture.bin':Buffer.from([0,255,128,10])};
 const obligations={artifacts:[{path:'out/core.tgz',purpose:'Accepted package'}],hooks:[]},body='Upstream contract\n```kairo-candidate\n'+JSON.stringify(obligations)+'\n```\n',artifact=Buffer.from([31,139,8,0,255]),accepted=join(root,'producer-attempt');await mkdir(join(accepted,'artifacts'),{recursive:true});await writeFile(join(accepted,'artifacts',sha(artifact)),artifact);
 const receipt={operation:'close',issueId:producer.id,completedAt:'fixture'},candidate={repository:producer.repository,base:SHA('a'),tree:SHA('b'),paths:['src/index.mjs'],diffHash:digest('diff'),obligations,artifacts:[{...obligations.artifacts[0],sha256:sha(artifact),size:artifact.length}],hookSources:[]},upstreamStore=new Store(root,unitId(parent,producer));
 await upstreamStore.transaction(0,s=>({...s,completion:{status:'COMPLETE',completionHash:digest('completed'),receiptHash:digest(receipt)},actionReceipts:[receipt],issues:{[producer.id]:{repairs:0,shape:{body,bodyHash:digest(body)},candidate,merge:{verified:true,commit:SHA('c')}}}}));
 let sourceReads=0,dependencies=[{node_id:producer.id}];
 const runtime={config:{stateDirectory:root},github:{dependencies:async()=>dependencies,api:async path=>{assert.equal(path,`/repos/example/one/git/commits/${SHA('c')}`);return{tree:{sha:SHA('b')}};}},workspace:()=>({root:accepted}),workspaceFactory:(path,issue)=>({root:path,work:join(path,'work'),prepare:async commit=>{assert.equal(commit,SHA('c'));sourceReads++;for(const[n,b]of Object.entries(sourceFiles)){await mkdir(join(path,'work',n,'..'),{recursive:true});await writeFile(join(path,'work',n),b);}},provenance:async()=>({tree:SHA('b'),entries:Object.entries(sourceFiles).map(([path,b])=>({path,type:'blob',mode:'100644',oid:blob(b)}))})}),save:(s,v)=>s.transaction(v.revision,()=>v)};
 const state=await store.read(),prepare=(operation='shape')=>prepareUpstreamHandoff(runtime,parent,consumer,child,state,store,operation);
 return{root,parent,child,consumer,producer,store,upstreamStore,state,runtime,prepare,sourceFiles,artifact,accepted,sourceReads:()=>sourceReads,setDependencies:rows=>{dependencies=rows;}};
}
test('Shape automatically receives exact immutable cross-repo source, producer contract and accepted artifact; later stages reuse the same manifest',async t=>{
 const f=await setup(t),record=await f.prepare(),saved=await f.store.read();assert.equal(saved.upstreamHandoff.handoffHash,record.handoffHash);assert.equal(record.producers[0].mergeCommit,SHA('c'));assert.equal(record.producers[0].completionHash,digest('completed'));
 for(const stage of['validate-shape','deliver','accept','shaper-review'])assert.equal((await f.prepare(stage)).handoffHash,record.handoffHash);
 assert.equal(f.sourceReads(),1,'No floating latest or implicit package refresh');
 const materialized=await materializeUpstreamHandoff(f.root,execution,record),directory=record.producers[0].directory;
 for(const[n,b]of Object.entries(f.sourceFiles))assert.deepEqual(await readFile(join(materialized.directory,directory,'source',n)),b);
 assert.deepEqual(await readFile(join(materialized.directory,directory,'artifacts/out/core.tgz')),f.artifact);
 assert.equal(materialized.receipt.handoffHash,record.handoffHash);assert.equal(materialized.receipt.manifest,'/upstream/manifest.json');assert.ok(!materialized.directory.startsWith(join(f.root,'executions')));
});
for(const mode of['missing artifact','corrupt artifact','unverified completion','forged receipt','artifact omitted from Candidate','merged tree differs','source bytes differ'])test('refuses to start Shape with '+mode,async t=>{
 const f=await setup(t),artifactPath=join(f.accepted,'artifacts',sha(f.artifact));
 if(mode==='missing artifact')await unlink(artifactPath);
 if(mode==='corrupt artifact')await writeFile(artifactPath,Buffer.alloc(f.artifact.length));
 if(['unverified completion','forged receipt','artifact omitted from Candidate'].includes(mode)){const s=await f.upstreamStore.read();await f.upstreamStore.transaction(s.revision,x=>{if(mode==='unverified completion')x.completion.status='WAITING';if(mode==='forged receipt')x.actionReceipts[0].issueId='another';if(mode==='artifact omitted from Candidate')x.issues[f.producer.id].candidate.artifacts=[];return x;});}
 if(mode==='merged tree differs')f.runtime.github.api=async()=>({tree:{sha:SHA('d')}});
 if(mode==='source bytes differ'){const factory=f.runtime.workspaceFactory;f.runtime.workspaceFactory=(...args)=>{const w=factory(...args),p=w.provenance;w.provenance=async()=>{const o=await p();o.entries[0].oid=SHA('e');return o;};return w;};}
 await assert.rejects(f.prepare());assert.equal((await f.store.read()).upstreamHandoff,undefined);
});
test('producer revision and dependency edge changes cannot silently replace Shape inputs',async t=>{
 const f=await setup(t),record=await f.prepare(),s=await f.upstreamStore.read();await f.upstreamStore.transaction(s.revision,x=>{x.issues[f.producer.id].merge.commit=SHA('d');return x;});
 await assert.rejects(f.prepare('deliver'),{code:'UPSTREAM_HANDOFF_CHANGED'});assert.equal((await f.store.read()).upstreamHandoff.handoffHash,record.handoffHash);
 f.setDependencies([]);await assert.rejects(f.prepare('deliver'),{code:'UPSTREAM_HANDOFF_CHANGED'});
});
test('corrupt retained bytes and unsafe or modified manifests fail before Agent execution',async t=>{
 const f=await setup(t),record=await f.prepare(),entry=record.files[0];await chmod(join(f.root,'upstream-input-blobs',entry.sha256),0o600);await writeFile(join(f.root,'upstream-input-blobs',entry.sha256),'corrupt');await assert.rejects(materializeUpstreamHandoff(f.root,execution,record));
 const changed=structuredClone(record);changed.files[0].name='../escape';const {handoffHash,...payload}=changed;changed.handoffHash=digest(payload);assert.throws(()=>validateUpstreamHandoff(changed),{code:'UPSTREAM_HANDOFF_UNAVAILABLE'});
 const tampered=structuredClone(record);tampered.producers[0].mergeCommit=SHA('d');assert.throws(()=>validateUpstreamHandoff(tampered));
});
test('same-repo dependencies are not exported; pre-rollout Shapes and non-owner grants keep their original evidence',async t=>{
 const f=await setup(t);assert.equal(await f.prepare('deliver'),null);assert.equal((await f.store.read()).upstreamHandoff,undefined);
 f.setDependencies([{node_id:f.parent.manifest.issues[2].id}]);f.parent.manifest.issues[2].repository=f.consumer.repository;const r=await f.prepare();assert.deepEqual(r.producers,[]);assert.equal(f.sourceReads(),0);assert.equal(await materializeUpstreamHandoff(f.root,execution,r),null);
 const other=await setup(t);other.parent.policy.controlMode=undefined;assert.equal(await other.prepare(),null);
});
test('Agent context/evidence includes the manifest and Docker mounts it read-only separately from work, IO and signed delivery inputs',async t=>{
 const f=await setup(t),record=await f.prepare();for(const role of['shape','shape-validator','deliver','accept']){await mkdir(join(f.root,'skills',role==='shape-validator'?'shape':role),{recursive:true});}
 for(const skill of['shape','deliver','accept'])await writeFile(join(f.root,'skills',skill,'SKILL.md'),`---\nname: ${skill}\n---\nFixture role.\n`);
 const config={image:'sha256:'+'a'.repeat(64),network:'isolated-fixture',user:'1000:1000',authDirectory:join(f.root,'auth')};let calls=0;
 const agent=new CodexAgent(config,f.root,f.root,async(cmd,args)=>{assert.equal(cmd,'docker');const upstream=args.find(a=>a.includes('dst=/upstream,'));assert.ok(upstream.endsWith(',readonly'));assert.ok(!upstream.includes('dst=/work'));const io=args.find(a=>a.includes('dst=/io')).split(',').find(a=>a.startsWith('src=')).slice(4);const context=JSON.parse(await readFile(join(io,'context.json'),'utf8'));assert.equal(context.upstreamHandoff.handoffHash,record.handoffHash);await writeFile(join(io,'result.json'),JSON.stringify({outcome:'accepted',body:'',summary:'Fixture',rootCause:'',failureClass:'none',evidenceReferences:['/upstream/manifest.json'],blockingFindings:[],contractConflicts:[]}));calls++;return{stdout:[{type:'thread.started',thread_id:execution},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:await readFile(join(io,'result.json'),'utf8')}},{type:'turn.completed'}].map(JSON.stringify).join('\n'),stderr:''};});agent.login=async()=>{};agent.credentialValues=async()=>[];
 const result=await agent.executeTurn('accept',{issue:{id:f.consumer.id}},f.root,null,null,null,record);assert.equal(result.upstreamHandoff.handoffHash,record.handoffHash);assert.equal(calls,1);
 const args=agent.executionArgs(f.root,join(f.root,'io'),true,null,join(f.root,'approved-input'),join(f.root,'upstream'));assert.ok(args.some(x=>x.includes('dst=/inputs,readonly')));assert.ok(args.some(x=>x.includes('dst=/upstream,readonly')));
});
test('dynamic execution waits durably before calling an Agent, then resumes with frozen input after the missing bytes are restored',async t=>{
 const f=await setup(t);let calls=0;
 class ProbeRuntime{
  constructor(config,root,github,agent,workspaceFactory){Object.assign(this,{config,root,github,agent,workspaceFactory});}
  async observe(){return{};}
  async execute(){calls++;return this.upstreamHandoff;}
  save(store,state){return store.transaction(state.revision,()=>state);}
  workspace(){return{root:f.accepted};}
 }
 const parent=new ProbeRuntime(f.runtime.config,f.root,f.runtime.github,{},f.runtime.workspaceFactory),child=childRuntime(parent,f.parent,f.consumer,false),decision={operation:'shape',issueId:f.consumer.id};
 f.state.pending=decision;await unlink(join(f.accepted,'artifacts',sha(f.artifact)));
 await assert.rejects(child.execute(f.child,f.state,{},decision,f.store),{code:'UPSTREAM_HANDOFF_UNAVAILABLE'});
 assert.equal(calls,0);const waiting=await f.store.read();assert.equal(waiting.pending,null);assert.equal(waiting.upstreamHandoffWait.code,'UPSTREAM_HANDOFF_UNAVAILABLE');
 await writeFile(join(f.accepted,'artifacts',sha(f.artifact)),f.artifact);
 const record=await child.execute(f.child,f.state,{},decision,f.store);assert.equal(calls,1);assert.equal((await f.store.read()).upstreamHandoffWait,undefined);
 assert.equal((await child.execute(f.child,f.state,{}, {operation:'deliver',issueId:f.consumer.id},f.store)).handoffHash,record.handoffHash);
});
