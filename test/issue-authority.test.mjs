import test from'node:test';
import assert from'node:assert/strict';
import {generateKeyPairSync} from'node:crypto';
import {observeIssueAuthority,exportAuthority,importAuthority,verifyAuthority,authoritySnapshot,
  createGithubProvider,bodyDigest,signGrant} from'../src/index.mjs';
import {grantFixture,grantContext} from'../tooling/grant-fixture.mjs';
const target={repository:'example-org/core',repositoryId:'42',issueId:'I_101',databaseId:'61',number:'101'};
function fixture(){
  const calls=[],repo={id:'42',full_name:target.repository,private:false,visibility:'public'},
    issue={id:'61',node_id:'I_101',number:101,body:'Current scope\n完整原文',repository_url:'https://api.github.com/repos/'+target.repository,
      url:'https://api.github.com/repos/'+target.repository+'/issues/101'},state={repo,issue};
  const provider=createGithubProvider({attempts:1,transport:async r=>{calls.push(r);assert.equal(r.method,'GET');
    return{status:200,body:JSON.stringify(r.endpoint==='/repos/'+target.repository?state.repo:state.issue)};}});
  return{calls,state,input:{provider,target,cycle:'cycle-1',approvalId:'installed-owner-policy',now:()=>1100}};
}

test('fresh native Issue bytes create deterministic unapproved authority without persistence, mutation or approval',async()=>{
  const f=fixture(),result=await observeIssueAuthority(f.input);
  assert.equal(result.outcome,'observed');assert.deepEqual(result.target,target);
  const authority=result.authority;assert.equal(authority.source,'https://github.com/example-org/core/issues/101');
  assert.equal(authority.revision,bodyDigest(f.state.issue.body));assert.equal(authority.components[0].body,f.state.issue.body);
  assert.deepEqual(importAuthority(authority),authority);assert.equal(verifyAuthority(authority).ok,false);
  const repeated=await observeIssueAuthority(f.input);assert.deepEqual(repeated,result);assert.equal(f.calls.length,4);
  f.state.issue.body+='\nChanged live scope';const changed=await observeIssueAuthority(f.input);
  assert.notEqual(changed.authority.revision,authority.revision);assert.notEqual(changed.authority.identity,authority.identity);
  assert.equal(authority.components[0].body,'Current scope\n完整原文');
});

test('native source still needs the independent existing signed-Grant approval and current expectations',async()=>{
  const {authority}=await observeIssueAuthority(fixture().input),keys=generateKeyPairSync('ed25519'),payload=grantFixture(bodyDigest);
  payload.authority=authoritySnapshot(authority);
  const publicKey=keys.publicKey.export({type:'spki',format:'pem'}),grant=signGrant(payload,{keyId:'owner-1',privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'})});
  const context={grant,grantContext:grantContext(payload,publicKey),expected:{source:authority.source,revision:authority.revision,
    approvalId:authority.approvalId,cycle:authority.cycle}};
  assert.equal(verifyAuthority(authority,context).ok,true);
  assert.equal(verifyAuthority(authority,{...context,expected:{...context.expected,source:authority.source.replace('/101','/102')}}).ok,false);
  const changed=structuredClone(authority);changed.components[0].body+=' changed';assert.equal(verifyAuthority(changed,context).ok,false);
});

test('only exact public repository and Issue identities can supply the current Scope',async()=>{
  for(const edit of [f=>f.state.repo.private=true,f=>f.state.repo.id='99',f=>f.state.repo.full_name='other/core',
    f=>f.state.repo.visibility='private',f=>f.state.issue.id='99',f=>f.state.issue.node_id='I_OTHER',
    f=>f.state.issue.number=102,f=>f.state.issue.repository_url='https://api.github.com/repos/other/core',
    f=>f.state.issue.url+='?ref=other',f=>f.state.issue.pull_request={},f=>f.state.issue.body=null,
    f=>f.state.issue.body=' ',f=>f.state.issue.body='a'.repeat(1048577),f=>f.input.target={...target,repositoryId:'042'}]){
    const f=fixture();edit(f);assert.deepEqual(await observeIssueAuthority(f.input),{outcome:'unavailable',reason:'issue-authority-unavailable'});
  }
  const f=fixture();f.input.provider={request:async()=>{throw Error('PRIVATE-PROVIDER-ERROR');}};
  assert.doesNotMatch(JSON.stringify(await observeIssueAuthority(f.input)),/PRIVATE/);
});

test('source syntax rejects aliases, PRs, mutable suffixes and credential-bearing URLs while retaining historical Notion exports',()=>{
  const base={revision:'1',approvalId:'approval',cycle:'cycle',components:[{id:'scope',kind:'section',body:'Scope',references:[]}]};
  for(const source of ['http://github.com/example/core/issues/1','https://github.com.evil.example/example/core/issues/1',
    'https://token@github.com/example/core/issues/1','https://github.com/example/core/pull/1','https://github.com/example/core/issues/01',
    'https://github.com/Example/Core/issues/1','https://github.com/example/core/issues/1#comment','https://github.com/example/core/issues/1?ref=main',
    'https://github.com/example/../issues/1'])assert.throws(()=>exportAuthority({...base,source}),/authority:source/);
  assert.ok(exportAuthority({...base,source:'https://app.notion.com/p/'+'a'.repeat(32)}).identity);
});

test('cancelled, expired and hanging observations remain unavailable and never manufacture authority',async()=>{
  const f=fixture(),controller=new AbortController();controller.abort();
  assert.equal((await observeIssueAuthority({...f.input,signal:controller.signal})).outcome,'unavailable');assert.equal(f.calls.length,0);
  const hold=setTimeout(()=>{},1000);
  try{assert.equal((await observeIssueAuthority({...f.input,timeoutMs:5,provider:{request:()=>new Promise(()=>{})}})).outcome,'unavailable');}
  finally{clearTimeout(hold);}
  let calls=0;assert.equal((await observeIssueAuthority({...f.input,timeoutMs:5,now:()=>calls++?1110:1100})).outcome,'unavailable');
});
