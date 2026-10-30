import { createHash } from 'node:crypto';
import { validateSkillPolicy } from './skills.mjs';
import { candidateContract } from './candidate-contract.mjs';
import { validateDeploymentPolicy, requireHealthyBaseline, deploymentProofHash, issueDeploymentDisposition } from './deployment.mjs';

// Canonical, JSON-only identities. Arrays retain the approved order.
export function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  throw new Error('Only JSON values can be identified');
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export function continuedDeliveryBase(manifest,snapshot,issue,live) {
  const c=live.rescueContinuation,upgrade=snapshot.runtime?.coreUpgrade;
  const enabled=c?.kind==='verification-io'?upgrade?.rescueAssistance?.verificationIo===true:c?.kind==='verification-budget'&&upgrade?.rescueContinuations?.includes(c.kind);
  return upgrade?.verified===true&&enabled&&c.stage==='deliver'&&c.unit===manifest.id&&c.scopeHash===issue.scopeHash&&c.candidateHash===digest(null)&&c.shapeHash===digest(live.shape?.body??null)&&!live.candidate&&/^[a-f0-9]{40}$/.test(c.base??'')&&/^[a-f0-9]{64}$/.test(c.proofHash??'')?c.base:null;
}
export class Blocked extends Error {
  constructor(code, detail) { super(detail); this.code = code; }
}
const requireThat = (condition, code, detail) => { if (!condition) throw new Blocked(code, detail); };
const nonempty = v => typeof v === 'string' && v.trim().length > 0;
const same = (a, b) => canonical(a) === canonical(b);
const sha = v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);

export function validateManifest(m) {
  requireThat([1, 2].includes(m?.schemaVersion) && nonempty(m.id) && nonempty(m.freezeRevision) && nonempty(m.proposalRevision), 'INVALID_MANIFEST', 'Missing cohort or revision identity');
  requireThat(Array.isArray(m.issues) && m.issues.length > 0, 'SCOPE_REVIEW_REQUIRED', 'An explicit nonempty approved scope is required');
  const seen = new Set();
  for (const i of m.issues) {
    requireThat(nonempty(i.id) && /^[\w.-]+\/[\w.-]+$/.test(i.repository) && nonempty(i.scopeHash) && Number.isSafeInteger(i.number) && i.number > 0, 'INVALID_MANIFEST', 'Issue requires stable ID, owning repository, number and frozen scope hash');
    requireThat(!seen.has(i.id), 'SCOPE_REVIEW_REQUIRED', `Duplicate issue ${i.id}`);
    requireThat(Array.isArray(i.dependencies) && i.dependencies.every(nonempty) && new Set(i.dependencies).size === i.dependencies.length, 'SCOPE_REVIEW_REQUIRED', `Invalid dependencies for ${i.id}`);
    for (const dep of i.dependencies) requireThat(m.schemaVersion === 2 || seen.has(dep), 'SCOPE_REVIEW_REQUIRED', `${i.id} is blocked by missing, cyclic or later dependency ${dep}`);
    seen.add(i.id);
  }
  if (m.schemaVersion === 2) {
    requireThat(m.scheduling === 'native-dependencies' && m.membership === 'fixed-approved-set', 'INVALID_MANIFEST', 'Dynamic manifests require explicit dependency scheduling and bounded membership');
    requireThat(m.issues.every(i => typeof i.repositoryId === 'string' && /^[1-9]\d*$/.test(i.repositoryId)), 'INVALID_MANIFEST', 'Dynamic issues require stable repository IDs');
  }
  return m;
}

export const binding = (manifest, policy) => ({
  authorityRevision: manifest.proposalRevision,
  cohortFreezeRevision: manifest.freezeRevision,
  autonomyPolicyRevision: policy.revision,
  grantId: policy.grantId,
  manifestHash: digest(manifest),
  policyHash: digest(policy),
});

