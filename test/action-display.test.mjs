import test from 'node:test';
import assert from 'node:assert/strict';
import {actionRunName,actionLogLine,rescueActionReport,publicActionReason} from '../src/action-display.mjs';
import {rescueFixture} from '../tooling/rescue-fixture.mjs';
import {workflowFixture} from '../tooling/workflow-fixture.mjs';
import {createWorkflowEntry} from '../src/workflow.mjs';
test('Action titles identify Issue and real stage without a repository prefix and retain exact dispatch correlation',()=>{
 assert.equal(actionRunName({issue:'198',stage:'accept',correlation:'request-1'}),'#198 | accept | op:request-1');
 assert.equal(actionRunName({issue:'55',stage:'deliver',correlation:'repair-1',rescue:true,mode:'verify'}),'Rescue | #55 | deliver | verify | op:repair-1');
 assert.throws(()=>actionRunName({issue:'0198',stage:'accept',correlation:'r'}));
 assert.throws(()=>actionRunName({issue:'198',stage:'shell',correlation:'r'}));
});
test('every eligible deterministic repair retains AI root cause; verified success is distinct from retry dispatch',async()=>{
 const f=rescueFixture(),id=await f.register();f.flags.remedy={kind:'github-read',proof:{healthy:true},apply:async()=>({healthy:true})};
 const result=await f.controller.run(id),held=f.snapshot().cases[id];
 const report=rescueActionReport(held,result);assert.equal(f.flags.diagnoses,1);assert.equal(report.root_cause,'Invocation failure');
 assert.equal(report.verified,'false');assert.equal(report.repair_status,'pending-verification');
 assert.ok(actionLogLine(report,'rescue').includes('"stage":"deliver"'));
});
test('invalid AI plans retain the actual root cause for red Action logs and cannot dispatch repair',async()=>{
 const f=rescueFixture(),id=await f.register();f.flags.diagnosisResult.body='invalid';f.flags.diagnosisResult.rootCause='A required tool is unavailable';
 const result=await f.controller.run(id),report=rescueActionReport(f.snapshot().cases[id],result);
 assert.equal(report.root_cause,'A required tool is unavailable');assert.equal(report.ai_status,'unresolved');
 assert.equal(report.verified,'false');assert.equal(result.conclusion,'failure');assert.equal(f.flags.repairs,0);
});
test('diagnostic projection removes credentials, control sequences, command annotations and arbitrary retained fields',()=>{
 const value='\u001b[31m\n::error:: token ghp_SUPERSECRET GH_TOKEN=OTHERSECRET Bearer abc123';
 const line=actionLogLine({root_cause:value,status:'blocked',rawProvider:'PRIVATE-DATA',environment:{TOKEN:'PRIVATE'}},'rescue');
 for(const secret of ['ghp_SUPERSECRET','OTHERSECRET','abc123','PRIVATE-DATA','::error::','\u001b'])assert.ok(!line.includes(secret));
 assert.equal(line.split('\n').length,2);assert.ok(publicActionReason(value).length<=1200);
});
test('the actual authenticated stage is logged before the model lifecycle starts; forged display stage never reaches execution',async()=>{
 const f=await workflowFixture(),selected=await f.resolve(),events=[];
 const entry=createWorkflowEntry(f.host,{onProgress:async value=>{assert.equal(f.sh.records.length,0);events.push(value);}});
 const result=await entry.invoke('compute',{...f.input,resolution:selected.resolution},f.context);
 assert.equal(result.status,'completed');assert.deepEqual(events,[{issue:'101',stage:'shape',status:'running'}]);
 const other=await workflowFixture(),route=await other.resolve();
 const wrong=await createWorkflowEntry(other.host).invoke('compute',{...other.input,nibfin_stage:'merge',resolution:route.resolution},other.context);
 assert.equal(wrong.status,'blocked');assert.equal(other.sh.records.length,0);
});
