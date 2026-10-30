import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseDocument} from 'yaml';
import * as core from '../src/index.mjs';
import {configure} from '../host/entry.mjs';
import {rescueFixture} from '../tooling/rescue-fixture.mjs';
test('single dispatch-only Rescue template installs with immutable bundle/host pins and no idle allocation path',()=>{
  const plan=core.workflowInstallation({commit:'a'.repeat(40),hostRepository:'example-org/host',hostCommit:'b'.repeat(40)});
  const rescue=[...plan.files].filter(([path])=>/rescue/i.test(path));assert.equal(rescue.length,1);
  const doc=parseDocument(rescue[0][1],{uniqueKeys:true});assert.deepEqual(doc.errors,[]);const w=doc.toJS();
  assert.equal(w.name,'Nibfin Rescue');assert.deepEqual(Object.keys(w.on),['workflow_dispatch']);
  assert.deepEqual(Object.keys(w.on.workflow_dispatch.inputs),['request_id','source_run_id','source_attempt','nibfin_correlation','nibfin_issue','nibfin_stage','mode']);
  assert.equal(Object.values(w.jobs).length,1);assert.equal(w.jobs.rescue['runs-on'],'ubuntu-latest');
  assert.equal(w.jobs.rescue.steps.at(-1).with.mode,'rescue');
  for(const step of w.jobs.rescue.steps.filter(s=>s.with?.repository))assert.match(step.with.ref,/^[a-f0-9]{40}$/);
  assert.equal(w.jobs.rescue.concurrency['cancel-in-progress'],false);
});
test('authenticated production host/workflow path reaches maintained Rescue, retains case and never executes a stage',async()=>{
  const f=rescueFixture(),id=await f.register();
  const identity={repository:f.policy.repository,repositoryId:'42',run:{id:'500',attempt:'1'},visibility:'public',ownership:'organization'};
  const context={...identity,eventName:'workflow_dispatch'};
  const host=configure({core,mode:'rescue',context,deployment:{options:{version:1,repository:f.policy.repository,repositoryId:'42',environment:'nibfin-hosted'},
    capabilities:{authenticate:async()=>identity,rescue:async()=>({...f.options,
      reporting:{capability:{runId:'500',scope:'reporting-run',neutralCheck:true},report:async r=>({confirmed:r.runId==='500'})}})}}});
  const r=await core.createWorkflowEntry(host).invoke('rescue',{nibfin_correlation:'correlation-1',nibfin_issue:'101',request_id:id,source_run_id:'100',source_attempt:'1',mode:'repair'},context);
  assert.equal(r.status,'blocked');assert.equal(r.reason,'reporting-unsupported');
  assert.equal(r.outcome,'PENDING_VERIFICATION');assert.equal(r.conclusion,'neutral');assert.equal(f.flags.repairs,1);
  assert.equal((await f.controller.report()).verifiedAutomaticResolutions,0);
  const foreign=await core.createWorkflowEntry(host).invoke('rescue',{nibfin_correlation:'correlation-1',nibfin_issue:'101',request_id:id,source_run_id:'100',source_attempt:'2',mode:'repair'},context);
  assert.equal(foreign.status,'blocked');
});
test('unavailable neutral reporting fails visibly without turning dispatch acceptance green',async()=>{
  const f=rescueFixture(),id=await f.register(),identity={repository:f.policy.repository,repositoryId:'42',run:{id:'500',attempt:'1'},visibility:'public',ownership:'personal'};
  const host={authenticate:async()=>identity,rescue:async()=>f.options};
  const r=await core.createWorkflowEntry(host).invoke('rescue',{nibfin_correlation:'correlation-1',nibfin_issue:'101',request_id:id,source_run_id:'100',source_attempt:'1',mode:'repair'},{...identity,eventName:'workflow_dispatch'});
  assert.equal(r.status,'blocked');assert.equal(r.outcome,'PENDING_VERIFICATION');assert.equal(r.reason,'reporting-unsupported');
});
test('maintained dispatch builder supplies exact installed notification and normal Core continuation inputs',async()=>{
  const f=rescueFixture(),id=await f.register();await f.controller.wake(id);
  const notification=[...f.ops.values()][0].input;
  assert.deepEqual(notification.payload.inputs,{request_id:id,source_run_id:'100',source_attempt:'1',mode:'repair',
    nibfin_correlation:notification.correlation,nibfin_issue:'101',nibfin_stage:f.target.role});
  assert.deepEqual(notification.payload.display,{repository:f.target.repository,issue:'101',stage:f.target.role});
  await f.controller.run(id);const inputs=[...f.ops.values()].map(f=>f.input.payload.inputs);
  assert.ok(inputs.some(i=>i.nibfin_request==='fresh-core-request'));
  assert.ok(inputs.every(i=>i.nibfin_correlation));
});
