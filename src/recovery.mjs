import {canonicalJSON,bodyDigest} from './grants.mjs';
import {contentIdentity,verifyEvidenceChain,verifyCompletion} from './evidence.mjs';
import {controlledIntent,observeControlledOperation} from './operations.mjs';
import {observeClosure} from './completion.mjs';
import {invalidateRepairEvidence} from './repair.mjs';
import {prepareCustodyManifest,publishCustody} from './custody.mjs';
import {deploymentHealthDisposition} from './deployment.mjs';
import {nativeConcurrency} from './concurrency.mjs';
const same=(a,b)=>canonicalJSON(a)===canonicalJSON(b),copy=structuredClone;
const need=(v)=>{if(!v)throw Error('recovery:blocked');};
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const id=v=>typeof v==='string'&&/^[1-9][0-9]*$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const label=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(v)
  && !/(?:gh[pousr]_|github_pat_|sk-|token|secret|password)/i.test(v);
const failureText={'deployment-failed':'Deployment reported failure.','health-status':'Health status differed from the required status.',
  'health-function':'Required deployed function check failed.'};

/** Independent official observation; authenticate must verify trusted source identity
 * and complete failure evidence, not just URL syntax or a failed Run conclusion.
 * Expected selectors and delivery mapping originate only in trusted current().
 */
