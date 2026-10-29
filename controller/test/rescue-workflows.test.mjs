import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import vm from 'node:vm';
import {detectRescueSource} from '../src/rescue-detection.mjs';
import {rescueConclusion} from '../src/rescue-result.mjs';

const workflow=await readFile(new URL('../.github/workflows/kairo-rescue.yml',import.meta.url),'utf8');
const script=workflow.split("node <<'NODE'")[1].split('\n          NODE')[0];
function fixture({conclusion='failure',marker=null}={}){
 const source={id:123,run_attempt:1,repository:{id:9,full_name:'taco3064/kairo'},path:'.github/workflows/action-stage.yml',event:'workflow_dispatch',status:'completed',head_branch:'main',head_sha:'a'.repeat(40),actor:{id:7},triggering_actor:{id:7},conclusion};
 const event={repository:{private:true},workflow_run:structuredClone(source)},calls=[];
 const policy={repository:'taco3064/kairo',repositoryId:'9',workflowPath:source.path,workflowBlob:'b'.repeat(40),actorIds:['7']};
 const runtime={actionExecutionPolicy:()=>policy,github:{api:async path=>{calls.push(path);return path.includes('/contents/')?{sha:policy.workflowBlob}:source;},list:async()=>[{id:77,name:'execute',status:'completed'}],download:async path=>{calls.push(path);return Buffer.from(marker?'2026-10-28T00:00:00Z '+JSON.stringify(marker):'Ordinary successful work');}}};
 return{runtime,event,source,calls};
}
test('one workflow directly detects failures without dispatching a second Rescue',async()=>{
 for(const conclusion of ['failure','timed_out','cancelled','startup_failure']){
  const f=fixture({conclusion}),event=await detectRescueSource(f.runtime,{},f.event);
  assert.deepEqual(event,{inputs:{source_run_id:'123',mode:'repair'}});
  assert(!f.calls.some(p=>p.includes('/dispatches')));
 }
});
test('successful sources require an exact live-run recovery marker; normal work is a no-op',async()=>{
 for(const marker of [null,{kind:'kairo-rescue-request',runId:999}]){
  const f=fixture({conclusion:'success',marker});assert.equal(await detectRescueSource(f.runtime,{},f.event),null);
 }
 for(const kind of ['kairo-rescue-request','kairo-rescue-resume-observed']){
  const f=fixture({conclusion:'success',marker:{kind,runId:123}});
  assert.equal((await detectRescueSource(f.runtime,{},f.event)).inputs.source_run_id,'123');
 }
 const f=fixture({conclusion:'success'});f.runtime.github.download=async()=>Buffer.from('echo '+JSON.stringify({kind:'kairo-rescue-request',runId:123}));
 assert.equal(await detectRescueSource(f.runtime,{},f.event),null);
});
test('changed attempt, SHA, actor, workflow, public origin or incomplete source cannot enter repair',async()=>{
 for(const change of [{run_attempt:2},{head_sha:'c'.repeat(40)},{actor:{id:88}},{path:'.github/workflows/foreign.yml'},{status:'in_progress'}]){
  const f=fixture();Object.assign(f.source,change);await assert.rejects(detectRescueSource(f.runtime,{},f.event));
 }
 const f=fixture();f.event.repository.private=false;await assert.rejects(detectRescueSource(f.runtime,{},f.event));
});
test('only verified resolution is green; failure is red; intermediate/no-op states are neutral',()=>{
 assert.equal(rescueConclusion('RESOLVED'),'success');
 for(const state of ['UNRESOLVED',undefined,'PENDING','unexpected'])assert.equal(rescueConclusion(state),'failure');
 for(const state of ['DEFERRED','PENDING_VERIFICATION','STAGE_RECOVERED','SUPERSEDED','NOT_NEEDED','RECHECKED'])assert.equal(rescueConclusion(state),'cancelled');
});
async function finalizer(conclusion,step='success',status=202){
 const calls=[],process={env:{RESCUE_CONCLUSION:conclusion,RESCUE_STEP_OUTCOME:step,GITHUB_REPOSITORY:'taco3064/kairo',GITHUB_RUN_ID:'456',GH_TOKEN:'hidden'},exitCode:0};
 await vm.runInNewContext(script,{process,console:{error:()=>{}},fetch:async(url,options)=>{calls.push({url,options});return{status};},AbortSignal,setTimeout:callback=>callback()});
 return{calls,process};
}
test('final gate never paints a failed step green and cancels only its own reporting Run',async()=>{
 let r=await finalizer('success');assert.equal(r.process.exitCode,0);assert.equal(r.calls.length,0);
 for(const [conclusion,step]of [['failure','success'],['success','failure'],['cancelled','failure'],['','success']]){
  r=await finalizer(conclusion,step);assert.equal(r.process.exitCode,1);assert.equal(r.calls.length,0);
 }
 r=await finalizer('cancelled');assert.equal(r.calls.length,1);assert(r.calls[0].url.endsWith('/actions/runs/456/cancel'));assert.equal(r.calls[0].options.method,'POST');
 // Accepted cancellation must actually take effect; otherwise fail closed.
 assert.equal(r.process.exitCode,1);
 r=await finalizer('cancelled','success',403);assert.equal(r.process.exitCode,1);assert.equal(r.calls.length,1);
});
test('single English workflow preserves pinned Core, typed inputs and nonrecursive completion',async()=>{
 await assert.rejects(access(new URL('../.github/workflows/kairo-rescue-trigger.yml',import.meta.url)),{code:'ENOENT'});
 assert(workflow.startsWith('name: Kairo Rescue\n'));assert(!/[\u3400-\u9fff]/.test(workflow));
 assert.doesNotMatch(workflow,/^\s+workflow_run:/m);assert(workflow.includes('workflow_dispatch:'));
 assert(!workflow.includes('actions/checkout'));assert(workflow.includes('rescue-run /etc/kairo/actions-runtime.json'));
 assert(workflow.includes('runs-on: [self-hosted, linux, kairo-actions]'));
 assert(workflow.includes('cancel-in-progress: false'));assert.doesNotMatch(workflow,/^\s*(?:-\s*)?(schedule|cron):/m);
 for(const line of workflow.split('\n'))if(/^\s+(?:run:|node |const |await )/.test(line))assert(!line.includes('${{ inputs.'));
});
