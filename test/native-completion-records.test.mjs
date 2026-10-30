import test from 'node:test';import assert from 'node:assert/strict';import{completionFixture}from'../tooling/completion-fixture.mjs';
import{createCompletionFlow,contentIdentity,verifyCompletion}from'../src/index.mjs';

test('native completion retains actual causal closure and the complete Core receipt chain with explicit private reference identities',async()=>{
 const f=await completionFixture(),records=new Map(),index=new Map();let corrupt=false;
 const completionRecords={
  retain:async({expected,value})=>{const body={version:1,kind:'native-completion-record',expected:structuredClone(expected),value:structuredClone(value)},identity=contentIdentity(body);
   records.set(identity,body);index.set(value.phase,{outcome:'found',ref:{kind:body.kind,identity},source:{runId:expected.runId,attempt:expected.attempt}});return {outcome:'retained'};},
  retrieve:async({ref})=>{const body=structuredClone(records.get(ref.identity));if(corrupt)body.value.value={replaced:true};return{outcome:'retrieved',expected:body.expected,value:body.value};}
 };
 const fresh=()=>createCompletionFlow({...f.capabilities,custody:undefined,publication:undefined,completionRecords,
  locate:async({identity,phase})=>index.get(phase)??{outcome:'new',identity}});
 assert.equal((await fresh().close()).outcome,'closed');const complete=await fresh().complete();assert.equal(complete.outcome,'completed',JSON.stringify(complete));
 assert.equal((await fresh().complete()).receipt.identity,complete.receipt.identity);
 assert.equal(f.close.writes().length,1);assert.equal(f.label.writes().length,1);assert.equal(f.state.records.size,0,'no artifact ID is fabricated');
 for(const entry of index.values())assert.equal(entry.ref.kind,'native-completion-record');
 corrupt=true;assert.equal((await fresh().complete()).outcome,'blocked');assert.equal(f.close.writes().length,1);assert.equal(f.label.writes().length,1);
 assert.throws(()=>createCompletionFlow({...f.capabilities,completionRecords:{...completionRecords,module:'untrusted'}}),/capabilities/);
});
