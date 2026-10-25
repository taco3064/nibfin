import {canonicalJSON,bodyDigest} from './grants.mjs';
import {contentIdentity,compareEvidence,verifyEvidenceChain,createCompletion,verifyCompletion} from './evidence.mjs';
import {controlledIntent,observeControlledOperation} from './operations.mjs';
import {prepareCustodyManifest,publishCustody} from './custody.mjs';
import {verifyDeployment,readDeploymentObservation} from './deployment.mjs';
import {nativeConcurrency} from './concurrency.mjs';
const same=(a,b)=>canonicalJSON(a)===canonicalJSON(b);
class CompletionFailure extends Error {}
const need=(ok,reason)=>{if(!ok)throw new CompletionFailure('completion:'+reason);};
const copy=structuredClone;
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const shared=['authority','grant','policy','core','runtime','repositoryId','issueId','scopeHash','shapeHash'];

/** Official provider-shaped readback. Full lifecycle events distinguish a reclose
 * even when the Issue's timestamp has only second precision. No event grants writes.
 */
export async function observeClosure({provider,target,mergeIntent,signal}={}) {
  const root=`/repos/${target.repository}`;
  const read=async path=>{
    const r=await provider.request({method:'GET',endpoint:root+path,operation:'completion-read',
      target:target.repositoryId,correlation:'completion',signal});
    need(r.outcome==='read','readback');return r.data;
  };
  const repo=await read(''),issue=await read(`/issues/${target.number}`);
  need(repo.id===target.repositoryId&&repo.full_name?.toLowerCase()===target.repository
    &&repo.private===false&&repo.visibility==='public'&&['User','Organization'].includes(repo.owner?.type),'public');
  need(issue.id===target.databaseId&&issue.node_id===target.issueId&&String(issue.number)===target.number
    &&issue.repository_url===`https://api.github.com${root}`&&!issue.pull_request,'issue');
  const path=root+`/issues/${target.number}/events`;
  const events=await provider.collection({method:'GET',endpoint:path+'?per_page=100',operation:'completion-read',
    target:target.repositoryId,correlation:'completion',signal,allowPage:p=>p.split('?')[0]===path});
  need(events.outcome==='complete'&&Array.isArray(events.data),'events');
  const lifecycle=events.data.filter(e=>['closed','reopened'].includes(e.event))
    .map(e=>({id:e.id,event:e.event,created_at:e.created_at,actorId:e.actor?.id??null}));
  need(lifecycle.every(e=>/^[1-9][0-9]*$/.test(e.id)&&time(e.created_at))
    &&new Set(lifecycle.map(e=>e.id)).size===lifecycle.length,'events');
  // IDs identify events; neither numeric magnitude nor collection order proves time.
  lifecycle.sort((a,b)=>a.id.localeCompare(b.id));
  const matching=lifecycle.filter(e=>e.event==='closed'&&Date.parse(e.created_at)===Date.parse(issue.closed_at));
  need(issue.state!=='closed'||matching.length===1,'ambiguous-closure');
  const last=issue.state==='closed'?matching[0]:null;
  const merge=await observeControlledOperation(provider,mergeIntent,signal);
  const pr=await read(`/pulls/${mergeIntent.target.number}`);
  need(time(pr.merged_at)&&pr.merge_commit_sha===merge.mergeCommit,'merge-time');
  return {issueIdentity:contentIdentity(issue),ownership:repo.owner.type==='User'?'personal':'organization',merge,mergedAt:pr.merged_at,
    issue:{state:issue.state,reason:issue.state_reason,closedAt:issue.closed_at,
      lifecycle:contentIdentity(lifecycle),eventIds:lifecycle.map(e=>e.id),
      occurrence:last?{id:last.id,event:last.event,at:last.created_at,actorId:last.actorId}:null}};
}

/** Trusted Core capabilities only; no event or agent-provided authorization bag.
 * locate durably resolves phase -> original custody ref/source, or positively
 * attests newness with the requested identity. Missing history is never newness.
 */