// snapshot must come from a trusted observer, never an Agent result or event body.
// The planner is pure: it does not authenticate JSON files or perform GitHub writes.
function authority(m, p, s, now) {
  validateManifest(m);
  requireThat(m.schemaVersion === 1, 'DYNAMIC_SCHEDULER_REQUIRED', 'Dynamic grants must run through the dependency scheduler');
  requireThat(p?.schemaVersion === 1 && nonempty(p.grantId) && nonempty(p.revision), 'NO_GRANT', 'Explicit autonomy policy required');
  requireThat(p.manifestHash === digest(m), 'STALE_AUTHORITY', 'Policy does not bind the complete frozen scope and order');
  try { validateSkillPolicy(p); } catch (error) { throw new Blocked('INVALID_POLICY', error.message); }
  const approval = s.approval;
  requireThat(approval?.verified === true && nonempty(approval.recordId) && nonempty(approval.actor) && approval.manifestHash === digest(m) && approval.policyHash === digest(p), 'NO_GRANT', 'Independent owner approval readback is absent or mismatched');
  requireThat(approval.revoked === false && (p.controlMode === 'owner-project' || (Number.isFinite(Date.parse(p.validFrom)) && Number.isFinite(Date.parse(p.expiresAt)) && Date.parse(p.validFrom) <= now && now < Date.parse(p.expiresAt))), 'EXPIRED_OR_REVOKED', 'Policy is inactive, expired or revoked');
  requireThat(s.manifestHash === digest(m) && s.policyHash === digest(p), 'STALE_AUTHORITY', 'Live authority has changed');
  requireThat(s.runtime?.trusted === true && s.runtime.isolated === true && nonempty(p.coreDigest) && s.runtime.coreDigest === p.coreDigest && nonempty(p.runnerId) && s.runtime.runnerId === p.runnerId, 'UNTRUSTED_RUNTIME', 'Runner isolation or installed core identity mismatch');
  requireThat(s.runtime.agent === 'codex-chatgpt' && s.runtime.authenticated === true, 'AGENT_UNAVAILABLE', 'A trusted subscription-authenticated agent is required; no API fallback');
  requireThat(p.executionMode === undefined || p.executionMode === 'actions-v1', 'INVALID_POLICY', 'Unknown execution mode');
  if (p.executionMode === 'actions-v1') requireThat(s.runtime.actionStage?.kind === 'github-action-stage' && nonempty(s.runtime.actionStage.identityHash), 'ACTIONS_STAGE_REQUIRED', 'Each transition requires an independently verified private Actions Run');
  requireThat(Number.isInteger(p.maxRepairs) && p.maxRepairs >= 0, 'INVALID_POLICY', 'A finite repair budget is required');
  requireThat(p.deliveryRepairMode === undefined || ['bounded', 'until-conformant'].includes(p.deliveryRepairMode), 'INVALID_POLICY', 'Unknown delivery repair policy');
  requireThat(Array.isArray(p.operations) && p.repositories && Array.isArray(p.deniedPaths), 'INVALID_POLICY', 'Explicit operations, repository grants and path restrictions required');
  requireThat(s.issues && Object.keys(s.issues).length === m.issues.length, 'SCOPE_REVIEW_REQUIRED', 'Live membership differs from frozen membership');
  for (const issue of m.issues) {
    const live = s.issues[issue.id];
    requireThat(live?.id === issue.id && live.repository === issue.repository && live.number === issue.number && live.scopeHash === issue.scopeHash && same(live.dependencies, issue.dependencies), 'SCOPE_REVIEW_REQUIRED', `Scope or native dependencies changed: ${issue.id}`);
    const publicBinding = p.publicRunner?.bindings?.[issue.repository];
    requireThat(live.visibility === 'private' || (live.visibility === 'public' && publicBinding && live.runnerBinding && same(live.runnerBinding, publicBinding) && publicBinding.runnerId === p.runnerId && nonempty(p.nibfinOwnerGitHubUserId) && publicBinding.ownerId === p.nibfinOwnerGitHubUserId && live.creatorGitHubUserId === p.nibfinOwnerGitHubUserId && s.runtime.publicDispatch?.nibfinOwnerGitHubUserId === p.nibfinOwnerGitHubUserId && s.runtime.publicDispatch?.kind === 'public-runner-dispatch' && s.runtime.publicDispatch.rootId === p.publicRunner.rootId), 'PUBLIC_EXECUTION_BLOCKED', `Verified private runner dispatch and repository binding required: ${issue.repository}`);
    requireThat(p.repositories[issue.repository], 'OUT_OF_SCOPE', `Repository not granted: ${issue.repository}`);
  }
}

function evidence(e, stage, subject, b, artifacts = {}) {
  requireThat(e?.schemaVersion === 1 && e.stage === stage && e.subject === subject && nonempty(e.executionId), 'MISSING_EVIDENCE', `Missing ${stage} envelope for ${subject}`);
  requireThat(Object.entries(b).every(([k, v]) => e[k] === v), 'STALE_EVIDENCE', `${stage} authority binding changed`);
  requireThat(Array.isArray(e.evidenceReferences) && e.evidenceReferences.length > 0 && e.evidenceReferences.every(nonempty) && Array.isArray(e.blockingFindings), 'MISSING_EVIDENCE', `${stage} lacks evidence or findings`);
  requireThat(Object.entries(artifacts).every(([k, v]) => e.artifactIdentities?.[k] === v), 'STALE_EVIDENCE', `${stage} artifact identity changed`);
  requireThat(!Object.hasOwn(e, 'authorized'), 'AGENT_AUTHORITY_REJECTED', 'Agents cannot assert authorization');
  return e;
}

export function reviewOutcome(result) {
  const defect = ['implementation_defect', 'shape_defect'].includes(result.failureClass);
  if (defect && ['blocked', 'changes_required'].includes(result.outcome)) return 'changes_required';
  if (defect && !['blocked', 'changes_required'].includes(result.outcome)) throw new Blocked('INVALID_RESULT', 'Successful result contains a defect');
  if (result.outcome === 'changes_required' && ['authority_gap', 'external_failure'].includes(result.failureClass)) throw new Blocked('INVALID_RESULT', 'Unavailable authority or evidence is not a repair finding');
  return result.outcome;
}

