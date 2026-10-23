import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { probeFamilies } from '../../test/fixtures/public-path/cases.mjs';

// Only fixed probe code runs in a subprocess, with an empty environment. No shell,
// arbitrary checkout code, real login paths or host environment inspection.
export async function probes() {
  const root = await mkdtemp(join(tmpdir(), 'nibfin-public-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const traces = [];
  try {
    await writeFile(join(workspace, 'public'), 'PUBLIC-CONTROL');
    for (const family of probeFamilies) {
      const target = join(root, `sentinel-${family}`);
      await writeFile(target, `SYNTHETIC-${family}`);
      for (const mode of ['unsafe-control', 'permission-deny']) {
        const allowed = mode === 'unsafe-control' ? root : workspace;
        const code = `import {readFileSync} from 'node:fs';
          try { const x=readFileSync(${JSON.stringify(target)}, 'utf8');
            console.log(JSON.stringify({attempted:true, exposed:x===${JSON.stringify(`SYNTHETIC-${family}`)}, stoppedAt:'none'})); }
          catch(e) { if(e.code!=='ERR_ACCESS_DENIED') process.exit(2);
            console.log(JSON.stringify({attempted:true, exposed:false, stoppedAt:'node-filesystem-permission'})); }`;
        const result = spawnSync(process.execPath, ['--experimental-permission', `--allow-fs-read=${allowed}`,
          '--input-type=module', '-e', code], { env: {}, encoding: 'utf8', timeout: 5000 });
        if (result.status !== 0) throw Error(`Probe unavailable: ${family}/${mode}`);
        traces.push({ id: `${family}/${mode}`, classification: 'measured-bounded-filesystem',
          expected: { attempted: true, exposed: mode === 'unsafe-control',
            stoppedAt: mode === 'unsafe-control' ? 'none' : 'node-filesystem-permission' },
          observed: JSON.parse(result.stdout) });
      }
    }
    const result = spawnSync(process.execPath, ['--experimental-permission', `--allow-fs-read=${workspace}`,
      '--input-type=module', '-e', `import {readFileSync} from 'node:fs';
      console.log(readFileSync(${JSON.stringify(join(workspace, 'public'))}, 'utf8'));`],
    { env: {}, encoding: 'utf8', timeout: 5000 });
    if (result.status !== 0 || result.stdout.trim() !== 'PUBLIC-CONTROL') throw Error('Positive filesystem control failed');
    traces.push({ id: 'public-read', classification: 'measured-bounded-filesystem', expected: 'PUBLIC-CONTROL', observed: result.stdout.trim() });
    // Bounded evaluator: hostile strings are data, not executable shell content.
    const hostile = '$(cat synthetic-login); " ; process.env; fetch("https://invalid")';
    const literal = vm.runInNewContext('JSON.stringify(input)', { input: hostile },
      { timeout: 100, contextCodeGeneration: { strings: false, wasm: false } });
    traces.push({ id: 'hostile-text-as-data', classification: 'measured-bounded-evaluator',
      expected: JSON.stringify(hostile), observed: literal });
    for (const expression of ['process', 'require', 'fetch']) {
      let outcome = 'exposed';
      try { vm.runInNewContext(expression, Object.create(null), { timeout: 100,
        contextCodeGeneration: { strings: false, wasm: false } }); }
      catch (e) { outcome = e.name; }
      traces.push({ id: `evaluator-${expression}`, classification: 'measured-bounded-evaluator', expected: 'ReferenceError', observed: outcome });
    }
    const privateDiagnostic = { status: 'blocked', code: '403', detail: 'SYNTHETIC-PRIVATE-LOGIN', log: 'private/provider' };
    const publicDiagnostic = ({ status, code }) => ({ status, code });
    traces.push({ id: 'diagnostic-disclosure', classification: 'measured-data-projection',
      expected: { status: 'blocked', code: '403' }, observed: publicDiagnostic(privateDiagnostic) });
    return traces;
  } finally { await rm(root, { recursive: true, force: true }); }
}
