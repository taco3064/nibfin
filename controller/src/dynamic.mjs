import { repositoryWrites } from './action-outbox.mjs';
import { binding, canonical, digest, plan, validateManifest } from './core.mjs';
import { Store } from './store.mjs';
import { ownerHold } from './owner-hold.mjs';
import { repoPath } from './github.mjs';
import { mapReads } from './parallel.mjs';
import { revisionProjection, assertRevisionExecution, revisionDependency } from './requirement-revision.mjs';
import { assigneeRetirement, isAssigneeRetirement } from './assignee-revision.mjs';
import { assertIssueScope, liveIssueScopes, issueScopeProjection, matchesIssueBody, issueScopeStore } from './issue-scope.mjs';
import { prepareUpstreamHandoff, waitForUpstreamHandoff } from './upstream-handoff.mjs';

const stop = (code, reason) => Object.assign(new Error(reason), { code });
export const unitId = (grant, issue) => {
  const revised=revisionProjection(grant,issue);
  return `dynamic:${digest({ grant: grant.policy.grantId, revision: revised?.cycleRevision || grant.policy.revision,
    repositoryId: issue.repositoryId, issueId: issue.id, scopeHash: revised?.issue.scopeHash || issue.scopeHash })}`;
};
export const issueLeaseId = issue => `issue:${issue.repositoryId}:${issue.id}`;

export function summarizeDynamicCompletion(grant, units) {
  const complete = units.length === grant.manifest.issues.length && units.every(u => u.status === 'COMPLETE' || isAssigneeRetirement(u));
  const result = { complete };
  if (units.some(isAssigneeRetirement)) result.retiredUnits = units.filter(isAssigneeRetirement).map(u => ({ issueId: u.issueId, retirementHash: u.retirementHash, disposition: u.disposition }));
  if (complete) result.completionHash = digest({ authority: binding(grant.manifest, grant.policy), units: units.map(u => isAssigneeRetirement(u) ?
    { issueId: u.issueId, unitId: u.unitId, retirementHash: u.retirementHash, disposition: u.disposition } :
    { issueId: u.issueId, unitId: u.unitId, completionHash: u.completionHash }).sort((a,b) => a.issueId.localeCompare(b.issueId)) });
  return result;
}

export function validateDynamic(grant) {
  const { manifest: m, policy: p } = grant;
  if (m.schemaVersion !== 2 || m.scheduling !== 'native-dependencies' || m.membership !== 'fixed-approved-set') throw stop('INVALID_DYNAMIC_GRANT', 'Explicit dynamic schema required');
  if (typeof p.stateDirectory !== 'string' || !p.stateDirectory.trim()) throw stop('INVALID_DYNAMIC_GRANT', 'Dynamic grants must pin the shared state and coordination directory');
  if (!Number.isSafeInteger(p.maxParallel) || p.maxParallel < 1 || p.maxParallel > 32) throw stop('INVALID_DYNAMIC_GRANT', 'Owner must approve maxParallel from 1 to 32');
  if (!m.issues.every(i => p.repositories[i.repository]?.repositoryId === i.repositoryId)) throw stop('INVALID_DYNAMIC_GRANT', 'Repository grant must pin every stable repository identity');
}

// A deterministic execution view of an authenticated parent, never a new signed
// grant. The full parent hashes remain in every child evidence binding.
export function projectUnit(grant, issue) {
  validateDynamic(grant);
  if (!grant.approval?.verified || !grant.manifest.issues.some(i => canonical(i) === canonical(issue))) throw stop('NO_GRANT', 'Unit is outside authenticated parent authority');
  const parent = { recordId: grant.recordId, ...binding(grant.manifest, grant.policy) };
  const revised=revisionProjection(grant,issue);
  const lineage=revised?{...parent,requirementRevisionRecordId:revised.recordId,requirementRevisionHash:revised.revisionHash}:parent;
  const manifest = { schemaVersion: 1, id: unitId(grant, issue), freezeRevision: revised?.freezeRevision || grant.manifest.freezeRevision,
    proposalRevision: revised?.proposalRevision || grant.manifest.proposalRevision, proposalHash: revised?.proposalHash || grant.manifest.proposalHash,
    dynamicParent: lineage, issues: [{ ...(revised?.issue || issue), dependencies: [] }] };
  const policy = { ...grant.policy,...(revised?{revision:revised.cycleRevision}:{}), manifestHash: digest(manifest), dynamicParent: lineage };
  if(revised?.liveIssueScope)policy.issueScopeSource='github-issue';
  if(revised?.issueDeployment){const repository=issue.repository;policy.repositories={...policy.repositories,[repository]:{...policy.repositories[repository],issueDeployment:revised.issueDeployment}};}
  return { ...grant,...(revised?{recordId:revised.recordId,proposal:revised.proposal}:{}), manifest, policy, approval: {
    ...grant.approval,...(revised?{recordId:revised.recordId,requirementRevisionHash:revised.revisionHash}:{}), manifestHash: digest(manifest), policyHash: digest(policy) } };
}

