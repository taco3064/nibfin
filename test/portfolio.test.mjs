import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {checkPortfolio, scopeInstructions, protectedSkills, selectInstructions} from '@nibfin/core';
const packageRoot=new URL('../',import.meta.resolve('@nibfin/core'));
const asset=path=>readFileSync(new URL(path,packageRoot),'utf8');
const fixture=()=>JSON.parse(asset('examples/scope.json'));
const codes=p=>checkPortfolio(p).diagnostics.map(d=>d.code);
const reject=(mutate,code)=>{
  const p=fixture();mutate(p);
  const result=checkPortfolio(p);
  assert.equal(result.ok,false,JSON.stringify(result));
  assert.ok(result.diagnostics.some(d=>d.code===code&&d.path&&d.reason&&d.remediation),JSON.stringify(result));
};
function subset(){
  const p=fixture();p.boundary={kind:'subset',approval:'owner:subset-review-1'};
  p.items.pop();p.coverage.pop();p.exclusions=[{requirement:'release',reason:'Approved deferred release integration owned by later entry work.'}];
  p.sourceInputs=[];p.projects=p.projects.filter(project=>project.id==='core');p.dependencies=[];p.nativeDependencies=[];return p;
}
function observed(p){
  p.audit={authority:{...p.authority},issues:p.items.map(i=>({item:i.id,repository:i.repository,outcome:i.outcome,
    states:['authorized','shaped'],scope:{source:'issue:'+i.id,revision:'1',identity:'scope-'+i.id},
    shape:{source:'shape:'+i.id,revision:'1',identity:'shape-'+i.id}}))};
  return p;
}

test('whole/subset examples execute unchanged with honest resource limits',()=>{
  for(const p of [fixture(),subset()]){
    const before=JSON.stringify(p), a=checkPortfolio(p), b=checkPortfolio(p);
    assert.equal(a.ok,true);assert.equal(a.graph,'complete-observation');
    assert.equal(a.resources,'limited');assert.ok(a.diagnostics.some(d=>d.code==='resource-limit'));
    assert.deepEqual(a,b);assert.equal(JSON.stringify(p),before);
  }
  const p=fixture();p.resources[0]={name:'Node 22',kind:'tool',status:'unavailable'};
  assert.equal(checkPortfolio(p).ok,true);
  assert.equal(checkPortfolio(p).resources,'limited');
});

test('installed instructions and package example are real assets; protected map unchanged',()=>{
  assert.equal(scopeInstructions(),asset('instructions/scope.md'));
  assert.ok(scopeInstructions().length>3000);
  assert.deepEqual(protectedSkills,['shape','deliver','accept']);
  assert.throws(()=>selectInstructions({skill:'scope',role:'scope'}));
  for(const skill of protectedSkills)assert.equal(selectInstructions({skill,role:skill}).skill,skill);
  assert.ok(asset('docs/scope.md').includes('Read-only Audit template'));
});

test('malformed and omitted/conflicting coverage is actionable',()=>{
  for(const p of [null,[],42,'text',{}, {version:1}])assert.equal(checkPortfolio(p).ok,false);
  reject(p=>p.requirements=null,'schema');
  reject(p=>{p.requirements=[];p.items=[];},'empty-plan');
  reject(p=>p.requirements.push(null),'schema');
  reject(p=>p.coverage.pop(),'omission');
  reject(p=>p.coverage.push({...p.coverage[0]}),'coverage-conflict');
  reject(p=>p.coverage[0].items=['absent'],'coverage');
  reject(p=>p.items.push({...p.items[0]}),'duplicate');
  reject(p=>p.requirements.push({...p.requirements[0]}),'duplicate');
  reject(p=>p.items.push({...p.items[0],id:'other'}),'conflicting-work');
  reject(p=>p.items[0].repository=['a/b','a/c'],'ownership');
  reject(p=>p.items[0].ownership='','ownership');
  reject(p=>p.items[0].verification='','outcome');
  reject(p=>p.items[0].estimate=null,'estimate');
  reject(p=>p.items[0].estimate.lines=-1,'estimate');
  reject(p=>p.items[0].estimate.lines=1200,'estimate');
  const p=fixture();p.items[0].estimate.lines=1200;p.items[0].estimate.exception='One coherent public interface and safety suite.';
  assert.equal(checkPortfolio(p).ok,true);
  const s=subset();s.exclusions[0].reason='';assert.ok(codes(s).includes('exclusion'));
  s.boundary.approval='';assert.ok(codes(s).includes('subset-approval'));
});

