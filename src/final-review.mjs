import {observeRepositoryCI} from './github.mjs';
import {canonicalJSON,bodyDigest} from './grants.mjs';
import {compareEvidence,compareStageCollection,contentIdentity} from './evidence.mjs';
import {verifyWorkspace,exportWorkspace} from './workspace.mjs';
import {verifyHookReceipt} from './hooks.mjs';
import {parseCandidateObligations,reconcileCandidateObligations} from './obligations.mjs';
import {selectInstructions} from './instructions.mjs';
import {observeGithubCI} from './ci.mjs';
import {controlledIntent} from './operations.mjs';
import {nativeConcurrency} from './concurrency.mjs';
const same=(a,b)=>canonicalJSON(a)===canonicalJSON(b);
const need=(ok,why='input')=>{if(!ok)throw Error('final-review:'+why);};
const frozen=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(frozen);Object.freeze(v);}return v;};
const shared=['authority','grant','policy','core','runtime','repositoryId','issueId','scopeHash','shapeHash'];
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);

// Validate the same producer contracts as accepted-candidate publication, plus PR/CI.
function intake(p,w) {
  verifyWorkspace(w,p.workspace);
  const b=p.binding,t=p.target;
  need(Array.isArray(p.decisions),'decisions');
  need(p.visibility==='public'&&['personal','organization'].includes(p.ownership),'public');
  need(bodyDigest(p.scopeBody)===b.scopeHash&&bodyDigest(p.shapeBody)===b.shapeHash,'provenance');
  need(t.repository===p.repository&&t.repositoryId===b.repositoryId&&t.issueId===b.issueId,'target');
  need(same(w.expected.binding,{repository:p.repository,cycle:t.cycle,policy:b.policy,scopeHash:b.scopeHash,shapeHash:b.shapeHash}),'workspace');
  const parsed=parseCandidateObligations(p.shapeBody);
  need(reconcileCandidateObligations(parsed,p.obligations).ok&&same(parsed.inventory,w.metadata.inventory),'inventory');
  const r={};
  for(const [name,stage] of Object.entries({author:'shape',validator:'shape-validator',publication:'publication',
    deliver:'deliver',accept:'accept',secondStage:'pre-commit-hooks',pr:'pr',ci:'ci'})) {
    const e=p.evidence[name];r[name]=compareEvidence(e.value,e.current);need(r[name].stage===stage,'stage');
    for(const k of shared)if(!(name==='author'&&k==='shapeHash'))need(r[name].binding[k]===b[k],'binding');
  }
  const {author,validator,publication,deliver,accept,secondStage,pr,ci}=r,h=p.hooks;
  need(author.inputs.body===b.shapeHash&&validator.inputs.author===author.execution.id
    &&publication.inputs.author===author.execution.id&&publication.inputs.validator===validator.execution.id
    &&publication.inputs.validation===contentIdentity(validator)&&deliver.inputs.publication===contentIdentity(publication),'publication');
  for(const s of [deliver,accept,secondStage,pr])need(same(s.inputs.candidate,w.candidate),'candidate');
  need(accept.inputs.deliver===deliver.execution.id&&accept.inputs.hooks===contentIdentity(h.firstStage)
    &&secondStage.inputs.accept===contentIdentity(accept)&&pr.inputs.accept===contentIdentity(accept)
    &&pr.inputs.hooks===contentIdentity(secondStage)&&pr.inputs.base===w.candidate.base,'chain');
  need(ci.inputs.pr===contentIdentity(pr)&&ci.inputs.head===pr.inputs.head&&ci.inputs.base===pr.inputs.base
    &&ci.inputs.policy===b.policy&&ci.inputs.checks===contentIdentity(p.observation.ci),'ci');
  verifyHookReceipt(h.receipt,{workspace:w,expected:p.workspace,profile:h.profile,message:Buffer.from(h.message,'base64'),
    observation:p.obligations.hookObservation,phase:'pre-commit',executionId:h.executionId,
    first:h.first,firstExecutionId:h.firstExecutionId,firstReceiptCurrent:h.firstReceiptCurrent,
    firstStage:h.firstStage,firstStageCurrent:h.firstStageCurrent,firstStageIdentity:contentIdentity(h.firstStage),
    accept,acceptCurrent:p.evidence.accept.current},h.receiptCurrent);
  need(secondStage.inputs.receipt===h.receipt.identity&&same(h.firstStage.inputs.candidate,w.candidate),'hooks');
  for(const k of shared)need(h.firstStage.binding[k]===b[k],'hooks-binding');
  need(p.observation.head===pr.inputs.head&&p.observation.base===pr.inputs.base&&p.observation.tree===w.candidate.tree,'pr');
  need(pr.inputs.readback===contentIdentity(p.publication.pr.observation)&&p.publication.pr.outcome==='confirmed-success'
    &&p.publication.commit===pr.inputs.head&&p.publication.tree===w.candidate.tree
    &&p.publication.base===w.candidate.base&&same(p.publication.candidate,p.workspace)
    &&p.publication.accept===contentIdentity(accept)&&p.publication.hooks===contentIdentity(secondStage)
    &&p.publication.pr.observation.id===t.prId,'published-candidate');
  return {candidate:w.candidate,pr:contentIdentity(pr),ci:contentIdentity(ci),head:pr.inputs.head,base:pr.inputs.base,
    author:author.execution.id,validator:validator.execution.id,deliver:deliver.execution.id,accept:accept.execution.id};
}

