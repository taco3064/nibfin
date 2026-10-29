import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,chmodSync,symlinkSync,mkdirSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureWorkspace,exportWorkspace,importWorkspace,verifyWorkspace,materializeWorkspace,bodyDigest,contentIdentity,byteDigest,createEvidence} from '../src/index.mjs';

const binary=Buffer.from([0,255,128,1,0,10]);
const empty={artifacts:[],hooks:[]};
function fixture(inventory=empty) {
  const root=mkdtempSync(join(tmpdir(),'nibfin-workspace-test-'));
  const git=(...args)=>execFileSync('git',args,{cwd:root,env:{PATH:process.env.PATH,HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},stdio:['pipe','pipe','pipe']});
  git('init','--object-format=sha1');git('config','user.email','test@example.invalid');git('config','user.name','Fixture');
  for(const [p,b] of Object.entries({'tracked':'base','deleted':'delete','mode':'mode','binary':binary,'.gitignore':'ignored\n'})) writeFileSync(join(root,p),b);
  mkdirSync(join(root,'nested'));writeFileSync(join(root,'nested/base'),'nested base');
  git('add','.');git('-c','core.hooksPath=/dev/null','commit','-qm','base');
  const base=git('rev-parse','HEAD').toString().trim();
  writeFileSync(join(root,'tracked'),'staged');git('add','tracked');writeFileSync(join(root,'tracked'),'final');
  writeFileSync(join(root,'binary'),Buffer.from([0,254,129]));rmSync(join(root,'deleted'));chmodSync(join(root,'mode'),0o755);
  writeFileSync(join(root,'untracked..file'),'untracked');writeFileSync(join(root,'ignored'),binary);
  for(const h of inventory.hooks) writeFileSync(join(root,h.path),'#!/bin/sh\nexit 99\n'+h.path);
  const scopeBody='Current Scope',shapeBody=['Candidate artifacts applicability: No other artifacts.',
    'Candidate hooks applicability: This fixture explicitly has no applicable hooks.',
    '```kairo-candidate',JSON.stringify(inventory),'```'].join('\n');
  const input={root,base,scopeBody,shapeBody,permittedPaths:['nested','tracked','deleted','mode','binary','.gitignore','untracked..file','ignored',...inventory.hooks.map(h=>h.path)],
    binding:{repository:'example/public',scopeHash:bodyDigest(scopeBody),shapeHash:bodyDigest(shapeBody),cycle:'cycle-1',policy:'a'.repeat(64)}};
  return {root,git,input,close:()=>rmSync(root,{recursive:true,force:true})};
}
const inv={artifacts:[{path:'ignored',purpose:'Mandatory binary'}],hooks:[
  {path:'pre1',event:'pre-commit'},{path:'pre2',event:'pre-commit'},
  {path:'prepare',event:'prepare-commit-msg'},{path:'message',event:'commit-msg'}]};
const wire=c=>JSON.parse(exportWorkspace(c));
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const pack=v=>Buffer.from(canonical(v));

test('native materialization restores exact binary/modes/ignored sources into an independent role without modifying the original',()=>{
  const f=fixture(inv),parent=mkdtempSync(join(tmpdir(),'nibfin-role-materialize-'));
  try{
    const original=captureWorkspace(f.input),sourceIndex=readFileSync(join(f.root,'.git/index'));
    const transferred=importWorkspace(exportWorkspace(original),{expected:original.expected}),root=join(parent,'review');
    mkdirSync(root,{mode:0o700});
    const output=materializeWorkspace(transferred,{expected:original.expected,root});
    assert.equal(output.status,'materialized');assert.deepEqual(output.workspace,original.expected);
    assert.deepEqual(readFileSync(join(root,'ignored')),binary);
    const observed=captureWorkspace({...f.input,root});
    assert.deepEqual(observed.expected,original.expected);
    assert.deepEqual(exportWorkspace(observed),exportWorkspace(original));
    assert.deepEqual(readFileSync(join(f.root,'.git/index')),sourceIndex);
    const before=readFileSync(join(root,'tracked'));
    assert.throws(()=>materializeWorkspace(transferred,{expected:original.expected,root}),/materialize-existing-work/);
    assert.deepEqual(readFileSync(join(root,'tracked')),before);
    assert.equal(readdirSync(parent).some(name=>name.startsWith('.nibfin-materialize-')),false);
  }finally{f.close();rmSync(parent,{recursive:true,force:true});}
});

