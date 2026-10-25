import {createPublicKey, publicEncrypt, privateDecrypt, randomBytes, createCipheriv, createDecipheriv, constants, createHash} from 'node:crypto';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGithubProvider, publicDiagnostic} from './provider.mjs';
import {readCustodyZip} from './custody-zip.mjs';

const id = v => typeof v === 'string' && /^[1-9][0-9]*$/.test(v);
const word = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v);
const login = v => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(v);
const fail = () => {throw Error('registration:invalid');};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const future = (expiry, now) => typeof expiry === 'string' && Number.isFinite(Date.parse(expiry)) && Date.parse(expiry) > now();
function keyInfo(pem) {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) fail();
  return {key, fingerprint: createHash('sha256').update(key.export({type:'spki', format:'der'})).digest('hex')};
}
function context(c) {
  if (!c || !word(c.requestId) || !id(c.requesterId) || !id(c.repositoryId)
      || !id(c.runId) || !id(c.attempt) || !/^[a-f0-9]{64}$/.test(c.recipient)
      || !/^[a-z0-9-]+\/[a-z0-9_.-]+$/.test(c.repository)
      || !['repository','organization'].includes(c.level) || !id(c.registrationId)) fail();
  return {requestId:c.requestId, requesterId:c.requesterId, repository:c.repository,
    repositoryId:c.repositoryId, level:c.level, registrationId:c.registrationId,
    runId:c.runId, attempt:c.attempt, recipient:c.recipient};
}
function protect(payload, pem, binding) {
  const {key, fingerprint} = keyInfo(pem);
  if (fingerprint !== binding.recipient) fail();
  const secret = randomBytes(32), iv = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', secret, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(binding)));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
    return Buffer.from(JSON.stringify({version:1, context:binding, iv:iv.toString('base64'),
      key:publicEncrypt({key, oaepHash:'sha256', padding:constants.RSA_PKCS1_OAEP_PADDING}, secret).toString('base64'),
      tag:cipher.getAuthTag().toString('base64'), ciphertext:encrypted.toString('base64')}));
  } finally {secret.fill(0);}
}
/** Only the requesting member consumes this result; never log its successful value. */
export function openRegistrationResponse(bytes, {privateKey, expected, now = Date.now}) {
  let secret;
  try {
    if (bytes.byteLength > 65536) fail();
    const e = JSON.parse(Buffer.from(bytes).toString()), binding = context(expected);
    if (e.version !== 1 || !equal(e.context, binding) || keyInfo(privateKey).fingerprint !== binding.recipient) fail();
    secret = privateDecrypt({key:privateKey, oaepHash:'sha256', padding:constants.RSA_PKCS1_OAEP_PADDING}, Buffer.from(e.key,'base64'));
    const decipher = createDecipheriv('aes-256-gcm', secret, Buffer.from(e.iv,'base64'));
    decipher.setAAD(Buffer.from(JSON.stringify(binding))); decipher.setAuthTag(Buffer.from(e.tag,'base64'));
    const p = JSON.parse(Buffer.concat([decipher.update(Buffer.from(e.ciphertext,'base64')), decipher.final()]).toString());
    if (!equal(p.context, binding) || typeof p.token !== 'string' || !p.token || !future(p.expires_at, now)
        || p.url !== `https://github.com/${binding.level === 'repository' ? binding.repository : binding.repository.split('/')[0]}`) fail();
    return {outcome:'available', token:p.token, expires_at:p.expires_at, url:p.url, context:binding};
  } catch {return {outcome:'unavailable', diagnostic:{kind:'invalid_or_expired_response'}};}
  finally {secret?.fill(0);}
}

/** Standard Actions artifact channel. Client is the official single-attempt upload
 * capability; reader is a fresh REST/binary read capability. Only ciphertext touches disk.
 */
