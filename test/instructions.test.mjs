import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { roles, resolveInstructions, invokeProtected, digest } from '../src/index.mjs';
import { fixture, roleResult, lifecycle } from './fixtures/protected.mjs';

// Deterministic document regression checks, not proof of Agent obedience.
const clauses = {
  shape: ['## Author', '## Validator', '## Diagnosis', '## Final Review',
    '## Reusable read-only Investigation', 'exactly one fenced kairo-candidate JSON',
    'Empty arrays each need an explicit applicability explanation',
    'Repeated implementation failures alone', 'scopeQuote/shapeQuote'],
  deliver: ['authorized workspace/paths', 'criterion', 'untracked/ignored deliverables',
    'Core captures immutable identities', 'until-conformant has no count-based stop'],
  accept: ['before any candidate', 'Never repair inputs', 'different session from',
    'mandatory non-tree artifacts', 'second hook pass after acceptance']
};
for (const [skill, required] of Object.entries(clauses)) {
  test(`selected ${skill} instructions retain reviewed operational clauses (content only)`, () => {
    const f = fixture(skill);
    const selected = resolveInstructions(skill, f.proof.configuration, f.proof.instructionContext);
    assert.equal(selected.content, readFileSync(`src/instructions/${skill}.md`, 'utf8'));
    assert.equal(selected.contentDigest, digest(selected.content));
    assert.notEqual(selected.contentDigest, digest(selected.content + '\nChanged instructions'));
    for (const clause of required) assert(selected.content.includes(clause), clause);
    for (const clause of ['no network', 'gitignored', 'Original-Scope defects',
      'open post-merge', 'closed regression', 'whole-Runner-set trust']) {
      assert(selected.content.includes(clause), clause);
    }
  });
}
test('planning findings cannot be submitted as formal Shape approval or invented roles', async () => {
  for (const role of ['scope', 'investigation', 'shape-investigation']) {
    const f = fixture(); f.request.binding.role = role;
    assert.equal((await invokeProtected(f.request, f.adapters)).status, 'rejected');
    assert.equal(f.calls(), 0);
  }
  const f = fixture('shape');
  f.adapters.execute = async r => roleResult(r.binding, { outcome: 'planning-findings' });
  assert.equal((await invokeProtected(f.request, f.adapters)).status, 'blocked');
});
test('host Candidate verification seam denies absent artifacts and hook proof before execution', async () => {
  // The package consumes a trusted permission decision. This fixture tests the
  // seam, not artifact capture, sandbox isolation or a production hook runner.
  for (const missing of ['artifact', 'hook-receipt', 'hook-prerequisite']) {
    const f = fixture('accept');
    const inventory = { artifact: true, 'hook-receipt': true, 'hook-prerequisite': true };
    f.adapters.verify = async () => ({ ...f.proof,
      permission: Object.values(inventory).every(Boolean) ? 'verified' : 'denied' });
    inventory[missing] = false;
    assert.equal((await invokeProtected(f.request, f.adapters)).status, 'blocked');
    assert.equal(f.calls(), 0);
    inventory[missing] = true;
    assert.equal((await invokeProtected(f.request, f.adapters)).status, 'succeeded');
    assert.equal(f.calls(), 1);
  }
});
test('incident observation cannot dispatch or restore: host authorization remains separate', async () => {
  for (const state of ['open-failure', 'closed-incident']) {
    for (const responsibility of [false, true]) {
      for (const authorized of [false, true]) {
        const f = fixture('deliver'); const e = lifecycle('recovery', state);
        f.proof.lifecycle = [{ evidence: e, expected: structuredClone(e), authenticity: 'verified' }];
        // Attribution is a trusted host obligation, not inferred from log text.
        f.proof.permission = responsibility && authorized ? 'verified' : 'denied';
        const result = await invokeProtected(f.request, f.adapters);
        assert.equal(result.status, responsibility && authorized ? 'succeeded' : 'blocked');
        assert.equal(f.calls(), responsibility && authorized ? 1 : 0);
        assert(!Object.hasOwn(result, 'dispatch'));
        assert(!Object.hasOwn(result, 'restore'));
      }
    }
  }
});
test('Scope and merged Shape concerns are classified reports, never lifecycle operations', async () => {
  const scenarios = [
    ['shape-diagnosis', 'authority_gap', 'Original Scope requires separate Scope Audit/Plan approval'],
    ['shape-diagnosis', 'shape_defect', 'Pre-merge suspected conflict awaits independent confirmation'],
    ['deliver', 'shape_defect', 'Merged concern cannot restore pre-merge Scope'],
    ['deliver', 'external_failure', 'Unknown write and missing responsibility evidence'],
    ['deliver', 'implementation_defect', 'Correct Shape, confirmed implementation failure']
  ];
  for (const [role, failureClass, reference] of scenarios) {
    const f = fixture(role);
    f.adapters.execute = async r => roleResult(r.binding, {
      outcome: 'concern', failureClass, references: [reference]
    });
    const result = await invokeProtected(f.request, f.adapters);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.result.outcome, 'concern');
    assert.equal(result.result.failureClass, failureClass);
    assert.deepEqual(Object.keys(result.result).sort(),
      ['schemaVersion', 'binding', 'outcome', 'failureClass', 'references', 'conflicts'].sort());
  }
});
test('all six roles receive selected bytes without expanding protected identity', async () => {
  for (const [role, skill] of Object.entries(roles)) {
    const f = fixture(role);
    f.adapters.execute = async (r, instructions) => {
      assert.equal(instructions.skill, skill);
      assert.equal(instructions.contentDigest, r.binding.instructionDigest);
      assert.equal(instructions.selectionDigest, r.binding.instructionSelectionDigest);
      return roleResult(r.binding);
    };
    assert.equal((await invokeProtected(f.request, f.adapters)).status, 'succeeded');
  }
});
