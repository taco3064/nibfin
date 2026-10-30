import {rescueWorkRestriction} from './owner-hold.mjs';
// Recovery transitions adapted from Kairo PR54 rescue.mjs. Nibfin supplies its
// existing custody/state, controlled operations, eligibility and normal Core
// role owners; Rescue never executes a delivery stage or grants permissions.
import {contentIdentity} from './evidence.mjs';
import {verifyCompletion,compareEvidence} from './evidence.mjs';
import {controlledIntent} from './operations.mjs';
import {rescueNeed as need,rescueSame as same,validateRescuePolicy} from './rescue-policy.mjs';
import {validateRescueTarget,diagnoseRescueTarget} from './rescue-ai.mjs';
import {rescueConclusion,rescueReport} from './rescue-result.mjs';
const pending=new Set(['PENDING','DEFERRED','PENDING_VERIFICATION','STAGE_RECOVERED']);
const stopCodes=new Set(['OWNER_HOLD','INTENTIONAL_PAUSE','AUTHORITY_CHANGED','CONTRACT_CONFLICT','UNKNOWN_WRITE','MANUAL_CANCELLATION']);
export const eligibleRescueRecheck=c=>pending.has(c.outcome)&&c.nextCheckAt!==null;
export function rescueCaseIdentity({target,source,code}) {
  return contentIdentity({version:1,repositoryId:target.repositoryId,issueId:target.issueId,cycle:target.cycle,
    authority:target.authority,scopeHash:target.scopeHash,shapeHash:target.shapeHash,source,code});
}
export function createRescueController({policy,records,provenance,current,authorize,active,capture,
  deterministic,adapter,retainDiagnosis,continueRole,operations,intent,completion,now=Date.now}={}) {
  const p=validateRescuePolicy(policy);
  need([current,authorize,active,capture,deterministic,adapter,retainDiagnosis,continueRole,intent,completion,now].every(f=>typeof f==='function')
    &&typeof records?.read==='function'&&typeof records?.update==='function'&&typeof operations==='function'
    &&typeof provenance?.verify==='function'&&typeof provenance?.timeout==='function','configuration');
  const modify=async(id,fn)=>{const s=await records.update(s=>{need(s.cases[id],'missing-case');s.cases[id]=fn(s.cases[id]);return s;});return s.cases[id];};
  const result=c=>({...c,conclusion:rescueConclusion(c.outcome),continuation:false});
  async function diagnose(c,signal){
    if(c.diagnosis){need(c.diagnosis.status==='completed','ai-diagnosis-incomplete');return c;}
    await checkpoint(c);const before=await capture(c.target);
    c=await modify(c.id,c=>({...c,diagnosis:{attempted:true,status:'attempted'}}));
    const diagnostic=await diagnoseRescueTarget({target:c.target,adapter:await adapter(c.target),capture,retain:retainDiagnosis,signal});
    c=await modify(c.id,c=>({...c,diagnosis:{attempted:true,...diagnostic}}));
    need(diagnostic.status==='completed','adapter-unsupported');
    await checkpoint(c);need(same(await capture(c.target),before),'ai-mutation');return c;
  }
  async function checkpoint(c,{allowActive=false,verification=false}={}) {
    need(now()<p.expiresAt,'authority-expired');
    const state=await current(structuredClone(c.target));
    const stable=['repository','repositoryId','issueId','number','cycle','authority','requirements','scopeHash','memberId','sessionMemberId','runnerMemberId','runnerId'];
    need(state&&(verification?stable.every(k=>state.target?.[k]===c.target[k]):same(state.target,c.target)),'state-changed');
    need(rescueWorkRestriction(state)===null&&!state.conflict,'stopped');
    need(state.authority===p.authority&&state.target.authority===p.authority,'authority-changed');
    const a=await authorize({operation:'rescue',target:structuredClone(c.target)});
    need(a?.ok===true&&a.memberId===c.target.memberId&&a.runnerId===c.target.runnerId
      &&a.assignee===true&&['write','maintain','admin'].includes(a.permission)
      &&a.sessionMemberId===c.target.memberId,'membership');
    if(!allowActive)need(await active(c.target)===false,'agent-active');
    const source=await provenance.verify(c.source.runId,c.source.attempt);
    need(source.head_sha===c.source.head,'source-changed');
    if(source.conclusion==='cancelled')need(await provenance.timeout(source),'manual-cancellation');
    need(same(await current(c.target),state),'state-changed');
    return {state,source};
  }
  async function register({target,source,code,blocked}) {
    target=validateRescueTarget(target);
    need(target.repository===p.repository&&target.repositoryId===p.repositoryId&&target.authority===p.authority
      &&same(target.source,{runId:source.runId,attempt:source.attempt})&&/^[a-f0-9]{40}$/.test(source.head)
      &&typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code),'case');
    // A green Run requires an actual persisted, structured BLOCKED observation.
    need(blocked?.outcome==='blocked'&&blocked.execution===target.execution&&blocked.role===target.role
      &&same(blocked.target,target)&&!stopCodes.has(code),'blocked-marker');
    const id=rescueCaseIdentity({target,source,code});
    await records.update(s=>{
      if(s.cases[id]){need(same(s.cases[id].target,target)&&same(s.cases[id].source,source),'duplicate');return null;}
      s.cases[id]={id,target,source,code,originalCode:code,blocked:structuredClone(blocked),eligible:true,triggered:false,
        outcome:'PENDING',createdAt:now(),nextCheckAt:now(),checks:0,actions:[]};return s;
    });return id;
  }
  async function defer(id,code) {
    return modify(id,c=>{const checks=c.checks+1;return {...c,checks,code,
      outcome:checks>=72?'UNRESOLVED':'DEFERRED',nextCheckAt:checks>=72?null:now()+300000};});
  }
  async function dispatch(c,kind,proof) {
    // Retain metadata before transport; operation owns intent/attempt/readback.
    const v=controlledIntent(await intent({case:structuredClone(c),kind,proof}));
    need(v.kind==='dispatch'&&v.binding.repository===p.repository&&v.binding.repositoryId===p.repositoryId
      &&v.binding.issueId===c.target.issueId&&v.binding.scopeHash===c.target.scopeHash
      &&v.binding.shapeHash===c.target.shapeHash&&v.binding.cycle===c.target.cycle,'dispatch-binding');
    if(kind==='notification')need(same(v.payload.inputs,{request_id:c.id,source_run_id:c.source.runId,source_attempt:c.source.attempt,
      mode:c.continuation?'verify':'repair',nibfin_correlation:v.correlation,nibfin_issue:c.target.number,nibfin_stage:c.target.role}),'notification-inputs');
    else need(v.payload.inputs.nibfin_request===proof.next?.request&&typeof proof.next?.request==='string'
      &&v.payload.inputs.nibfin_correlation===v.correlation,'continuation-inputs');
    const owner=await operations({case:structuredClone(c),intent:structuredClone(v),
      beforeSubmit:async actual=>{need(same(actual,v)&&same(await intent({case:structuredClone(c),kind,proof}),v),'dispatch-binding');await checkpoint(c,{verification:kind==='notification'&&Boolean(c.continuation)});}});
    need(typeof owner?.execute==='function','operations');
    const r=await owner.execute(v);
    return {identity:contentIdentity(v),outcome:r.outcome,observation:r.observation??null};
  }
  async function verify(id) {
    let c=(await records.read()).cases[id];need(c,'missing-case');
    const {state}=await checkpoint(c,{allowActive:true,verification:true});
    // Completion capability returns actual Nibfin receipt plus fresh independent
    // expectations; a status boolean/green Run/dispatch cannot resolve a case.
    const final=await completion(c.target);
    if(final!==null) {
      const receipt=verifyCompletion(final.receipt,final.expected),b=receipt.payload.receipts.publication.binding;
      need(b.repositoryId===c.target.repositoryId&&b.issueId===c.target.issueId
        &&b.scopeHash===c.target.scopeHash&&b.shapeHash===state.target.shapeHash&&b.authority===c.target.authority
        &&final.cycle===c.target.cycle,'completion');
      c=await modify(id,c=>({...c,outcome:'RESOLVED',nextCheckAt:null,completion:receipt.identity,
        resolution:c.repairAttempt&&final.caseId===id&&final.continuation===c.continuation?.observation?.id?'automatic':'external'}));
      return result(c);
    }
    if(c.continuation?.observation?.id) {
      const source=await provenance.verify(String(c.continuation.observation.id),c.continuation.observation.attempt??'1',{completed:false});
      if(source.status!=='completed')return result(await defer(id,'CONTINUATION_ACTIVE'));
      if(source.conclusion==='success'&&state.stageReceipt?.caseId===id) {
        const stage=compareEvidence(state.stageReceipt.receipt,state.stageReceipt.expected);
        need(stage.execution.source?.runId===String(source.id)&&stage.execution.source?.attempt===String(source.run_attempt)
          &&stage.binding.repositoryId===c.target.repositoryId&&stage.binding.issueId===c.target.issueId
          &&stage.binding.scopeHash===c.target.scopeHash&&(stage.binding.shapeHash===state.target.shapeHash||stage.binding.shapeHash===c.target.shapeHash)
          &&stage.binding.authority===c.target.authority,'stage-receipt');
        return result(await modify(id,c=>({...c,outcome:'STAGE_RECOVERED',nextCheckAt:now()+300000})));
      }
      return result(await modify(id,c=>({...c,outcome:'UNRESOLVED',code:'REPAIR_FAILED',nextCheckAt:null})));
    }
    return result(c);
  }
  async function run(id,{diagnoseOnly=false,signal}={}) {
    let c=(await records.read()).cases[id];need(c,'missing-case');
    if(!pending.has(c.outcome))return result(c);
    if(c.continuation)return verify(id);
    try {
      if(await completion(c.target)!==null)return verify(id);
      const {source}=await checkpoint(c);
      // A confirmed notification invokes Rescue immediately. Local due times
      // bound notifier wakeups; the shared budget below enforces cooldown for
      // every authenticated invocation, including early/manual requests.
      if(c.budgetReservation)return result(await modify(id,c=>({...c,outcome:'UNRESOLVED',code:'REPAIR_ALREADY_ATTEMPTED',nextCheckAt:null})));
      if(diagnoseOnly){c=await diagnose(c,signal);return result({...c,outcome:'DEFERRED',code:'DIAGNOSIS_ONLY'});}
      // Classify deterministic evidence before spending a repair. Pending CI and
      // read-only availability checks are not repair attempts.
      const remedy=await deterministic({case:structuredClone(c),source,signal});
      if(remedy?.kind==='ci-wait'){c=await diagnose(c,signal);return result(await defer(id,'CI_WAIT'));}
      await checkpoint(c);
      // Reserve the shared per-Issue-cycle budget before any diagnostic/remedy.
      const key=contentIdentity({repositoryId:c.target.repositoryId,issueId:c.target.issueId,cycle:c.target.cycle});
      let reserved=false,cooldown=false;
      await records.update(s=>{
        const b=s.budgets[key]??{attempts:0,lastAt:null};
        if(b.attempts>=p.maxRepairs)return null;
        if(b.lastAt!==null&&now()-b.lastAt<p.cooldownMs){cooldown=true;return null;}
        need(!s.cases[id].budgetReservation,'concurrent-repair');
        s.budgets[key]={attempts:b.attempts+1,lastAt:now(),cases:{...b.cases,[id]:now()}};
        s.cases[id]={...s.cases[id],budgetReservation:{key,number:b.attempts+1,at:now()},triggered:true,nextCheckAt:null};reserved=true;return s;
      });
      if(!reserved)return result(cooldown?await defer(id,'COOLDOWN'):await modify(id,c=>({...c,outcome:'UNRESOLVED',code:'BUDGET_EXHAUSTED',nextCheckAt:null})));
      c=(await records.read()).cases[id];
      await checkpoint(c);
      // Every eligible block receives a retained AI diagnosis, including known
      // deterministic remedies. AI never applies the remedy or clears a gate.
      c=await diagnose(c,signal);
      // Deterministic classifier returns a proof and bounded fixed remedy. It may
      // not dispatch/execute a role. No commands or credentials occur in plans.
      let proof,plan=null;
      if(remedy) {
        need(['dead-lock','github-read','verification-budget','verification-io','ci-change','provider-timeout'].includes(remedy.kind)
          &&typeof remedy.apply==='function'&&remedy.proof,'remedy');
        await checkpoint(c);
        c=await modify(id,c=>({...c,repairAttempt:{at:now(),kind:remedy.kind}}));
        proof=await remedy.apply({signal});need(proof&&same(proof,remedy.proof),'remedy-result');
        c=await modify(id,c=>({...c,actions:[...c.actions,remedy.kind],proof}));
      } else {
        need(c.blocked.contractConflicts?.length===0&&['external_failure','implementation_defect'].includes(c.blocked.failureClass),'ai-ineligible');
        const diagnostic=c.diagnosis;
        proof={kind:'ai-repair',diagnosis:contentIdentity(diagnostic.record)};plan=diagnostic.plan;
      }
      await checkpoint(c);
      const continuation=await continueRole({target:c.target,caseId:id,proof,plan});
      await checkpoint(c);
      c=await modify(id,c=>({...c,outcome:'PENDING_VERIFICATION',proof,repairInput:contentIdentity(continuation),dispatchAttempted:true,repairAttempt:c.repairAttempt??{at:now(),kind:proof.kind}}));
      const sent=await dispatch(c,'continuation',continuation);
      c=await modify(id,c=>({...c,continuation:sent,outcome:sent.outcome==='confirmed-success'?'PENDING_VERIFICATION':'UNRESOLVED',
        code:sent.outcome==='confirmed-success'?c.code:'UNKNOWN_DISPATCH',nextCheckAt:sent.outcome==='confirmed-success'?now()+300000:null}));
      return result(c);
    } catch(e) {
      c=(await records.read()).cases[id];
      if(e.code==='concurrent-repair')return result(c);
      if(e.code==='agent-active'&&!c.diagnosis?.attempted&&!c.repairAttempt) {
        if(c.budgetReservation)await records.update(s=>{
          const key=c.budgetReservation.key,b=s.budgets[key];
          need(b?.cases?.[id]!==undefined,'reservation');
          delete b.cases[id];b.attempts--;const times=Object.values(b.cases);b.lastAt=times.length?Math.max(...times):null;
          if(!b.attempts)delete s.budgets[key];delete s.cases[id].budgetReservation;return s;
        });
        return result(await defer(id,'AGENT_ACTIVE'));
      }
      return result(await modify(id,c=>({...c,outcome:e.code==='state-changed'&&!c.budgetReservation?'SUPERSEDED':'UNRESOLVED',
        code:e.code??'RECOVERY_UNAVAILABLE',nextCheckAt:null})));
    }
  }
  async function wake(id) {
    let c=(await records.read()).cases[id];need(c,'missing-case');
    if(!eligibleRescueRecheck(c)||c.nextCheckAt>now())return {outcome:'NOT_DUE'};
    try {
      // Repair progress may advance Candidate/execution. Keep the original case,
      // authority and requirements, but observe the retained continuation too:
      // a lost completion webhook must not look like an unchanged source Run.
      const {state,source}=await checkpoint(c,{verification:Boolean(c.continuation)});
      const continuation=c.continuation?.observation?.id
        ?await provenance.verify(String(c.continuation.observation.id),c.continuation.observation.attempt??'1',{completed:false}):null;
      if(continuation&&continuation.status!=='completed')return {outcome:(await defer(id,'CONTINUATION_ACTIVE')).outcome};
      const fingerprint=contentIdentity({state,source:source.identity,continuation:continuation?.identity??null});
      const old=(await records.read()).notifications[id];
      if(old?.fingerprint===fingerprint) {
        await defer(id,'UNCHANGED');return {outcome:'UNCHANGED'};
      }
      await records.update(s=>{s.notifications[id]={fingerprint,attempted:true};return s;});
      const sent=await dispatch(c,'notification',{fingerprint});
      await records.update(s=>{s.notifications[id]={fingerprint,...sent};s.cases[id].triggered=true;return s;});
      if(sent.outcome!=='confirmed-success')await modify(id,c=>({...c,outcome:'UNRESOLVED',code:'UNKNOWN_DISPATCH',nextCheckAt:null}));
      else await defer(id,'NOTIFICATION_SENT');
      return sent;
    } catch(e) {
      if(e.code==='agent-active')return {outcome:(await defer(id,'AGENT_ACTIVE')).outcome};
      return {outcome:(await modify(id,c=>({...c,outcome:'UNRESOLVED',code:e.code??'WAKE_UNAVAILABLE',nextCheckAt:null}))).outcome};
    }
  }
  return Object.freeze({register,run,verify,wake,checkpoint,report:async()=>rescueReport(await records.read())});
}

