// Adapted upstream exact-copy/fresh-install negatives using the maintained lane.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,chmodSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareNodeVerification,nodeSourceIdentity,preparedCommandInputs} from '../src/node-verification.mjs';
import {runVerification,verificationBudget} from '../src/verification-runner.mjs';
function fixture(t) {
 const root=mkdtempSync(join(tmpdir(),'nibfin-prepared-')),source=join(root,'source'),scratch=join(root,'scratch');
 mkdirSync(source);mkdirSync(scratch);t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(join(source,'package.json'),'{}');writeFileSync(join(source,'package-lock.json'),'{}');
 writeFileSync(join(source,'code.mjs'),'export const answer=42;');chmodSync(join(source,'code.mjs'),0o755);
 const lane={budget:{require:()=>10000},command:async()=>({status:'passed'})};return {root,source,scratch,lane};
}
test('exact mode/bytes, excluded Git/modules, fresh caches and independent copies survive preparation',async t=>{
 const f=fixture(t),before=nodeSourceIdentity(f.source).identity;
 mkdirSync(join(f.source,'.git'));writeFileSync(join(f.source,'.git','config'),'excluded');
 mkdirSync(join(f.source,'node_modules'));writeFileSync(join(f.source,'node_modules','stale'),'excluded');
 const a=await prepareNodeVerification(f),b=await prepareNodeVerification(f);
 assert.equal(a.status,'prepared');assert.equal(b.status,'prepared');assert.notEqual(a.directory,b.directory);assert.notEqual(a.cache,b.cache);
 assert.equal(nodeSourceIdentity(f.source).identity,before);assert.equal(nodeSourceIdentity(a.directory).identity,before);
 assert.equal(existsSync(join(a.directory,'.git')),false);assert.equal(existsSync(join(a.directory,'node_modules')),false);
 const inputs=preparedCommandInputs(a.cwd);assert.equal(inputs.source,before);
 writeFileSync(join(a.cache,'new-entry'),'new bytes');assert.notEqual(preparedCommandInputs(a.cwd).cache,inputs.cache);
 chmodSync(join(a.directory,'code.mjs'),0o600);assert.throws(()=>preparedCommandInputs(a.cwd),/modified-copy/);
});
test('copied source mutation during dependency install cannot yield prepared success',async t=>{
 const f=fixture(t);f.lane.command=async input=>{writeFileSync(join(input.cwd,'code.mjs'),'modified');return {status:'passed'};};
 await assert.rejects(prepareNodeVerification(f),/source-changed/);
});
test('CLI runner rejects stale or modified prepared input without executing the requested command',async t=>{
 for(const mode of ['stale','modified']){
  const f=fixture(t),p=await prepareNodeVerification(f),marker=join(f.root,'executed');
  writeFileSync(join(mode==='stale'?f.source:p.directory,'code.mjs'),'changed');
  await assert.rejects(runVerification(process.execPath,['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`],
   {directory:join(f.root,'lane'),budget:verificationBudget(10000),cwd:p.cwd,stdout:null,stderr:null}),/stale-copy|modified-copy/);
  assert.equal(existsSync(marker),false);assert.equal(existsSync(join(f.root,'lane','active.lock')),true,'failure retains lane ownership');
 }
});

test('Core-prepared host manifests validate through the fixed container mount mapping',async t=>{
 const f=fixture(t),p=await prepareNodeVerification(f),work=join(p.directory,'..');
 const manifest=join(work,'prepared.json'),stored=JSON.parse(readFileSync(manifest));
 // The process sees mounted paths; the manifest retains the host namespace.
 const hostSource='/host-owned/candidate',hostWork='/host-owned/verification/prepared';
 writeFileSync(manifest,JSON.stringify({...stored,source:hostSource,directory:hostWork+'/source',cache:hostWork+'/cache'}));
 assert.throws(()=>preparedCommandInputs(p.cwd),/preparation-manifest/);
 const pathMappings=[{from:hostSource,to:f.source},{from:hostWork,to:work}];
 assert.equal(preparedCommandInputs(p.cwd,{pathMappings}).source,p.sourceIdentity);
 const marker=join(f.root,'mapped-command');
 const result=await runVerification(process.execPath,['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'ok')`],
  {directory:join(f.root,'mapped-lane'),budget:verificationBudget(10000),cwd:p.cwd,pathMappings,stdout:null,stderr:null});
 assert.equal(result.status,'passed');assert.equal(readFileSync(marker,'utf8'),'ok');
 writeFileSync(join(f.source,'code.mjs'),'changed original');
 assert.throws(()=>preparedCommandInputs(p.cwd,{pathMappings}),/stale-copy/);
});
