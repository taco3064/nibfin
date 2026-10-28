import {generateKeyPairSync} from 'node:crypto';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import * as core from '../src/index.mjs';
import {grantFixture,grantContext} from './grant-fixture.mjs';

// Local cryptographic/provider fixtures. No production credential or live source.
export async function hostIdentityFixture(mode='lookup') {
  const {privateKey,publicKey}=await generateKeyPair('RS256');
  const jwks={keys:[{...await exportJWK(publicKey),kid:'fixture',alg:'RS256',use:'sig'}]};
  const policy={repository:'source-org/automation',repository_id:'91',repository_owner_id:'92',actor_id:'93',
    run_id:'44',run_attempt:'1',workflow_ref:'source-org/automation/.github/workflows/stage.yml@refs/heads/main',
    workflow_sha:'a'.repeat(40),workflowDigest:'b'.repeat(64),ref:'refs/heads/main',event_name:'workflow_dispatch',
    repository_visibility:'public',audience:'nibfin-test',maxAge:300,tolerance:0,
    reusable:'required',job_workflow_ref:'shared/core/.github/workflows/reuse.yml@v1',job_workflow_sha:'c'.repeat(40),
    job:'required',check_run_id:'94',jobId:'95',runner:'required',runnerId:'96',runner_environment:'self-hosted'};
  if(mode==='registration')Object.assign(policy,{repository:'example-org/core',repository_id:'9007199254740993',
    actor_id:'42',workflow_ref:'example-org/core/.github/workflows/register.yml@refs/heads/main',workflow_sha:'b'.repeat(40)});
  const claims=Object.fromEntries(['repository','repository_id','repository_owner_id','actor_id','run_id','run_attempt',
    'workflow_ref','workflow_sha','ref','event_name','repository_visibility','job_workflow_ref','job_workflow_sha',
    'check_run_id','runner_environment'].map(k=>[k,policy[k]]));
  const association=Object.fromEntries(['repository_id','run_id','run_attempt','check_run_id','jobId','runnerId'].map(k=>[k,policy[k]]));
  const sign=(change={})=>new SignJWT({...claims,iss:core.actionsIssuer,aud:policy.audience,sub:'local-only',jti:'nonce',
    iat:0,nbf:0,exp:60,...change}).setProtectedHeader({alg:'RS256',kid:'fixture'}).sign(privateKey);
  const p=grantFixture(core.bodyDigest),keys=generateKeyPairSync('ed25519');
  const grant=core.signGrant(p,{keyId:'owner-1',privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'})});
  const grantInput=grantContext(p,keys.publicKey.export({type:'spki',format:'pem'}));
  const endpoint='/repos/example-org/core/issues/101';
  const checkpoint={request:grantInput.request,member:{id:'42',login:'member'},grant,grantContext:grantInput,
    write:{method:'PATCH',endpoint,target:'123'}};
  const replies={
    '/user':{id:7,login:'operator'},
    '/repos/example-org/core':{id:'9007199254740993',full_name:'example-org/core',private:false,visibility:'public',
      owner:{id:17,login:'example-org',type:'Organization'},permissions:{admin:true}},
    [endpoint]:{id:123,node_id:'I_101',number:101,repository_url:'https://api.github.com/repos/example-org/core',assignees:[{id:42,login:'member'}]},
    '/repos/example-org/core/actions/runs/44/attempts/1':{id:'44',run_attempt:1,repository:{id:'9007199254740993'},
      event:'workflow_dispatch',actor:{id:'42',login:'member'},head_sha:'b'.repeat(40)},
    '/users/member':{id:42,login:'member'},
    '/repos/example-org/core/collaborators/member/permission':{permission:'write',user:{id:42,login:'member'}},
    '/user/memberships/orgs/example-org':{state:'active',role:'admin'},
  };
  const calls=[],handoffs=[];const state={token:await sign(),time:1100,lookup:0};
  const transport=async r=>{calls.push(r);if(state.reply)return state.reply(r);
    return {status:200,headers:{},body:JSON.stringify(r.method==='GET'?replies[r.endpoint]:{id:123})};};
  const options={version:1,repository:'example-org/core',repositoryId:'9007199254740993',authentication:'actions-oidc',
    environment:['compute','execute'].includes(mode)?'nibfin-member':'nibfin-hosted'};
  const config={options,mode,now:()=>state.time,source:{policy,getToken:()=>state.token,getAssociation:()=>association,continuation:{kind:'none'}},
    api:{kind:['compute','execute'].includes(mode)?'local':'hosted',operator:{id:'7',login:'operator'},
      ...(['compute','execute'].includes(mode)?{}:{getCredential:()=>{throw Error('must not discover local login or real token');}})},
    authorization:{getCheckpoint:()=>checkpoint,maxCheckpointMs:50},operations:[
      {method:'PATCH',endpoint,target:'123',operation:'deliver'},
      {method:'GET',endpoint,target:'123',operation:'deliver'}]};
  const facility={jwks,transport};
  const make=()=>core.createHostIdentityAdaptersForTest(config,facility);
  const context={repository:options.repository,repositoryId:options.repositoryId,run:{id:'44',attempt:'1'},
    eventName:'workflow_dispatch',event:{untrusted:'cannot authenticate itself'}};
  const argument={mode,context};
  const identityConfiguration=()=>Object.fromEntries(Object.entries(config).filter(([k])=>!['mode','options'].includes(k)));
  return {extendGrant:until=>{p.expiresAt=until;checkpoint.grant=core.signGrant(p,{keyId:'owner-1',
      privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'})});},config,facility,make,state,calls,handoffs,replies,checkpoint,policy,association,sign,context,argument,identityConfiguration,
    write:adapter=>adapter.provider.request({method:'PATCH',endpoint,target:'123',operation:'deliver',correlation:'test',body:{title:'new'}})};
}
