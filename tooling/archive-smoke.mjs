import assert from 'node:assert/strict';
import { dynamicFixture } from './dynamic-fixture.mjs';
const df = dynamicFixture();
assert.equal((await df.evaluate()).outcome, 'ready');
df.edges.set('1', ['2']);
assert.equal((await df.evaluate()).outcome, 'waiting');
import { selectionFixture } from './selection-fixture.mjs';
const sf = selectionFixture();
const sd = await sf.select();
assert.equal(sd.outcome, sf.expected.outcome);
assert.equal(sd.memberId, sf.expected.memberId);
import { actionsFixture } from './actions-fixture.mjs';
const af = await actionsFixture();
const av = af.verifier();
const authenticated = await av.authenticate(await af.sign(), af.expected);
assert.equal(authenticated.ok, true);
assert.ok(
  import.meta
    .resolve('jose')
    .startsWith('file://' + process.cwd() + '/node_modules/jose/'),
);
assert.equal((await av.authenticate('invalid', af.expected)).ok, false);
assert.equal(av.predecessor({ source: authenticated, receipt: {} }).ok, false);
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  githubId,
  repositoryCoordinates,
  memberRunnerLabel,
  prepareGrant,
  signGrant,
  verifyGrant,
  createGithubProvider,
  observeRunners,
  parseCandidateObligations,
  validateCandidateFiles,
} from '@nibfin/core';
import { generateKeyPairSync } from 'node:crypto';
import {
  exportAuthority,
  importAuthority,
  authoritySnapshot,
  verifyAuthority,
  synchronizeAuthority,
} from '@nibfin/core';
import {
  skillForRole,
  parseStageResult,
  compareCompatibility,
  compareEvidence,
  createAuthorizationBoundary,
  bodyDigest,
} from '@nibfin/core';
const { createRepairFlow, invalidateRepairEvidence } = await import('@nibfin/core');
assert.equal(typeof createRepairFlow, 'function');
assert.equal(typeof invalidateRepairEvidence, 'function');
const { createAgentEnvironments, createAgentLifecycle } = await import(
  '@nibfin/core'
);
const { selectInstructions, createAssigneeSelector } = await import('@nibfin/core');
assert.equal(typeof createAssigneeSelector, 'function');
for (const skill of ['shape', 'deliver', 'accept']) {
  const selected = selectInstructions({ skill, role: skill });
  assert.equal(selected.identity, bodyDigest(selected.content));
  assert.equal(selected.source, 'builtin');
  const asset = new URL(
    '../skills/' + skill + '/SKILL.md',
    import.meta.resolve('@nibfin/core'),
  );
  assert.equal(
    selected.content,
    (await import('node:fs')).readFileSync(asset, 'utf8'),
  );
}

