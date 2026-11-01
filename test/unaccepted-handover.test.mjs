import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  bodyDigest,
  contentIdentity,
  signGrant,
  unacceptedHandoverPolicy,
  verifyUnacceptedHandover,
  createUnacceptedHandoverEvidence,
  checkUnacceptedHandoverFrame,
  verifyUnacceptedHandoverRevision,
} from '../src/index.mjs';
import { grantFixture, grantContext } from '../tooling/grant-fixture.mjs';

const keys = generateKeyPairSync('ed25519');
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });

function fixture() {
  const payload = grantFixture(bodyDigest);
  payload.policy.core = 'd'.repeat(64);
  payload.policy.runtime = 'c'.repeat(64);
  payload.work = payload.work.slice(0, 1);
  const work = payload.work[0];
  const target = {
    repository: work.repository.name,
    issueId: work.issueId,
    number: work.number,
  };
  const snapshot = {
    version: 1,
    memberId: '42',
    role: 'deliver',
    session: '00000000-0000-4000-8000-000000000001',
    execution: 'original-writer',
    adapter: 'codex',
    files: [{ path: 'original.jsonl', bytes: 'e30K', digest: '1'.repeat(64) }],
  };
  const original = {
    version: 1,
    kind: 'native-legacy-unaccepted-custody',
    status: 'UNACCEPTED',
    archive: '1'.repeat(64),
    state: '2'.repeat(64),
    originalScope: '3'.repeat(64),
    originalShape: '4'.repeat(64),
    conversation: '5'.repeat(64),
    target,
    memberId: '42',
    repairs: 2,
    session: snapshot.session,
    execution: snapshot.execution,
    snapshot: {
      ...snapshot,
      digest: contentIdentity(snapshot),
      terminated: true,
    },
    workspaceSnapshot: {
      kind: 'native-unaccepted-workspace',
      status: 'UNACCEPTED',
      execution: { id: snapshot.execution },
      entries: [],
      bytes: 0,
    },
  };
  const shapeBody =
    'Original Shape\n\n```kairo-candidate\n' + '{"artifacts":[],"hooks":[]}\n```';
  original.originalShape = bodyDigest(shapeBody);
  const record = (stage, outcome, id) => ({
    stage,
    outcome,
    failureClass: 'none',
    subject: target.issueId,
    executionId: id,
    resultHash: contentIdentity({ stage }),
    artifactIdentities: {
      scopeHash: original.originalScope,
      shapeHash: original.originalShape,
    },
  });
  original.shape = {
    body: shapeBody,
    bodyHash: original.originalShape,
    author: record('shape', 'ready', 'original-author'),
    validator: record('shape-validator', 'approved', 'original-validator'),
    publication: {
      bodyHash: original.originalShape,
      scopeHash: original.originalScope,
      decisionId: '6'.repeat(64),
    },
  };
  const current = {
    target,
    memberId: '42',
    scopeHash: work.scope.hash,
    core: payload.policy.core,
    labels: 'e'.repeat(64),
    workflow: 'shaped',
    authority: 'e'.repeat(64),
    cycle: 'fresh-native-cycle',
  };
  payload.recordId = unacceptedHandoverPolicy({ original, current }).recordId;
  const grant = signGrant(payload, { keyId: 'owner-1', privateKey });
  const context = grantContext(payload, publicKey);
  return { original, current, grant, context };
}

test('handover repeats independent gates and retains original budget/session', () => {
  const f = fixture();
  const before = structuredClone(f.original);
  const plan = verifyUnacceptedHandover(f);
  assert.equal(plan.next, 'deliver');
  assert.equal(plan.requiresFreshShape, false);
  assert.equal(plan.repairs, 2);
  assert.equal(plan.session, before.session);
  assert.deepEqual(plan.retainedStages, ['shape', 'shape-validator', 'publication']);
  for (const stage of ['accept', 'ci', 'merge', 'final', 'closure', 'delivered'])
    assert.ok(plan.repeatedStages.includes(stage));
  assert.deepEqual(f.original, before);
});

function revisionFixture() {
  const f = fixture();
  const saved = createUnacceptedHandoverEvidence(f);
  const body = {
    ...saved,
    scopeBody: f.grant.payload.work[0].scope.body,
    cycle: f.current.cycle,
    attempts: {},
    operations: {},
    operationBlobs: {},
    completions: {},
    completionBlobs: {},
    publications: {},
    dispatch: null,
    candidate: null,
    workspace: null,
    head: null,
    ci: null,
    completion: null,
    stageInput: null,
    closed: false,
    deferredRoles: {
      deliver: { phase: 'prepared', target: { session: f.original.session } },
    },
  };
  const state = { ...body, identity: contentIdentity(body) };
  return {
    previous: { ...f, state },
    original: f.original,
    current: { ...f.current, core: 'a'.repeat(64), predecessor: state.identity },
  };
}

