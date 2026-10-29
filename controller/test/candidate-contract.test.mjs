import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateContract } from '../src/candidate-contract.mjs';
import { validateSchema } from '../src/schema.mjs';
import { resultSchema } from '../src/agent.mjs';
import { runHooks } from '../src/hooks.mjs';
import { fixture, shape, deliver, NOW } from './fixtures.mjs';
import { plan, digest } from '../src/core.mjs';

const block = value => '```kairo-candidate\n' + JSON.stringify(value) + '\n```\n';
test('Controller validates the entire nested stage result schema without relying on the Agent', () => {
  const good = {outcome:'changes_required',body:'',summary:'conflict',rootCause:'scope',failureClass:'shape_defect',evidenceReferences:['observed'],blockingFindings:['conflict'],contractConflicts:[{scopeHash:'s',shapeHash:'h',scopeQuote:'a',shapeQuote:'b',explanation:'conflict',evidenceReference:'observed'}]};
  assert.equal(validateSchema(good,resultSchema),good);
  for (const value of [null,{},'claim',42,[null],[{}],[{...good.contractConflicts[0],authorized:true}],[{...good.contractConflicts[0],scopeQuote:[]}]] ) assert.throws(()=>validateSchema({...good,contractConflicts:value},resultSchema),/schema mismatch/);
  for (const key of resultSchema.required) {const bad=structuredClone(good);delete bad[key];assert.throws(()=>validateSchema(bad,resultSchema),/schema mismatch/);}
  assert.throws(()=>validateSchema({...good,authorized:true},resultSchema),/unknown property/);
  assert.throws(()=>validateSchema({...good,failureClass:'invented'},resultSchema),/invalid enum/);
  assert.throws(()=>validateSchema(good,{...resultSchema,pattern:'unsupported'}),/Unsupported schema/);
});
test('Shape obligations require explicit applicable inventories, safe paths and exact fields', () => {
  const valid={artifacts:[{path:'out/report.json',purpose:'AC1'}],hooks:[{path:'.githooks/pre-commit',event:'pre-commit'}]};
  assert.deepEqual(candidateContract(block(valid)),valid);
  for(const body of ['',block(valid)+block(valid),block({...valid,skipAccept:true}),block({...valid,hooks:[{path:'x',event:'post-commit'}]})])assert.throws(()=>candidateContract(body));
  for(const path of ['../token','/etc/passwd','C:/token','x/../y','x\\y','x/.git/config','x//y','x;id','x\ny'])assert.throws(()=>candidateContract(block({...valid,artifacts:[{path,purpose:'proof'}]})));
});
test('Core rejects omitted artifact identity and missing trusted hook evidence',()=>{
  const f=fixture();for(const i of f.manifest.issues)shape(f,i.id);deliver(f,'I_A');
  const live=f.snapshot.issues.I_A;
  delete live.candidate.artifacts;
  assert.equal(plan(f.manifest,f.policy,f.snapshot,NOW).code,'MISSING_ARTIFACT_IDENTITY');
  live.candidate.artifacts=[];delete live.hookEvidence;
  assert.equal(plan(f.manifest,f.policy,f.snapshot,NOW).code,'MISSING_HOOK_EVIDENCE');
});
test('A trusted post-Accept hook mutation automatically returns to same-Issue repair',()=>{
  const f=fixture();for(const i of f.manifest.issues)shape(f,i.id);deliver(f,'I_A');
  f.policy.deliveryRepairMode='until-conformant';f.snapshot.policyHash=digest(f.policy);f.snapshot.approval.policyHash=digest(f.policy);
  // Recreate envelopes with the updated authority before asserting the transition.
  for(const i of f.manifest.issues)shape(f,i.id);deliver(f,'I_A');
  Object.assign(f.snapshot.issues.I_A,{repairs:8,candidateFailure:{reason:'hook changed artifact'}});
  const next=plan(f.manifest,f.policy,f.snapshot,NOW);assert.equal(next.operation,'repair');assert.equal(next.issueId,'I_A');assert.equal(next.artifacts.cause,'candidate-obligation');
});
test('Hook sandbox mounts no credentials or controller metadata and confirms timeout cleanup',async()=>{
  const config={image:'sha256:'+'a'.repeat(64),user:'1000:1000',authDirectory:'/secret/auth'};
  const hooks=[{path:'.githooks/pre-commit',event:'pre-commit'}], gitState={directory:'/hook-git',base:'a'.repeat(40),tree:'b'.repeat(40),paths:['src/feature.mjs'],commitMessage:'Deliver #1\n\nCandidate: exact identity\n'};let calls=[];
  const result=await runHooks(config,'/candidate',hooks,async(exe,args)=>{calls.push(args);return {stdout:'ok',stderr:''};},gitState);
  assert.equal(result.status,'passed');const args=calls[0];assert.equal(args[args.indexOf('--network')+1],'none');assert.equal(args.filter(x=>x==='--mount').length,2);assert.ok(!args.join(' ').includes('/secret'));assert.ok(args.includes('--read-only'));
  const reviewerEvidence=JSON.parse(JSON.stringify(result));
  assert.equal(reviewerEvidence.commitMessage,gitState.commitMessage);
  assert.equal(reviewerEvidence.messageHash,digest(reviewerEvidence.commitMessage));
  assert.ok(args.includes('KAIRO_COMMIT_MESSAGE='+reviewerEvidence.commitMessage));
  assert.deepEqual(reviewerEvidence.stagedPaths,gitState.paths);
  assert.equal(reviewerEvidence.stagedPathsVerified,true);
  assert.equal(reviewerEvidence.execution.exitCode,0);
  assert.deepEqual(reviewerEvidence.execution.arguments,args);
  assert.deepEqual(reviewerEvidence.execution.invocations,[{event:'pre-commit',command:'sh',arguments:['/work/.githooks/pre-commit']}]);
  assert.equal(reviewerEvidence.execution.isolation.network,'none');
  assert.equal(reviewerEvidence.execution.isolation.credentialsMounted,false);
  assert.ok(Date.parse(reviewerEvidence.execution.completedAt)>=Date.parse(reviewerEvidence.execution.startedAt));
  assert.ok(args.at(-1).includes('cmp /tmp/expected-staged-paths /tmp/staged-paths'));
  calls=[];
  const failed=await runHooks(config,'/candidate',hooks,async(exe,args)=>{calls.push(args);if(args[0]==='run')throw new Error('timeout');return {stdout:args[0]==='ps'?'container-id':'',stderr:''};},gitState);
  assert.equal(failed.status,'failed');assert.deepEqual(calls.map(a=>a[0]),['run','ps','rm']);
  await assert.rejects(runHooks(config,'/candidate',hooks,async()=>{throw new Error('docker unavailable');},gitState),{recoveryRequired:true});
});
