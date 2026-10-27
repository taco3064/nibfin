import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {readFile, stat, access} from 'node:fs/promises';
import {createRegistrationHost, createRegistrationArtifactChannel, registrationArtifactReader,
  openRegistrationResponse, createGithubProvider} from '../src/index.mjs';
import {zipFixture} from '../tooling/custody-fixture.mjs';

import {registrationFixture as fixture,registrationKeys as keys,registrationSentinel as sentinel,pair} from '../tooling/registration-fixture.mjs';

test('official repository calls, encrypted readback, consumption and cleanup for personal and org ownership',async()=>{
  for (const ownerType of ['User','Organization']) for (const permission of ['write','maintain','admin']) {
    const f = fixture(); f.state.ownerType=ownerType; f.state.permission=permission;
    const r = await f.issue(); assert.equal(r.outcome,'delivered',JSON.stringify(r));
    const post = f.calls.find(r=>r.method==='POST');
    assert.equal(post.endpoint,'/repos/example/core/actions/runners/registration-token');
    assert.equal(post.body,'{}'); assert.deepEqual(post.headers,{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'});
    const opened = openRegistrationResponse(f.bytes(),{privateKey:keys.privateKey,expected:r.context,now:()=>f.state.now});
    assert.equal(opened.token,sentinel); assert.equal(opened.expires_at,f.state.expiry);
    assert.equal(opened.url,'https://github.com/example/core'); assert.equal('runnerId' in r,false);
    assert.doesNotMatch(JSON.stringify(r)+f.staged.join(''),new RegExp(sentinel));
    for (const path of f.paths) await assert.rejects(access(path));
    assert.equal(f.calls.some(r=>r.endpoint.includes('/issues/')),false);
  }
});

test('off, changed, malformed or spoofed current authorization never posts',async()=>{
  const changes = [f=>{f.p.enabled=false;},f=>{delete f.p.enabled;},f=>{f.state.permission='read';},
    f=>{f.state.permission='triage';},f=>{f.state.permission=null;},f=>{f.s.authenticated=false;},
    f=>{f.s.event='pull_request';},f=>{f.s.requester.id='9';},f=>{f.s.repositoryId='43';},
    f=>{f.s.publicKey='invalid';},f=>{f.state.policyChange=true;},
    f=>{f.state.change=(d,r)=>r.endpoint==='/repos/example/core'?{...d,private:true}:d;},
    f=>{f.state.change=(d,r)=>r.endpoint==='/repos/example/core'?{...d,visibility:undefined}:d;},
    f=>{f.state.change=(d,r)=>r.endpoint==='/users/member'?{}:d;},
    f=>{f.state.change=(d,r)=>r.endpoint.endsWith('/permission')?{...d,user:{id:'9',login:'member'}}:d;}];
  for (const change of changes) {
    const f=fixture(); change(f); const r=await f.issue();
    assert.notEqual(r.outcome,'delivered'); assert.equal(f.posts(),0,JSON.stringify(r));
    assert.equal(f.staged.length,0);
  }
  const spoof=fixture();
  assert.equal((await spoof.host().issue({...spoof.s,authenticated:true})).outcome,'unavailable');
  assert.equal(spoof.posts(),0);
  const f=fixture(); assert.equal((await f.issue()).outcome,'delivered');
  f.state.permission='read'; assert.notEqual((await f.issue()).outcome,'delivered'); assert.equal(f.posts(),1);
  f.p.enabled=false; f.state.permission='write'; assert.equal((await f.issue()).outcome,'denied'); assert.equal(f.posts(),1);
});

test('organization issuance uses distinct official endpoint and independent management policy',async()=>{
  const f=fixture(); f.s.level='organization'; f.state.ownerType='Organization';
  const r=await f.issue(); assert.equal(r.outcome,'delivered'); assert.equal(r.context.registrationId,'7');
  assert.equal(r.url,'https://github.com/example');
  assert.equal(f.calls.find(c=>c.method==='POST').endpoint,'/orgs/example/actions/runners/registration-token');
  for (const mutation of [f=>{f.p.organization.enabled=false;},f=>{f.p.capabilities['organization_self_hosted_runners:write']=false;},
    f=>{f.p.organization.id='99';},f=>{f.state.ownerType='User';}]) {
    const x=fixture(); x.s.level='organization'; x.state.ownerType='Organization'; mutation(x);
    assert.notEqual((await x.issue()).outcome,'delivered'); assert.equal(x.posts(),0);
  }
  for (const status of [401,403]) {
    const x=fixture(); x.state.status=status; const result=await x.issue();
    assert.equal(result.outcome,'denied'); assert.equal(result.diagnostic.status,status);
    assert.equal(result.diagnostic.capability,'administration:write'); assert.equal(x.posts(),1);
    assert.doesNotMatch(JSON.stringify(result),new RegExp(sentinel));
  }
});

test('invalid, expired and delayed tokens cannot be delivered or consumed',async()=>{
  for (const value of [null,'bad','2026-10-24T00:00:00Z']) {
    const f=fixture(); f.state.expiry=value; assert.notEqual((await f.issue()).outcome,'delivered'); assert.equal(f.staged.length,0);
  }
  for (const change of [t=>({...t,token:''}),t=>({}),()=>'{']) {
    const f=fixture(); f.state.tokenChange=change; assert.notEqual((await f.issue()).outcome,'delivered');
  }
  const f=fixture(); const r=await f.issue();
  const open = options=>openRegistrationResponse(f.bytes(),{privateKey:keys.privateKey,expected:r.context,now:()=>f.state.now,...options});
  assert.equal(open({now:()=>Date.parse(f.state.expiry)}).outcome,'unavailable');
  assert.equal(open({privateKey:pair().privateKey}).outcome,'unavailable');
  for (const field of ['requestId','requesterId','repositoryId','registrationId','runId','attempt','recipient'])
    assert.equal(open({expected:{...r.context,[field]:'2'}}).outcome,'unavailable');
  const e=JSON.parse(f.bytes()); e.ciphertext=Buffer.from('altered').toString('base64');
  assert.equal(openRegistrationResponse(Buffer.from(JSON.stringify(e)),{privateKey:keys.privateKey,expected:r.context}).outcome,'unavailable');
  const delayed=fixture(); delayed.state.readChange=b=>{delayed.state.now=Date.parse(delayed.state.expiry);return b;};
  assert.notEqual((await delayed.issue()).outcome,'delivered');
});

test('ambiguous effects, readback rejection and cleanup failures remain sanitized without replay',async()=>{
  for (const setup of [f=>{f.state.loss=true;},f=>{f.state.readFailure=true;},
    f=>{f.state.readChange=b=>({...b,bytes:Buffer.from('mismatch')});},
    f=>{f.state.readChange=b=>({...b,artifactId:'999'});},
    f=>{f.state.change=(d,r)=>r.endpoint.includes('/artifacts?')?{...d,artifacts:[d.artifacts[0],d.artifacts[0]]}:d;},
    f=>{f.state.change=(d,r)=>r.endpoint.endsWith('/runs/91')?{...d,run_attempt:2}:d;},
    f=>{f.state.zipChange=()=>Buffer.from('bad zip');},
    f=>{f.state.change=(d,r)=>r.endpoint.includes('/artifacts?')?{...d,artifacts:[]}:d;}]) {
    const f=fixture();setup(f);const r=await f.issue();
    assert.ok(['unknown','unconfirmed'].includes(r.outcome),JSON.stringify(r));assert.equal(f.posts(),1);
    assert.doesNotMatch(JSON.stringify(r),new RegExp(sentinel));
    for(const path of f.paths) await assert.rejects(access(path));
  }
  const f=fixture(); f.state.uploadLoss=true;
  assert.equal((await f.issue()).outcome,'delivered'); assert.equal(f.posts(),1); // reconciled exact readback
  const x=fixture(); let root;
  const channel=createRegistrationArtifactChannel({client:x.client,runtime:x.runtime,read:x.reader,now:()=>x.state.now,
    remove:async p=>{root=p;throw Error(sentinel);}});
  try {
    const r=await x.issue({channel});assert.equal(r.outcome,'unconfirmed');assert.equal(r.diagnostic.kind,'cleanup_incomplete');
    assert.doesNotMatch(JSON.stringify(r),new RegExp(sentinel));
  } finally {if(root) await (await import('node:fs/promises')).rm(root,{recursive:true,force:true});}
});

test('cancellation and provider timeout are bounded and never repeat issuance',async()=>{
  const f=fixture(), controller=new AbortController();controller.abort();
  assert.equal((await f.host().issue('opaque-host-handle',{signal:controller.signal})).outcome,'unavailable');assert.equal(f.posts(),0);
  const x=fixture();x.state.hang=true;
  const keep=setTimeout(()=>{},200); // AbortSignal timers do not keep the process alive
  try {assert.equal((await x.issue({timeoutMs:30})).outcome,'unknown'); assert.equal(x.posts(),1);}
  finally {clearTimeout(keep);}
});
