import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,shape,deliver,NOW } from './fixtures.mjs';
import { digest,plan } from '../src/core.mjs';
function prepared(number,required=false){
 const f=fixture(),old=f.manifest.issues[0],id=number===46?'I_kwDOVRsWxs8AAAABZBxG0A':'I_kwDOVRsWxs8AAAABZBxTsw',issue={...old,id,repository:'taco3064/nibfin',repositoryId:'1427838662',number,dependencies:[]};
 f.manifest.issues=[issue];f.snapshot.issues={[id]:{...f.snapshot.issues[old.id],...issue}};
 const deployment=required?{mode:'required',environment:'production',stream:'website',maxAgeMs:60000,statusActorIds:['7'],trustedCheckAppIds:[1],requiredChecks:['health'],workflow:{path:'.github/workflows/deploy.yml',blobSha:'a'.repeat(40),checks:['health']}}:{mode:'not-applicable',reason:'Original library policy'};
 f.policy.repositories={'taco3064/nibfin':{...f.policy.repositories['example/one'],deployment,issueDeployment:{issueId:id,mode:number===46?'source-only':'required',revisionHash:digest('revision'),baseline:'preserve-repository'}}};f.policy.controlMode='owner-project';f.policy.executionMode='actions-v1';f.policy.manifestHash=digest(f.manifest);f.snapshot.manifestHash=digest(f.manifest);f.snapshot.policyHash=digest(f.policy);f.snapshot.approval.manifestHash=digest(f.manifest);f.snapshot.approval.policyHash=digest(f.policy);f.snapshot.runtime.actionStage={kind:'github-action-stage',identityHash:'fixture'};shape(f,id);return{f,issue,live:f.snapshot.issues[id]};
}
test('#52 cannot start Deliver under the inherited library no-deployment policy',()=>{const{f}=prepared(52);const r=plan(f.manifest,f.policy,f.snapshot,NOW);assert.equal(r.code,'WEBSITE_DEPLOYMENT_POLICY_REQUIRED',JSON.stringify(r));});
test('#52 cannot complete even if candidate and merge are supplied under a no-deployment policy',()=>{const{f,issue}=prepared(52);deliver(f,issue.id,true);const r=plan(f.manifest,f.policy,f.snapshot,NOW);assert.equal(r.code,'WEBSITE_DEPLOYMENT_POLICY_REQUIRED',JSON.stringify(r));});
test('#46 source-only never bypasses failed existing repository deployment health',()=>{const{f,issue,live}=prepared(46,true);deliver(f,issue.id,true);live.state='open';live.deploymentBaseline={status:'failed'};const r=plan(f.manifest,f.policy,f.snapshot,NOW);assert.equal(r.code,'DEPLOYMENT_BASELINE_UNHEALTHY',JSON.stringify(r));});
test('#46 source-only does not require its own new Pages deployment when repository health is inapplicable',()=>{const{f,issue,live}=prepared(46);deliver(f,issue.id,true);live.state='open';const r=plan(f.manifest,f.policy,f.snapshot,NOW);assert.equal(r.operation,'close',JSON.stringify(r));});
