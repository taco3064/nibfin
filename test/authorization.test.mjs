import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {createAuthorizationBoundary, bodyDigest, signGrant} from '../src/index.mjs';
import {grantFixture, grantContext} from '../tooling/grant-fixture.mjs';

// Official response field contracts: docs.github.com/en/rest/{users/users,
// repos/repos,issues/issues,collaborators/collaborators}. Synthetic identities only.
export function harness(options = {}) {
  const p = grantFixture(bodyDigest);
  const keys = generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({type:'pkcs8',format:'pem'});
  const publicKey = keys.publicKey.export({type:'spki',format:'pem'});
  const context = grantContext(p, publicKey);
  const endpoint = '/repos/example-org/core/issues/101';
  const c = {request: context.request, member:{id:'42',login:'member'}, operator:{id:'7',login:'operator'},
    grant:signGrant(p,{keyId:'owner-1',privateKey}), grantContext:context,
    write:{method:'PATCH',endpoint,target:'123'}};
  const replies = {
    '/user': {id:7,login:'operator'},
    '/repos/example-org/core': {id:p.work[0].repository.id, full_name:'example-org/core',private:false,visibility:'public',owner:{login:'example-org',type:'Organization'}},
    [endpoint]: {id:123,node_id:'I_101',number:101,repository_url:'https://api.github.com/repos/example-org/core',assignees:[{id:42,login:'member'}]},
    '/users/member': {id:42,login:'member'},
    '/repos/example-org/core/collaborators/member/permission': {permission:'write',role_name:'write',user:{id:42,login:'member'}},
  };
  const calls = [];
  let clock = 1100;
  const boundary = createAuthorizationBoundary({maxCheckpointMs:50,now:()=>clock,
    getCheckpoint:()=>c, attempts:2, delay:async()=>{},
    transport:async r => {calls.push(r); if (options.transport) return options.transport(r, replies);
      return {status:200,headers:{},body:JSON.stringify(r.method === 'GET' ? replies[r.endpoint] : {id:123})};},
    ...options.config});
  const write = () => boundary.request({method:'PATCH',endpoint,target:'123',
    operation:'deliver',correlation:'test',body:{title:'updated'}});
  return {boundary,c,p,replies,calls,write,setClock:v=>{clock=v;},sign:()=>{c.grant=signGrant(p,{keyId:'owner-1',privateKey});}};
}
const permission = '/repos/example-org/core/collaborators/member/permission';
const repo = '/repos/example-org/core';
const issue = repo + '/issues/101';
const writes = h => h.calls.filter(r=>r.method !== 'GET').length;

