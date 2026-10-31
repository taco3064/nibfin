// Synthetic signed contract fixture; never a live handover or completion proof.
import { generateKeyPairSync } from 'node:crypto';
import { grantFixture, grantContext } from './grant-fixture.mjs';
import { chain, fixture, h, g } from './evidence-fixture.mjs';
import {
  bodyDigest,
  contentIdentity,
  signGrant,
  exportAuthority,
  authoritySnapshot,
  coreStages,
  prepareMergedContinuation,
} from '../src/index.mjs';
const deliveryStages = coreStages.slice(0, coreStages.indexOf('fanout'));

export function mergedContinuationFixture() {
  const keys = () => {
    const value = generateKeyPairSync('ed25519');
    return {
      privateKey: value.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      publicKey: value.publicKey.export({ type: 'spki', format: 'pem' }),
    };
  };
  const previous = keys(),
    owner = keys();
  const payload = grantFixture(bodyDigest);
  payload.policy.core = h('d');
  payload.policy.runtime = h('e');
  payload.policy.repair = { mode: 'bounded', maxRepairs: 3 };
  payload.permissions[0].operations = [
    ...deliveryStages,
    'readiness',
    'verify-deployment',
    'close',
    'mark-delivered',
    'label',
    'dispatch',
    'fanout',
  ];
  const work = payload.work[0];
  const authority = exportAuthority({
    source: 'https://github.com/example-org/core/issues/101',
    revision: '1',
    approvalId: 'owner-1',
    cycle: 'original-cycle',
    components: [
      { id: 'scope', kind: 'section', body: work.scope.body, references: [] },
    ],
  });
  payload.authority = authoritySnapshot(authority);
  const grant = signGrant(payload, {
    keyId: 'owner-1',
    privateKey: previous.privateKey,
  });
  const binding = {
    authority: authority.identity,
    grant: contentIdentity(grant),
    policy: contentIdentity(payload.policy),
    core: payload.policy.core,
    runtime: payload.policy.runtime,
    instructions: h('f'),
    repositoryId: work.repository.id,
    issueId: work.issueId,
    scopeHash: bodyDigest(work.scope.body),
    shapeHash: bodyDigest('published shape'),
  };
  const all = chain(false, false, (receipts) => {
    for (const [stage, receipt] of Object.entries(receipts)) {
      receipt.binding = structuredClone(binding);
      receipt.execution.request = 'request-' + stage;
    }
    receipts.ci.inputs.policy = binding.policy;
  }).receipts;
  const author = fixture('shape'),
    validator = fixture('shape-validator');
  Object.assign(author, {
    binding: { ...binding, shapeHash: null },
    inputs: { body: binding.shapeHash },
  });
  Object.assign(author.execution, { id: 'author', request: 'author-request' });
  Object.assign(validator, {
    binding: structuredClone(binding),
    inputs: { body: binding.shapeHash, author: 'author' },
  });
  Object.assign(validator.execution, {
    id: 'validator',
    request: 'validator-request',
  });
  const stages = deliveryStages.slice(0, deliveryStages.indexOf('merge') + 1);
  const receipts = Object.fromEntries(
    stages.map((s) => [
      s,
      s === 'shape' ? author : s === 'shape-validator' ? validator : all[s],
    ]),
  );
  const expectations = Object.fromEntries(
    Object.entries(receipts).map(([s, expected]) => [
      s,
      { expected: structuredClone(expected), consumed: [] },
    ]),
  );
  const target = {
    repository: work.repository.name,
    repositoryId: work.repository.id,
    issueId: work.issueId,
    databaseId: '1010',
    number: work.number,
  };
  const parent = {
    state: h('3'),
    archive: h('4'),
    cycle: 'original-cycle',
    target,
    memberId: '7',
    ownerKey: { id: 'owner-1', publicKey: previous.publicKey },
    grant,
    policy: payload.policy,
    authority,
    scopeBody: work.scope.body,
    shapeBody: 'published shape',
    receipts,
    expectations,
    revocation: { id: payload.revocationId, available: true, revokedRecords: [] },
  };
  const execution = {
    core: h('1'),
    source: g('f'),
    activation: h('2'),
    memberId: '7',
    keyId: 'new-owner',
    validFrom: 1100,
    expiresAt: 1900,
  };
  const draft = prepareMergedContinuation(parent, execution).draft;
  const approve = (p = draft) =>
    signGrant(p, {
      keyId: execution.keyId,
      privateKey: owner.privateKey,
    });
  const context = grantContext(draft, owner.publicKey);
  context.trustedKeys = new Map([[execution.keyId, owner.publicKey]]);
  context.now = 1200;
  context.request.operation = 'verify-deployment';
  const plan = {
    target,
    cycle: parent.cycle,
    visibility: 'public',
    ownership: 'organization',
    binding,
    scopeBody: parent.scopeBody,
    shapeBody: parent.shapeBody,
    receipts: structuredClone(receipts),
    evidenceCurrent: structuredClone(expectations),
    candidate: receipts.deliver.inputs.candidate,
    base: receipts.pr.inputs.base,
    head: receipts.pr.inputs.head,
    completion: null,
    transition: null,
    prior: null,
    stageInput: null,
    selectionInput: null,
    dependencyInput: null,
    operationIdentity: null,
    ciIdentity: null,
  };
  return { parent, execution, context, approve, plan, all, draft };
}
