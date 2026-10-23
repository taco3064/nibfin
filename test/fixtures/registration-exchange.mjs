import { experimentHost, memberKeys, ownerKeys, publicText, requestFingerprint, keyFingerprint } from '../../experiments/registration-exchange.mjs';
export function registrationFixture() {
  let time = 100000, calls = 0, reads = 0;
  const member = memberKeys(), owner = ownerKeys();
  const request = { id: 'request-1', nonce: 'nonce-1', scope: 'repository', userId: '1001', repositoryId: '2001',
    publicKey: publicText(member.publicKey), created: time, deadline: time + 60000,
    workflow: '.github/workflows/registration.yml', revision: 'synthetic-fixed-version', runId: '3001', attempt: 1 };
  const observation = { status: 200, identityStatus: 200, permissionStatus: 200, policy: true,
    userId: '1001', actorId: '1001', repositoryId: '2001', permission: 'write',
    keyFingerprint: keyFingerprint(request.publicKey), requestFingerprint: requestFingerprint(request),
    workflow: request.workflow, revision: request.revision, runId: request.runId, attempt: 1, source: 'protected-owner' };
  const f = { member, owner, request, observation, token: 'SYNTHETIC-REGISTRATION-TOKEN-ONLY',
    now: () => time, setTime: n => { time = n; }, calls: () => calls, reads: () => reads,
    beforeRead: () => {}, issuer: async () => ({ token: f.token, expires: time + 3600000 }),
    bind: () => { observation.requestFingerprint = requestFingerprint(request); observation.keyFingerprint = keyFingerprint(request.publicKey); } };
  f.host = experimentHost({ now: f.now, trust: { workflow: request.workflow, revision: request.revision },
    signingKey: owner.privateKey, observe: async () => { await f.beforeRead(++reads); return structuredClone(observation); },
    issue: async () => { calls++; return f.issuer(); } });
  return f;
}
