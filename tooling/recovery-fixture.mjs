// Synthetic provider/authorization/custody proof. No live GitHub observations.
import {chain,chainContext} from './evidence-fixture.mjs';
import {completionFixture} from './completion-fixture.mjs';
import {operationInput,operationsFixture} from './operations-fixture.mjs';
import {createRecoveryFlow,observeRecoveryIncident,recoveryComment,contentIdentity,nativeConcurrency,createCompletion} from '../src/index.mjs';
export async function recoveryFixture(closed=true,configure) {
  const f=await completionFixture(undefined,configure),{pin:c,state}=f,t=c.target,b=c.binding;
  state.closed=closed;
  const incident={id:'incident-1',commit:'d'.repeat(40),environment:'production',version:'v1',baseline:'e'.repeat(64),
    deploymentId:'301',statusId:'302',observedAt:1000,maxAgeMs:10000,failure:'deployment-failed',
    source:{repository:t.repository,repositoryId:t.repositoryId,runId:'303',attempt:'1',jobId:'304',workflow:'.github/workflows/deploy.yml'}};
  const s=incident.source;
  state.deploymentData={
    '/deployments/301':{id:'301',sha:incident.commit,environment:'production',payload:{version:'v1',baseline:incident.baseline}},
    '/deployments/301/statuses/302':{id:'302',state:'failure',environment:'production',log_url:`https://github.com/${t.repository}/actions/runs/303/attempts/1`},
    '/actions/runs/303/attempts/1':{id:'303',run_attempt:1,repository:{id:t.repositoryId},head_sha:incident.commit,path:s.workflow,status:'completed',conclusion:'failure'},
    '/actions/jobs/304':{id:'304',run_id:'303',run_attempt:1,status:'completed',conclusion:'failure'}};
  const regenerated=chain(true,false,r=>{
    for(const [k,v] of Object.entries(c.receipts))r[k]=structuredClone(v);
    for(const [k,v] of Object.entries(r))if(!['deliver','accept','shaper-review'].includes(k))v.execution.id=k+'-execution';
  });
  delete regenerated.receipts.closure;delete regenerated.receipts.delivered;
  c.receipts=regenerated.receipts;c.contexts=chainContext(regenerated);
  const all=structuredClone(c.receipts);
  const tail=chain(true).receipts;
  for(const k of ['closure','delivered']){all[k]=tail[k];all[k].binding=structuredClone(b);}
  all.closure.inputs.final=contentIdentity(all.final);all.delivered.inputs.closure=contentIdentity(all.closure);
  const completionContexts=chainContext({receipts:all}),completionReceipt=createCompletion({version:1,receipts:all},completionContexts);
  const selector={kind:'environment',repositoryId:t.repositoryId,environment:'production',releaseLine:'main',output:'service'};
  const policy={mode:'required',reason:'Fixture deployment',repositoryId:t.repositoryId,commit:incident.commit,version:incident.version,
    environment:incident.environment,deploymentId:incident.deploymentId,statusId:incident.statusId,baseline:incident.baseline,
    source:{repositoryId:t.repositoryId,runId:s.runId,attempt:s.attempt,workflow:s.workflow},maxAgeMs:10000,checks:[{url:'https://invalid.example'}]};
  const pin={target:t,binding:b,visibility:'public',ownership:'organization',scopeBody:c.scopeBody,shapeBody:c.shapeBody,
    concurrency:nativeConcurrency({repository:t.repository,repositoryId:t.repositoryId,scope:'repository-write'}),
    incident,mergeIntent:c.mergeIntent,mergeOperation:c.mergeOperation,delivery:{receipts:c.receipts,contexts:c.contexts},
    originalGrant:b.grant,completion:closed?completionReceipt.identity:null,completionReceipt,completionContexts,writerId:'7',source:c.source,
    responsibility:[{repositoryId:t.repositoryId,issueId:t.issueId,commit:incident.commit,merge:contentIdentity(c.receipts.merge)}],
    evidence:{records:Object.values(all),current:Object.fromEntries(Object.entries(all).map(([k,r])=>[contentIdentity(r),completionContexts[k]]))},next:{cycle:'cycle-2',attempt:'attempt-2',base:'d'.repeat(40)},
    baseRef:'main',health:{selectors:[selector],baselines:[{id:'baseline-1',selector,incident:incident.id,effectiveAt:1000,policy}],observations:[]},
    gates:['routing','isolation','effects'].map(name=>({name,status:'valid'})),previousAttempt:'attempt-1',history:[],intents:{}};
  const local={time:1100,authenticated:true,granted:true,classification:'implementation_defect',effects:'reconciled',events:[],hooks:{},installed:null};
  const authenticate=async v=>{await local.hooks.authenticate?.(v);return {ok:local.authenticated};};
  const observation=await observeRecoveryIncident({provider:f.provider,pin,authenticate,now:()=>local.time});
  for(const kind of ['comment','reopen']) {
    const i=operationInput(kind);i.correlation='recovery-'+kind;
    Object.assign(i.binding,{scopeHash:b.scopeHash,shapeHash:b.shapeHash,authorization:b.grant});
    if(kind==='comment')i.payload.body=recoveryComment(pin,observation)+`\n<!-- nibfin-operation:${i.correlation} -->`;
    pin.intents[kind]=i;
  }
  const comment=operationsFixture(pin.intents.comment),reopen=operationsFixture(pin.intents.reopen);
  reopen.state.onWrite=()=>{state.closed=false;state.events=[{id:'200',event:'closed',created_at:state.at,actor:{id:'7'}},
    {id:'201',event:'reopened',created_at:'2026-10-24T12:05:00Z',actor:{id:local.actor??'7'}}];};
  const reader={request:r=>r.endpoint.includes('/comments/')?comment.provider.request(r):f.provider.request(r),
    collection:r=>r.endpoint.includes('/comments?')?comment.provider.collection(r):f.provider.collection(r)};
  const caps={current:async()=>{await local.hooks.current?.();return pin;},provider:reader,authenticate,
    authorization:{eligibility:async({operation})=>{local.events.push('auth:'+operation);await local.hooks.authorization?.(operation);
      return {ok:state.auth,observation:{repositoryId:t.repositoryId,issueId:t.issueId}};}},
    dependencies:{evaluate:async()=>{local.events.push('dependencies');await local.hooks.dependencies?.();
      return {outcome:state.dependencies?'ready':'waiting',target:t};}},dependencyInput:{target:t},
    operations:async({intent,beforeSubmit})=>{
      const op=intent.kind==='comment'?comment:reopen;
      // Run traces include actual boundary reads and post-read guard.
      op.state.onPublish=phase=>local.events.push(intent.kind+':'+phase);
      return op.fresh(undefined,beforeSubmit);
    },custody:f.custody(),publication:f.publication,
    locate:async({identity,phase})=>state.missingHistory?{outcome:'unavailable'}:state.history.get(phase)
      ??(state.attempted.has(phase)?{outcome:'unavailable'}:{outcome:'new',identity}),
    installInvalidation:async inv=>{await local.hooks.install?.(inv);local.installed=inv;return {outcome:'installed'};},
    classify:async()=>{await local.hooks.classify?.();return {failureClass:local.classification,independent:true,
      incident:contentIdentity(incident),issueId:t.issueId,effects:local.effects,identity:'b'.repeat(64),observedAt:1000,expiresAt:10000,...local.classificationOverride};},
    repairAuthorization:async()=>{await local.hooks.repair?.();return {ok:local.granted,grant:'c'.repeat(64),
      incident:contentIdentity(incident),issueId:t.issueId,repositoryId:t.repositoryId,operation:'deliver-repair',
      revoked:false,validFrom:1000,expiresAt:10000,...local.grantOverride};},now:()=>local.time};
  return {f,pin,state,local,comment,reopen,caps,fresh:()=>createRecoveryFlow(caps)};
}
