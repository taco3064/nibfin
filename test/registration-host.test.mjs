import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/index.mjs';
import {configure} from '../host/entry.mjs';
import {registrationHostFixture} from '../tooling/registration-host-fixture.mjs';
const repo='/repos/example-org/core',permission=repo+'/collaborators/member/permission';
function entry(f,deployment=f.deployment()) {
  return core.createWorkflowEntry(configure({core:f.facade,mode:'registration',context:f.context,deployment}));
}
const invoke=(f,e=entry(f),signal)=>e.invoke('registration',f.input,f.context,{signal});
function encrypted(f){return f.response().entries.find(([p])=>p==='response.json')[1];}

test('first-party protected composition is inert and issues/decrypts personal and Org-owned Repository responses',async()=>{
  for(const ownership of ['User','Organization']) {
    const f=await registrationHostFixture();f.replies[repo].owner.type=ownership;
    const e=entry(f);assert.equal(f.posts(),0);assert.equal(f.calls.length,0);assert.equal(f.remote.remote.reads,0);
    const result=await invoke(f,e);assert.equal(result.status,'delivered',JSON.stringify(result));assert.equal(f.posts(),1);
    const sourcePolicy=f.config.source.policy;
    const slots=core.registrationCustodySlots({source:{repository:f.context.repository,repositoryId:f.context.repositoryId,
      runId:'44',attempt:'1',revision:sourcePolicy.workflow_sha},workflow:sourcePolicy.workflow_ref,
      ref:sourcePolicy.ref,request:f.request});
    const responseSlot=slots['registration-response'];
    assert.equal(result.response,core.custodySlotIdentity(responseSlot));
    const consumer=core.createCustodyHost({...f.deployment().custody,now:()=>f.state.time,
      expect:async({kind,key})=>{assert.equal(key,slots[kind].key);return slots[kind];}});
    const held=await consumer.recover({kind:responseSlot.kind,key:responseSlot.key});
    assert.equal(held.outcome,'recovered');
    const bytes=Buffer.from(held.value.bytes,'base64'),expected=held.value.binding;
    assert(bytes.equals(encrypted(f)));
    const opened=core.openRegistrationResponse(bytes,{expected,privateKey:f.keys.privateKey,now:()=>f.state.time});
    assert.equal(opened.outcome,'available');assert.equal(opened.token,f.sentinel);
    assert.equal(expected.registrationId,f.context.repositoryId);
    assert(!JSON.stringify(result).includes(f.sentinel));
    for(const a of f.remote.remote.artifacts.values())for(const [,b]of a.entries)assert(!b.toString().includes(f.sentinel));
    assert.equal((await invoke(f,entry(f))).status,'retained');assert.equal(f.posts(),1);
  }
});

test('invalid protected configuration rejects at inert construction',async()=>{
  const f=await registrationHostFixture();
  for(const change of [d=>delete d.identity,d=>delete d.custody,d=>delete d.registration.policy,
    d=>d.registration.request.input.public_key='invalid',d=>d.registration.request.requester.id='999',
    d=>d.registration.module='event-selected.mjs',d=>d.custody.expect=()=>{}]) {
    const d=f.deployment();change(d);assert.throws(()=>entry(f,d));assert.equal(f.posts(),0);
  }
});

test('authenticated source and exact protected request reject forgery without token POST',async()=>{
  for(const change of [f=>f.input.nibfin_registration='forged',f=>f.input.level='organization',
    f=>f.input.public_key=f.input.public_key+' ',f=>f.context.repositoryId='99',f=>f.context.run.attempt='2',
    f=>f.context.eventName='issues',f=>f.replies[repo].id='99',f=>f.replies[repo].private=true,
    f=>f.replies[repo+'/actions/runs/44/attempts/1'].actor.id='999',
    f=>f.replies[repo+'/actions/runs/44/attempts/1'].head_sha='a'.repeat(40)]) {
    const f=await registrationHostFixture(),e=entry(f);change(f);
    assert.notEqual((await invoke(f,e)).status,'delivered');assert.equal(f.posts(),0);
  }
  for(const claims of [{actor_id:'99'},{ref:'refs/heads/untrusted'},{run_attempt:'2'},{workflow_ref:'wrong'}]){
    const f=await registrationHostFixture();f.state.token=await f.sign(claims);
    assert.equal((await invoke(f)).status,'blocked');assert.equal(f.posts(),0);
  }
});

