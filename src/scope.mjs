import { readFile } from 'node:fs/promises';
import { digest } from './index.mjs';
import { validateSnapshot } from './requirements.mjs';

const text = x => typeof x === 'string' && x.trim().length > 0;
const list = x => Array.isArray(x) ? x : [];
const evidence = x => Array.isArray(x) && x.length > 0 && x.every(text);
const repo = x => text(x) && /^[^/\s]+\/[^/\s]+$/.test(x);
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const unique = xs => new Set(xs).size === xs.length;
const protectedStates = ['frozen', 'authorized', 'shaped', 'executing', 'delivered', 'closed'];
const accounting = ['added', 'ported', 'rewritten', 'tests', 'scripts', 'configuration', 'workflows'];
export async function scopeInstructions() {
  return readFile(new URL('./instructions/scope.md', import.meta.url), 'utf8');
}
// This digest binds the entire plan, including metadata, drafts and every edge.
export const publicationPlanDigest = plan => digest(plan);

export async function verifyScopePlan(input, trusted = {}) {
  const findings = [];
  const add = (code, subject, message) => findings.push({ code, subject, message });
  let p;
  try { p = structuredClone(input); } catch {
    return { planValid: false, findings: [{ code: 'invalid-plan', message: 'Plan is not serializable.' }] };
  }
  try {
    if (!p || p.schemaVersion !== 1 || !text(p.id)) throw Error();
    const snapshot = validateSnapshot(p.authority);
    if (!text(snapshot.content) || !Array.isArray(p.requirements) || !p.requirements.length ||
        typeof trusted.verifyAuthority !== 'function' ||
        await trusted.verifyAuthority(structuredClone({ snapshot, requirements: p.requirements })) !== true) throw Error();
  } catch { add('authority-unavailable', p?.id, 'Complete current authority and its requirement ledger must be authenticated.'); }
  if (!p || typeof p !== 'object') return { planValid: false, findings };
  const requirements = list(p.requirements), items = list(p.items), edges = list(p.dependencies);
  if (!['items', 'dependencies', 'prerequisites', 'sharedVerification', 'investigations'].every(k => Array.isArray(p[k]))) {
    add('invalid-inventory', p.id, 'Plan item, dependency, prerequisite, shared-verification and investigation arrays are required.');
  }
  if ([requirements, items, edges, list(p.prerequisites), list(p.sharedVerification), list(p.investigations), list(p.boundary?.excluded)].some(xs => xs.some(x => !record(x)))) {
    add('invalid-record', p.id, 'Ledger, items, edges and evidence inventories must contain records.');
    return { planValid: false, findings };
  }
  const ids = requirements.map(r => r.id), itemIds = items.map(i => i.id);
  if (!unique(ids) || requirements.some(r => !text(r.id) || !repo(r.repository) || !text(r.outcome) ||
      !text(r.sourceClause) || !evidence(r.evidence))) add('invalid-ledger', p.id, 'Requirements need unique IDs, normative owners, outcomes, clauses and evidence.');
  if (!unique(itemIds)) add('duplicate-item', p.id, 'Plan item IDs must be unique.');
  const boundary = p.boundary;
  let selected = ids;
  if (!boundary || !['whole', 'partial'].includes(boundary.mode)) {
    add('invalid-boundary', p.id, 'Specify a whole or explicitly approved partial boundary.');
  } else if (boundary.mode === 'partial') {
    selected = list(boundary.included);
    const excluded = list(boundary.excluded);
    if (!selected.length || !unique(selected) || !unique(excluded.map(e => e.id)) ||
        selected.some(id => !ids.includes(id)) || excluded.some(e => !ids.includes(e.id) || selected.includes(e.id) || !text(e.reason)) ||
        ids.some(id => !selected.includes(id) && !excluded.some(e => e.id === id))) {
      add('invalid-boundary', p.id, 'Partial inclusion and reasoned exclusions must partition the current ledger.');
    }
    try {
      if (typeof trusted.verifyBoundaryApproval !== 'function' ||
          await trusted.verifyBoundaryApproval(structuredClone({ planId: p.id, authority: p.authority.reference, boundary })) !== true) throw Error();
    } catch { add('partial-approval', p.id, 'The exact partial boundary lacks authenticated user approval.'); }
  }
  if (!Array.isArray(p.unresolved) || p.unresolved.some(x => !text(x))) add('invalid-unresolved', p.id, 'List unresolved facts explicitly, using an empty list when none remain.');
  if (list(p.unresolved).length) add('unresolved', p.id, 'Unresolved facts prevent an unsupported completeness claim.');
  const coverage = new Map(selected.map(id => [id, []]));
  for (const item of items) {
    if (!text(item.id) || !repo(item.repository) || !text(item.body) || !text(item.acceptance) ||
        !evidence(item.evidence) || !item.metadata || typeof item.metadata !== 'object' || Array.isArray(item.metadata)) {
      add('invalid-item', item.id, 'Each original draft needs identity, repository, body, metadata, acceptance boundary and evidence.');
    }
    if (list(item.metadata?.labels).some(label => ['shaped', 'delivered'].includes(label))) {
      add('protected-metadata', item.id, 'Scope publication cannot manufacture formal stage or completion labels.');
    }
    if (item.metadata && Object.hasOwn(item.metadata, 'assignees') &&
        (!Array.isArray(item.metadata.assignees) || !item.metadata.assignees.every(text))) {
      add('invalid-assignees', item.id, 'Assignees must be an explicit list of user-decided identities.');
    }
    if (!list(item.requirements).length || !unique(list(item.requirements))) add('untraced-item', item.id, 'Each item must map to distinct authoritative requirements.');
    for (const id of list(item.requirements)) {
      const r = requirements.find(r => r.id === id);
      if (!r || !selected.includes(id)) add('outside-boundary', item.id, `Requirement ${id} is outside the approved boundary.`);
      else {
        coverage.get(id).push(item.id);
        if (r.repository !== item.repository) add('ownership-drift', item.id, `Requirement ${id} belongs to ${r.repository}.`);
      }
    }
    const effort = item.effort;
    if (!effort || !Number.isSafeInteger(effort.lines) || effort.lines < 1 ||
        !['low', 'medium', 'high'].includes(effort.confidence) || !text(effort.basis) ||
        !accounting.every(k => Number.isSafeInteger(effort.counts?.[k]) && effort.counts[k] >= 0) ||
        accounting.reduce((n, k) => n + (effort.counts?.[k] ?? 0), 0) !== effort.lines) {
      add('invalid-effort', item.id, 'Count meaningful first-party work including tests, ports and rewrites; net growth is insufficient.');
    } else if (effort.lines > 1000 && (!text(effort.exception?.reason) || !evidence(effort.exception?.reassessment))) {
      add('oversized-item', item.id, 'Over-budget work requires a reasoned exception and Scope reassessment evidence.');
    }
  }
  for (const prerequisite of list(p.prerequisites)) {
    if (!selected.includes(prerequisite.requirement) || !text(prerequisite.outcome) || !repo(prerequisite.repository) ||
        !evidence(prerequisite.evidence) || requirements.find(r => r.id === prerequisite.requirement)?.repository !== prerequisite.repository) add('invalid-prerequisite', prerequisite.requirement, 'External prerequisites need an explicit outcome, owner and evidence.');
    else coverage.get(prerequisite.requirement).push(`prerequisite:${prerequisite.outcome}`);
  }
  for (const [id, owners] of coverage) {
    if (!owners.length) add('missing-coverage', id, 'No Issue outcome or evidenced prerequisite covers this requirement.');
    if (owners.length > 1 && !list(p.sharedVerification).some(s => s.requirement === id &&
        text(s.rationale) && evidence(s.evidence) && digest([...list(s.items)].sort()) === digest([...owners].sort()))) {
      add('duplicate-coverage', id, 'Repeated coverage requires an exact shared-verification inventory and rationale.');
    }
  }
  const adjacency = new Map(itemIds.map(id => [id, []]));
  if (!unique(edges.map(e => `${e.item}:${e.blockedBy}`))) add('duplicate-edge', p.id, 'Proposed native edges must be unique.');
  for (const edge of edges) {
    if (!adjacency.has(edge.item) || !adjacency.has(edge.blockedBy)) add('dangling-dependency', edge.item, 'Dependency endpoint is absent from this plan.');
    else adjacency.get(edge.item).push(edge.blockedBy);
    if (!text(edge.rationale) || !text(edge.interface) || !evidence(edge.evidence) || edge.kind !== 'prerequisite') {
      add('unjustified-dependency', edge.item, 'Every edge needs concrete prerequisite/interface rationale and evidence; order is insufficient.');
    }
  }
  const reaches = (start, target, skip, seen = new Set()) => {
    if (start === target) return true;
    if (seen.has(start)) return false;
    seen.add(start);
    return list(adjacency.get(start)).some(next => !(skip && start === skip.item && next === skip.blockedBy) && reaches(next, target, skip, seen));
  };
  for (const edge of edges) {
    if (reaches(edge.blockedBy, edge.item)) add('dependency-cycle', edge.item, 'Proposed dependencies contain a cycle.');
    else if (reaches(edge.item, edge.blockedBy, edge)) add('redundant-dependency', edge.item, 'A transitive path already supplies this blocker.');
  }
  for (const investigation of list(p.investigations)) {
    if (!text(investigation.source) || !text(investigation.revision) || !evidence(investigation.evidence) ||
        !text(investigation.findings) || !Array.isArray(investigation.uncertainty) || !investigation.uncertainty.every(text) ||
        !text(investigation.interfaces) || !text(investigation.implication) ||
        !itemIds.includes(investigation.item) || !['boundary', 'ownership', 'dependency'].includes(investigation.use)) {
      add('invalid-investigation', investigation.item, 'Investigation needs revision-linked findings, uncertainty and a planning implication.');
    }
  }
  return { planValid: findings.length === 0, planDigest: publicationPlanDigest(p), findings,
    coverage: Object.fromEntries(coverage), planningEvidence: list(p.investigations).map(i => ({
      ...Object.fromEntries(['source', 'revision', 'evidence', 'findings', 'uncertainty', 'interfaces', 'implication', 'item', 'use'].map(k => [k, i[k]])),
      status: 'planning-evidence' })) };
}