test('dependency endpoints, cycles, duplicates, handoffs and independent branch',()=>{
  reject(p=>p.sourceInputs=[],'missing-handoff');
  reject(p=>p.sourceInputs[0].interface='','source-input');
  reject(p=>p.dependencies.push({from:'core',to:'missing'}),'endpoint');
  reject(p=>p.dependencies.push({from:'core',to:'core'}),'self-edge');
  reject(p=>p.dependencies.push({from:'core',to:'entry'}),'cycle');
  reject(p=>p.dependencies.push({...p.dependencies[0]}),'duplicate-edge');
  reject(p=>p.nativeDependencies=[],'dependency-drift');
  reject(p=>p.nativeDependencies.push({from:'core',to:'entry'}),'cycle');
  reject(p=>p.items[0].priority=1,'ordering');
  const p=fixture();p.items.push({...p.items[0],id:'independent',outcome:'Separate observable branch.'});
  p.coverage[0].items.push('independent');
  assert.equal(checkPortfolio(p).ok,true);
  p.items.push({...p.items[0],id:'middle',outcome:'Intermediate contract.'});p.coverage[0].items.push('middle');
  p.dependencies.push({from:'entry',to:'middle'},{from:'middle',to:'core'});
  p.nativeDependencies=structuredClone(p.dependencies);
  assert.ok(codes(p).includes('redundant-edge'));
});

test('partial graph never upgrades unresolved predecessors or global claims',()=>{
  const p=fixture();p.graphCoverage='partial';p.dependencies.push({from:'core',to:'external'});
  p.nativeDependencies=structuredClone(p.dependencies);
  const r=checkPortfolio(p);assert.equal(r.ok,true);assert.equal(r.graph,'known-subgraph');
  assert.ok(r.diagnostics.some(d=>d.code==='endpoint'&&d.severity==='warning'));
  assert.ok(r.diagnostics.some(d=>d.code==='partial-graph'));
  p.claims=[{kind:'global-graph',evidence:'Unproven global claim'}];
  assert.equal(checkPortfolio(p).ok,false);assert.ok(codes(p).includes('unsafe-graph-claim'));
});

test('read-only Audit identifies conflicts and routes protected drift to recovery',()=>{
  const p=observed(fixture());assert.equal(checkPortfolio(p).ok,true);
  p.audit.issues[0].repository='example/entry';delete p.audit.issues[0].scope.identity;
  p.audit.issues[0].outcome='Different product requirement';
  const before=JSON.stringify(p),r=checkPortfolio(p);
  for(const code of ['ownership-drift','scope-provenance','requirement-conflict']) {
    const d=r.diagnostics.find(d=>d.code===code);assert.ok(d);
    assert.match(d.remediation,/reauthorization.*recovery/);
  }
  assert.equal(JSON.stringify(p),before);
  p.audit.issues.push(structuredClone(p.audit.issues[0]));assert.ok(codes(p).includes('audit-work'));
  p.audit.issues=[];assert.ok(codes(p).includes('audit-work'));
  p.audit.authority.revision='2';assert.ok(codes(p).includes('authority-drift'));
});

test('unsafe availability, completion and provenance claims fail',()=>{
  reject(p=>p.resources[0]={name:'Node',kind:'tool',status:'observed'},'invented-availability');
  reject(p=>p.claims=[{kind:'availability',resource:'invented',evidence:'assertion'}],'unsafe-availability');
  for(const origin of ['source-project','fixture','package'])for(const kind of ['target-completion','live-provider'])
    reject(p=>p.claims=[{kind,origin,evidence:'local check'}],'unsafe-completion');
  const p=observed(fixture());p.audit.issues[0].shape.identity=p.audit.issues[0].scope.identity;
  assert.ok(codes(p).includes('conflated-provenance'));
  p.requirements[0].revision='stale';assert.ok(codes(p).includes('authority-drift'));
});

