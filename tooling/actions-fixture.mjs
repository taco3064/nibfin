import {generateKeyPair, exportJWK, SignJWT} from 'jose';
import {createSyntheticActionsVerifierForTest, actionsIssuer} from '../src/index.mjs';
export async function actionsFixture() {
  const {privateKey, publicKey} = await generateKeyPair('RS256');
  const jwk = {...await exportJWK(publicKey), kid:'synthetic-local', alg:'RS256', use:'sig'};
  const expected = {repository_id:'9007199254740993',repository_owner_id:'42',actor_id:'43',
    run_id:'44',run_attempt:'1',workflow_ref:'org/repo/.github/workflows/test.yml@refs/heads/main',
    workflow_sha:'a'.repeat(40),workflowDigest:'b'.repeat(64),ref:'refs/heads/main',event_name:'workflow_dispatch',
    repository_visibility:'public',audience:'nibfin-test',now:1000,maxAge:300,tolerance:5,
    reusable:'not-applicable',job:'not-applicable'};
  const claims = Object.fromEntries(Object.entries(expected).filter(([k]) => ['repository_id','repository_owner_id','actor_id',
    'run_id','run_attempt','workflow_ref','workflow_sha','ref','event_name','repository_visibility'].includes(k)));
  return {expected, jwks:{keys:[jwk]}, verifier:()=>createSyntheticActionsVerifierForTest({keys:[jwk]}),
    sign:async (changes={}, header={})=>new SignJWT({...claims,iss:actionsIssuer,aud:expected.audience,
      sub:'synthetic-only',jti:'synthetic-nonce',iat:990,nbf:990,exp:1200,...changes})
      .setProtectedHeader({alg:'RS256',kid:jwk.kid,...header}).sign(privateKey)};
}