async function unchanged(runtime, approved) {
  const live = await runtime.grant();
  if (digest(live.manifest) !== digest(approved.manifest) || digest(live.policy) !== digest(approved.policy) || live.recordId !== approved.recordId) throw stop('AUTHORITY_CHANGED', 'Dynamic authority changed; new authorization and explicit migration required');
  return live;
}

async function graph(runtime, grant, targetId) {
  await unchanged(runtime, grant);
  const nodes = new Map();
  const authorized = new Map(grant.manifest.issues.map(i=>[i.id,i]));
  let queue = targetId ? [authorized.get(targetId)] : [...grant.manifest.issues];
  const visited = new Set();
  while (queue.length) {
    const current = queue.filter(i=>i && !visited.has(i.id)); queue=[];
    for (const i of current) visited.add(i.id);
    await mapReads(current, async issue => {
    try {
      const repo = await runtime.github.repository(issue.repository);
      if (String(repo.id) !== issue.repositoryId) throw stop('REPOSITORY_CHANGED', 'Repository identity changed');
      const remote = await runtime.github.issue(issue);
      if (remote.node_id !== issue.id) throw stop('ISSUE_CHANGED', 'Issue identity changed');
      if (!remote.labels.some(l => l.name === 'scope')) throw stop('SCOPE_REMOVED', 'Scope label removed; no new work permitted');
      const milestone = grant.policy.repositories[issue.repository].milestoneNumber;
      if (milestone !== undefined && remote.milestone?.number !== milestone) throw stop('SCOPE_REMOVED', 'Issue left the approved milestone');
      const deps = (await runtime.github.dependencies(issue)).map(i => i.node_id);
      if (deps.some(id => typeof id !== 'string') || new Set(deps).size !== deps.length) throw stop('INVALID_DEPENDENCIES', 'Invalid live dependency identities');
      nodes.set(issue.id, { issue, dependencies: deps, labels: remote.labels.map(l=>l.name) });
      if (targetId) for (const id of deps) if (authorized.has(id) && !visited.has(id)) queue.push(authorized.get(id));
    } catch (error) { nodes.set(issue.id, { issue, error }); }
    });
    queue = [...new Map(queue.map(i=>[i.id,i])).values()];
  }
  return nodes;
}

export function prerequisiteIds(nodes, id) {
  const visiting = new Set(), visited = new Set(), result = [];
  function walk(key) {
    if (visiting.has(key)) throw stop('DEPENDENCY_CYCLE', 'Native dependency cycle');
    if (visited.has(key)) return;
    const node = nodes.get(key);
    if (!node) throw stop('PREREQUISITE_NOT_AUTHORIZED', `Missing or external prerequisite: ${key}`);
    if (node.error) throw node.error;
    visiting.add(key);
    for (const dep of node.dependencies) walk(dep);
    visiting.delete(key); visited.add(key);
    if (key !== id) result.push(key);
  }
  walk(id);
  return result;
}