export function createCompletionFlow({current,authorization,dependencies,dependencyInput,provider,observe,
  operations,custody,publication,locate,stageCurrent,postMerge,now=Date.now}={}) {
  need([current,authorization?.eligibility,dependencies?.evaluate,provider?.request,observe,operations,
    custody?.retrieve,publication,locate,stageCurrent,postMerge].every(f=>typeof f==='function'),'capabilities');
  let busy=false;
  async function run(mode,{signal}={}) {
    if(busy)return {outcome:'blocked',finding:'completion:busy'};busy=true;
    let reference;
    try {
      const p=freeze(copy(await current())),b=p.binding,t=p.target;
      need(p.visibility==='public'&&['personal','organization'].includes(p.ownership),'public');
      need(t.repositoryId===b.repositoryId&&t.issueId===b.issueId
        &&bodyDigest(p.scopeBody)===b.scopeHash&&bodyDigest(p.shapeBody)===b.shapeHash,'binding');
      need(typeof p.decision==='string'&&p.decision.length>0&&typeof p.writerId==='string'&&/^[1-9][0-9]*$/.test(p.writerId),'decision');
      const receipts=copy(p.receipts),contexts=copy(p.contexts);
      verifyEvidenceChain({version:1,receipts},contexts,'final');
      for(const k of shared)need(receipts.final.binding[k]===b[k],'binding');
      const commit=receipts.merge.inputs.commit;
      const intents={};
      for(const kind of ['close','label']) {
        const v=controlledIntent(p.intents[kind]);intents[kind]=v;
        need(v.kind===kind&&v.binding.repository===t.repository&&v.binding.repositoryId===t.repositoryId
          &&v.binding.issueId===t.issueId&&v.target.id===t.databaseId&&v.binding.number===t.number
          &&v.binding.cycle===t.cycle&&v.binding.authorization===b.grant&&v.binding.scopeHash===b.scopeHash
          &&v.binding.shapeHash===b.shapeHash&&v.binding.head===receipts.pr.inputs.head
          &&v.binding.base===receipts.pr.inputs.base&&v.binding.candidate===p.candidate,'intent');
        if(kind==='label')need(same(v.payload,{labels:['delivered']}),'label');
      }
      need(p.mergeIntent.kind==='merge'&&p.mergeIntent.binding.repository===t.repository
        &&p.mergeIntent.binding.repositoryId===t.repositoryId&&p.mergeIntent.binding.issueId===t.issueId
        &&p.mergeIntent.binding.head===receipts.pr.inputs.head&&p.mergeIntent.binding.base===receipts.pr.inputs.base,'merge-intent');
      async function stable() {need(!signal?.aborted&&same(await current(),p),'drift');}
      async function checkpoint(operation,closure=null) {
        await stable();
        const a=await authorization.eligibility({operation,context:t},{signal});
        need(a?.ok===true&&a.observation?.repositoryId===t.repositoryId&&a.observation?.issueId===t.issueId,'authorization');
        const d=await dependencies.evaluate(copy(dependencyInput),{signal});
        need(d?.outcome==='ready'&&d.target?.repositoryId===t.repositoryId&&d.target?.issueId===t.issueId,'dependencies');
        const o=await observe({signal});
        need(o.ownership===p.ownership&&o.merge.mergeCommit===commit&&o.merge.effect==='merged','merge');
        need(o.merge.id===p.mergeIntent.target.id&&o.merge.base===receipts.merge.inputs.base,'merge');
        need(p.mergeOperation.outcome==='confirmed-success'&&p.mergeOperation.continuation===true
          &&receipts.merge.inputs.readback===contentIdentity(p.mergeOperation),'merge-provenance');
        for(const k of ['mergeCommit','baseRef','base','id'])
          need(o.merge[k]===p.mergeOperation.observation[k],'merge-drift');
        const pm=await postMerge({policy:copy(p.postMerge),commit,target:copy(t),signal});
        need(same(pm,receipts.final.inputs.postMerge),'post-merge');
        need(pm.mode==='not-applicable'?p.postMerge.mode==='not-applicable'&&p.postMerge.reason===pm.reason
          :p.postMerge.mode==='required','post-merge-policy');
        const policy=p.deployment;
        let observation;
        if(policy.mode==='required') {
          need(policy.commit===commit&&policy.repositoryId===t.repositoryId,'deployment');
          const r=await readDeploymentObservation(provider,{repository:t.repository,policy,now});
          need(r.status==='observed','deployment');
          const {observedAt:ignored,...fresh}=r.observation;
          const {observedAt:original,...retained}=p.deploymentObservation;
          need(same(fresh,retained),'deployment-drift');observation=p.deploymentObservation;
        }
        const deployment=await verifyDeployment({policy,observation,health:p.health,now});
        need(['qualified','not-applicable'].includes(deployment.status)
          &&same(deployment.proof,receipts.final.inputs.deployment),'deployment');
        if(closure)validateClosure(closure,o);
        const latest=await observe({signal});
        need(same(latest.issue,o.issue)&&latest.ownership===o.ownership&&latest.mergedAt===o.mergedAt
          &&latest.merge.mergeCommit===o.merge.mergeCommit&&latest.merge.id===o.merge.id,'native-drift');
        if(policy.mode==='required')need(now()>=observation.observedAt&&now()-observation.observedAt<=policy.maxAgeMs,'proof-expired');
        await stable();return latest;
      }
      function validateClosure(record,o) {
        need(record.decision===p.decision&&record.writerId===p.writerId&&record.grant===b.grant&&record.commit===commit
          &&record.final===contentIdentity(receipts.final)&&record.start.issue.state==='open','closure-provenance');
        need(record.operation.outcome==='confirmed-success'&&record.operation.continuation===true
          &&record.operation.refs.intent&&record.operation.refs.attempt&&record.operation.refs.submission,'close-operation');
        const i=o.issue,prior=record.start.issue.eventIds;
        const added=i.eventIds.filter(id=>!prior.includes(id));
        need(prior.every(id=>i.eventIds.includes(id))&&added.length===1&&added[0]===i.occurrence?.id,'closure-event');
        need(i.state==='closed'&&i.reason==='completed'&&time(i.closedAt)&&i.occurrence?.event==='closed'
          &&i.occurrence.actorId===p.writerId&&Date.parse(i.occurrence.at)===Date.parse(i.closedAt)
          &&Date.parse(i.closedAt)>=Date.parse(o.mergedAt),'closure');
        need(same(record.issue,i),'closure-occurrence');
      }
      const key=contentIdentity({kind:'completion-publication-v1',binding:b,decision:p.decision,writerId:p.writerId,intents});reference=key;
      function expected(phase,source) {return {repository:t.repository,repositoryId:t.repositoryId,issueId:t.issueId,
        cycle:t.cycle,scopeHash:b.scopeHash,shapeHash:b.shapeHash,authorization:b.grant,runId:source.runId,
        attempt:source.attempt,stage:'candidate',result:phase+'-'+key,candidate:null};}
      async function load(phase) {
        const entry=await locate({identity:key,phase,target:copy(t)});await stable();
        if(entry?.outcome==='new'&&entry.identity===key)return null;
        need(entry?.outcome==='found','history');
        const r=await custody.retrieve({ref:entry.ref,expected:expected(phase,entry.source),signal});
        need(r.outcome==='retrieved'&&r.payloads.size===1,'custody');
        const bytes=r.payloads.get('completion.json');need(bytes,'custody');
        const v=JSON.parse(Buffer.from(bytes).toString('utf8'));
        need(Buffer.from(bytes).equals(Buffer.from(canonicalJSON(v)))&&v.key===key&&v.phase===phase,'custody-bytes');
        await stable();return v.value;
      }
      async function save(phase,value,guard) {
        const prior=await load(phase);
        if(prior!==null){need(same(prior,value),'conflict');return prior;}
        const exp=expected(phase,p.source),payloads=new Map([['completion.json',Buffer.from(canonicalJSON({key,phase,value}))]]);
        const facilities=await publication({phase,identity:key,expected:exp});
        const client={uploadArtifact:async(...args)=>{await guard();return facilities.client.uploadArtifact(...args);}};
        const result=await publishCustody({...facilities,client,expected:exp,payloads,
          manifest:prepareCustodyManifest(exp,payloads),custody,name:phase+'-'+key,retentionDays:7,signal});
        need(result.outcome==='retained','publication-unconfirmed');
        // Core's durable locator must resolve even an interrupted/lost upload response.
        const read=await load(phase);need(read!==null&&same(read,value),'receipt-readback');return read;
      }
      async function stage(name,inputs,record) {
        const c=await stageCurrent(name,copy(record)),e=compareEvidence(c.expected,c);
        need(e.stage===name&&same(e.inputs,inputs),'stage');
        for(const k of shared)need(e.binding[k]===b[k],'stage-binding');
        receipts[name]=e;contexts[name]=c;
        verifyEvidenceChain({version:1,receipts},contexts,name==='closure'?'closure':'delivered');return e;
      }
      async function execute(kind,closure,start,known=false) {
        const intent=intents[kind];
        const beforeSubmit=async actual=>{
          need(!known&&same(actual,intent),'intent');const o=await checkpoint(kind,closure);
          if(kind==='close')need(same(o.issue,start.issue)&&o.issue.state==='open','already-closed');
        };
        const ops=await operations({intent,beforeSubmit,causalClose:true,
          concurrency:nativeConcurrency({repository:t.repository,repositoryId:t.repositoryId,scope:'repository-write'})});
        need(kind!=='close'||ops.causalClose===true,'causal-close-required');
        const result=await ops.execute(intent,{signal});
        need(result.outcome==='confirmed-success'&&result.continuation===true,'operation-unconfirmed');return result;
      }
      let closure=await load('closure');
      if(mode==='close'&&!closure) {
        let start=await load('close-start');
        if(!start) {
          start=await checkpoint('close');need(start.issue.state==='open','manual-closure');
          await save('close-start',start,async()=>{const o=await checkpoint('close');need(same(o.issue,start.issue),'drift');});
        }
        const operation=await execute('close',null,start),o=await checkpoint('close');
        need(operation.observation.identity===o.issueIdentity,'close-readback');
        closure={start,operation,issue:o.issue,commit,final:contentIdentity(receipts.final),decision:p.decision,writerId:p.writerId,grant:b.grant};
        validateClosure(closure,o);
        await save('closure',closure,()=>checkpoint('close',closure));
      }
      need(closure,'missing-closure');
      const recovered=await execute('close',closure,closure.start,true);
      for(const k of ['intent','attempt','submission'])need(same(recovered.refs[k],closure.operation.refs[k]),'close-provenance');
      await checkpoint(mode==='close'?'close':'mark-delivered',closure);
      const ce=await stage('closure',{final:contentIdentity(receipts.final),commit,state:'completed',readback:contentIdentity(closure)},closure);
      if(mode==='close'){await checkpoint('close',closure);return {outcome:'closed',evidence:ce};}
      const existing=await load('receipt');
      if(existing) {
        const intent=await load('receipt-intent');need(intent&&same(intent.receipt,existing),'receipt-intent');
        const delivered=await load('delivered');need(delivered,'missing-delivered');
        const label=await execute('label',closure,null,true);
        need(same(label.refs.intent,delivered.operation.refs.intent)&&same(label.refs.attempt,delivered.operation.refs.attempt),'label-provenance');
        const observed=await observeControlledOperation(provider,intents.label,signal);
        need(delivered.closure===contentIdentity(ce)&&observed.labelsIdentity===delivered.operation.observation.labelsIdentity,'label-drift');
        await stage('delivered',{closure:contentIdentity(ce),commit,readback:contentIdentity(delivered)},delivered);
        const receipt=verifyCompletion(existing,contexts);await checkpoint('mark-delivered',closure);
        return {outcome:'completed',receipt,reused:true};
      }
      let delivered=await load('delivered');
      const label=await execute('label',closure,null,delivered!==null);
      await checkpoint('mark-delivered',closure);
      if(!delivered){delivered={closure:contentIdentity(ce),operation:label};
        await save('delivered',delivered,()=>checkpoint('mark-delivered',closure));}
      need(same(label.refs.intent,delivered.operation.refs.intent)&&same(label.refs.attempt,delivered.operation.refs.attempt)
        &&label.observation.labelsIdentity===delivered.operation.observation.labelsIdentity,'label-drift');
      await stage('delivered',{closure:contentIdentity(ce),commit,readback:contentIdentity(delivered)},delivered);
      const receipt=createCompletion({version:1,receipts},contexts);
      await save('receipt-intent',{receipt,delivered:contentIdentity(delivered)},()=>checkpoint('mark-delivered',closure));
      await save('receipt',receipt,()=>checkpoint('mark-delivered',closure));
      const read=await load('receipt');verifyCompletion(read,contexts);
      const observed=await observeControlledOperation(provider,intents.label,signal);
      need(observed.labelsIdentity===delivered.operation.observation.labelsIdentity,'label-drift');await checkpoint('mark-delivered',closure);
      return {outcome:'completed',receipt:read,reused:false};
    }catch(error){return {outcome:'blocked',finding:error instanceof CompletionFailure?error.message:'completion:invalid-or-unresolved',
      ...(reference?{reference}:{})};}
    finally{busy=false;}
  }
  return Object.freeze({close:options=>run('close',options),complete:options=>run('complete',options)});
}
