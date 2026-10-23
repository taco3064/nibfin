import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { digest, parseCandidateInventory, validateCandidateObligations } from '../src/index.mjs';
import { approval, reasons } from './fixtures/obligations.mjs';
const scopeDigest = digest('Frozen Scope requires the configured hook and no extra build outputs');
const full = { artifacts: [{ path: 'out/binary', purpose: 'Required binary output' }],
  hooks: ['pre-commit', 'prepare-commit-msg', 'commit-msg'].map(event => ({ path: `hooks/${event}`, event })) };
const empty = { artifacts: [], hooks: [] };
const validate = (e, configuration = e.configuration) => validateCandidateObligations(e,
  { shapeDigest: digest(e.body), scopeDigest }, configuration);
const body = value => `\`\`\`kairo-candidate\n${JSON.stringify(value)}\n\`\`\`\n`;

test('AC1: exported parser fence grammar distinguishes authoritative blocks from literal examples', () => {
  for (const fence of ['```', '````', '~~~']) {
    assert.deepEqual(parseCandidateInventory(`   ${fence}kairo-candidate\r\n${JSON.stringify(full)}\r\n   ${fence}\r\n`), full);
  }
  const literal = '````markdown\n```kairo-candidate\n{"ignored":true}\n```\n````\n';
  assert.deepEqual(parseCandidateInventory(literal + body(full)), full);
  assert.deepEqual(parseCandidateInventory('```json\n{"artifacts":[],"hooks":[]}\n```\n' + body(full)), full);
  for (const text of ['', body(full) + body(empty), '```kairo-candidate\n{bad}\n```',
    '```kairo-candidate\n{}', '```kairo-candidate\n{"artifacts":[],"artifacts":[],"hooks":[]}\n```', '```kairo-candidate extra\n{}\n```',
    '    ```kairo-candidate\n{}\n    ```', 'An inline ```kairo-candidate {} ```']) {
    assert.throws(() => parseCandidateInventory(text));
  }
});
test('AC1: malformed inventories cannot establish extraction destinations', () => {
  for (const value of [null, [], {}, { ...empty, extra: true }, { artifacts: {}, hooks: [] },
    { artifacts: [null], hooks: [] }, { artifacts: [{ path: 'out/a', purpose: '  ' }], hooks: [] },
    { artifacts: [{ path: 'out/a', purpose: 7 }], hooks: [] },
    { artifacts: [], hooks: [{ path: 'hooks/a', event: 'post-commit' }] },
    { artifacts: [], hooks: [{ path: 'hooks/a', event: 'pre-commit', extra: true }] },
    { artifacts: [full.artifacts[0], full.artifacts[0]], hooks: [] },
    { artifacts: [{ path: 'hooks', purpose: 'conflict' }], hooks: full.hooks },
    { artifacts: [{ path: 'hooks/pre-commit', purpose: 'conflict' }], hooks: full.hooks }]) {
    assert.throws(() => parseCandidateInventory(body(value)));
  }
  for (const path of ['/tmp/a', '../a', 'a/../b', '.git/config', 'a/.GIT/config', 'C:/a', 'a\\b', 'a//b']) {
    assert.throws(() => parseCandidateInventory(body({ artifacts: [{ path, purpose: 'x' }], hooks: [] })), /unsafe/);
  }
});
test('AC1/AC2: independent approval correlates exact Shape, frozen Scope, inventory and configuration', () => {
  const e = approval(full, scopeDigest);
  assert.deepEqual(validate(e).obligations, full);
  for (const change of [x => { x.validation.approved = false; }, x => { x.validation.validatorId = x.validation.authorId; },
    x => { x.validation.scopeDigest = digest('different Scope'); }, x => { x.validation.shapeDigest = digest('different Shape'); },
    x => { x.validation.configurationDigest = digest({}); }, x => { x.validation.inventoryDigest = digest(empty); },
    x => { x.body += '\nChanged Shape'; }, x => { x.validation = undefined; }]) {
    const altered = structuredClone(e); change(altered); assert.throws(() => validate(altered));
  }
  assert.throws(() => validateCandidateObligations(e, { shapeDigest: digest('wrong'), scopeDigest }, e.configuration));
  assert.throws(() => validateCandidateObligations(e, { shapeDigest: digest(e.body), scopeDigest }));
});
test('AC2: empty applicability remains explicit, Scope-reviewed and bound to exact source prose', () => {
  const e = approval(empty, scopeDigest), result = validate(e);
  assert.deepEqual(result.obligations, empty);
  assert.deepEqual(JSON.parse(JSON.stringify(result.evidence)), e);
  for (const kind of ['artifacts', 'hooks']) {
    for (const reason of ['', null, 'A reason not in the approved body']) {
      const bad = structuredClone(e); bad.validation.emptyReasons[kind] = reason;
      assert.throws(() => validate(bad), /applicability/);
    }
    const stripped = structuredClone(e); stripped.body = stripped.body.replace(reasons[kind], '');
    stripped.validation.shapeDigest = digest(stripped.body);
    assert.throws(() => validate(stripped), /applicability/);
  }
  const codeReason = structuredClone(e);
  codeReason.body = codeReason.body.replace(reasons.artifacts, '```text\n' + reasons.artifacts + '\n```');
  codeReason.validation.shapeDigest = digest(codeReason.body);
  assert.throws(() => validate(codeReason), /applicability/);
  const changedScope = { ...e.validation, scopeDigest: digest('Scope now requires an artifact') };
  assert.throws(() => validate({ ...e, validation: changedScope }), /validation/);
});