export function childRuntime(runtime, grant, issue, enforceDependencies = true) {
  const child = new runtime.constructor(runtime.config, runtime.root, runtime.github, runtime.agent, runtime.workspaceFactory, runtime.environment);
  child.dynamicUnit = true;
  child.grant = async () => {
    const fresh = await unchanged(runtime, grant);
    await assertRevisionExecution(runtime,fresh,issue);
    const hold = ownerHold(runtime, issue);
    if (hold) throw stop('OWNER_REAUTHORIZATION_REQUIRED', hold.reason);
    const currentState = fresh.policy.controlMode === 'owner-project' ? await new Store(runtime.config.stateDirectory,unitId(fresh,issue)).read() : null;
    const afterMerge = Boolean(currentState?.issues?.[issue.id]?.merge?.verified);
    if (afterMerge) child.dynamicObservation = null;
    if (enforceDependencies && !afterMerge && !child.ownerIssueSession) child.dynamicObservation = await ready(runtime, fresh, issue);
    child.publicDispatch = runtime.publicDispatch;
    child.publicBindings = runtime.publicBindings;
    child.executionContext = structuredClone(runtime.executionContext);
    child.installedCoreDigest = runtime.installedCoreDigest;
    child.coreUpgrade = runtime.coreUpgrade;
    child.deliveryInputs = runtime.deliveryInputs;
    child.priorImplementation = issueScopeProjection(fresh,issue)?.priorImplementation || null;
    child.agentHealthOwner = runtime.agentHealthOwner || runtime;
  child.actionIdentity = runtime.actionIdentity;
    return projectUnit(fresh, issue);
  };
  const observe = child.observe.bind(child);
  child.observe = async (...args) => {
    const work = async () => {
      if (child.ownerIssueSession && enforceDependencies) {
        const current = args[1];
        child.dynamicObservation = current.issues?.[issue.id]?.merge?.verified ? null : await ready(runtime,grant,issue);
      }
      return {...await observe(...args),dynamicDependencies:child.dynamicObservation || null};
    };
    return child.ownerIssueSession && runtime.github.readObservation ? runtime.github.readObservation(work) : work();
  };
  // Same-repository publication/merge writes are short serialized sections.
  // Agents and verification run in independent issue workspaces concurrently.
  const execute = child.execute.bind(child);
  child.execute = async (g, state, snapshot, decision, store) => {
    await assertRevisionExecution(runtime,grant,issue);
    await assertIssueScope(runtime,grant,issue,state);
    if (!state.issues?.[issue.id]?.merge?.verified && (state.upstreamHandoff || ['shape','validate-shape','deliver','accept','shaper-review','diagnose-shape','diagnose-deployment'].includes(decision.operation))) {
      try {
        child.upstreamHandoff = await prepareUpstreamHandoff(child,grant,issue,g,state,store,decision.operation);
        if (state.upstreamHandoffWait) { delete state.upstreamHandoffWait; state.revision=(await child.save(store,state)).revision; }
      } catch (error) { await waitForUpstreamHandoff(child,state,store,decision,error); throw error; }
    }
    if (!repositoryWrites.has(decision.operation)) return execute(g, state, snapshot, decision, store);
    const started = Date.now();
    return new Store(runtime.config.stateDirectory, `repository-write:${issue.repositoryId}`).lease(async () => {
      if (child.ownerIssueSession) console.error(JSON.stringify({kind:'repository-write-acquired',issueId:issue.id,operation:decision.operation,waitMs:Date.now()-started}));
      const current = await child.observe(g, state);
      const next = plan(g.manifest, g.policy, current);
      const live = current.issues[issue.id];
      const reconciled = decision.operation === 'merge' && live.merge || decision.operation === 'publish-shape' && live.labels.includes('shaped') && live.bodyHash === (g.policy.issueScopeSource==='github-issue'?g.manifest.issues[0].scopeHash:state.issues[issue.id].shape?.bodyHash) || decision.operation === 'mark-delivered' && live.labels.includes('delivered') || decision.operation === 'close' && live.state === 'closed' || decision.operation === 'invalidate-shape' && live.bodyHash === live.scopeHash;
      if (state.pending?.writeAttempted && reconciled) return execute(g, state, current, decision, store);
      if (next.status !== 'READY' || next.operation !== decision.operation || canonical(next.artifacts) !== canonical(decision.artifacts)) {
        // This invocation has not attempted the write yet. Preserve the intent
        // as history and let the next pass run the newly required evidence cycle.
        if (state.pending?.writeAttempted) throw stop('AMBIGUOUS_WRITE', 'Attempted mutation requires readback reconciliation');
        state.events.push({ ...decision, outcome: 'not-attempted-gate-changed' });
        state.pending = null;
        return child.save(store, state);
      }
      state.pending.writeAttempted = true;
      state.pending.writeStartedAt ||= new Date().toISOString();
      // Keep the caller's state object current: Runtime records errors using
      // this same object if a write succeeds but its response/readback fails.
      // Replacing it with the persisted clone leaves that handler one revision
      // behind and masks the recoverable error with a state revision conflict.
      state.revision = (await child.save(store, state)).revision;
      return execute(g, state, current, decision, store);
    }, {waitMs:child.ownerIssueSession ? 120000 : 0});
  };
  return child;
}

