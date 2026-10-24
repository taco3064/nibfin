import {spawn} from 'node:child_process';
import {userInfo, tmpdir} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';

export const githubApiVersion = '2026-03-10';
const origin = 'https://api.github.com';
const media = 'application/vnd.github+json';
const writes = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const token = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const id = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
function endpoint(value) {
  if (typeof value !== 'string' || !/^\/[a-zA-Z0-9_/?=&.-]+$/.test(value)
      || value.includes('..') || value.includes('//')) throw Error('unsupported');
  const url = new URL(value, origin);
  if (url.origin !== origin) throw Error('unsupported');
  return url.pathname + url.search;
}
// Node 22's reviver source retains numeric spelling before lossy Number conversion.
export function parseGithubJson(text) {
  return JSON.parse(text, (key, value, context) => {
    if (key === 'id' || (key.endsWith('_id') && key !== 'node_id')) {
      if (typeof value === 'number') value = context.source;
      if (value !== null && !id(value)) throw Error('identity');
    }
    if (key === 'node_id' && (typeof value !== 'string' || !/^[A-Za-z0-9_=-]{1,256}$/.test(value))) throw Error('identity');
    return value;
  });
}

function run(executable, args, input, signal, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {cwd: tmpdir(), env, shell: false, signal, stdio: ['pipe', 'pipe', 'pipe']});
    let output = '', size = 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > 8 * 1024 * 1024) child.kill();
      else output += chunk;
    });
    child.stderr.resume(); // Never retain or expose gh's potentially private error output.
    child.on('error', () => reject(Error('process')));
    child.on('close', code => resolve({code, output, overflow: size > 8 * 1024 * 1024}));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Trusted process-account stored login only; never consult checkout defaults. */
export function localGhTransport({executable = 'gh'} = {}) {
  const env = {PATH: process.env.PATH, HOME: userInfo().homedir, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1',
    GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', NO_COLOR: '1'};
  return async request => {
    const auth = await run(executable, ['auth', 'status', '--hostname', 'github.com'], '', request.signal, env);
    if (auth.code !== 0) return {failure: 'authentication'};
    const args = ['api', '--hostname', 'github.com', '--include', '--method', request.method,
      '--header', 'Content-Type: application/json', '--header', `Accept: ${media}`, '--header', `X-GitHub-Api-Version: ${githubApiVersion}`];
    if (request.body !== undefined) args.push('--input', '-');
    args.push(origin + request.endpoint);
    const response = await run(executable, args, request.body ?? '', request.signal, env);
    if (response.overflow) return {failure: 'malformed'};
    const match = response.output.match(/^HTTP\/\S+ (\d{3})[^\r\n]*\r?\n((?:[^\r\n]+\r?\n)*)\r?\n([\s\S]*)$/);
    if (!match) return {failure: 'transport'};
    const headers = {};
    for (const line of match[2].split(/\r?\n/).filter(Boolean)) {
      const separator = line.indexOf(':');
      if (separator < 1) return {failure: 'malformed'};
      headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
    }
    // gh returns nonzero for HTTP errors; preserve the structured status, never stderr.
    if (response.code !== 0 && Number(match[1]) < 400) return {failure: 'transport'};
    return {status: Number(match[1]), headers, body: match[3]};
  };
}

function classify(response) {
  if (response.failure) return ['authentication', 'malformed'].includes(response.failure) ? response.failure : 'transport';
  const {status, headers: h, body} = response;
  if (!Number.isInteger(status) || status < 100 || status > 599 || typeof body !== 'string') return 'malformed';
  if (status === 401) return 'authentication';
  if ((status === 403 || status === 429) && (status === 429 || h['x-ratelimit-remaining'] === '0'
      || h['retry-after'] !== undefined || /secondary rate limit/i.test(body))) return 'rate_limited';
  if (status === 403) return 'denied';
  if (status === 404) return 'not_found_or_inaccessible';
  if (status === 400 || status === 422) return 'invalid_request';
  if (status >= 500) return 'server';
  if (status < 200 || status >= 300) return 'unsupported';
  return null;
}
function requirement(method, path) {
  if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/actions\/runners(?:\?|$)/.test(path)) return 'administration:read';
  return 'unknown';
}
function retryDelay(headers, now, attempt, rateLimited) {
  let delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
  if (rateLimited && headers['retry-after'] === undefined && headers['x-ratelimit-remaining'] !== '0')
    delay = Math.max(delay, 60000 * 2 ** (attempt - 1));
  if (headers['retry-after'] !== undefined) {
    const raw = headers['retry-after'];
    const ms = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now;
    if (!Number.isFinite(ms)) return Infinity;
    delay = Math.max(delay, ms);
  }
  if (headers['x-ratelimit-remaining'] === '0') {
    const reset = Number(headers['x-ratelimit-reset']);
    if (!Number.isFinite(reset)) return Infinity;
    delay = Math.max(delay, reset * 1000 - now);
  }
  return delay;
}

