// Explicit operator test. Uses the enrolled subscription but no GitHub authority.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAgent, resultSchema } from '../src/agent.mjs';
import { digest } from '../src/core.mjs';

const [configPath, scratchPath] = process.argv.slice(2);
if (!configPath || !scratchPath) throw new Error('Usage: node scripts/agent-smoke.mjs <agent-config.json> <new-scratch-directory>');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const root = resolve(scratchPath);
await mkdir(root, { mode: 0o700 }); // Refuse an existing directory.
const work = join(root, 'work');
await mkdir(work);
const coreRoot = fileURLToPath(new URL('../', import.meta.url));
const agent = new CodexAgent(config, coreRoot, root);
const testSource = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sum } from './sum.mjs';
test('sum adds positive, negative and zero values', () => {
  assert.equal(sum(2, 3), 5);
  assert.equal(sum(-4, 7), 3);
  assert.equal(sum(0, 0), 0);
});
`;
await writeFile(join(work, 'sum.test.mjs'), testSource);
async function snapshot(path) {
  const entries = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error('Unexpected non-file in smoke workspace');
    entries.push([entry.name, await readFile(join(path, entry.name), 'utf8')]);
  }
  return digest(entries.sort(([a], [b]) => a.localeCompare(b)));
}
async function runAgent(name, writable, prompt) {
  const io = join(root, name);
  await mkdir(io);
  await writeFile(join(io, 'schema.json'), JSON.stringify(resultSchema));
  await agent.login(work, io);
  const args = agent.executionArgs(work, io, writable);
  const container = `kairo-smoke-${name}-${Date.now()}`;
  args.splice(1, 0, '--name', container);
  try {
    await agent.run('docker', args, { input: prompt, timeout: 180000 });
  } finally {
    const active = await agent.run('docker', ['ps', '-aq', '--filter', `name=^/${container}$`]);
    if (active.stdout.trim()) await agent.run('docker', ['rm', '--force', container]);
  }
  const result = JSON.parse(await readFile(join(io, 'result.json'), 'utf8'));
  await writeFile(join(root, `${name}-result.json`), JSON.stringify(result, null, 2));
  if (!['ready', 'accepted', 'approved'].includes(result.outcome) || result.blockingFindings.length) throw new Error(`${name} reported a failure; inspect ${name}-result.json`);
  return io;
}
const deliveryIO = await runAgent('deliver', true,
  'This is a local smoke test, not a Cohort approval. Create sum.mjs exporting named function sum(a,b) that returns a+b. Do not modify sum.test.mjs. Run node --test sum.test.mjs and report its actual output in evidenceReferences. Return outcome ready only if successful; body empty, summary concise, rootCause empty, blockingFindings empty on success. Do not access external services or credentials.');
assert.equal(await readFile(join(work, 'sum.test.mjs'), 'utf8'), testSource);
// Independently rerun the test with the same mounts, outside the model.
const containerArgs = agent.args(work, deliveryIO, false);
const imageIndex = containerArgs.indexOf(config.image);
await agent.run('docker', [...containerArgs.slice(0, imageIndex + 1), 'node', '--test', 'sum.test.mjs']);
const before = await snapshot(work);
await runAgent('review', false,
  'This is an isolated reviewer-permission smoke test, not Cohort acceptance. Run node --test sum.test.mjs. Then use a shell command to try writing /work/reviewer-write-probe; it MUST fail because /work is read-only. Also confirm /opt/kairo/core and /var/run/docker.sock do not exist, and the GH_TOKEN environment variable is unset. Do not read authentication files. Report the actual outputs in evidenceReferences. Return outcome approved only if tests pass and the attempted write fails and host resources are absent; otherwise blocked with findings. body empty, rootCause empty on success.');
assert.equal(await snapshot(work), before, 'Reviewer changed the workspace');
const probe = `const fs=require('fs');
for (const path of ['/work/os-write-probe','/etc/os-write-probe']) {
  try { fs.writeFileSync(path,'unexpected'); throw Error('Writable protected path: '+path); }
  catch (e) { if (!['EROFS','EACCES'].includes(e.code)) throw e; }
}
if(fs.existsSync('/opt/kairo/core')||fs.existsSync('/var/run/docker.sock')||process.env.GH_TOKEN)throw Error('Host resource exposed');
console.log('OS isolation verified');`;
await agent.run('docker', [...containerArgs.slice(0, imageIndex + 1), 'node', '-e', probe]);
const evidence = { passed: true, image: config.image, sandboxBoundary: config.sandboxBoundary ?? 'codex', authenticated: true, actualAgentWrite: true, independentTestPassed: true, reviewerWorkspaceUnchanged: true, operatingSystemIsolationPassed: true, workspaceHash: before };
await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
