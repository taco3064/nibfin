import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub } from '../src/github.mjs';
import { mapReads } from '../src/parallel.mjs';

test('observation coalesces identical reads, isolates callers, and revalidates the next boundary', async () => {
  let calls = 0, revision = 1;
  const gh = new GitHub('test', async () => { calls++; return new Response(JSON.stringify({ revision })); });
  await gh.readObservation(async () => {
    const [a,b] = await Promise.all([gh.api('/same'), gh.api('/same')]);
    a.revision = 99;
    assert.equal(b.revision, 1);
    assert.equal((await gh.readObservation(() => gh.api('/same'))).revision, 1);
    assert.equal(calls, 1);
  });
  revision = 2;
  assert.equal((await gh.readObservation(() => gh.api('/same'))).revision, 2);
  assert.equal(calls, 2);
  await Promise.all([gh.readObservation(() => gh.api('/same')), gh.readObservation(() => gh.api('/same'))]);
  assert.equal(calls, 4);
});

test('changed permissions cannot be hidden by an earlier observation and writes are forbidden inside it', async () => {
  let denied = false, calls = 0;
  const gh = new GitHub('test', async () => { calls++; return new Response('{}', {status: denied ? 403 : 200}); });
  await gh.readObservation(() => gh.api('/grant'));
  denied = true;
  await assert.rejects(gh.readObservation(() => gh.api('/grant')), {status:403});
  await assert.rejects(gh.readObservation(() => gh.api('/write','PATCH',{})), /Writes are forbidden/);
  assert.equal(calls, 2);
});

test('a concurrent mutation invalidates subsequent scoped reads', async () => {
  let value = 1;
  const gh = new GitHub('test', async (_,options) => {
    if (options.method !== 'GET') value++;
    return new Response(JSON.stringify({value}));
  });
  let release, ready;
  const entered = new Promise(resolve => ready=resolve);
  const resumed = new Promise(resolve => release=resolve);
  const observing = gh.readObservation(async () => {
    assert.equal((await gh.api('/value')).value,1);
    ready(); await resumed;
    assert.equal((await gh.api('/value')).value,2);
  });
  await entered;
  await gh.api('/value','PATCH',{});
  release(); await observing;
});

test('parallel reads remain bounded and fully settle before surfacing failure', async () => {
  let active=0,max=0,settled=0;
  await assert.rejects(mapReads([0,1,2,3,4,5],async n=>{
    active++;max=Math.max(max,active);
    await new Promise(r=>setTimeout(r,5));
    active--;settled++;
    if(n===0)throw Error('denied');
  },2),/denied/);
  assert.equal(max,2);assert.equal(active,0);assert.equal(settled,6);
});

test('timing categories retain phase attribution without recording private API paths', async () => {
 const gh = new GitHub('secret', async () => new Response(JSON.stringify({ok:true})));
 await gh.measure('observe', () => gh.readObservation(async () => {
  await gh.measure('provenance', () => gh.api('/repos/private/name/actions/runs/123'));
  await gh.api('/repos/private/name/actions/runs/123');
 }));
 assert.equal(gh.metrics.requests,1);
 assert.equal(gh.metrics.readsByCategory['provenance:GET:action-runs'].requests,1);
 assert.equal(gh.metrics.readsByCategory['observe:GET:action-runs'].reusedReads,1);
 assert.equal(gh.metrics.phases.observe.calls,1);
 assert.equal(JSON.stringify(gh.metrics).includes('private/name'),false);
 await assert.rejects(gh.measure('failure',async()=>{throw Error('failed')}));
 assert.equal(gh.metrics.phases.failure.calls,1);
});
