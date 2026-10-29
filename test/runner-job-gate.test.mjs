import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runnerJobPolicy,runnerJobPolicies,verifyRunnerJobAdmission} from '../src/runner-job-gate.mjs';
const source=Buffer.from('name: reviewed\non: workflow_dispatch\njobs: {}\n');
const sha=createHash('sha256').update(source).digest('hex');
const policy={version:1,repository:'owner/project',repositoryId:'101',ownerId:'12',runnerId:'23',runnerName:'member-one',
  runnerDirectory:'/home/member/nibfin/registration',workerSha256:'b'.repeat(64),workflowPath:'.github/workflows/nibfin.yml',workflowSha256:sha,
  jobName:'execute',allowedActorIds:['12','41898282'],ref:'refs/heads/main'};
const fixture=()=>({context:{repository:'owner/project',runId:'700',attempt:2},
  localRunner:{id:'23',name:'member-one',repository:'owner/project',workerSha256:'b'.repeat(64)},
  run:{id:'700',run_attempt:2,event:'workflow_dispatch',status:'in_progress',head_branch:'main',path:policy.workflowPath,head_sha:'a'.repeat(40),
    repository:{id:'101',full_name:'owner/project',owner:{id:'12'}},head_repository:{id:'101'},actor:{id:'12'},triggering_actor:{id:'12'}},
  job:{run_id:'700',run_attempt:2,status:'in_progress',name:'execute',runner_id:'23',runner_name:'member-one',head_sha:'a'.repeat(40)},
  workflow:{type:'file',path:policy.workflowPath,encoding:'base64',size:source.length,content:source.toString('base64'),sha:createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex')}});

test('one exact installed Runner, authenticated Run/Attempt/job and reviewed source can pass admission',()=>{
  const result=verifyRunnerJobAdmission(policy,fixture());assert.equal(result.allowed,true);assert.equal(result.runnerId,'23');
  assert.ok(Object.isFrozen(runnerJobPolicy(policy).allowedActorIds));
});

test('reusable workflow dependencies must match the installed complete content set before any job steps',()=>{
  const dependency={path:'.github/workflows/nibfin-delivery-42.yml',sha256:sha},
    configured={...policy,workflowDependencies:[dependency]},observation=fixture();
  observation.workflowDependencies=[{...observation.workflow,path:dependency.path}];
  const checked=runnerJobPolicy(configured);assert.ok(Object.isFrozen(checked.workflowDependencies[0]));
  dependency.sha256='f'.repeat(64);assert.equal(checked.workflowDependencies[0].sha256,sha);
  assert.equal(verifyRunnerJobAdmission(checked,observation).allowed,true);
  for(const mutate of [o=>delete o.workflowDependencies,o=>o.workflowDependencies=[],
    o=>o.workflowDependencies.push({...o.workflowDependencies[0]}),o=>o.workflowDependencies[0].path=policy.workflowPath,
    o=>o.workflowDependencies[0].sha='e'.repeat(40),o=>o.workflowDependencies[0].type='symlink',
    o=>o.workflowDependencies[0].content=Buffer.from('replaced callee').toString('base64')]){
    const next=structuredClone(observation);mutate(next);
    assert.deepEqual(verifyRunnerJobAdmission(checked,next),{allowed:false,code:'workflow-dependency'});
  }
  for(const workflowDependencies of [[],Array(9).fill({path:'.github/workflows/other.yml',sha256:sha}),
    [{path:policy.workflowPath,sha256:sha}],[{path:'../../run.sh',sha256:sha}],
    [{path:'.github/workflows/reuse.yml',sha256:sha,ref:'main'}],
    [{path:'.github/workflows/reuse.yml',sha256:'main'}],
    [{path:'.github/workflows/reuse.yml',sha256:sha},{path:'.github/workflows/reuse.yml',sha256:sha}]])
    assert.throws(()=>runnerJobPolicy({...policy,workflowDependencies}),/invalid-dependencies/);
});
test('foreign/fork runs, changed actors, source, attempts or assigned Runner never pass',()=>{
  const cases=[o=>o.run.event='pull_request',o=>o.run.event='pull_request_target',o=>o.run.head_branch='attacker',
    o=>o.run.path='.github/workflows/other.yml',o=>o.run.repository.id='102',o=>o.run.repository.owner.id='13',
    o=>o.run.head_repository.id='102',o=>o.run.actor.id='13',o=>o.run.triggering_actor.id='13',
    o=>o.run.run_attempt=1,o=>o.context.attempt=1,o=>o.run.status='completed',o=>o.job.run_attempt=1,
    o=>o.job.run_id='701',o=>o.job.runner_id='24',o=>o.job.runner_name='other',o=>o.job.status='queued',
    o=>o.job.name='untrusted',o=>o.job.head_sha='c'.repeat(40),o=>o.localRunner.workerSha256='c'.repeat(64),
    o=>o.localRunner.repository='attacker/fork',o=>o.workflow.content=Buffer.from('changed').toString('base64'),
    o=>o.workflow.sha='c'.repeat(40),o=>o.workflow.type='symlink',o=>o.workflow.encoding='none',
    o=>o.workflow.size=65537,o=>o.workflow.content+='!',o=>o.context.repository='attacker/fork'];
  for(const mutate of cases){const o=fixture();mutate(o);assert.equal(verifyRunnerJobAdmission(policy,o).allowed,false,mutate.toString());}
});
test('policy cannot become a permissive fallback or choose an arbitrary host executable',()=>{
  for(const change of [{extra:true},{runnerId:23},{allowedActorIds:[]},{allowedActorIds:['12','12']},
    {runnerDirectory:'/home/member/../other'},{workflowSha256:'main'},{workflowPath:'../../run.sh'},
    {repository:'Owner/Project'},{ref:'refs/heads/../other'},{jobName:'execute\n'}])
    assert.throws(()=>runnerJobPolicy({...policy,...change}),/invalid-policy/);
});
test('Controller/Rescue policy set shares exactly one instance and has no ambiguous source selection',()=>{
  const rescue={...policy,workflowPath:'.github/workflows/nibfin-rescue.yml',jobName:'rescue',events:['workflow_dispatch','workflow_run']};
  assert.equal(runnerJobPolicies({schemaVersion:1,policies:[policy,rescue]}).length,2);
  assert.throws(()=>runnerJobPolicies({schemaVersion:1,policies:[policy,policy]}),/duplicate/);
  assert.throws(()=>runnerJobPolicies({schemaVersion:1,policies:[policy,{...rescue,runnerId:'24'}]}),/conflicting/);
  assert.throws(()=>runnerJobPolicies({schemaVersion:1,policies:[]}),/invalid-policy-set/);
  assert.throws(()=>runnerJobPolicy({...policy,events:['pull_request']}),/invalid-policy/);
  const observation=fixture();observation.run.event='workflow_run';
  assert.equal(verifyRunnerJobAdmission(policy,observation).allowed,false);
  assert.equal(verifyRunnerJobAdmission({...policy,events:['workflow_run']},observation).allowed,true);
});

test('missing or unavailable authenticated read observations deny rather than defaulting to admission',()=>{
 for(const field of ['context','run','job','workflow','localRunner']){
  const observation=fixture();delete observation[field];assert.equal(verifyRunnerJobAdmission(policy,observation).allowed,false);
 }
 assert.equal(verifyRunnerJobAdmission(policy,null).allowed,false);
});


test('explicit Organization registration binds the real org URL and finite repository policies',()=>{
  const org={...policy,registrationLevel:'organization'},second={...org,repository:'owner/second',repositoryId:'102'};
  const o=fixture();o.localRunner.repository='owner';o.localRunner.registrationLevel='organization';o.run.repository.owner.type='Organization';
  assert.equal(verifyRunnerJobAdmission(org,o).allowed,true);
  assert.equal(verifyRunnerJobAdmission(policy,o).allowed,false);
  assert.equal(runnerJobPolicies({schemaVersion:1,policies:[org,second]}).length,2);
  const next=structuredClone(o);next.context.repository='owner/second';next.run.repository.id='102';next.run.repository.full_name='owner/second';next.run.head_repository.id='102';
  assert.equal(verifyRunnerJobAdmission(second,next).allowed,true);
  assert.equal(verifyRunnerJobAdmission(org,next).allowed,false);
  for(const change of [v=>v.localRunner.repository='other',v=>delete v.localRunner.registrationLevel,
    v=>v.localRunner.registrationLevel='repository',v=>v.run.repository.owner.type='User',v=>delete v.run.repository.owner.type,
    v=>v.run.repository.owner.id='13',v=>v.run.repository.id='999',v=>v.run.head_repository.id='999']){
    const x=structuredClone(o);change(x);assert.equal(verifyRunnerJobAdmission(org,x).allowed,false);
  }
  for(const second of [{...org,registrationLevel:'repository'},{...org,repository:'other/project'},
    {...org,ownerId:'13'},{...org,runnerId:'24'}])
    assert.throws(()=>runnerJobPolicies({schemaVersion:1,policies:[org,second]}),/conflicting/);
  assert.throws(()=>runnerJobPolicies({schemaVersion:1,policies:[org,{...org,repositoryId:'999'}]}),/conflicting-target/);
  assert.throws(()=>runnerJobPolicy({...policy,registrationLevel:'enterprise'}),/invalid-policy/);
});

test('official repository and Org configuration URLs are parsed without accepting aliases or credentials',async()=>{
  const {localRunnerRegistration}=await import('../host/runner-job-hook.mjs');
  assert.deepEqual(localRunnerRegistration('https://github.com/Owner/Project/'),{repository:'owner/project',registrationLevel:'repository'});
  assert.deepEqual(localRunnerRegistration('https://github.com/Owner'),{repository:'owner',registrationLevel:'organization'});
  for(const url of ['http://github.com/owner','https://github.com.evil.example/owner','https://user:token@github.com/owner',
    'https://github.com/owner?token=SECRET','https://github.com/owner#fragment','https://github.com/owner/../owner',
    'https://github.com/owner/%2e%2e/owner','https://github.com/owner/repo/extra','https://github.com/'])
    assert.throws(()=>localRunnerRegistration(url),/local-registration/);
});
