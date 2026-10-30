import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import{createControlledOperations,contentIdentity,canonicalJSON}from'../src/index.mjs';
import{operationsFixture,operationInput}from'../tooling/operations-fixture.mjs';

test('native operations use actual durable private records without fabricating GitHub artifacts; replay rechecks the real operation and retained original attempt',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'nibfin-native-operations-')),f=operationsFixture(operationInput('comment'));
 const refs={},registered=contentIdentity(f.input);let corrupt=false;
 const records={
  retain:async({expected,value})=>{const body={version:1,kind:'native-operation-record',expected,value},identity=contentIdentity(body);
   const file=join(root,identity+'.json');try{await fs.writeFile(file,canonicalJSON(body),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
   const ref={kind:'native-operation-record',identity};refs[value.phase]={ref,source:{runId:expected.runId,attempt:expected.attempt}};return{outcome:'retained',ref};},
  retrieve:async({ref,expected})=>{const value=JSON.parse(await fs.readFile(join(root,ref.identity+'.json')));
   if(corrupt)value.value.intent.correlation='foreign';return{outcome:'retrieved',expected:value.expected,value:value.value};}
 };
 const options={authorization:f.authorization,provider:f.provider,operationRecords:records,execution:{runId:'100',attempt:'1'},
  locate:async({identity})=>{assert.equal(identity,registered);return Object.keys(refs).length?{outcome:'found',refs:structuredClone(refs)}:{outcome:'new',identity:registered};}};
 try{
  assert.equal((await createControlledOperations(options).execute(f.input)).outcome,'confirmed-success');assert.equal(f.writes().length,1);
  const repeated=await createControlledOperations(options).execute(f.input);assert.equal(repeated.outcome,'confirmed-success');assert.equal(f.writes().length,1);
  assert.equal(repeated.refs.intent.ref.kind,'native-operation-record');assert.equal(Object.hasOwn(repeated.refs.intent.ref,'artifactId'),false);
  corrupt=true;assert.equal((await createControlledOperations(options).execute(f.input)).outcome,'unknown');assert.equal(f.writes().length,1);
  assert.throws(()=>createControlledOperations({...options,operationRecords:{...records,command:'arbitrary'}}),/capability/);
 }finally{await fs.rm(root,{recursive:true});}
});

test('an unconfirmed native intent or wrong expected binding prevents the write and cannot be treated as a fresh artifact upload',async()=>{
 const f=operationsFixture(operationInput('comment'));
 for(const mismatch of ['reference','expected']){
  let retained;
  const operationRecords={retain:async value=>{retained=value;return{outcome:'retained',ref:{kind:'native-operation-record',identity:'a'.repeat(64)}};},
   retrieve:async()=>({outcome:'retrieved',expected:mismatch==='expected'?{}:retained.expected,value:retained.value})};
  const result=await createControlledOperations({authorization:f.authorization,provider:f.provider,operationRecords,execution:{runId:'100',attempt:'1'},
   locate:async({identity})=>({outcome:'new',identity})}).execute(f.input);
  assert.equal(result.outcome,'unknown');assert.equal(f.writes().length,0);
 }
});
