import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { inspect, receiptTrace } from './model.mjs';
import { cases, attacks } from '../../test/fixtures/runner-set/cases.mjs';
export const modes = [
  { name: 'snapshot', protection: 'snapshot', enforcement: false, bypass: false, exposed: true, dispatched: true },
  { name: 'post-start', protection: 'post-start', enforcement: false, bypass: false, exposed: true, dispatched: true },
  { name: 'closed-range-enforced', protection: 'closed-range', enforcement: true, bypass: false, exposed: false, dispatched: true },
  { name: 'closed-range-unverified', protection: 'closed-range', enforcement: false, bypass: false, exposed: false, dispatched: false },
  { name: 'closed-range-bypassed', protection: 'closed-range', enforcement: true, bypass: true, exposed: true, dispatched: true }
];
export async function evidence() {
  const files = ['experiments/runner-set/model.mjs', 'experiments/runner-set/run.mjs',
    'test/fixtures/runner-set/cases.mjs', 'test/runner-set.test.mjs', 'docs/decisions/runner-set.md'];
  const revisions = [];
  for (const path of files) revisions.push({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
  const inventory = cases.map(c => ({ id: c.id, input: `test/fixtures/runner-set/cases.mjs#${c.id}`,
    classification: 'synthetic', expected: c.expected, observed: inspect(c.input) }));
  const traces = attacks.flatMap(a => modes.map(m => ({ id: `${a.id}/${m.name}`,
    input: `test/fixtures/runner-set/cases.mjs#${a.id}`, classification: 'synthetic',
    assumptions: { enforcement: m.enforcement, bypass: m.bypass, protection: m.protection },
    expected: { exposed: m.exposed, dispatched: m.dispatched },
    observed: receiptTrace(a, m.protection, m.enforcement, m.bypass) })));
  const failures = [...inventory.filter(c => Object.entries(c.expected).some(([k, v]) => JSON.stringify(c.observed[k]) !== JSON.stringify(v))),
    ...traces.filter(c => c.observed.exposed !== c.expected.exposed || c.observed.dispatched !== c.expected.dispatched)];
  if (failures.length) throw new Error(`Unexpected research outcomes: ${failures.map(c => c.id).join(', ')}`);
  return { schemaVersion: 1, experiment: 'runner-set-model-v1',
    environment: { node: process.versions.node, requiredNode: '22.23.3', requiredNpm: '10.9.9' },
    investigationBaseline: '1e617281842cb484a140e45ebed2fcac654bc7b9',
    implementationBase: '0ed433a11a2a72091e2152f165fe578092e75461', revisions,
    documentationRetrieved: '2026-10-23', inventory, traces, providerObservations: [],
    finding: 'inconclusive', dependentImplementation: 'blocked-from-relying-on-safe-dispatch',
    blockers: ['No authorized provider experiment environment or receipt evidence supplied.',
      'No proven enforcement closes registration, label, group, access, binding and eligibility changes through queued receipt and reassignment.',
      'Production complete visibility, trusted workflow sources and enforcement authority require separate implementation and provider verification.'] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await evidence();
  await mkdir('out/runner-set', { recursive: true });
  await writeFile('out/runner-set/evidence.json', `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Synthetic research: ${result.inventory.length} inventory cases, ${result.traces.length} traces; provider feasibility inconclusive.`);
}