async function inspect(runtime, grant, issue) {
  const child = childRuntime(runtime, grant, issue, false);
  const projected = await child.grant();
  const state = await new Store(runtime.config.stateDirectory, projected.manifest.id).read();
  if (state.pending || state.binding && canonical(state.binding) !== canonical(binding(projected.manifest, projected.policy))) return { status: 'BLOCKED', code: 'UNIT_PENDING_OR_STALE' };
  const snapshot = await child.observe(projected, state);
  return plan(projected.manifest, projected.policy, snapshot);
}

export async function ready(runtime, grant, issue) {
  return runtime.github.measure ? runtime.github.measure('dependencies', () => readyFresh(runtime, grant, issue)) : readyFresh(runtime, grant, issue);
}
async function readyFresh(runtime, grant, issue) {
  const nodes = await graph(runtime, grant, grant.policy.controlMode === 'owner-project' ? issue.id : undefined);
  const proofs = [];
  for (const id of prerequisiteIds(nodes, issue.id)) {
    if (grant.policy.controlMode === 'owner-project') {
      if (!nodes.get(id).labels.includes('delivered')) throw stop('DEPENDENCY_WAIT', `Prerequisite ${id} is not delivered`);
      if(liveIssueScopes(grant)) {
        const producer=nodes.get(id).issue, cursor=await issueScopeStore(runtime,grant,producer).read();
        const local=issueScopeProjection(grant,producer);
        if((cursor.current?.revisionHash || null)!==(local?.revisionHash || null))throw stop('DEPENDENCY_WAIT','Dependency requirements cycle changed; refresh observation');
        const state=await new Store(runtime.config.stateDirectory,unitId(grant,producer)).read();
        const remote=await runtime.github.issue(producer);
        if(!state.completion?.receiptHash || !matchesIssueBody(local?.issue || producer,state,remote,Boolean(local)))
          throw stop('DEPENDENCY_WAIT',`Prerequisite ${id} has no completion for its current Issue requirements`);
      }
      // A revised producer/consumer boundary needs explicit signed compatibility
      // and a fresh Core completion proof; old labels cannot bridge new cycles.
      const consumers=[...nodes.values()].filter(n=>n.dependencies?.includes(id));
      let cross=false;
      for(const consumer of consumers) if(await revisionDependency(runtime,grant,nodes.get(id).issue,consumer.issue)) cross=true;
      if(cross){
        const checked=await inspect(runtime,grant,nodes.get(id).issue);
        if(checked.status!=='COMPLETE') throw stop('CROSS_CYCLE_COMPLETION_UNVERIFIED','Revised dependency lacks current-cycle completion');
        proofs.push({issueId:id,completionHash:checked.completionHash}); continue;
      }
      proofs.push({issueId:id,completionHash:digest({issueId:id,status:'delivered'})});
      continue;
    }
    const result = await inspect(runtime, grant, nodes.get(id).issue);
    if (result.status !== 'COMPLETE') {
      const detail = { issueId: issue.id, prerequisiteId: id, status: result.status, code: result.code || null, operation: result.operation || null, reason: result.reason || null };
      console.error(JSON.stringify({ kind: 'dependency-proof-wait', ...detail }));
      throw Object.assign(stop('DEPENDENCY_WAIT', `Prerequisite ${id}: ${result.code || result.operation || result.status}${result.reason ? ': ' + result.reason : ''}`), { dependency: detail });
    }
    proofs.push({ issueId: id, completionHash: result.completionHash });
  }
  return { issueId: issue.id, dependencies: nodes.get(issue.id).dependencies, proofs, observedAt: new Date().toISOString() };
}

export async function discover(runtime, grant) {
  const found = [];
  for (const [repository, policy] of Object.entries(grant.policy.repositories)) {
    const rows = await runtime.github.list(`${repoPath(repository)}/issues?state=all&labels=scope${policy.milestoneNumber ? `&milestone=${policy.milestoneNumber}` : ''}`);
    for (const row of rows.filter(i => !i.pull_request)) found.push({ repository, id: row.node_id, number: row.number, authorized: grant.manifest.issues.some(i => i.repository === repository && i.id === row.node_id) });
  }
  return found;
}

export async function dynamicDoctor(runtime, grant) {
  validateDynamic(grant);
  const nodes = await graph(runtime, grant);
  return { status: 'OK', mode: 'native-dependencies', discovered: await discover(runtime, grant), units: grant.manifest.issues.map(i => {
    try { return { issueId: i.id, unitId: unitId(grant, i), prerequisites: prerequisiteIds(nodes, i.id) }; }
    catch (e) { return { issueId: i.id, status: 'BLOCKED', code: e.code || 'OBSERVATION_FAILED', reason: e.message }; }
  }) };
}