/** Injected transport and authorize are trusted Core capabilities, never provider data. */
export function createGithubProvider({transport, identity = 'local-stored-login', authorize,
  now = Date.now, delay = (ms, signal) => sleep(ms, undefined, {signal}),
  attempts = 3, elapsedMs = 30000, maxPages = 100} = {}) {
  if (!['local-stored-login', 'hosted-authorized'].includes(identity) || (transport !== undefined && typeof transport !== 'function')
      || (identity === 'hosted-authorized' && !transport)
      || !Number.isInteger(attempts) || attempts < 1 || attempts > 10 || !Number.isInteger(elapsedMs)
      || elapsedMs <= 0 || elapsedMs > 86400000 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw Error('Invalid provider configuration');
  transport ??= localGhTransport();
  const submissions = new WeakMap();
  const remaining = Symbol();
  async function request(options) {
    let path, body;
    const budget = options[remaining] ?? elapsedMs;
    const method = options.method ?? 'GET';
    const write = writes.has(method);
    let sent = false, started;
    const diagnostic = {kind: 'unsupported', capability: 'unknown'};
    const failure = kind => {
      const result = {outcome: write && ['transport', 'server', 'malformed', 'timeout', 'cancelled'].includes(kind) ? 'unknown' : 'failed',
      diagnostic: {...diagnostic, kind}};
      if (write && sent && result.outcome === 'unknown') submissions.set(result, {target: options.target, started});
      return result;
    };
    try {
      path = endpoint(options.endpoint);
      if ((!write && method !== 'GET') || !token(options.operation) || !token(options.correlation) || !id(options.target)) return failure('unsupported');
      diagnostic.operation = options.operation;
      diagnostic.correlation = options.correlation;
      diagnostic.capability = requirement(method, path);
      body = options.body === undefined ? undefined : JSON.stringify(options.body);
      if (write && (typeof authorize !== 'function' || await authorize(Object.freeze({method, endpoint: path,
        operation: options.operation, target: options.target, context: options.context, correlation: options.correlation,
        signal: options.signal, body: body === undefined ? undefined : JSON.parse(body)})) !== true)) return failure('unauthorized');
    } catch { return failure('unsupported'); }
    started = now();
    const signal = AbortSignal.any([AbortSignal.timeout(budget), ...(options.signal ? [options.signal] : [])]);
    for (let attempt = 1; attempt <= (write ? 1 : attempts); attempt++) {
      if (signal.aborted) return failure(options.signal?.aborted ? 'cancelled' : 'timeout');
      if (now() - started >= budget) return failure('timeout');
      let response;
      try {
        sent = true;
        // Race also bounds an injected transport that ignores cancellation.
        response = await abortable(transport({method, endpoint: path, body, signal,
          headers: {Accept: media, 'X-GitHub-Api-Version': githubApiVersion}, identity}), signal);
      } catch { response = {failure: 'transport'}; }
      if (signal.aborted) return failure(options.signal?.aborted ? 'cancelled' : 'timeout');
      const headers = Object.fromEntries(Object.entries(response?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
      response = {...response, headers};
      if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) diagnostic.status = response.status;
      if (now() - started >= budget) return failure('timeout');
      if (token(headers['x-github-request-id'])) diagnostic.requestId = headers['x-github-request-id'];
      const kind = classify(response);
      if (kind) {
        const result = failure(kind);
        if (write || !['transport', 'server', 'rate_limited'].includes(kind)) return result;
        const wait = retryDelay(headers, now(), attempt, kind === 'rate_limited');
        if (Number.isFinite(wait)) result.diagnostic.retryAfterMs = wait;
        if (attempt === attempts || wait >= budget - (now() - started)) return result;
        try { await abortable(delay(wait, signal), signal); } catch { return failure(options.signal?.aborted ? 'cancelled' : 'timeout'); }
        continue;
      }
      let data;
      try {
        data = response.status === 204 && response.body === '' ? null : parseGithubJson(response.body);
        if ((options.expectedId !== undefined && (!id(options.expectedId) || data?.id !== options.expectedId))
            || (options.validate && options.validate(data) !== true)) return failure('malformed');
      } catch { return failure('malformed'); }
      const result = {outcome: write ? 'submitted' : 'read', data, observedAt: now(), diagnostic: {...diagnostic, kind: 'none'}};
      // Pagination metadata is trusted-only, excluded by publicDiagnostic.
      if (!write) result.link = headers.link;
      else submissions.set(result, {target: options.target, started});
      return result;
    }
  }
  async function collection(options) {
    const items = [], seen = new Set();
    const signal = AbortSignal.any([AbortSignal.timeout(elapsedMs), ...(options.signal ? [options.signal] : [])]);
    const started = now();
    let path = options.endpoint;
    for (let page = 0; page < maxPages; page++) {
      if (seen.has(path) || now() - started >= elapsedMs) break;
      seen.add(path);
      const result = await request({...options, method: 'GET', endpoint: path, signal, [remaining]: Math.max(1, elapsedMs - (now() - started))});
      if (result.outcome !== 'read') return {...publicDiagnostic(result), outcome: 'incomplete'};
      const values = options.envelope ? result.data?.[options.envelope] : result.data;
      if (!Array.isArray(values) || values.some(value => !value || !id(value.id))) return {outcome: 'incomplete', diagnostic: {kind: 'malformed'}};
      items.push(...values);
      if (!result.link) return {outcome: 'complete', data: items};
      try {
        const links = result.link.split(',').map(part => {
          const match = part.trim().match(/^<([^>]+)>;\s*rel="([a-z]+)"$/);
          if (!match) throw Error('link');
          return match;
        });
        const next = links.filter(link => link[2] === 'next');
        if (!next.length) return {outcome: 'complete', data: items};
        if (next.length !== 1) break;
        const url = new URL(next[0][1]);
        if (url.origin !== origin || url.username || url.password || url.hash) break;
        path = endpoint(url.pathname + url.search);
      } catch { break; }
    }
    return {outcome: 'incomplete', diagnostic: {kind: 'pagination'}};
  }
  async function reconcile(submission, options, matches) {
    const binding = submissions.get(submission);
    if (!binding || options.target !== binding.target || typeof matches !== 'function') return {outcome: 'unknown'};
    const read = await request({...options, method: 'GET', body: undefined});
    try {
      if (read.outcome === 'read' && read.observedAt >= binding.started && read.data?.id === binding.target
          && matches(read.data) === true) return {...read, outcome: 'verified'};
    } catch { /* Caller predicates do not manufacture completion on failure. */ }
    return {outcome: 'unknown', diagnostic: read.diagnostic};
  }
  return Object.freeze({request, collection, reconcile});
}
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Error('cancelled'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
/** Only fixed-schema diagnostics are safe to publish; data/link/context are trusted-only. */
export function publicDiagnostic(result) {
  const d = result.diagnostic ?? {};
  return {outcome: result.outcome, diagnostic: Object.fromEntries(Object.entries(d).filter(([key, value]) =>
    (['kind', 'capability'].includes(key) && /^[a-z_:]+$/.test(value))
    || (['operation', 'correlation', 'requestId'].includes(key) && token(value))
    || (['status', 'retryAfterMs'].includes(key) && Number.isFinite(value))))};
}
