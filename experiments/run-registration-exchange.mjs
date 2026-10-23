import assert from 'node:assert/strict';
import { registrationFixture } from '../test/fixtures/registration-exchange.mjs';
import { openResponse } from './registration-exchange.mjs';
// Private keys and synthetic plaintext exist only in memory. No sensitive files are created.
const f = registrationFixture();
const result = await f.host.exchange(f.request);
assert.equal(result.status, 'encrypted');
assert.equal(openResponse(result.response, f.request, f.member.privateKey, f.owner.publicKey, f.now()).token, f.token);
assert.equal((await f.host.exchange(f.request)).status, 'rejected');
const denied = registrationFixture(); denied.observation.policy = false;
assert.equal((await denied.host.exchange(denied.request)).status, 'rejected');
assert.equal(denied.calls(), 0);
console.log('Offline synthetic exchange passed: encrypted response, replay rejected, disabled policy rejected. No retained sensitive output.');
