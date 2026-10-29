import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,copyFileSync,mkdirSync,mkdtempSync,unlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {distributionAPI,distributionOwners,distributionIdentity,createInstallation,
  planInstallationTransition,applyInstallationTransition} from '../src/index.mjs';
const pin='a'.repeat(64),git='a'.repeat(40);
const policy={version:1,repository:'example/project',repositoryId:'101',ownerId:'12',runnerId:'23',runnerName:'member-one',
  runnerDirectory:'/home/member/nibfin/registration',workerSha256:pin,workflowPath:'.github/workflows/nibfin.yml',workflowSha256:pin,
  jobName:'execute',allowedActorIds:['12'],ref:'refs/heads/main'};
function fixture(profile='source'){
  const identity=distributionIdentity(),calls=[];
  const configuration={version:1,expected:{packageVersion:identity.packageVersion,coreSha256:identity.components.core.sha256},profile,
    observeCapability:async request=>{calls.push(request);return {...request,status:'verified'};}};
  if(profile==='member')configuration.runner={configuration:{version:1,platform:'linux',arch:'x64',path:'/usr/local/bin:/usr/bin:/bin',interpreter:'/usr/local/bin/node',
    work:'/fixture/work',scratch:'/fixture/scratch',cache:'/fixture/cache',account:{user:'member',uid:1000,githubUserId:'12'}},
    observe:async()=>({platform:'linux',arch:'x64',uid:1000,user:'member',tokenOverride:false,roots:{work:true,scratch:true,cache:true}}),
    probe:async()=>({status:'verified',userId:'12'})};
  return {identity,calls,configuration};
}
test('exact constructor/check/plan contract is read-only and binds ordinary hook integration',async()=>{
  for(const profile of ['source','member']){
    const f=fixture(profile),api=createInstallation(f.configuration);
    assert.equal(f.calls.length,0); // no callback at construction
    const result=await api.check();assert.deepEqual(Object.keys(result).sort(),['diagnostics','identity','scope','status','version']);
    assert.equal(result.version,1);assert.equal(result.status,'ready');assert.equal(result.scope,profile==='source'?'source-contract':'member-runtime');
    assert.deepEqual(result.identity.pins,f.identity.pins);assert.deepEqual(result.diagnostics,[]);
    const plan=await api.plan({commit:git,hostCommit:git,hostRepository:'taco3064/nibfin',admission:policy});
    assert.equal(plan.status,'planned');assert.equal(plan.admission.entry,'host/runner-job-hook.sh');
    assert.equal(plan.admission.manualCommandRequired,false);assert.equal(plan.admission.policies[0].repository,'example/project');
    assert.ok(plan.workflow.files.has('.github/workflows/nibfin-rescue.yml'));
    assert.equal([...plan.workflow.files.keys()].filter(p=>p.includes('rescue')).length,1);
    assert.deepEqual(plan.pins,result.identity.pins);
    assert.deepEqual(f.calls.map(c=>c.capability),Array(2).fill(['runtime','workflow','skills','source','recovery','jobAdmission']).flat());
  }
});
test('missing/incompatible capabilities never return ready or expose provider/credential canaries',async()=>{
  const canary='github_pat_PRIVATE_ADMISSION_TOKEN';
  for(const missing of ['runtime','workflow','skills','source','recovery','jobAdmission'])for(const result of [null,{version:99,status:'verified'},'throw']){
    const f=fixture();f.configuration.observeCapability=async r=>{
      if(r.capability!==missing)return {...r,status:'verified'};
      if(result==='throw')throw Error(canary);return result;
    };
    const api=createInstallation(f.configuration),r=await api.check();
    assert.equal(r.status,'blocked');assert.equal(r.diagnostics[0].capability,missing);
    assert.ok(r.diagnostics[0].action);assert.ok(!JSON.stringify(r).includes(canary));
    assert.equal((await api.plan()).status,'blocked');
  }
  const f=fixture();f.configuration.expected.coreSha256='f'.repeat(64);
  assert.equal((await createInstallation(f.configuration).check()).status,'blocked');assert.equal(f.calls.length,0);
  for(const update of [{version:2},{expected:{packageVersion:'latest',coreSha256:pin}},{profile:'unknown'},{observeCapability:null}])
    assert.throws(()=>createInstallation({...fixture().configuration,...update}));
  const g=fixture('member');g.configuration.runner.probe=async()=>{throw Error(canary);};
  const r=await createInstallation(g.configuration).check();assert.equal(r.status,'blocked');assert.ok(!JSON.stringify(r).includes(canary));
  assert.equal((await createInstallation(fixture().configuration).plan({commit:git,hostCommit:git,hostRepository:'taco3064/nibfin',admission:{}})).status,'blocked');
});
test('packaged ownership and current file hashes resolve all maintained responsibilities',()=>{
  const identity=distributionIdentity(),map=JSON.parse(readFileSync(new URL('../src/distribution-map.json',import.meta.url)));
  assert.deepEqual(map.api,distributionAPI);assert.equal(map.origin.reviewedNibfinBaseline.commit,'36bfe080e375da2a7beb6d2b9bc87bebc8c06f2d');
  assert.equal(map.origin.jobAdmission.commit,'6d8c3016923e0895dcecc6f462f47f33b035be4a');
  assert.equal(new Set(distributionOwners.map(o=>o.responsibility)).size,distributionOwners.length);
  for(const owner of distributionOwners)assert.ok(identity.components.core.files.some(f=>f.path===owner.owner));
  assert.ok(!identity.components.core.files.some(f=>f.path.startsWith('controller/')));
  assert.ok(map.origin.inputs.some(f=>f.path==='docs/rootless-hardening.md'));
});
function transition(){
  const pins={runtime:pin,workflow:pin,skills:pin,source:pin,recovery:pin,jobAdmission:pin};
  return {version:1,current:{packageVersion:'0.1.0',pins},next:{packageVersion:'0.1.1',pins:{...pins,runtime:'b'.repeat(64),source:'b'.repeat(64)}},
    work:{restrictionsChecked:true,hold:null,paused:false,unknownWrite:false,active:false,terminated:true,reconciled:true,
      conversations:['original-member-session'],pending:[{status:'UNACCEPTED',workspace:'original'}],receipts:[{id:'approved-historical',identity:pin}]}};
}
test('protected work blocks incompatible/active/paused/unreconciled upgrades without mutation',()=>{
  for(const change of [v=>v.next.packageVersion='1.0.0',v=>v.work.active=true,v=>v.work.paused=true,v=>v.work.hold={id:'owner'},
    v=>v.work.unknownWrite=true,v=>v.work.reconciled=false,v=>delete v.work.restrictionsChecked,v=>v.next.pins.skills='unknown']){
    const v=transition();change(v);const before=structuredClone(v);
    assert.equal(planInstallationTransition(v).status,'blocked');assert.deepEqual(v,before);
  }
  const v=transition(),before=structuredClone(v),r=planInstallationTransition(v);
  assert.equal(r.status,'planned');assert.equal(r.evidence,'fresh-gates-required');assert.deepEqual(v,before);
  assert.deepEqual(r.preserve,{conversations:v.work.conversations,pending:v.work.pending,receipts:v.work.receipts});
});
test('failed switch, confirmed switch and explicit rollback retain protected work; unknown writes never retry',async()=>{
  const v=transition(),work=structuredClone(v.work);let installation=v.current,calls=0,fail=true,unknown=false;
  const observe=async()=>({installation,work});
  const retain=async i=>({status:'retained',identity:i.identity,prior:unknown?'unresolved':'new'});
  const switchPins=async i=>{calls++;assert.deepEqual(i.expected,installation);if(fail)throw Error('private detail');installation=structuredClone(i.next);};
  const attempt=(current,next)=>applyInstallationTransition({current,next,observe,retain,switchPins});
  assert.equal((await attempt(v.current,v.next)).status,'failed');assert.deepEqual(installation,v.current);assert.deepEqual(work,v.work);
  fail=false;const switched=await attempt(v.current,v.next);assert.equal(switched.status,'switched');assert.deepEqual(installation,v.next);
  assert.equal((await attempt(v.next,v.current)).status,'switched');assert.deepEqual(installation,v.current);assert.deepEqual(work,v.work);
  unknown=true;const count=calls;assert.equal((await attempt(v.current,v.next)).status,'unknown');assert.equal(calls,count);
  installation=structuredClone(v.next);assert.equal((await attempt(v.current,v.next)).status,'switched');assert.equal(calls,count);
  work.unknownWrite=true;assert.equal((await attempt(v.current,v.next)).status,'blocked');assert.equal(calls,count);
});

