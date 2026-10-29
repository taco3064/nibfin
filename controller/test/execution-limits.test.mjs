import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {digest} from '../src/core.mjs';
import {signGrant,verifyCoreUpgrade} from '../src/authority.mjs';
import {Runtime} from '../src/runtime.mjs';
import {CodexAgent} from '../src/agent.mjs';
const keys=generateKeyPairSync('ed25519'),publicKey=keys.publicKey.export({type:'spki',format:'pem'}),privateKey=keys.privateKey.export({type:'pkcs8',format:'pem'});
const grant={recordId:'original',manifest:{id:'cohort'},policy:{controlMode:'owner-project',executionMode:'actions-v1',runtimeHash:'r',coreDigest:'a'.repeat(64),actionExecution:{workflowBlob:'b'.repeat(40),repository:'owner/core'}}};
const payload=()=>({schemaVersion:1,kind:'owner-core-upgrade',grantRecordId:grant.recordId,manifestHash:digest(grant.manifest),policyHash:digest(grant.policy),runtimeHash:grant.policy.runtimeHash,fromCoreDigest:grant.policy.coreDigest,toCoreDigest:'c'.repeat(64),sourceCommit:'d'.repeat(40),reason:'Owner requested longer bounded work',executionLimits:{previousWorkflowBlob:'b'.repeat(40),workflowBlob:'e'.repeat(40),jobTimeoutMinutes:180,agentTimeoutMs:3600000}});
const verify=p=>verifyCoreUpgrade(signGrant(p,privateKey),grant,'c'.repeat(64),publicKey);
test('exact signed timeout amendment preserves parent authority and changes only effective workflow identity',()=>{
 const before=JSON.stringify(grant),upgrade=verify(payload()),policy=Runtime.prototype.actionExecutionPolicy.call({coreUpgrade:upgrade},grant);
 assert.equal(policy.workflowBlob,'e'.repeat(40));assert.equal(policy.previousWorkflowBlob,'b'.repeat(40));assert.equal(policy.repository,'owner/core');assert.equal(JSON.stringify(grant),before);
 assert.deepEqual(Runtime.prototype.actionExecutionPolicy.call({},grant),grant.policy.actionExecution);
 const forged=signGrant(payload(),privateKey);forged.payload.executionLimits.agentTimeoutMs++;
 assert.throws(()=>verifyCoreUpgrade(forged,grant,'c'.repeat(64),publicKey),/not explicitly approved/);
});
test('display workflow approval retains original and timeout-era receipt pins without changing limits',()=>{
 const p=payload(),before=JSON.stringify(p.executionLimits);p.actionWorkflowBlob='f'.repeat(40);
 const upgrade=verify(p),policy=Runtime.prototype.actionExecutionPolicy.call({coreUpgrade:upgrade},grant);
 assert.equal(policy.workflowBlob,p.actionWorkflowBlob);
 assert.equal(policy.previousWorkflowBlob,p.executionLimits.workflowBlob);
 assert.equal(policy.originalWorkflowBlob,grant.policy.actionExecution.workflowBlob);
 assert.equal(JSON.stringify(upgrade.executionLimits),before);
 assert.equal(grant.policy.actionExecution.workflowBlob,'b'.repeat(40));
 const forged=signGrant(p,privateKey);forged.payload.actionWorkflowBlob='a'.repeat(40);
 assert.throws(()=>verifyCoreUpgrade(forged,grant,'c'.repeat(64),publicKey),/not explicitly approved/);
});
for(const[name,change]of Object.entries({oldPin:p=>p.executionLimits.previousWorkflowBlob='f'.repeat(40),newPin:p=>p.executionLimits.workflowBlob='main',unboundedJob:p=>p.executionLimits.jobTimeoutMinutes=Infinity,oversizedJob:p=>p.executionLimits.jobTimeoutMinutes=361,shortAgent:p=>p.executionLimits.agentTimeoutMs=0,longAgent:p=>p.executionLimits.agentTimeoutMs=180*60000,extra:p=>p.executionLimits.runnerIds=[999],null:p=>p.executionLimits=null,parent:p=>p.policyHash='changed'}))test('signed timeout amendment rejects '+name,()=>{const p=payload();change(p);assert.throws(()=>verify(p));});
test('Agent subprocess receives approved longer timeout while original runtime configuration remains unchanged',async t=>{
 const root=await mkdtemp(join(tmpdir(),'kairo-timeout-'));t.after(()=>rm(root,{recursive:true}));
 await mkdir(join(root,'skills','accept'),{recursive:true});await writeFile(join(root,'skills','accept','SKILL.md'),'---\nname: accept\n---\nInspect evidence.\n');
 const c={timeoutMs:1200000},seen=[];
 const agent=new CodexAgent(c,root,root,async(exe,args,options)=>{
  seen.push(options.timeout);const dirs=await readdir(join(root,'executions'));
  assert.match(options.input,/node \/verification-runner.mjs --/);assert.match(options.input,/Writer observations never substitute/);
  // The effective signed limit must be the budget supplied in this exact prompt.
  const supplied=JSON.parse(options.input.split('CONTEXT:\n').at(-1));
  assert.equal(supplied.verificationPolicy.budget.timeoutMs,options.timeout);assert.equal(supplied.verificationPolicy.maxConcurrent,1);
  for(const id of dirs)await writeFile(join(root,'executions',id,'result.json'),JSON.stringify({outcome:'accepted',body:'',summary:'Fixture review',rootCause:'none',failureClass:'none',evidenceReferences:['fixture'],blockingFindings:[],contractConflicts:[]}));
  return{stdout:[{type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify({outcome:'accepted',body:'',summary:'Fixture review',rootCause:'none',failureClass:'none',evidenceReferences:['fixture'],blockingFindings:[],contractConflicts:[]})}},{type:'turn.completed'}].map(JSON.stringify).join('\n'),stderr:''};
 });
 agent.login=async()=>{};agent.credentialValues=async()=>[];agent.executionArgs=()=>['run'];
 agent.executionTimeoutMs=verify(payload()).executionLimits.agentTimeoutMs;await agent.executeTurn('accept',{},root,null,null);
 agent.executionTimeoutMs=null;await agent.executeTurn('accept',{},root,null,null);
 assert.deepEqual(seen,[3600000,1200000]);assert.deepEqual(c,{timeoutMs:1200000});
});
