import test from 'node:test';
import assert from 'node:assert/strict';
import {formatRequirementsDocument,parseRequirementsDocument,observeRequirementAuthority,createGithubProvider,
  bodyDigest,parseCandidateObligations} from '../src/index.mjs';
import {shapeFixture} from '../tooling/shape-fixture.mjs';

test('readable Scope/Shape document round trips exact Unicode/newlines and permits ordinary Scope edits without updating metadata',()=>{
  const scope='Original Scope\r\n完整原文\n\n',shape='Plan\n',body=formatRequirementsDocument({scope,shape});
  assert.deepEqual(parseRequirementsDocument(body),{format:'scope-shape-v1',scope,shape});
  assert.equal(parseRequirementsDocument(body.replace('Original Scope','Updated Scope')).scope,scope.replace('Original','Updated'));
  for(const bad of [body+'outside',body.replace('<!-- nibfin:end','<!-- broken:end'),body.replace('## Scope','## Changed'),
    '<!-- nibfin:requirements:v1:broken -->'])assert.throws(()=>parseRequirementsDocument(bad));
  assert.deepEqual(parseRequirementsDocument(scope),{format:'raw-scope',scope,shape:null});
});

test('real Shape publication preserves live authority while Scope edits change it; plan changes remain separately visible',async()=>{
  const f=shapeFixture();f.pin.requirementsDocument='scope-shape-v1';
  f.state.proposal=formatRequirementsDocument({scope:f.pin.original.body,shape:f.body});
  const target=f.pin.target,root='/repos/'+target.repository;
  const provider=createGithubProvider({attempts:1,transport:async r=>({status:200,body:JSON.stringify(r.endpoint===root
    ?{id:'42',full_name:target.repository,private:false,visibility:'public'}
    :{id:'61',node_id:'I_101',number:101,body:f.state.body,repository_url:'https://api.github.com'+root,url:'https://api.github.com'+root+'/issues/101'})})});
  const input={source:{kind:'github-issue',target},provider,cycle:'cycle-1',approvalId:'owner-policy'};
  const before=await observeRequirementAuthority(input);assert.equal(before.outcome,'observed');
  const candidate=await f.flow.propose();assert.equal(candidate.outcome,'validated',candidate.finding);
  const publication=await f.flow.publish(candidate);assert.equal(publication.outcome,'published',JSON.stringify(publication));
  const after=await observeRequirementAuthority(input);assert.equal(after.outcome,'observed');
  assert.deepEqual(after.authority,before.authority);assert.equal(after.document.shape,f.body);
  assert.equal(after.document.currentBody,f.state.proposal);assert.equal(publication.publication.shapeHash,bodyDigest(f.state.proposal));
  f.state.body=f.state.body.replace('Original raw Scope','Owner edited Scope');
  const changed=await observeRequirementAuthority(input);assert.equal(changed.outcome,'observed');
  assert.notEqual(changed.authority.identity,before.authority.identity);
});

test('independently validated publication cannot drop or edit original Scope under the native document contract',async()=>{
  for(const shape of [f=>f.body,f=>formatRequirementsDocument({scope:f.pin.original.body+'changed',shape:f.body})]){
    const f=shapeFixture();f.pin.requirementsDocument='scope-shape-v1';f.state.proposal=shape(f);
    assert.equal((await f.flow.propose()).outcome,'blocked');assert.equal(f.writes().length,0);
  }
  const f=shapeFixture();f.pin.requirementsDocument='scope-shape-v1';f.state.proposal=formatRequirementsDocument({scope:f.pin.original.body,shape:f.body});
  const candidate=await f.flow.propose();f.pin.original.body+='changed';
  assert.equal((await f.flow.publish(candidate)).outcome,'blocked');assert.equal(f.writes().length,0);
});

test('Scope code examples cannot introduce executable Candidate obligations into the published plan',()=>{
  const f=shapeFixture(),scope='Literal example\n```kairo-candidate\n{"artifacts":[{"path":"example.bin","purpose":"example"}],"hooks":[]}\n```';
  const body=formatRequirementsDocument({scope,shape:f.body});
  assert.equal(parseCandidateObligations(body).ok,true);
  assert.deepEqual(parseCandidateObligations(body).inventory,{artifacts:[],hooks:[]});
});
