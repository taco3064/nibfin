import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,access} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

test('private workflows cannot allocate GitHub-hosted runners and Core CI is removed',async()=>{
 await assert.rejects(access('.github/workflows/ci.yml'),{code:'ENOENT'});
 for(const file of await readdir('.github/workflows')){
  if(!/\.ya?ml$/.test(file))continue;
  const source=await readFile('.github/workflows/'+file,'utf8');
  const runners=[...source.matchAll(/^\s*runs-on:\s*(.+)$/gm)];assert.ok(runners.length,file);
  for(const [,runner]of runners)assert.match(runner,/^\[self-hosted,/,file+' must use local runners');
  const schedules=[...source.matchAll(/^\s*(?:-\s*)?(schedule|cron):[^\S\r\n]*(.*)$/gm)].map(([,key,value])=>[key,value.trim()]);
  assert.deepEqual(schedules,[],file+' must remain event-driven');
 }
});

async function handoff(hints,attempt='1'){
 const source=await readFile('.github/workflows/action-stage.yml','utf8');
 const script=source.split('  handoff:')[1].match(/node <<'NODE'\r?\n([\s\S]*?)\r?\n\s*NODE/)[1];
 const calls=[],errors=[],process={env:{HANDOFFS:JSON.stringify(hints),GITHUB_RUN_ATTEMPT:attempt},exitCode:0};
 await runInNewContext(script,{process,console:{error:m=>errors.push(m)},require:name=>{
  assert.equal(name,'node:child_process');return{execFileSync:(command,args,options)=>{calls.push({command,args,body:JSON.parse(options.input)});return '';}};
 }});
 return{calls,errors,exitCode:process.exitCode};
}

test('local handoff uses the logged-in gh for private and participant dispatches',async()=>{
 const hints=[{repository:'taco3064/kairo',workflow:'action-stage.yml',ref:'main',requestId:'a'.repeat(64),issueRef:'nibfin#229'},
  {repository:'taco3064/nibfin',workflow:'kairo.yml',ref:'main',requestId:'b'.repeat(64),issueId:'I_example'}];
 const result=await handoff(hints);assert.deepEqual(result.errors,[]);assert.equal(result.calls.length,2);
 for(let n=0;n<hints.length;n++){
  const call=result.calls[n],hint=hints[n];assert.equal(call.command,'gh');
  assert.deepEqual(Array.from(call.args),['api','--method','POST','/repos/'+hint.repository+'/actions/workflows/'+hint.workflow+'/dispatches','--input','-']);
  assert.deepEqual(call.body,{ref:'main',inputs:{request_id:hint.requestId,...(hint.issueId?{issue_id:hint.issueId}:{}),...(hint.issueRef?{issue_ref:hint.issueRef}:{})}});
 }
});

test('local handoff rejects foreign targets and never repeats dispatches on rerun',async()=>{
 for(const [hints,attempt]of[[[{repository:'other/repo',workflow:'kairo.yml',ref:'main',requestId:'a'.repeat(64),issueId:'I_foreign'}],'1'],
  [[{repository:'taco3064/kairo',workflow:'action-stage.yml',ref:'main',requestId:'a'.repeat(64)}],'2']]){
  const result=await handoff(hints,attempt);assert.equal(result.exitCode,1);assert.equal(result.calls.length,0);assert.equal(result.errors.length,1);
 }
});
