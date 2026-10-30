import {protectedWorkRestriction} from './owner-hold.mjs';
import {assertCapturedCandidate} from './delivery-contract.mjs';
import {executeDeliveryOperation} from './runtime.mjs';
import {nextDeliveryStage} from './delivery-planner.mjs';
import {bodyDigest,canonicalJSON} from './grants.mjs';
import {contentIdentity,compareEvidence,compareStageCollection,verifyCompletion,skillForRole} from './evidence.mjs';
import {githubId,repositoryCoordinates} from './index.mjs';
import {verifyAuthority} from './authority.mjs';
import {captureWorkspace,exportWorkspace} from './workspace.mjs';
import {selectInstructions} from './instructions.mjs';
import {createShapeFlow} from './shape.mjs';
import {createHookRunner} from './hooks.mjs';
import {createAcceptFlow} from './accept.mjs';
import {createCandidatePublication} from './candidate-publication.mjs';
import {createFinalReview,createProtectedMerge} from './final-review.mjs';
import {createCompletionFlow} from './completion.mjs';
import {createRecoveryFlow} from './recovery.mjs';
import {createRepairFlow} from './repair.mjs';
import {supportsStartCheckpoint} from './lifecycle.mjs';
import {loadApprovedInputs} from './host-source.mjs';
import {createDownstreamFanout} from './fanout.mjs';

const copy=structuredClone, same=(a,b)=>canonicalJSON(a)===canonicalJSON(b);
const need=(ok,code)=>{if(!ok)throw Error('core:'+code);};
const text=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const fields=(v,names)=>need(v&&same(Object.keys(v).sort(),names.split(' ').sort()),'schema');
// Stage identifiers and dispatch are owned by Core, never an Issue or an event.
export const coreStages=Object.freeze(['shape','shape-validator','publication','deliver','pre-accept-hooks',
  'accept','pre-commit-hooks','pr','ci','shaper-review','merge','final','closure','delivered','fanout','recovery','repair']);
const sequence=coreStages.slice(0,14);
const operations={publication:'publish-shape',pr:'commit-pr',ci:'observe-ci',final:'verify-deployment',closure:'close',delivered:'mark-delivered'};
const links={deliver:{publication:'publication'},accept:{hooks:'pre-accept-hooks'},
  'pre-commit-hooks':{accept:'accept'},pr:{accept:'accept',hooks:'pre-commit-hooks'},ci:{pr:'pr'},
  'shaper-review':{pr:'pr',ci:'ci'},merge:{review:'shaper-review'},final:{merge:'merge'},
  closure:{final:'final'},delivered:{closure:'closure'}};
