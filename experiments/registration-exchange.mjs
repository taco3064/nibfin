// Offline research only: adapters are synthetic, not a production trust boundary.
import { createPublicKey, generateKeyPairSync, diffieHellman, hkdfSync, randomBytes,
  createCipheriv, createDecipheriv, sign, verify, createHash } from 'node:crypto';
const encode = value => Buffer.from(JSON.stringify(value));
const fail = () => { throw new Error('Registration exchange rejected.'); };
const fingerprint = key => createHash('sha256').update(key).digest('hex');
export const memberKeys = () => generateKeyPairSync('x25519');
export const ownerKeys = () => generateKeyPairSync('ed25519');
export const publicText = key => key.export({ type: 'spki', format: 'pem' }).toString();
function publicKey(text) {
  if (typeof text !== 'string' || text.length > 256) fail();
  const key = createPublicKey(text);
  if (key.asymmetricKeyType !== 'x25519' || publicText(key) !== text) fail();
  // Reject low-order X25519 inputs before the issuer can be invoked.
  const probe = diffieHellman({ privateKey: memberKeys().privateKey, publicKey: key });
  probe.fill(0);
  return key;
}
const context = r => ({ version: 1, id: r.id, nonce: r.nonce, userId: r.userId,
  repositoryId: r.repositoryId, publicKey: r.publicKey, created: r.created, deadline: r.deadline,
  workflow: r.workflow, revision: r.revision, runId: r.runId, attempt: r.attempt });
function derive(privateKey, peer, salt, aad) {
  const shared = diffieHellman({ privateKey, publicKey: peer });
  try { return Buffer.from(hkdfSync('sha256', shared, salt, aad, 32)); }
  finally { shared.fill(0); }
}
function seal(r, payload, signingKey) {
  const ephemeral = memberKeys(), salt = randomBytes(32), iv = randomBytes(12);
  const header = { construction: 'nibfin-research-x25519-hkdf-sha256-aes256gcm-ed25519-v1',
    context: context(r), ephemeral: publicText(ephemeral.publicKey), salt: salt.toString('base64'), iv: iv.toString('base64') };
  const aad = encode(header), key = derive(ephemeral.privateKey, publicKey(r.publicKey), salt, aad);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    const plaintext = encode(payload);
    let ciphertext;
    try { ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]); }
    finally { plaintext.fill(0); }
    const envelope = { header, ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
    return { ...envelope, signature: sign(null, encode(envelope), signingKey).toString('base64') };
  } finally { key.fill(0); }
}
export function openResponse(response, request, privateKey, trustedOwnerKey, now) {
  try {
    const { signature, ...envelope } = response;
    if (!verify(null, encode(envelope), trustedOwnerKey, Buffer.from(signature, 'base64'))) fail();
    const { header, ciphertext, tag } = envelope;
    if (header.construction !== 'nibfin-research-x25519-hkdf-sha256-aes256gcm-ed25519-v1' ||
        JSON.stringify(header.context) !== JSON.stringify(context(request)) || now >= request.deadline ||
        publicText(createPublicKey(privateKey)) !== request.publicKey) fail();
    const aad = encode(header), key = derive(privateKey, publicKey(header.ephemeral), Buffer.from(header.salt, 'base64'), aad);
    let plaintext;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
      decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(tag, 'base64'));
      plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
      const payload = JSON.parse(plaintext.toString());
      if (JSON.stringify(payload.context) !== JSON.stringify(context(request)) ||
          !Number.isSafeInteger(payload.issued) || payload.issued > now + 5000 ||
          !Number.isSafeInteger(payload.expires) || payload.expires <= now || payload.expires <= payload.issued ||
          typeof payload.token !== 'string' || !payload.token) fail();
      return payload;
    } finally { key.fill(0); plaintext?.fill(0); }
  } catch { fail(); }
}
export function experimentHost({ now, observe, issue, signingKey, trust }) {
  // Atomic only inside one JS process. Both indexes are reserved before any await.
  const ids = new Map(), nonces = new Set();
  function valid(r) {
    for (const k of ['id', 'nonce', 'userId', 'repositoryId', 'workflow', 'revision', 'runId']) {
      if (typeof r[k] !== 'string' || !/^[a-zA-Z0-9_./:-]{1,128}$/.test(r[k])) fail();
    }
    if (r.scope !== 'repository' || !Number.isSafeInteger(r.attempt) || r.attempt < 1 ||
        !Number.isSafeInteger(r.created) || !Number.isSafeInteger(r.deadline) ||
        r.created > now() + 5000 || r.deadline <= now() || r.deadline <= r.created ||
        r.deadline - r.created > 60000) fail();
    publicKey(r.publicKey);
  }
  async function authorize(r, signal) {
    let timer, abort, o;
    try {
      o = await Promise.race([Promise.resolve().then(() => observe(structuredClone(r))), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Deadline reached.')), Math.max(1, r.deadline - now()));
        abort = () => reject(new Error('Cancelled.'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      })]);
    } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
    if (!o || o.status !== 200 || o.identityStatus !== 200 || o.permissionStatus !== 200 ||
        o.policy !== true || o.userId !== r.userId || o.actorId !== r.userId ||
        o.repositoryId !== r.repositoryId || !['write', 'maintain', 'admin'].includes(o.permission) ||
        o.keyFingerprint !== fingerprint(r.publicKey) || o.requestFingerprint !== fingerprint(encode(r)) ||
        o.workflow !== trust.workflow || o.revision !== trust.revision || o.source !== 'protected-owner' ||
        r.workflow !== o.workflow || r.revision !== o.revision || o.runId !== r.runId || o.attempt !== r.attempt) fail();
  }
  return {
    async exchange(input, signal) {
      let r, record;
      try {
        r = structuredClone(input); valid(r);
        if (ids.has(r.id) || nonces.has(r.nonce)) fail();
        record = { state: 'reserved', attempted: false }; ids.set(r.id, record); nonces.add(r.nonce);
        await authorize(r, signal);
        await authorize(r, signal); // fresh read immediately before modeled issuance boundary
        valid(r); if (signal?.aborted) fail();
        record.attempted = true; record.state = 'issuing';
        let timer, abort;
        let result;
        try {
          result = await Promise.race([Promise.resolve().then(issue), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Deadline reached.')), Math.max(1, r.deadline - now()));
            abort = () => reject(new Error('Cancelled.'));
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
          })]);
        } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
        if (signal?.aborted || now() >= r.deadline) fail();
        if (!result || typeof result.token !== 'string' || !result.token ||
            !Number.isSafeInteger(result.expires) || result.expires <= now()) fail();
        const response = seal(r, { context: context(r), issued: now(), expires: result.expires, token: result.token }, signingKey);
        if (signal?.aborted || now() >= r.deadline) fail();
        record.state = 'complete'; return { status: 'encrypted', response };
      } catch {
        if (record) record.state = record.attempted ? 'unknown' : 'rejected';
        return { status: record?.state ?? 'rejected' };
      }
    },
    state: id => ids.get(id)?.state,
    reconcile(id, evidence) {
      const record = ids.get(id);
      // Synthetic trusted reconciliation: no recovered token and no retry permission.
      if (record?.state !== 'unknown' || evidence?.outcome !== 'expired' ||
          !Number.isSafeInteger(evidence.expires) || now() < evidence.expires || evidence.verified !== true) fail();
      record.state = 'expired';
    }
  };
}
export const requestFingerprint = r => fingerprint(encode(r));
export const keyFingerprint = fingerprint;