test('positive intersection, exact decimal IDs and observations before each write', async()=>{
  for (const type of ['User','Organization']) for (const role of ['write','maintain','admin']) {
    const h=harness(); h.replies[repo].owner.type=type; h.replies[permission].permission=role;
    const result=await h.boundary.eligibility(); assert.equal(result.ok,true);
    assert.equal(result.observation.repositoryId,'9007199254740993');
    assert.equal((await h.write()).outcome,'submitted');
    assert.equal((await h.write()).outcome,'submitted');
    assert.deepEqual(h.calls.map(r=>r.method),[...Array(10).fill('GET'),'PATCH',...Array(5).fill('GET'),'PATCH']);
  }
});
test('independent malformed, denied and identity cases submit zero writes', async()=>{
  const changes=[
    h=>{h.replies[repo].id='99';},h=>{h.replies[repo].full_name='other/core';},
    h=>{h.replies[repo].private=true;},h=>{delete h.replies[repo].visibility;},
    h=>{h.replies[issue].node_id='I_102';},h=>{h.replies[issue].number=102;},
    h=>{h.replies[issue].pull_request={};},h=>{delete h.replies[issue].assignees;},
    h=>{h.replies[issue].assignees=[];},h=>{h.replies[issue].assignees[0].id=43;},
    h=>{h.replies['/users/member'].id=43;},h=>{h.replies[permission].user.id=43;},
    h=>{h.replies[permission].permission='read';},h=>{h.replies[permission].permission='triage';},
    h=>{h.replies[permission].permission='custom';},h=>{delete h.replies[permission].user;},
    h=>{h.replies['/user'].id=42;},h=>{h.c.member.id='43';},
  ];
  for(const change of changes){const h=harness();change(h);assert.notEqual((await h.write()).outcome,'submitted');assert.equal(writes(h),0);}
});
test('hosted service/user uses trusted source without local identity discovery',async()=>{
  for(const kind of ['service','user']){
    const h=harness({config:{identity:'hosted-authorized'}});
    h.c.operator={id:'installation-7',source:'hosted-authorized',kind,trusted:true};
    assert.equal((await h.write()).outcome,'submitted'); assert.equal(h.calls.some(r=>r.endpoint==='/user'),false);
    h.c.operator.trusted=false; assert.equal((await h.write()).outcome,'failed');assert.equal(writes(h),1);
  }
  const h=harness({config:{identity:'hosted-authorized'}});assert.equal((await h.write()).outcome,'failed');
});
test('real signed Grant rejection cannot be bypassed by successful observations',async()=>{
  const changes=[h=>{delete h.c.grant.signature;},h=>{h.c.grant.payload.revision='tampered';},
    h=>{h.c.grantContext.trustedKeys=new Map();},h=>h.setClock(2000),h=>h.setClock(999),
    h=>{h.c.grantContext.revocation.available=false;},h=>{h.c.grantContext.revocation.revokedRecords=['record-1'];},
    h=>{h.c.grantContext.expectedAuthority.body='wrong';},h=>{h.c.grantContext.expectedPolicy.core='wrong';},
    h=>{h.c.grantContext.expectedWork[0].scope.body='wrong';},
    h=>{h.c.request.path='secrets/key';},h=>{h.c.request.operation='merge';},
    h=>{h.p.work=h.p.work.slice(1);h.sign();h.c.grantContext.expectedWork=h.p.work;},
  ];
  for(const change of changes){const h=harness();change(h);assert.equal((await h.write()).outcome,'failed');assert.equal(writes(h),0);}
});
test('fresh eligibility and first write never authorize changed next checkpoint',async()=>{
  for(const change of [h=>{h.replies[permission].permission='read';},h=>{h.replies[issue].assignees=[];},
    h=>{h.replies[repo].private=true;},h=>{h.replies[repo].id='4';},h=>{h.replies['/user'].id=8;},
    h=>h.setClock(2000),h=>{h.c.grantContext.revocation.revokedRecords=['record-1'];}]){
    const h=harness();assert.equal((await h.boundary.eligibility()).ok,true);
    assert.equal((await h.write()).outcome,'submitted');change(h);
    assert.equal((await h.write()).outcome,'failed');assert.equal(writes(h),1);
  }
});
test('trusted write mapping rejects cross operation/Issue and cannot reuse mutable result',async()=>{
  const h=harness(); const result=await h.boundary.eligibility(); result.ok=true;
  for(const patch of [{endpoint:'/repos/example-org/core/issues/102'},{operation:'merge'},{target:'42'}]){
    assert.equal((await h.boundary.request({method:'PATCH',endpoint:issue,operation:'deliver',correlation:'test',target:'123',context:result,...patch})).outcome,'failed');
  }
  assert.equal(writes(h),0);
});
test('clock regression and exhausted checkpoint duration reject',async()=>{
  for(const time of [1099,1150,NaN]){
    let h;h=harness({transport:async(r,replies)=>{h.setClock(time);return {status:200,body:JSON.stringify(replies[r.endpoint])};}});
    assert.equal((await h.write()).outcome,'failed');assert.equal(writes(h),0);
  }
});
test('endpoint failures and secret-bearing malformed responses remain bounded and write-free',async()=>{
  for(const status of [401,403,404,429,500]) for(const failing of ['/user',permission]){
    const h=harness({transport:async(r,replies)=>r.endpoint===failing?{status,headers:{},body:'SECRET_TOKEN private response'}:{status:200,body:JSON.stringify(replies[r.endpoint])}});
    const result=await h.write();assert.equal(result.outcome,'failed');assert.equal(writes(h),0);
    assert.equal(JSON.stringify(result).includes('SECRET'),false);
    const eligibility=await h.boundary.eligibility();
    assert.equal(eligibility.ok,false);assert.equal(eligibility.diagnostic.status,status);
    assert.equal(JSON.stringify(eligibility).includes('SECRET'),false);
  }
  const h=harness({transport:async()=>({status:200,body:'SECRET malformed'})});
  assert.equal((await h.boundary.eligibility()).diagnostic.kind,'malformed');assert.equal(writes(h),0);
});
test('timeout and cancellation reject before submission',async()=>{
  for(const cancel of [false,true]){
    const h=harness({config:{elapsedMs:5},transport:async()=>new Promise(resolve=>setTimeout(()=>resolve({status:401,body:"{}"}),30))});
    if(cancel){const ac=new AbortController();ac.abort();assert.equal((await h.boundary.eligibility({}, {signal:ac.signal})).ok,false);}
    else assert.equal((await h.write()).outcome,'failed');
    assert.equal(writes(h),0);
  }
});
test('unknown write never resubmits; readback can verify or remain unknown',async()=>{
  const h=harness({transport:async(r,replies)=>{if(r.method==='PATCH')throw Error('SECRET stderr');return {status:200,body:JSON.stringify(replies[r.endpoint])};}});
  const result=await h.write();assert.equal(result.outcome,'unknown');assert.equal(writes(h),1);
  const options={endpoint:issue,target:'123',operation:'deliver',correlation:'readback'};
  assert.equal((await h.boundary.reconcile(result,options,d=>d.node_id==='I_101')).outcome,'verified');
  assert.equal((await h.boundary.reconcile(result,options,()=>false)).outcome,'unknown');
  h.replies[permission].permission='read';assert.equal((await h.write()).outcome,'failed');assert.equal(writes(h),1);
});
test('current Scope/work and repository membership are mandatory signed intersections',async()=>{
  for(const change of [
    h=>{h.p.work.forEach(w=>{w.repository.id='77';});h.p.permissions[0].repository.id='77';h.sign();},
    h=>{h.c.grantContext.expectedWork[0].currentBody.body='changed';},
    h=>{h.c.grantContext.expectedWork=[];},
    h=>{delete h.replies[issue].id;},
    h=>{h.replies[issue].repository_url='https://api.github.com/repos/other/core';},
    h=>{h.replies[repo].visibility='private';},
  ]){
    const h=harness();change(h);assert.equal((await h.write()).outcome,'failed');assert.equal(writes(h),0);
  }
});
test('checkpoint inputs are snapshotted before reads; later mutation only affects next call',async()=>{
  let h;
  h=harness({transport:async(r,replies)=>{
    h.c.member.id='99';h.c.request.operation='merge';
    return {status:200,body:JSON.stringify(r.method==='GET'?replies[r.endpoint]:{id:123})};
  }});
  assert.equal((await h.write()).outcome,'submitted');
  assert.equal((await h.write()).outcome,'failed');assert.equal(writes(h),1);
});
test('trusted operation mapping sees exact serialized body; mutation cannot change submission',async()=>{
  const h=harness();let seen;
  const b=createAuthorizationBoundary({now:()=>1100,maxCheckpointMs:50,
    getCheckpoint:intent=>{seen=intent.body;if(intent.method && intent.body?.state)throw Error('disallowed side effect');
      if(intent.body)intent.body.title='changed by callback';return h.c;},
    transport:async r=>{h.calls.push(r);return {status:200,body:JSON.stringify(r.method==='GET'?h.replies[r.endpoint]:{id:123})};}});
  const request={method:'PATCH',endpoint:issue,operation:'deliver',correlation:'payload',target:'123'};
  assert.equal((await b.request({...request,body:{state:'closed'}})).outcome,'failed');assert.equal(writes(h),0);
  assert.equal((await b.request({...request,body:{title:'exact'}})).outcome,'submitted');
  assert.equal(seen.title,'changed by callback');assert.equal(h.calls.at(-1).body,'{"title":"exact"}');
});
test('within-window clock regression rejects earlier observations now in the future',async()=>{
  for(const entry of ['eligibility','write']) {
    let h;
    h=harness({transport:async(r,replies)=>{
      h.setClock(r.endpoint==='/user'?1120:1110);
      return {status:200,body:JSON.stringify(replies[r.endpoint])};
    }});
    if(entry==='eligibility')assert.equal((await h.boundary.eligibility()).ok,false);
    else assert.equal((await h.write()).outcome,'failed');
    assert.equal(writes(h),0);
  }
});
test('advancing checkpoint clock accepts observations within the freshness bound',async()=>{
  let h,time=1100;
  h=harness({transport:async(r,replies)=>{
    h.setClock(++time);
    return {status:200,body:JSON.stringify(r.method==='GET'?replies[r.endpoint]:{id:123})};
  }});
  assert.equal((await h.boundary.eligibility()).ok,true);
  assert.equal((await h.write()).outcome,'submitted');assert.equal(writes(h),1);
});