const shared=['authority','grant','policy','core','runtime','repositoryId','issueId','scopeHash'];
function identity(t) {
  fields(t,'repository repositoryId issueId databaseId number');
  for(const k of ['repositoryId','databaseId','number'])githubId(t[k]);
  const [owner,repo,extra]=t.repository.split('/');
  need(!extra&&repositoryCoordinates(owner,repo).key===t.repository&&typeof t.issueId==='string'&&/^[A-Za-z0-9_=-]{1,256}$/.test(t.issueId),'identity');
}
function intake(r) {
  fields(r,'version target cycle request run expected');
  need(r.version===1&&text(r.cycle)&&text(r.request),'request');identity(r.target);
  fields(r.run,'id attempt');githubId(r.run.id);githubId(r.run.attempt);
  fields(r.expected,'stage decision');
  need(coreStages.includes(r.expected.stage)&&hash(r.expected.decision),'decision');
  return freeze(r);
}
function plan(p) {
  identity(p.target);
  need(text(p.cycle)&&p.visibility==='public'&&['personal','organization'].includes(p.ownership),'scope');
  need(bodyDigest(p.scopeBody)===p.binding.scopeHash&&p.binding.repositoryId===p.target.repositoryId
    &&p.binding.issueId===p.target.issueId,'scope');
  need(p.shapeBody===null?p.binding.shapeHash===null:bodyDigest(p.shapeBody)===p.binding.shapeHash,'shape');
  const receipts={}, ids=new Set();
  need(p.receipts&&p.evidenceCurrent,'evidence');
  need(p.transition===null||['recovery','repair'].includes(p.transition),'transition');
  let gap=false;
  for(const stage of p.transition?[]:sequence) {
    const submitted=p.receipts[stage];
    if(!submitted){gap=true;continue;}
    need(!gap,'evidence-gap');
    const e=compareEvidence(submitted,p.evidenceCurrent[stage]);need(e.stage===stage,'stage');
    for(const k of shared)need(e.binding[k]===p.binding[k],'evidence-binding');
    if(stage!=='shape')need(e.binding.shapeHash===p.binding.shapeHash,'evidence-binding');
    if(['shape','shape-validator','deliver','accept','shaper-review'].includes(stage)) {
      for(const k of ['id','request','result'])need(!ids.has(e.execution[k]),'independence');
      for(const k of ['id','request','result'])ids.add(e.execution[k]);
    }
    if(stage==='shape')need(e.inputs.body===p.binding.shapeHash,'shape');
    if(stage==='shape-validator')need(e.inputs.author===receipts.shape.execution.id,'author');
    if(stage==='publication')need(e.inputs.author===receipts.shape.execution.id
      &&e.inputs.validator===receipts['shape-validator'].execution.id,'validator');
    for(const [key,upstream] of Object.entries(links[stage]??{}))
      need(e.inputs[key]===contentIdentity(receipts[upstream]),'evidence-link');
    if(e.inputs.candidate) {
      need(same(e.inputs.candidate,p.candidate),'candidate');
      if(stage!=='deliver')need(same(e.inputs.candidate,receipts.deliver.inputs.candidate),'candidate');
    }
    if(['pr','ci','shaper-review','merge'].includes(stage))need(e.inputs.base===p.base&&e.inputs.head===p.head,'head');
    if(stage==='pr')need(e.inputs.base===p.candidate.base,'base');
    if(stage==='ci')need(e.inputs.policy===p.binding.policy,'ci');
    if(stage==='accept')need(e.inputs.deliver===receipts.deliver.execution.id,'deliver');
    if(stage==='shaper-review')for(const [key,s] of Object.entries({author:'shape',validator:'shape-validator',deliver:'deliver',accept:'accept'}))
      need(e.inputs[key]===receipts[s].execution.id,'review');
    if(['final','closure','delivered'].includes(stage))need(e.inputs.commit===receipts.merge.inputs.commit,'commit');
    receipts[stage]=e;
  }
  if(p.completion)verifyCompletion(p.completion,p.completionCurrent);
  const stage=nextDeliveryStage(receipts,p.transition);
  // These inputs come from the recovery/repair owners' attributed, authorized handoffs.
  // Their respective run methods independently classify and recheck permission.
  const inputs={...(p.requirementRevision?{requirementRevision:p.requirementRevision}:{}),
    ...(p.referenceInputApproval?{referenceInputApproval:p.referenceInputApproval}:{}),binding:p.binding,scopeHash:p.binding.scopeHash,shapeHash:p.binding.shapeHash,
    candidate:p.candidate,base:p.base,head:p.head,ci:p.ciIdentity,cycle:p.cycle,
    receipts:Object.fromEntries(Object.entries(p.transition?p.receipts:receipts).map(([s,e])=>[s,contentIdentity(e)])),
    completion:p.completion?.identity??null,transition:p.transition,prior:contentIdentity(p.prior),
    operation:p.operationIdentity,stageInput:contentIdentity(p.stageInput),
    selection:contentIdentity(p.selectionInput),dependencies:contentIdentity(p.dependencyInput)};
  return {stage,identity:contentIdentity({target:p.target,...inputs}),inputs};
}
// Bind owner-local verification to the decision being executed, not merely the
// same Issue/authority. Each owner still independently validates these inputs.
function ownerContext(value,p,name) {
  if(['accept','publication','review','merge'].includes(name))
    need(same(value.workspace?.candidate,p.candidate),'owner-candidate');
  if(name==='deliver'){need(value.capture?.base===p.base,'owner-base');
    need(same(value.publication,p.receipts.publication),'owner-publication');}
  const aliases={author:'shape',validator:'shape-validator',firstStage:'pre-accept-hooks',secondStage:'pre-commit-hooks'};
  for(const [key,item] of Object.entries(value.evidence??{})) {
    const stage=aliases[key]??key;
    if(p.receipts[stage])need(same(item.value,p.receipts[stage]),'owner-evidence');
  }
  if(name==='completion')for(const stage of sequence.slice(2,12))
    need(same(value.receipts?.[stage],p.receipts[stage]),'owner-evidence');
  if(name==='accept')need(same(value.deliver,p.receipts.deliver)
    &&same(value.hooks?.stage,p.receipts['pre-accept-hooks']),'owner-evidence');
  if(['review','merge'].includes(name))need(value.observation?.head===p.head
    &&value.observation?.base===p.base,'owner-head');
}
function ownerEvidence(e,p,stage) {
  need(e.stage===stage,'owner-stage');
  for(const k of [...shared,'shapeHash'])if(!(stage==='shape'&&k==='shapeHash'))
    need(e.binding[k]===p.binding[k],'owner-binding');
  if(stage!=='deliver'&&e.inputs.candidate&&p.candidate!==null)need(same(e.inputs.candidate,p.candidate),'owner-candidate');
  for(const k of ['base','head'])if(k in e.inputs)need(e.inputs[k]===p[k],'owner-head');
  for(const [key,upstream] of Object.entries(links[stage]??{}))
    need(e.inputs[key]===contentIdentity(p.receipts[upstream]),'owner-evidence');
  if(stage==='accept')need(e.inputs.deliver===p.receipts.deliver.execution.id,'owner-evidence');
  if(stage==='shape-validator')need(e.inputs.author===p.receipts.shape.execution.id
    &&e.inputs.body===p.binding.shapeHash,'owner-evidence');
  if(stage==='shaper-review')for(const [key,s] of Object.entries({author:'shape',validator:'shape-validator',deliver:'deliver',accept:'accept'}))
    need(e.inputs[key]===p.receipts[s].execution.id,'owner-evidence');
}
function shapeChain(value,p,validated=false) {
  need(value.original?.kind==='raw-scope'&&value.original.body===p.scopeBody
    &&value.original.hash===p.binding.scopeHash,'owner-scope');
  need(value.author?.body===p.shapeBody&&same(value.author.receipt,p.receipts.shape),'owner-author');
  if(validated)need(value.validator?.body===p.shapeBody
    &&same(value.validator.receipt,p.receipts['shape-validator']),'owner-validator');
}
function shapeResult(value,p,stage) {
  if(stage==='shape'&&value.outcome==='authored') {
    need(value.original?.body===p.scopeBody&&value.original.hash===p.binding.scopeHash,'owner-scope');
    ownerEvidence(value.author.receipt,p,'shape');
    need(value.author.receipt.inputs.body===bodyDigest(value.author.body),'owner-body');
  }
  if(stage==='shape-validator'&&value.outcome==='validated') {
    shapeChain(value,p);ownerEvidence(value.validator.receipt,p,stage);
    need(value.validator.body===p.shapeBody,'owner-body');
  }
  if(stage==='publication'&&value.outcome==='published') {
    const v=value.publication;
    need(v.original?.body===p.scopeBody&&v.original.hash===p.binding.scopeHash
      &&v.shapeHash===p.binding.shapeHash&&same(v.author,p.receipts.shape.execution)
      &&same(v.validator,p.receipts['shape-validator'].execution)
      &&v.validation===contentIdentity(p.receipts['shape-validator']),'owner-publication');
    for(const k of [...shared,'shapeHash'])need(v.binding[k]===p.binding[k],'owner-binding');
  }
}
/** Inert composition of maintained owners. Configuration is a trusted host boundary.
 * current() resolves independent expectations/custody; it must not trust receipts
 * to choose their own expectations. No callback supplied by request data is used.
 */
