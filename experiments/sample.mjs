import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invoke } from '../src/index.mjs';
import { initial } from '../test/fixtures/request.mjs';
const directory = await mkdtemp(join(tmpdir(), 'nibfin-experiment-'));
try {
  // Synthetic experiment adapter has no production export or credential access.
  const result = await invoke(initial(), {
    verify: async () => ({ permission: 'verified' }),
    execute: async () => ({ status: 'succeeded' })
  });
  if (result.status !== 'succeeded') throw new Error('Sample experiment failed.');
  await writeFile(join(directory, 'result.json'), JSON.stringify(result));
  console.log('Synthetic one-stage experiment passed; temporary output disposed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