function shapeConflict(e, issue, live) {
  requireThat(reviewOutcome(e) === 'changes_required' && e.failureClass === 'shape_defect', 'INVALID_SHAPE_DIAGNOSIS', 'Restoration requires a consistent independent Shape defect verdict');
  requireThat(e.blockingFindings.length > 0 && e.blockingFindings.every(nonempty), 'MISSING_CONFLICT_EVIDENCE', 'Shape defect requires concrete blocking findings');
  requireThat(Array.isArray(e.contractConflicts) && e.contractConflicts.length > 0, 'MISSING_CONFLICT_EVIDENCE', 'Missing structured Scope/Shape conflicts');
  for (const f of e.contractConflicts) {
    requireThat(f.scopeHash === issue.scopeHash && f.shapeHash === live.shape.bodyHash && digest(issue.scopeBody) === f.scopeHash && digest(live.shape.body) === f.shapeHash, 'STALE_CONFLICT_EVIDENCE', 'Conflict is not bound to the current frozen Scope and Shape');
    requireThat([f.scopeQuote, f.shapeQuote, f.explanation, f.evidenceReference].every(nonempty) && issue.scopeBody.includes(f.scopeQuote) && live.shape.body.includes(f.shapeQuote) && e.evidenceReferences.includes(f.evidenceReference), 'MISSING_CONFLICT_EVIDENCE', 'Conflict quotes and reference must resolve against reviewed sources');
  }
}

function successful(e, outcome) {
  requireThat(e.outcome === outcome, e.outcome === 'decision_required' || e.outcome === 'proposal_update_required' ? 'OWNER_DECISION_REQUIRED' : 'STAGE_BLOCKED', `${e.stage}: ${e.outcome}`);
  requireThat(e.blockingFindings.length === 0, 'STAGE_BLOCKED', `${e.stage} retains blocking findings`);
  requireThat(e.failureClass === undefined || e.failureClass === 'none', 'STAGE_BLOCKED', `${e.stage} claims success while retaining a failure classification`);
}

function shapeEvidence(issue, live, b) {
  requireThat(nonempty(live.shape?.bodyHash), 'MISSING_EVIDENCE', 'Shape body hash required');
  try { candidateContract(live.shape.body); } catch (error) { throw new Blocked('INVALID_CANDIDATE_CONTRACT',error.message); }
  const identities = { scopeHash: issue.scopeHash, shapeHash: live.shape.bodyHash };
  const author = evidence(live.shape.author, 'shape', issue.id, b, identities);
  successful(author, 'ready');
  const validator = evidence(live.shape.validator, 'shape-validator', issue.id, b, identities);
  requireThat(author.executionId !== validator.executionId, 'NOT_INDEPENDENT', 'Shape author cannot validate its own contract');
  successful(validator, 'approved');
  return identities;
}