test('current Write/Maintain/Admin without Issue/Grant; policy and permissions fail closed',async()=>{
  for(const right of ['write','maintain','admin']) {
    const f=await registrationHostFixture();f.replies[permission].permission=right;
    assert.equal((await invoke(f)).status,'delivered');assert.equal(f.posts(),1);
  }
  for(const change of [f=>f.policy.enabled=false,f=>f.policy.capabilities['administration:write']=false,
    f=>f.replies[permission].permission='read',f=>f.replies[permission].permission='triage',
    f=>f.replies['/users/member'].id='99',f=>f.replies[permission].user.id='99',
    f=>f.state.reply=()=>({status:403,body:'{}'})]){
    const f=await registrationHostFixture();change(f);assert.notEqual((await invoke(f)).status,'delivered');assert.equal(f.posts(),0);
  }
  for(const change of [f=>f.policy.enabled=false,f=>f.replies[permission].permission='read',
    f=>f.state.token='forged']) {
    const f=await registrationHostFixture();f.state.credentialHook=()=>change(f);
    assert.notEqual((await invoke(f)).status,'delivered');assert.equal(f.posts(),0);
  }
});

test('Organization level requires independent policy and matching organization identity',async()=>{
  for(const allowed of [true,false]) {
    const f=await registrationHostFixture();f.input.level='organization';f.policy.organization.enabled=allowed;
    assert.equal((await invoke(f)).status,allowed?'delivered':'denied');assert.equal(f.posts(),allowed?1:0);
    if(allowed)assert.equal(JSON.parse(encrypted(f)).context.registrationId,'17');
  }
});

test('fresh instances preserve lost issuance and result retention uncertainty without reissuing',async()=>{
  for(const failure of ['lostPost','failResult']) {
    const f=await registrationHostFixture();f.state[failure]=true;
    assert.equal((await invoke(f)).status,'unknown');assert.equal(f.posts(),1);
    f.state[failure]=false;
    const second=await invoke(f,entry(f));
    assert.equal(second.status,failure==='failResult'?'retained':'unknown');assert.equal(f.posts(),1);
  }
  const f=await registrationHostFixture();f.remote.remote.lostUpload='result';f.remote.remote.lossFilter=name=>name.startsWith('registration-');
  const result=await invoke(f);assert.equal(result.status,'delivered');assert.equal(f.posts(),1);
  const uploads=f.remote.remote.uploads;
  assert.equal((await invoke(f,entry(f))).status,'retained');assert.equal(f.remote.remote.uploads,uploads);
});

test('missing, conflicting, inaccessible and expired retained records cannot manufacture a first attempt',async()=>{
  for(const corrupt of [f=>f.remote.remote.artifacts.clear(),f=>f.remote.remote.duplicate=true,
    f=>f.remote.remote.error=403,f=>f.remote.remote.archiveChange=()=>Buffer.from('bad'),
    f=>f.state.time=Date.parse('2031-01-01')]) {
    const f=await registrationHostFixture();assert.equal((await invoke(f)).status,'delivered');
    corrupt(f);assert.notEqual((await invoke(f,entry(f))).status,'delivered');assert.equal(f.posts(),1);
  }
});

test('official endpoint denial and missing Organization capability are safe and never fall back',async()=>{
  for(const status of [401,403]) {
    const f=await registrationHostFixture();f.state.postStatus=status;
    const result=await invoke(f);assert.equal(result.status,'denied');assert.equal(f.posts(),1);
    assert(!JSON.stringify(result).includes(f.sentinel));
    assert.equal((await invoke(f,entry(f))).status,'unknown');assert.equal(f.posts(),1);
  }
  for(const change of [f=>f.policy.capabilities['organization_self_hosted_runners:write']=false,
    f=>f.policy.organization.id='99',f=>f.replies[repo].owner.type='User']) {
    const f=await registrationHostFixture();f.input.level='organization';change(f);
    assert.notEqual((await invoke(f)).status,'delivered');assert.equal(f.posts(),0);
  }
});

test('interrupted pre-issuance intent never becomes permission to issue on restart',async()=>{
  for(const phase of ['intent','result']) {
    const f=await registrationHostFixture();f.remote.remote.failUpload=phase;
    assert.notEqual((await invoke(f)).status,'delivered');assert.equal(f.posts(),0);
    f.remote.remote.failUpload=null;
    assert.notEqual((await invoke(f,entry(f))).status,'delivered');assert.equal(f.posts(),0);
  }
});

test('post-publication result recovery reads exact ciphertext and never repeats uploads',async()=>{
  const f=await registrationHostFixture();f.state.failResult=true;
  assert.equal((await invoke(f)).status,'unknown');assert.equal(f.posts(),1);
  const uploads=f.remote.remote.uploads;f.state.failResult=false;
  assert.equal((await invoke(f,entry(f))).status,'retained');assert.equal(f.posts(),1);
  assert.equal(f.remote.remote.uploads,uploads);
  // Retained ciphertext without a publication/cleanup observation is insufficient.
  for(const [id,a]of f.remote.remote.artifacts) {
    if(a.entries.some(([path,b])=>path==='host-record.json'&&JSON.parse(b).slot.kind==='registration-publication'))
      f.remote.remote.artifacts.delete(id);
  }
  assert.notEqual((await invoke(f,entry(f))).status,'retained');assert.equal(f.posts(),1);
});

