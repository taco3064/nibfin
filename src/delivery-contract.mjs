// Candidate/evidence guards reused from Kairo src/core.mjs at
// d1b47d5e073cf15bdcdc1fbbec098401649878d9. The Nibfin adapter below projects
// independently checked v1 custody receipts; it cannot authenticate Agent claims.
import {createHash} from 'node:crypto';
import {canonicalJSON} from './canonical.mjs';
import {candidateContract} from './candidate-contract.mjs';
import {sourceManifest} from './workspace-sources.mjs';
import {Blocked} from './delivery-planner.mjs';
const digest=v=>createHash('sha256').update(canonicalJSON(v)).digest('hex');
const same=(a,b)=>canonicalJSON(a)===canonicalJSON(b);
const nonempty=v=>typeof v==='string'&&v.trim().length>0;
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const requireThat=(ok,code,detail)=>{if(!ok)throw new Blocked(code,detail);};
function evidence(e, stage, subject, b, artifacts = {}) {
  requireThat(e?.schemaVersion === 1 && e.stage === stage && e.subject === subject && nonempty(e.executionId), 'MISSING_EVIDENCE', `Missing ${stage} envelope for ${subject}`);
  requireThat(Object.entries(b).every(([k, v]) => e[k] === v), 'STALE_EVIDENCE', `${stage} authority binding changed`);
  requireThat(Array.isArray(e.evidenceReferences) && e.evidenceReferences.length > 0 && e.evidenceReferences.every(nonempty) && Array.isArray(e.blockingFindings), 'MISSING_EVIDENCE', `${stage} lacks evidence or findings`);
  requireThat(Object.entries(artifacts).every(([k, v]) => e.artifactIdentities?.[k] === v), 'STALE_EVIDENCE', `${stage} artifact identity changed`);
  requireThat(!Object.hasOwn(e, 'authorized'), 'AGENT_AUTHORITY_REJECTED', 'Agents cannot assert authorization');
  return e;
}


function successful(e, outcome) {
  requireThat(e.outcome === outcome, e.outcome === 'decision_required' || e.outcome === 'proposal_update_required' ? 'OWNER_DECISION_REQUIRED' : 'STAGE_BLOCKED', `${e.stage}: ${e.outcome}`);
  requireThat(e.blockingFindings.length === 0, 'STAGE_BLOCKED', `${e.stage} retains blocking findings`);
  requireThat(e.failureClass === undefined || e.failureClass === 'none', 'STAGE_BLOCKED', `${e.stage} claims success while retaining a failure classification`);
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

// No new serialized identity is introduced: the full v1 descriptor is still
// verified by workspace/evidence and used for custody, Hooks and Acceptance.
// Byte sizes required by the donor are read from the actual retained sources,
// never guessed or copied from an Agent-supplied descriptor.
export function assertCapturedCandidate(workspace,shapeBody,delivery) {
  const w=workspace,candidate=w.candidate,binding=delivery.binding;
  requireThat(same(delivery.inputs.candidate,candidate),'STALE_EVIDENCE','Delivery differs from captured Candidate');
  const manifests=sourceManifest(w.sources),inventory=w.metadata.inventory;
  const c={repository:w.metadata.binding.repository,base:candidate.base,tree:candidate.tree,
    diffHash:candidate.diff,paths:candidate.paths,obligations:inventory,
    artifacts:manifests.filter(m=>m.kind==='artifact'),hookSources:manifests.filter(m=>m.kind==='hook')};
  const shapeHash=digest(shapeBody),artifacts={candidateHash:digest(c),shapeHash};
  const projected={schemaVersion:1,stage:delivery.stage,subject:binding.issueId,...binding,
    executionId:delivery.execution.id,artifactIdentities:artifacts,
    outcome:delivery.result?.outcome,failureClass:delivery.result?.failureClass,
    evidenceReferences:[workspace.expected.identity],blockingFindings:[]};
  const issue={id:binding.issueId,repository:c.repository};
  candidateEvidence(issue,{candidate:c,shape:{body:shapeBody,bodyHash:shapeHash},delivery:projected},binding,false);
}
