import test from 'node:test';
import assert from 'node:assert/strict';
import {observeRequirementAuthority,observeIssueAuthority,supportedRequirementSources,bodyDigest} from '../src/index.mjs';

const target={repository:'example-org/core',repositoryId:'42',issueId:'I_101',databaseId:'61',number:'101'};
function fixture(){
  const calls=[],body='Current Scope\n完整原文',repo={id:'42',full_name:target.repository,private:false,visibility:'public'},
    issue={id:'61',node_id:'I_101',number:101,body,repository_url:'https://api.github.com/repos/'+target.repository,
      url:'https://api.github.com/repos/'+target.repository+'/issues/101'};
  return {calls,repo,issue,input:{source:{kind:'github-issue',target:structuredClone(target)},cycle:'cycle-1',approvalId:'installed-owner-policy',
    now:()=>1100,provider:{request:async r=>{calls.push(r);assert.equal(r.method,'GET');
      return {outcome:'read',data:r.endpoint==='/repos/'+target.repository?repo:issue};}}}};
}

test('generic requirement entry preserves the GitHub compatibility contract and exact content identity',async()=>{
  const f=fixture(),result=await observeRequirementAuthority(f.input);
  assert.equal(result.outcome,'observed');assert.deepEqual(result.source,f.input.source);
  const old=await observeIssueAuthority({...f.input,target});
  assert.deepEqual(result.authority,old.authority);assert.deepEqual(result.source.target,old.target);
  assert.equal(result.authority.revision,bodyDigest(f.issue.body));
  assert.deepEqual(supportedRequirementSources,[{kind:'github-issue',version:1}]);
  assert.ok(Object.isFrozen(supportedRequirementSources)&&Object.isFrozen(supportedRequirementSources[0]));
  result.source.target.number='999';assert.equal(f.input.source.target.number,'101');
});

test('unsupported or malformed source selections never perform I/O or silently fall back to GitHub',async()=>{
  for(const source of [{kind:'jira',target},{kind:'linear',target},{kind:'notion',target},{kind:'GitHub',target},
    {kind:'github-issue',target,adapterModule:'./untrusted.mjs'},null,{kind:'github-issue',target:{url:'https://github.com/example-org/core/issues/101'}}]){
    const f=fixture();assert.deepEqual(await observeRequirementAuthority({...f.input,source}),
      {outcome:'unavailable',reason:'requirement-source-unavailable'});assert.equal(f.calls.length,0);
  }
});

test('source selection and connection stay outside requirement prose and mutable caller input',async()=>{
  const f=fixture();f.issue.body='{"kind":"jira","target":"https://untrusted.example","adapterModule":"evil.mjs"}';
  const original=f.input.provider.request;f.input.provider.request=async r=>{
    f.input.source.kind='linear';f.input.source.target.repository='other/repo';return original(r);
  };
  const result=await observeRequirementAuthority(f.input);assert.equal(result.outcome,'observed');
  assert.equal(result.source.kind,'github-issue');assert.equal(result.source.target.repository,target.repository);
  assert.equal(result.authority.source,'https://github.com/example-org/core/issues/101');
  assert.equal(result.authority.components[0].body,f.issue.body);
  assert.deepEqual(f.calls.map(r=>r.endpoint),['/repos/example-org/core','/repos/example-org/core/issues/101']);
});

test('timeout rejects late adapter continuation and does not fetch a second resource after the observer returns',async()=>{
  const f=fixture();let release;
  f.input.provider.request=r=>{f.calls.push(r);return new Promise(resolve=>{release=()=>resolve({outcome:'read',data:f.repo});});};
  const hold=setTimeout(()=>{},1000);
  try{
    assert.equal((await observeRequirementAuthority({...f.input,timeoutMs:5})).outcome,'unavailable');
    release();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.length,1);
  }finally{clearTimeout(hold);}
});
