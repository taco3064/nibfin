import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {readFile, stat, access} from 'node:fs/promises';
import {createRegistrationHost, createRegistrationArtifactChannel, registrationArtifactReader,
  openRegistrationResponse, createGithubProvider} from '../src/index.mjs';
import {zipFixture} from '../tooling/custody-fixture.mjs';

const pair = () => {
  const k = generateKeyPairSync('rsa',{modulusLength:2048});
  return {publicKey:k.publicKey.export({type:'spki',format:'pem'}),privateKey:k.privateKey.export({type:'pkcs8',format:'pem'})};
};
const keys = pair(), sentinel = 'SENTINEL-registration-secret';
function fixture() {
  const s = {authenticated:true,event:'workflow_dispatch',requestId:'request-1',requester:{id:'8',login:'member'},
    repository:'example/core',repositoryId:'42',runId:'91',attempt:'1',level:'repository',publicKey:keys.publicKey};
  const p = {enabled:true,repository:s.repository,repositoryId:'42',capabilities:{'administration:write':true,
    'organization_self_hosted_runners:write':true},organization:{enabled:true,login:'example',id:'7'}};
  const state = {now:Date.parse('2026-10-25T00:00:00Z'),permission:'write',ownerType:'User',
    expiry:'2026-10-25T01:00:00Z',change:x=>x,readChange:x=>x};
  const calls = [], staged = [], paths = []; let zip, captured, posts = 0;
  const transport = async r => {
    calls.push(r);
    let d;
    if (r.method === 'POST') {
      posts++;
      if (state.loss) throw Error(sentinel);
      if (state.hang) return new Promise(()=>{});
      if (state.status) return {status:state.status,headers:{},body:sentinel};
      d = {token:sentinel,expires_at:state.expiry};
      if (state.tokenChange) d = state.tokenChange(d);
    } else if (r.endpoint === '/repos/example/core') d = {id:'42',full_name:'example/core',private:false,
      visibility:'public',owner:{id:'7',login:'example',type:state.ownerType}};
    else if (r.endpoint === '/repos/example/core/collaborators/member/permission')
      d = {permission:state.permission,user:{id:'8',login:'member'}};
    else if (r.endpoint === '/users/member') d = {id:'8',login:'member'};
    else if (r.endpoint === '/orgs/example') d = {id:'7',login:'example'};
    else if (r.endpoint === '/repos/example/core/actions/runs/91') d = {id:'91',run_attempt:1,repository:{id:'42'}};
    else if (r.endpoint === '/repos/example/core/actions/runs/91/artifacts?per_page=100') d = {total_count:1,artifacts:[{
      id:'92',name:'registration-request-1-1',expired:false,expires_at:'2030-01-01T00:00:00Z',
      workflow_run:{id:'91'},size_in_bytes:zip.length}]};
    else throw Error('Unexpected endpoint');
    return {status:200,headers:{},body:JSON.stringify(state.change(d,r))};
  };
  const reader = registrationArtifactReader({provider:createGithubProvider({transport,attempts:1}),archive:async r=> {
    assert.equal(r.endpoint,'/repos/example/core/actions/artifacts/92/zip');
    return {status:200,bytes:state.zipChange?state.zipChange(zip):zip};
  }});
  const client = {async uploadArtifact(name, files, root, options) {
    assert.equal(name,'registration-request-1-1'); assert.deepEqual(options,{retentionDays:1,compressionLevel:6});
    assert.equal(files.length,1); assert.equal((await stat(root)).mode & 0o777,0o700);
    paths.push(root);
    captured = await readFile(files[0]); staged.push(captured.toString());
    assert.equal((await stat(files[0])).mode & 0o777,0o600);
    zip = zipFixture([['response.json',captured]]);
    if (state.uploadLoss) throw Error(sentinel);
    return {id:'92'};
  }};
  const runtime = {facility:'@actions/artifact@2.3.2',available:true,repository:'example/core',repositoryId:'42',runId:'91',attempt:'1'};
  const channel = createRegistrationArtifactChannel({client,runtime,now:()=>state.now,
    read:async arg => {if (state.readFailure) throw Error(sentinel); const back = await reader(arg); return state.readChange(back);},
    ...(state.remove?{remove:state.remove}:{})});
  let policyCalls = 0;
  const host = options => createRegistrationHost({authenticate:async handle => {
    assert.equal(handle,'opaque-host-handle'); return s;
  },policy:async () => {policyCalls++; if (state.policyChange && policyCalls % 2 === 0) return {...p,enabled:false}; return p;},
  transport,channel,now:()=>state.now,...options});
  return {s,p,state,calls,staged,paths,host,channel,reader,client,runtime,
    issue:options=>host(options).issue('opaque-host-handle'),bytes:()=>captured,posts:()=>posts};
}

test('official repository calls, encrypted readback, consumption and cleanup for personal and org ownership',async()=>{
  for (const ownerType of ['User','Organization']) for (const permission of ['write','maintain','admin']) {
    const f = fixture(); f.state.ownerType=ownerType; f.state.permission=permission;
    const r = await f.issue(); assert.equal(r.outcome,'delivered',JSON.stringify(r));
    const post = f.calls.find(r=>r.method==='POST');
    assert.equal(post.endpoint,'/repos/example/core/actions/runners/registration-token');
    assert.equal(post.body,'{}'); assert.deepEqual(post.headers,{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10'});
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
