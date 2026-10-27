import {readFileSync, writeFileSync, appendFileSync, existsSync} from 'node:fs';
import {resolve, dirname, posix} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync, spawnSync} from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const word = value => value.match(/[A-Za-z_$][\w$]*/g) ?? [];
const suite = path => /^test\/[^/]+\.test\.mjs$/.test(path);
const packageSuites = new Set(['test/archive.test.mjs','test/release.test.mjs']);

// Conservative reverse dependency selection, including public barrel symbols.
// Identifier matches may over-select (including comments); they never rely on
// file names alone to infer that a consumer is unaffected.
export function selectTests({files, changed, event = 'pull_request'}) {
  const all = [...files.keys()].filter(suite).sort();
  const full = reason => ({mode:'full', reason, changed, tests:all, sdk:true, archive:true, website:true});
  if (event !== 'pull_request') return full('Main/manual runs retain full verification');
  if (!changed.length) return full('Empty or unavailable change set');
  const symbols = new Map();
  for (const match of (files.get('src/index.mjs') ?? '').matchAll(/export\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const target = posix.normalize(posix.join('src', match[2]));
    for (const name of word(match[1])) {
      if (name === 'as') continue;
      if (!symbols.has(name)) symbols.set(name, new Set());
      symbols.get(name).add(target);
    }
  }
  const dependencies = new Map();
  for (const [path, text] of files) {
    if (!path.endsWith('.mjs')) continue;
    const deps = new Set();
    for (const match of text.matchAll(/['"](\.{1,2}\/[^'"\r\n]+)['"]/g)) {
      const target = posix.normalize(posix.join(posix.dirname(path), match[1]));
      // index.mjs eagerly loads all exports, but its named consumers are mapped
      // by symbols below. Changes to the barrel itself always select everything.
      if (target !== 'src/index.mjs' && files.has(target)) deps.add(target);
    }
    for (const name of word(text)) for (const target of symbols.get(name) ?? []) deps.add(target);
    // Namespace/dynamic access can compute an export name; no narrow proof.
    if (/import\s*\*\s*as|import\s*\(\s*['"](?:[^'"]*index\.mjs|@nibfin\/core)['"]/.test(text)) deps.add('src/index.mjs');
    dependencies.set(path, deps);
  }
  const affected = new Set(changed);
  let website = changed.some(path => path.startsWith('website/') || path.startsWith('docs/') || path === 'README.md');
  for (const path of changed) {
    if (path.startsWith('website/')) continue;
    if (suite(path) && files.has(path)) continue;
    if (path === 'src/archive.mjs' || path === 'src/release.mjs') return full('Package/release boundary changed: ' + path);
    if (path.startsWith('docs/') && path.endsWith('.md')) {
      const source = 'src/' + posix.basename(path, '.md') + '.mjs';
      if (!files.has(source)) return full('Documentation has no unambiguous module: ' + path);
      affected.add(source);
      continue;
    }
    if (/^(src|tooling)\/[^/]+\.mjs$/.test(path) && files.has(path) && path !== 'src/index.mjs') {
      if (path.startsWith('tooling/') && !path.endsWith('-fixture.mjs')) return full('Shared tooling changed: ' + path);
      continue;
    }
    if (/^test\/[\w-]+-fixture\.mjs$/.test(path) && files.has(path)) continue;
    if (/^test-sdk\/[^/]+\.test\.mjs$/.test(path) && files.has(path)) continue;
    return full('Shared, removed, or unclassified input changed: ' + path);
  }
  let size;
  do {
    size = affected.size;
    for (const [path, deps] of dependencies) if ([...deps].some(dep => affected.has(dep))) affected.add(path);
  } while (affected.size !== size);
  // These suites intentionally build/consume the entire package and recursively
  // run regressions. Ordinary module PRs defer that integration stage to main;
  // changes to these suites themselves still exercise them on the PR.
  const tests = all.filter(path => affected.has(path) && (!packageSuites.has(path) || changed.includes(path)));
  const sdk = [...files.keys()].some(path => path.startsWith('test-sdk/') && affected.has(path));
  const coreChanges = changed.some(path => !path.startsWith('website/') && !suite(path));
  if (coreChanges && !tests.length && !sdk) return full('No existing consumer test covers the changed input');
  return {mode:'scoped', reason:'Changed files and transitive consumers', changed, tests, sdk, archive:false, website};
}

export function changedFiles(base, head, cwd = root) {
  if (![base, head].every(sha => /^[a-f0-9]{40}$/.test(sha ?? ''))) throw Error('ci:invalid-commit');
  // NUL-separated paths and no rename coalescing retain both sides of renames.
  return execFileSync('git', ['diff','--name-only','-z','--no-renames',base+'...'+head], {cwd,encoding:'utf8',stdio:'pipe'})
    .split('\0').filter(Boolean);
}

function inventory() {
  return new Map(execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean)
    .filter(path => path.endsWith('.mjs') && !path.startsWith('website/'))
    .map(path => [path, readFileSync(resolve(root,path),'utf8')]));
}

function run(args) {
  const result = spawnSync(process.execPath, args, {cwd:root,stdio:'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error('ci:test-command-failed: ' + (result.signal ?? result.status));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2], planPath = process.env.NIBFIN_CI_PLAN ??
    (process.env.RUNNER_TEMP && resolve(process.env.RUNNER_TEMP,'nibfin-ci-plan.json'));
  if (!planPath) throw Error('ci:missing-plan-path');
  if (mode === 'plan') {
    const event = process.env.GITHUB_EVENT_NAME;
    const plan = selectTests({files:inventory(),event,
      changed:event === 'pull_request' ? changedFiles(process.env.PR_BASE_SHA,process.env.PR_HEAD_SHA) : []});
    writeFileSync(planPath,JSON.stringify(plan,null,2)+'\n');
    if (process.env.GITHUB_OUTPUT) for (const key of ['sdk','archive','website']) appendFileSync(process.env.GITHUB_OUTPUT,`${key}=${plan[key]}\n`);
    const summary = `## CI test plan\n\nMode: **${plan.mode}** — ${plan.reason}\n\n`+
      `SDK: ${plan.sdk}; installed archive: ${plan.archive}; website: ${plan.website}\n\n`+
      `Selected root suites (${plan.tests.length}):\n\n`+(plan.tests.map(path=>'- `'+path+'`').join('\n') || 'No root suites affected.')+'\n';
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,summary);
  } else if (mode === 'run' || mode === 'syntax') {
    const plan = JSON.parse(readFileSync(planPath,'utf8'));
    if (!Array.isArray(plan.tests) || !plan.tests.every(path=>suite(path)&&existsSync(resolve(root,path)))) throw Error('ci:invalid-test-plan');
    if (mode === 'syntax') {
      for (const path of plan.changed) {
        if (/^(src|test|test-sdk|tooling)\/[\w./-]+\.mjs$/.test(path) && existsSync(resolve(root,path))) run(['--check',path]);
      }
      process.exit(0);
    }
    // Never invoke `node --test` with an empty list: that discovers every suite.
    if (plan.tests.length) run(['--test',...plan.tests]);
    else console.log('No root suites affected; see the explicit CI plan.');
  } else throw Error('ci:unknown-mode');
}