test('native materialization rejects foreign expectations, links and nonempty destinations without leaving staging resources',()=>{
  const f=fixture(),parent=mkdtempSync(join(tmpdir(),'nibfin-role-materialize-'));
  try{
    const value=captureWorkspace(f.input),root=join(parent,'review');
    const foreign={...value.expected,identity:'f'.repeat(64)};
    assert.throws(()=>materializeWorkspace(value,{expected:foreign,root}),/mismatch/);assert.equal(existsSync(root),false);
    symlinkSync(f.root,root);
    assert.throws(()=>materializeWorkspace(value,{expected:value.expected,root}),/materialize-existing-work/);
    rmSync(root);mkdirSync(root,{mode:0o700});writeFileSync(join(root,'original'),'keep');
    assert.throws(()=>materializeWorkspace(value,{expected:value.expected,root}),/materialize-existing-work/);
    assert.equal(readFileSync(join(root,'original'),'utf8'),'keep');
    assert.equal(readdirSync(parent).some(name=>name.startsWith('.nibfin-materialize-')),false);
  }finally{f.close();rmSync(parent,{recursive:true,force:true});}
});

test('real Git fidelity, declared ignored bytes, source order, immutable round trip',()=>{
  const f=fixture(inv);
  try {
    const index=f.git('ls-files','--stage','-z'), status=f.git('status','--porcelain=v1','-z');
    const rawIndex=readFileSync(join(f.root,'.git/index'));
    const c=captureWorkspace(f.input), expected=c.expected;
    assert.deepEqual(readFileSync(join(f.root,'.git/index')),rawIndex);
    assert.deepEqual(f.git('ls-files','--stage','-z'),index);assert.deepEqual(f.git('status','--porcelain=v1','-z'),status);
    assert.deepEqual(c.sources.map(e=>[e.path,e.event]),[['ignored',undefined],...inv.hooks.map(e=>[e.path,e.event])]);
    assert.deepEqual(c.sources[0].bytes,binary);
    assert.deepEqual(c.metadata.changes.map(e=>e.path).sort(),['binary','deleted','message','mode','pre1','pre2','prepare','tracked','untracked..file'].sort());
    assert.equal(c.metadata.changes.find(e=>e.path==='mode').after.mode,'100755');
    assert.equal(c.metadata.changes.find(e=>e.path==='deleted').after,null);
    assert.equal(c.candidate.artifacts[0].digest,byteDigest(binary));
    // Independently stage final workspace using the fixture's real Git, only after proving capture did not touch it.
    f.git('add','-A');const tree=f.git('write-tree').toString().trim();assert.equal(c.candidate.tree,tree);
    const diff=f.git('diff-tree','--no-commit-id','--no-ext-diff','--no-textconv','--no-renames','--binary','--full-index','--no-color','-p',f.input.base,tree,'--');
    assert.deepEqual(c.diff,diff);
    for(const e of c.objects) assert.deepEqual(f.git('cat-file',e.type,e.oid),e.bytes);
    const exported=exportWorkspace(c);
    // Returned buffers/metadata/expectations and caller inputs cannot mutate custody.
    c.diff.fill(0);c.objects[0].bytes.fill(0);c.sources[0].bytes.fill(0);c.metadata.binding.cycle='wrong';c.expected.candidate.paths.length=0;
    f.input.binding.cycle='wrong';f.input.permittedPaths.length=0;
    rmSync(f.root,{recursive:true,force:true});
    assert.deepEqual(verifyWorkspace(c,expected),expected);
    const restored=importWorkspace(exported,{expected});assert.deepEqual(restored.expected,expected);
    assert.deepEqual(restored.sources[0].bytes,binary);assert.deepEqual(restored.diff,diff);
    assert.deepEqual(exportWorkspace(restored),exported);
    assert.throws(()=>verifyWorkspace(c));assert.throws(()=>importWorkspace(exported));
    // Existing Candidate fields and content hashing remain directly consumable.
    assert.match(contentIdentity(c.candidate),/^[a-f0-9]{64}$/);
    const h='a'.repeat(64);
    const receipt={version:1,stage:'deliver',binding:{authority:h,grant:h,policy:h,core:h,runtime:h,
      instructions:h,repositoryId:'42',issueId:'I_95',scopeHash:h,shapeHash:h},
      execution:{role:'deliver',skill:'deliver',id:'deliver-95',request:'request',result:'result',source:null},
      inputs:{publication:h,candidate:c.candidate},
      result:{version:1,outcome:'ready',failureClass:'none',summary:'fixture',conflicts:[]}};
    assert.deepEqual(createEvidence({expected:receipt,consumed:[]}).inputs.candidate,c.candidate);
  } finally {f.close();}
});