const { verifyDeployment, deploymentHealthDisposition } = await import(
  '@nibfin/core'
);
assert.equal(
  (
    await verifyDeployment({
      policy: { mode: 'not-applicable', reason: 'No obligation' },
    })
  ).status,
  'not-applicable',
);
assert.equal(
  (await verifyDeployment({ policy: { mode: 'required' } })).status,
  'blocked',
);
assert.equal(
  (
    await deploymentHealthDisposition({
      target: { issueId: 'I' },
      selectors: [],
      baselines: [],
      observations: [],
    })
  ).permission,
  false,
);
const registry = createAgentEnvironments();
const descriptor = {
  id: 'env',
  agent: 'fixture',
  loginSpace: '/fixture/login',
  instances: [
    {
      id: 'one',
      workspace: '/fixture/work',
      registration: '/fixture/reg',
      service: '/fixture/service',
    },
  ],
};
assert.equal(registry.describe(descriptor).agent, 'fixture');
assert.throws(() => registry.describe({ ...descriptor, agent: 'other' }));
assert.equal(typeof createAgentLifecycle, 'function');
assert.equal(skillForRole('shape-validator'), 'shape');
assert.throws(() => skillForRole('scope'));
assert.equal(
  parseStageResult({
    version: 1,
    outcome: 'ready',
    failureClass: 'none',
    summary: 'ok',
    conflicts: [],
  }).outcome,
  'ready',
);
assert.throws(() => compareCompatibility({ version: 99 }, { version: 99 }));
const digest = 'a'.repeat(64);
const evidence = {
  version: 1,
  stage: 'shape',
  binding: {
    authority: digest,
    grant: digest,
    policy: digest,
    core: digest,
    runtime: digest,
    instructions: digest,
    repositoryId: '42',
    issueId: 'I_1',
    scopeHash: digest,
    shapeHash: null,
  },
  execution: {
    role: 'shape',
    skill: 'shape',
    id: 'author',
    request: 'req',
    result: 'result',
    source: null,
  },
  inputs: { body: digest },
  result: {
    version: 1,
    outcome: 'ready',
    failureClass: 'none',
    summary: 'ok',
    conflicts: [],
  },
};
assert.deepEqual(
  compareEvidence(evidence, { expected: evidence, consumed: [] }),
  evidence,
);
const lifecycleEvidence = structuredClone(evidence);
lifecycleEvidence.binding.instructions = bodyDigest('approved');
const lifecycle = createAgentLifecycle({
  environment: registry.describe(descriptor),
  instanceId: 'one',
  current: () => ({ expected: lifecycleEvidence, consumed: [] }),
  backend: {
    readiness: async () => ({
      login: 'available',
      tool: 'available',
      isolation: 'verified',
      read: 'verified',
      write: 'verified',
      evidence: ['fixture'],
      limitations: [],
    }),
    start: async () => ({ status: 'started' }),
    collect: async () => ({
      status: 'complete',
      exitCode: 0,
      evidence: lifecycleEvidence,
    }),
    stop: async () => ({ status: 'requested' }),
    termination: async () => ({ status: 'terminated' }),
    cleanup: async () => ({ status: 'completed', residuals: [] }),
  },
});
const lifecycleInput = {
  execution: lifecycleEvidence.execution,
  binding: lifecycleEvidence.binding,
  instructions: { identity: bodyDigest('approved'), content: 'approved' },
  visibility: 'public',
  ownership: 'organization',
};
assert.equal((await lifecycle.start(lifecycleInput)).start.status, 'started');
assert.equal((await lifecycle.collect('author')).result.status, 'valid');
await assert.rejects(lifecycle.collect('author'));
await lifecycle.termination('author');
assert.equal((await lifecycle.cleanup()).status, 'completed');

assert.throws(() =>
  compareEvidence(evidence, { expected: evidence, consumed: ['result'] }),
);

