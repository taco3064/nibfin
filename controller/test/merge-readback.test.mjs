import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub } from '../src/github.mjs';

test('merged PR readback explicitly requests the representation containing the actual merge SHA', async () => {
  const github = new GitHub('test', async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/example/repo/pulls/4');
    assert.equal(options.headers['X-GitHub-Api-Version'], '2022-11-28');
    return { ok: true, status: 200, json: async () => ({ merged: true, merge_commit_sha: 'a'.repeat(40) }) };
  });
  assert.equal((await github.pull('example/repo', 4)).merge_commit_sha, 'a'.repeat(40));
});

test('merged PR without a real merge identity fails before persisting a fabricated receipt', async () => {
  const github = new GitHub('test', async () => ({ ok: true, status: 200, json: async () => ({ merged: true }) }));
  await assert.rejects(github.pull('example/repo', 4), /actual merge commit identity/);
});
