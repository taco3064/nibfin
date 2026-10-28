import test from 'node:test';
import assert from 'node:assert/strict';
import { credentialStrings, redactCredentials, containsCredentials } from '../src/credential-output.mjs';
test('known authentication material is removed from transcripts and detected before publishing output',()=>{
  const secret='fixture-auth-token-not-a-real-credential';
  const values=credentialStrings({tokens:{access_token:secret},account:'short'});
  assert.deepEqual(values,[secret]);
  for(const form of [secret,Buffer.from(secret).toString('base64'),Buffer.from(secret).toString('base64url'),Buffer.from(secret).toString('hex'),Buffer.from(secret).toString('hex').toUpperCase(),encodeURIComponent(secret)]) {
    assert.equal(containsCredentials(`output ${form}`,values),true);
    assert.ok(!redactCredentials(`output ${form}`,values).includes(form));
  }
  assert.equal(containsCredentials('ordinary evidence',values),false);
});
