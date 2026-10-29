import {readFile,readdir,lstat,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {binding,digest} from './core.mjs';
import {projectUnit,unitId} from './dynamic.mjs';
import {Store} from './store.mjs';
import {candidateContract} from './candidate-contract.mjs';

const uuid=value=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value??'');
// Reuse UNACCEPTED source and its original conversation, never an orphan verdict.
export async function inspectInterruptedWriter(runtime,grant,issue,state,source,timeout){
 const p=state.pending,s=state.issues?.[issue.id];
 if(!timeout||p?.operation!=='deliver'||p.writeAttempted||p.recoveryRequired||String(p.executionContext?.action?.runId)!==String(source.id)||s?.candidate||s?.blocked||state.completion||!s?.shape?.body)return null;
 const projected=projectUnit(grant,issue),effective=projected.manifest.issues[0],authority=binding(projected.manifest,projected.policy);
 if(Object.entries(authority).some(([k,v])=>p[k]!==v)||!Number.isSafeInteger(s.repairs??0)||(s.repairs??0)<0||(s.repairs??0)>=Number.MAX_SAFE_INTEGER)return null;
 const key=digest({repository:issue.repository,issue:issue.id,scope:effective.scopeHash,binding:authority,role:'deliver'}),sessions=new Store(runtime.config.stateDirectory,'role-session:'+key),session=await sessions.read();
 if(!['running','recovery-required','ready'].includes(session.sessionStatus)||session.stage!=='deliver'||!uuid(session.sessionId))return null;
 const directory=join(runtime.config.stateDirectory,'role-sessions',key),files=(await readdir(directory,{recursive:true})).filter(f=>f.endsWith('.jsonl')&&f.includes(session.sessionId));
 if(files.length!==1)return null;
 const path=join(directory,files[0]),meta=await lstat(path);if(!meta.isFile()||meta.isSymbolicLink()||meta.nlink!==1||meta.size>64*1024*1024||await realpath(path)!==resolve(path))return null;
 const lines=(await readFile(path,'utf8')).split('\n').filter(Boolean).map(JSON.parse);
 if(!lines.some(x=>x.type==='session_meta'&&x.payload?.id===session.sessionId&&x.payload?.cwd==='/work'))return null;
 const workspace=runtime.workspace(projected,effective,s),base=await workspace.preparedBase();
 if(!/^[a-f0-9]{40}$/.test(base??'')||base!==p.artifacts?.base)return null;
 return{kind:'interrupted-writer',unit:unitId(grant,issue),sessionKey:key,sessionId:session.sessionId,scopeHash:effective.scopeHash,base,sourceAttempt:s.repairs??0,pendingHash:digest(p),shapeHash:digest(s.shape),sourceRunId:String(source.id),conversationHash:digest(lines)};
}
export const writerSessionStore=(runtime,proof)=>new Store(runtime.config.stateDirectory,'role-session:'+proof.sessionKey);
export async function restoreInterruptedWriter(runtime,grant,issue,unit,state,source,timeout,proof,caseId){
 const fresh=await inspectInterruptedWriter(runtime,grant,issue,state,source,timeout);
 if(digest(fresh)!==digest(proof))throw Error('Interrupted Writer evidence changed');
 const projected=projectUnit(grant,issue),effective=projected.manifest.issues[0],stored=state.issues[issue.id],workspace=runtime.workspace(projected,effective,stored),targetAttempt=proof.sourceAttempt+1;
 const target=runtime.workspace(projected,effective,{repairs:targetAttempt});
 try{await lstat(target.root);throw Error('Recovered Writer target already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
 const seed={...await workspace.snapshotRepair(proof.base,candidateContract(stored.shape.body)),sourceAttempt:proof.sourceAttempt,targetAttempt};
 const sessionStore=writerSessionStore(runtime,proof),session=await sessionStore.read(),at=new Date().toISOString();
 await sessionStore.transaction(session.revision,s=>({...s,sessionStatus:'ready',rescueRecoveries:[...(s.rescueRecoveries??[]),{caseId,proof,at}]}));
 await unit.transaction(state.revision,s=>{
  s.rescueRecoveries=[...(s.rescueRecoveries??[]),{caseId,pending:s.pending,proof,timeout,seed,at}];s.pending=null;
  const writer=s.issues[issue.id];writer.repairs=targetAttempt;writer.repairSeed=seed;
  writer.repairFindings=[...(writer.repairFindings??[]),'The prior provider job timed out. Its original Writer has stopped; continue the same persisted conversation and restored UNACCEPTED source in a fresh bounded execution. No orphan result, old test, Acceptance or CI is adopted. Finish required verification and normal independent gates on the current baseline.'];
  return s;
 });
 return seed;
}
