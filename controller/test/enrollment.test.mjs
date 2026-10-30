import test from 'node:test';
import assert from 'node:assert/strict';
import { enrollment } from '../src/enrollment.mjs';
import { UPSTREAM_REPOSITORY, UPSTREAM_REPOSITORY_ID } from '../src/owner-identity.mjs';
function github(privateRepo, content) {
  return {
    repository: async name => name === UPSTREAM_REPOSITORY ? { id: UPSTREAM_REPOSITORY_ID, owner: { id: 77, type: 'User' } } : { private: privateRepo, owner: { id: 77, type: 'User' } },
    initialize: async()=>({repository:'owner/repo',entrypoint:privateRepo?'private-reusable':'public-runner-dispatch',defaultBranch:'main'}),
    api: async path => {
      if(path.includes('/contents/')) { if(!content)throw Object.assign(Error('missing'),{status:404});return {encoding:'base64',content:Buffer.from(content).toString('base64')}; }
      return {commit:{sha:'b'.repeat(40)}};
    },
    list: async (path)=>path.endsWith('/runners')?[{id:2,name:'runner',status:'online'}]:[{id:1,path:'.github/workflows/ci.yml',state:'active'}],
  };
}
test('private bootstrap compares the actual caller and requires an immutable Core pin', async()=>{
  await assert.rejects(enrollment(github(true),process.cwd(),'owner/repo'),/commit SHA/);
  const result=await enrollment(github(true),process.cwd(),'owner/repo',{coreCommit:'a'.repeat(40)});
  assert.ok(result.workflow.includes('@'+'a'.repeat(40)));
  assert.equal(result.workflowStatus,'missing');assert.equal(result.executionAuthorized,false);
  assert.equal(result.runners[0].id,2);
  const matched=await enrollment(github(true,result.workflow),process.cwd(),'owner/repo',{coreCommit:'a'.repeat(40)});
  assert.equal(matched.workflowStatus,'matched');
});

test('public init checks the official Owner before writing even enrollment labels', async()=>{
  const gh = github(false); let initialized = false;
  const repository = gh.repository;
  gh.repository = async name => name === UPSTREAM_REPOSITORY ? repository(name) : { private: false, owner: { id: 78, type: 'User' } };
  gh.initialize = async()=>{initialized=true;};
  await assert.rejects(enrollment(gh,process.cwd(),'foreign/repo'),/upstream Owner/);
  assert.equal(initialized,false);
});
test('public bootstrap never references private source or schedules a credential-bearing runner', async()=>{
  const result=await enrollment(github(false),process.cwd(),'owner/repo');
  assert.ok(result.workflow.includes('ubuntu-latest'));
  assert.ok(result.workflow.includes('BLOCKED'));
  assert.ok(result.workflow.includes('actions/upload-artifact@'));assert.ok(!result.workflow.includes('self-hosted'));
  assert.deepEqual(result.runners,[]);assert.equal(result.executionAuthorized,false);
});