test('cancellation and hanging protected policy are bounded before token submission',async()=>{
  const f=await registrationHostFixture(),controller=new AbortController();controller.abort();
  assert.equal((await invoke(f,entry(f),controller.signal)).status,'blocked');assert.equal(f.posts(),0);
  const g=await registrationHostFixture();g.state.policyHook=()=>new Promise(()=>{});
  const d=g.deployment();d.registration.timeoutMs=30;
  const keep=setTimeout(()=>{},1000);
  try {assert.equal((await invoke(g,entry(g,d))).status,'unknown');assert.equal(g.posts(),0);}
  finally {clearTimeout(keep);}
});

test('approved workflow CLI loads first-party registration with official OIDC/hosted transport contracts',async()=>{
  const {registrationSourceFixture}=await import('../tooling/registration-host-fixture.mjs');
  const {join}=await import('node:path');
  const {pathToFileURL}=await import('node:url');
  const {readFile,writeFile}=await import('node:fs/promises');
  const f=await registrationHostFixture(),checkout=await registrationSourceFixture();
  const originalFetch=globalThis.fetch;let posts=0;const endpoints=[];
  const management='PROTECTED-MANAGEMENT-CREDENTIAL';
  const reply=(url,data,status=200)=>{
    const response=new Response(JSON.stringify(data),{status});Object.defineProperty(response,'url',{value:url});return response;
  };
  globalThis.fetch=async(url,args)=>{
    endpoints.push([url,args.method??'GET']);
    if(url===core.actionsDiscovery)return reply(url,{issuer:core.actionsIssuer,jwks_uri:core.actionsJwks,id_token_signing_alg_values_supported:['RS256']});
    if(url===core.actionsJwks)return reply(url,f.facility.jwks);
    const endpoint=url.slice('https://api.github.com'.length);
    assert.equal(url,'https://api.github.com'+endpoint);assert.equal(args.headers.Authorization,'Bearer '+management);
    assert.equal(args.redirect,'error');
    if(args.method==='POST') {
      posts++;assert.equal(endpoint,repo+'/actions/runners/registration-token');
      // A durable original intent already exists in the independent provider store.
      assert([...f.remote.remote.artifacts.values()].some(a=>a.entries.some(([p,b])=>
        p==='host-record.json'&&JSON.parse(b).slot.kind==='registration-intent'&&JSON.parse(b).phase==='result')));
      return reply(url,{token:f.sentinel,expires_at:'2030-01-01T00:00:00Z'});
    }
    if(endpoint===repo+'/actions/runs/44/attempts/1') {
      const result=JSON.parse((await f.remote.transport({method:'GET',endpoint})).body);
      return reply(url,{...result,...f.replies[endpoint],repository:result.repository});
    }
    if(endpoint.startsWith(repo+'/actions/')) {
      const result=await f.remote.transport({method:args.method,endpoint});
      return reply(url,JSON.parse(result.body),result.status);
    }
    assert(Object.hasOwn(f.replies,endpoint),endpoint);return reply(url,f.replies[endpoint]);
  };
  const marker='__nibfinRegistrationContractFixture';
  assert.equal(globalThis[marker],undefined);
  try {
    const d=f.deployment();
    d.identity.api.getCredential=()=>({token:management,installationId:'7',expiresAt:60000,
      repositoryIds:[f.context.repositoryId],permissions:{administration:'write',actions:'read',metadata:'read'}});
    // Custody must pass the same maintained permission/scoping boundary as identity.
    d.custody.provider=core.createGithubProvider({attempts:1,transport:core.hostedGithubTransport({
      getCredential:d.identity.api.getCredential,repository:f.context.repository,
      repositoryId:f.context.repositoryId,now:()=>f.state.time})});
    globalThis[marker]=d;
    const source=`const d=globalThis.${marker};
export const capabilities={registration:d.capabilities};
export const identity={registration:d.identity};
export const custody={registration:d.custody};
export const registration={registration:d.registration};`;
    const options=JSON.stringify({registration:d.options});
    const env={GITHUB_WORKSPACE:checkout.root,GITHUB_EVENT_PATH:join(checkout.root,'event.json'),
      GITHUB_OUTPUT:join(checkout.root,'output'),GITHUB_EVENT_NAME:'workflow_dispatch',
      GITHUB_REPOSITORY:f.context.repository,GITHUB_REPOSITORY_ID:f.context.repositoryId,
      GITHUB_RUN_ID:'44',GITHUB_RUN_ATTEMPT:'1',NIBFIN_BUNDLE_COMMIT:checkout.bundleApproval.commit,
      NIBFIN_HOST_COMMIT:checkout.hostApproval.commit,NIBFIN_HOST_REPOSITORY:'taco3064/nibfin',
      NIBFIN_HOST_ROOT:checkout.host,NIBFIN_MODE:'registration',NIBFIN_INPUT:JSON.stringify(f.input),
      NIBFIN_HOST_OPTIONS:options,NIBFIN_HOST_CAPABILITY_SOURCE:source,
      NIBFIN_SOURCE_APPROVALS:JSON.stringify({bundle:checkout.bundleApproval,host:checkout.hostApproval,
        deployment:{sourceSha256:core.byteDigest(Buffer.from(source)),optionsSha256:core.byteDigest(Buffer.from(options))}})};
    const {workflowMain}=await import(pathToFileURL(join(checkout.bundle,'src/workflow-entry.mjs')));
    await writeFile(env.GITHUB_EVENT_PATH,'{}');
    const code=await workflowMain(env);assert.equal(code,0,(await readFile(env.GITHUB_OUTPUT,'utf8'))+JSON.stringify(endpoints));
    const output=await readFile(env.GITHUB_OUTPUT,'utf8');assert.match(output,/status=delivered\nresponse=[a-f0-9]{64}\n/);
    assert(!output.includes(f.sentinel)&&!output.includes(management));assert.equal(posts,1);
    assert(endpoints.some(([url])=>url==='https://api.github.com'+repo+'/actions/runs/44'));
    env.GITHUB_OUTPUT=join(checkout.root,'retained');
    assert.equal(await workflowMain(env),0);assert.equal(posts,1);
    assert.match(await readFile(env.GITHUB_OUTPUT,'utf8'),/status=retained/);
    env.NIBFIN_HOST_CAPABILITY_SOURCE+='throw Error("unapproved");';env.GITHUB_OUTPUT=join(checkout.root,'rejected');
    assert.equal(await workflowMain(env),1);assert.equal(posts,1);
    assert.match(await readFile(env.GITHUB_OUTPUT,'utf8'),/status=blocked/);
  } finally {globalThis.fetch=originalFetch;delete globalThis[marker];await checkout.cleanup();}
});

