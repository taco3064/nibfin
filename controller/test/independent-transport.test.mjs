import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {verifyIndependentTransport,notificationPolicy,rescueWorkflowFor} from '../src/independent-transport.mjs';
import {signGrant} from '../src/authority.mjs';
import {digest} from '../src/core.mjs';
import {runtimeConfigurationHash} from '../src/runtime-configuration.mjs';
import {verifyKairoOwner} from '../src/owner-identity.mjs';
const keys=generateKeyPairSync('ed25519'),hash='a'.repeat(64),blob='b'.repeat(40);
function fixture(){
 const binding={runnerId:'existing-runner',repository:'taco3064/nibfin',repositoryId:'1427838662',ownerId:'127829492',bindingId:'1234567890abcdef',workflowPath:'.github/workflows/kairo.yml',workflowBlob:blob};
 const events={'taco3064/nibfin':{actorIds:['127829492'],reconcileWorkflowPaths:['.github/workflows/repository-policy.yml'],signerVerification:'hmac-workflow-pin'}};
 const config={runnerId:binding.runnerId,grantSource:{repository:'historical/source',path:'grant.json',ref:'main'},agent:{authDirectory:'/credentials'},actionExecution:{coordinationHostId:hash},independentTransport:{authorityFile:'/etc/nibfin/development/authority.json',proposalFile:'/etc/nibfin/development/proposal.txt',registryPath:'/etc/nibfin/development/bindings.json'}};
 const grant={recordId:'unchanged-record',actorGitHubUserId:'127829492',manifest:{issues:[]},policy:{runnerId:binding.runnerId,publicRunner:{rootId:hash,bindings:{'taco3064/nibfin':binding}},kairoOwnerGitHubUserId:'127829492',actionExecution:config.actionExecution,actionEvents:events,repositories:{'taco3064/nibfin':{}}}};
 const execution={repository:'taco3064/nibfin',repositoryId:'1427838662',visibility:'public',workflowPath:'.github/workflows/nibfin-controller.yml',workflowBlob:blob,ref:'main',ownerId:'127829492',identityMode:'local-gh',actorIds:['127829492','41898282'],workers:[{id:1,name:'nibfin-worker-1'},{id:2,name:'nibfin-worker-2'}],runnerIds:[1,2],coordinationHostId:hash,jobName:'execute',handoffJobName:'handoff'};
 const payload={schemaVersion:1,kind:'nibfin-independent-transport',grantRecordId:grant.recordId,manifestHash:digest(grant.manifest),policyHash:digest(grant.policy),coreDigest:hash,runtimeHash:runtimeConfigurationHash(config),settingsHash:digest(config.independentTransport),reason:'Owner-authorized migration',execution,rescueWorkflow:'.github/workflows/nibfin-rescue.yml',rescueWorkflowBlob:blob,authorityRepository:'taco3064/nibfin',authorityRepositoryId:'1427838662',notifications:{publicRunner:{rootId:hash,bindings:{'taco3064/nibfin':{...binding,workflowPath:'.github/workflows/nibfin-events.yml'}}},actionEvents:events}};
 return {config,grant,payload};
}
test('signed migration retains original scope/authority and selects exact public execution and caller pins',()=>{
 const {config,grant,payload}=fixture(),before=structuredClone(grant);
 const result=verifyIndependentTransport(signGrant(payload,keys.privateKey),grant,config,hash,keys.publicKey.export({type:'spki',format:'pem'}));
 assert.equal(result.verified,true);assert.deepEqual(grant,before);assert.equal(rescueWorkflowFor({transport:result}),'.github/workflows/nibfin-rescue.yml');
 assert.equal(notificationPolicy({transport:result},grant).publicRunner.bindings['taco3064/nibfin'].workflowPath,'.github/workflows/nibfin-events.yml');
});
test('signature, scope, host, settings, foreign repository, runner, event capability and pins fail closed',()=>{
 const changes=[p=>p.grantRecordId='foreign',p=>p.policyHash='0'.repeat(64),p=>p.manifestHash='0'.repeat(64),p=>p.settingsHash='0'.repeat(64),p=>p.coreDigest='0'.repeat(64),p=>p.runtimeHash='0'.repeat(64),p=>p.execution.repository='foreign/repo',p=>p.execution.repositoryId='1',p=>p.execution.visibility='private',p=>p.execution.ownerId='1',p=>p.execution.workflowBlob='unpinned',p=>p.execution.coordinationHostId='0'.repeat(64),p=>p.execution.runnerIds=[99],p=>p.execution.workers[1].id=1,p=>p.execution.actorIds.push('999'),p=>p.notifications.actionEvents['taco3064/nibfin'].actorIds.push('999'),p=>p.notifications.publicRunner.bindings['taco3064/nibfin'].ownerId='1',p=>p.rescueWorkflowBlob='unpinned'];
 for(const mutate of changes){const {config,grant,payload}=fixture();mutate(payload);assert.throws(()=>verifyIndependentTransport(signGrant(payload,keys.privateKey),grant,config,hash,keys.publicKey.export({type:'spki',format:'pem'})));}
 const {config,grant,payload}=fixture(),record=signGrant(payload,keys.privateKey);record.payload.reason='tampered';assert.throws(()=>verifyIndependentTransport(record,grant,config,hash,keys.publicKey.export({type:'spki',format:'pem'})));
});
test('independent ownership reads only the immutable Nibfin repository identity',async()=>{
 const calls=[],github={ownerAuthority:{repository:'taco3064/nibfin',repositoryId:'1427838662'},repository:async name=>{calls.push(name);return{id:1427838662,owner:{id:127829492,type:'User'}};},api:async()=>({id:127829492,type:'User'})};
 assert.equal(await verifyKairoOwner(github,{kairoOwnerGitHubUserId:'127829492'}),'127829492');assert.deepEqual(calls,['taco3064/nibfin']);
 github.repository=async()=>({id:1,owner:{id:127829492,type:'User'}});await assert.rejects(verifyKairoOwner(github,{kairoOwnerGitHubUserId:'127829492'}));
});
