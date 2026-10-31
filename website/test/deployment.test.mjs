import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { validateConfiguration } from '../tooling/pages-configuration.mjs';
import { outputMember } from '../tooling/build-identity.mjs';
import { workflowInstallation } from '../../src/workflow-install.mjs';
const workflow = parse(readFileSync('../.github/workflows/ci.yml', 'utf8'));
test('required check names remain visible with scoped jobs; deployment requires successful quality on protected main', () => {
  const core = parse(readFileSync('../.github/workflows/ci.yml', 'utf8'));
  for (const ci of [workflow, core]) {
    assert(Object.hasOwn(ci.on, 'pull_request'));
    for (const event of ['pull_request', 'push']) {
      assert.equal(ci.on[event]?.paths, undefined, 'A required workflow must not skip changed paths');
      assert.equal(ci.on[event]?.['paths-ignore'], undefined);
    }
    assert.deepEqual(ci.on.push.branches, ['main']);
  }
  for(const name of ['core','website','controller']) {
    assert.equal(workflow.jobs[name].needs,'owner-pr');
    assert.equal(workflow.jobs[name].if,`needs.owner-pr.outputs.${name} == 'true'`);
  }
  assert.equal(workflow.jobs['owner-pr'].if,undefined);
  assert(workflow.jobs['owner-pr'].steps.find(s=>s.id==='plan'));
  assert.deepEqual(Object.keys(workflow.jobs).sort(),['controller','core','deploy','owner-pr','website']);
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
  const guard = workflow.jobs.deploy.steps.find(s => s.name === 'Require the immutable build artifact ID');
  assert.equal(guard.env.QUALITY_ARTIFACT_ID, download.with['artifact-ids']);
  for (const id of ['', 'all', '12,34']) assert.notEqual(spawnSync('/bin/sh', ['-c', guard.run], { env: { ...process.env, QUALITY_ARTIFACT_ID: id } }).status, 0);
  assert.equal(spawnSync('/bin/sh', ['-c', guard.run], { env: { ...process.env, QUALITY_ARTIFACT_ID: '123456' } }).status, 0);
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
    writeFileSync(join(root,'.github/workflows/ci.yml'),'name: fixture');
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

const packagedEntries=['ci.yml','core-release.yml','nibfin-delivery.yml','nibfin-registration.yml'];
const input=name=>'${{ inputs.'+name+' }}';
const selectorNames=['nibfin_request','nibfin_correlation','nibfin_issue','nibfin_stage','nibfin_member'];
function checkEntryInventory(names,read){
 assert.deepEqual(names.filter(n=>!['nibfin-stage.yml','nibfin-rescue.yml'].includes(n)).sort(),packagedEntries);
 if(names.includes('nibfin-stage.yml')){
  const entry=parse(read('nibfin-stage.yml'));
  assert.deepEqual(Object.keys(entry.on),['workflow_dispatch']);assert.deepEqual(entry.permissions,{});
  assert.deepEqual(Object.keys(entry.on.workflow_dispatch.inputs).sort(),[...selectorNames].sort());
  for(const field of Object.values(entry.on.workflow_dispatch.inputs))assert.deepEqual(field,{type:'string',required:true});
  assert.deepEqual(Object.keys(entry.jobs),['stage']);const stage=entry.jobs.stage;
  assert.equal(stage.name,'stage / execute');assert.deepEqual(stage.permissions,{});
  assert.deepEqual(stage['runs-on'],['self-hosted','linux','x64','nibfin-user-'+input('nibfin_member'),'nibfin-request-'+input('nibfin_request')]);
  assert.equal(stage.uses,undefined);assert.equal(stage.steps.length,1);assert.equal(stage.steps[0].shell,'bash');
  assert.equal(stage.steps[0].uses,undefined);
  assert.equal(stage.steps[0].run,'/usr/local/bin/node "$HOME/.local/share/nibfin/control/runtime/client/native-stage-main.mjs"');
 }
 if(names.includes('nibfin-rescue.yml')){
  const entry=parse(read('nibfin-rescue.yml'));
  assert.deepEqual(Object.keys(entry.on),['workflow_dispatch']);assert.deepEqual(entry.permissions,{});
  assert.deepEqual(Object.keys(entry.on.workflow_dispatch.inputs).sort(),['request_id','source_run_id','source_attempt','mode','nibfin_correlation','nibfin_issue','nibfin_stage'].sort());
  assert.deepEqual(Object.keys(entry.jobs),['rescue']);const job=entry.jobs.rescue;
  assert.deepEqual(job['runs-on'],['self-hosted','linux','x64','nibfin-request-'+input('nibfin_correlation')]);
  assert.deepEqual(job.permissions,{actions:'write'});assert.equal(job.steps.length,2);
  assert.equal(job.steps[0].run,'/usr/local/bin/node "$HOME/.local/share/nibfin/control/runtime/client/native-stage-main.mjs"');
  assert.equal(job.steps[0]['continue-on-error'],true);assert.equal(job.steps[0].env.GH_TOKEN,undefined);
  assert.equal(job.steps[1].env.GH_TOKEN,'${{ github.token }}');assert.match(job.steps[1].run,/id=process.env.GITHUB_RUN_ID/);
  assert.match(job.steps[1].run,/actions\/runs\/.*cancel/);assert.doesNotMatch(job.steps[1].run,/inputs\.source_run_id/);
 }
}

test('four package entries and the optional installed dispatch stage retain their separate purposes',()=>{
  checkEntryInventory(readdirSync('../.github/workflows').filter(n=>n.endsWith('.yml')),name=>readFileSync('../.github/workflows/'+name,'utf8'));
  for(const name of ['nibfin-delivery','nibfin-registration']) {
    const entry=parse(readFileSync('../.github/workflows/'+name+'.yml','utf8'));
    assert.deepEqual(Object.keys(entry.on),['workflow_call']);
  }
  assert.equal(workflow.jobs['owner-pr'].steps[0].name,'Require repository owner as PR author');
  for(const [name,job] of Object.entries(workflow.jobs))if(name!=='deploy')assert.equal(job.permissions,undefined);
});

test('installed stage remains a dispatch-only private entry and unknown workflows reject',()=>{
 const entry={on:{workflow_dispatch:{inputs:Object.fromEntries(selectorNames.map(name=>[name,{type:'string',required:true}]))}},permissions:{},jobs:{stage:{name:'stage / execute',permissions:{},'runs-on':['self-hosted','linux','x64','nibfin-user-'+input('nibfin_member'),'nibfin-request-'+input('nibfin_request')],steps:[{shell:'bash',run:'/usr/local/bin/node "$HOME/.local/share/nibfin/control/runtime/client/native-stage-main.mjs"'}]}}};
 const read=()=>JSON.stringify(entry);checkEntryInventory([...packagedEntries,'nibfin-stage.yml'],read);
 assert.throws(()=>checkEntryInventory([...packagedEntries,'extra-ci.yml'],read));
 entry.on.push={};assert.throws(()=>checkEntryInventory([...packagedEntries,'nibfin-stage.yml'],read));delete entry.on.push;
 entry.jobs.stage.steps[0].run='unexpected';assert.throws(()=>checkEntryInventory([...packagedEntries,'nibfin-stage.yml'],read));
});

test('actual native installation adds bounded project-local Rescue without another CI or scheduled workflow',()=>{
 const target={version:1,repository:'example/project',repositoryId:'42',ownerId:'7',ownerType:'User'};
 const plan=workflowInstallation({commit:'a'.repeat(40),hostRepository:'example/core',hostCommit:'b'.repeat(40),
  repository:target.repository,executionPool:{version:2,id:'member-default',capacity:2,targets:[target]}});
 const names=[...packagedEntries,...[...plan.files.keys()].map(p=>p.split('/').at(-1))];
 checkEntryInventory(names,name=>plan.files.get('.github/workflows/'+name));
 const rescue=parse(plan.files.get('.github/workflows/nibfin-rescue.yml'));
 rescue.on.schedule=[];assert.throws(()=>checkEntryInventory(names,name=>name==='nibfin-rescue.yml'?JSON.stringify(rescue):plan.files.get('.github/workflows/'+name)));
});
