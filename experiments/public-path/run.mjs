import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { inspect } from './model.mjs';
import { probes } from './probe.mjs';
import { cases, initial } from '../../test/fixtures/public-path/cases.mjs';
export function verify(inventory, traces) {
  const failures = [...inventory, ...traces].filter(c => JSON.stringify(c.expected) !== JSON.stringify(c.observed));
  if (failures.length) throw Error(`Unexpected outcomes: ${failures.map(c => c.id).join(', ')}`);
  return [];
}
export async function evidence() {
  const files = ['experiments/public-path/model.mjs', 'experiments/public-path/probe.mjs',
    'experiments/public-path/run.mjs', 'test/fixtures/public-path/cases.mjs',
    'test/public-path.test.mjs', 'docs/decisions/public-path.md', 'docs/decisions/runner-set.md',
    'out/runner-set/evidence.json', 'src/protected.mjs'];
  const revisions = await Promise.all(files.map(async path => ({ path,
    sha256: createHash('sha256').update(await readFile(path)).digest('hex') })));
  const inventory = cases.map(c => ({ id: c.id, input: c.input, expected: c.expected,
    observed: inspect(c.input).outcome, trace: inspect(c.input), classification: 'synthetic-admission-model' }));
  const seen = new Set();
  const sequences = [
    ['native-first', initial(), 'admit'], ['dispatch-duplicate', initial(), 'duplicate'],
    ['dependency-first-side', { ...initial(), event: 'dependency' }, 'admit'],
    ['dependency-second-side', { ...initial(), event: 'dependency', delivery: 'delivery-2' }, 'duplicate'],
    ['replay', initial(), 'duplicate']
  ].map(([id, input, expected]) => ({ id, input, expected, observed: inspect(input, seen).outcome,
    classification: 'synthetic-admission-model' }));
  const traces = await probes();
  const failures = verify([...inventory, ...sequences], traces);
  return { schemaVersion: 1, experiment: 'public-path-v1', baseline: 'bf823fd3db1c63f1a99d65076a27d1d895400b6f',
    environment: { node: process.versions.node, requiredNode: '22.23.3', requiredNpm: '10.9.9', platform: process.platform, arch: process.arch },
    revisions, assumptions: ['Admission inputs stipulate verified source facts; no production verifier is implemented.',
      'Fixed filesystem probes only access newly created synthetic files; Node permissions are not a native-code sandbox.',
      'Bounded VM evaluation is not a security boundary for arbitrary Agent code.',
      'Temporary paths are omitted from observations; no timestamps, randomness or credentials enter evidence.'],
    inventory, sequences, traces, failures, providerObservations: [], documentationRetrieved: '2026-10-23',
    routes: [
      { id: 'persistent-public-runner', feasibility: 'disproven under stated conditions', productionReliance: 'blocked',
        blockers: ['When untrusted execution can read credential stores, the unsafe controls expose synthetic login data. Changing runs-on supplies no isolation.'] },
      { id: 'hosted-untrusted-worker-without-credentials', feasibility: 'inconclusive', productionReliance: 'blocked',
        blockers: ['No provider-observed clean ephemeral execution, network/mount/process isolation or artifact provenance evidence.'] },
      { id: 'trusted-ingress-and-isolated-member-agent', feasibility: 'inconclusive', productionReliance: 'blocked',
        blockers: ['No selected/approved ingress deployment or verified live permission/signature/replay store.',
          'Runner-set pre-receipt enforcement remains unproven.', 'No native-event or approved equivalent Dispatch provider E2E.',
          'No native-code Agent/Core credential isolation or deployment/recovery provider evidence.'] }
    ] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await evidence();
  await mkdir('out/public-path', { recursive: true });
  await writeFile('out/public-path/evidence.json', `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Public-path research: ${result.inventory.length} cases, ${result.sequences.length} relay observations, ${result.traces.length} bounded probes; production reliance blocked.`);
}