export function createCore({current,provider,authorization,dependencies,selector,owners,referenceInputs,checkpoint,onDiagnostic}={}) {
  need(typeof current==='function'&&typeof authorization?.eligibility==='function'
    &&typeof provider?.request==='function'&&typeof dependencies?.evaluate==='function'&&typeof selector?.select==='function'&&owners,'capabilities');
  const read=current,request=provider.request.bind(provider), eligibility=authorization.eligibility.bind(authorization),
    evaluate=dependencies.evaluate.bind(dependencies),select=selector.select.bind(selector);
  const factories={shape:createShapeFlow,deliver:createDeliverFlow,hooks:createHookRunner,accept:createAcceptFlow,
    publication:createCandidatePublication,review:createFinalReview,merge:createProtectedMerge,
    completion:createCompletionFlow,fanout:createDownstreamFanout,recovery:createRecoveryFlow,repair:createRepairFlow};
  need(checkpoint===undefined||typeof checkpoint==='function','checkpoint');
  need(onDiagnostic===undefined||typeof onDiagnostic==='function','diagnostic');
  let executing=null,executionSignal,executionDependencies;
  const checkExecution=async()=>{
    need(protectedWorkRestriction((await read()).restrictions)===null,'execution-restriction');
    if(checkpoint) {
    need(!executionSignal?.aborted,'cancelled');
    await checkpoint({signal:executionSignal});
    if(executing) {
      const live=await read();
      need(same(plan(live),plan(executing))&&same(live.invocation,executing.invocation),'checkpoint-drift');
      const deps=await evaluate(copy(executing.dependencyInput),{signal:executionSignal});
      need(deps.outcome==='ready'&&same(deps.target,executing.target)
        &&same({edges:deps.edges,completions:deps.completions},executionDependencies),'checkpoint-dependencies');
      const target=executing.target,stage=plan(executing).stage;
      const issue=await request({method:'GET',endpoint:'/repos/'+target.repository+'/issues/'+target.number,
        target:target.repositoryId,operation:'core-read',correlation:executing.invocation.request,signal:executionSignal});
      need(issue.outcome==='read'&&issue.data?.id===target.databaseId&&issue.data.node_id===target.issueId
        &&(issue.data.state==='open'||Boolean(executing.receipts.closure)||executing.transition==='recovery')
        &&(issue.data.body===(executing.receipts.publication?executing.shapeBody:executing.scopeBody)
          ||stage==='publication'&&issue.data.body===executing.shapeBody),'checkpoint-scope');
    }
  }};
  const owned={};
  for(const [name,factory] of Object.entries(factories))if(owners[name]) {
    const config={...owners[name]},ownerCurrent=config.current;
    if(checkpoint && typeof config.operations==='function') {
      const operations=config.operations;
      config.operations=options=>{
        const before=options.beforeSubmit;
        return operations({...options,beforeSubmit:async(...args)=>{
          if(before)await before(...args);
          await checkExecution();
        }});
      };
    }
    if(typeof ownerCurrent==='function')config.current=async(...args)=>{
      const value=await ownerCurrent(...args),live=await read(),p=executing??live;
      if(executing){need(!executionSignal?.aborted,'cancelled');need(same(plan(live),plan(p)),'owner-drift');}
      for(const k of shared)need(value.binding?.[k]===p.binding[k],'owner-binding');
      need(value.binding.shapeHash===p.binding.shapeHash,'owner-binding');
      const repository=value.target?.repository??value.repository;
      need(repository===p.target.repository,'owner-binding');
      ownerContext(value,executing??p,name);
      await checkExecution();
      return value;
    };
    if(typeof config.prepareRole==='function') {
      const prepare=config.prepareRole;
      config.prepareRole=async task=>{
        const before=await read();
        let references;
        if(before.referenceInputApproval)need(hash(before.referenceInputApproval)&&typeof referenceInputs==='function','reference-inputs');
        if(referenceInputs!==undefined) {
          need(typeof referenceInputs==='function','reference-inputs');
          const spec=await referenceInputs({role:task.role,scopeHash:before.binding.scopeHash});
          if(before.referenceInputApproval)need(contentIdentity(spec.approval)===before.referenceInputApproval,'reference-approval');
          need(spec.expected.role===task.role&&spec.expected.requirements.scopeHash===before.binding.scopeHash
            &&spec.expected.requirements.revision===before.requirementRevision,'reference-inputs');
          references=await loadApprovedInputs(spec);
          need(same(plan(await read()),plan(before)),'reference-drift');
        }
        const prepared=await prepare(references?{...task,referenceInputs:references}:task),p=await read(),e=prepared.input.execution;
        if(executing){need(!executionSignal?.aborted,'cancelled');need(same(plan(p),plan(executing)),'owner-drift');}
        need(e.role===task.role&&e.skill===task.skill,'role');
        const used=Object.values(p.receipts).flatMap(r=>['id','request','result'].map(k=>r.execution[k]));
        need(['id','request','result'].every(k=>!used.includes(e[k])),'independence');
        const signal=executionSignal,lifecycle=prepared.lifecycle;
        need(!checkpoint||supportsStartCheckpoint(lifecycle),'lifecycle-checkpoint-unavailable');
        return {...prepared,lifecycle:{...lifecycle,start:async input=>{
          await checkExecution();
          need(!signal?.aborted,'cancelled');return lifecycle.start(input,{signal,...(checkpoint?{beforeStart:checkExecution}:{})});
        }}};
      };
    }
    owned[name]=factory(config);
  }
  const ciProvider=owners.ci?.provider,ciMode=owners.ci?.mode,hookInput=owners.hookInput;
  need(ciMode===undefined||['github-repository','signed'].includes(ciMode),'ci-mode');
  let busy=false;const invoked=new Set(),runStages=new Map();
  const observe=(r,signal)=>typeof provider.freshReadObservation==='function'
    ?provider.freshReadObservation(()=>observeFresh(r,signal)):observeFresh(r,signal);
  async function observeFresh(r,signal) {
    const p=freeze(copy(await read()));
    need(same(p.target,r.target)&&p.cycle===r.cycle&&same(p.invocation,{request:r.request,run:r.run}),'binding');
    const decision=plan(p);
    const refuse=(ok,gate,observation=null)=>{
      if(!ok)throw {decision:{...decision,identity:contentIdentity({decision:decision.identity,gate,observation})},gate};
    };
    refuse(protectedWorkRestriction(p.restrictions)===null,'execution-restriction');
    refuse(!Object.values(p.receipts).some(e=>e.execution.source?.runId===r.run.id),'historical-run-reuse');
    const options={method:'GET',target:p.target.repositoryId,operation:'core-read',correlation:r.request,signal};
    const root='/repos/'+p.target.repository;
    const repository=await request({...options,endpoint:root});
    refuse(repository.outcome==='read'&&repository.data?.id===p.target.repositoryId
      &&repository.data.full_name?.toLowerCase()===p.target.repository&&repository.data.private===false,'repository');
    const issue=await request({...options,endpoint:root+'/issues/'+p.target.number});
    const actual=issue.data;
    refuse(issue.outcome==='read'&&actual?.id===p.target.databaseId&&actual.node_id===p.target.issueId
      &&String(actual.number)===p.target.number&&!actual.pull_request&&actual.repository_url==='https://api.github.com'+root
      &&(actual.body===(p.receipts.publication?p.shapeBody:p.scopeBody)
        ||decision.stage==='publication'&&p.prior?.state==='unresolved'&&actual.body===p.shapeBody),'issue');
    refuse(actual.state==='open'||Boolean(p.receipts.closure)||p.transition==='recovery','issue-state');
    need(!signal?.aborted,'cancelled');
    const operation=operations[decision.stage]??decision.stage;
    const auth=await eligibility({operation,correlation:r.request},{signal});
    refuse(auth.ok===true&&auth.observation.repositoryId===p.target.repositoryId
      &&auth.observation.issueId===p.target.issueId&&auth.observation.operation===operation,'authorization');
    const authority=verifyAuthority(p.authority.export,p.authority.context);
    refuse(authority.ok&&authority.binding.identity===p.binding.authority&&authority.binding.cycle===p.cycle,'authority');
    const deps=await evaluate(copy(p.dependencyInput),{signal});
    refuse(deps.outcome==='ready'&&same(deps.target,p.target),'dependencies',deps);
    refuse(p.selectionInput.operation===operation&&p.selectionInput.execution.operation===operation,'selection-operation');
    const selection=await select(copy(p.selectionInput),{signal});
    refuse(selection.outcome==='selected'&&selection.observation.repositoryId===p.target.repositoryId
      &&selection.observation.issueId===p.target.issueId,'selection',selection);
    // Bind semantic graph/routing data, not observation timestamps, to queued work.
    decision.identity=contentIdentity({decision:decision.identity,edges:deps.edges,completions:deps.completions,
      member:selection.memberId,routing:selection.routing});
    const after=freeze(copy(await read()));
    need(same(plan(after),plan(p))&&same(after.invocation,p.invocation),'drift');
    need(!signal?.aborted,'cancelled');
    return {pin:p,decision,dependencies:{edges:deps.edges,completions:deps.completions}};
  }
  function result(r,d,disposition,reason,stage=null,owner=null) {
    return {version:1,target:r.target,cycle:r.cycle,request:r.request,run:r.run,
      requested:r.expected,current:d?{stage:d.stage,decision:d.identity}:null,
      executed:stage,disposition,reason,inputs:d?.inputs??null,
      owner:owner?{outcome:owner.outcome??owner.status??null,identity:contentIdentity(owner),output:owner}:null};
  }
  async function dispatch(p,stage,signal,resume) {
    if(['shape-validator','publication'].includes(stage))shapeChain(p.stageInput,p,stage==='publication');
    return executeDeliveryOperation({p,stage,signal,resume,owned,hookInput,ciProvider,ciMode});
  }

  return Object.freeze({
    async inspect(input,{signal}={}) {
      let r;
      try {r=intake(copy(input));const {decision}=await observe(r,signal);return result(r,decision,'waiting','evaluated');}
      catch(e) {return r?result(r,e?.decision??null,'blocked',e?.gate??'invalid-or-unavailable'):{version:1,disposition:'rejected',reason:'invalid-request'};}
    },
    async run(input,{signal}={}) {
      let r,d,launched=false,acquired=false;
      try {
        r=intake(copy(input));
        if(busy)return result(r,null,'blocked','busy');busy=true;acquired=true;
        const observed=await observe(r,signal),p=observed.pin;d=observed.decision;
        if(r.expected.stage!==d.stage||r.expected.decision!==d.identity)return result(r,d,'superseded','fresh-decision-required');
        const prior=p.prior;
        need(prior&&['new','resolved','unresolved'].includes(prior.state),'prior-evidence');
        if(prior.state==='resolved')return result(r,d,'waiting','original-result-retained');
        const resume=prior.state==='unresolved';
        if(resume)need(prior.request?.request===r.request&&prior.stage===d.stage,'reconciliation');
        // Owners guard writes after their own awaited reads. This additional boundary
        // refuses an operation if queued inputs drifted during Core's reads.
        const fresh=await observe(r,signal);
        if(fresh.decision.identity!==d.identity)return result(r,fresh.decision,'superseded','checkpoint-drift');
        if(runStages.has(r.run.id)&&runStages.get(r.run.id)!==d.stage)return result(r,d,'blocked','run-stage-already-bound');
        const invocation=contentIdentity(r.run);
        if(!resume&&invoked.has(invocation))return result(r,d,'blocked','invocation-already-attempted');
        invoked.add(invocation);runStages.set(r.run.id,d.stage);executing=p;executionSignal=signal;executionDependencies=fresh.dependencies;launched=true;const owner=await dispatch(p,d.stage,signal,resume);
        if(owner?.evidence)ownerEvidence(owner.evidence,p,d.stage);
        if(['shape','shape-validator','publication'].includes(d.stage))shapeResult(owner,p,d.stage);
        const descriptor=owner?.value?.candidate??owner?.receipt?.binding?.workspace;
        if(descriptor)need(same(descriptor.candidate,p.candidate),'owner-candidate');
        if(d.stage==='delivered'&&owner?.receipt?.payload)for(const [stage,e] of Object.entries(p.receipts))if(!['shape','shape-validator'].includes(stage))
          need(same(owner.receipt.payload.receipts[stage],e),'owner-evidence');
        const value=owner?.outcomes?.some(x=>['blocked','waiting','failed'].includes(x.outcome))?'blocked':owner?.outcome??owner?.status;
        const unresolved=owner?.reconciliationRequired||owner?.disposition==='reconcile'
          ||owner?.outcomes?.some(x=>x.outcome==='unknown')
          ||[owner?.operation,owner?.bodyResult,owner?.labelResult].some(x=>x?.outcome==='unknown');
        const disposition=unresolved?'unresolved':['blocked','failed','rejected','waiting','pending','unknown','cancelled'].includes(value)
          ?(['waiting','pending'].includes(value)?'waiting':value==='rejected'?'rejected':value==='unknown'?'unresolved':'blocked')
          :owner?.ok===false?'blocked':
            ['authored','validated','published','ready','accepted','approved','confirmed-success','closed','completed',
              'delivered','observed','qualified','not-applicable','retained','woken','success','satisfied','merged','handoff','discovered'].includes(value)||owner?.ok===true?'completed':'blocked';
        return result(r,d,signal?.aborted&&disposition==='completed'?'blocked':disposition,
          signal?.aborted?'cancelled':'owner-result',d.stage,owner);
      }catch(e){
        if(onDiagnostic)try{await onDiagnostic({phase:launched?'owner':'intake',stage:d?.stage??null,
          code:typeof e?.message==='string'&&/^(?:core|shape|operations|runtime|evidence|authority|lifecycle):[a-z-]{1,100}$/.test(e.message)?e.message:'core:unavailable'});}catch{/* Diagnostics never change the disposition. */}
        return r?result(r,e?.decision??d,launched?'unresolved':'blocked',e?.decision?e.gate:'invalid-or-unavailable',launched?d.stage:null)
        :{version:1,disposition:'rejected',reason:'invalid-request'};}
      finally{if(acquired){executing=null;executionSignal=undefined;executionDependencies=undefined;busy=false;}}
    }
  });
}