test('pre-execution reapproval preserves cycle, Writer and spent donor budget', () => {
  const f = revisionFixture();
  const before = structuredClone(f.previous);
  const result = verifyUnacceptedHandoverRevision(f);
  assert.equal(result.previous, before.state.identity);
  assert.equal(result.session, f.original.session);
  assert.equal(result.repairs, 2);
  assert.equal(result.cycle, before.current.cycle);
  assert.deepEqual(f.previous, before);
});

test('revision cannot erase an execution, write intent or changed requirements', () => {
  for (const change of [
    (f) => {
      f.previous.state.attempts.deliver = { phase: 'unresolved' };
    },
    (f) => {
      f.previous.state.operations.intent = { phase: 'prepared' };
    },
    (f) => {
      f.previous.state.dispatch = { runId: '1' };
    },
    (f) => {
      f.previous.state.deferredRoles.deliver.phase = 'running';
    },
    (f) => {
      f.current.scopeHash = 'b'.repeat(64);
    },
    (f) => {
      f.current.core = f.previous.current.core;
    },
    (f) => {
      f.original = { ...f.original, repairs: 0 };
    },
  ]) {
    const f = revisionFixture();
    change(f);
    const { identity, ...body } = f.previous.state;
    f.previous.state.identity = contentIdentity(body);
    f.current.predecessor = f.previous.state.identity;
    assert.throws(() => verifyUnacceptedHandoverRevision(f));
  }
});

test('retained Shape is explicit history and cannot be rewritten or reattributed', () => {
  const f = fixture();
  const saved = createUnacceptedHandoverEvidence(f);
  const frame = {
    ...saved,
    evidenceCurrent: saved.expectations,
    scopeBody: f.grant.payload.work[0].scope.body,
    cycle: f.current.cycle,
  };
  checkUnacceptedHandoverFrame(f, frame);
  assert.equal(
    saved.receipts.shape.execution.id,
    f.original.shape.author.executionId,
  );
  assert.equal(saved.receipts.shape.execution.source, null);
  assert.equal(saved.receipts.shape.retained.scopeHash, f.original.originalScope);
  saved.receipts.shape.execution.source = {
    repositoryId: '1',
    workflow: '1'.repeat(64),
    runId: '1',
    attempt: '1',
  };
  assert.throws(() => checkUnacceptedHandoverFrame(f, frame), /historical-rewrite/);
  f.current.workflow = 'scope';
  assert.throws(() => createUnacceptedHandoverEvidence(f));
});

test('old evidence and a self-approved key cannot authorize imported work', () => {
  const f = fixture();
  const other = generateKeyPairSync('ed25519');
  f.grant = signGrant(f.grant.payload, {
    keyId: 'owner-1',
    privateKey: other.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
  assert.throws(() => verifyUnacceptedHandover(f), /current-owner-approval/);
  const old = fixture();
  old.grant.payload.recordId = 'old-cycle';
  assert.throws(() => verifyUnacceptedHandover(old), /current-owner-approval/);
});

test('mutated conversation, member, source and budget require new approval', () => {
  for (const mutate of [
    (f) => {
      f.original.snapshot.files[0].bytes = 'changed';
    },
    (f) => {
      f.original.snapshot.terminated = false;
    },
    (f) => {
      f.current.memberId = '99';
    },
    (f) => {
      f.original.workspaceSnapshot.execution.id = 'other';
    },
    (f) => {
      f.original.repairs = 0;
    },
    (f) => {
      f.original.state = '9'.repeat(64);
    },
    (f) => {
      f.current.scopeHash = 'a'.repeat(64);
    },
    (f) => {
      f.current.core = 'b'.repeat(64);
    },
    (f) => {
      f.current.labels = 'f'.repeat(64);
    },
    (f) => {
      f.current.target.number = '999';
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => verifyUnacceptedHandover(f));
  }
});

test('revoked current authority remains denied for retained work', () => {
  const f = fixture();
  f.context.revocation.revokedRecords.push(f.grant.payload.recordId);
  assert.throws(() => verifyUnacceptedHandover(f), /current-owner-approval/);
});
