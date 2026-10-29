import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {selectTests,changedFiles} from '../../tooling/ci-tests.mjs';

const fixture = () => new Map([
  ['src/index.mjs',"export {alpha} from './alpha.mjs'; export {beta} from './beta.mjs';"],
  ['src/alpha.mjs','export function alpha() {}'],
  ['src/beta.mjs',"import {alpha as dependency} from './index.mjs'; export function beta() { return dependency(); }"],
  ['src/other.mjs','export function other() {}'],
  ['tooling/beta-fixture.mjs',"import {beta} from '../src/index.mjs'; export const setup = beta;"],
  ['test/alpha.test.mjs',"import {alpha} from '../src/index.mjs'; alpha();"],
  ['test/beta.test.mjs',"import {setup} from '../tooling/beta-fixture.mjs'; setup();"],
  ['test/other.test.mjs',"import {other} from '../src/other.mjs'; other();"],
  ['test-sdk/alpha.test.mjs',"import {alpha} from '../src/index.mjs'; alpha();"],
]);
const plan = (changed, files=fixture(), event='pull_request') => selectTests({files,changed,event});

test('selects direct and transitive barrel/fixture consumers, excludes unrelated tests',()=>{
  const result=plan(['src/alpha.mjs']);
  assert.equal(result.mode,'scoped');
  assert.deepEqual(result.tests,['test/alpha.test.mjs','test/beta.test.mjs']);
  assert.equal(result.sdk,true);assert.equal(result.archive,false);assert.equal(result.website,false);
  assert.deepEqual(plan(['src/other.mjs']).tests,['test/other.test.mjs']);
  assert.deepEqual(plan(['tooling/beta-fixture.mjs']).tests,['test/beta.test.mjs']);
});

test('independent controller changes use their own regression while mixed product changes retain gates',()=>{
 const result=plan(['controller/src/core.mjs','controller/test/core.test.mjs','.github/workflows/controller-ci.yml','tooling/ci-tests.mjs','.github/tests/pr-test-plan.test.mjs']);
 assert.equal(result.mode,'scoped');assert.deepEqual(result.tests,[]);assert.equal(result.archive,false);assert.equal(result.website,false);
 for(const path of ['src/alpha.mjs','package.json','host/entry.mjs','workflow/templates/nibfin-stage.yml'])assert.equal(plan(['controller/src/core.mjs',path]).mode,'full');
 assert.equal(plan(['controller/src/core.mjs'],fixture(),'push').mode,'full');
 assert.equal(plan(['tooling/ci-tests.mjs']).mode,'full');
});

test('test-only, website-only, matching docs and combined changes retain their scopes',()=>{
  assert.deepEqual(plan(['test/beta.test.mjs']).tests,['test/beta.test.mjs']);
  const website=plan(['website/src/page.astro']);assert.equal(website.mode,'scoped');
  assert.deepEqual(website.tests,[]);assert.equal(website.website,true);assert.equal(website.sdk,false);
  const docs=plan(['docs/alpha.md']);assert.equal(docs.website,true);assert.equal(docs.tests.length,2);
  const mixed=plan(['website/src/page.astro','src/other.mjs']);assert.equal(mixed.website,true);assert.equal(mixed.tests.length,1);
});

test('unknown, removed, shared inputs and non-PR runs conservatively select full checks',()=>{
  for (const paths of [[],['src/index.mjs'],['package-lock.json'],['host/entry.mjs'],['skills/accept/SKILL.md'],
    ['.github/workflows/core-ci.yml'],['tooling/archive.mjs'],['src/removed.mjs'],['test/deleted.test.mjs'],['docs/unknown.md'],['new/input.json']]) {
    const result=plan(paths);assert.equal(result.mode,'full',paths.join(','));
    assert.equal(result.tests.length,3);assert(result.sdk&&result.archive&&result.website);
  }
  assert.equal(plan(['src/other.mjs'],fixture(),'push').mode,'full');
  const uncovered=fixture();uncovered.set('src/new.mjs','export const newThing = 1;');
  assert.equal(plan(['src/new.mjs'],uncovered).mode,'full');
});

test('namespace and dynamic barrel consumers are included on source changes',()=>{
  const files=fixture();files.set('test/dynamic.test.mjs',"const api = await import('../src/index.mjs'); api[process.env.KEY]();");
  files.set('test/namespace.test.mjs',"import * as api from '../src/index.mjs'; api[process.env.KEY]();");
  const result=plan(['src/alpha.mjs'],files);
  assert(result.tests.includes('test/dynamic.test.mjs'));assert(result.tests.includes('test/namespace.test.mjs'));
});