test('every protected lifecycle state routes observed drift through recovery',()=>{
  for(const state of ['frozen','authorized','shaped','active','delivered','closed']){
    const p=observed(fixture());p.audit.issues[0].states=[state];p.audit.issues[0].repository='example/drift';
    assert.match(checkPortfolio(p).diagnostics.find(d=>d.code==='ownership-drift').remediation,/reauthorization.*recovery/);
  }
  const p=observed(fixture());delete p.audit.issues[0].states;
  assert.ok(codes(p).includes('audit-state'));
  p.audit.issues[0].repository='example/drift';
  assert.match(checkPortfolio(p).diagnostics.find(d=>d.code==='ownership-drift').remediation,/reauthorization.*recovery/);
  p.audit.issues[0].states=['shaped'];delete p.audit.issues[0].shape;
  assert.ok(codes(p).includes('shape-provenance'));
});


test('malformed availability references return diagnostics without throwing',()=>{
  // Includes the independently reported null entry plus omitted claim resource.
  for(const resources of [[null], [null, {}], [false, 0, "invalid"],
    [{status:'observed',evidence:'unnamed resource'}],
    [{name:'Node 22',kind:'tool',status:'observed',evidence:'local observation'},null]]) {
    for(const resource of [undefined,null,'',42,'missing']) {
      const p=fixture();p.resources=resources;
      p.claims=[{kind:'availability',evidence:'claim',...(resource===undefined?{}:{resource})}];
      const before=JSON.stringify(p);
      let result;
      assert.doesNotThrow(()=>{result=checkPortfolio(p);});
      assert.equal(result.ok,false);
      assert.ok(result.diagnostics.some(d=>d.code==='resource'&&d.path.startsWith('resources[')));
      assert.ok(result.diagnostics.some(d=>d.code==='unsafe-availability'&&d.path==='claims[0]'&&d.reason&&d.remediation));
      assert.deepEqual(checkPortfolio(p),result);
      assert.equal(JSON.stringify(p),before);
    }
  }
  const p=fixture();
  p.resources=[null,{name:'Node 22',kind:'tool',status:'observed',evidence:'local observation'}];
  p.claims=[{kind:'availability',resource:'Node 22',evidence:'local observation'}];
  assert.equal(checkPortfolio(p).ok,false); // Malformed entry still rejects the portfolio.
  assert.ok(!codes(p).includes('unsafe-availability')); // Valid reference still resolves.
  p.resources.shift();
  assert.equal(checkPortfolio(p).ok,true);
});

test('source consumption replaces proof handoffs while legacy v1 remains accepted',()=>{
  const p=fixture();assert.equal(Object.hasOwn(p,'handoffs'),false);
  assert.equal(checkPortfolio(p).ok,true);
  const legacy=structuredClone(p);delete legacy.projects;
  for(const item of legacy.items)delete item.project;
  legacy.handoffs=[{producer:'core',consumer:'entry',contract:'Consume src/index.mjs at the merged producer revision.',
    verification:'Local consumer import and rejection tests; no producer report.'}];
  delete legacy.sourceInputs;
  assert.equal(checkPortfolio(legacy).ok,true);
  legacy.handoffs[0].verification='';assert.ok(codes(legacy).includes('handoff'));
  for(const mutate of [s=>s.paths=[],s=>s.paths=['../private'],s=>s.paths=['/absolute'],
    s=>s.revision='',s=>s.producer='missing',s=>s.interface='']) {
    const invalid=fixture();mutate(invalid.sourceInputs[0]);
    assert.equal(checkPortfolio(invalid).ok,false);assert.ok(codes(invalid).includes('source-input'));
  }
  const absent=fixture();delete absent.sourceInputs;assert.ok(codes(absent).includes('schema'));
  const malformed=fixture();malformed.handoffs={};assert.ok(codes(malformed).includes('schema'));
});