/** Read-only official observations, separate from the mutation capability. Native
 * CI may be pending; signed source policies are additionally enforced at merge.
 */
export async function observeFinalReview({provider,target,head,base,actions=[],ciMode='signed'}={}) {
  const root=`/repos/${target.repository}`;
  const read=async path=>{const r=await provider.request({method:'GET',endpoint:root+path,
    operation:'observe-final',correlation:'final',target:target.repositoryId});need(r.outcome==='read','read');return r.data;};
  const repo=await read(''),pr=await read(`/pulls/${target.prNumber}`);
  need(repo.id===target.repositoryId&&repo.full_name?.toLowerCase()===target.repository&&repo.private===false
    &&repo.visibility==='public'&&['User','Organization'].includes(repo.owner?.type),'repository');
  need(pr.id===target.prId&&String(pr.number)===target.prNumber&&pr.head?.sha===head&&pr.base?.sha===base
    &&pr.base?.ref===target.baseRef&&pr.base?.repo?.id===target.repositoryId&&pr.head?.repo?.id===target.repositoryId
    &&pr.head?.ref===target.headRef&&pr.state==='open'&&pr.merged===false&&pr.draft===false,'pr-state');
  const branch=await read(`/branches/${encodeURIComponent(target.baseRef)}`);
  need(branch.name===target.baseRef&&branch.commit?.sha===base&&typeof branch.protected==='boolean','branch');
  need(['signed','github-repository'].includes(ciMode),'ci-mode');
  const protection=ciMode==='github-repository'?{}:await read(`/branches/${encodeURIComponent(target.baseRef)}/protection`);
  const checks=protection.required_status_checks;
  const directEnforced=protection.enforce_admins?.enabled===true&&checks?.strict===true
    &&Array.isArray(checks.contexts)&&Array.isArray(checks.checks)&&(checks.contexts.length>0||checks.checks.length>0);
  const commit=await read(`/commits/${head}`);need(commit.sha===head&&sha(commit.commit?.tree?.sha),'tree');
  const ci=await (ciMode==='github-repository'?observeRepositoryCI:observeGithubCI)({provider,expected:{repository:target.repository,repositoryId:target.repositoryId,
    prId:target.prId,pr:Number(target.prNumber),head,baseSha:base,baseRepositoryId:target.repositoryId,baseBranch:target.baseRef},actions});
  need(ci.policy&&['satisfied','pending','failed'].includes(ci.status),'protection-unreadable');
  // Exclude observation timestamps; retain all semantic source/policy/check inputs.
  const {provenance,...boundCI}=ci;
  return {head,base,tree:commit.commit.tree.sha,protected:branch.protected,directEnforced,ownership:repo.owner.type==='User'?'personal':'organization',
    permission:repo.permissions?.push===true,methods:{merge:repo.allow_merge_commit,squash:repo.allow_squash_merge,rebase:repo.allow_rebase_merge},
    mergeable:pr.mergeable,mergeableState:pr.mergeable_state,ci:boundCI};
}

/** Core capabilities only. prepareRole transfers the entire task or rejects it;
 * lifecycle enforces read-only access. No mutation capability enters this task.
 */
