import { mkdtempSync, cpSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
// All mutations occur in a verifier-owned temporary copy; dependencies are read-only inputs.
const dir = mkdtempSync(join(tmpdir(), 'nibfin-boundaries-'));
try {
  for (const name of ['src', 'package.json', 'tsconfig.json', 'astro.config.mjs', 'blueprint.config.mjs', 'eslint.config.mjs']) cpSync(name, join(dir, name), { recursive: true });
  symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), 'dir');
  function run(command, args, shouldPass, expected) {
    const r = spawnSync(command, args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' } });
    const log = (r.stdout ?? '') + (r.stderr ?? '');
    console.log([command, ...args].join(' '), `exit=${r.status}`, log);
    assert.equal(r.status === 0, shouldPass, log);
    if (expected) assert.match(log, expected);
  }
  const bin = name => resolve('node_modules/.bin', name);
  run(bin('blueprint'), ['inspect'], true);
  writeFileSync(join(dir, 'src/modules/policy/forbidden.ts'), "import { ReleaseStatus } from '@site/status';\nexport const forbidden = ReleaseStatus;\n");
  run(bin('blueprint'), ['inspect'], false, /module|depend|forbidden/i);
  rmSync(join(dir, 'src/modules/policy/forbidden.ts'));
  writeFileSync(join(dir, 'src/modules/status/TypeFailure.tsx'), 'export const failure: string = 42;\n');
  run(bin('astro'), ['check'], false, /not assignable/);
  rmSync(join(dir, 'src/modules/status/TypeFailure.tsx'));
  writeFileSync(join(dir, 'src/content/docs/invalid.mdx'), '---\ntitle: [\n---\nMalformed metadata\n');
  run(bin('astro'), ['check'], false, /YAML|parse|flow|unexpected/i);
  console.log('Real Blueprint, TSX and content rejection boundaries verified');
} finally { rmSync(dir, { recursive: true, force: true }); }
