import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeConcurrency, nativeExecutionPlan, parallelIssueWorkspace} from '../src/index.mjs';
import {concurrencyConsumer} from '../tooling/operations-fixture.mjs';
const identity = {repository:'Example-Org/Core',repositoryId:'42'};
test('all resource paths converge independent of workflow/event/stage, distinct repositories and Issues differ', () => {
  const groups = ['dispatch','pr','merge','close','label'].map(path => nativeConcurrency({...identity,scope:'repository-write',path}));
  assert.ok(groups.every(c=>c.group===groups[0].group));
  assert.deepEqual(groups[0],nativeConcurrency({...identity,repository:'example-org/core',scope:'repository-write'}));
  assert.deepEqual(groups[0],nativeConcurrency({...identity,repository:'renamed/project',scope:'repository-write'}));
  assert.notEqual(groups[0].group,nativeConcurrency({...identity,repositoryId:'43',scope:'repository-write'}).group);
  const issue = n=>nativeConcurrency({...identity,issue:n,scope:'issue'}).group;
  assert.notEqual(issue('101'),issue('102')); assert.notEqual(issue('101'),groups[0].group);
});
test('official queue and cancellation validation and positive bounded parallelism', () => {
  for(const queue of ['max','single']) assert.equal(nativeConcurrency({...identity,scope:'repository-write',queue}).queue,queue);
  for(const extra of [{cancelInProgress:true},{queue:'unbounded'},{cancelInProgress:'false'},{repositoryId:'01'},
    {repository:'${{ github.repository }}'},{scope:'global'},{issue:'101'}])
    assert.throws(()=>nativeConcurrency({...identity,scope:'repository-write',...extra}));
  for(const maxParallel of [0,-1,1.5,257,'2',NaN])
    assert.throws(()=>nativeExecutionPlan({...identity,issue:'101',cycle:'c1',maxParallel}));
  assert.throws(()=>nativeExecutionPlan({...identity,issue:'101',cycle:'c1',maxParallel:2,parallelScope:'global'}));
  assert.throws(()=>parallelIssueWorkspace({repositoryId:'42',issue:'101',cycle:'../escape'}));
});
test('consumer consumes actual workflow/job outputs without recursive group acquisition', () => {
  const input={...identity,issue:'101',cycle:'cycle-1',maxParallel:2};
  const workflow=concurrencyConsumer(input), plan=nativeExecutionPlan(input);
  assert.deepEqual(workflow.concurrency,plan.concurrency);
  assert.deepEqual(workflow.jobs.write.concurrency,plan.jobs.write.concurrency);
  assert.equal(workflow.jobs.compute.strategy['max-parallel'],2);
  assert.equal(workflow.jobs.compute.concurrency,undefined);
  assert.notEqual(workflow.concurrency.group,workflow.jobs.write.concurrency.group);
  assert.deepEqual(workflow.jobs.write.needs,['compute']);
  const other=nativeExecutionPlan({...input,issue:'102'});
  assert.notEqual(plan.workspace.branch,other.workspace.branch); assert.notEqual(plan.workspace.directory,other.workspace.directory);
  assert.equal(plan.jobs.write.concurrency.group,other.jobs.write.concurrency.group);
});
