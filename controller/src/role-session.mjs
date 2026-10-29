import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { digest } from './core.mjs';
import { Store } from './store.mjs';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const sessionRole = stage => stage === 'shape' || stage === 'shaper-review' ? 'shaper' : stage === 'deliver' ? 'deliver' : null;
export async function withRoleSession(root, stage, context, work) {
 const role=sessionRole(stage);
 if (!role) return work(null);
 if (!context.issue?.id || !context.issue.repository || !context.binding) throw Error('Role session requires bound Issue authority');
 const key=digest({repository:context.issue.repository,issue:context.issue.id,scope:context.issue.scopeHash,binding:context.binding,role});
 const store=new Store(root,'role-session:'+key), directory=join(root,'role-sessions',key);
 return store.lease(async()=>{
  let state=await store.read();
  if(state.sessionStatus && state.sessionStatus!=='ready') throw Error('Role session requires recovery: '+state.sessionStatus);
  if(stage==='shaper-review'&&!state.sessionId)throw Error('Original Shaper session is missing');
  await mkdir(directory,{recursive:true,mode:0o700});
  if(state.sessionId){
   const files=await readdir(directory,{recursive:true});
   if(!files.some(f=>f.endsWith('.jsonl')&&f.includes(state.sessionId)))throw Error('Original role session data is missing');
  }
  state=await store.transaction(state.revision,s=>({...s,sessionStatus:'running',stage}));
  try{
   const result=await work({directory,id:state.sessionId||null,role});
   const id=result.session?.id;
   if(!uuid.test(id||'') || state.sessionId && state.sessionId!==id)throw Error('Role session identity mismatch');
   const files=await readdir(directory,{recursive:true});
   if(!files.some(f=>f.endsWith('.jsonl')&&f.includes(id)))throw Error('Role session was not persisted');
   await store.transaction(state.revision,s=>({...s,sessionStatus:'ready',sessionId:id,lastExecution:result.executionId}));
   return result;
  }catch(e){await store.transaction(state.revision,s=>({...s,sessionStatus:'recovery-required'}));throw e;}
 });
}
export function sessionIdFromEvents(stdout) {
 const ids=new Set(stdout.split('\n').flatMap(line=>{try{const e=JSON.parse(line);return e.type==='thread.started'&&uuid.test(e.thread_id||'')?[e.thread_id]:[];}catch{return [];}}));
 if(ids.size!==1)throw Error('Missing or ambiguous Codex session identity');
 return [...ids][0];
}