test('isolated readiness bootstrap diagnoses missing/tampered package bytes before importing broken runtime owners',()=>{
  const original=fileURLToPath(new URL('../',import.meta.resolve('@nibfin/core'))),root=mkdtempSync(join(tmpdir(),'nibfin-readiness-'));
  const identity=distributionIdentity(),expected={packageVersion:identity.packageVersion,coreSha256:identity.components.core.sha256};
  try{
    for(const {path} of identity.components.core.files){mkdirSync(dirname(join(root,path)),{recursive:true});copyFileSync(join(original,path),join(root,path));}
    const script=`import {createInstallation} from ${JSON.stringify(pathToFileURL(join(root,'src/installation.mjs')).href)};
      const api=createInstallation({version:1,expected:${JSON.stringify(expected)},profile:'source',observeCapability:async r=>({...r,status:'verified'})});
      console.log(JSON.stringify(await api.check()));`;
    const check=()=>JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:root}}));
    assert.equal(check().status,'ready');
    for(const [path,capability] of [['src/runtime.mjs','runtime'],['.github/workflows/nibfin-delivery.yml','workflow'],['skills/deliver/SKILL.md','skills'],['src/rescue.mjs','recovery'],['host/runner-job-hook.sh','jobAdmission']]){
      const file=join(root,path),bytes=readFileSync(file);unlinkSync(file);
      let r=check();assert.equal(r.status,'blocked');assert.equal(r.diagnostics[0].capability,capability);
      writeFileSync(file,Buffer.concat([bytes,Buffer.from('github_pat_PRIVATE_CANARY')]));
      r=check();assert.equal(r.status,'blocked');assert.equal(r.diagnostics[0].capability,capability);
      assert.ok(!JSON.stringify(r).includes('PRIVATE_CANARY'));writeFileSync(file,bytes);
    }
    writeFileSync(join(root,'src/distribution-map.json'),'{}');assert.equal(check().status,'blocked');
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('a timed-out trusted capability read aborts and returns a sanitized readiness blocker',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  try{
    const f=fixture();let signal;
    f.configuration.observeCapability=async request=>{
      if(request.capability!=='runtime')return {...request,status:'verified'};
      signal=request.signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('private-read-error')),{once:true}));
    };
    const pending=createInstallation(f.configuration).check();
    t.mock.timers.tick(30000);const r=await pending;
    assert.equal(signal.aborted,true);assert.equal(r.status,'blocked');assert.equal(r.diagnostics[0].capability,'runtime');
    assert.ok(!JSON.stringify(r).includes('private-read-error'));
  }finally{t.mock.timers.reset();}
});

test('repository initialization plans require no existing Runner ID; member plans require its admission binding',async()=>{
  const input={commit:git,hostCommit:git,hostRepository:'taco3064/nibfin'};
  const init=await createInstallation(fixture().configuration).plan(input);
  assert.equal(init.status,'planned');assert.equal(init.readiness.scope,'source-contract');
  assert.equal(init.admission.policies,null);assert.equal(init.admission.policyRequiredAt,'runner-registration');
  assert.equal((await createInstallation(fixture('member').configuration).plan(input)).status,'blocked');
  assert.equal((await createInstallation(fixture().configuration).plan({...input,commit:'main'})).status,'blocked');
  assert.equal((await createInstallation(fixture().configuration).plan({...input,extra:true})).status,'blocked');
});
