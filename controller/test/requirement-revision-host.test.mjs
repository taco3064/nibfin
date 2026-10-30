import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest,canonical } from '../src/core.mjs';
import { signGrant,coreDigest } from '../src/authority.mjs';
import { runtimeConfigurationHash } from '../src/runtime.mjs';
import { Store } from '../src/store.mjs';
import { unitId } from '../src/dynamic.mjs';
import { createRevisionHost,readRevisionIssue } from '../src/requirement-revision-host.mjs';
import { migrateRequirements } from '../src/requirement-revision.mjs';
import { revisionFixture } from './requirement-revision-fixture.mjs';

async function nativeFixture(t){
  const root=await mkdtemp(join(tmpdir(),'nibfin-native-revision-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const f=await revisionFixture(root),p=f.data.parentBundle.payload,r=f.data.revisionBundle.payload;
  const config={runnerId:'test-runner',stateDirectory:root,publicKeyPath:join(root,'owner-public.pem'),agent:{authDirectory:root+'-unused-auth'},
    grantSource:{repository:'retired-private-source',path:'fixture.json',ref:'main'},proposalSource:{repository:'retired-private-source',path:'old-proposal.txt',ref:'main'}};
  await writeFile(config.publicKeyPath,f.data.publicKey);
  p.actorGitHubUserId='77';p.policy.runtimeHash=runtimeConfigurationHash(config);p.policy.coreDigest=await coreDigest(process.cwd());
  r.requiredCoreDigest=p.policy.coreDigest;r.parentPayloadHash=digest(p);r.parentPolicyHash=digest(p.policy);
  for(const s of r.subjects){const i=p.manifest.issues.find(i=>i.id===s.issueId),store=new Store(root,unitId(p,i));
    await store.transaction(0,()=>f.data.states[i.id]);s.oldStateHash=digest(await store.read());}
  f.data.parentBundle=signGrant(p,f.data.privateKey);f.data.revisionBundle=signGrant(r,f.data.privateKey);
  const bundle={...f.data.parentBundle,requirementRevision:f.data.revisionBundle};
  const calls=[];let unavailable=false;
  const github={grant:async()=>structuredClone(bundle),text:async()=>p.proposal,
    api:async(path,method,body)=>{
      if(path==='/user')return {type:'User',id:77};
      assert.equal(path,'/graphql');assert.equal(method,'POST');assert.ok(body.query.startsWith('query('));
      if(unavailable)return {errors:[{type:'INSUFFICIENT_SCOPES'}]};
      return {data:{node:{id:body.variables.id,projectItems:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}};
    },
    repository:async repository=>({id:repository==='taco3064/gh-nibfin'?2:1}),
    issue:async i=>{const o=f.data.observations[i.id];const body=o.bodyHash===digest('Historical Gemini Shape')?'Historical Gemini Shape':
      r.subjects.find(s=>s.newScopeHash===o.bodyHash)?.newScopeBody || p.manifest.issues.find(s=>s.scopeHash===o.bodyHash).scopeBody;
      return {node_id:i.id,body,title:o.metadata.title,state:o.metadata.state,labels:o.metadata.labels.map(name=>({name})),assignees:[],milestone:null};},
    dependencies:async i=>f.data.observations[i.id].blockedBy.map(node_id=>({node_id})),
    list:async path=>{const number=Number(path.split('/')[5]),repository=path.split('/').slice(2,4).join('/');
      const i=p.manifest.issues.find(i=>i.repository===repository&&i.number===number);return f.data.observations[i.id].blocking.map(node_id=>({node_id}));},
    removeLabel:async(i,label)=>{assert.equal(i.id,'I_1');assert.equal(label,'shaped');calls.push({kind:'remove-label',id:i.id,label});
      f.data.observations[i.id].metadata.labels=['scope'];},
    updateIssue:async(i,patch)=>{assert.deepEqual(Object.keys(patch),['body']);calls.push({kind:'patch-body',id:i.id,patch});f.data.observations[i.id].bodyHash=digest(patch.body);}}
  const created=await createRevisionHost(config,process.cwd(),github,f.data.revisionBundle,{containers:async()=>[]});
  return {...created,f,github,calls,root,config,unavailable:()=>{unavailable=true;}};
}
test('real operator adapter preserves old stores and limits native writes to six bodies plus Gemini shaped retirement',async t=>{
  const f=await nativeFixture(t),before=[];
  for(const s of f.record.subjects){const i=f.grant.manifest.issues.find(i=>i.id===s.issueId);before.push(canonical(await new Store(f.root,unitId(f.grant,i)).read()));}
  await migrateRequirements(f.record,f.host);
  assert.equal(f.calls.filter(c=>c.kind==='patch-body').length,6);assert.equal(f.calls.filter(c=>c.kind==='remove-label').length,1);
  const retire=f.calls.findIndex(c=>c.kind==='remove-label');const gemini=f.calls.findIndex(c=>c.kind==='patch-body'&&c.id==='I_1');assert.ok(retire<gemini);
  for(const [n,s]of f.record.subjects.entries()){const i=f.grant.manifest.issues.find(i=>i.id===s.issueId);assert.equal(canonical(await new Store(f.root,unitId(f.grant,i)).read()),before[n]);}
  const archived=JSON.parse(await readFile(join(f.root,'requirement-archives',f.record.revisionHash,'I_1.json'),'utf8'));
  assert.equal(archived.state.issues.I_1.shape.body,'Historical Gemini Shape');assert.equal(archived.originalBundle.signature,f.f.data.parentBundle.signature);
  await migrateRequirements(f.record,f.host);assert.equal(f.calls.length,7);
});
test('unreadable Projects membership denies migration; it is not reported as empty or silently bypassed',async t=>{
  const f=await nativeFixture(t);f.unavailable();
  await assert.rejects(migrateRequirements(f.record,f.host),{code:'REVISION_PROJECT_READ_UNAVAILABLE'});assert.equal(f.calls.length,0);
});
test('native provider read checks stable identities and both relation directions',async t=>{
  const f=await nativeFixture(t),s=f.record.subjects[0];const observed=await readRevisionIssue(f.github,s);
  assert.deepEqual(observed.blockedBy,['I_6']);assert.deepEqual(observed.blocking,['I_3']);assert.deepEqual(observed.metadata.projects,[]);
  f.github.repository=async()=>({id:999});await assert.rejects(readRevisionIssue(f.github,s),{code:'REVISION_IDENTITY_CHANGED'});
});
test('native operator refuses unresolved queued requests for affected work and leaves them unchanged',async t=>{
  const f=await nativeFixture(t),store=new Store(f.root,'actions-outbox:undefined');
  const items={old:{request:{issueId:'I_1'},status:'attempted'}};
  await store.transaction(0,s=>({...s,items}));
  await assert.rejects(migrateRequirements(f.record,f.host),{code:'REVISION_OUTBOX_RECONCILIATION_REQUIRED'});
  assert.deepEqual((await store.read()).items,items);assert.equal(f.calls.length,0);
});
test('interruption during archive preparation resumes without replacing preserved history or issuing early writes',async t=>{
  const f=await nativeFixture(t),archive=f.host.archive;let first=true;
  f.host.archive=async(...args)=>{const result=await archive(...args);if(first){first=false;throw Error('Interrupted after first durable archive');}return result;};
  await assert.rejects(migrateRequirements(f.record,f.host));assert.equal(f.calls.length,0);
  const path=join(f.root,'requirement-archives',f.record.revisionHash,'I_0.json'),old=await readFile(path,'utf8');
  f.host.archive=archive;await migrateRequirements(f.record,f.host);assert.equal(await readFile(path,'utf8'),old);assert.equal(f.calls.length,7);
});
