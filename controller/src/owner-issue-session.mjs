import { binding, digest } from './core.mjs';
import { childRuntime, issueLeaseId, unitId } from './dynamic.mjs';
import { Store } from './store.mjs';
import { ownerHold } from './owner-hold.mjs';
import { resolveBoundaryWakeup, withActionCapacity, reconcileActionIssue } from './action-stage.mjs';
import { ownerRunBudget } from './owner-run-budget.mjs';
import { assertRevisionExecution, revisionHash } from './requirement-revision.mjs';
import { wakeupKey as sourceKey, nativeAction, nextInboxSource, readInbox, verifyInboxSource } from './native-wakeup.mjs';
import { reconcileIssueScope } from './issue-scope.mjs';


// One authenticated Issue wakeup owns the work until a real external wait.
// Agent executions stay isolated; sharing an Actions job is not self-acceptance.
export async function runOwnerIssueSession(runtime, grant, issue, source) {
  if (grant.policy.controlMode !== 'owner-project' || grant.policy.executionMode !== 'actions-v1' || !runtime.actionIdentity)
    throw Error('Owner Issue session requires verified owner-project Actions authority');
  await assertRevisionExecution(runtime,grant,issue);
  const hold = ownerHold(runtime, issue);
  if (hold) return {status:'WAITING',code:'OWNER_REAUTHORIZATION_REQUIRED',issueId:issue.id,holdHash:hold.holdHash,reason:hold.reason};
  const root = runtime.config.stateDirectory;
  // Shared by all Issues/wakeups in this invocation; an inbox hint cannot reset
  // the clock after another Issue or Agent consumed this job's time.
  runtime.ownerRunBudget ??= await ownerRunBudget(runtime,grant);
  let store = new Store(root, unitId(grant, issue));
  for (let wake = 0; wake < 32; wake++) {
    const admitted = source;
    const result = await withActionCapacity(root, grant, () => new Store(root, issueLeaseId(issue)).lease(async () => {
      if(admitted?.kind==='public-issue-event' && !await verifyInboxSource(runtime,grant,issue,admitted,await readInbox(runtime,grant)))
        return {status:'WAITING',code:'NATIVE_SOURCE_REJECTED',issueId:issue.id};
      await reconcileIssueScope(runtime,grant,issue,unitId);
      store = new Store(root, unitId(grant, issue));
      let state = await store.read();
      const key = sourceKey(admitted);
      if (state.ownerWakeups?.[key]) return {status:'DUPLICATE',issueId:issue.id};
      if(!nativeAction(state) && admitted?.kind==='public-issue-event' && !await verifyInboxSource(runtime,grant,issue,admitted,await readInbox(runtime,grant)))
        return {status:'WAITING',code:'NATIVE_SOURCE_REJECTED',issueId:issue.id};
      if (state.completion?.receiptHash) {
        const receipt = state.actionReceipts?.findLast(r=>['close','mark-delivered'].includes(r.operation));
        if (!receipt || state.completion.receiptHash !== digest(receipt)) throw Object.assign(new Error('Stored completion receipt differs'),{code:'COMPLETION_UNVERIFIED'});
      }
      const finalClose=state.actionReceipts?.at(-1)?.operation === 'close' && grant.policy.repositories[issue.repository].deployment?.mode === 'not-applicable';
      const boundary = finalClose?null:await resolveBoundaryWakeup(runtime, grant, issue, state, admitted);
      if (boundary?.path === 'waiting') return {status:'WAITING',code:'NATIVE_ISSUE_EVENT_REQUIRED',issueId:issue.id,action:boundary.action};
      state = await store.transaction(state.revision, s => ({...s,ownerWakeups:{...s.ownerWakeups,[key]:{source:admitted,at:new Date().toISOString()}}}));
      const child = childRuntime(runtime, grant, issue);
      child.actionInvocation = true; child.ownerIssueSession = true;
      child.ownerRunBudget = runtime.ownerRunBudget;
      const save = child.save.bind(child);
      child.save = async (target, current) => {
        const transition = current.events.at(-1);
        if (!current.pending && transition?.operation && transition.completedAt) {
          const requestId = digest({issueId:issue.id,decisionId:transition.decisionId,completedAt:transition.completedAt});
          if (!current.actionRequests?.[requestId]) {
            const receipt = {schemaVersion:1,requestId,issueId:issue.id,operation:transition.operation,authority:binding(grant.manifest,grant.policy),...(revisionHash(grant,issue)?{requirementRevisionHash:revisionHash(grant,issue)}:{}),action:runtime.actionIdentity,wakeup:boundary || null,transition,completedAt:transition.completedAt};
            current.actionReceipts = [...(current.actionReceipts || []),receipt];
            current.actionRequests = {...current.actionRequests,[requestId]:receipt};
            console.error(JSON.stringify({kind:'issue-stage-complete',issueId:issue.id,operation:transition.operation,runId:runtime.actionIdentity.runId,at:transition.completedAt}));
          }
        }
        if (current.completion?.status === 'COMPLETE' && transition?.kind === 'gate-decision' && transition.status === 'COMPLETE') {
          const receipt = current.actionReceipts?.at(-1);
          if (!receipt || !['close','mark-delivered'].includes(receipt.operation)) throw Error('Completion lacks a durable finalization receipt');
          current.completion = {...current.completion,action:receipt.action,receiptHash:digest(receipt)};
        }
        return save(target,current);
      };
      try {
        const next = await child.resume({maxSteps:32,onProgress:p=>console.error(JSON.stringify({kind:'issue-stage-start',...p,runId:runtime.actionIdentity.runId,at:new Date().toISOString()}))});
        const final = await store.read();
        return {...next,issueId:issue.id,...(next.status==='COMPLETE'?{completion:final.completion}:{})};
      } catch (error) {
        if(error.code==='ISSUE_SCOPE_CHANGED')return {status:'WAITING',code:error.code,issueId:issue.id};
        if (!['DEPENDENCY_WAIT','MERGE_REQUIREMENTS_PENDING','UPSTREAM_HANDOFF_UNAVAILABLE','UPSTREAM_HANDOFF_CHANGED'].includes(error.code)) throw error;
        return {status:'WAITING',code:error.code,issueId:issue.id,...(error.dependency?{dependency:error.dependency}:{})};
      }
    }));
    if(result.code==='OWNER_RUN_BUDGET_EXHAUSTED'){
      // Release capacity and Issue leases before persisting the normal outbox
      // handoff. The pinned workflow dispatches it only after this job succeeds.
      const state=await store.read(),receipt=state.actionReceipts?.at(-1);
      const next=await reconcileActionIssue(runtime,grant,issue,receipt?{kind:'stage-result',receiptHash:digest(receipt)}:source);
      return {...next,...(next.requestId?{code:'OWNER_RUN_BUDGET_EXHAUSTED',yielded:true}:{})};
    }
    if (['COMPLETE','DUPLICATE'].includes(result.status) || result.code === 'ACTIONS_CAPACITY_BUSY') return result;
    if(result.code==='ISSUE_SCOPE_CHANGED')continue;
    // Release the Issue lease BEFORE checking hints. An event that arrived
    // during a write was persisted before its lock attempt; a later arrival
    // can now acquire the lease itself. Neither ordering loses the wakeup.
    const [state,inbox] = await Promise.all([store.read(),new Store(root,`actions-inbox:${grant.policy.grantId}`).read()]);
    const hint = await nextInboxSource(runtime,grant,issue,state,inbox);
    if (!hint) return result;
    source = hint;
  }
  return {status:'WAITING',code:'ISSUE_SESSION_WAKE_LIMIT',issueId:issue.id};
}