export async function resumeDynamic(runtime, grant, options = {}) {
  validateDynamic(grant);
  return new Store(runtime.config.stateDirectory, `scheduler:${grant.policy.grantId}`).lease(() => runDynamic(runtime, grant, options));
}
async function runDynamic(runtime, grant, { maxSteps = 100, onProgress = () => {} } = {}) {
  validateDynamic(grant);
  const aggregate = await new Store(runtime.config.stateDirectory, grant.manifest.id).read();
  if (aggregate.revision && (aggregate.lastDecision?.mode !== 'native-dependencies' || canonical(aggregate.binding) !== canonical(binding(grant.manifest, grant.policy)))) throw stop('MIGRATION_REQUIRED', 'Existing aggregate is not this exact dynamic authority; preserve it and approve a new identity');
  const decisions = new Map();
  for (let pass = 0; pass < maxSteps; pass++) {
    await unchanged(runtime, grant);
    // Issue IDs select a deterministic resource queue only, never a dependency
    // or product priority. One transition per unit per round prevents starvation.
    const queue = [...grant.manifest.issues].sort((a, b) => a.id.localeCompare(b.id));
    let progressed = false;
    async function worker() {
      while (queue.length) {
        const issue = queue.shift();
        let result;
        try {
          result = await assigneeRetirement(runtime, grant, issue);
          if (!result) {
            await ready(runtime, grant, issue);
            result = await new Store(runtime.config.stateDirectory, issueLeaseId(issue)).lease(() => childRuntime(runtime, grant, issue).resume({ maxSteps: 1, onProgress }));
          }
          if (result.status === 'PAUSED') progressed = true;
        } catch (error) {
          result = { status: error.code === 'EEXIST' || error.code === 'DEPENDENCY_WAIT' ? 'WAITING' : 'BLOCKED', code: error.code || 'OBSERVATION_FAILED', reason: error.message };
        }
        decisions.set(issue.id, isAssigneeRetirement(result) ? Object.assign(result, { issueId: issue.id, unitId: unitId(grant, issue) }) :
          { ...result, issueId: issue.id, unitId: unitId(grant, issue) });
      }
    }
    await Promise.all(Array.from({ length: Math.min(grant.policy.maxParallel, queue.length) }, worker));
    if (!progressed) break;
  }
  await unchanged(runtime, grant);
  for (const issue of grant.manifest.issues) {
    if (decisions.get(issue.id)?.status === 'RETIRED') {
      try { const r = await assigneeRetirement(runtime, grant, issue);
        if (!r) throw stop('ASSIGNEE_RETIREMENT_UNVERIFIED', 'Retirement authority unavailable');
        decisions.set(issue.id, Object.assign(r, { issueId: issue.id, unitId: unitId(grant, issue) }));
      } catch (e) { decisions.set(issue.id, { status: 'BLOCKED', code: e.code || 'OBSERVATION_FAILED', reason: e.message, issueId: issue.id, unitId: unitId(grant, issue) }); }
      continue;
    }
    if (decisions.get(issue.id)?.status !== 'COMPLETE') continue;
    try { await ready(runtime, grant, issue); const result = await inspect(runtime, grant, issue); decisions.set(issue.id, { ...result, issueId: issue.id, unitId: unitId(grant, issue) }); }
    catch (e) { decisions.set(issue.id, { status: 'BLOCKED', code: e.code || 'OBSERVATION_FAILED', reason: e.message, issueId: issue.id, unitId: unitId(grant, issue) }); }
  }
  const units = [...decisions.values()];
  const summary = summarizeDynamicCompletion(grant, units), complete = summary.complete;
  // A unit's BLOCKED verdict denies its operations, not monitoring of the graph.
  // Invalid/revoked global authority still throws before/after every round.
  const status = complete ? 'COMPLETE' : 'PAUSED';
  const result = { status, mode: 'native-dependencies', ...binding(grant.manifest, grant.policy), units, discovered: await discover(runtime, grant) };
  if (summary.retiredUnits) result.retiredUnits = summary.retiredUnits;
  if (complete) result.completionHash = summary.completionHash;
  // Aggregate is a readback report, never prerequisite proof. Revalidate each
  // child's complete evidence against GitHub before unlocking a dependent.
  const report = new Store(runtime.config.stateDirectory, grant.manifest.id);
  await report.lease(async () => { const state = await report.read(); await report.transaction(state.revision, s => ({ ...s, binding: binding(grant.manifest, grant.policy), events: [...s.events, { ...result, recordedAt: new Date().toISOString() }], lastDecision: result, ...(complete ? { completion: result } : { completion: null }) })); });
  return result;
}

