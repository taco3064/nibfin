import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { validateConfiguration } from '../tooling/pages-configuration.mjs';
import { outputMember } from '../tooling/build-identity.mjs';
const workflow = parse(readFileSync('../.github/workflows/website-ci.yml', 'utf8'));
test('required Core and website checks run for every PR; deployment requires successful quality on protected main', () => {
  const core = parse(readFileSync('../.github/workflows/core-ci.yml', 'utf8'));
  for (const ci of [workflow, core]) {
    assert(Object.hasOwn(ci.on, 'pull_request'));
    for (const event of ['pull_request', 'push']) {
      assert.equal(ci.on[event]?.paths, undefined, 'A required workflow must not skip changed paths');
      assert.equal(ci.on[event]?.['paths-ignore'], undefined);
    }
    assert.deepEqual(ci.on.push.branches, ['main']);
  }
  assert.equal(workflow.jobs.website.if, undefined);
  assert.equal(core.jobs.core.if, undefined);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.jobs.deploy.needs, 'website');
  assert.match(workflow.jobs.deploy.if, /event_name == 'push'.*refs\/heads\/main.*ref_protected/);
  assert.equal(workflow.jobs.deploy.concurrency['cancel-in-progress'], false);
  assert.deepEqual(workflow.jobs.deploy.permissions, { contents: 'read', pages: 'write', 'id-token': 'write' });
  assert.equal(workflow.jobs.deploy.environment.name, 'github-pages');
  const steps = workflow.jobs.website.steps;
  const pages = steps.findIndex(s => s.uses?.startsWith('actions/upload-pages-artifact@'));
  assert(pages > steps.findIndex(s => s.run === 'npm run evidence:site'));
  assert(!steps[pages].if.includes('always'));
  assert(steps.filter(s => s.run?.includes('evidence')).every(s => !s['continue-on-error']));
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
});

test('deployment retries consume the immutable artifact ID from the completed build job', () => {
  const upload = workflow.jobs.website.steps.find(s => s.id === 'quality');
  assert(upload.uses.startsWith('actions/upload-artifact@'));
  assert.equal(workflow.jobs.website.outputs['quality-artifact-id'], '${{ steps.quality.outputs.artifact-id }}');
  const download = workflow.jobs.deploy.steps.find(s => s.uses?.startsWith('actions/download-artifact@'));
  assert.equal(download.with['artifact-ids'], '${{ needs.website.outputs.quality-artifact-id }}');
  assert.equal(download.with['merge-multiple'], true);
  assert.equal(download.with.name, undefined, 'A deploy retry must not derive an artifact name from its current run_attempt');
});

