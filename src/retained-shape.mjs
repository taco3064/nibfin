import { bodyDigest } from './canonical.mjs';
import { contentIdentity, createEvidence } from './evidence.mjs';
import { parseCandidateObligations } from './obligations.mjs';

const need = (ok, reason) => {
  if (!ok) throw Error('unaccepted-handover:' + reason);
};

// A format adapter, not a new Shape verdict. Original bytes and records stay in
// the signed custody proof; every derived receipt explicitly names that proof.
export function inspectRetainedShape(original) {
  const shape = original.shape;
  need(
    typeof shape?.body === 'string' &&
      bodyDigest(shape.body) === original.originalShape &&
      shape.bodyHash === original.originalShape,
    'original-shape',
  );
  const { author, validator, publication } = shape;
  for (const [record, stage, outcome] of [
    [author, 'shape', 'ready'],
    [validator, 'shape-validator', 'approved'],
  ])
    need(
      record?.stage === stage &&
        record.outcome === outcome &&
        record.failureClass === 'none' &&
        record.subject === original.target.issueId &&
        typeof record.executionId === 'string' &&
        /^[a-f0-9]{64}$/.test(record.resultHash) &&
        record.artifactIdentities?.scopeHash === original.originalScope &&
        record.artifactIdentities?.shapeHash === original.originalShape,
      'original-shape-verdict',
    );
  need(
    author.executionId !== validator.executionId &&
      publication?.bodyHash === original.originalShape &&
      publication.scopeHash === original.originalScope &&
      /^[a-f0-9]{64}$/.test(publication.decisionId),
    'original-shape-publication',
  );
  let body = shape.body;
  if (!parseCandidateObligations(body).ok) {
    const blocks = [...body.matchAll(/^```kairo-candidate\r?\n(.*?)^```/gms)];
    need(blocks.length === 1, 'legacy-inventory');
    const inventory = JSON.parse(blocks[0][1]);
    body = body.replace(/^```kairo-candidate$/m, '```nibfin-candidate');
    for (const kind of ['artifacts', 'hooks'])
      if (Array.isArray(inventory[kind]) && inventory[kind].length === 0)
        body +=
          '\n\nCandidate ' +
          kind +
          ' applicability: Retained explicit empty ' +
          'inventory from original Shape ' +
          original.originalShape +
          '; recheck current source before accepting any Candidate.';
  }
  need(parseCandidateObligations(body).ok, 'retained-inventory');
  return body;
}

export function retainedShapeEvidence({ original, current, grant, identity }) {
  const shapeBody = inspectRetainedShape(original);
  const receipts = {},
    expectations = {};
  const binding = {
    authority: current.authority,
    grant: contentIdentity(grant),
    policy: contentIdentity(grant.payload.policy),
    core: current.core,
    runtime: grant.payload.policy.runtime,
    repositoryId: grant.payload.work[0].repository.id,
    issueId: current.target.issueId,
    scopeHash: current.scopeHash,
    shapeHash: bodyDigest(shapeBody),
  };
  const shape = original.shape;
  for (const stage of ['shape', 'shape-validator', 'publication']) {
    const record =
      stage === 'shape'
        ? shape.author
        : stage === 'shape-validator'
          ? shape.validator
          : shape.publication;
    const source = contentIdentity(record);
    const machine = stage === 'publication';
    const expected = {
      version: 1,
      stage,
      binding: { ...binding, instructions: contentIdentity(record.skill ?? record) },
      execution: {
        id: machine ? 'retained-publication:' + source : record.executionId,
        request: 'retained-record:' + source,
        result: 'retained-result:' + (record.resultHash ?? source),
        role: machine ? 'shape' : stage,
        skill: 'shape',
        source: null,
      },
      inputs: {
        body: binding.shapeHash,
        ...(stage === 'shape' ? {} : { author: shape.author.executionId }),
        ...(machine
          ? {
              validator: shape.validator.executionId,
              validation: contentIdentity(receipts['shape-validator']),
              readback: contentIdentity(shape.publication),
            }
          : {}),
      },
      result: machine
        ? null
        : {
            version: 1,
            outcome: record.outcome,
            failureClass: 'none',
            summary: 'Retained historical verdict; no new role execution.',
            conflicts: [],
          },
      retained: {
        version: 1,
        handover: identity,
        record: source,
        scopeHash: original.originalScope,
        shapeHash: original.originalShape,
      },
    };
    expectations[stage] = { expected, consumed: [] };
    receipts[stage] = createEvidence(expectations[stage]);
  }
  return { shapeBody, receipts, expectations };
}
