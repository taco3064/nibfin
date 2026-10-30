import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/index.mjs';
import {hostIdentityFixture} from '../tooling/host-identity-fixture.mjs';
import {selectionFixture} from '../tooling/selection-fixture.mjs';
const descriptor=(repository,repositoryId,ownerId,ownerType)=>({version:1,repository,repositoryId,ownerId,ownerType});
test('v2 pooled hosted identity authenticates the real project OIDC and never reads a central execution repository',async()=>{
 const f=await hostIdentityFixture('lookup');
 Object.assign(f.policy,{repository:f.config.options.repository,repository_id:f.config.options.repositoryId,
  repository_owner_id:'17',workflow_ref:f.config.options.repository+'/.github/workflows/stage.yml@refs/heads/main'});
 f.state.token=await f.sign({repository:f.policy.repository,repository_id:f.policy.repository_id,
  repository_owner_id:'17',workflow_ref:f.policy.workflow_ref});
 f.config.options.executionPool={version:2,id:'member-default',capacity:6,targets:[descriptor(f.policy.repository,f.policy.repository_id,'17','Organization')]};
 const identity=await f.make().authenticate(f.argument);assert.equal(identity.repository,f.config.options.repository);
 assert.ok(f.calls.every(c=>!c.endpoint.includes('source-org')));
});
test('v2 Runner inventory and bindings remain at their actual repository and reject a foreign registration',async()=>{
 const f=selectionFixture(),pool={version:2,id:'member-default',capacity:6,
  targets:[descriptor('example-org/core',f.input.target.id,'7','Organization')]};
 const input={...f.input,executionPool:pool,correlation:'pool-v2'};
 const result=await core.observeRunnerBindings(f.provider,input);assert.equal(result.outcome,'matched',JSON.stringify(result));
 const rejected=await core.observeRunnerBindings(f.provider,{...input,registration:{level:'repository',id:'999'}});
 assert.notEqual(rejected.outcome,'matched');
 assert.throws(()=>core.validateMemberBinding({...f.input.records[0],version:2,executionRepositoryId:'999'},
  {repositoryId:f.input.target.id,registration:f.input.registration,executionPool:pool}));
});
