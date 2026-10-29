import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerRunBudget} from '../src/owner-run-budget.mjs';

function fixture(){
 let now=Date.parse('2026-10-28T00:00:00Z');
 const run={id:123,run_attempt:1,path:'.github/workflows/action-stage.yml',repository:{full_name:'owner/control'},run_started_at:new Date(now).toISOString()};
 const calls=[],runtime={coreUpgrade:{executionLimits:{jobTimeoutMinutes:180,agentTimeoutMs:3600000}},actionIdentity:{runId:'123',runAttempt:1},actionExecutionPolicy:()=>({repository:'owner/control',workflowPath:run.path}),github:{api:async path=>{calls.push(path);return run;}}};
 return{runtime,run,calls,now:()=>now,advance:minutes=>now+=minutes*60000};
}
test('conservative provider budget reserves one complete Agent plus cleanup before the next launch',async()=>{
 const f=fixture(),b=await ownerRunBudget(f.runtime,{}, {now:f.now});
 assert.equal(b.shouldYield('deliver'),false);f.advance(115);assert.equal(b.shouldYield('accept'),true);assert.equal(b.shouldYield('repair'),false);
 f.advance(60);assert.equal(b.shouldYield('commit-pr'),true);assert.equal(f.calls.length,1);assert(!f.calls[0].includes('/jobs'));
});
test('budget is shared by lightweight phases and is never refreshed after a phase finishes',async()=>{
 const f=fixture(),b=await ownerRunBudget(f.runtime,{}, {now:f.now}),deadline=b.deadline;
 for(const minutes of [40,35,40])f.advance(minutes);
 assert.equal(b.shouldYield('deliver'),true);assert.equal(b.deadline,deadline);
});
test('unknown provider times, foreign attempts and impossible signed budgets fail closed',async()=>{
 for(const kind of ['missing-time','foreign-attempt','foreign-run','future','too-small']){
  const f=fixture();if(kind==='missing-time')delete f.run.run_started_at;if(kind==='foreign-attempt')f.run.run_attempt=2;if(kind==='foreign-run')f.run.id=456;
  if(kind==='future')f.run.run_started_at='2099-01-01T00:00:00Z';if(kind==='too-small')f.runtime.coreUpgrade.executionLimits.jobTimeoutMinutes=60;
  await assert.rejects(ownerRunBudget(f.runtime,{}, {now:f.now}));
 }
 const f=fixture();delete f.runtime.coreUpgrade;assert.equal(await ownerRunBudget(f.runtime,{}),null);assert.equal(f.calls.length,0);
});
