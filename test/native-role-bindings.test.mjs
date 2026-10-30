import test from'node:test';import assert from'node:assert/strict';
import{createNativeRoleBindings,nativeRoleSuccessSummary,selectInstructions,bodyDigest,contentIdentity,requirementsDocumentFrame}from'../src/index.mjs';
const binding=instructions=>({authority:'a'.repeat(64),grant:'b'.repeat(64),policy:'c'.repeat(64),core:'d'.repeat(64),runtime:'e'.repeat(64),
 instructions:instructions.identity,repositoryId:'42',issueId:'I_current',scopeHash:bodyDigest('Scope'),shapeHash:bodyDigest('Shape')});
const request=(role,task)=>({role,skill:role==='deliver'?'deliver':role==='accept'?'accept':'shape',instructions:selectInstructions({role,skill:role==='deliver'?'deliver':role==='accept'?'accept':'shape'}),task});
test('native bindings retain independent role identity and fixed success contract before launch',async()=>{
 const retained=[],host=createNativeRoleBindings({ownership:'personal',retain:async v=>{retained.push(v);return'custody:request';},now:()=>1000});
 const instructions=selectInstructions({role:'shape',skill:'shape'}),authority=binding(instructions);
 const task={original:{kind:'raw-scope',body:'Scope'},authority,requirementsDocument:{format:'scope-shape-v1',scope:'Scope',frame:requirementsDocumentFrame('Scope')}};
 const a=await host.bind(request('shape',task)),b=await host.bind(request('shape',task));
 for(const k of ['id','request','result'])assert.notEqual(a.input.execution[k],b.input.execution[k]);
 assert.equal(a.outputFormat,'shape-author-v1');assert.deepEqual(a.inputs,{});assert.equal(a.current().expected.result.summary,nativeRoleSuccessSummary);
 assert.equal(Object.hasOwn(a.startCurrent().expected,'inputs'),false);assert.equal(a.deadlineAt,721000);assert.equal(a.reserveMs,60000);
 assert.equal(retained.length,2);assert.equal(retained[0].taskIdentity,contentIdentity(task));
 assert.equal(host.get(a.input.execution.id).reference,'custody:request');
 const forged=a.current();forged.expected.result.summary='model-selected approval';assert.notEqual(a.current().expected.result.summary,forged.expected.result.summary);
 const validator=await host.bind(request('shape-validator',{original:task.original,authority,proposedBody:'Actual Shape',author:a.input.execution.id}));
 assert.equal(validator.inputs.author,a.input.execution.id);assert.equal(validator.input.binding.shapeHash,bodyDigest('Actual Shape'));
});
test('review prompts bind complete task identity while omitting the duplicate binary transfer',async()=>{
 const host=createNativeRoleBindings({ownership:'personal',retain:async()=> 'custody:request'}),r=request('accept',{}),b=binding(r.instructions);
 const candidate={marker:'independently-retained-candidate'},wire={secretLargeBinary:'BINARY_WIRE_MUST_NOT_ENTER_PROMPT'};
 r.task={repository:'example/core',scopeBody:'Scope',shapeBody:'Shape',binding:b,workspace:wire,
  expected:{identity:'f'.repeat(64),candidate},deliver:{execution:{id:'writer'}},hooks:{stage:{kind:'verified-hooks'}}};
 const value=await host.bind(r);assert.equal(value.inputs.deliver,'writer');assert.deepEqual(value.inputs.candidate,candidate);
 assert(!value.prompt.includes(wire.secretLargeBinary));assert(value.prompt.includes(contentIdentity(r.task)));
 assert(value.prompt.includes('/work'));assert(value.prompt.includes('Scope'));assert(value.prompt.includes('Shape'));
 const bad=structuredClone(r);bad.task.scopeBody='Changed Scope';await assert.rejects(host.bind(bad),/document-binding/);
});
test('missing retention and ambiguous Shape author format cannot create an executable request',async()=>{
 assert.throws(()=>createNativeRoleBindings({ownership:'personal'}),/configuration/);
 const host=createNativeRoleBindings({ownership:'personal',retain:async()=>null}),r=request('deliver',{});
 r.task={scopeBody:'Scope',shapeBody:'Shape',binding:binding(r.instructions),publication:{verified:'publication'}};
 await assert.rejects(host.bind(r),/retention/);
 const shape=request('shape',{original:{kind:'raw-scope',body:'Scope'},authority:binding(r.instructions)});
 await assert.rejects(host.bind(shape),/scope/);
});


test('native role attribution is pinned by the protected host before launch and cannot be chosen by task data',async()=>{
 const source={repositoryId:'42',workflow:'a'.repeat(64),runId:'100',attempt:'1'};
 const host=createNativeRoleBindings({ownership:'personal',source,retain:async()=> 'custody:native-role'});
 source.runId='999';const instructions=selectInstructions({role:'shape-validator',skill:'shape'});
 const task=request('shape-validator',{authority:binding(instructions),proposedBody:'Actual Shape',author:'prior-author',source:{runId:'999'}});
 const value=await host.bind(task);assert.equal(value.input.execution.source.runId,'100');
 assert.equal(value.current().expected.execution.source.repositoryId,'42');
 assert.throws(()=>createNativeRoleBindings({ownership:'personal',retain:async()=> 'custody',source:{...source,token:'no'}}),/source/);
});