test('recursive package-consumer suites run on direct changes or full gates, not ordinary module PRs',()=>{
  const files=fixture();files.set('test/archive.test.mjs',"import {alpha} from '../src/index.mjs';");
  files.set('test/release.test.mjs',"import {beta} from '../src/index.mjs';");
  assert(!plan(['src/alpha.mjs'],files).tests.includes('test/archive.test.mjs'));
  assert.deepEqual(plan(['test/archive.test.mjs'],files).tests,['test/archive.test.mjs']);
  assert(plan(['src/archive.mjs'],files).tests.includes('test/archive.test.mjs'));
  assert(plan(['src/alpha.mjs'],files,'push').tests.includes('test/release.test.mjs'));
});

test('real Git diff uses merge base, preserves rename/delete paths and rejects missing SHAs',t=>{
  const cwd=mkdtempSync(join(tmpdir(),'nibfin-ci-diff-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
  git('init');git('config','user.name','CI fixture');git('config','user.email','ci@example.invalid');
  mkdirSync(join(cwd,'src'));writeFileSync(join(cwd,'src/old.mjs'),'export const x = 1;');
  git('add','.');git('commit','-m','base');const base=git('rev-parse','HEAD');
  git('mv','src/old.mjs','src/new.mjs');git('commit','-m','rename');const head=git('rev-parse','HEAD');
  assert.deepEqual(changedFiles(base,head,cwd).sort(),['src/new.mjs','src/old.mjs']);
  git('checkout','-b','advanced-base',base);writeFileSync(join(cwd,'base-only.txt'),'not a PR change');
  git('add','.');git('commit','-m','advance base');
  assert.deepEqual(changedFiles(git('rev-parse','HEAD'),head,cwd).sort(),['src/new.mjs','src/old.mjs']);
  assert.throws(()=>changedFiles('',head,cwd),/invalid-commit/);
  assert.throws(()=>changedFiles('a'.repeat(40),head,cwd));
});

test('runner does not discover all tests for an explicitly empty selection and propagates failures',t=>{
  const cwd=mkdtempSync(join(tmpdir(),'nibfin-ci-run-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  const planPath=join(cwd,'plan.json');const command=fileURLToPath(new URL('../../tooling/ci-tests.mjs',import.meta.url));
  const invoke=()=>execFileSync(process.execPath,[command,'run'],{env:{...process.env,NIBFIN_CI_PLAN:planPath},encoding:'utf8',stdio:'pipe'});
  writeFileSync(planPath,JSON.stringify({tests:[]}));assert.match(invoke(),/No root suites affected/);
  writeFileSync(planPath,JSON.stringify({tests:['../escape.test.mjs']}));assert.throws(invoke);
});

test('workflow contract retains required checks, main full run, pinned actions and wakeup identity',()=>{
  const core=readFileSync(new URL('../workflows/core-ci.yml',import.meta.url),'utf8').replaceAll('\r\n','\n');
  assert.match(core,/name: Core package/);assert.match(core,/\n  core:\n/);
  assert.match(core,/fetch-depth: 0/);assert.match(core,/PR_BASE_SHA: \$\{\{ github.event.pull_request.base.sha \}\}/);
  // Runtime prerequisites must fail before suites, including the installed
  // consumers, rather than silently skipping subprocess/cancellation coverage.
  assert.match(core,/uses: actions\/setup-python@[a-f0-9]{40}[\s\S]*python-version: '3\.11'/);
  const probe=core.indexOf('src/verification-supervisor.py --probe');
  assert(probe>0&&probe<core.indexOf('run: node tooling/ci-tests.mjs run'));
  assert.match(core,/env -i PATH=\/usr\/bin:\/bin \/usr\/bin\/python3 -I -S/);
  for(const name of ['node','npm'])assert(core.includes('/usr/local/bin/'+name+' --version'));
  assert.match(core,/run: node tooling\/ci-tests.mjs run/);assert.match(core,/run: npm run verify:archive\n\s+if: steps.plan.outputs.archive == 'true'/);
  const website=readFileSync(new URL('../workflows/website-ci.yml',import.meta.url),'utf8').replaceAll('\r\n','\n');
  assert.match(website,/\n  website:\n/);assert.match(website,/always\(\) && steps.plan.outputs.website == 'true'/);
  for (const text of [core,website]) for (const match of text.matchAll(/uses: (actions\/[^\s]+)/g)) assert.match(match[1],/@[a-f0-9]{40}$/);
});
