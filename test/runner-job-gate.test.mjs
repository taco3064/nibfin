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