export async function verifyScopeHandoff(input, trusted = {}) {
  const p = structuredClone(input);
  const design = await verifyScopePlan(p, trusted);
  const limitations = [];
  const expected = { planId: p.id, planDigest: publicationPlanDigest(p) };
  try {
    if (typeof trusted.verifyPublicationApproval !== 'function' ||
        await trusted.verifyPublicationApproval(structuredClone(expected)) !== true) throw Error();
  } catch { limitations.push('Explicit approval of the exact complete publication plan is unavailable.'); }
  for (const item of list(p.items)) {
    try {
      if (item.metadata && Object.hasOwn(item.metadata, 'assignees') && (typeof trusted.verifyAssigneeDecision !== 'function' ||
          await trusted.verifyAssigneeDecision(structuredClone({ ...expected, item })) !== true)) {
        limitations.push(`Specific user Assignee decision is unavailable for ${item.id}.`);
      }
      if (typeof trusted.observeWork !== 'function') throw Error();
      const current = await trusted.observeWork(structuredClone(item));
      if (!current || current.complete !== true || !evidence(current.evidence) ||
          !Array.isArray(current.states) || !current.states.length || current.states.some(s => !['original', ...protectedStates].includes(s))) throw Error();
      if (current.states.some(s => protectedStates.includes(s))) limitations.push(`Protected work ${item.id} requires lifecycle safety, reauthorization and a separately approved publication path.`);
    } catch { limitations.push(`Current protected-work eligibility is unknown for ${item.id}.`); }
  }
  try {
    const available = await trusted.publicationPreflight?.(structuredClone(expected));
    if (available?.tools !== true) limitations.push('Publication tools are unavailable.');
    for (const repository of new Set(list(p.items).map(i => i.repository))) {
      if (available?.writeRepositories?.includes(repository) !== true) limitations.push(`Write permission is unverified for ${repository}.`);
    }
    if (available?.journal?.writable !== true || available?.journal?.persistent !== true ||
        available?.journal?.recoverable !== true || !evidence(available?.journal?.evidence)) {
      limitations.push('A writable, persistent, recoverable Publication Journal is unverified.');
    }
  } catch { limitations.push('Publication availability could not be verified.'); }
  return { ...design, publicationReady: design.planValid && limitations.length === 0, limitations,
    handoff: 'Preflight only. Before writing, the authorized publisher must verify fresh permission and durable journal, retain intents, independently read back partial/unknown results, and never blindly recreate or roll back work. No execution grant is issued.' };
}

