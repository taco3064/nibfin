import { digest } from './core.mjs';
import { Store } from './store.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { repoPath } from './github.mjs';
import {requestIssueReference,actionRunTitle} from './action-display.mjs';

export const repositoryWrites = new Set(['publish-shape', 'commit-pr', 'merge', 'close', 'mark-delivered', 'invalidate-shape', 'repair', 'record-recovery-comment', 'reopen-recovery', 'post-merge-repair']);
const queuedWrite = r => r.schemaVersion === 1 && repositoryWrites.has(r.operation);

// Keep immutable provenance hashes and legacy IDs; deduplicate work separately.
export function stageWorkKey(request) {
  if (request.schemaVersion !== 1 || !request.operation || !request.basis || !request.authority) return null;
  return digest({ authority: request.authority, repository: request.repository,
    issueId: request.issueId, operation: request.operation, basis: request.basis,
    artifacts: request.artifacts,...(request.requirementRevisionHash?{requirementRevisionHash:request.requirementRevisionHash}:{}) });
}

// Dispatch APIs do not provide idempotency keys. Persist the exact intent BEFORE
// attempting a dispatch; after an uncertain result only reconcile provider state.
// Never retry an ambiguous write merely because a new event arrived.
export class ActionOutbox {
  constructor(root, github, execution, issues=[]) {
    this.store = new Store(root, `actions-outbox:${execution.repositoryId}`);
    this.github = github; this.execution = execution;
    this.issues=issues;
  }
  // Contention here covers only small local metadata transactions. Never hold
  // this lease while waiting for a worker or another repository mutation.
  async metadata(work) {
    for (let attempt = 0; ; attempt++) {
      let entered = false;
      try { return await this.store.lease(() => { entered = true; return work(); }); }
      catch (e) { if (entered || e.code !== 'EEXIST' || attempt >= 100) throw e; await delay(25 + Math.floor(Math.random() * 25)); }
    }
  }
  handoff(id, item) {
    return { requestId: id, repository: this.execution.repository, repositoryId: this.execution.repositoryId,
      workflow: this.execution.workflowPath.split('/').at(-1), ref: this.execution.ref,
      ...(this.execution.kind === 'participant' ? { issueId: item.request.issueId } : {}),
      ...(this.execution.kind!=='participant'&&requestIssueReference(item.request,this.issues)?{issueRef:requestIssueReference(item.request,this.issues)}:{}) };
  }
  async finish(id, outcome) {
    return this.metadata(async () => {
      const state = await this.store.read(), item = state.items?.[id];
      if (!item || digest(item.request) !== id) throw new Error('Unknown or altered queue item');
      if (item.finishedAt) return;
      await this.store.transaction(state.revision, s => { s.items[id].finishedAt = new Date().toISOString(); s.items[id].outcome = outcome; return s; });
      console.error(JSON.stringify({kind:'repository-queue-released',repository:item.request.repository,requestId:id,outcome}));
    });
  }
  async drainWrites() {
    const state = await this.store.read(), handoffs = [];
    for (const [id, item] of Object.entries(state.items || {})) {
      if (item.status !== 'pending' || !queuedWrite(item.request)) continue;
      const h = await this.prepareHandoff(id); if (h) handoffs.push(h);
    }
    return handoffs;
  }
  async enqueue(request) {
    const id = digest(request);
    return this.metadata(async () => {
      const state = await this.store.read();
      if (state.items?.[id]) return id;
      const key = stageWorkKey(request);
      if (key) for (const [existingId, item] of Object.entries(state.items || {})) {
        if (stageWorkKey(item.request) !== key) continue;
        if (digest(item.request) !== existingId) throw new Error('Dispatch intent is altered');
        // Preserve the original predecessor and boundary proof. Additional
        // verified event sources remain in the inbox, without another dispatch.
        if (item.status === 'dependency-wait') continue; // New verified source gets a distinct retry intent.
        return existingId;
      }
      await this.store.transaction(state.revision, s => ({ ...s, items: { ...s.items, [id]: { request, status: 'pending' } } }));
      return id;
    });
  }
  async deferDependency(id, dependency) {
    return this.metadata(async () => {
      const s = await this.store.read(), item = s.items?.[id];
      if (!item || digest(item.request) !== id) throw new Error('Unknown or altered dispatch intent');
      await this.store.transaction(s.revision, current => {
        current.items[id] = { ...current.items[id], status: 'dependency-wait', dependency, deferredAt: new Date().toISOString() };
        return current;
      });
    });
  }
  async dispatch(id) {
    return this.metadata(async () => {
      let state = await this.store.read(), item = state.items?.[id];
      if (!item) throw new Error('Unknown durable dispatch intent');
      if (queuedWrite(item.request) && item.status === 'pending') throw new Error('Repository writes require the queued workflow handoff');
      const root = repoPath(this.execution.repository), workflow = encodeURIComponent(this.execution.workflowPath.split('/').at(-1));
      const reconcile = async () => {
        const runs = await this.github.list(`${root}/actions/workflows/${workflow}/runs?event=workflow_dispatch`, 'workflow_runs');
        const titles=[`upstream ${id}`,actionRunTitle(requestIssueReference(item.request,this.issues),id),actionRunTitle(null,id)];
        const matches = runs.filter(r => titles.includes(r.display_title) && r.path === this.execution.workflowPath &&
          String(r.repository?.id) === String(this.execution.repositoryId) && this.execution.actorIds.map(String).includes(String(r.actor?.id)));
        if (matches.length > 1) throw Object.assign(new Error('Multiple Actions Runs match a dispatch intent'), { code: 'AMBIGUOUS_DISPATCH' });
        if (!matches.length) return { status: 'WAITING', code: 'DISPATCH_READBACK_PENDING', requestId: id };
        await this.store.transaction(state.revision, s => { s.items[id] = { ...s.items[id], status: 'confirmed', runId: String(matches[0].id) }; return s; });
        return { status: 'DISPATCHED', requestId: id, runId: String(matches[0].id) };
      };
      if (item.status !== 'pending') return reconcile();
      state = await this.store.transaction(state.revision, s => { s.items[id].status = 'attempted'; s.items[id].attemptedAt = new Date().toISOString(); return s; });
      // Inputs select a durable intent only. No role, shell, skill, host or token
      // comes from them. The target re-reads the intent and fresh Core decision.
      const reference=this.execution.kind!=='participant'&&requestIssueReference(item.request,this.issues);
      await this.github.api(`${root}/actions/workflows/${workflow}/dispatches`, 'POST', { ref: this.execution.ref, inputs: { request_id: id,...(reference?{issue_ref:reference}:{}) } });
      return reconcile();
    });
  }
  async read(id) {
    if (!/^[a-f0-9]{64}$/.test(id || '')) throw new Error('Invalid dispatch request identity');
    const item = (await this.store.read()).items?.[id];
    if (!item || digest(item.request) !== id || item.status === 'pending') throw new Error('Dispatch intent is missing, altered or not attempted');
    return structuredClone(item);
  }
  async prepareHandoff(id) {
    return this.metadata(async () => {
      const state = await this.store.read(), item = state.items?.[id];
      if (!item || item.status !== 'pending') return null;
      if (queuedWrite(item.request)) {
        const first = Object.entries(state.items).find(([, v]) => queuedWrite(v.request) &&
          v.request.repository === item.request.repository && !v.finishedAt);
        if (first?.[0] !== id) {
          console.error(JSON.stringify({kind:'repository-queue-wait',repository:item.request.repository,requestId:id,waitingFor:first?.[0]}));
          return null;
        }
      }
      await this.store.transaction(state.revision, s => { s.items[id].status = 'attempted'; s.items[id].attemptedAt = new Date().toISOString(); return s; });
      console.error(JSON.stringify({kind:'repository-queue-dispatched',repository:item.request.repository,requestId:id,operation:item.request.operation}));
      return this.handoff(id, item);
    });
  }
}
