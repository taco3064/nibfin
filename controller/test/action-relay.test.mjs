import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createActionRelayServer } from '../src/action-relay.mjs';

test('relay forwards only 401/403 status so the calling Action records local gh failure', async t => {
  let status = 401;
  const server = createActionRelayServer(async () => { throw Object.assign(new Error('private-secret-provider-body'), {status}); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (status of [401, 403]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/event`, {method:'POST', body:'{}'});
    assert.equal(response.status, status);
    assert.equal(await response.text(), '{"status":"REJECTED"}');
    assert.equal(response.headers.get('retry-after'), null);
  }
});

test('relay exposes only the bounded event endpoint and never private error details', async t => {
  let resolutions = 0;
  const server = createActionRelayServer(async () => { resolutions++; throw new Error('private-token-never-public'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/event', '/admin', '/']) assert.equal((await fetch(url + path)).status, 404);
  assert.equal(resolutions, 0);
  const invalid = await fetch(url + '/event', { method: 'POST', body: 'invalid JSON' });
  assert.equal(invalid.status, 400); assert.equal(resolutions, 0);
  const rejected = await fetch(url + '/event', { method: 'POST', body: JSON.stringify({ payload: { repository: 'foreign/repo' } }) });
  assert.equal(rejected.status, 400); assert.equal(await rejected.text(), '{"status":"REJECTED"}');
  assert.equal(resolutions, 1);
});

test('relay distinguishes safe signer readback wait from rejected or uncertain requests',async t=>{
  const server=createActionRelayServer(async()=>{throw Object.assign(new Error('Signer pending'),{code:'ACTION_EVENT_SIGNER_PENDING'});});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const r=await fetch(`http://127.0.0.1:${server.address().port}/event`,{method:'POST',body:JSON.stringify({payload:{repository:'owner/app'}})});
  assert.equal(r.status,425);assert.equal(r.headers.get('retry-after'),'5');assert.deepEqual(await r.json(),{status:'WAITING',code:'ACTION_EVENT_SIGNER_PENDING'});
});