export function createFinalReview({current,workspace,observe,prepareRole,evidenceCurrent}={}) {
  need([current,workspace,observe,prepareRole,evidenceCurrent].every(f=>typeof f==='function'),'capabilities');
  let active=null,busy=false;const used=new Set();
  async function checkpoint(pin) {
    need(same(await current(),pin),'drift');const w=await workspace(),inputs=intake(pin,w);
    need(same(await observe(),pin.observation),'native-drift');
    need(pin.observation.ownership===pin.ownership,'ownership');
    need(same(await current(),pin),'drift');return {w,inputs};
  }
  async function finish() {
    const a=active;
    try {
      await checkpoint(a.pin);let collected,terminal;
      try {collected=a.collected??await a.lifecycle.collect(a.input.execution.id);
        if(['valid','rejected'].includes(collected.result?.status))a.collected=collected;}
      finally {terminal=await a.lifecycle.termination(a.input.execution.id);}
      need(terminal.termination?.status==='terminated','execution-unresolved');
      if(!['pending','unknown','unresolved'].includes(collected.result?.status))active=null;
      need(['valid','rejected'].includes(collected.result?.status),'result');
      const raw=collected.result.evidence??collected.result.collection;
      const checked=compareStageCollection(raw,await evidenceCurrent(a.input.execution.id),{scopeBody:a.pin.scopeBody,shapeBody:a.pin.shapeBody});
      need(same(raw.execution,a.input.execution)&&same(raw.binding,a.input.binding)&&same(raw.inputs,a.inputs),'foreign-result');
      await checkpoint(a.pin);active=null;
      return checked.status==='valid'?{outcome:'approved',evidence:checked.evidence,context:contentIdentity(a.pin)}:
        {outcome:'rejected',result:checked.collection.result,execution:checked.collection.execution};
    }catch{return {outcome:'blocked',finding:'final-review:invalid-or-unresolved',...(active?{reconciliationRequired:active.input.execution.id}:{})};}
  }
  async function exclusive(fn){if(busy)return {outcome:'blocked',finding:'final-review:busy'};busy=true;try{return await fn();}finally{busy=false;}}
  return Object.freeze({run(){return exclusive(async()=>{
    if(active)return {outcome:'blocked',finding:'final-review:reconciliation-required'};
    try {
      const pin=frozen(structuredClone(await current())),{w,inputs}=await checkpoint(pin);
      need(pin.instructions&&Object.keys(pin.instructions).every(k=>['repository','shared','approvals'].includes(k)),'instructions');
      const selected=selectInstructions({...pin.instructions,skill:'shape',role:'shaper-review'});
      need(selected.identity===pin.binding.instructions,'instructions');
      const task=frozen({version:1,role:'shaper-review',skill:'shape',...pin,
        workspace:JSON.parse(exportWorkspace(w).toString()),expected:pin.workspace});
      need(Buffer.byteLength(canonicalJSON(task))<=64*1024*1024,'task-limit');
      const {lifecycle,input,taskIdentity}=await prepareRole({role:'shaper-review',skill:'shape',instructions:selected,task});
      need(taskIdentity===contentIdentity(task),'task-transfer');
      const e=input.execution;
      need(e.role==='shaper-review'&&e.skill==='shape'&&same(input.binding,pin.binding)
        &&same(input.instructions,{identity:selected.identity,content:selected.content})
        &&input.visibility===pin.visibility&&input.ownership===pin.ownership,'role');
      for(const name of ['author','validator','deliver','accept'])for(const k of ['id','request','result'])
        for(const j of ['id','request','result'])need(e[k]!==pin.evidence[name].value.execution[j],'independence');
      for(const k of ['id','request','result'])need(!used.has(e[k]),'reuse');
      const expected=(await evidenceCurrent(e.id)).expected;
      need(expected.stage==='shaper-review'&&same(expected.inputs,inputs)&&same(expected.execution,e)&&same(expected.binding,input.binding),'expectations');
      await checkpoint(pin);for(const k of ['id','request','result'])used.add(e[k]);
      active={pin,inputs,lifecycle,input:frozen(structuredClone(input))};
      const started=await lifecycle.start(input);
      if(!started.id||started.start?.status==='rejected')active=null;
      need(started.start?.status==='started','start');return await finish();
    }catch{return {outcome:'blocked',finding:'final-review:invalid-or-unresolved',...(active?{reconciliationRequired:active.input.execution.id}:{})};}
  });},reconcile(){return exclusive(async()=>active?finish():{outcome:'blocked',finding:'final-review:no-execution'});},
  stop(){return exclusive(async()=>{if(!active)return {outcome:'blocked',finding:'final-review:no-execution'};
    try {const id=active.input.execution.id,s=await active.lifecycle.termination(id);
      if(s.termination?.status!=='terminated')await active.lifecycle.stop(id);return await finish();}
    catch{return {outcome:'blocked',finding:'final-review:execution-unresolved'};}});}});
}

/** operations constructs the existing custody-backed controlled operations with
 * its native repository-write concurrency group. Review remains a separate cap.
 */