assert.equal(githubId('9007199254740993'), '9007199254740993');
assert.equal(repositoryCoordinates('Example-Org', 'Core').key, 'example-org/core');
assert.equal(memberRunnerLabel('42'), 'nibfin-user-42');
assert.throws(() => githubId('01'), TypeError);
assert.equal(parseCandidateObligations('missing').ok, false);
const obligationBody = [
  'Candidate hooks applicability: No configured hooks.',
  '```nibfin-candidate',
  JSON.stringify({
    artifacts: [{ path: 'package.json', purpose: 'consumer' }],
    hooks: [],
  }),
  '```',
].join('\n');
const parsedObligations = parseCandidateObligations(obligationBody);
assert.equal(parsedObligations.ok, true);
assert.equal(
  validateCandidateFiles(parsedObligations.inventory, {
    root: process.cwd(),
    permittedPaths: ['package.json'],
  }).ok,
  true,
);
const providerCalls = [];
const providerContext = Object.freeze({ operation: 'close', target: '42' });
const provider = createGithubProvider({
  authorize: (r) =>
    r.context === providerContext && r.target === '42' && r.operation === 'close',
  transport: async (r) => {
    providerCalls.push(r);
    return { status: 200, headers: {}, body: '{"id":42}' };
  },
});
assert.equal(
  (
    await provider.request({
      endpoint: '/user',
      operation: 'user',
      correlation: 'smoke',
      target: '42',
    })
  ).data.id,
  '42',
);
assert.equal(
  (
    await provider.request({
      endpoint: '/repos/org/core/issues/1',
      method: 'PATCH',
      operation: 'close',
      correlation: 'smoke',
      target: '42',
      context: providerContext,
      body: { state: 'closed' },
    })
  ).outcome,
  'submitted',
);
assert.equal(providerCalls.length, 2);
assert.equal(providerCalls[1].headers['X-GitHub-Api-Version'], '2022-11-28');
assert.equal(providerCalls[1].headers.Accept, 'application/vnd.github+json');
assert.equal(providerCalls[1].body, JSON.stringify({ state: 'closed' }));
const runnerTarget = {
  owner: 'org',
  repository: 'core',
  id: '42',
  ownerId: '7',
  ownerType: 'Organization',
};
const runnerInput = {
  target: runnerTarget,
  registration: { level: 'repository', id: '42' },
  records: [
    {
      instanceId: 'one',
      runnerId: '91',
      memberId: '8',
      repositoryId: '42',
      platform: 'linux',
      registration: { level: 'repository', id: '42' },
    },
  ],
  conditions: { labels: ['self-hosted', 'linux'], platform: 'linux' },
  correlation: 'consumer',
};
const runnerProvider = createGithubProvider({
  transport: async (r) => {
    assert.equal(r.method, 'GET');
    const data =
      r.endpoint === '/repos/org/core'
        ? {
            id: '42',
            owner: { id: '7', type: 'Organization' },
            full_name: 'org/core',
            private: false,
            visibility: 'public',
          }
        : {
            total_count: 1,
            runners: [
              {
                id: '91',
                name: 'one',
                os: 'linux',
                status: 'online',
                busy: true,
                labels: ['self-hosted', 'Linux', 'nibfin-user-8'].map((name) => ({
                  name,
                  type: 'custom',
                })),
              },
            ],
          };
    return { status: 200, headers: {}, body: JSON.stringify(data) };
  },
});
assert.equal((await observeRunners(runnerProvider, runnerInput)).outcome, 'matched');
assert.equal(
  (
    await observeRunners(runnerProvider, {
      ...runnerInput,
      target: { ...runnerTarget, id: '01' },
    })
  ).outcome,
  'unavailable',
);

