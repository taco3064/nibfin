import { spawn } from 'node:child_process';
import { userInfo, tmpdir } from 'node:os';
import { githubApiVersion, origin, media } from './github-contract.mjs';
import { createConditionalGithubTransport } from './github-conditional.mjs';

function run(executable, args, input, signal, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: tmpdir(),
      env,
      shell: false,
      signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '',
      size = 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > 8 * 1024 * 1024) child.kill();
      else output += chunk;
    });
    // Never retain or expose gh's potentially private error output.
    child.stderr.resume();
    child.on('error', () => reject(Error('process')));
    child.on('close', (code) =>
      resolve({ code, output, overflow: size > 8 * 1024 * 1024 }),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Trusted process-account stored login only; never consult checkout defaults. */
export function localGhTransport({
  executable = 'gh',
  onResponse,
  authenticateReads = true,
} = {}) {
  // Resolve the actual process account only on invocation, never at construction.
  const environment = () => ({
    PATH: process.env.PATH,
    HOME: userInfo().homedir,
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
  });
  const dispatch = async (request, env) => {
    const args = [
      'api',
      '--hostname',
      'github.com',
      '--include',
      '--method',
      request.method,
      '--header',
      'Content-Type: application/json',
      '--header',
      `Accept: ${media}`,
      '--header',
      `X-GitHub-Api-Version: ${githubApiVersion}`,
    ];
    const etag = Object.entries(request.headers ?? {}).find(
      ([key]) => key.toLowerCase() === 'if-none-match',
    )?.[1];
    if (
      request.method === 'GET' &&
      typeof etag === 'string' &&
      etag.length <= 1024 &&
      !/[\x00-\x1f\x7f]/.test(etag)
    ) {
      args.push('--header', 'If-None-Match: ' + etag);
    }
    if (request.body !== undefined) args.push('--input', '-');
    args.push(origin + request.endpoint);
    const response = await run(
      executable,
      args,
      request.body ?? '',
      request.signal,
      env,
    );
    if (response.overflow) return { failure: 'malformed' };
    const match = response.output.match(
      /^HTTP\/\S+ (\d{3})[^\r\n]*\r?\n((?:[^\r\n]+\r?\n)*)\r?\n([\s\S]*)$/,
    );
    if (!match) return { failure: 'transport' };
    const headers = {};
    for (const line of match[2].split(/\r?\n/).filter(Boolean)) {
      const separator = line.indexOf(':');
      if (separator < 1) return { failure: 'malformed' };
      headers[line.slice(0, separator).toLowerCase()] = line
        .slice(separator + 1)
        .trim();
    }
    // gh returns nonzero for HTTP errors; preserve the structured status, never stderr.
    if (response.code !== 0 && Number(match[1]) < 400 && Number(match[1]) !== 304)
      return { failure: 'transport' };
    return { status: Number(match[1]), headers, body: match[3] };
  };
  const prepare = async ({ signal } = {}) => {
    const env = environment();
    const auth = await run(
      executable,
      ['auth', 'status', '--hostname', 'github.com'],
      '',
      signal,
      env,
    );
    if (auth.code !== 0) return () => ({ failure: 'authentication' });
    return (request) => dispatch(request, env);
  };
  // Host adapters may use server-authenticated GETs to avoid duplicate quota
  // consumption. Default callers retain the explicit stored-login preflight.
  const transport = async (request) =>
    request.method === 'GET' && !authenticateReads
      ? dispatch(request, environment())
      : (await prepare({ signal: request.signal }))(request);
  // Complete the local login subprocess before final source/Grant validation.
  // The request-local sender launches only gh api, without another auth await.
  Object.defineProperty(transport, 'prepareMutation', { value: prepare });
  return createConditionalGithubTransport({ send: transport, onResponse });
}
