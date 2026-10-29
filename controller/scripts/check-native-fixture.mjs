import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { digest } from '../src/core.mjs';
const base = new URL('../grants/native-chain-20261022/', import.meta.url);
const { payload: g } = JSON.parse(await readFile(new URL('grant.json', base), 'utf8'));
const proposal = await readFile(new URL('proposal.txt', base), 'utf8');
assert.equal(g.proposal, proposal, 'Embedded and independent Proposal must match');
assert.equal(g.manifest.proposalHash, digest(proposal));
assert.equal(g.policy.manifestHash, digest(g.manifest));
assert.match(proposal, /C \(#3\) and D \(#4\) both depend only on B/);
const issues = [...g.manifest.issues].sort((a,b)=>a.number-b.number);
for (const issue of issues) {
 assert.deepEqual(issue.dependencies, issue.number < 3 ? [] : [issues[1].id]);
 assert.match(issue.scopeBody, /C and D are both Blocked by B/);
 assert.equal(issue.scopeHash, digest(issue.scopeBody));
}
console.log('Fixture Proposal, hashes, scopes and fork dependencies agree.');
