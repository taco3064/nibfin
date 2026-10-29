import {readFile,lstat,readdir,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {digest} from './core.mjs';
import {unitId} from './dynamic.mjs';
import {revisionProjection} from './requirement-revision.mjs';
import {verifyRescueSource} from './rescue-policy.mjs';
import {validateBudget} from './verification-runner.mjs';
import {Store} from './store.mjs';
import {sessionRole} from './role-session.mjs';

const sha=value=>/^[a-f0-9]{40}$/.test(value??'');
const uuid=value=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value??'');
const enabled=(runtime,kind)=>kind==='verification-io'?runtime.coreUpgrade?.rescueAssistance?.verificationIo===true:runtime.coreUpgrade?.rescueContinuations?.includes(kind);
async function json(path,limit=1024*1024){
 const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit||await realpath(path)!==resolve(path))throw Error('Unsafe recovery evidence');
 return JSON.parse(await readFile(path,'utf8'));
}

// A receipt authorizes no test result: it only explains why the same authorized
// role may receive one fresh bounded execution. All stage gates run normally.
export async function verificationContinuation(runtime,grant,issue,stored){
 if(!enabled(runtime,'verification-budget')&&!enabled(runtime,'verification-io'))return null;
 const blocked=stored.blocked;
 if(blocked?.outcome!=='blocked'||blocked.failureClass!=='external_failure'||!uuid(blocked.executionId)||!['deliver','accept','shape-validator','shaper-review'].includes(blocked.stage)||blocked.contractConflicts?.length)return null;
 try{
  const root=join(runtime.config.stateDirectory,'executions',blocked.executionId),context=await json(join(root,'context.json')),result=await json(join(root,'validated-result.json'));
  const effective=revisionProjection(grant,issue)?.issue??issue;
  if(context.issue?.id!==issue.id||context.issue.repository!==issue.repository||context.issue.scopeHash!==effective.scopeHash||context.cohort?.id!==unitId(grant,issue)||context.skillSelection?.stage!==blocked.stage||Object.entries(result).some(([k,v])=>digest(v)!==digest(blocked[k]??null)))return null;
  if(digest(context.candidate??null)!==digest(stored.candidate??null)||digest(context.shape??null)!==digest(stored.shape?.body??null))return null;
  const role=sessionRole(blocked.stage);
  if(role){const key=digest({repository:context.issue.repository,issue:issue.id,scope:effective.scopeHash,binding:context.binding,role});
   const session=await new Store(runtime.config.stateDirectory,'role-session:'+key).read();
   if(session.sessionStatus!=='ready'||session.lastExecution!==blocked.executionId||!uuid(session.sessionId))return null;
  }
  const budget=validateBudget(await json(join(root,'verification-budget.json'))),directory=join(root,'verification');
  const names=(await readdir(directory)).filter(n=>uuid(n.slice(0,-5))&&n.endsWith('.json'));if(names.length>200)return null;
  const receipts=[],all=[];
  for(const name of names){const r=await json(join(directory,name));
   if(!uuid(r.id)||name!==r.id+'.json'||r.schemaVersion!==1||r.deadlineAt!==budget.stopVerificationAt||!Number.isSafeInteger(r.startedAt)||!Number.isSafeInteger(r.finishedAt)||r.startedAt<budget.startedAt||r.finishedAt<r.startedAt||r.finishedAt>budget.deadlineAt+30000)return null;
   all.push(r);
   if(r.status==='budget_exhausted'&&r.exitCode===124||r.status==='output_error'&&r.exitCode===74&&r.errorCode==='EPIPE')receipts.push({id:r.id,status:r.status,exitCode:r.exitCode,...(r.errorCode?{errorCode:r.errorCode}:{})});
  }
  const latest=all.sort((a,b)=>b.finishedAt-a.finishedAt)[0];
  const kind=latest?.status==='budget_exhausted'&&latest.exitCode===124&&enabled(runtime,'verification-budget')?'verification-budget':latest?.status==='output_error'&&latest.exitCode===74&&latest.errorCode==='EPIPE'&&enabled(runtime,'verification-io')?'verification-io':null;
  if(!receipts.length||!kind||!sha(context.repositoryObservation?.base))return null;
  const source=await verifyRescueSource(runtime,grant,context.executionContext?.action?.runId);if(source.conclusion==='cancelled'||budget.startedAt<Date.parse(source.run_started_at??source.created_at)-60000||all.some(r=>r.finishedAt>Date.parse(source.updated_at)+60000))return null;
  return{kind,executionId:blocked.executionId,sourceRunId:String(source.id),stage:blocked.stage,unit:unitId(grant,issue),scopeHash:effective.scopeHash,base:context.repositoryObservation.base,candidateHash:digest(stored.candidate??null),shapeHash:digest(stored.shape?.body??null),receipts,proofHash:digest({context,result,budget,receipts})};
 }catch{return null;}
}

export async function ciContinuation(runtime,grant,issue,stored,code){
 if(!enabled(runtime,'ci-change')||!stored.prNumber||!stored.candidate)return null;
 const policy=grant.policy.repositories?.[issue.repository];if(policy?.ciMode!=='github-repository')return null;
 const head=stored.blocked?.reviewHead??stored.review?.artifactIdentities?.head;if(!sha(head))return null;
 const pr=await runtime.github.pull(issue.repository,stored.prNumber);
 if(pr.head?.repo?.full_name!==issue.repository||pr.head.sha!==head||pr.base?.ref!==policy.baseBranch||pr.state!=='open'||pr.merged||pr.draft)return null;
 if(stored.blocked?.resumeOn==='ci-change'&&stored.blocked.failureClass==='external_failure'&&stored.blocked.outcome==='blocked'&&stored.blocked.candidateHash===digest(stored.candidate)){
  const checks=await runtime.github.checks(issue.repository,head,policy.trustedCheckAppIds);
  if(digest(checks)!==stored.blocked.checksHash)return{kind:'ci-change',head,checksHash:digest(checks),clearBlock:false};
 }
 if(!stored.blocked&&['MERGE_REQUIREMENTS_PENDING','CI_PENDING_OR_FAILED'].includes(code)&&pr.mergeable===true&&pr.mergeable_state==='clean')return{kind:'ci-ready',head,clearBlock:false};
 if(!stored.blocked&&code==='MERGE_REQUIREMENTS_PENDING'&&pr.mergeable_state!=='dirty'&&pr.mergeable!==false)return{kind:'ci-wait',head,clearBlock:false};
 return null;
}