// Installed package boundary: actual provider responses, native CI success and failure.
const { observeGithubCI } = await import('@nibfin/core');
const ciExpected = {
  repository: 'example-org/core',
  repositoryId: '42',
  prId: '43',
  pr: 7,
  head: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  baseRepositoryId: '42',
  baseBranch: 'main',
};
let ciConclusion = 'success';
const ciProvider = createGithubProvider({
  transport: async (r) => {
    assert.equal(r.method, 'GET');
    const p = r.endpoint.slice('/repos/example-org/core'.length);
    const data =
      p === ''
        ? {
            id: 42,
            full_name: 'example-org/core',
            private: false,
            visibility: 'public',
            owner: { type: 'Organization' },
          }
        : p === '/pulls/7'
          ? {
              id: 43,
              number: 7,
              head: { sha: ciExpected.head },
              base: { sha: ciExpected.baseSha, ref: 'main', repo: { id: 42 } },
            }
          : p === '/branches/main'
            ? { name: 'main', protected: true, commit: { sha: ciExpected.baseSha } }
            : p === '/branches/main/protection'
              ? {
                  required_status_checks: {
                    strict: true,
                    contexts: ['build'],
                    checks: [{ context: 'build', app_id: 15368 }],
                  },
                }
              : p.startsWith('/commits/') && p.includes('/check-runs?')
                ? {
                    total_count: 1,
                    check_runs: [
                      {
                        id: 44,
                        name: 'build',
                        head_sha: ciExpected.head,
                        app: { id: 15368 },
                        status: 'completed',
                        conclusion: ciConclusion,
                      },
                    ],
                  }
                : p.startsWith('/rules/branches/') ||
                    p.endsWith('/statuses?per_page=100')
                  ? []
                  : null;
    assert.notEqual(data, null, 'Unexpected CI endpoint');
    return { status: 200, body: JSON.stringify(data) };
  },
});
assert.equal(
  (await observeGithubCI({ provider: ciProvider, expected: ciExpected })).qualifies,
  true,
);
ciConclusion = 'failure';
assert.equal(
  (await observeGithubCI({ provider: ciProvider, expected: ciExpected })).status,
  'failed',
);
const entry = realpathSync(fileURLToPath(import.meta.resolve('@nibfin/core')));
assert.equal(entry, process.cwd() + '/node_modules/@nibfin/core/src/index.mjs');
const input = JSON.parse((await import('node:fs')).readFileSync('grant-input.json'));
const { draft, summary } = prepareGrant(input);
assert.ok(summary.includes('DRAFT ONLY'));
const keys = generateKeyPairSync('ed25519');
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const grant = JSON.parse(
  JSON.stringify(signGrant(draft, { keyId: 'owner-1', privateKey })),
);
const context = {
  trustedKeys: new Map([['owner-1', publicKey]]),
  now: 1000,
  revocation: { id: draft.revocationId, available: true, revokedRecords: [] },
  expectedAuthority: draft.authority,
  expectedWork: draft.work,
  expectedPolicy: draft.policy,
  request: {
    repository: draft.work[0].repository,
    issueId: draft.work[0].issueId,
    number: draft.work[0].number,
    path: 'src/file.mjs',
    operation: 'deliver',
  },
};
assert.deepEqual(verifyGrant(grant, context), { ok: true, category: 'authorized' });
const authorization = createAuthorizationBoundary({
  now: () => 1100,
  maxCheckpointMs: 100,
  identity: 'hosted-authorized',
  getCheckpoint: () => ({
    request: context.request,
    grant,
    grantContext: context,
    member: { id: '42', login: 'member' },
    operator: {
      kind: 'service',
      id: 'app-1',
      source: 'hosted-authorized',
      trusted: true,
    },
    write: {
      method: 'PATCH',
      endpoint: '/repos/example-org/core/issues/101',
      target: '123',
    },
  }),
  transport: async (r) => ({
    status: 200,
    body: JSON.stringify(
      r.method === 'PATCH'
        ? { id: 123 }
        : r.endpoint === '/repos/example-org/core'
          ? {
              id: context.request.repository.id,
              full_name: 'example-org/core',
              private: false,
              visibility: 'public',
              owner: { login: 'example-org', type: 'Organization' },
            }
          : r.endpoint.endsWith('/issues/101')
            ? {
                id: 123,
                node_id: 'I_101',
                number: 101,
                repository_url: 'https://api.github.com/repos/example-org/core',
                assignees: [{ id: 42, login: 'member' }],
              }
            : r.endpoint.endsWith('/permission')
              ? { permission: 'write', user: { id: 42, login: 'member' } }
              : { id: 42, login: 'member' },
    ),
  }),
});
assert.equal((await authorization.eligibility()).ok, true);
assert.equal(
  (
    await authorization.request({
      method: 'PATCH',
      endpoint: '/repos/example-org/core/issues/101',
      target: '123',
      operation: 'deliver',
      correlation: 'smoke',
      body: { title: 'new' },
    })
  ).outcome,
  'submitted',
);
context.revocation.available = false;
assert.equal((await authorization.eligibility()).ok, false);
context.revocation.available = true;
const exported = exportAuthority({
  source: 'https://github.com/example-org/core/issues/101',
  revision: '1',
  approvalId: 'approval-1',
  cycle: 'cycle-1',
  components: [
    {
      id: 'section',
      kind: 'section',
      body: 'Hello\n世界',
      references: ['attachment'],
    },
    { id: 'attachment', kind: 'attachment', body: 'AAEC', references: [] },
  ],
});
const approvedPayload = { ...draft, authority: authoritySnapshot(exported) };
const approvedGrant = signGrant(approvedPayload, { keyId: 'owner-1', privateKey });
const verification = {
  grant: approvedGrant,
  grantContext: { ...context, expectedAuthority: approvedPayload.authority },
  expected: {
    source: exported.source,
    revision: '1',
    approvalId: 'approval-1',
    cycle: 'cycle-1',
  },
};
const imported = importAuthority(JSON.stringify(exported));
const verified = verifyAuthority(imported, verification);
assert.equal(verified.ok, true);
const nextExport = exportAuthority({
  ...verification.expected,
  revision: '2',
  cycle: 'cycle-2',
  approvalId: 'approval-2',
  components: exported.components,
});
const nextPayload = { ...draft, authority: authoritySnapshot(nextExport) };
const nextVerification = {
  grant: signGrant(nextPayload, { keyId: 'owner-1', privateKey }),
  grantContext: { ...context, expectedAuthority: nextPayload.authority },
  expected: {
    source: exported.source,
    revision: '2',
    approvalId: 'approval-2',
    cycle: 'cycle-2',
  },
};
const transition = synchronizeAuthority({
  active: verified.binding,
  expectedPrevious: verified.binding,
  replacement: nextExport,
  verification: nextVerification,
  authorization: {
    previousIdentity: exported.identity,
    replacementIdentity: nextExport.identity,
    cycle: 'cycle-2',
  },
});
assert.equal(transition.status, 'replaced');
assert.equal(verifyAuthority(imported, nextVerification).ok, false);
assert.equal(verifyGrant(approvedGrant, nextVerification.grantContext).ok, false);
context.request.operation = 'merge';
assert.deepEqual(verifyGrant(grant, context), { ok: false, category: 'operation' });
const { custodyFixture } = await import('./custody-fixture.mjs');
const custodyTest = custodyFixture();
const retained = await custodyTest.publish();
assert.equal(retained.outcome, 'retained');
custodyTest.payloads.clear();
const recovered = await custodyTest
  .fresh()
  .retrieve({ ref: retained.ref, expected: custodyTest.expected });