function candidateEvidence(issue, live, b, requireHooks = true) {
  const c = live.candidate;
  requireThat(c?.repository === issue.repository && sha(c.base) && sha(c.tree) && nonempty(c.diffHash) && Array.isArray(c.paths) && c.paths.every(nonempty), 'INVALID_CANDIDATE', 'Complete owning-repository candidate identity required');
  requireThat(c.paths.every(path => !path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..') && !path.includes(':')), 'INVALID_CANDIDATE', 'Candidate paths must be repository-relative');
  let obligations;
  try { obligations = candidateContract(live.shape.body); } catch (error) { throw new Blocked('INVALID_CANDIDATE_CONTRACT',error.message); }
  requireThat(c.obligations && same(c.obligations, obligations), 'INVALID_CANDIDATE', 'Candidate must bind the independently validated Shape obligations');
  for (const [field, requirements] of [['artifacts', obligations.artifacts], ['hookSources', obligations.hooks]]) {
    requireThat(Array.isArray(c[field]) && c[field].length === requirements.length && requirements.every((entry,index) => {
      const observed = c[field][index];
      return observed && Object.entries(entry).every(([key,value]) => observed[key] === value) && /^[a-f0-9]{64}$/.test(observed.sha256) && Number.isSafeInteger(observed.size) && observed.size >= 0;
    }), 'MISSING_ARTIFACT_IDENTITY', 'Required artifacts and hook sources need exact content identities');
  }
  const artifacts = { candidateHash: digest(c), shapeHash: live.shape.bodyHash };
  const delivery = evidence(live.delivery, 'deliver', issue.id, b, artifacts);
  successful(delivery, 'ready');
  if (requireHooks) requireThat(live.hookEvidence?.candidateHash === digest(c) && nonempty(live.hookEvidence.executionId) && live.hookEvidence.status === (obligations.hooks.length ? 'passed' : 'not-applicable'), 'MISSING_HOOK_EVIDENCE', 'Trusted pre-accept hook execution must bind the complete Candidate');
  return { c, artifacts, delivery };
}

function acceptance(issue, live, b, artifacts, delivery) {
  const accept = evidence(live.accept, 'accept', issue.id, b, artifacts);
  requireThat(accept.executionId !== delivery.executionId, 'NOT_INDEPENDENT', 'Deliver session cannot accept its own candidate');
  requireThat(accept.artifactIdentities.preCommit === true, 'INVALID_ACCEPT', 'Acceptance must precede candidate commit');
  successful(accept, 'accepted');
  return accept;
}

function ciEvidence(live, grant) {
  const pr = live.pr;
  requireThat(pr && sha(pr.head) && pr.tree === live.candidate.tree && pr.base === live.candidate.base && pr.repository === live.repository && pr.baseBranch === grant.baseBranch && pr.branch.startsWith(grant.branchPrefix) && nonempty(pr.id), 'STALE_HEAD', 'PR identity differs from accepted candidate or branch policy');
  if (grant.ciMode === 'github-repository') {
    requireThat(pr.mergeState !== 'dirty', 'MERGE_CONFLICT', 'GitHub reports a merge conflict');
    requireThat(!(pr.mergeState === 'blocked' && live.checks?.some(c=>c.status === 'completed' && c.conclusion === 'failure')), 'CI_FAILED', 'GitHub blocked this PR and reported failing checks');
    return;
  }
  requireThat(Array.isArray(grant.requiredChecks) && grant.requiredChecks.length > 0, 'CI_NOT_CONFIGURED', 'At least one explicit required CI check is mandatory');
  requireThat(['github-required', 'owner-policy'].includes(grant.ciMode ?? 'github-required'), 'INVALID_POLICY', 'Unknown CI policy mode');
  if (grant.ciMode === 'owner-policy') {
    validateWorkflowPins(grant);
    const observed = live.protectionInspection;
    requireThat(observed && ((observed.source === 'branch-api' && observed.protected === false) || (observed.source === 'protection-apis' && typeof observed.protected === 'boolean')), 'MERGE_PROTECTED', 'Current protection inspection required; unknown rules cannot be waived');
    requireThat(Array.isArray(live.requiredChecks), 'CI_NOT_CONFIGURED', 'Observed server obligations are missing');
  } else requireThat(Array.isArray(live.requiredChecks) && live.requiredChecks.length > 0, 'CI_NOT_CONFIGURED', 'Live required checks must be read back');
  for (const name of new Set([...grant.requiredChecks, ...live.requiredChecks])) {
    const check = live.checks?.filter(c => c.name === name);
    requireThat(!(check?.length === 1 && check[0].head === pr.head && check[0].trusted === true && (grant.ciMode !== 'owner-policy' || check[0].provenanceMatched === true) && check[0].status === 'completed' && check[0].conclusion === 'failure'), 'CI_FAILED', `Required check failed: ${name}`);
    requireThat(check?.length === 1 && check[0].head === pr.head && check[0].status === 'completed' && check[0].conclusion === 'success' && nonempty(check[0].id) && check[0].trusted === true, 'CI_PENDING_OR_FAILED', `Missing unambiguous trusted exact-head success: ${name}`);
    if (grant.ciMode === 'owner-policy') {
      const pin = grant.requiredWorkflows.find(w => w.checks.includes(name));
      requireThat(pin && check[0].provenanceVerified === true && check[0].workflowPath === pin.path && check[0].workflowBlobSha === pin.blobSha && nonempty(check[0].runId) && nonempty(check[0].checkSuiteId) && Number.isSafeInteger(check[0].runAttempt) && check[0].runAttempt > 0, 'CI_PROVENANCE_MISMATCH', `Missing pinned workflow execution: ${name}`);
    }
  }
}

export function validateWorkflowPins(grant) {
  requireThat(Array.isArray(grant.requiredChecks) && grant.requiredChecks.length > 0 && grant.requiredChecks.every(nonempty), 'CI_NOT_CONFIGURED', 'Explicit nonempty check names required');
  requireThat(Array.isArray(grant.requiredWorkflows) && grant.requiredWorkflows.length > 0, 'INVALID_POLICY', 'Owner CI policy requires pinned workflows');
  const names = [], paths = [];
  for (const w of grant.requiredWorkflows) {
    requireThat(/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(w.path) && sha(w.blobSha) && Array.isArray(w.checks) && w.checks.length > 0 && w.checks.every(nonempty), 'INVALID_POLICY', 'Workflow path, blob SHA and check names required');
    paths.push(w.path); names.push(...w.checks);
  }
  requireThat(new Set(paths).size === paths.length && new Set(names).size === names.length && grant.requiredChecks.every(n => names.includes(n)), 'INVALID_POLICY', 'Every required check must have exactly one workflow pin');
}

function decide(m, p, s, now) {
  authority(m, p, s, now);
  for (const issue of m.issues) {
    const stop = s.issues[issue.id].blocked;
    if (stop) throw new Blocked(stop.outcome === 'decision_required' || stop.outcome === 'proposal_update_required' ? 'OWNER_DECISION_REQUIRED' : 'STAGE_BLOCKED', `${issue.id} ${stop.stage}: ${stop.summary}`);
  }
  const b = binding(m, p);
  const action = (operation, issue, artifacts = {}) => {
    requireThat(p.operations.includes(operation), 'OPERATION_DENIED', `Policy does not permit ${operation}`);
    return { status: 'READY', operation, issueId: issue.id, repository: issue.repository, ...b, artifacts };
  };
  const repair = (issue, live, stage, cause = 'review') => {
    const untilConformant = stage === 'deliver' && p.deliveryRepairMode === 'until-conformant';
    requireThat(Number.isInteger(live.repairs) && live.repairs >= 0 && (untilConformant || live.repairs < p.maxRepairs), 'REPAIR_BUDGET_EXHAUSTED', `Repair budget exhausted for ${issue.id}`);
    if (!untilConformant) requireThat(Number.isInteger(live.sameRootCauseFailures) && live.sameRootCauseFailures < 2, 'REPEATED_ROOT_CAUSE', 'Two unsuccessful fixes for the same root cause');
    return action('repair', issue, { stage, cause, attempt: live.repairs + 1 });
  };
  const invalidateShape = (issue, live, artifacts, verdict) => {
    shapeConflict(verdict, issue, live);
    requireThat(!live.merge && !live.mergeHistory?.length, 'MERGED_SHAPE_CONFLICT', 'Already merged work requires explicit recovery; Scope restoration cannot undo a merge');
    if (p.executionMode === 'actions-v1') requireThat(live.repairs < p.maxRepairs, 'REPAIR_BUDGET_EXHAUSTED', 'Shape restoration cannot waive the signed Shape repair bound');
    return action('invalidate-shape', issue, artifacts);
  };
  if (p.executionMode === 'actions-v1') for (const issue of m.issues) {
    const live = s.issues[issue.id], failure = live.deploymentFailure;
    if (!failure) continue;
    requireThat(failure.issueId === issue.id && failure.commit === live.merge?.commit && failure.status === 'failed', 'RECOVERY_ATTRIBUTION_INVALID', 'Failure must identify this actual merged delivery');
    requireThat(live.deploymentObservation?.status === 'failed' && deploymentProofHash(live.deploymentObservation) === failure.failureProofHash, 'DEPLOYMENT_FAILURE_STALE', 'A changed deployment observation cannot reuse stale repair attribution');
    const artifacts = { failureProofHash: failure.failureProofHash, mergedCommit: failure.commit };
    if (live.state === 'closed') {
      if (!live.recoveryComment) return action('record-recovery-comment', issue, artifacts);
      return action('reopen-recovery', issue, { ...artifacts, commentHash: live.recoveryComment.commentHash });
    }
    if (live.delivered) {
      requireThat(live.recoveryComment, 'RECOVERY_EVENT_UNVERIFIED', 'Previously delivered work requires an attributable Recovery Comment');
      if (!live.reopenedReceipt) return action('reopen-recovery', issue, { ...artifacts, commentHash: live.recoveryComment.commentHash });
      if (!live.recoverySource) return action('verify-recovery', issue, { ...artifacts, commentHash: live.recoveryComment.commentHash });
    }
    if (!live.deploymentDiagnosis) return action('diagnose-deployment', issue, artifacts);
    const diagnosis = evidence(live.deploymentDiagnosis, 'deployment-diagnosis', issue.id, b, { candidateHash: digest(live.candidate), failureProofHash: failure.failureProofHash });
    requireThat(diagnosis.executionId !== live.delivery.executionId && diagnosis.executionId !== live.accept.executionId && diagnosis.executionId !== live.review.executionId, 'NOT_INDEPENDENT', 'Deployment diagnosis must use a new independent reviewer');
    requireThat(reviewOutcome(diagnosis) === 'changes_required' && diagnosis.failureClass === 'implementation_defect' && diagnosis.blockingFindings.length > 0, 'RECOVERY_CLASSIFICATION_REQUIRED', 'Only independently proven implementation defects permit post-merge code repair');
    const permission = p.postMergeRecovery;
    requireThat(permission && permission.issueIds?.includes(issue.id) && permission.environments?.includes(failure.environment) && permission.streams?.includes(failure.stream) && Number.isSafeInteger(permission.maxCycles) && (live.mergeHistory?.length || 0) < permission.maxCycles, 'REPAIR_AUTHORITY_MISSING', 'Post-merge repair requires explicit bounded Owner authority for this Issue and deployment stream');
    const freshRepair = live.repairAuthorization;
    requireThat(freshRepair?.verified === true && freshRepair.issueId === issue.id && freshRepair.failureProofHash === failure.failureProofHash &&
      Date.parse(freshRepair.validFrom) <= now && now < Date.parse(freshRepair.expiresAt) && (live.mergeHistory?.length || 0) < freshRepair.maxCycles,
      'REPAIR_AUTHORITY_MISSING', 'Generic recovery permission cannot replace a fresh failure-specific signed Owner repair Grant');
    if (p.deliveryRepairMode !== 'until-conformant') requireThat(live.repairs < p.maxRepairs && live.sameRootCauseFailures < 2, 'REPAIR_BUDGET_EXHAUSTED', 'Post-merge correction cannot waive the signed bounded repair budget');
    requireThat(!live.delivered || permission.allowClosedRepair === true && live.recoverySource, 'REPAIR_AUTHORITY_MISSING', 'Closed-Issue repair requires explicit approval and verified recovery evidence');
    return action('post-merge-repair', issue, artifacts);
  }
  for (const issue of m.issues) {
    const live = s.issues[issue.id];
    requireThat(!live.scopeReset, 'SCOPE_REVIEW_REQUIRED', `${issue.id}: invalid Shape was restored to frozen Scope; new approved Shape/Freeze required`);
    if (live.shapeConcern) {
      if (!live.shapeDiagnosis) return action('diagnose-shape', issue, { shapeHash: live.shape.bodyHash, concernHash: digest(live.shapeConcern), attemptHash: digest(live.shapeConcern.attempt) });
      const diagnosis = evidence(live.shapeDiagnosis, 'shape-diagnosis', issue.id, b, { shapeHash: live.shape.bodyHash, concernHash: digest(live.shapeConcern) });
      requireThat(diagnosis.executionId !== live.shapeConcern.executionId, 'NOT_INDEPENDENT', 'Shape diagnosis must be independent of the reporting Agent');
      if (reviewOutcome(diagnosis) === 'changes_required' && diagnosis.failureClass === 'shape_defect') return invalidateShape(issue, live, { shapeHash: live.shape.bodyHash, diagnosisId: diagnosis.executionId }, diagnosis);
      if (!(reviewOutcome(diagnosis) === 'changes_required' && diagnosis.failureClass === 'implementation_defect' && diagnosis.blockingFindings.length > 0 && diagnosis.blockingFindings.every(nonempty))) successful(diagnosis, 'approved');
      return repair(issue, live, 'deliver', 'diagnosed-implementation');
    }
  }
  // Verify every published Shape before any delivery. Publication is separate
  // from frozen Scope identity: a lawful body rewrite is not scope drift.
  for (const issue of m.issues) {
    const live = s.issues[issue.id];
    if (!live.shape) return action('shape', issue);
    if (!live.shape.validator) {
      requireThat(nonempty(live.shape.bodyHash), 'MISSING_EVIDENCE', 'Shape body hash required');
      const author = evidence(live.shape.author, 'shape', issue.id, b, { scopeHash: issue.scopeHash, shapeHash: live.shape.bodyHash });
      successful(author, 'ready');
      return action('validate-shape', issue, { shapeHash: live.shape.bodyHash });
    }
    if (live.shape.validator.outcome === 'changes_required') {
      const identities = { scopeHash: issue.scopeHash, shapeHash: live.shape.bodyHash };
      const author = evidence(live.shape.author, 'shape', issue.id, b, identities);
      successful(author, 'ready');
      const validator = evidence(live.shape.validator, 'shape-validator', issue.id, b, identities);
      requireThat(author.executionId !== validator.executionId, 'NOT_INDEPENDENT', 'Shape author cannot validate its own contract');
      return repair(issue, live, 'shape');
    }
    const identities = shapeEvidence(issue, live, b);
    if (!live.shape.publication) return action('publish-shape', issue, identities);
    requireThat(live.shape.publication.policyHash === b.policyHash && nonempty(live.shape.publication.decisionId) && live.shape.publication.bodyHash === live.shape.bodyHash &&
      (p.issueScopeSource==='github-issue'?live.bodyHash===issue.scopeHash && live.shape.publication.scopeHash===issue.scopeHash:live.bodyHash===live.shape.bodyHash) && live.labels.includes('shaped'), 'SHAPE_PUBLICATION_MISMATCH', 'Published requirements, label or core decision does not match validated Shape');
  }
  for (const issue of m.issues) {
    const live = s.issues[issue.id];
    const grant = p.repositories[issue.repository];
    const disposition=issueDeploymentDisposition(grant,issue);
    if(disposition==='required')requireThat(grant.deployment?.mode==='required','WEBSITE_DEPLOYMENT_POLICY_REQUIRED','Issue #52 requires its separately authorized exact deployment policy before Deliver or completion');
    requireThat(nonempty(grant.baseBranch) && nonempty(grant.branchPrefix), 'INVALID_POLICY', 'Explicit base and controlled branch prefix required');
    if (live.candidateFailure) return repair(issue,live,'deliver','candidate-obligation');
    if (!live.candidate) {
      requireThat(sha(live.defaultHead), 'STALE_BASE', 'Latest default branch SHA must be observed before delivery');
      if (p.executionMode === 'actions-v1') {
        try {
          const repair = live.recoveryActive;
          const exception = repair?.policyHash === b.policyHash && live.repairBaseline?.status === 'failed' && deploymentProofHash(live.repairBaseline) === repair.failureProofHash && repair.issueId === issue.id &&
            live.repairAuthorization?.verified === true && digest(live.repairAuthorization) === repair.repairAuthorizationHash && Date.parse(live.repairAuthorization.validFrom) <= now && now < Date.parse(live.repairAuthorization.expiresAt);
          if (!exception) requireHealthyBaseline(grant.deployment, live.deploymentBaseline,
            live.deploymentBaselineExpected || {repository:issue.repository,repositoryId:grant.repositoryId,issueId:issue.id}, now);
        }
        catch (error) { throw new Blocked(error.code || 'DEPLOYMENT_BASELINE_UNHEALTHY', error.message); }
      }
      return action('deliver', issue, { base: continuedDeliveryBase(m,s,issue,live)||live.defaultHead });
    }
    const { c, artifacts, delivery } = candidateEvidence(issue, live, b, p.executionMode !== 'actions-v1' || Boolean(live.hookEvidence));
    const publicationPaths = [...c.paths, ...c.artifacts.map(a => a.path)];
    requireThat(publicationPaths.every(path => !p.deniedPaths.some(prefix => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))), 'PATH_DENIED', 'Candidate touches a policy-restricted path');
    if (grant.allowedPaths !== undefined) requireThat(Array.isArray(grant.allowedPaths) && grant.allowedPaths.length > 0 && grant.allowedPaths.every(nonempty) && publicationPaths.every(path => grant.allowedPaths.some(prefix => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))), 'PATH_DENIED', 'Candidate exceeds the approved repository path allowlist');
    if (issue.allowedPaths !== undefined) requireThat(Array.isArray(issue.allowedPaths) && issue.allowedPaths.length > 0 && issue.allowedPaths.every(nonempty) && publicationPaths.every(path => issue.allowedPaths.includes(path)), 'PATH_DENIED', 'Candidate exceeds the approved Issue file allowlist');
    if (!live.merge && c.base !== live.defaultHead) return repair(issue, live, 'deliver', 'base');
    if (p.executionMode === 'actions-v1' && !live.hookEvidence) return action('pre-accept-hooks', issue, artifacts);
    if (!live.accept) return action('accept', issue, artifacts);
    if (reviewOutcome(live.accept) === 'changes_required') {
      const accept = evidence(live.accept, 'accept', issue.id, b, artifacts);
      requireThat(accept.executionId !== delivery.executionId, 'NOT_INDEPENDENT', 'Deliver session cannot accept its own candidate');
      if (accept.failureClass === 'shape_defect') return invalidateShape(issue, live, { ...artifacts, diagnosisId: accept.executionId }, accept);
      if (p.deliveryRepairMode === 'until-conformant') requireThat(accept.failureClass === 'implementation_defect', 'UNCLASSIFIED_FAILURE', 'Independent reviewer must distinguish implementation defects from authority or Shape errors');
      return repair(issue, live, 'deliver');
    }
    const accept = acceptance(issue, live, b, artifacts, delivery);
    requireThat(c.paths.length > 0, 'INVALID_ACCEPT', 'An empty delivery attempt cannot be committed');
    if (p.executionMode === 'actions-v1' && !live.preCommitHooks) return action('post-accept-hooks', issue, artifacts);
    if (!live.pr) return action('commit-pr', issue, artifacts);
    requireThat(live.preCommitHooks?.candidateHash === digest(c) && nonempty(live.preCommitHooks.executionId) && live.preCommitHooks.status === (c.obligations.hooks.length ? 'passed' : 'not-applicable'), 'MISSING_HOOK_EVIDENCE', 'PR requires trusted post-Accept hook consistency evidence');
    try { ciEvidence(live, grant); }
    catch (error) {
      if (error.code === 'MERGE_CONFLICT' && !live.merge) return repair(issue,live,'deliver','merge-conflict');
      if (error.code === 'CI_FAILED' && !live.merge) return repair(issue, live, 'deliver', 'ci');
      throw error;
    }
    const reviewArtifacts = { ...artifacts, head: live.pr.head, prId: live.pr.id };
    if (!live.review) return action('shaper-review', issue, reviewArtifacts);
    const review = evidence(live.review, 'shaper-review', issue.id, b, reviewArtifacts);
    requireThat(![delivery.executionId, accept.executionId, live.shape.author.executionId, live.shape.validator.executionId].includes(review.executionId), 'NOT_INDEPENDENT', 'Final review requires a fresh independent execution');
    if (reviewOutcome(review) === 'changes_required') {
      if (review.failureClass === 'shape_defect') return invalidateShape(issue, live, { ...reviewArtifacts, diagnosisId: review.executionId }, review);
      if (p.deliveryRepairMode === 'until-conformant') requireThat(review.failureClass === 'implementation_defect', 'UNCLASSIFIED_FAILURE', 'Review failure requires an independent classification');
      return repair(issue, live, 'deliver');
    }
    successful(review, 'approved');
    if (!live.merge) {
      requireThat((grant.ciMode === 'github-repository' || live.pr.protectionSatisfied === true) && live.pr.mergePermission === true && live.pr.state === 'open', 'MERGE_PROTECTED', 'Current GitHub protection and merge permission must be satisfied');
      requireThat(['merge', 'squash', 'rebase'].includes(grant.mergeMethod), 'INVALID_POLICY', 'Explicit permitted merge method required');
      if (grant.ciMode === 'github-repository') requireThat(grant.mergeStrategy !== 'atomic-merge', 'INVALID_POLICY', 'Repository controls require GitHub merge API');
      if (grant.mergeStrategy === 'atomic-merge') requireThat(grant.mergeMethod === 'merge' && live.protectionInspection?.protected === false, 'MERGE_BASE_UNSAFE', 'Atomic merge requires explicit merge-commit policy on an unprotected branch; never bypass server protections');
      else if (grant.ciMode !== 'github-repository') requireThat(live.protectionInspection?.strictBase === true, 'MERGE_BASE_UNSAFE', 'REST merge requires server-enforced strict up-to-date checks including administrators');
      return action('merge', issue, { ...reviewArtifacts, base: c.base, method: grant.mergeMethod });
    }
    requireThat(live.merge.prId === live.pr.id && live.merge.head === live.pr.head && sha(live.merge.commit) && live.merge.verified === true && live.merge.policyHash === b.policyHash && nonempty(live.merge.decisionId), 'MERGE_UNVERIFIED', 'Actual merge and authorizing decision must be independently verified');
    requireThat(grant.ciMode === 'github-repository' || Array.isArray(grant.finalProofs) && grant.finalProofs.every(name => live.finalProofs?.some(proof => proof.name === name && proof.commit === live.merge.commit && proof.verified === true && nonempty(proof.id))), 'FINAL_PROOF_MISSING', 'Required post-merge evidence is absent');
    if(disposition==='source-only') {
      try { requireHealthyBaseline(grant.deployment,live.deploymentBaseline,live.deploymentBaselineExpected||{repository:issue.repository,repositoryId:grant.repositoryId,issueId:issue.id},now); }
      catch(error){throw new Blocked(error.code||'DEPLOYMENT_BASELINE_UNHEALTHY',error.message);}
    }
    const ownerFinalize = p.controlMode === 'owner-project' && (grant.deployment?.mode === 'not-applicable' || disposition==='source-only');
    if (ownerFinalize && (live.state !== 'closed' || !live.labels.includes('delivered') || !live.closeReceipt || !live.delivered)) {
      requireThat(p.operations.includes('mark-delivered'), 'OPERATION_DENIED', 'Finalization requires closure and label permissions');
      return action('close', issue, {mergedCommit:live.merge.commit});
    }
    if (p.executionMode === 'actions-v1' && !ownerFinalize) {
      try { validateDeploymentPolicy(grant.deployment); } catch (error) { throw new Blocked(error.code, error.message); }
      const proof = live.deploymentObservation;
      requireThat(proof && (['healthy', 'failed'].includes(proof.status) || proof.mode === 'not-applicable'), 'DEPLOYMENT_PENDING', 'Applicable deployment version and health/function proof must exist before Closure');
      if (!live.deploymentVerification || live.deploymentVerification.proofHash !== deploymentProofHash(proof)) return action('verify-deployment', issue, { mergedCommit: live.merge.commit, deploymentProofHash: deploymentProofHash(proof) });
      requireThat(proof.status !== 'failed', 'DEPLOYMENT_FAILED', 'Verified deployment failure requires independently classified, authorized post-merge correction');
    }
    if (live.state !== 'closed') return action('close', issue, { mergedCommit: live.merge.commit });
    requireThat(live.closure?.verified === true && nonempty(live.closure.id) && live.closure.mergeCommit === live.merge.commit, 'CLOSURE_UNVERIFIED', 'Issue closure must bind the merged commit');
    if (p.executionMode === 'actions-v1') requireThat(live.closeReceipt?.policyHash === b.policyHash && live.closeReceipt.mergeCommit === live.merge.commit && live.closeReceipt.action?.kind === 'github-action-stage' && live.closure.id === `${issue.id}:${live.closeReceipt.closedAt}`, 'CLOSURE_UNVERIFIED', 'A handwritten close cannot replace the authorized Closure Action receipt');
    if (!live.labels.includes('delivered')) return action('mark-delivered', issue, { mergedCommit: live.merge.commit });
    requireThat(live.delivered?.policyHash === b.policyHash && nonempty(live.delivered.decisionId) && live.delivered.mergeCommit === live.merge.commit, 'DELIVERY_UNVERIFIED', 'A label alone cannot prove delivery');
  }
  return { status: 'COMPLETE', ...b, completionHash: digest({ binding: b, issues: m.issues.map(i => ({ id: i.id, merge: s.issues[i.id].merge, closure: s.issues[i.id].closure, delivered: s.issues[i.id].delivered, ...(p.executionMode === 'actions-v1' ? { ...(s.issues[i.id].deploymentVerification ? {deployment:s.issues[i.id].deploymentVerification} : {}), closeReceipt: s.issues[i.id].closeReceipt } : {}) })) }) };
}

export function plan(manifest, policy, snapshot, now = Date.now()) {
  try {
    requireThat(Number.isFinite(now), 'INVALID_TIME', 'A valid observation time is required');
    const decision = decide(manifest, policy, snapshot, now);
    return { ...decision, decisionId: digest({ decision, snapshotHash: digest(snapshot), observedAt: now }), observedAt: now };
  } catch (error) {
    return { status: 'BLOCKED', code: error instanceof Blocked ? error.code : 'INVALID_INPUT', reason: error.message, observedAt: now };
  }
}
