import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { digest, createAgentAdapter } from '../../src/index.mjs';
import { fixture, roleResult } from './protected.mjs';
export const environments = () => [{ schemaVersion: 1, id: 'env-a', agent: 'agent-a', credentialDomain: 'agent-domain-a' },
  { schemaVersion: 1, id: 'env-b', agent: 'agent-b', credentialDomain: 'agent-domain-b' }];
export const instances = () => [0, 1, 2].map(n => ({ schemaVersion: 1, id: `instance-${n}`, environmentId: n === 2 ? 'env-b' : 'env-a',
  agentCredentialDomain: n === 2 ? 'agent-domain-b' : 'agent-domain-a', githubIdentity: `github-${n}`,
  githubCredentialDomain: `github-domain-${n}`, workspace: `registration-work-${n}`, service: `service-${n}`, runnerId: `runner-${n}` }));
export function setup(role = 'deliver', suffix = 'a', executionClass = 'agent') {
  const f = fixture(role); f.request.binding.source.runId = `run-${suffix}`;
  f.proof.assignment = structuredClone(f.request.binding);
  // Existing prior evidence is independently completed in other Runs.
  const a = { schemaVersion: 1, executionId: `execution-${suffix}`, workspaceId: `workspace-${suffix}`,
    environmentId: 'env-a', instanceId: 'instance-0', class: executionClass, binding: structuredClone(f.request.binding), references: [] };
  const store = new Map([['repository', 'immutable repository'], ['ignored', 'required ignored artifact'], ['ignore-rules', 'ignored/\n']]);
  a.references = [...store].map(([key, content]) => ({ schemaVersion: 1, id: `immutable:${key}`, kind: key === 'ignored' ? 'artifact' : 'repository',
    digest: digest(content), path: key === 'ignored' ? 'ignored/artifact.txt' : key === 'ignore-rules' ? '.gitignore' : 'source.txt', repositoryId: a.binding.repository.id,
    candidateDigest: a.binding.candidateDigest, runId: a.binding.source.runId, attempt: a.binding.source.attempt }));
  let expectedLogin = { phase: 'issue', operation: 'execute', runId: a.binding.source.runId, attempt: 1,
    account: 'service-account', userId: 'member-id', caller: 'local' };
  let login = { schemaVersion: 1, ...expectedLogin, agent: 'available', gh: 'available', tokenEnvironment: 'absent', httpStatus: null };
  delete login.caller;
  if (executionClass === 'hook') { login = null; expectedLogin = null; }
  const mode = executionClass === 'hook' || role !== 'deliver' ? 'read-only' : 'workspace-write';
  const proof = { assignment: structuredClone(a), environments: environments(), instances: instances(), previousEnvironments: [], login,
    capabilities: { filesystem: mode, symlinks: 'deny', credentials: 'isolated', network: 'denied', termination: 'observable' },
    exposures: executionClass === 'hook' ? [] : ['agent-login'], permission: 'verified' };
  return { f, a, store, proof, expectedLogin, mode };
}
export const correlated = a => ({ schemaVersion: 1, executionId: a.executionId, workspaceId: a.workspaceId, assignmentDigest: digest(a),
  operation: a.class === 'hook' ? 'hook' : a.binding.role, runId: a.binding.source.runId, attempt: a.binding.source.attempt });
export const clean = a => ({ ...correlated(a), termination: 'confirmed', disposal: 'safe', references: ['host:cleanup'] });
// Synthetic immutable store plus a bounded JavaScript test host, NOT an Agent sandbox.
// Node's process permission model supplies a second actual filesystem boundary.
export async function testHost(s) {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-agent-'));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const outside = join(root, 'outside'); await writeFile(outside, 'protected');
  const secrets = join(root, 'credentials'); await writeFile(secrets, 'SENTINEL-CREDENTIAL');
  const pending = new Map(); let executions = 0; let stopFailure = false;
  let cleanupObservation = clean(s.a); let predecessors = [];
  async function destination(relative) {
    if (relative.split('/').some(x => !x || x === '..' || x === '.') || relative.startsWith('/') || relative.includes('\\')) throw Error('Path denied');
    let current = workspace;
    for (const part of relative.split('/')) {
      current = join(current, part);
      try { if ((await lstat(current)).isSymbolicLink()) throw Error('Symlink denied'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return current;
  }
  const host = {
    observe: async () => structuredClone(s.proof),
    predecessors: async () => structuredClone(predecessors),
    reconcile: async p => p.observation,
    materialize: async (a, r) => {
      const content = s.store.get(r.id.slice('immutable:'.length));
      if (typeof content !== 'string' || digest(content) !== r.digest) throw Error('Unavailable immutable bytes');
      await destination(r.path); pending.set(r.path, content); return content;
    },
    seal: async a => {
      for (const [relative, content] of pending) {
        const target = await destination(relative); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, content);
      }
      return { ...correlated(a), mode: s.mode, references: a.references };
    },
    execute: async a => {
      executions++;
      return a.class === 'hook' ? { ...correlated(a), status: 'succeeded', references: ['host:hook'] } :
        { ...correlated(a), result: roleResult(a.binding), references: ['host:result'] };
    },
    stop: async () => { if (stopFailure) throw Error('private stop error SENTINEL-CREDENTIAL'); },
    cleanup: async () => {
      if (cleanupObservation.termination === 'confirmed' && cleanupObservation.disposal === 'safe')
        await rm(workspace, { recursive: true, force: true });
      return structuredClone(cleanupObservation);
    }
  };
  const adapter = createAgentAdapter(host);
  // No process, import, fetch, sockets or credential objects enter this VM context.
  // This probe tests an intentionally restricted JS evaluator, not arbitrary native Agent code.
  const evaluate = code => vm.runInNewContext(code, Object.create(null), { timeout: 100, contextCodeGeneration: { strings: false, wasm: false } });
  function processProbe(code) {
    const args = ['--experimental-permission', `--allow-fs-read=${workspace}`];
    if (s.mode === 'workspace-write') args.push(`--allow-fs-write=${workspace}`);
    return spawnSync(process.execPath, [...args, '--input-type=module', '-e', code], { encoding: 'utf8', env: {} });
  }
  return { adapter, host, root, workspace, outside, secrets, evaluate, processProbe,
    calls: () => executions, setCleanup: x => { cleanupObservation = x; }, failStop: () => { stopFailure = true; },
    setPredecessors: x => { predecessors = x; },
    read: async p => readFile(await destination(p), 'utf8'),
    write: async (p, content) => {
      const target = await destination(p);
      if (s.mode !== 'workspace-write') throw Error('Read-only workspace');
      const result = processProbe(`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(target)}, ${JSON.stringify(content)});`);
      if (result.status !== 0) throw Error('Filesystem denied');
    },
    link: async () => symlink(outside, join(workspace, 'escape')),
    discard: async () => rm(root, { recursive: true, force: true }) };
}