assert.equal(recovered.outcome, 'retrieved');
assert.deepEqual(
  recovered.payloads.get('out/ignored.bin'),
  Buffer.from([0, 255, 1, 128]),
);
assert.equal(
  (
    await custodyTest
      .fresh()
      .retrieve({
        ref: retained.ref,
        expected: { ...custodyTest.expected, attempt: '2' },
      })
  ).outcome,
  'failed',
);
if (process.argv.includes('--release')) {
  const { verifyRelease, releaseComponents, workflowInstallation } = await import(
    '@nibfin/core'
  );
  const fs = await import('node:fs');
  const releaseManifest = JSON.parse(fs.readFileSync('release-manifest.json'));
  const compatibilityBytes = fs.readFileSync('compatibility.json');
  verifyRelease({
    manifest: releaseManifest,
    compatibility: JSON.parse(compatibilityBytes),
    compatibilityBytes,
    archive: fs.readFileSync('nibfin-core.tgz'),
    expectedVersion: releaseManifest.version,
    expectedSource: releaseManifest.source,
  });
  assert.deepEqual(releaseComponents(), releaseManifest.components);
  const installation = workflowInstallation({
    commit: 'a'.repeat(40),
    hostCommit: 'b'.repeat(40),
    hostRepository: 'taco3064/nibfin',
  });
  assert.equal(installation.coreVersion, releaseManifest.version);
  assert.ok(installation.files.size > 0);
  assert.throws(() =>
    verifyRelease({
      manifest: releaseManifest,
      compatibility: JSON.parse(compatibilityBytes),
      compatibilityBytes,
      archive: fs.readFileSync('nibfin-core.tgz'),
      expectedVersion: '9.9.9',
      expectedSource: releaseManifest.source,
    }),
  );
  console.log(
    'Installed release identities, exact pin rejection and workflow installation passed',
  );
}

console.log(
  'Installed archive consumer passed (real Grant signatures and rejection):',
  entry,
);
