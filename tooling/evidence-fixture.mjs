// Retained synthetic N06 complete-chain fixture; never live completion evidence.
import {bodyDigest, outcomesForRole, skillForRole, contentIdentity} from '../src/index.mjs';
const h = c => c.repeat(64);
const g = c => c.repeat(40);
const clone = v => JSON.parse(JSON.stringify(v));
const binding = {authority: h('a'), grant: h('b'), policy: h('c'), core: h('d'), runtime: h('e'),
  instructions: h('f'), repositoryId: '9007199254740993', issueId: 'I_node',
  scopeHash: bodyDigest('original scope'), shapeHash: bodyDigest('published shape')};
const candidate = {base: g('a'), tree: g('b'), diff: h('a'), paths: ['src/index.mjs'],
  artifacts: [{path: 'out/nibfin-core.tgz', digest: h('b')}],
  hooks: [{path: 'hooks/check', event: 'pre-commit', digest: h('c')}], emptyHooksReason: null};
const result = role => ({version: 1, outcome: outcomesForRole(role)[0], failureClass: 'none', summary: 'evidenced', conflicts: []});
const execution = role => ({role, skill: skillForRole(role), id: role + '-execution', request: 'request-1',
  result: role + '-result', source: {repositoryId: '42', workflow: h('d'), runId: '123', attempt: '1'}});
const na = () => ({mode: 'not-applicable', identities: [], reason: 'Current policy has no deployment obligation'});
function fixture(stage) {
  const inputs = {
    shape: {body: binding.shapeHash}, 'shape-validator': {body: binding.shapeHash, author: 'author'},
    'shape-diagnosis': {body: binding.shapeHash},
    publication: {body: binding.shapeHash, author: 'author', validator: 'validator', validation: h('2'), readback: h('3')},
    deliver: {publication: h('1'), candidate},
    'pre-accept-hooks': {candidate, phase: 'pre-accept', receipt: h('2')},
    accept: {candidate, hooks: h('2'), deliver: 'deliver-execution'},
    'pre-commit-hooks': {candidate, phase: 'pre-commit', accept: h('2'), receipt: h('3')},
    pr: {candidate, accept: h('2'), hooks: h('3'), head: g('c'), base: g('a'), readback: h('4')},
    ci: {pr: h('2'), head: g('c'), base: g('a'), policy: h('c'), checks: h('3')},
    'shaper-review': {candidate, pr: h('2'), ci: h('3'), head: g('c'), base: g('a'),
      author: 'author', validator: 'validator', deliver: 'deliver-execution', accept: 'accept-execution'},
    merge: {review: h('1'), head: g('c'), base: g('a'), commit: g('d'), readback: h('2')},
    final: {merge: h('1'), commit: g('d'), postMerge: {mode: 'required', identities: [h('2')], reason: null}, deployment: na()},
    closure: {final: h('1'), commit: g('d'), state: 'completed', readback: h('2')},
    delivered: {closure: h('1'), commit: g('d'), readback: h('2')}
  };
  const roles = ['shape', 'shape-validator', 'shape-diagnosis', 'deliver', 'accept', 'shaper-review'];
  return clone({version: 1, stage, binding, execution: execution(roles.includes(stage) ? stage : 'deliver'),
    inputs: inputs[stage], result: roles.includes(stage) ? result(stage) : null});
}
const context = expected => ({expected: clone(expected), consumed: []});
function chain(emptyHooks = false, requiredDeployment = false, configure = () => {}) {
  const stages = ['publication', 'deliver', 'pre-accept-hooks', 'accept', 'pre-commit-hooks', 'pr',
    'ci', 'shaper-review', 'merge', 'final', 'closure', 'delivered'];
  const receipts = Object.fromEntries(stages.map(s => [s, fixture(s)]));
  if (emptyHooks) for (const r of Object.values(receipts)) {
    if (r.inputs.candidate) { r.inputs.candidate.hooks = []; r.inputs.candidate.emptyHooksReason = 'No configured hooks'; }
  }
  if (requiredDeployment) receipts.final.inputs.deployment = {mode:'required', identities:[h('9')], reason:null};
  configure(receipts);
  const ref = (s, k, upstream) => { receipts[s].inputs[k] = contentIdentity(receipts[upstream]); };
  ref('deliver', 'publication', 'publication'); ref('accept', 'hooks', 'pre-accept-hooks');
  ref('pre-commit-hooks', 'accept', 'accept'); ref('pr', 'accept', 'accept'); ref('pr', 'hooks', 'pre-commit-hooks');
  ref('ci', 'pr', 'pr'); ref('shaper-review', 'pr', 'pr'); ref('shaper-review', 'ci', 'ci');
  ref('merge', 'review', 'shaper-review'); ref('final', 'merge', 'merge');
  ref('closure', 'final', 'final'); ref('delivered', 'closure', 'closure');
  return {version: 1, receipts};
}
const chainContext = v => Object.fromEntries(Object.entries(v.receipts).map(([s, r]) => [s, context(r)]));

export {h, g, clone, binding, candidate, result, execution, fixture, context, chain, chainContext};
