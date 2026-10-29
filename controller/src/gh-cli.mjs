import { command } from './process.mjs';

// Use the operating-system user's gh login, never an Actions token override.
export function ghEnvironment(source = process.env) {
  const env = { ...source, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' };
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_DEBUG', 'DEBUG']) delete env[key];
  return env;
}

function cliFailure(error, method, path) {
  const code = error.code === 'ENOENT' ? 'GH_CLI_MISSING' : 'GH_CLI_FAILED';
  // Do not propagate stdout/stderr: either can contain provider data or secrets.
  return Object.assign(new Error(`${code}: gh ${method} ${path.split('?')[0]} failed; verify gh installation and login for the runner user`), { code, requestMethod: method, exitCode: error.exitCode });
}

export function ghTransport(run = command) {
  return async (url, options = {}) => {
    const target = new URL(url);
    if (target.origin !== 'https://api.github.com' || target.username || target.password) throw new Error('gh transport requires api.github.com');
    const path = target.pathname + target.search, method = options.method || 'GET';
    const args = ['api', '--hostname', 'github.com', '--include', '--method', method, path];
    for (const [key, value] of Object.entries(options.headers || {})) {
      if (key.toLowerCase() !== 'authorization') args.push('--header', `${key}: ${value}`);
    }
    if (options.body !== undefined) args.push('--input', '-');
    let output;
    try { output = (await run('gh', args, { env: ghEnvironment(), input: options.body, timeout: 30000 })).stdout; }
    catch (error) {
      // gh exits nonzero for HTTP errors but --include still provides the status.
      if (!/^HTTP\/\S+ \d{3}\b/.test(error.stdout || '')) throw cliFailure(error, method, path);
      output = error.stdout;
    }
    const boundary = /\r?\n\r?\n/.exec(output);
    const status = Number(/^HTTP\/\S+ (\d{3})\b/.exec(output)?.[1]);
    if (!boundary || !status) throw Object.assign(new Error('Invalid gh API response'), { code: 'GH_RESPONSE_INVALID', requestMethod: method });
    const headers = new Headers();
    for (const line of output.slice(0, boundary.index).split(/\r?\n/).slice(1)) {
      const colon = line.indexOf(':');
      if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
    }
    if (status >= 400) console.error(JSON.stringify({ kind: 'github-cli-error', method, endpoint: target.pathname,
      httpStatus: status, requestId: headers.get('x-github-request-id'),
      code: status === 401 ? 'GITHUB_AUTH_FAILED' : status === 403 ? 'GITHUB_ACCESS_DENIED' : 'GITHUB_HTTP_ERROR' }));
    return new Response([204, 205, 304].includes(status) ? null : output.slice(boundary.index + boundary[0].length), { status, headers });
  };
}

export async function ghDownload(path, limit, run = command) {
  if (!/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/(jobs\/\d+\/logs|artifacts\/\d+\/zip)$/.test(path)) throw new Error('Invalid gh download endpoint');
  try {
    const help = await run('gh', ['api', '--help'], { env: ghEnvironment(), timeout: 30000 });
    const rawOutput = help.stdout.toString().includes('--allow-escape-sequences') ? ['--allow-escape-sequences'] : [];
    // gh handles GitHub's authenticated download and storage redirect. Keep bytes
    // binary and bounded; never expose the temporary signed download URL.
    return (await run('gh', ['api', '--hostname', 'github.com', ...rawOutput, path], { env: ghEnvironment(), encoding: null, timeout: 30000, limit })).stdout;
  } catch (error) {
    const status = Number(/\(HTTP (\d{3})\)/.exec(error.stderr || '')?.[1]) || undefined;
    throw Object.assign(cliFailure(error, 'GET', path), { status, ...(status === 401 ? {code:'GITHUB_AUTH_FAILED'} : {}) });
  }
}
