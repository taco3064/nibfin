import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {writeFileSync,readFileSync} from 'node:fs';
import {codexFixture} from '../tooling/codex-fixture.mjs';
import {rescueFixture} from '../tooling/rescue-fixture.mjs';
import {createRescueAgentAdapter,diagnoseRescueTarget} from '../src/index.mjs';
for(const agent of ['codex','claude','gemini'])test('restricted '+agent+' diagnosis crosses the existing isolated backend and real process boundary',async t=>{
  const f=codexFixture('shape-diagnosis',undefined,agent);t.after(()=>f.dispose());
  const r=rescueFixture();r.target.adapter=agent;
  const original=join(f.environment.instances[1].workspace,'preserved.txt');writeFileSync(original,'unaccepted source');
  const result={...r.flags.diagnosisResult};
  f.flags.mutateCollected=value=>{value.result=result;};
  const adapter=createRescueAgentAdapter({agent,memberId:'7',retainVerification:async()=>({outcome:'retained'}),
    bind:async({target,execution})=>({target,memberId:'7',disposable:true,originalWorkspace:f.environment.instances[1].workspace,
      caseId:'case-fixture',config:f.config,binding:f.input.binding,prompt:'Diagnose the retained original execution; propose only the original-role retry.'})});
  const observed=await diagnoseRescueTarget({target:r.target,adapter,capture:async()=>readFileSync(original,'utf8'),retain:async()=>({outcome:'retained'})});
  assert.equal(observed.status,'completed');assert.equal(observed.plan.action,'retry-original-role');
  assert.equal(readFileSync(original,'utf8'),'unaccepted source');
  const role=f.calls.find(c=>c.args.includes('/entry.mjs')&&c.args.at(-1)==='execute');
  assert.ok(role);const mount=role.args.find(v=>v.includes('dst=/work,'));assert.match(mount,/,readonly$/);
  assert.equal(role.args.includes('--privileged'),false);assert.equal(role.env.GH_TOKEN,undefined);
});
test('diagnostic adapter rejects cross-member login binding before process allocation',async()=>{
  const r=rescueFixture();let called=false;
  const adapter=createRescueAgentAdapter({agent:'codex',memberId:'8',bind:async()=>{called=true;},retainVerification:async()=>({outcome:'retained'})});
  await assert.rejects(adapter.diagnose({role:'rescue-diagnosis',access:'read-only',target:r.target,timeoutMs:1000}));assert.equal(called,false);
});