test('coherence rejects declared-source and Git index changes during reads',()=>{
  for(const change of [f=>writeFileSync(join(f.root,'ignored'),'changed'),f=>f.git('add','tracked'),
    f=>writeFileSync(join(f.root,'tracked'),'changed'),f=>writeFileSync(join(f.root,'new-file'),'new')]) {
    const f=fixture(inv);
    try {assert.throws(()=>captureWorkspace({...f.input,afterRead:()=>change(f)}));} finally {f.close();}
  }
});

test('inventory and boundaries reject unsafe, missing, unreadable and unsupported declarations',()=>{
  for(const action of [f=>rmSync(join(f.root,'ignored')),f=>chmodSync(join(f.root,'ignored'),0),
    f=>{rmSync(join(f.root,'ignored'));symlinkSync('tracked',join(f.root,'ignored'));},
    f=>{rmSync(join(f.root,'ignored'));mkdirSync(join(f.root,'ignored'));},
    f=>{f.input.permittedPaths=f.input.permittedPaths.filter(p=>p!=='ignored');},
    f=>writeFileSync(join(f.root,'space name'),'unsupported'),
    f=>writeFileSync(Buffer.concat([Buffer.from(f.root+'/'),Buffer.from([255])]),'unsupported'),
    f=>{rmSync(join(f.root,'ignored'));execFileSync('mkfifo',[join(f.root,'ignored')]);},
    f=>{symlinkSync('tracked',join(f.root,'link'));f.input.permittedPaths.push('link');},
    f=>{f.git('update-index','--add','--cacheinfo','160000,'+f.input.base+',submodule');f.input.permittedPaths.push('submodule');}]) {
    const f=fixture(inv);try {action(f);assert.throws(()=>captureWorkspace(f.input));} finally {f.close();}
  }
  for(const inventory of [{artifacts:[{path:'../escape',purpose:'bad'}],hooks:[]},
    {artifacts:[],hooks:[{path:'pre1',event:'post-commit'}]},
    {artifacts:[],hooks:[{path:'pre1',event:'commit-msg'},{path:'pre2',event:'pre-commit'}]},
    {artifacts:[],hooks:[{path:'pre1',event:'pre-commit'},{path:'pre1',event:'pre-commit'}]}]) {
    const f=fixture();try {
      f.input.shapeBody='Candidate artifacts applicability: None.\nCandidate hooks applicability: None.\n```kairo-candidate\n'+JSON.stringify(inventory)+'\n```';
      f.input.binding.shapeHash=bodyDigest(f.input.shapeBody);assert.throws(()=>captureWorkspace(f.input));
    } finally {f.close();}
  }
  const f=fixture();try {assert.ok(captureWorkspace(f.input).candidate.emptyHooksReason);} finally {f.close();}
});