test('cleanup failure remains unconfirmed across fresh adapters despite exact ciphertext',async()=>{
  const f=await registrationHostFixture();let root;
  f.state.remove=async path=>{root=path;throw Error(f.sentinel);};
  const {rm}=await import('node:fs/promises');
  try {
    const result=await invoke(f);assert.equal(result.status,'unconfirmed');assert.equal(f.posts(),1);
    assert.equal((await invoke(f,entry(f))).status,'unknown');assert.equal(f.posts(),1);
    assert(!JSON.stringify(result).includes(f.sentinel));
  } finally {if(root)await rm(root,{recursive:true,force:true});}
});

test('published v1 schema matches request, fixed statuses and the encrypted response surface',async()=>{
  const {readFile}=await import('node:fs/promises');
  const schema=JSON.parse(await readFile(new URL('../host/registration.schema.json',import.meta.resolve('../src/index.mjs'))));
  // Resolve relative to package root in both source and installed consumers.
  const f=await registrationHostFixture(),result=await invoke(f);
  assert.equal(schema.$defs.request.additionalProperties,false);
  assert.deepEqual(Object.keys(f.input).sort(),schema.$defs.request.required.slice().sort());
  assert.equal(schema.$defs.request.properties.public_key.maxLength,8192);
  assert.equal(schema.$defs.output.properties.status.enum.includes(result.status),true);
  const envelope=JSON.parse(encrypted(f));
  assert.deepEqual(Object.keys(envelope).sort(),schema.$defs.envelope.required.slice().sort());
  assert.deepEqual(Object.keys(envelope.context).sort(),schema.$defs.context.required.slice().sort());
  for(const status of ['blocked','unknown','unconfirmed','retained','delivered','denied','unavailable','expired'])
    assert(schema.$defs.output.properties.status.enum.includes(status));
});

test('a matching result cannot replace a missing original intent or exact known artifact ID',async()=>{
  for(const change of ['original-intent','artifact-id']) {
    const f=await registrationHostFixture();assert.equal((await invoke(f)).status,'delivered');
    if(change==='original-intent'){
      for(const [id,a]of f.remote.remote.artifacts)if(a.entries.some(([p,b])=>p==='host-record.json'
        &&JSON.parse(b).slot.kind==='registration-intent'))f.remote.remote.artifacts.delete(id);
    } else {
      const response=f.response();f.remote.remote.artifacts.delete(response.id);
      f.remote.remote.artifacts.set('999',{...response,id:'999'});
    }
    assert.equal((await invoke(f,entry(f))).status,'unknown');assert.equal(f.posts(),1);
  }
});