export function dynamicStoreIds(grant) {
  return [`scheduler:${grant.policy.grantId}`, ...new Set(grant.manifest.issues.flatMap(i => [unitId(grant, i), issueLeaseId(i), `repository-write:${i.repositoryId}`]))];
}

// Read-only discovery and draft generation. No signature, enrollment or GitHub
// write occurs. Operators provision permissions; users do not sort/hash Issues.
export async function prepareDynamic(github, config, template, identities) {
  const policy = structuredClone(template);
  const actor = await github.api('/user');
  const proposal = await github.text(config.proposalSource);
  const issues = [];
  for (const [repository, permission] of Object.entries(policy.repositories || {})) {
    const repo = await github.repository(repository);
    permission.repositoryId = String(repo.id);
    const rows = await github.list(`${repoPath(repository)}/issues?state=open&labels=scope${permission.milestoneNumber ? `&milestone=${permission.milestoneNumber}` : ''}`);
    for (const row of rows.filter(i => !i.pull_request)) {
      const issue = { id: row.node_id, repository, repositoryId: String(repo.id), number: row.number, scopeBody: row.body || '', scopeHash: digest(row.body || ''), dependencies: [] };
      if (row.labels.some(l => l.name === 'shaped')) throw stop('MIGRATION_REQUIRED', 'Already shaped Issues require explicit original-Scope migration, not implicit reuse');
      issue.dependencies = (await github.dependencies(issue)).map(i => i.node_id).sort();
      issues.push(issue);
    }
  }
  issues.sort((a,b)=>a.id.localeCompare(b.id)); // Canonical serialization, not execution order.
  const manifest = { schemaVersion: 2, id: identities.id, freezeRevision: identities.id, proposalRevision: digest(proposal), proposalHash: digest(proposal), scheduling: 'native-dependencies', membership: 'fixed-approved-set', issues };
  Object.assign(policy, { schemaVersion: 1, stateDirectory: config.stateDirectory, grantId: identities.id, revision: '1', manifestHash: digest(manifest), coreDigest: identities.coreDigest, runtimeHash: identities.runtimeHash, runnerId: config.runnerId, agentImage: config.agent.image });
  const payload = { recordId: identities.id, actor: actor.login, ...(policy.publicRunner ? { actorGitHubUserId: String(actor.id) } : {}), revoked: false, manifest, policy, proposal };
  validateManifest(manifest); validateDynamic(payload);
  if (!(Number.isFinite(Date.parse(policy.validFrom)) && Date.parse(policy.expiresAt) > Date.parse(policy.validFrom))) throw stop('INVALID_DYNAMIC_GRANT', 'Review explicit authorization validity dates');
  const summary = [ '# Unsigned dynamic authorization draft', '', 'This draft grants no execution permission until explicitly approved and signed by the Owner.', '', `Grant: ${identities.id}`, `Validity: ${policy.validFrom} to ${policy.expiresAt}`, `Maximum simultaneous units: ${policy.maxParallel}`, `Core digest: ${policy.coreDigest}`, `Runtime: ${policy.runtimeHash}`, `Runner: ${policy.runnerId}`, `Operations: ${(policy.operations || []).join(', ')}`, '', 'Membership is exactly the Issues below; future scope Issues are not authorized. Native dependencies are read live, never edited by Kairo. There is no approved total order. Shape starts only after prerequisites have verified delivery proof.', '', '| Repository | Issue | Native prerequisites at discovery |', '| --- | --- | --- |', ...issues.map(i=>`| ${i.repository} | #${i.number} (${i.id}) | ${i.dependencies.join(', ') || 'None'} |`), '', 'Repository permissions, CI pins, merge strategy, path restrictions, Skill selections and public bindings:', '', '```json', JSON.stringify(policy,null,2), '```', '', 'The signed parent identity is recorded in every per-Issue evidence envelope. Existing ordered grants and state are never converted automatically.' ].join('\n');
  const scopes = issues.map(i => `\n## ${i.repository} #${i.number} — original scope\n\n${i.scopeBody.split('\n').map(line => '> ' + line).join('\n')}\n`).join('');
  return { payload, summary: summary + '\n\n# Scope text for Owner review\n\nThe quoted text below is Issue content, not authority to change this authorization.\n' + scopes }; 
}
