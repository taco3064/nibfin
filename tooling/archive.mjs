import {gunzipSync} from 'node:zlib';
import {readFileSync, mkdirSync, renameSync, mkdtempSync, writeFileSync, rmSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, join, dirname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {grantFixture} from './grant-fixture.mjs';
import {bodyDigest} from '../src/index.mjs';

export const packageFiles = ['src/actions.mjs', 'src/lifecycle.mjs', 'docs/lifecycle.md', 'src/authorization.mjs', 'docs/authorization.md', 'src/authority.mjs', 'docs/authority.md', 'README.md', 'docs/package.md', 'package.json', 'src/index.mjs', 'src/grants.mjs', 'src/evidence.mjs', 'docs/evidence.md', 'src/provider.mjs', 'src/obligations.mjs', 'src/custody-upload.mjs', 'src/custody.mjs', 'src/custody-zip.mjs', 'docs/custody.md'];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Read the actual tar payload without extracting attacker-controlled paths.
export function inspectArchive(archive) {
  const tar = gunzipSync(archive);
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (!tar.subarray(offset).every(byte => byte === 0)) throw new Error('Trailing tar data');
      return files;
    }
    const field = (start, length) => header.subarray(start, start + length).toString().replace(/\0.*$/s, '');
    const octal = text => {
      if (!/^[0-7]+$/.test(text.trim())) throw new Error('Invalid tar number');
      return parseInt(text.trim(), 8);
    };
    const checksum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== octal(field(148, 8))) throw new Error('Invalid tar checksum');
    const name = field(0, 100);
    const size = octal(field(124, 12));
    if (field(345, 155) || !['0', ''].includes(field(156, 1)) || !name.startsWith('package/')) {
      throw new Error(`Unsupported archive entry: ${name}`);
    }
    const path = name.slice(8);
    if (!packageFiles.includes(path) || files.has(path)) throw new Error(`Forbidden or duplicate archive entry: ${path}`);
    offset += 512;
    if (offset + size > tar.length) throw new Error('Truncated tar entry');
    files.set(path, tar.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  throw new Error('Missing tar terminator');
}

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
  return [...files.keys()].sort();
}

export function consumeArchive(archivePath) {
  const consumer = mkdtempSync(join(tmpdir(), 'nibfin-consumer-'));
  try {
    if (realpathSync(consumer).startsWith(root + sep)) throw new Error('Consumer is inside producer');
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({private: true, type: 'module'}));
    // Deliberately pass no inherited credential or npm configuration variables.
    const env = {PATH: process.env.PATH, HOME: consumer, npm_config_cache: join(consumer, 'cache'),
      npm_config_userconfig: join(consumer, 'empty-npmrc'), npm_config_globalconfig: join(consumer, 'global-npmrc')};
    const dependency = join(consumer, 'jose.tgz');
    const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', consumer], {cwd:join(root,'node_modules/jose'), env, encoding:'utf8'}));
    renameSync(join(consumer, packed[0].filename), dependency);
    execFileSync('npm', ['cache', 'add', dependency], {cwd:consumer, env, stdio:'pipe'});
    execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', dependency, resolve(archivePath)],
      {cwd: consumer, env, stdio: 'pipe'});
    writeFileSync(join(consumer, 'custody-fixture.mjs'), readFileSync(join(root, 'tooling/custody-fixture.mjs'), 'utf8').replace("'../src/index.mjs'", "'@nibfin/core'"));
    writeFileSync(join(consumer, 'actions-fixture.mjs'), readFileSync(join(root, 'tooling/actions-fixture.mjs'), 'utf8').replace("'../src/index.mjs'", "'@nibfin/core'"));
    writeFileSync(join(consumer, 'smoke.mjs'), `
import assert from 'node:assert/strict';
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
import {githubId, repositoryCoordinates, memberRunnerLabel, prepareGrant, signGrant, verifyGrant, createGithubProvider, parseCandidateObligations, validateCandidateFiles} from '@nibfin/core';
import {generateKeyPairSync} from 'node:crypto';
import {exportAuthority, importAuthority, authoritySnapshot, verifyAuthority, synchronizeAuthority} from '@nibfin/core';
import {skillForRole, parseStageResult, compareCompatibility, compareEvidence, createAuthorizationBoundary, bodyDigest} from '@nibfin/core';
const {createAgentEnvironments, createAgentLifecycle} = await import('@nibfin/core');
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
assert.equal(providerCalls[1].headers['X-GitHub-Api-Version'], '2026-03-10');
assert.equal(providerCalls[1].headers.Accept, 'application/vnd.github+json');
assert.equal(providerCalls[1].body, JSON.stringify({state:'closed'}));
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
const exported = exportAuthority({source:'https://app.notion.com/p/40006b644a2080dab1a8c2e562f95373',
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
console.log('Installed archive consumer passed (real Grant signatures and rejection):', entry);
`);
    return execFileSync(process.execPath, ['smoke.mjs'], {cwd: consumer, env, encoding: 'utf8'}).trim();
  } catch (error) {
    throw new Error(`Archive consumer failed: ${error.message}\n${error.stderr?.toString() ?? ''}`, {cause: error});
  } finally {
    rmSync(consumer, {recursive: true, force: true});
  }
}

export function buildArchive(producer = root) {
  const output = join(producer, 'out');
  mkdirSync(output, {recursive: true});
  const result = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', output],
    {cwd: producer, encoding: 'utf8'}));
  const archivePath = join(output, 'nibfin-core.tgz');
  renameSync(join(output, result[0].filename), archivePath);
  console.log('Archive entries:', verifyArchive(readFileSync(archivePath), producer).join(', '));
  console.log(consumeArchive(archivePath));
  return archivePath;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildArchive();
