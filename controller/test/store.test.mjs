import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';

test('durable decisions, deduplication and compare-and-swap across restarts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-'));
  t.after(() => rm(root, { recursive: true }));
  const store = new Store(root, 'cohort');
  await store.recordDecision(0, { decisionId: 'd1' });
  assert.equal((await new Store(root, 'cohort').read()).revision, 1);
  await assert.rejects(store.recordDecision(0, { decisionId: 'd2' }), /revision conflict/);
  await assert.rejects(store.recordDecision(1, { decisionId: 'd1' }), /Duplicate/);
  await store.recordDecision(1, { decisionId: 'd2' });
  assert.equal((await store.read()).events.length, 2);
});
test('one cohort lock across callers and crash lock is never stolen', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-'));
  t.after(() => rm(root, { recursive: true }));
  const store = new Store(root, 'cohort');
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const first = store.transaction(0, async state => { entered(); await wait; return state; });
  await ready;
  await assert.rejects(new Store(root, 'cohort').recordDecision(0, { decisionId: 'duplicate' }), { code: 'EEXIST' });
  release(); await first;
  await writeFile(join(store.directory, 'lock'), '{"pid":-1}');
  await assert.rejects(store.recordDecision(1, { decisionId: 'late' }), { code: 'EEXIST' });
});
test('detect corrupt state and isolate cohort storage', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-'));
  t.after(() => rm(root, { recursive: true }));
  const store = new Store(root, 'cohort');
  await store.recordDecision(0, { decisionId: 'd1' });
  await writeFile(join(store.directory, 'state.json'), JSON.stringify({ payload: { revision: 99 }, hash: 'wrong' }));
  await assert.rejects(store.read(), /integrity/);
  assert.equal((await new Store(root, 'other-cohort').read()).revision, 0);
});

test('failed serialization preserves the caller revision so the original failure can be recorded', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kairo-'));
  t.after(() => rm(root, { recursive: true }));
  const store = new Store(root, 'cohort');
  const state = await store.read();
  state.invalidReceipt = { commit: undefined };
  await assert.rejects(store.transaction(state.revision, () => state), /Only JSON/);
  assert.equal(state.revision, 0);
  assert.equal((await store.read()).revision, 0);
  delete state.invalidReceipt;
  state.lastError = { message: 'Missing merge identity' };
  assert.equal((await store.transaction(state.revision, () => state)).revision, 1);
});