export function createProtectedMerge({current,workspace,observe,authorization,dependencies,dependencyInput,operations,mergeCurrent}={}) {
  need([current,workspace,observe,authorization?.eligibility,dependencies?.evaluate,operations,mergeCurrent].every(f=>typeof f==='function'),'capabilities');
  let busy=false;
  return Object.freeze({async run({signal}={}) {
    if(busy)return {outcome:'blocked',finding:'final-review:busy'};busy=true;
    try {
      const p=frozen(structuredClone(await current())),t=p.target;
      async function checkpoint(native=false) {
        need(!signal?.aborted&&same(await current(),p),'drift');
        const {review,...reviewed}=p;need(review.context===contentIdentity(reviewed),'review-context');
        const inputs=intake(p,await workspace()),r=compareEvidence(p.review.value,p.review.current);
        need(r.stage==='shaper-review'&&same(r.inputs,inputs),'review');
        for(const k of shared)need(r.binding[k]===p.binding[k],'review-binding');
        for(const name of ['author','validator','deliver','accept'])for(const k of ['id','request','result'])
          for(const j of ['id','request','result'])need(r.execution[k]!==p.evidence[name].value.execution[j],'independence');
        const a=await authorization.eligibility({operation:'merge',context:t,signal});
        need(a?.ok===true&&a.observation?.repositoryId===t.repositoryId&&a.observation?.issueId===t.issueId,'authorization');
        const d=await dependencies.evaluate(structuredClone(dependencyInput),{signal});
        need(d?.outcome==='ready'&&d.target?.repositoryId===t.repositoryId&&d.target?.issueId===t.issueId,'dependencies');
        if(native) {
          const o=await observe();need(same(o,p.observation),'native-drift');
          need(o.ownership===p.ownership&&o.permission&&o.methods[p.method]===true,'permission-or-method');
          need(!o.ci.policy.limitations.some(x=>x.type==='merge_queue'),'unsupported-required-merge-queue:REST-direct-only');
          if(p.ciMode!=='github-repository') {
            need(o.directEnforced===true,'direct-protection-bypass-or-unsupported');
            need(o.protected===true&&o.ci.policy.strict===true&&o.ci.policy.requirements.length>0,'strict-base-required');
          }
          need(o.protected===true,'protection-unreadable');
          need(o.mergeable===true&&['clean','has_hooks','unstable','blocked'].includes(o.mergeableState),'mergeability');
          need(p.ciMode==='github-repository'||p.ciMode==='signed'&&o.ci.qualifies===true,'signed-ci');
          need(o.ci.status!=='failed','ci-failed');
          need(o.ci.evaluations.filter(x=>x.requirement.kind==='actions').every(x=>x.status==='satisfied'),'signed-source-ci');
        }
        intake(p,await workspace());need(!signal?.aborted&&same(await current(),p),'drift');
      }
      await checkpoint();
      need(!p.observation.ci.policy.limitations.some(x=>x.type==='merge_queue'),'unsupported-required-merge-queue:REST-direct-only');
      if(p.ciMode!=='github-repository')need(p.observation.directEnforced===true,'direct-protection-bypass-or-unsupported');
      const b=p.binding,pr=p.evidence.pr.value.inputs;
      const intent=controlledIntent({version:1,kind:'merge',correlation:p.mergeCorrelation,source:p.source,
        binding:{repository:t.repository,repositoryId:t.repositoryId,issueId:t.issueId,number:t.number,cycle:t.cycle,
          scopeHash:b.scopeHash,shapeHash:b.shapeHash,authorization:b.grant,runId:p.source.runId,attempt:p.source.attempt,
          candidate:p.workspace.identity,base:pr.base,head:pr.head,baseRef:t.baseRef},
        target:{id:t.prId,number:t.prNumber,workflow:null},payload:{sha:pr.head,merge_method:p.method}});
      const guard=async actual=>{need(same(actual,intent),'intent');await checkpoint(true);};
      const ops=await operations({intent,beforeSubmit:guard,concurrency:nativeConcurrency({repository:t.repository,repositoryId:t.repositoryId,scope:'repository-write'})});
      const result=await ops.execute(intent,{signal});
      if(result.outcome!=='confirmed-success'||result.continuation!==true)return {outcome:'blocked',finding:'final-review:merge-unconfirmed',operation:result};
      await checkpoint();
      const expected=await mergeCurrent(result),e=compareEvidence(expected.expected,expected);
      need(e.stage==='merge'&&e.inputs.review===contentIdentity(p.review.value)&&e.inputs.head===pr.head&&e.inputs.base===pr.base
        &&e.inputs.commit===result.observation.mergeCommit&&e.inputs.readback===contentIdentity(result),'merge-evidence');
      for(const k of shared)need(e.binding[k]===b[k],'merge-binding');
      await checkpoint();
      return {outcome:'merged',evidence:e,operation:result};
    }catch(error){return {outcome:'blocked',finding:['final-review:unsupported-required-merge-queue:REST-direct-only','final-review:direct-protection-bypass-or-unsupported'].includes(error?.message)
      ?error.message:'final-review:invalid-or-unresolved'};}
    finally{busy=false;}
  }});
}
