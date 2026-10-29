import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './action-runtime-fixture.mjs';
import { Store } from '../src/store.mjs';
test('changed pre-execution gate preserves original planner reason in durable state',async t=>{
 const f=await setup(t),original=f.runtime.observe.bind(f.runtime);
 f.runtime.observe=async(g,s)=>{const result=await original(g,s);if(s.pending)result.runtime.trusted=false;return result;};
 await assert.rejects(f.runtime.resume({maxSteps:1}),e=>e.code==='EXECUTION_GATE_CHANGED'&&e.detail.actual.code==='UNTRUSTED_RUNTIME');
 const state=await new Store(f.config.stateDirectory,f.payload.manifest.id).read();
 assert.equal(state.lastError.actual.code,'UNTRUSTED_RUNTIME');assert.equal(state.lastError.expected.operation,'shape');
 assert.equal(state.pending.writeAttempted,undefined);assert.equal(state.events.at(-1).kind,'execution-gate-changed');
});
