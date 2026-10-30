import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import{prepareCodexCredentials,initializeCodexCredentials,stageCodexCredentials}from'../src/codex-credentials.mjs';
const token=(seconds,account='fixture-member')=>JSON.stringify({auth_mode:'chatgpt',tokens:{account_id:account,
 access_token:'fixture.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+seconds})).toString('base64url')+'.fixture',refresh_token:'SYNTHETIC-REFRESH',id_token:'SYNTHETIC-ID'}});
async function fixture(fn){const root=fs.mkdtempSync(join(tmpdir(),'nibfin-credential-test-')),login=join(root,'login');fs.mkdirSync(login,{mode:0o700});
 const auth=join(login,'auth.json');fs.writeFileSync(auth,token(-10),{mode:0o600});const owners=[];
 const prepare=async(n,deadlineAt=Date.now()+60000)=>{const work=join(root,n);fs.mkdirSync(work,{mode:0o700});const owner=await prepareCodexCredentials({login:auth,root:work,execution:n,deadlineAt});owners.push(owner);return owner;};
 try{await fn({root,login,auth,prepare});}finally{for(const o of owners)await o.settle({successful:true});fs.rmSync(root,{recursive:true,force:true});}}

test('CLI writable copy refresh is saved after termination, even when the model task failed',async()=>fixture(async f=>{
 const original=fs.readFileSync(f.auth),owner=await f.prepare('role'),target=join(f.root,'client/auth.json');owner.markLaunched();
 const selected=initializeCodexCredentials({source:owner.source,target});assert(selected.equals(original));
 const next=token(86400);fs.writeFileSync(target,next);assert(fs.readFileSync(f.auth).equals(original));
 assert.equal(stageCodexCredentials(selected,{target,output:owner.output}),true);
 const result=await owner.settle({successful:false});assert.equal(result.status,'completed');assert.equal(fs.readFileSync(f.auth,'utf8'),next);
 assert.equal(fs.statSync(f.auth).mode&0o777,0o600);assert.equal(fs.existsSync(join(f.login,'codex-credential-intent.json')),false);
}));

test('expiring login has one refresh owner; fresh login permits parallel roles',async()=>fixture(async f=>{
 const first=await f.prepare('first');first.markLaunched();
 await assert.rejects(f.prepare('second'),/reconciliation-required|refresh-busy/);
 assert.equal((await first.settle({successful:true})).status,'completed');
 fs.writeFileSync(f.auth,token(86400));const a=await f.prepare('fresh-a'),b=await f.prepare('fresh-b');a.markLaunched();b.markLaunched();
 assert.equal(fs.existsSync(join(f.login,'codex-credential-intent.json')),false);
 assert.equal((await a.settle({successful:false})).status,'completed');assert.equal((await b.settle({successful:false})).status,'completed');
}));

test('unknown refresh outcome retains its journal and blocks another execution',async()=>fixture(async f=>{
 const owner=await f.prepare('unknown');owner.markLaunched();assert.equal((await owner.settle()).status,'unresolved');
 assert.equal(owner.unresolved(),true);assert(fs.existsSync(join(f.login,'codex-credential-intent.json')));
 await assert.rejects(f.prepare('retry'),/reconciliation-required/);
}));

test('wrong account and a concurrent current login change preserve both credentials for reconciliation',async()=>{
 for(const change of ['account','current'])await fixture(async f=>{
  const original=fs.readFileSync(f.auth),owner=await f.prepare('role'),target=join(f.root,'client/auth.json');owner.markLaunched();
  initializeCodexCredentials({source:owner.source,target});fs.writeFileSync(target,token(86400,change==='account'?'other-member':'fixture-member'));
  stageCodexCredentials(original,{target,output:owner.output});if(change==='current')fs.writeFileSync(f.auth,token(172800));const before=fs.readFileSync(f.auth);
  assert.equal((await owner.settle({successful:true})).status,'unresolved');assert(fs.readFileSync(f.auth).equals(before));
  assert(fs.existsSync(join(owner.output,'auth.json')));assert(fs.existsSync(join(f.login,'codex-credential-intent.json')));
 });
});

test('unknown update entries and symlink sources never become current credentials',async()=>fixture(async f=>{
 const original=fs.readFileSync(f.auth),owner=await f.prepare('role');fs.writeFileSync(join(owner.output,'unknown'),'untrusted');
 assert.equal((await owner.settle({successful:true})).status,'unresolved');assert(fs.readFileSync(f.auth).equals(original));
 const destination=join(f.root,'link');fs.symlinkSync(f.auth,destination);
 assert.throws(()=>initializeCodexCredentials({source:destination,target:join(f.root,'client/auth.json')}));
}));