// Trusted fixture adapter reads actual repository/workspace setup. This deliberately
// supports only declarative fixture formats; unknown setup must block, not guess.
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
function readConfiguration(root, kind) {
  const hooksPath = git(root, ['config', '--local', '--get', 'core.hooksPath']);
  assert.equal(hooksPath, kind === 'repository' ? 'managed-hooks' : '.husky');
  const settings = Buffer.from(JSON.stringify({ hooksPath })).toString('base64');
  const sources = [{ path: 'git-hook-settings.json', bytes: settings, contentDigest: digest(settings) }];
  if (kind === 'husky') {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
    assert.equal(pkg.scripts.prepare, 'husky');
    const workspace = JSON.parse(readFileSync(join(root, 'workspace.json')));
    assert.equal(workspace.hooksPath, hooksPath);
    for (const path of ['package.json', 'workspace.json']) {
      const bytes = readFileSync(join(root, path)).toString('base64'); sources.push({ path, bytes, contentDigest: digest(bytes) });
    }
  }
  const hooks = ['pre-commit', 'prepare-commit-msg', 'commit-msg'].flatMap(event => {
    const path = `${hooksPath}/${event}`;
    return existsSync(join(root, path)) ? [{ path, event }] : [];
  });
  return { complete: true, inspected: ['git', 'repository', 'husky', 'workspace'], sources, hooks,
    prerequisites: [{ kind: 'tool', description: 'Local fixture shell, with Git hooksPath already provisioned', supported: true }] };
}
test('AC2: real repository-managed and Husky/workspace setup reconciles with independent inventory evidence', t => {
  const dir = mkdtempSync(join(tmpdir(), 'nibfin-config-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const kind of ['repository', 'husky']) {
    const root = join(dir, kind); mkdirSync(root); git(root, ['init']);
    const hooksPath = kind === 'repository' ? 'managed-hooks' : '.husky';
    mkdirSync(join(root, hooksPath)); git(root, ['config', 'core.hooksPath', hooksPath]);
    for (const event of kind === 'repository' ? ['pre-commit', 'prepare-commit-msg', 'commit-msg'] : ['commit-msg']) {
      writeFileSync(join(root, hooksPath, event), '#!/bin/sh\nexit 0\n');
    }
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { prepare: 'husky' } }));
    writeFileSync(join(root, 'workspace.json'), JSON.stringify({ hooksPath: '.husky' }));
    const configuration = readConfiguration(root, kind);
    const inventory = { artifacts: [], hooks: configuration.hooks };
    const e = approval(inventory, scopeDigest, configuration);
    assert.deepEqual(validate(e, readConfiguration(root, kind)).obligations, inventory);
    const emptyClaim = approval(empty, scopeDigest, configuration);
    assert.throws(() => validate(emptyClaim, configuration), /hook inventory/);
    for (const hooks of [[], [...configuration.hooks, { path: 'extra', event: 'pre-commit' }],
      configuration.hooks.map(h => ({ ...h, event: 'prepare-commit-msg' })), [...full.hooks].reverse()]) {
      const wrong = approval({ artifacts: [], hooks }, scopeDigest, configuration);
      assert.throws(() => validate(wrong, configuration), /hook inventory/);
    }
    if (kind === 'husky') {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { prepare: 'husky' }, changed: true }));
      assert.throws(() => validate(e, readConfiguration(root, kind)), /fresh hook configuration/);
    }
    git(root, ['config', 'core.hooksPath', 'unexpected-hooks']);
    assert.throws(() => validate(e, readConfiguration(root, kind)));
  }
});
test('AC2: incomplete configuration, missing setup and unsupported prerequisites block with a reason', () => {
  for (const change of [c => { c.complete = false; }, c => { c.inspected = ['git']; },
    c => { delete c.sources; }, c => { c.sources = [{ path: 'package.json', bytes: '', contentDigest: 'bad' }]; }]) {
    const e = approval(empty, scopeDigest); change(e.configuration); e.validation.configurationDigest = digest(e.configuration);
    assert.throws(() => validate(e));
  }
  for (const kind of ['installation', 'signing', 'credential', 'network', 'external-effect', 'tool']) {
    const e = approval(empty, scopeDigest);
    e.configuration.prerequisites.push({ kind, description: 'Required setup is unavailable in the isolated hook sandbox', supported: false });
    e.validation.configurationDigest = digest(e.configuration);
    assert.throws(() => validate(e), new RegExp(`unsupported mandatory hook prerequisite: ${kind}`));
  }
  for (const kind of ['credential', 'network', 'external-effect']) {
    const e = approval(empty, scopeDigest);
    e.configuration.prerequisites.push({ kind, description: 'Cannot be made safe by a caller claim', supported: true });
    e.validation.configurationDigest = digest(e.configuration);
    assert.throws(() => validate(e), /unsupported mandatory/);
  }
});