function emptyProject() {
  const p=fixture();
  p.projects=[{id:'shared',baseline:'empty',bootstrap:'core'}];
  for(const item of p.items)item.project='shared';
  Object.assign(p.items[0],{type:'bootstrap',outcome:'Pinned package/lockfile and shared check entry points only.',
    verification:'Local setup and negative tool/config checks; no feature, release or E2E.'});
  for(const id of ['feature-a','feature-b']) {
    p.items.push({...p.items[0],id,type:'implementation',outcome:`Independent source feature ${id}.`,
      verification:'Local contract and rejection tests.'});
    p.coverage[0].items.push(id);
  }
  p.dependencies=[{from:'feature-a',to:'core'},{from:'feature-b',to:'core'},{from:'entry',to:'feature-a'}];
  p.nativeDependencies=structuredClone(p.dependencies);
  p.sourceInputs=[{...p.sourceInputs[0],producer:'feature-a'}];
  return p;
}

test('one empty-project bootstrap supports independent branches and transitive consumers',()=>{
  const p=emptyProject(),before=JSON.stringify(p);
  assert.equal(checkPortfolio(p).ok,true,JSON.stringify(checkPortfolio(p)));
  assert.equal(JSON.stringify(p),before);
  for(const item of p.items)if(item.type==='implementation')assert.match(item.verification,/Local/);
  const duplicate=structuredClone(p);duplicate.items.find(i=>i.id==='feature-b').type='bootstrap';
  assert.ok(codes(duplicate).includes('bootstrap'));
  const orphan=structuredClone(p);orphan.dependencies=orphan.dependencies.filter(e=>e.from!=='feature-b');
  orphan.nativeDependencies=structuredClone(orphan.dependencies);
  assert.ok(codes(orphan).includes('bootstrap-path'));assert.equal(checkPortfolio(orphan).ok,false);
  const missing=structuredClone(p);delete missing.projects[0].bootstrap;
  assert.ok(codes(missing).includes('bootstrap'));
});

test('initialized baseline is reused; malformed project observations cannot prove setup',()=>{
  assert.equal(checkPortfolio(fixture()).ok,true);
  reject(p=>p.items[0].type='bootstrap','bootstrap');
  reject(p=>p.projects[0].bootstrap='core','bootstrap');
  reject(p=>p.projects[0].revision='','baseline');
  reject(p=>p.projects[0].baseline='unknown','baseline');
  reject(p=>p.items[0].project='absent','project');
  reject(p=>p.projects.push({...p.projects[0]}),'duplicate');
  reject(p=>delete p.projects,'project');
  // Two genuinely separate empty projects each get one root, not two roots
  // initializing the same shared project.
  const p=emptyProject();p.items.find(i=>i.id==='entry').type='bootstrap';
  p.items.find(i=>i.id==='entry').project='entry';
  p.projects.push({id:'entry',baseline:'empty',bootstrap:'entry'});
  assert.equal(checkPortfolio(p).ok,true);
});

test('bounded Investigation observes actual package source without creating formal Shape',()=>{
  const request={mode:'Plan',question:'Can a consumer retrieve instructions without a protected Scope role?',
    paths:['src/index.mjs','src/portfolio.mjs','instructions/scope.md'],access:'read-only package files'};
  const portfolio=observed(fixture()),before=JSON.stringify(portfolio);
  const observations=request.paths.map(path=>({path,text:asset(path)}));
  assert.match(observations[0].text,/scopeInstructions/);
  assert.match(observations[1].text,/instructions\/scope.md/);
  const finding={question:request.question,observations:observations.map(o=>o.path),
    uncertainty:'No actual provider, host or release was observed.',
    implication:'Consume source/exports directly; no new protected role or dependency inferred.'};
  assert.ok(finding.uncertainty);assert.deepEqual(protectedSkills,['shape','deliver','accept']);
  assert.equal(checkPortfolio(portfolio).ok,true);
  assert.equal(JSON.stringify(portfolio),before); // Source inspection and Audit preserve supplied observations.
});