export async function observeRecoveryIncident({provider,pin,authenticate,now=Date.now,signal}) {
  const t=pin.target,i=pin.incident,s=i.source,root=`/repos/${t.repository}`;
  need(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(t.repository)&&[t.repositoryId,t.databaseId,t.number,i.deploymentId,i.statusId,s.runId,s.attempt,s.jobId].every(id));
  need(sha(i.commit)&&label(i.id)&&label(i.environment)&&label(i.version)&&hash(i.baseline)
    &&Object.hasOwn(failureText,i.failure)&&Number.isSafeInteger(i.observedAt)&&Number.isSafeInteger(i.maxAgeMs)
    &&i.maxAgeMs>0&&i.maxAgeMs<=86400000&&now()>=i.observedAt&&now()-i.observedAt<=i.maxAgeMs);
  need(s.repository===t.repository&&s.repositoryId===t.repositoryId);
  const read=async path=>{const r=await provider.request({method:'GET',endpoint:root+path,operation:'recovery-read',
    target:t.repositoryId,correlation:i.id,signal});need(r.outcome==='read');return r.data;};
  const [deployment,status,run,job]=await Promise.all([read(`/deployments/${i.deploymentId}`),
    read(`/deployments/${i.deploymentId}/statuses/${i.statusId}`),read(`/actions/runs/${s.runId}/attempts/${s.attempt}`),read(`/actions/jobs/${s.jobId}`)]);
  const log=`https://github.com/${t.repository}/actions/runs/${s.runId}/attempts/${s.attempt}`;
  need(deployment.id===i.deploymentId&&deployment.sha===i.commit&&deployment.environment===i.environment
    &&deployment.payload?.version===i.version&&deployment.payload?.baseline===i.baseline
    &&status.id===i.statusId&&status.environment===i.environment&&status.log_url===log
    &&(i.failure==='deployment-failed'?['failure','error'].includes(status.state):status.state==='success')
    &&run.id===s.runId&&String(run.run_attempt)===s.attempt&&run.repository?.id===t.repositoryId
    &&run.head_sha===i.commit&&run.path===s.workflow&&run.status==='completed'
    &&job.id===s.jobId&&job.run_id===s.runId&&String(job.run_attempt)===s.attempt&&job.status==='completed');
  need((await authenticate({incident:copy(i),deployment,status,run,job,signal})).ok===true);
  const o=await observeClosure({provider,target:t,mergeIntent:pin.mergeIntent,signal});
  need(o.merge.mergeCommit===i.commit&&o.ownership===pin.ownership
    &&pin.mergeIntent.binding.repository===t.repository&&pin.mergeIntent.binding.repositoryId===t.repositoryId
    &&pin.mergeIntent.binding.issueId===t.issueId&&o.merge.id===pin.mergeOperation.observation.id
    &&o.merge.base===pin.mergeOperation.observation.base);
  need(pin.mergeIntent.binding.head===pin.delivery.receipts.merge.inputs.head
    &&pin.mergeIntent.binding.base===pin.delivery.receipts.merge.inputs.base);
  const stages=['publication','deliver','pre-accept-hooks','accept','pre-commit-hooks','pr','ci','shaper-review','merge'];
  verifyEvidenceChain({version:1,receipts:Object.fromEntries(stages.map(k=>[k,pin.delivery.receipts[k]]))},
    Object.fromEntries(stages.map(k=>[k,pin.delivery.contexts[k]])),'merge');
  if(pin.completion!==null) {
    verifyCompletion(pin.completionReceipt,pin.completionContexts);
    need(pin.completionReceipt.identity===pin.completion
      &&pin.completionReceipt.payload.receipts.merge.inputs.commit===i.commit
      &&same(pin.completionReceipt.payload.receipts.merge,pin.delivery.receipts.merge));
  }
  const m=pin.delivery.receipts.merge;
  need(m.inputs.commit===i.commit&&m.binding.issueId===t.issueId&&m.binding.repositoryId===t.repositoryId
    &&m.binding.scopeHash===pin.binding.scopeHash&&m.binding.shapeHash===pin.binding.shapeHash
    &&m.binding.grant===pin.originalGrant&&m.inputs.readback===contentIdentity(pin.mergeOperation)
    &&pin.mergeOperation.outcome==='confirmed-success'&&pin.mergeOperation.observation.mergeCommit===i.commit);
  need(Array.isArray(pin.responsibility)&&pin.responsibility.length===1&&same(pin.responsibility[0],
    {repositoryId:t.repositoryId,issueId:t.issueId,commit:i.commit,merge:contentIdentity(m)}));
  need(now()>=i.observedAt&&now()-i.observedAt<=i.maxAgeMs);
  return {incident:contentIdentity(i),commit:i.commit,log,merge:contentIdentity(m),lifecycle:o.issue};
}
function commentBody(p,o) {
  const t=p.target,i=p.incident,s=i.source;
  need(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(t.repository)&&[t.repositoryId,t.number,s.runId,s.attempt,s.jobId,i.deploymentId].every(id)
    &&[i.id,i.environment,i.version].every(label)&&sha(i.commit)&&Object.hasOwn(failureText,i.failure)
    &&o.log===`https://github.com/${t.repository}/actions/runs/${s.runId}/attempts/${s.attempt}`&&hash(o.merge));
  need(hash(p.originalGrant)&&(p.completion===null||hash(p.completion))&&/^[A-Za-z0-9_=-]{1,256}$/.test(t.issueId));
  return ['Recovery incident '+i.id,`Repository: ${t.repository} (${t.repositoryId}); Issue: ${t.number} (${t.issueId}).`,
    `Prior completion: ${p.completion??'absent (Issue has not completed)'}; original Grant: ${p.originalGrant}.`,
    `Deployment: ${i.deploymentId}; environment: ${i.environment}; version: ${i.version}; commit: ${i.commit}.`,
    `Run: ${s.runId}; Attempt: ${s.attempt}; Job: ${s.jobId}; Actions log: ${o.log}`,
    failureText[i.failure],`Attribution: verified delivery Merge receipt ${o.merge}.`,
    'Repair authorization: independently required; this Comment grants no execution permission.'].join('\n');
}
/** Core-owned capabilities, never supplied by event/Comment/Agent content.
 * operations is the existing controlled-operations factory; installInvalidation
 * must durably install and independently read back returned current envelopes.
 */
