// Credential-free adapter contracts using production builders and a real MCP
// stdio subprocess. Synthetic Docker observations are not host/model E2E proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline';
import {codexFixture} from '../tooling/codex-fixture.mjs';
import {createGithubReadService} from '../src/agent-gh-read.mjs';
import {claudeInvocation} from '../src/claude-entry.mjs';
import {geminiPolicy,geminiRoleSettings} from '../src/gemini-entry.mjs';

async function client(t,module,options) {
  const script=join(options.scratch,'mcp-bootstrap.mjs');
  writeFileSync(script,`import {createReadonlyTools,serveReadonlyTools} from ${JSON.stringify(pathToFileURL(module).href)};await serveReadonlyTools({invoke:await createReadonlyTools(${JSON.stringify({...options,secrets:['LOGIN-SENTINEL']})})});`);
  const child=spawn(process.execPath,[script],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,ANTHROPIC_API_KEY:'',GEMINI_API_KEY:''}});
  let stderr='';child.stderr.on('data',b=>stderr+=b);const messages=new Map();let seq=0;
  const lines=createInterface({input:child.stdout});lines.on('line',line=>{const value=JSON.parse(line);const waiter=messages.get(value.id);if(waiter){messages.delete(value.id);waiter.resolve(value);}});
  child.once('exit',()=>{for(const waiter of messages.values())waiter.reject(Error('MCP closed: '+stderr));messages.clear();});
  t.after(async()=>{if(child.exitCode===null){child.stdin.end();await once(child,'exit');}lines.close();assert.equal(stderr,'');});
  return {
    notify(method,params){child.stdin.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\n');},
    call(method,params){const id=++seq;return {id,promise:new Promise((resolve,reject)=>{messages.set(id,{resolve,reject});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');})};},
    close(){child.stdin.end();return once(child,'exit');}
  };
}
const text=response=>JSON.parse(response.result.content[0].text);
const waitFile=async path=>{for(let n=0;n<300;n++){if(existsSync(path))return;await new Promise(r=>setTimeout(r,10));}throw Error('child did not start');};

for(const agent of ['claude','gemini'])test(`${agent}: read-only backend exposes callable guarded verification and authorized reads`,async t=>{
  const f=codexFixture('accept',undefined,agent);t.after(()=>f.dispose());
  assert.equal((await f.life.start(f.input)).start.status,'started');
  const command=f.calls.find(c=>c.args[2]==='create'&&c.args.at(-1)==='execute');
  const mounts=command.args.flatMap((v,i)=>v==='--mount'?[command.args[i+1]]:[]);
  const source=target=>mounts.find(v=>v.includes('dst='+target+',')).match(/src=([^,]+)/)[1];
  assert.ok(mounts.find(v=>v.includes('dst=/work,')).endsWith(',readonly'));
  assert.ok(mounts.find(v=>v.includes('dst=/readonly-tools.mjs,')).endsWith(',readonly'));
  const input=source('/input'),request=JSON.parse(readFileSync(join(input,'request.json')));
  let server;
  if(agent==='claude') {
    const invocation=claudeInvocation(request,'{}','LOGIN-SENTINEL');
    const arg=key=>invocation.args[invocation.args.indexOf(key)+1];
    server=JSON.parse(arg('--mcp-config')).mcpServers.nibfin;
    assert.equal(arg('--tools'),'Read,Glob,Grep');assert.equal(arg('--disallowedTools'),'Edit,Write,Bash');
    for(const tool of ['verify','github_read'])assert.ok(arg('--allowedTools').split(',').includes('mcp__nibfin__'+tool));
    assert.ok(invocation.args.includes('--strict-mcp-config'));
  } else {
    const settings=JSON.parse(readFileSync(join(input,'gemini-settings.json')));
    server=settings.mcpServers.nibfin;assert.equal(settings.admin.mcp.enabled,true);
    assert.deepEqual(Object.keys(settings.mcpServers),['nibfin']);
    const policy=readFileSync(join(input,'gemini-policy.toml'),'utf8');
    assert.equal(policy,geminiPolicy('read'));assert.doesNotMatch(policy,/run_shell_command|write_file|replace/);
    for(const tool of ['verify','github_read'])assert.ok(policy.includes('mcpName = "nibfin"\ntoolName = "'+tool+'"\ndecision = "allow"'));
  }
  assert.equal(server.command,'/usr/local/bin/node');assert.deepEqual(server.args,['/readonly-tools.mjs']);
  assert.equal(server.env.ANTHROPIC_API_KEY,'');assert.equal(server.env.GEMINI_API_KEY,'');
  // A separate scratch parent keeps the original Candidate outside writable cwd.
  const utilityRoot=mkdtempSync(join(tmpdir(),'nibfin-mcp-'));t.after(()=>rmSync(utilityRoot,{recursive:true,force:true}));
  const retained=join(utilityRoot,'commands'),writable=join(utilityRoot,'scratch');mkdirSync(retained);mkdirSync(writable);
  const broker=createGithubReadService({repositories:['public-owner/project'],run:async(file,args)=>({stdout:args[0]==='api'?JSON.stringify({full_name:'public-owner/project',private:false}):'{"number":230}'})});
  const socket=join(utilityRoot,'read.sock');await new Promise(r=>broker.listen(socket,r));t.after(()=>new Promise(r=>broker.close(r)));
  const c=await client(t,source(server.args[0]),{input,directory:retained,scratch:writable,socket});
  const initialized=await c.call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:agent+'-contract',version:'1'}}).promise;
  assert.equal(initialized.result.protocolVersion,'2024-11-05');c.notify('notifications/initialized',{});
  assert.deepEqual((await c.call('tools/list').promise).result.tools.map(v=>v.name),['verify','github_read']);
  const verify=args=>c.call('tools/call',{name:'verify',arguments:{file:process.execPath,cwd:writable,args}});
  const passed=text(await verify(['-e','console.log("real verification"); if(process.env.ANTHROPIC_API_KEY||process.env.GEMINI_API_KEY||process.env.GH_TOKEN)process.exit(9)']).promise);
  assert.equal(passed.status,'passed');assert.match(passed.log,/real verification/);assert.equal(JSON.parse(readFileSync(passed.receiptPath)).status,'passed');
  assert.equal(passed.execution,request.verificationPolicy.budget.execution);
  const failed=await verify(['-e','console.log(String.fromCharCode(76,79,71,73,78,45,83,69,78,84,73,78,69,76));process.exit(7)']).promise;
  assert.equal(failed.result.isError,true);assert.equal(text(failed).exitCode,7);assert.doesNotMatch(JSON.stringify(failed),/LOGIN-SENTINEL/);
  const gh=args=>c.call('tools/call',{name:'github_read',arguments:{args}}).promise;
  assert.equal((await gh(['issue','view','230','--repo','public-owner/project'])).result.content[0].text,'{"number":230}');
  for(const args of [['pr','merge','1','--repo','public-owner/project'],['issue','view','1','--repo','unknown/private'],['api','repos/public-owner/project/issues','-X','POST']])assert.equal((await gh(args)).result.isError,true);
  const denied=await c.call('tools/call',{name:'verify',arguments:{file:process.execPath,args:['-e','throw Error()'],cwd:source('/work')}}).promise;
  assert.equal(denied.result.isError,true);
  symlinkSync(source('/work'),join(writable,'candidate-link'));
  assert.equal((await c.call('tools/call',{name:'verify',arguments:{file:process.execPath,args:[],cwd:join(writable,'candidate-link')}}).promise).result.isError,true);
  assert.equal((await c.call('tools/call',{name:'shell',arguments:{args:[]}}).promise).result.isError,true);
  const marker=join(writable,'started');
  const running=verify(['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000)`]);await waitFile(marker);
  const busy=text(await verify(['-e','throw Error("must not run")']).promise);assert.equal(busy.status,'busy');
  c.notify('notifications/cancelled',{requestId:running.id});const cancelled=text(await running.promise);assert.equal(cancelled.status,'cancelled');
  assert.equal(existsSync(join(retained,'active.lock')),false);
  assert.equal(text(await verify(['-e','']).promise).status,'passed');
  const exhausted=await c.call('tools/call',{name:'verify',arguments:{file:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:writable,timeoutMs:25}}).promise;
  assert.equal(exhausted.result.isError,true);assert.equal(text(exhausted).status,'budget_exhausted');
  assert.ok(text(exhausted).deadlineAt<=request.verificationPolicy.budget.stopVerificationAt);
  assert.equal((await c.call('tools/call',{name:'verify',arguments:{file:process.execPath,args:[],cwd:writable,env:{GH_TOKEN:'bad'}}}).promise).result.isError,true);
  const eofMarker=join(writable,'eof-started');
  const ending=verify(['-e',`process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(eofMarker)},String(process.pid));setInterval(()=>{},1000)`]);
  const endingResult=ending.promise.catch(()=>null);await waitFile(eofMarker);const owned=Number(readFileSync(eofMarker));
  await c.close();await endingResult;assert.throws(()=>process.kill(owned,0),{code:'ESRCH'});
  assert.equal(existsSync(join(retained,'active.lock')),false);
  const receipts=readdirSync(retained).filter(v=>v.endsWith('.json')).map(v=>JSON.parse(readFileSync(join(retained,v))));
  assert.equal(receipts.length,6);assert.equal(receipts.filter(v=>v.status==='cancelled').length,2);
  assert.equal((await f.collect()).result.status,'valid');await f.life.termination(f.input.execution.id);assert.equal((await f.life.cleanup()).status,'completed');
});

test('read-only MCP policies preserve writer behavior and reject unknown access',()=>{
  assert.deepEqual(geminiRoleSettings('write').mcpServers,{});assert.equal(geminiRoleSettings('write').admin.mcp.enabled,false);
  assert.throws(()=>geminiRoleSettings('invalid'));
  const invocation=claudeInvocation({access:'write',prompt:'task',timeout:1000},'{}','key');
  assert.equal(JSON.parse(invocation.args[invocation.args.indexOf('--mcp-config')+1]).mcpServers.nibfin,undefined);
});
