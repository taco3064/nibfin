import test from 'node:test';
import assert from 'node:assert/strict';
import{mkdtemp,readFile,access,rm}from'node:fs/promises';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{spawn}from'node:child_process';
import{verificationBudget,validateBudget,runVerification}from'../src/verification-runner.mjs';
import{CodexAgent}from'../src/agent.mjs';

async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'nibfin-verification-'));t.after(()=>rm(directory,{recursive:true,force:true}));return{directory,budget:verificationBudget(15000),stdout:null,stderr:null,killGraceMs:40};}
async function waitFile(path){for(let n=0;n<200;n++){try{await access(path);return;}catch{}await new Promise(r=>setTimeout(r,10));}throw Error('Fixture did not start');}
test('budget reserves five minutes without changing the exact Agent timeout',()=>{
 const b=verificationBudget(3600000,1000);assert.equal(b.deadlineAt,3601000);assert.equal(b.stopVerificationAt,3301000);assert.equal(b.reserveMs,300000);validateBudget(b);
 assert.throws(()=>validateBudget({...b,stopVerificationAt:b.deadlineAt}));assert.throws(()=>verificationBudget(0));assert.throws(()=>verificationBudget(Infinity));
});
test('successful and failing real commands persist truthful isolated receipts and logs',async t=>{
 const o=await fixture(t),passed=await runVerification(process.execPath,['-e','console.log("real output")'],o);assert.equal(passed.status,'passed');assert.equal(passed.exitCode,0);assert.match(await readFile(passed.logPath,'utf8'),/real output/);assert.equal(JSON.parse(await readFile(passed.receiptPath,'utf8')).status,'passed');
 const failed=await runVerification(process.execPath,['-e','console.error("expected failure");process.exit(7)'],o);assert.equal(failed.status,'failed');assert.equal(failed.exitCode,7);assert.match(await readFile(failed.logPath,'utf8'),/expected failure/);
});
test('overlap is rejected before spawning; sequential reuse succeeds',async t=>{
 const o=await fixture(t),marker=join(o.directory,'started'),forbidden=join(o.directory,'must-not-exist');
 const first=runVerification(process.execPath,['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'started');setTimeout(()=>{},500)`],o);await waitFile(marker);
 const second=await runVerification(process.execPath,['-e',`require('fs').writeFileSync(${JSON.stringify(forbidden)},'bad')`],o);assert.equal(second.status,'busy');assert.equal(second.exitCode,75);await assert.rejects(access(forbidden));assert.equal((await first).status,'passed');assert.equal((await runVerification(process.execPath,['-e',''],o)).status,'passed');
});
test('expired budget refuses new work rather than inventing a successful check',async t=>{
 const o=await fixture(t),marker=join(o.directory,'must-not-start');o.budget=verificationBudget(1000,Date.now()-2000);
 const result=await runVerification(process.execPath,['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`],o);assert.equal(result.status,'budget_exhausted');assert.equal(result.exitCode,124);await assert.rejects(access(marker));
});
test('budget expiration terminates a running command and frees the lane',async t=>{
 const o=await fixture(t);o.budget=verificationBudget(1000);
 const result=await runVerification(process.execPath,['-e','setInterval(()=>{},1000)'],o);assert.equal(result.status,'budget_exhausted');assert.equal(result.exitCode,124);await assert.rejects(access(join(o.directory,'active.lock')));
});
test('explicit cancellation records failure and terminates a running subprocess',async t=>{
 const o=await fixture(t),controller=new AbortController(),marker=join(o.directory,'cancel-start');
 const running=runVerification(process.execPath,['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'yes');setInterval(()=>{},1000)`],{...o,signal:controller.signal});await waitFile(marker);controller.abort();const result=await running;assert.equal(result.status,'cancelled');assert.equal(result.exitCode,130);await assert.rejects(access(join(o.directory,'active.lock')));
});
test('spawn errors are failed evidence and release the lane',async t=>{
 const o=await fixture(t),result=await runVerification('nibfin-nonexistent-test-executable',[],o);assert.equal(result.status,'spawn_failed');assert.equal(result.errorCode,'ENOENT');assert.equal(result.exitCode,1);await assert.rejects(access(join(o.directory,'active.lock')));
});

test('a real closed output pipe records EPIPE, stops the command and releases the lane',{skip:process.platform==='win32'},async t=>{
 const o=await fixture(t),helper=new URL('../src/verification-runner.mjs',import.meta.url).href;
 const code=`import{runVerification}from ${JSON.stringify(helper)};const receipt=await runVerification(process.execPath,['-e','setInterval(()=>console.log("output"),10)'],${JSON.stringify({...o,stdout:undefined,stderr:undefined})});console.error(JSON.stringify(receipt));`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});
 let errorLog='';child.stderr.on('data',b=>{errorLog+=b;});child.stdout.once('data',()=>child.stdout.destroy());
 const codeExit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(codeExit,0);
 const receipt=JSON.parse(errorLog.trim());assert.equal(receipt.status,'output_error');assert.equal(receipt.exitCode,74);assert.equal(receipt.errorCode,'EPIPE');
 await assert.rejects(access(join(o.directory,'active.lock')));assert.match(await readFile(receipt.logPath,'utf8'),/output/);
 assert.equal((await runVerification(process.execPath,['-e',''],o)).status,'passed');
});
test('cancellation kills the normal descendant group before releasing ownership',{skip:process.platform==='win32'},async t=>{
 const o=await fixture(t),controller=new AbortController(),ready=join(o.directory,'group-ready'),escaped=join(o.directory,'escaped');
 const childCode=`process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(escaped)},'bad'),700);setInterval(()=>{},1000)`;
 const parentCode=`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit'});setInterval(()=>{},1000)`;
 const pending=runVerification(process.execPath,['-e',parentCode],{...o,signal:controller.signal});await waitFile(ready);controller.abort();assert.equal((await pending).status,'cancelled');
 await new Promise(r=>setTimeout(r,800));await assert.rejects(access(escaped));await assert.rejects(access(join(o.directory,'active.lock')));
});
test('Agent mounts only the single credential-free helper read-only and retains read-only review',()=>{
 const a=new CodexAgent({image:'sha256:'+'a'.repeat(64),network:'restricted',user:'1000:1000',authDirectory:'/auth'},'/private/core','/state');const args=a.executionArgs('/candidate','/io',false);assert(args.some(s=>s.includes('src=')&&s.endsWith('verification-runner.mjs,dst=/verification-runner.mjs,readonly')));assert(args.some(s=>s.endsWith('dst=/work,readonly')));assert(!args.some(s=>s.endsWith('dst=/private/core')));
});