/** Writer seam: lifecycle owns isolation/result parsing, workspace owns capture.
 * A retained unresolved execution is collected again, never launched again.
 */
export function createDeliverFlow({current,captureInput,prepareRole,evidenceCurrent}={}) {
  need([current,captureInput,prepareRole,evidenceCurrent].every(f=>typeof f==='function'),'capabilities');
  let active=null,busy=false;const used=new Set();
  async function checkpoint(pin){need(same(await current(),pin),'drift');}
  async function finish() {
    const a=active;await checkpoint(a.pin);
    // Capture only after the Writer has stopped. The maintained role bridge can
    // then bind this owner's Candidate without asking the model to predict edits.
    const terminal=await a.lifecycle.termination(a.input.execution.id);
    need(terminal.termination?.status==='terminated','termination');
    const source=await captureInput();
    need(same({root:source.root,base:source.base,permittedPaths:source.permittedPaths,binding:source.binding},a.pin.capture)
      &&source.scopeBody===a.pin.scopeBody&&source.shapeBody===a.pin.shapeBody,'capture-binding');
    const w=captureWorkspace(source);
    if(a.bindCandidate)await a.bindCandidate(w.candidate);
    const collected=a.collected??await a.lifecycle.collect(a.input.execution.id);
    if(['valid','rejected'].includes(collected.result?.status))a.collected=collected;
    if(['valid','rejected','invalid','absent'].includes(collected.result?.status))active=null;
    const raw=collected.result?.evidence??collected.result?.collection;
    const checked=compareStageCollection(raw,await evidenceCurrent(a.input.execution.id),a.pin);
    need(raw.stage==='deliver'&&same(raw.execution,a.input.execution)&&same(raw.binding,a.input.binding),'role');
    await checkpoint(a.pin);
    if(checked.status!=='valid'){active=null;return {outcome:'rejected',collection:checked.collection};}
    need(same(raw.inputs.candidate,w.candidate)&&raw.inputs.publication===contentIdentity(a.pin.publication),'candidate');
    assertCapturedCandidate(w,a.pin.shapeBody,checked.evidence);
    await checkpoint(a.pin);
    active=null;return {outcome:'ready',evidence:checked.evidence,workspace:JSON.parse(exportWorkspace(w))};
  }
  async function exclusive(fn) {
    if(busy)return {outcome:'blocked'};busy=true;
    try{return await fn();}catch{return {outcome:'blocked',...(active?{reconciliationRequired:active.input.execution.id}:{})};}
    finally{busy=false;}
  }
  return Object.freeze({
    run(){return exclusive(async()=>{
      need(!active,'active');const pin=freeze(copy(await current()));await checkpoint(pin);
      const publication=compareEvidence(pin.publication,pin.publicationCurrent);
      need(publication.stage==='publication'&&publication.binding.scopeHash===bodyDigest(pin.scopeBody)
        &&publication.binding.shapeHash===bodyDigest(pin.shapeBody),'publication');
      const instructions=selectInstructions({...pin.instructions,skill:'deliver',role:'deliver'});
      const task=freeze({version:1,role:'deliver',skill:'deliver',repository:pin.repository,
        scopeBody:pin.scopeBody,shapeBody:pin.shapeBody,binding:pin.binding,capture:pin.capture,
        decisions:pin.decisions??[],publication:pin.publication});
      const {lifecycle,input,bindCandidate}=await prepareRole({role:'deliver',skill:'deliver',instructions,task});
      need(bindCandidate===undefined||typeof bindCandidate==='function','candidate-handoff');
      need(input.execution.role==='deliver'&&input.execution.skill===skillForRole('deliver')
        &&same(input.binding,pin.binding)&&same(input.instructions,instructionsFor(instructions)),'role');
      for(const k of ['id','request','result'])need(!used.has(input.execution[k]),'reuse');
      await checkpoint(pin);for(const k of ['id','request','result'])used.add(input.execution[k]);
      active={pin,input:freeze(copy(input)),lifecycle,bindCandidate};
      const started=await lifecycle.start(input);
      if(started.start?.status==='rejected')active=null;
      need(started.start?.status==='started','start');return finish();
    });},
    reconcile(){return exclusive(async()=>{need(active,'active');return finish();});}
  });
}
const instructionsFor=i=>({identity:i.identity,content:i.content});
