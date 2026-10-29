import test from 'node:test';
import assert from 'node:assert/strict';
import {digest,plan,continuedDeliveryBase} from '../src/core.mjs';
import {Runtime} from '../src/runtime.mjs';
import {fixture,shape,deliver,NOW,SHA} from './fixtures.mjs';

function continued(){
 const f=fixture();for(const i of f.manifest.issues)shape(f,i.id);const i=f.manifest.issues[0],live=f.snapshot.issues[i.id];live.defaultHead=SHA('e');
 f.snapshot.runtime.coreUpgrade={verified:true,rescueContinuations:['verification-budget']};
 live.rescueContinuation={kind:'verification-budget',stage:'deliver',unit:f.manifest.id,scopeHash:i.scopeHash,candidateHash:digest(null),shapeHash:digest(live.shape.body),base:SHA('a'),proofHash:'b'.repeat(64)};
 return{...f,issue:i,live};
}
test('fresh Core continues the proven original delivery base while still observing the new default head',()=>{
 const f=continued(),d=plan(f.manifest,f.policy,f.snapshot,NOW);assert.equal(d.operation,'deliver');assert.equal(d.artifacts.base,SHA('a'));assert.equal(f.live.defaultHead,SHA('e'));
 f.live.defaultHead=SHA('a');deliver(f,f.issue.id);f.live.defaultHead=SHA('e');const next=plan(f.manifest,f.policy,f.snapshot,NOW);assert.equal(next.operation,'repair');assert.equal(next.artifacts.cause,'base');
});
test('old cycle, changed Shape, unsigned capability or existing Candidate cannot nominate a continued base',()=>{
 for(const change of ['cycle','scope','shape','unsigned','candidate']){const f=continued();if(change==='cycle')f.live.rescueContinuation.unit='other';if(change==='scope')f.live.rescueContinuation.scopeHash='old';if(change==='shape')f.live.shape.body+='changed';if(change==='unsigned')f.snapshot.runtime.coreUpgrade.verified=false;if(change==='candidate')f.live.candidate={base:SHA('e')};assert.equal(continuedDeliveryBase(f.manifest,f.snapshot,f.issue,f.live),null);}
});
test('normal Runtime passes the continuation to the same role and consumes it without accepting a failed result',async()=>{
 const f=continued(),state={events:[],issues:{[f.issue.id]:{shape:f.live.shape,rescueContinuation:f.live.rescueContinuation}}},seen={};
 const runtime={executionContext:{kind:'local-operator'},workspace:()=>({work:'/work',prepare:async base=>seen.base=base,provenance:async base=>({base})}),
  agent:{execute:async(role,context)=>{seen.role=role;seen.context=context;return{executionId:'fresh-execution',evidencePath:'evidence',result:{outcome:'blocked',failureClass:'external_failure',rootCause:'Still incomplete',summary:'No passing result',blockingFindings:[],contractConflicts:[]}};}},save:async(_store,s)=>s};
 const result=await Runtime.prototype.execute.call(runtime,{manifest:f.manifest,policy:f.policy,proposal:'proposal'},state,f.snapshot,{operation:'deliver',issueId:f.issue.id},null);
 assert.equal(seen.base,SHA('a'));assert.equal(seen.role,'deliver');assert(seen.context.rescueContinuation.instruction.includes('not passing tests'));
 assert.equal(result.issues[f.issue.id].rescueContinuation,undefined);assert.equal(result.issues[f.issue.id].blocked.summary,'No passing result');assert.equal(result.issues[f.issue.id].candidate,undefined);
});