test('live resource verification maps directory URLs to exact archived index files', () => {
  const outputs = { 'index.html': 'home', 'concepts/index.html': 'concepts', '_astro/site.css': 'css', '404.html': '404' };
  for (const [path, expected] of [['/nibfin/', 'home'], ['/nibfin/concepts/', 'concepts'], ['/nibfin/_astro/site.css', 'css'], ['/nibfin/404.html', '404']])
    assert.equal(outputs[outputMember(path)], expected);
  assert.notEqual(outputs[outputMember('/nibfin/concepts/')], 'stale bytes');
  for (const path of ['/elsewhere/', '/nibfin/%2e%2e/private', '/nibfin/a%5cb']) assert.throws(() => outputMember(path));
});
test('configuration rejects non-Actions source, unprotected main and permissive environments', () => {
  const good = { pages: { build_type: 'workflow' }, branch: { name: 'main', protected: true }, environment: { deployment_branch_policy: { custom_branch_policies: true } }, policies: { branch_policies: [{ name: 'main', type: 'branch' }] } };
  validateConfiguration(good);
  for (const change of [x => x.pages.build_type = 'legacy', x => x.branch.protected = false, x => x.policies.branch_policies.push({ name: '*', type: 'branch' }), x => x.environment.deployment_branch_policy = null]) {
    const bad = structuredClone(good); change(bad); assert.throws(() => validateConfiguration(bad));
  }
});
test('real build verifier rejects changed sources, added inputs and altered archives', () => {
  const root = mkdtempSync(join(tmpdir(), 'site-proof-'));
  const script = resolve('tooling/build-identity.mjs');
  const runner = `import {inventory, outputInventory, hash, verifyBuild} from ${JSON.stringify('file://' + script)}; import {readFileSync,writeFileSync} from 'node:fs'; const b={inputs:inventory(), outputs:outputInventory(),commands:Array(9).fill({exitCode:0}),archive:{sha256:hash(readFileSync('out/site.tar.gz'))}};writeFileSync('out/build-evidence.json',JSON.stringify(b));verifyBuild();`;
  try {
    for (const dir of ['website/tooling', 'website/dist', 'website/out', '.github/workflows']) mkdirSync(join(root, dir), { recursive: true });
    const cwd = join(root,'website'); writeFileSync(join(cwd,'dist/index.html'), '<h1>Exact output</h1>'); writeFileSync(join(cwd,'tooling/input.mjs'), '// original');
    assert.equal(spawnSync('tar',['-czf','out/site.tar.gz','-C','dist','.'], {cwd}).status,0);
    assert.equal(spawnSync(process.execPath,['--input-type=module','-e',runner],{cwd}).status,0);
    const verify = () => spawnSync(process.execPath,['--input-type=module','-e',`import {verifyBuild} from ${JSON.stringify('file://' + script)};verifyBuild()`],{cwd});
    writeFileSync(join(cwd,'tooling/new.mjs'),'// added'); assert.notEqual(verify().status,0); rmSync(join(cwd,'tooling/new.mjs'));
    writeFileSync(join(cwd,'tooling/input.mjs'),'// changed'); assert.notEqual(verify().status,0); writeFileSync(join(cwd,'tooling/input.mjs'),'// original');
    writeFileSync(join(cwd,'out/site.tar.gz'),'altered archive'); assert.notEqual(verify().status,0);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
test('configuration CLI consumes Fetch responses and rejects denied reads or stale main', () => {
  const root = mkdtempSync(join(tmpdir(), 'pages-readback-'));
  const script = resolve('tooling/pages-configuration.mjs');
  try {
    mkdirSync(join(root, 'out'));
    const mock = join(root, 'fetch.mjs');
    writeFileSync(mock, `import assert from 'node:assert/strict';
      globalThis.fetch = async (url, options) => {
        const path = new URL(url).pathname.replace('/repos/taco3064/nibfin', '');
        assert.equal(Boolean(options.headers.Authorization), path === '/pages');
        const data = {
          '/pages': { build_type: 'workflow' },
          '/branches/main': { name: 'main', protected: true, commit: { sha: process.env.STALE_MAIN ? 'other' : 'current' } },
          '/environments/github-pages': { deployment_branch_policy: { custom_branch_policies: true } },
          '/environments/github-pages/deployment-branch-policies': { branch_policies: [{ name: 'main', type: 'branch' }] }
        };
        assert(path in data);
        return new Response(JSON.stringify(data[path]), { status: process.env.DENIED_READ ? 403 : 200 });
      };`);
    const env = { ...process.env, GITHUB_REPOSITORY: 'taco3064/nibfin', GITHUB_REF: 'refs/heads/main', GITHUB_REF_PROTECTED: 'true', GITHUB_SHA: 'current', GH_TOKEN: 'fixture-only' };
    const run = extra => spawnSync(process.execPath, ['--import', mock, script], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' });
    const positive = run({}); assert.equal(positive.status, 0, positive.stderr);
    const receipt = join(root, 'out/pages-configuration.json');
    assert.equal(JSON.parse(readFileSync(receipt)).branch.commit.sha, 'current');
    for (const [extra, reason] of [[{ DENIED_READ: '1' }, /HTTP 403/], [{ STALE_MAIN: '1' }, /no longer current main/]]) {
      rmSync(receipt, { force: true }); const rejected = run(extra);
      assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, reason);
      assert.throws(() => readFileSync(receipt));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