export function createRegistrationArtifactChannel({client, read, runtime, now = Date.now,
  remove = path => rm(path, {recursive:true, force:true})}) {
  return Object.freeze({async publish({bytes, binding, expires_at, signal}) {
    let root, submitted = false, ref, result, pending;
    try {
      binding = context(binding);
      if (!runtime || runtime.available !== true || runtime.facility !== '@actions/artifact@2.3.2'
          || !equal([runtime.repository, runtime.repositoryId, runtime.runId, runtime.attempt],
            [binding.repository,binding.repositoryId,binding.runId,binding.attempt])
          || typeof client?.uploadArtifact !== 'function' || typeof read !== 'function'
          || bytes.byteLength > 65536 || !future(expires_at,now) || signal.aborted) fail();
      const name = `registration-${binding.requestId}-${binding.attempt}`;
      root = await mkdtemp(join(tmpdir(),'nibfin-registration-'));
      const file = join(root,'response.json');
      await writeFile(file, bytes, {flag:'wx',mode:0o600});
      if (signal.aborted || !future(expires_at,now)) fail();
      submitted = true;
      pending = Promise.resolve().then(() => client.uploadArtifact(name,[file],root,{retentionDays:1,compressionLevel:6}));
      let upload;
      try {upload = await bounded(pending,signal);} catch { /* Read by exact unique name after ambiguous upload. */ }
      if (upload && !id(upload.id)) fail();
      ref = {repository:binding.repository, repositoryId:binding.repositoryId, runId:binding.runId,
        attempt:binding.attempt, name, artifactId:upload?.id ?? null};
      const back = await bounded(read({ref,signal}),signal);
      if (!id(back?.artifactId) || upload && back.artifactId !== upload.id
          || !Buffer.from(back.bytes).equals(bytes) || !future(expires_at,now)) fail();
      ref.artifactId = back.artifactId;
      result = {outcome:'delivered',ref};
    } catch {result = {outcome:submitted ? 'unconfirmed':'unavailable', diagnostic:{kind:submitted?'publication_unknown':'channel_unavailable'}, ...(ref?{ref}:{})};}
    finally {
      if (root) {
        // SDK has no cancellation API. Do not remove files it may still be using.
        if (signal.aborted && pending) {
          void pending.then(() => remove(root), () => remove(root)).catch(() => {});
          result = {...result,outcome:'unconfirmed',diagnostic:{kind:'cleanup_pending'}};
        } else {
          try {await remove(root);} catch {result = {...result,outcome:'unconfirmed',diagnostic:{kind:'cleanup_incomplete'}};}
        }
      }
    }
    return result;
  }});
}
/** Fresh official metadata and exact ZIP readback, no latest-artifact selection. */
export function registrationArtifactReader({provider, archive, now = Date.now}) {
  return async ({ref,signal}) => {
    const root = `/repos/${ref.repository}/actions`;
    const opts = {target:ref.repositoryId, operation:'registration_read',correlation:'registration',signal};
    const repo = await provider.request({...opts,endpoint:`/repos/${ref.repository}`});
    const run = await provider.request({...opts,endpoint:`${root}/runs/${ref.runId}`});
    if (repo.outcome !== 'read' || repo.data.id !== ref.repositoryId || repo.data.private !== false
        || repo.data.visibility !== 'public' || repo.data.full_name?.toLowerCase() !== ref.repository
        || run.outcome !== 'read' || run.data.id !== ref.runId || String(run.data.run_attempt) !== ref.attempt
        || run.data.repository?.id !== ref.repositoryId) fail();
    const endpoint = `${root}/runs/${ref.runId}/artifacts?per_page=100`;
    const allowPage = path => {
      const u = new URL(path,'https://api.github.com');
      return u.origin === 'https://api.github.com' && u.pathname === `${root}/runs/${ref.runId}/artifacts`
        && [...u.searchParams.keys()].every(k => ['page','per_page'].includes(k))
        && u.searchParams.getAll('page').length <= 1 && u.searchParams.getAll('per_page').length <= 1
        && (!u.searchParams.has('page') || id(u.searchParams.get('page')))
        && (!u.searchParams.has('per_page') || u.searchParams.get('per_page') === '100');
    };
    const list = await provider.collection({...opts,endpoint,envelope:'artifacts',allowPage});
    if (list.outcome !== 'complete') fail();
    const matches = list.data.filter(a => a.name === ref.name);
    if (matches.length !== 1) fail();
    const a = matches[0];
    if (!id(a.id) || ref.artifactId !== null && a.id !== ref.artifactId || a.expired !== false
        || !future(a.expires_at,now) || a.workflow_run?.id !== ref.runId
        || !Number.isSafeInteger(a.size_in_bytes) || a.size_in_bytes > 131072) fail();
    const downloaded = await archive({endpoint:`${root}/artifacts/${a.id}/zip`,signal,maxBytes:131072});
    if (downloaded.status !== 200 || downloaded.bytes?.length !== a.size_in_bytes) fail();
    const files = readCustodyZip(downloaded.bytes,{maxBytes:131072,maxFiles:1});
    if (files.size !== 1 || !files.has('response.json')) fail();
    return {artifactId:a.id,bytes:files.get('response.json')};
  };
}
function bounded(promise, signal) {
  return new Promise((resolve,reject) => {
    const abort = () => reject(Error('registration:cancelled'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(() => signal.removeEventListener('abort',abort));
  });
}

/** Protected hosted Core adapter, never callable with payload-supplied authority.
 * authenticate reads a verified source Run/request; policy reads Owner configuration.
 * Transport credentials live only in the host capability. No checkout/process execution.
 */
export function createRegistrationHost({authenticate, policy, transport, channel, now = Date.now, timeoutMs = 30000}) {
  if ([authenticate,policy,transport].some(v => typeof v !== 'function') || typeof channel?.publish !== 'function'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) fail();
  return Object.freeze({async issue(handle,{signal:caller} = {}) {
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs),...(caller?[caller]:[])]);
    let sent = false, diagnostic, binding;
    const started = now(); let latest = started;
    const fresh = () => {
      const current = now();
      if (!Number.isSafeInteger(current) || current < latest || current-started >= timeoutMs || signal.aborted) return false;
      latest = current; return true;
    };
    try {
      const s = structuredClone(await bounded(authenticate(handle,{signal}),signal));
      if (s?.authenticated !== true || s.event !== 'workflow_dispatch' || !word(s.requestId)
          || !id(s.requester?.id) || !login(s.requester.login) || !id(s.repositoryId)
          || !id(s.runId) || !id(s.attempt) || !/^[a-z0-9-]+\/[a-z0-9_.-]+$/.test(s.repository)
          || !['repository','organization'].includes(s.level)) fail();
      const [owner,repo] = s.repository.split('/');
      if (!login(owner) || !/^[a-z0-9_.-]{1,100}$/.test(repo) || ['.','..'].includes(repo)) fail();
      const recipient = keyInfo(s.publicKey).fingerprint;
      const p = structuredClone(await bounded(policy(s.repositoryId,{signal}),signal));
      const enabled = p => p?.enabled === true && p.repositoryId === s.repositoryId && p.repository === s.repository;
      if (!enabled(p)) return {outcome:'denied',diagnostic:{kind:'policy_off'}};
      const level = s.level;
      const permission = level === 'repository' ? 'administration:write':'organization_self_hosted_runners:write';
      if (p.capabilities?.[permission] !== true || level === 'organization' &&
          (p.organization?.enabled !== true || p.organization.login !== owner || !id(p.organization.id)))
        return {outcome:'denied',diagnostic:{kind:'management_permission',capability:permission}};
      const endpoint = level === 'repository' ? `/repos/${s.repository}/actions/runners/registration-token`
        : `/orgs/${owner}/actions/runners/registration-token`;
      const provider = createGithubProvider({identity:'hosted-authorized',transport,now,elapsedMs:timeoutMs,
        authorize:async intent => {
          const current = await bounded(policy(s.repositoryId,{signal}),signal);
          return fresh() && enabled(current) && equal(current,p) && intent.endpoint === endpoint && intent.method === 'POST';
        }});
      const read = async path => {
        const r = await provider.request({endpoint:path,target:s.repositoryId,operation:'registration',correlation:s.requestId,signal});
        if (r.outcome !== 'read' || !fresh()) fail();
        return r.data;
      };
      const r = await read(`/repos/${s.repository}`);
      if (r.id !== s.repositoryId || r.full_name?.toLowerCase() !== s.repository || r.private !== false
          || r.visibility !== 'public' || r.owner?.login?.toLowerCase() !== owner
          || !['User','Organization'].includes(r.owner.type)) fail();
      const u = await read(`/users/${s.requester.login}`);
      const m = await read(`/repos/${s.repository}/collaborators/${s.requester.login}/permission`);
      const same = u => u?.id === s.requester.id && u.login?.toLowerCase() === s.requester.login.toLowerCase();
      if (!same(u) || !same(m.user) || !['write','maintain','admin'].includes(m.permission)) fail();
      if (level === 'organization') {
        const org = await read(`/orgs/${owner}`);
        if (r.owner.type !== 'Organization' || org.id !== p.organization.id || org.id !== r.owner.id
            || org.login?.toLowerCase() !== owner) fail();
      }
      binding = context({...s,requesterId:s.requester.id,recipient,
        registrationId:level === 'repository'?s.repositoryId:p.organization.id});
      if (!fresh()) fail();
      sent = true;
      const issued = await provider.request({method:'POST',endpoint,target:binding.registrationId,
        operation:'registration',correlation:s.requestId,body:{},signal});
      diagnostic = publicDiagnostic(issued).diagnostic;
      if (issued.outcome !== 'submitted') return {outcome:issued.outcome === 'unknown'?'unknown':'denied',diagnostic};
      const t = issued.data;
      if (typeof t?.token !== 'string' || !t.token || t.token.length > 8192
          || typeof t.expires_at !== 'string' || !Number.isFinite(Date.parse(t.expires_at)))
        return {outcome:'unknown',diagnostic:{kind:'invalid_token_response'}};
      if (!future(t.expires_at,now)) return {outcome:'expired'};
      const url = `https://github.com/${level === 'repository'?s.repository:owner}`;
      const bytes = protect({token:t.token,expires_at:t.expires_at,url,context:binding},s.publicKey,binding);
      if (!fresh() || !future(t.expires_at,now)) return {outcome:'expired'};
      const delivered = await bounded(channel.publish({bytes,binding,expires_at:t.expires_at,signal}),signal);
      if (!fresh() || !future(t.expires_at,now)) return {outcome:'expired'};
      // Only our fixed channel schema may escape; never propagate arbitrary client diagnostics.
      if (delivered.outcome !== 'delivered') return {outcome:'unconfirmed',diagnostic:{kind:
        ['cleanup_pending','cleanup_incomplete'].includes(delivered.diagnostic?.kind)?delivered.diagnostic.kind:'publication_unknown'}};
      return {outcome:'delivered',context:binding,expires_at:t.expires_at,url,ref:delivered.ref};
    } catch {return {outcome:sent?'unknown':'unavailable',diagnostic:{kind:signal.aborted?'cancelled_or_timeout':'invalid_observation'}};}
  }});
}