// Only this read method is used. Mutation methods on the adapter are never invoked.
export async function auditScope(input, trusted = {}, adapter = {}) {
  const p = structuredClone(input);
  const baseline = await verifyScopePlan(p, trusted);
  const findings = [...baseline.findings];
  const add = (code, item, observation, message, refs) => findings.push({ code, item: item?.id,
    requirements: item?.requirements ?? [], observedIdentity: observation ? { repository: observation.repository, issueId: observation.issueId } : null,
    evidence: evidence(refs) ? refs : ['unknown'], message });
  const observed = [], unknown = [];
  for (const repository of new Set(list(p.items).map(i => i.repository))) {
    try {
      const inventory = structuredClone(await adapter.readInventory(repository));
      if (inventory?.complete !== true || !evidence(inventory.evidence) || !Array.isArray(inventory.issues) ||
          inventory.issues.some(o => !record(o) || o.repository !== repository || !text(o.issueId) || !evidence(o.evidence) ||
            !Array.isArray(o.blockedBy) || o.blockedBy.some(e => !record(e) || !repo(e.repository) || !text(e.issueId)))) throw Error();
      observed.push(...inventory.issues);
    } catch {
      unknown.push(repository);
      for (const item of list(p.items).filter(i => i.repository === repository)) {
        add('unknown-read', item, null, `Actual work in ${repository} is unknown; read failed or was incomplete.`, []);
      }
    }
  }
  const matched = new Map();
  for (const item of list(p.items)) {
    // Exact stable identity wins. planItemId also discovers duplicate tickets and ownership drift.
    const matches = observed.filter(o => o.planItemId === item.id ||
      (item.observed?.issueId === o.issueId && item.observed?.repository === o.repository));
    matched.set(item.id, matches);
    if (!matches.length && !unknown.includes(item.repository)) add('missing-ticket', item, null, 'Planned original Issue is missing.', item.evidence);
    if (matches.length > 1) for (const o of matches) add('duplicate-ticket', item, o, 'Multiple actual Issues claim this plan item.', o.evidence);
    for (const o of matches) {
      if (o.repository !== item.repository) add('ownership-drift', item, o, 'Observed Issue belongs to the wrong normative repository.', o.evidence);
      if (item.observed && (o.issueId !== item.observed.issueId || o.repository !== item.observed.repository)) {
        add('identity-drift', item, o, 'Observed stable identity differs from the baseline.', o.evidence);
      }
      if (o.originalScopeDigest !== digest(item.body)) add('scope-traceability-loss', item, o, 'Preserved original Scope does not match; mutable Shape body is not an original-Scope substitute.', o.evidence);
      if (o.completion?.claimed === true && o.completion.repository !== item.repository) {
        add('source-completion', item, o, 'Source-project evidence cannot establish target-project completion.', o.evidence);
      }
    }
  }
  for (const item of list(p.items)) for (const o of matched.get(item.id)) {
    const expected = [];
    let uncertain = false;
    for (const edge of list(p.dependencies).filter(e => e.item === item.id)) {
      const upstream = matched.get(edge.blockedBy) ?? [];
      if (upstream.length !== 1) uncertain = true;
      else expected.push({ repository: upstream[0].repository, issueId: upstream[0].issueId });
    }
    if (uncertain) add('unknown-dependencies', item, o, 'Upstream stable identity is unavailable or ambiguous.', o.evidence);
    else {
      const key = i => `${i.repository}#${i.issueId}`;
      for (const edge of expected) if (!o.blockedBy.some(x => key(x) === key(edge))) add('dependency-removed', item, o, `Missing native blocker ${key(edge)}.`, o.evidence);
      for (const edge of o.blockedBy) if (!expected.some(x => key(x) === key(edge))) add('dependency-added', item, o, `Unexpected native blocker ${key(edge)}.`, o.evidence);
    }
  }
  return { baselineValid: baseline.planValid, status: unknown.length ? 'unknown' : findings.length ? 'findings' : 'consistent',
    findings, remediation: 'Read-only observations. Corrections require a separate concrete plan and applicable approval.',
    planningEvidence: baseline.planningEvidence };
}
