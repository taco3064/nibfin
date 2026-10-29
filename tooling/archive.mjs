import {inspectPackageArchive} from '../src/archive.mjs';
import {readFileSync, mkdirSync, renameSync, mkdtempSync, writeFileSync, rmSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, join, dirname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {grantFixture} from './grant-fixture.mjs';
import {bodyDigest,workflowFiles} from '../src/index.mjs';

export const packageFiles = ["src/native-role-bindings.mjs","src/requirements-document.mjs","src/requirement-source.mjs","src/requirement-sources/index.mjs","src/requirement-sources/github-issue.mjs","docs/requirement-sources.md","src/issue-authority.mjs","src/execution-pool.mjs","src/identity.mjs","npm-shrinkwrap.json","src/distribution-contract.mjs","src/distribution.mjs","src/distribution-map.json","src/installation.mjs","src/owner-hold.mjs","src/runner-job-gate.mjs","host/runner-job-hook.mjs","host/runner-job-hook.sh","docs/runner-job-admission.md","src/rescue-agent.mjs", "src/rescue-ai.mjs", "src/rescue-completion.mjs", "src/rescue-continuation.mjs", "src/rescue-host.mjs", "src/rescue-install.mjs", "src/rescue-policy.mjs", "src/rescue-records.mjs", "src/rescue-remedies.mjs", "src/rescue-result.mjs", "src/rescue-session.mjs", "src/rescue-wakeup.mjs", "src/rescue.mjs", "skills/rescue/SKILL.md", "host/templates/nibfin-rescue-wakeups.service", "docs/rescue.md",'src/candidate-contract.mjs','src/candidate-schema.mjs','src/delivery-planner.mjs','src/delivery-contract.mjs','src/runtime.mjs','src/github.mjs','src/workspace-sources.mjs','src/role-session.mjs','docs/kairo-reuse.md','src/readonly-tools.mjs','src/collaboration.mjs','src/runner-lifecycle.mjs','docs/collaboration.md','src/canonical.mjs','src/process.mjs','src/docker-security.mjs','src/credential-output.mjs','src/agent-gh-read.mjs','src/agent-gh-client.mjs','src/verification-runner.mjs','src/verification-prepare.mjs','docs/rootless-hardening.md','src/registration-host.mjs','src/host-routing.mjs','src/custody-host.mjs','docs/custody-host.md','host/custody.example.mjs','src/verification.mjs','src/verification-child.mjs','src/verification-supervisor.py','src/node-verification.mjs','src/runner.mjs','src/role-host.mjs','src/egress.mjs','src/egress-gateway.mjs','src/agent-session.mjs','docs/role-host.md','host/runner.schema.json','host/runner.example.json','src/host-identity.mjs','docs/authentication.md','src/archive.mjs','src/release.mjs','docs/releases.md',...workflowFiles,'src/core.mjs','docs/core.md','src/fanout.mjs','docs/fanout.md','src/recovery.mjs','docs/recovery.md','src/completion.mjs','docs/completion.md','src/final-review.mjs','docs/final-review.md','src/candidate-publication.mjs','docs/candidate-publication.md','src/repair.mjs','docs/repair.md','src/accept.mjs','docs/accept.md','src/hooks.mjs','docs/hooks.md','src/wsl.mjs','src/wsl-guest.mjs','docs/wsl.md','src/gemini.mjs','src/gemini-entry.mjs','docs/gemini.md','src/claude.mjs','src/claude-entry.mjs','docs/claude.md','src/shape.mjs', 'docs/shape.md', 'src/publisher.mjs', 'docs/publisher.md', 'src/codex.mjs', 'src/codex-entry.mjs', 'docs/codex.md', 'src/publication.mjs', 'docs/publication.md', 'src/ci.mjs', 'src/portfolio.mjs', 'instructions/scope.md', 'docs/scope.md', 'examples/scope.json', 'src/registration.mjs', 'docs/registration.md', 'src/relay.mjs', 'docs/relay.md', 'src/dynamic.mjs', 'docs/dynamic.md', 'src/operations.mjs', 'src/concurrency.mjs', 'docs/operations.md', 'src/selection.mjs', 'docs/selection.md', 'src/workspace.mjs', 'docs/workspace.md', 'src/runners.mjs', 'src/instructions.mjs', 'docs/instructions.md', 'skills/shape/SKILL.md', 'skills/deliver/SKILL.md', 'skills/accept/SKILL.md', 'src/actions.mjs', 'src/deployment.mjs', 'docs/deployment.md', 'src/lifecycle.mjs', 'docs/lifecycle.md', 'src/authorization.mjs', 'docs/authorization.md', 'src/authority.mjs', 'docs/authority.md', 'README.md', 'docs/package.md', 'package.json', 'src/index.mjs', 'src/grants.mjs', 'src/evidence.mjs', 'docs/evidence.md', 'src/provider.mjs', 'src/obligations.mjs', 'src/custody-upload.mjs', 'src/custody.mjs', 'src/custody-zip.mjs', 'docs/custody.md'];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const inspectArchive = archive => inspectPackageArchive(archive, packageFiles);

export function verifyArchive(archive, producer = root) {
  const files = inspectArchive(archive);
  for (const path of packageFiles) {
    if (!files.has(path)) throw new Error(`Missing required archive entry: ${path}`);
    if (!files.get(path).equals(readFileSync(join(producer, path)))) throw new Error(`Archive/source mismatch: ${path}`);
  }
  const manifest = JSON.parse(files.get('package.json'));
  if (manifest.name !== '@nibfin/core' || manifest.exports?.['.'] !== './src/index.mjs'
      || JSON.stringify(manifest.dependencies) !== JSON.stringify({jose:'6.2.13'}) || manifest.optionalDependencies || manifest.workspaces) {
    throw new Error('Unexpected package boundary');
  }
  const lock=JSON.parse(files.get('npm-shrinkwrap.json'));
  if(lock.lockfileVersion!==3||lock.name!==manifest.name||lock.version!==manifest.version
    ||JSON.stringify(lock.packages?.['']?.dependencies)!==JSON.stringify(manifest.dependencies)
    ||lock.packages?.['node_modules/jose']?.version!=='6.2.13'
    ||!lock.packages['node_modules/jose'].integrity?.startsWith('sha512-'))throw Error('Invalid installed dependency lock');
  return [...files.keys()].sort();
}

export function consumeArchive(archivePath, {release = false} = {}) {
  const consumer = mkdtempSync(join(tmpdir(), 'nibfin-consumer-'));
  try {
    if (realpathSync(consumer).startsWith(root + sep)) throw new Error('Consumer is inside producer');
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({private: true, type: 'module'}));
    // Deliberately pass no inherited credential or npm configuration variables.
    const env = {PATH: process.env.PATH, HOME: consumer, npm_config_cache: join(consumer, 'cache'),
      npm_config_userconfig: join(consumer, 'empty-npmrc'), npm_config_globalconfig: join(consumer, 'global-npmrc')};
    const dependencies=[];
    for (const name of ['jose','yaml']) {
      const packed=JSON.parse(execFileSync('npm',['pack','--json','--ignore-scripts','--offline','--pack-destination',consumer],
        {cwd:join(root,'node_modules',name),env,encoding:'utf8'}));
      const dependency=join(consumer,packed[0].filename);dependencies.push(dependency);
      execFileSync('npm',['cache','add',dependency],{cwd:consumer,env,stdio:'pipe'});
    }
    execFileSync('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund','--package-lock=false',...dependencies,resolve(archivePath)],
      {cwd:consumer,env,stdio:'pipe'});
    writeFileSync(join(consumer, 'custody-fixture.mjs'), readFileSync(join(root, 'tooling/custody-fixture.mjs'), 'utf8').replace("'../src/index.mjs'", "'@nibfin/core'"));
    writeFileSync(join(consumer, 'actions-fixture.mjs'), readFileSync(join(root, 'tooling/actions-fixture.mjs'), 'utf8').replace("'../src/index.mjs'", "'@nibfin/core'"));
    for (const fixture of ['docker-observation-fixture.mjs','registration-host-fixture.mjs','host-routing-fixture.mjs','custody-host-fixture.mjs','host-identity-fixture.mjs','workflow-fixture.mjs','registration-fixture.mjs','core-fixture.mjs','fanout-fixture.mjs','recovery-fixture.mjs','completion-fixture.mjs','final-review-fixture.mjs','candidate-publication-fixture.mjs','repair-fixture.mjs','evidence-fixture.mjs','accept-fixture.mjs','wsl-fixture.mjs','shape-fixture.mjs','codex-fixture.mjs','relay-fixture.mjs','operations-fixture.mjs','selection-fixture.mjs','grant-fixture.mjs','dynamic-fixture.mjs','rescue-fixture.mjs']) {
      writeFileSync(join(consumer, fixture), readFileSync(join(root, 'tooling', fixture), 'utf8').replaceAll("'../src/index.mjs'", "'@nibfin/core'").replaceAll("'../host/runner-job-hook.mjs'","'./node_modules/@nibfin/core/host/runner-job-hook.mjs'").replaceAll("'../host/entry.mjs'", "'@nibfin/core/protected-host'"));
    }
    writeFileSync(join(consumer,'core-lock-fixture.json'),readFileSync(join(root,'package-lock.json')));
    writeFileSync(join(consumer,'ci-fixture.mjs'),readFileSync(join(root,'test/ci-fixture.mjs'),'utf8').replace("'../src/provider.mjs'","'@nibfin/core'"));
    for (const file of ['requirements-document.test.mjs','requirement-source.test.mjs','issue-authority.test.mjs','installation.test.mjs','runner-job-gate.test.mjs','runner-job-hook.test.mjs','rescue.test.mjs','rescue-completion.test.mjs','rescue-continuation.test.mjs','rescue-agent.test.mjs','rescue-composition.test.mjs','rescue-workflow.test.mjs','delivery-composition.test.mjs','kairo-reuse.test.mjs','readonly-tools.test.mjs','collaboration.test.mjs','runner-lifecycle.test.mjs','docker-security.test.mjs','credential-output.test.mjs','agent-gh-read.test.mjs','isolation-reuse.test.mjs','verification-runner.test.mjs','verification-prepare.test.mjs','registration-host.test.mjs','host-routing.test.mjs','custody-host.test.mjs','approved-inputs.test.mjs','role-host.test.mjs','verification.test.mjs','agent-session.test.mjs','egress.test.mjs','host-identity.test.mjs','protected-host.test.mjs','workflows.test.mjs','lifecycle.test.mjs','core-owners.test.mjs','core.test.mjs','fanout.test.mjs','recovery.test.mjs','completion.test.mjs','final-review.test.mjs','candidate-publication.test.mjs','repair.test.mjs','accept.test.mjs','hooks.test.mjs','wsl.test.mjs','gemini.test.mjs','claude.test.mjs','shape.test.mjs','publisher.test.mjs','codex.test.mjs','publication.test.mjs','portfolio.test.mjs','registration.test.mjs','relay.test.mjs','operations.test.mjs','concurrency.test.mjs']) {
      writeFileSync(join(consumer, file), readFileSync(join(root, 'test', file), 'utf8')
        .replaceAll("'../src/distribution-map.json'", "'./node_modules/@nibfin/core/src/distribution-map.json'")
        .replaceAll("'../src/runner-job-gate.mjs'", "'@nibfin/core'")
        .replaceAll("'../host/runner-job-hook.sh'", "'./node_modules/@nibfin/core/host/runner-job-hook.sh'")
        .replaceAll("'../tooling/rescue-fixture.mjs'", "'./rescue-fixture.mjs'").replaceAll("'../tooling/selection-fixture.mjs'", "'./selection-fixture.mjs'").replaceAll("'../tooling/docker-observation-fixture.mjs'","'./docker-observation-fixture.mjs'").replaceAll("'../tooling/registration-host-fixture.mjs'", "'./registration-host-fixture.mjs'").replaceAll("'../tooling/host-routing-fixture.mjs'", "'./host-routing-fixture.mjs'").replaceAll("'../tooling/custody-host-fixture.mjs'", "'./custody-host-fixture.mjs'").replaceAll("'../tooling/host-identity-fixture.mjs'", "'./host-identity-fixture.mjs'").replaceAll("'../host/runner-job-hook.mjs'","'./node_modules/@nibfin/core/host/runner-job-hook.mjs'").replaceAll("'../host/entry.mjs'", "'@nibfin/core/protected-host'").replaceAll("'../src/index.mjs'", "'@nibfin/core'").replaceAll("'../tooling/workflow-fixture.mjs'", "'./workflow-fixture.mjs'").replaceAll("'../tooling/registration-fixture.mjs'", "'./registration-fixture.mjs'").replace("'../tooling/core-fixture.mjs'", "'./core-fixture.mjs'").replaceAll("'../tooling/fanout-fixture.mjs'", "'./fanout-fixture.mjs'").replace("'../tooling/recovery-fixture.mjs'", "'./recovery-fixture.mjs'").replace("'../tooling/completion-fixture.mjs'", "'./completion-fixture.mjs'").replace("'../tooling/final-review-fixture.mjs'", "'./final-review-fixture.mjs'").replace("'../tooling/candidate-publication-fixture.mjs'", "'./candidate-publication-fixture.mjs'").replace("'../tooling/repair-fixture.mjs'", "'./repair-fixture.mjs'").replaceAll("'../tooling/evidence-fixture.mjs'", "'./evidence-fixture.mjs'").replace("'../tooling/grant-fixture.mjs'", "'./grant-fixture.mjs'").replace("'../tooling/accept-fixture.mjs'", "'./accept-fixture.mjs'").replace("'../tooling/wsl-fixture.mjs'", "'./wsl-fixture.mjs'").replace("'../tooling/shape-fixture.mjs'", "'./shape-fixture.mjs'").replace("'../tooling/dynamic-fixture.mjs'", "'./dynamic-fixture.mjs'").replace("'../tooling/codex-fixture.mjs'", "'./codex-fixture.mjs'").replace("'../tooling/custody-fixture.mjs'", "'./custody-fixture.mjs'").replace("'../tooling/operations-fixture.mjs'", "'./operations-fixture.mjs'").replace("'../tooling/relay-fixture.mjs'", "'./relay-fixture.mjs'").replaceAll(/\b(from\s*|import\s*\(\s*)'\.\.\/src\/([^']+)'/g,"$1'./node_modules/@nibfin/core/src/$2'"));
      const result = execFileSync(process.execPath, ['--test', file], {cwd:consumer,env,encoding:'utf8'});
      if (!result.includes('# fail 0')) throw Error('Installed controlled operation contract failed');
      console.log('Installed consumer',file, result.match(/^# tests \d+/m)?.[0], result.match(/^# pass \d+/m)?.[0]);
    }
    if (release) {
      for (const name of ['release-manifest.json','compatibility.json']) {
        writeFileSync(join(consumer,name),readFileSync(join(dirname(archivePath),name)));
      }
      writeFileSync(join(consumer,'nibfin-core.tgz'),readFileSync(archivePath));
    }
    writeFileSync(join(consumer, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import {dynamicFixture} from './dynamic-fixture.mjs';
const df = dynamicFixture();
assert.equal((await df.evaluate()).outcome,'ready');
df.edges.set('1',['2']);
assert.equal((await df.evaluate()).outcome,'waiting');
import {selectionFixture} from './selection-fixture.mjs';
const sf = selectionFixture();
const sd = await sf.select();
assert.equal(sd.outcome,sf.expected.outcome);
assert.equal(sd.memberId,sf.expected.memberId);
import {actionsFixture} from './actions-fixture.mjs';
const af = await actionsFixture();
const av = af.verifier();
const authenticated = await av.authenticate(await af.sign(), af.expected);
assert.equal(authenticated.ok,true);
assert.ok(import.meta.resolve('jose').startsWith('file://' + process.cwd() + '/node_modules/jose/'));
assert.equal((await av.authenticate('invalid',af.expected)).ok,false);
assert.equal(av.predecessor({source:authenticated,receipt:{}}).ok,false);
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {githubId, repositoryCoordinates, memberRunnerLabel, prepareGrant, signGrant, verifyGrant, createGithubProvider, observeRunners, parseCandidateObligations, validateCandidateFiles} from '@nibfin/core';
import {generateKeyPairSync} from 'node:crypto';
import {exportAuthority, importAuthority, authoritySnapshot, verifyAuthority, synchronizeAuthority} from '@nibfin/core';
import {skillForRole, parseStageResult, compareCompatibility, compareEvidence, createAuthorizationBoundary, bodyDigest} from '@nibfin/core';
const {createRepairFlow, invalidateRepairEvidence} = await import('@nibfin/core');
assert.equal(typeof createRepairFlow,'function');
assert.equal(typeof invalidateRepairEvidence,'function');
const {createAgentEnvironments, createAgentLifecycle} = await import('@nibfin/core');
const {selectInstructions, createAssigneeSelector} = await import('@nibfin/core');
assert.equal(typeof createAssigneeSelector,'function');
for (const skill of ['shape','deliver','accept']) {
  const selected = selectInstructions({skill,role:skill});
  assert.equal(selected.identity,bodyDigest(selected.content));
  assert.equal(selected.source,'builtin');
  const asset = new URL('../skills/' + skill + '/SKILL.md', import.meta.resolve('@nibfin/core'));
  assert.equal(selected.content,(await import('node:fs')).readFileSync(asset,'utf8'));
}

const {verifyDeployment, deploymentHealthDisposition} = await import('@nibfin/core');
assert.equal((await verifyDeployment({policy:{mode:'not-applicable',reason:'No obligation'}})).status,'not-applicable');
assert.equal((await verifyDeployment({policy:{mode:'required'}})).status,'blocked');
assert.equal((await deploymentHealthDisposition({target:{issueId:'I'},selectors:[],baselines:[],observations:[]})).permission,false);
const registry = createAgentEnvironments();
const descriptor = {id:'env',agent:'fixture',loginSpace:'/fixture/login',instances:[{id:'one',workspace:'/fixture/work',registration:'/fixture/reg',service:'/fixture/service'}]};
assert.equal(registry.describe(descriptor).agent, 'fixture');
assert.throws(() => registry.describe({...descriptor,agent:'other'}));
assert.equal(typeof createAgentLifecycle, 'function');
assert.equal(skillForRole('shape-validator'), 'shape');
assert.throws(() => skillForRole('scope'));
assert.equal(parseStageResult({version:1, outcome:'ready', failureClass:'none', summary:'ok', conflicts:[]}).outcome, 'ready');
assert.throws(() => compareCompatibility({version:99}, {version:99}));
const digest = 'a'.repeat(64);
const evidence = {version:1, stage:'shape', binding:{authority:digest, grant:digest, policy:digest,
  core:digest, runtime:digest, instructions:digest, repositoryId:'42', issueId:'I_1', scopeHash:digest, shapeHash:null},
  execution:{role:'shape', skill:'shape', id:'author', request:'req', result:'result', source:null},
  inputs:{body:digest}, result:{version:1,outcome:'ready',failureClass:'none',summary:'ok',conflicts:[]}};
assert.deepEqual(compareEvidence(evidence, {expected:evidence, consumed:[]}), evidence);
const lifecycleEvidence = structuredClone(evidence);
lifecycleEvidence.binding.instructions = bodyDigest('approved');
const lifecycle = createAgentLifecycle({environment:registry.describe(descriptor),instanceId:'one',
  current:()=>({expected:lifecycleEvidence,consumed:[]}),backend:{
    readiness:async()=>({login:'available',tool:'available',isolation:'verified',read:'verified',write:'verified',evidence:['fixture'],limitations:[]}),
    start:async()=>({status:'started'}), collect:async()=>({status:'complete',exitCode:0,evidence:lifecycleEvidence}),
    stop:async()=>({status:'requested'}), termination:async()=>({status:'terminated'}),
    cleanup:async()=>({status:'completed',residuals:[]})}});
const lifecycleInput={execution:lifecycleEvidence.execution,binding:lifecycleEvidence.binding,
  instructions:{identity:bodyDigest('approved'),content:'approved'},visibility:'public',ownership:'organization'};
assert.equal((await lifecycle.start(lifecycleInput)).start.status,'started');
assert.equal((await lifecycle.collect('author')).result.status,'valid');
await assert.rejects(lifecycle.collect('author'));
await lifecycle.termination('author');
assert.equal((await lifecycle.cleanup()).status,'completed');

assert.throws(() => compareEvidence(evidence, {expected:evidence, consumed:['result']}));

assert.equal(githubId('9007199254740993'), '9007199254740993');
assert.equal(repositoryCoordinates('Example-Org', 'Core').key, 'example-org/core');
assert.equal(memberRunnerLabel('42'), 'nibfin-user-42');
assert.throws(() => githubId('01'), TypeError);
assert.equal(parseCandidateObligations('missing').ok, false);
const obligationBody = ['Candidate hooks applicability: No configured hooks.', '\`\`\`kairo-candidate', JSON.stringify({artifacts:[{path:'package.json',purpose:'consumer'}],hooks:[]}), '\`\`\`'].join('\\n');
const parsedObligations = parseCandidateObligations(obligationBody);
assert.equal(parsedObligations.ok, true);
assert.equal(validateCandidateFiles(parsedObligations.inventory, {root:process.cwd(), permittedPaths:['package.json']}).ok, true);
const providerCalls = [];
const providerContext = Object.freeze({operation:'close',target:'42'});
const provider = createGithubProvider({authorize: r => r.context === providerContext && r.target === '42' && r.operation === 'close',
  transport: async r => {providerCalls.push(r); return {status:200, headers:{}, body:'{"id":42}'};}});
assert.equal((await provider.request({endpoint:'/user', operation:'user', correlation:'smoke', target:'42'})).data.id, '42');
assert.equal((await provider.request({endpoint:'/repos/org/core/issues/1', method:'PATCH', operation:'close', correlation:'smoke', target:'42', context:providerContext, body:{state:'closed'}})).outcome, 'submitted');
assert.equal(providerCalls.length, 2);
assert.equal(providerCalls[1].headers['X-GitHub-Api-Version'], '2022-11-28');
assert.equal(providerCalls[1].headers.Accept, 'application/vnd.github+json');
assert.equal(providerCalls[1].body, JSON.stringify({state:'closed'}));
const runnerTarget = {owner:'org',repository:'core',id:'42',ownerId:'7',ownerType:'Organization'};
const runnerInput = {target:runnerTarget, registration:{level:'repository',id:'42'}, records:[
  {instanceId:'one',runnerId:'91',memberId:'8',repositoryId:'42',platform:'linux',registration:{level:'repository',id:'42'}}],
  conditions:{labels:['self-hosted','linux'],platform:'linux'},correlation:'consumer'};
const runnerProvider = createGithubProvider({transport:async r => {
  assert.equal(r.method,'GET');
  const data = r.endpoint === '/repos/org/core' ? {id:'42',owner:{id:'7',type:'Organization'},full_name:'org/core',private:false,visibility:'public'}
    : {total_count:1,runners:[{id:'91',name:'one',os:'linux',status:'online',busy:true,labels:
      ['self-hosted','Linux','nibfin-user-8'].map(name=>({name,type:'custom'}))}]};
  return {status:200,headers:{},body:JSON.stringify(data)};
}});
assert.equal((await observeRunners(runnerProvider,runnerInput)).outcome,'matched');
assert.equal((await observeRunners(runnerProvider,{...runnerInput,target:{...runnerTarget,id:'01'}})).outcome,'unavailable');

// Installed package boundary: actual provider responses, native CI success and failure.
const {observeGithubCI} = await import('@nibfin/core');
const ciExpected = {repository:'example-org/core',repositoryId:'42',prId:'43',pr:7,
  head:'a'.repeat(40),baseSha:'b'.repeat(40),baseRepositoryId:'42',baseBranch:'main'};
let ciConclusion = 'success';
const ciProvider = createGithubProvider({transport:async r=>{
  assert.equal(r.method,'GET');
  const p=r.endpoint.slice('/repos/example-org/core'.length);
  const data = p===''?{id:42,full_name:'example-org/core',private:false,visibility:'public',owner:{type:'Organization'}}:
    p==='/pulls/7'?{id:43,number:7,head:{sha:ciExpected.head},base:{sha:ciExpected.baseSha,ref:'main',repo:{id:42}}}:
    p==='/branches/main'?{name:'main',protected:true,commit:{sha:ciExpected.baseSha}}:
    p==='/branches/main/protection'?{required_status_checks:{strict:true,contexts:['build'],checks:[{context:'build',app_id:15368}]}}:
    p.startsWith('/commits/')&&p.includes('/check-runs?')?{total_count:1,check_runs:[{id:44,name:'build',head_sha:ciExpected.head,app:{id:15368},status:'completed',conclusion:ciConclusion}]}:
    p.startsWith('/rules/branches/')||p.endsWith('/statuses?per_page=100')?[]:null;
  assert.notEqual(data,null,'Unexpected CI endpoint');
  return {status:200,body:JSON.stringify(data)};
}});
assert.equal((await observeGithubCI({provider:ciProvider,expected:ciExpected})).qualifies,true);
ciConclusion='failure';
assert.equal((await observeGithubCI({provider:ciProvider,expected:ciExpected})).status,'failed');
const entry = realpathSync(fileURLToPath(import.meta.resolve('@nibfin/core')));
assert.equal(entry, process.cwd() + '/node_modules/@nibfin/core/src/index.mjs');
const input = ${JSON.stringify(grantFixture(bodyDigest))};
const {draft, summary} = prepareGrant(input);
assert.ok(summary.includes('DRAFT ONLY'));
const keys = generateKeyPairSync('ed25519');
const privateKey = keys.privateKey.export({type: 'pkcs8', format: 'pem'});
const publicKey = keys.publicKey.export({type: 'spki', format: 'pem'});
const grant = JSON.parse(JSON.stringify(signGrant(draft, {keyId: 'owner-1', privateKey})));
const context = {trustedKeys: new Map([['owner-1', publicKey]]), now: 1000,
  revocation: {id: draft.revocationId, available: true, revokedRecords: []},
  expectedAuthority: draft.authority, expectedWork: draft.work, expectedPolicy: draft.policy,
  request: {repository: draft.work[0].repository, issueId: draft.work[0].issueId,
    number: draft.work[0].number, path: 'src/file.mjs', operation: 'deliver'}};
assert.deepEqual(verifyGrant(grant, context), {ok: true, category: 'authorized'});
const authorization = createAuthorizationBoundary({now:()=>1100,maxCheckpointMs:100,
  identity:'hosted-authorized',getCheckpoint:()=>({request:context.request,grant,grantContext:context,
    member:{id:'42',login:'member'},operator:{kind:'service',id:'app-1',source:'hosted-authorized',trusted:true},
    write:{method:'PATCH',endpoint:'/repos/example-org/core/issues/101',target:'123'}}),
  transport:async r=>({status:200,body:JSON.stringify(r.method==='PATCH'?{id:123}:
    r.endpoint==='/repos/example-org/core'?{id:context.request.repository.id,full_name:'example-org/core',private:false,visibility:'public',owner:{login:'example-org',type:'Organization'}}:
    r.endpoint.endsWith('/issues/101')?{id:123,node_id:'I_101',number:101,repository_url:'https://api.github.com/repos/example-org/core',assignees:[{id:42,login:'member'}]}:
    r.endpoint.endsWith('/permission')?{permission:'write',user:{id:42,login:'member'}}:{id:42,login:'member'})})});
assert.equal((await authorization.eligibility()).ok,true);
assert.equal((await authorization.request({method:'PATCH',endpoint:'/repos/example-org/core/issues/101',
  target:'123',operation:'deliver',correlation:'smoke',body:{title:'new'}})).outcome,'submitted');
context.revocation.available=false;
assert.equal((await authorization.eligibility()).ok,false);
context.revocation.available=true;
const exported = exportAuthority({source:'https://github.com/example-org/core/issues/101',
  revision:'1', approvalId:'approval-1', cycle:'cycle-1', components:[
    {id:'section',kind:'section',body:'Hello\\n世界',references:['attachment']},
    {id:'attachment',kind:'attachment',body:'AAEC',references:[]}]});
const approvedPayload = {...draft, authority:authoritySnapshot(exported)};
const approvedGrant = signGrant(approvedPayload, {keyId:'owner-1',privateKey});
const verification = {grant:approvedGrant, grantContext:{...context, expectedAuthority:approvedPayload.authority},
  expected:{source:exported.source,revision:'1',approvalId:'approval-1',cycle:'cycle-1'}};
const imported = importAuthority(JSON.stringify(exported));
const verified = verifyAuthority(imported, verification);
assert.equal(verified.ok, true);
const nextExport = exportAuthority({...verification.expected, revision:'2',cycle:'cycle-2',
  approvalId:'approval-2',components:exported.components});
const nextPayload = {...draft,authority:authoritySnapshot(nextExport)};
const nextVerification = {grant:signGrant(nextPayload,{keyId:'owner-1',privateKey}),
  grantContext:{...context,expectedAuthority:nextPayload.authority},
  expected:{source:exported.source,revision:'2',approvalId:'approval-2',cycle:'cycle-2'}};
const transition = synchronizeAuthority({active:verified.binding, expectedPrevious:verified.binding,
  replacement:nextExport, verification:nextVerification,
  authorization:{previousIdentity:exported.identity,replacementIdentity:nextExport.identity,cycle:'cycle-2'}});
assert.equal(transition.status,'replaced');
assert.equal(verifyAuthority(imported,nextVerification).ok,false);
assert.equal(verifyGrant(approvedGrant,nextVerification.grantContext).ok,false);
context.request.operation = 'merge';
assert.deepEqual(verifyGrant(grant, context), {ok: false, category: 'operation'});
const {custodyFixture} = await import('./custody-fixture.mjs');
const custodyTest = custodyFixture();
const retained = await custodyTest.publish();
assert.equal(retained.outcome, 'retained');
custodyTest.payloads.clear();
const recovered = await custodyTest.fresh().retrieve({ref:retained.ref, expected:custodyTest.expected});
assert.equal(recovered.outcome, 'retrieved');
assert.deepEqual(recovered.payloads.get('out/ignored.bin'), Buffer.from([0,255,1,128]));
assert.equal((await custodyTest.fresh().retrieve({ref:retained.ref, expected:{...custodyTest.expected,attempt:'2'}})).outcome, 'failed');
${release ? `
const {verifyRelease,releaseComponents,workflowInstallation} = await import('@nibfin/core');
const fs = await import('node:fs');
const releaseManifest=JSON.parse(fs.readFileSync('release-manifest.json'));
const compatibilityBytes=fs.readFileSync('compatibility.json');
verifyRelease({manifest:releaseManifest,compatibility:JSON.parse(compatibilityBytes),compatibilityBytes,
  archive:fs.readFileSync('nibfin-core.tgz'),expectedVersion:releaseManifest.version,expectedSource:releaseManifest.source});
assert.deepEqual(releaseComponents(),releaseManifest.components);
const installation=workflowInstallation({commit:'a'.repeat(40),hostCommit:'b'.repeat(40),hostRepository:'taco3064/nibfin'});
assert.equal(installation.coreVersion,releaseManifest.version);
assert.ok(installation.files.size>0);
assert.throws(()=>verifyRelease({manifest:releaseManifest,compatibility:JSON.parse(compatibilityBytes),compatibilityBytes,
  archive:fs.readFileSync('nibfin-core.tgz'),expectedVersion:'9.9.9',expectedSource:releaseManifest.source}));
console.log('Installed release identities, exact pin rejection and workflow installation passed');
` : ''}
console.log('Installed archive consumer passed (real Grant signatures and rejection):', entry);
`);
    const smoke = execFileSync(process.execPath, ['smoke.mjs'], {cwd: consumer, env, encoding: 'utf8'}).trim();
    writeFileSync(join(consumer, 'workspace.test.mjs'), readFileSync(join(root, 'test/workspace.test.mjs'), 'utf8').replace("'../src/index.mjs'", "'@nibfin/core'"));
    const workspace = execFileSync(process.execPath, ['--test', 'workspace.test.mjs'], {cwd: consumer, env, encoding: 'utf8'});
    if (!workspace.includes('# fail 0')) throw Error('Installed workspace contract failed');
    writeFileSync(join(consumer, 'deployment.test.mjs'), readFileSync(join(root, 'test/deployment.test.mjs')));
    const deployment = execFileSync(process.execPath, ['--test', 'deployment.test.mjs'], {cwd: consumer, env, encoding: 'utf8'});
    if (!deployment.includes('# fail 0')) throw Error('Installed deployment contract failed');
    return smoke + '\nInstalled publication/restart/relay/controlled operation/concurrency public contracts passed\nInstalled deployment public contract: 5 tests passed; installed workspace contract: 6 tests passed';
  } catch (error) {
    // node:test emits assertion diagnostics on stdout, including on failure.
    // Retain those credential-free consumer diagnostics rather than just exit 1.
    throw new Error(`Archive consumer failed: ${error.message}\n${error.stdout?.toString() ?? ''}\n${error.stderr?.toString() ?? ''}`, {cause: error});
  } finally {
    rmSync(consumer, {recursive: true, force: true});
  }
}

// Packing and byte validation do not execute the installed consumer suite.
// Keep that gate in buildArchive, including every CLI/release entry point.
export function packArchive(producer = root) {
  const output = join(producer, 'out');
  mkdirSync(output, {recursive: true});
  const result = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', output],
    {cwd: producer, encoding: 'utf8'}));
  const archivePath = join(output, 'nibfin-core.tgz');
  renameSync(join(output, result[0].filename), archivePath);
  console.log('Archive entries:', verifyArchive(readFileSync(archivePath), producer).join(', '));
  return archivePath;
}

export function buildArchive(producer = root) {
  const archivePath = packArchive(producer);
  console.log(consumeArchive(archivePath));
  return archivePath;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if(process.argv[2]==='--verify' && process.argv.length===4) {
    const path=resolve(process.argv[3]);verifyArchive(readFileSync(path));console.log(consumeArchive(path));
  } else if(process.argv.length===2) buildArchive();
  else throw Error('Usage: archive.mjs [--verify archive.tgz]');
}