test('protected expectations reject fully recomputed forged identity and all material tampering',()=>{
  const f=fixture(inv);
  try {
    const c=captureWorkspace(f.input), expected=c.expected;
    for(const mutate of [v=>{v.metadata.binding.repository='other/public';},v=>{v.metadata.binding.cycle='other';},
      v=>{v.metadata.binding.policy='b'.repeat(64);},v=>{v.metadata.binding.scopeHash='b'.repeat(64);},
      v=>{v.metadata.binding.shapeHash='b'.repeat(64);},v=>{v.metadata.base='0'.repeat(40);},
      v=>{v.metadata.tree='0'.repeat(40);},v=>{v.metadata.changes[0].after.mode='100755';},
      v=>{v.diff=Buffer.from('forged').toString('base64');},v=>{v.sources[0].data='AQ==';},
      v=>{v.sources[1].event='commit-msg';},v=>{[v.sources[1],v.sources[2]]=[v.sources[2],v.sources[1]];},
      v=>{v.objects[0].data='AQ==';}]) {
      const v=wire(c);mutate(v);assert.throws(()=>importWorkspace(pack(v),{expected}));
    }
    // A legitimate second capture recomputes every internal object/diff/content identity.
    // Submitting its internally consistent bytes against the first protected expectation must fail.
    writeFileSync(join(f.root,'tracked'),'attacker replacement');writeFileSync(join(f.root,'ignored'),'forged artifact');
    const forged=captureWorkspace(f.input);
    assert.notEqual(forged.expected.identity,expected.identity);
    assert.throws(()=>importWorkspace(exportWorkspace(forged),{expected}));
    assert.deepEqual(importWorkspace(exportWorkspace(forged),{expected:forged.expected}).expected,forged.expected);
  } finally {f.close();}
});

test('bounded canonical transfer rejects malformed, duplicate, extra, missing and unsafe entries',()=>{
  const f=fixture(inv);
  try {
    const c=captureWorkspace(f.input), bytes=exportWorkspace(c), expected=c.expected, v=wire(c);
    const all=[...c.objects,...c.sources,{bytes:c.diff}];
    const limits={entries:all.length,payloadBytes:Math.max(...all.map(e=>e.bytes.length)),
      totalBytes:all.reduce((n,e)=>n+e.bytes.length,0),serializedBytes:bytes.length};
    assert.deepEqual(importWorkspace(exportWorkspace(c,{limits}),{expected,limits}).expected,expected);
    for(const key of Object.keys(limits)) {
      const smaller={...limits,[key]:limits[key]-1};
      assert.throws(()=>exportWorkspace(c,{limits:smaller}));assert.throws(()=>importWorkspace(bytes,{expected,limits:smaller}));
    }
    for(const mutate of [w=>{w.version=2;},w=>{w.objects.push(w.objects[0]);},w=>{w.objects.pop();},
      w=>{w.sources.pop();},w=>{w.sources.push(w.sources[0]);},w=>{w.sources[0].path='../escape';},
      w=>{w.sources[0].path='/absolute';},w=>{w.sources[0].mode='120000';},w=>{w.objects[0].type='tag';},
      w=>{w.diff='***';},w=>{w.extra=true;}]) {
      const w=structuredClone(v);mutate(w);assert.throws(()=>importWorkspace(pack(w),{expected}));
    }
    assert.throws(()=>importWorkspace(bytes.subarray(0,-1),{expected}));
    assert.throws(()=>importWorkspace(Buffer.from('{"version":1,"version":1}'),{expected}));
    assert.throws(()=>captureWorkspace({...f.input,limits:{entries:1}}));
  } finally {f.close();}
});


test('ambient hooks, clean filters and external diff commands never execute',()=>{
  const f=fixture();
  try {
    const marker=join(f.root,'EXECUTED');
    const command='touch '+marker;
    f.git('config','filter.untrusted.clean',command);
    f.git('config','filter.untrusted.required','true');
    f.git('config','diff.external',command);
    writeFileSync(join(f.root,'.gitattributes'),'tracked filter=untrusted diff=untrusted\n');
    writeFileSync(join(f.root,'.git/hooks/pre-commit'),'#!/bin/sh\n'+command+'\n');
    chmodSync(join(f.root,'.git/hooks/pre-commit'),0o755);
    f.input.permittedPaths.push('.gitattributes');
    const c=captureWorkspace(f.input);
    assert.equal(existsSync(marker),false);
    assert.deepEqual(importWorkspace(exportWorkspace(c),{expected:c.expected}).expected,c.expected);
    assert.equal(existsSync(marker),false);
  } finally {f.close();}
});
