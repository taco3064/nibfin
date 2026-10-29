import {rescueWorkflowFor,rescueNamespace} from './independent-transport.mjs';
import {positive,rescueStop,verifyRescueSource} from './rescue-policy.mjs';

// Detection and repair share one pinned workflow. A completion hint never
// supplies authority, executable content, or permission to replay a write.
export async function detectRescueSource(runtime,grant,event){
 const hint=event.workflow_run,policy=runtime.actionExecutionPolicy(grant);
 if(event.repository?.private!==(policy.visibility!=='public')||!positive(hint?.id)||hint.repository?.full_name!==policy.repository||hint.path!==policy.workflowPath||hint.event!=='workflow_dispatch'||hint.status!=='completed')throw rescueStop('RESCUE_SOURCE_INVALID','Unapproved completion hint');
 const source=await verifyRescueSource(runtime,grant,hint.id);
 if(source.run_attempt!==hint.run_attempt||source.head_sha!==hint.head_sha)throw rescueStop('RESCUE_SOURCE_CHANGED','Completed source identity changed');
 let marker=null;
 if(source.conclusion==='success'){
  const jobs=source.jobs.filter(j=>j.name==='execute'&&j.status==='completed');
  if(jobs.length!==1||!positive(jobs[0].id))throw rescueStop('RESCUE_SOURCE_INVALID','Exact completed execute job is missing');
  const limit=16*1024*1024,bytes=await runtime.github.download('/repos/'+policy.repository+'/actions/jobs/'+jobs[0].id+'/logs',limit);
  if(bytes.length>limit)throw rescueStop('RESCUE_SOURCE_INVALID','Oversized Core log');
  for(const line of bytes.toString('utf8').split('\n')){
   const match=/^(?:\d{4}-\d\d-\d\dT\S+\s+)?(\{"kind":"kairo-rescue-(?:request|resume-observed)".*\})\r?$/.exec(line);
   if(!match)continue;
   try{const item=JSON.parse(match[1]);if(String(item.runId)===String(source.id))marker=item;}catch{}
  }
  if(!marker)return null;
 }else if(!['failure','timed_out','cancelled','startup_failure'].includes(source.conclusion))return null;
 return{inputs:{source_run_id:String(source.id),mode:'repair'}};
}
