import{createHmac,timingSafeEqual}from'node:crypto';
import{readFile,lstat,mkdir}from'node:fs/promises';
import{watch}from'node:fs';
import{binding,digest}from'./core.mjs';
import{outside}from'./authority.mjs';
import{Store}from'./store.mjs';
import{positive,verifyRescueSource,providerTimeoutEvidence,cleanRescueText}from'./rescue-policy.mjs';
import{rescueIndexStore,rescueCaseStore,eligibleRescueRecheck}from'./rescue.mjs';
import{loadRescueWakeupGrant,wakeCase}from'./rescue-wakeup.mjs';

const indexStore=(r,g)=>new Store(r.config.stateDirectory,'rescue-completion-index:'+g.policy.grantId);
const eventStore=(r,id)=>new Store(r.config.stateDirectory,'rescue-completion:'+id);
async function matchingCases(r,g,id){const out=[];for(const caseId of Object.keys((await rescueIndexStore(r,g).read()).cases??{})){const state=await rescueCaseStore(r,caseId).read();if(state.request&&[state.request.sourceRunId,state.resumeRunId].includes(String(id)))out.push({caseId,state});}return out;}
export async function loadRescueCompletionSecret(path,runtime){
 if(!path||!outside(runtime.root,path)||!outside(runtime.config.stateDirectory,path)||!outside(runtime.config.agent.authDirectory,path))throw Error('Webhook secret must remain outside Core, state and Agent mounts');
 const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==0||s.nlink!==1||(s.mode&0o027)!==0)throw Error('Webhook secret must be a protected root-owned file');
 const secret=await readFile(path);if(secret.length<32||secret.length>256)throw Error('Invalid webhook secret length');return secret;
}
// Authenticate exact provider bytes before parsing. Notifications are hints only;
// the host and then Rescue independently reread provider provenance and authority.
export async function receiveRescueCompletion(runtime,grant,secret,bytes,headers){
 const signature=headers['x-hub-signature-256'];
 if(!/^sha256=[a-f0-9]{64}$/.test(signature??'')||!timingSafeEqual(Buffer.from(signature.slice(7),'hex'),createHmac('sha256',secret).update(bytes).digest()))throw Error('Invalid Rescue webhook signature');
 const event=JSON.parse(bytes.toString('utf8'));
 if(headers['x-github-event']==='ping')return{status:'IGNORED',reason:'PING'};
 if(headers['x-github-event']!=='workflow_run'||event.action!=='completed')return{status:'IGNORED',reason:'UNRELATED_EVENT'};
 const policy=runtime.actionExecutionPolicy(grant),hint=event.workflow_run;
 if(event.repository?.private!==true||event.repository.full_name!==policy.repository||String(event.repository.id)!==String(policy.repositoryId)||!positive(hint?.id)||!positive(hint.run_attempt)||!(/^[a-f0-9]{40}$/).test(hint.head_sha??'')||hint.path!==policy.workflowPath||hint.event!=='workflow_dispatch'||hint.head_branch!=='main'||hint.status!=='completed')return{status:'IGNORED',reason:'UNRELATED_SOURCE'};
 // Cases are committed before a successful Core return. No case means no
 // recovery work: do not create a workflow, download logs or allocate a Runner.
 if(hint.conclusion==='success'&&!(await matchingCases(runtime,grant,hint.id)).length)return{status:'IGNORED',reason:'NORMAL_COMPLETION'};
 if(!['success','failure','timed_out','cancelled','startup_failure'].includes(hint.conclusion))return{status:'IGNORED',reason:'NO_RECOVERY_SIGNAL'};
 const id=digest({authority:binding(grant.manifest,grant.policy),runId:String(hint.id),attempt:hint.run_attempt}),store=eventStore(runtime,id);
 await store.metadataLease(async()=>{const s=await store.read();if(s.hint)return;await store.transaction(s.revision,v=>({...v,hint:{runId:String(hint.id),attempt:hint.run_attempt,headSha:hint.head_sha},authority:binding(grant.manifest,grant.policy),status:'pending',nextCheckAt:new Date().toISOString(),receivedAt:new Date().toISOString()}));});
 const index=indexStore(runtime,grant);await index.metadataLease(async()=>{const s=await index.read();if(s.items?.[id])return;await index.transaction(s.revision,v=>({...v,items:{...v.items,[id]:true}}));});
 return{status:'ACCEPTED',id};
}
export async function processRescueCompletions(runtime,grant,{now=Date.now}={}){
 const index=await indexStore(runtime,grant).read(),results=[];
 for(const id of Object.keys(index.items??{})){
  const store=eventStore(runtime,id),current=await store.read();if(current.status!=='pending'||Date.parse(current.nextCheckAt)>now())continue;
  results.push(await store.metadataLease(async()=>{
   let s=await store.read();if(s.status!=='pending')return{status:s.status};
   try{
    if(digest(s.authority)!==digest(binding(grant.manifest,grant.policy)))throw Error('Completion authority changed');
    const source=await verifyRescueSource(runtime,grant,s.hint.runId);
    if(source.run_attempt!==s.hint.attempt||source.head_sha!==s.hint.headSha)throw Error('Completion source changed');
    const cases=await matchingCases(runtime,grant,source.id);
    if(source.conclusion==='cancelled'&&!await providerTimeoutEvidence(runtime,grant,source)){
     await store.transaction(s.revision,v=>({...v,status:'ignored',reason:'UNATTRIBUTED_CANCELLATION',nextCheckAt:null}));return{status:'ignored'};
    }
    for(const c of cases){
     if(!eligibleRescueRecheck(c.state))continue;
     if(c.state.repairCode==='RESCUE_COOLDOWN'&&Date.parse(c.state.nextCheckAt)>now())continue;
     await wakeCase(runtime,grant,c.caseId);
    }
    if(!cases.length&&source.conclusion!=='success'){
     // A provider-proven crash/timeout may occur before Core can register a
     // case. Persist intent first; an uncertain POST is never replayed.
     s=await store.transaction(s.revision,v=>({...v,status:'attempted',attemptedAt:new Date().toISOString()}));
     const result=await runtime.github.api('/repos/'+runtime.actionExecutionPolicy(grant).repository+'/actions/workflows/kairo-rescue.yml/dispatches','POST',{ref:'main',inputs:{source_run_id:String(source.id),reason_code:'PROVIDER_FAILURE',mode:'repair'},return_run_details:true},'2022-11-28');
     if(!positive(result?.workflow_run_id))throw Error('Rescue dispatch outcome is uncertain');
     await store.transaction(s.revision,v=>({...v,status:'confirmed',rescueRunId:String(result.workflow_run_id),nextCheckAt:null}));return{status:'confirmed',runId:String(result.workflow_run_id)};
    }
    await store.transaction(s.revision,v=>({...v,status:'processed',nextCheckAt:null}));return{status:'processed'};
   }catch(error){
    const latest=await store.read(),tries=(latest.readAttempts??0)+1;
    const retry=latest.status==='pending'&&(error.code==='RESCUE_SOURCE_ACTIVE'||error.requestMethod==='GET'||['EEXIST','GITHUB_READ_UNAVAILABLE','GITHUB_RATE_LIMIT'].includes(error.code))&&tries<8;
    await store.transaction(latest.revision,v=>({...v,status:retry?'pending':'unresolved',readAttempts:tries,nextCheckAt:retry?new Date(Math.max(now()+Math.min(900000,15000*2**(tries-1)),error.retryAt??0)).toISOString():null,error:cleanRescueText(error.message)}));
    console.error(JSON.stringify({kind:'kairo-rescue-completion-error',id,status:retry?'pending':'unresolved',reason:cleanRescueText(error.message)}));return{status:retry?'pending':'unresolved'};
   }
  }));
  if(results.length>=10)break;
 }
 return results;
}
export async function startRescueCompletions(runtime,loadGrant=()=>loadRescueWakeupGrant(runtime)){
 const grant=await loadGrant(),index=indexStore(runtime,grant);let closed=false,running=false,again=false,timer=null;
 await mkdir(index.directory,{recursive:true});
 const refresh=async()=>{
  if(closed)return;if(running){again=true;return;}running=true;clearTimeout(timer);timer=null;
  try{
   const items=Object.keys((await index.read()).items??{}),due=[];for(const id of items){const s=await eventStore(runtime,id).read();if(s.status==='pending'&&Date.parse(s.nextCheckAt)<=Date.now())due.push(id);}
   if(due.length){const fresh=await loadGrant();if(digest(binding(fresh.manifest,fresh.policy))!==digest(binding(grant.manifest,grant.policy)))throw Error('Completion authority changed; restart notifier');await processRescueCompletions(runtime,fresh);}
  }catch(error){
   console.error(JSON.stringify({kind:'kairo-rescue-completion-error',reason:cleanRescueText(error.message)}));
   for(const id of Object.keys((await index.read()).items??{})){const store=eventStore(runtime,id),s=await store.read();if(s.status!=='pending'||Date.parse(s.nextCheckAt)>Date.now())continue;await store.metadataLease(async()=>{const v=await store.read(),tries=(v.readAttempts??0)+1;await store.transaction(v.revision,x=>({...x,readAttempts:tries,status:tries<8?'pending':'unresolved',nextCheckAt:tries<8?new Date(Date.now()+Math.min(900000,15000*2**(tries-1))).toISOString():null,error:cleanRescueText(error.message)}));});}
  }
  finally{
   const pending=[];for(const id of Object.keys((await index.read()).items??{})){const s=await eventStore(runtime,id).read();if(s.status==='pending')pending.push(Date.parse(s.nextCheckAt));}
   if(!closed&&pending.length)timer=setTimeout(()=>void refresh(),Math.min(2147483647,Math.max(15000,Math.min(...pending)-Date.now())));
   running=false;if(again&&!closed){again=false;queueMicrotask(()=>void refresh());}
  }
 };
 const watcher=watch(index.directory,()=>void refresh());watcher.on('error',error=>console.error(cleanRescueText(error.message)));
 await refresh();return{close(){closed=true;clearTimeout(timer);watcher.close();},refresh};
}