export function createRecoveryFlow({current,provider,authenticate,authorization,dependencies,dependencyInput,
  operations,custody,publication,locate,installInvalidation,classify,repairAuthorization,now=Date.now}={}) {
  need([current,provider?.request,authenticate,authorization?.eligibility,dependencies?.evaluate,operations,
    custody?.retrieve,publication,locate,installInvalidation,classify,repairAuthorization,now].every(f=>typeof f==='function'));
  let busy=false;
  return Object.freeze({async run({signal}={}) {
    if(busy)return {outcome:'blocked',finding:'recovery:busy'};busy=true;
    try {
      const p=freeze(copy(await current())),t=p.target,b=p.binding;
      need(p.visibility==='public'&&['personal','organization'].includes(p.ownership)
        &&b.repositoryId===t.repositoryId&&b.issueId===t.issueId
        &&bodyDigest(p.scopeBody)===b.scopeHash&&bodyDigest(p.shapeBody)===b.shapeHash
        &&label(t.cycle)&&label(p.next.cycle)&&label(p.next.attempt)&&sha(p.next.base)
        &&Array.isArray(p.gates)&&['routing','isolation','effects'].every(k=>p.gates.some(g=>g.name===k&&g.status==='valid'))
        &&p.next.cycle!==t.cycle&&p.next.attempt!==p.previousAttempt
        &&!p.history.some(h=>h.cycle===p.next.cycle||h.attempt===p.next.attempt));
      const concurrency=nativeConcurrency({repository:t.repository,repositoryId:t.repositoryId,scope:'repository-write'});
      need(same(p.concurrency,concurrency));
      const stable=async()=>need(!signal?.aborted&&same(await current(),p));
      const observe=()=>observeRecoveryIncident({provider,pin:p,authenticate,now,signal});
      const original=await observe();
      const key=contentIdentity({kind:'recovery-v1',target:t,incident:p.incident.id,binding:b});
      async function checkpoint(operation) {
        await stable();
        const a=await authorization.eligibility({operation,context:copy(t)},{signal});
        need(a.ok===true&&a.observation?.repositoryId===t.repositoryId&&a.observation?.issueId===t.issueId);
        const d=await dependencies.evaluate(copy(dependencyInput),{signal});
        need(d.outcome==='ready'&&d.target?.repositoryId===t.repositoryId&&d.target?.issueId===t.issueId);
        const o=await observe();need(o.incident===original.incident&&o.commit===original.commit);await stable();return o;
      }
      function expected(phase,source) {return {repository:t.repository,repositoryId:t.repositoryId,issueId:t.issueId,cycle:t.cycle,
        scopeHash:b.scopeHash,shapeHash:b.shapeHash,authorization:b.grant,runId:source.runId,attempt:source.attempt,
        stage:'candidate',result:phase+'-'+key,candidate:null};}
      async function load(phase) {
        const e=await locate({identity:key,phase,target:copy(t)});await stable();
        if(e?.outcome==='new'&&e.identity===key)return null;
        need(e?.outcome==='found');
        const r=await custody.retrieve({ref:e.ref,expected:expected(phase,e.source),signal});
        need(r.outcome==='retrieved'&&r.payloads.size===1);
        const bytes=r.payloads.get('recovery.json'),v=JSON.parse(Buffer.from(bytes).toString());
        need(Buffer.from(bytes).equals(Buffer.from(canonicalJSON(v)))&&v.key===key&&v.phase===phase);
        return v.value;
      }
      async function save(phase,value) {
        const prior=await load(phase);if(prior!==null){need(same(prior,value));return prior;}
        const exp=expected(phase,p.source),payloads=new Map([['recovery.json',Buffer.from(canonicalJSON({key,phase,value}))]]);
        const facilities=await publication({phase,identity:key,expected:exp});
        const r=await publishCustody({...facilities,expected:exp,payloads,manifest:prepareCustodyManifest(exp,payloads),
          custody,name:phase+'-'+key,retentionDays:7,signal});
        need(r.outcome==='retained'&&same(await load(phase),value));return value;
      }
      // Pin the original lifecycle before any writes; restart never recasts Open as a direct path.
      const prior=await load('incident');
      const request=contentIdentity({incident:p.incident,next:p.next,intents:p.intents,writerId:p.writerId,originalGrant:p.originalGrant});
      const start=prior??{observation:original,completion:p.completion,merge:original.commit,request};
      need(start.request===request&&start.observation.incident===original.incident&&start.merge===original.commit&&start.completion===p.completion);
      if(!prior)await save('incident',start);
      const closed=start.observation.lifecycle.state==='closed';
      need(closed?p.completion!==null:start.observation.lifecycle.state==='open');
      const from={repositoryId:t.repositoryId,issueId:t.issueId,stage:'final'};
      const historical=p.completion===null?p.delivery.receipts:p.completionReceipt.payload.receipts;
      for(const stage of ['final','closure','delivered'])if(historical[stage])
        need(p.evidence.records.some(r=>same(r,historical[stage])));
      const invalidation=invalidateRepairEvidence({...p.evidence,from});
      await save('invalidation',invalidation);
      need((await installInvalidation(copy(invalidation))).outcome==='installed');await stable();
      let comment=null,reopen=null;
      function intent(kind) {
        const v=controlledIntent(p.intents[kind]);
        need(v.kind===kind&&v.binding.repository===t.repository&&v.binding.repositoryId===t.repositoryId
          &&v.binding.issueId===t.issueId&&v.target.id===t.databaseId&&v.target.number===t.number
          &&v.binding.cycle===t.cycle&&v.binding.scopeHash===b.scopeHash&&v.binding.shapeHash===b.shapeHash
          &&v.binding.authorization===b.grant&&v.source.actorId===p.writerId);
        if(kind==='comment')need(v.payload.body===commentBody(p,start.observation)+`\n<!-- nibfin-operation:${v.correlation} -->`);
        return v;
      }
      function causal(result,o) {
        need(result?.outcome==='confirmed-success'&&result.continuation===true&&result.refs.submission);
        const before=start.observation.lifecycle.eventIds,after=o.lifecycle.eventIds;
        const added=after.filter(x=>!before.includes(x));
        need(before.every(x=>after.includes(x))&&added.length===1&&o.lifecycle.state==='open');
        // observeClosure does not select an occurrence while Open: retrieve full events below.
        return added[0];
      }
      async function validateReopen(result) {
        const o=await checkpoint('reopen'),eventId=causal(result,o);
        const path=`/repos/${t.repository}/issues/${t.number}/events`;
        const r=await provider.collection({endpoint:path+'?per_page=100',operation:'recovery-read',target:t.repositoryId,
          correlation:p.incident.id,signal,allowPage:x=>x.split('?')[0]===path});
        const e=r.data?.filter(x=>x.id===eventId);
        need(r.outcome==='complete'&&e.length===1&&e[0].event==='reopened'&&e[0].actor?.id===p.writerId
          &&Date.parse(e[0].created_at)>=Date.parse(start.observation.lifecycle.closedAt));
        await stable();return {operation:result,event:contentIdentity(e[0]),lifecycle:o.lifecycle};
      }
      if(closed) {
        const ci=intent('comment');
        const commentGuard=async()=>{
          const o=await checkpoint('comment');need(same(o.lifecycle,start.observation.lifecycle));
        };
        comment=await load('comment');
        if(!comment) {
          const ops=await operations({intent:ci,beforeSubmit:commentGuard});
          const result=await ops.execute(ci,{signal});need(result.outcome==='confirmed-success'&&result.refs.submission);
          comment=await save('comment',result);
        }
        const proof=await (await operations({intent:ci,beforeSubmit:commentGuard})).execute(ci,{signal});
        need(proof.outcome==='confirmed-success'&&same(proof.observation,comment.observation));
        const checkComment=async()=>{
          const read=await observeControlledOperation(provider,ci,signal);need(same(read,comment.observation));
        };
        await checkComment();
        const ri=intent('reopen');
        const reopenGuard=async()=>{const o=await checkpoint('reopen');
          need(same(o.lifecycle,start.observation.lifecycle));await checkComment();await stable();};
        let retained=await load('reopen');
        if(!retained) {
          const ops=await operations({intent:ri,beforeSubmit:reopenGuard});
          const result=await ops.execute(ri,{signal});
          retained=await save('reopen',await validateReopen(result));
        }
        const proofReopen=await (await operations({intent:ri,beforeSubmit:reopenGuard})).execute(ri,{signal});
        need(proofReopen.outcome==='confirmed-success'&&same({...proofReopen.observation,observedAt:null},{...retained.operation.observation,observedAt:null}));
        const rechecked=await validateReopen(retained.operation);need(same(retained,rechecked));reopen=retained;
        await checkComment();
      } else need(same((await checkpoint('deliver-repair')).lifecycle,start.observation.lifecycle));
      const classification=await classify({identity:key,incident:copy(p.incident),target:copy(t),signal});
      need(classification.failureClass==='implementation_defect'&&classification.independent===true
        &&classification.incident===original.incident&&classification.issueId===t.issueId
        &&classification.effects==='reconciled'&&hash(classification.identity)
        &&classification.expiresAt>now()&&classification.observedAt<=now());
      const fresh=async()=>{
        const a=await repairAuthorization({identity:key,incident:copy(p.incident),target:copy(t),next:copy(p.next),signal});
        need(a.ok===true&&hash(a.grant)&&a.grant!==p.originalGrant&&a.incident===original.incident
          &&a.issueId===t.issueId&&a.repositoryId===t.repositoryId&&a.operation==='deliver-repair'
          &&a.revoked===false&&a.validFrom<=now()&&now()<a.expiresAt&&a.validFrom>=p.incident.observedAt);
        await checkpoint('deliver-repair');need(a.validFrom<=now()&&now()<a.expiresAt);return a;
      };
      const grant=await fresh();
      async function healthCheck(grant) {
      const health=await deploymentHealthDisposition({...p.health,target:t,now,repair:{
        classification:classification.failureClass,responsibleIssue:t.issueId,incident:p.incident.id,unknownWrites:false,
        classifiedAt:classification.observedAt,maxAgeMs:p.incident.maxAgeMs,authorization:{...grant,incident:p.incident.id}}});
      need(['eligible','repair-health-exception'].includes(health.status));
      for(const bypass of health.bypassed) {
        const baseline=p.health.baselines.find(x=>x.id===bypass);
        need(baseline.incident===p.incident.id&&baseline.policy.repositoryId===t.repositoryId
          &&baseline.policy.commit===p.incident.commit&&baseline.policy.baseline===p.incident.baseline
          &&baseline.policy.environment===p.incident.environment);
      }
      need(health.selected.some(id=>p.health.baselines.some(x=>x.id===id&&x.incident===p.incident.id
        &&x.policy.commit===p.incident.commit&&x.policy.baseline===p.incident.baseline)));
      return health;
      }
      async function baseCheck() {
      const base=await provider.request({method:'GET',endpoint:`/repos/${t.repository}/branches/${encodeURIComponent(p.baseRef)}`,
        target:t.repositoryId,operation:'recovery-read',correlation:p.incident.id,signal});
      need(base.outcome==='read'&&base.data.name===p.baseRef&&base.data.commit?.sha===p.next.base);
      }
      const health=await healthCheck(grant);await baseCheck();
      const record={version:1,identity:key,target:t,incident:original.incident,merge:original.commit,completion:p.completion,
        binding:b,next:p.next,classification,grant,comment,reopen,invalidation,health,
        path:closed?'recovery-action':'direct-repair',eventObserved:false,
        requiredGates:['deliver','pre-accept-hooks','accept','pre-commit-hooks','pr','ci','shaper-review','merge','deployment','final','closure','delivered']};
      await save('handoff',record);need(same(await fresh(),grant));
      if(closed) {await validateReopen(reopen.operation);await observeControlledOperation(provider,intent('comment'),signal);}
      else need(same((await observe()).lifecycle,start.observation.lifecycle));
      need(classification.expiresAt>now()&&same(await classify({identity:key,incident:copy(p.incident),target:copy(t),signal}),classification));
      need(same(await healthCheck(grant),health));await baseCheck();
      need(grant.expiresAt>now()&&classification.expiresAt>now());await stable();
      return {outcome:'handoff',record,closure:'blocked',completion:'invalidated'};
    } catch {return {outcome:'blocked',finding:'recovery:unverified-or-unavailable',closure:'blocked'};}
    finally {busy=false;}
  }});
}

/** Build only validated, bounded public text; raw observations/logs are never rendered. */
export function recoveryComment(pin,observation) {return commentBody(pin,observation);}