/** Build real installed-workflow inputs from protected current configuration.
 * load rereads the workflow id/ref/content and existing operation binding. No
 * event, model plan or display hint can choose a workflow or role.
 */
export function createRescueDispatch({policy,load,provenance}) {
  const p=validateRescuePolicy(policy);need(typeof load==='function'&&typeof provenance?.workflow==='function','dispatch-configuration');
  return async ({case:c,kind,proof})=>{
    need(['notification','continuation'].includes(kind),'dispatch-kind');
    const descriptor=await load({target:structuredClone(c.target),kind});
    need(descriptor.workflow?.path===(kind==='notification'?'.github/workflows/nibfin-rescue.yml':p.stageWorkflow),'dispatch-workflow');
    const b=descriptor.binding;
    need(b.repository===p.repository&&b.repositoryId===p.repositoryId&&b.issueId===c.target.issueId
      &&b.number===c.target.number&&b.scopeHash===c.target.scopeHash&&b.shapeHash===c.target.shapeHash
      &&b.cycle===c.target.cycle,'dispatch-binding');
    const workflow=await provenance.workflow(kind);
    need(workflow.path===descriptor.workflow.path&&workflow.id===descriptor.workflow.id,'dispatch-workflow');
    const correlation='rescue-'+contentIdentity({caseId:c.id,kind,proof,workflow});
    const inputs=kind==='notification'?{request_id:c.id,source_run_id:c.source.runId,source_attempt:c.source.attempt,
      mode:c.continuation?'verify':'repair',nibfin_correlation:correlation,nibfin_issue:c.target.number,nibfin_stage:c.target.role}
      :{nibfin_request:proof.next?.request,nibfin_correlation:correlation,nibfin_issue:c.target.number,nibfin_stage:c.target.role};
    return controlledIntent({version:1,kind:'dispatch',correlation,source:{...descriptor.source,request:correlation},binding:b,
      target:{id:workflow.id,number:null,workflow:workflow.id},payload:{ref:workflow.ref,refIdentity:workflow.refIdentity,inputs,
        display:{repository:p.repository,issue:b.number,stage:c.target.role}}});
  };
}
