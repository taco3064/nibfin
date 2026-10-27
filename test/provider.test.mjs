import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {createGithubProvider, localGhTransport, parseGithubJson, publicDiagnostic} from '../src/index.mjs';

const base = {endpoint:'/repos/Example-Org/core/issues/1', target:'42', operation:'issue', correlation:'attempt-1'};
const response = (status = 200, body = '{"id":42}', headers = {}) => ({status, body, headers});
function fixture(replies, config = {}) {
  const calls = [], waits = [];
  let time = 0;
  const provider = createGithubProvider({now:() => time, delay:async ms => {waits.push(ms); time += ms;},
    transport:async request => {calls.push(request); const next = replies.shift(); if (next instanceof Error) throw next; return next;}, ...config});
  return {provider, calls, waits};
}

test('imports are inert even when process and network entry points reject calls', () => {
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import child from 'node:child_process'; import https from 'node:https'; import http from 'node:http';
    import {syncBuiltinESMExports} from 'node:module';
    const reject = () => {throw Error('Unexpected import side effect');};
    child.spawn = child.exec = child.execFile = https.request = http.request = reject;
    syncBuiltinESMExports();
    await import(${JSON.stringify(new URL('../src/index.mjs', import.meta.url).href)});
  `]);
});

test('exact identities, original order, requested identity and malformed rejection', async () => {
  const data = parseGithubJson('{"id":9007199254740993,"node_id":"I_abc","assignees":[{"id":2},{"id":1}]}');
  assert.equal(data.id, '9007199254740993');
  assert.deepEqual(data.assignees.map(a => a.id), ['2', '1']);
  for (const value of ['0','-1','1.2','1e50','1.0000000000000001','1e3','"01"','true','{}']) assert.throws(() => parseGithubJson(`{"id":${value}}`));
  assert.throws(() => parseGithubJson('{"id":'));
  for (const body of ['{}','{"id":43}','{"id":null}']) {
    const f = fixture([response(200, body)]);
    assert.equal((await f.provider.request({...base, expectedId:'42'})).diagnostic.kind, 'malformed');
  }
  for (const owner of ['person','Example-Org']) {
    const f = fixture([response()]);
    assert.equal((await f.provider.request({...base, endpoint:`/repos/${owner}/core`, expectedId:'42'})).outcome, 'read');
  }
});

test('complete array and envelope traversals and empty collection', async () => {
  for (const envelope of [undefined, 'runners']) {
    const replies = [1,2,3].map(page => response(200,
      JSON.stringify(envelope ? {[envelope]:[{id:String(page)}]} : [{id:String(page)}]),
      page < 3 ? {link:`<https://api.github.com/repos/org/core/actions/runners?page=${page+1}>; rel="next"`} : {}));
    const f = fixture(replies);
    const result = await f.provider.collection({...base, envelope});
    assert.equal(result.outcome, 'complete');
    assert.deepEqual(result.data.map(v => v.id), ['1','2','3']);
    assert.equal(f.calls.length, 3);
  }
  for (const body of ['[]','[{"id":42}]']) {
    const f = fixture([response(200, body)]);
    assert.equal((await f.provider.collection(base)).outcome, 'complete');
  }
});

test('real repository metadata opaque IDs do not invalidate numeric GitHub identities',()=>{
 const data=parseGithubJson('{"id":9007199254740993,"owner":{"id":127829492,"gravatar_id":""},"license":{"key":"mit","spdx_id":"MIT"}}');
 assert.equal(data.id,'9007199254740993');assert.equal(data.owner.id,'127829492');
 assert.equal(data.owner.gravatar_id,'');assert.equal(data.license.spdx_id,'MIT');
 const run=parseGithubJson(JSON.stringify({id:40427623781,runner_group_id:0,check_suite_id:109573840467,
  check_suite_node_id:'CS_kwDOVRsWxs8AAAAZgyEeUw',external_id:'48e5a7ee-5963-5ab6-8c1f-a3cfe90df5e5',
  app:{id:15368,client_id:'Iv1.05c79e9ad1f6bdfa'},head_commit:{id:'6d9904909ca604363ef2c4f97fc59fd3e73193e7',tree_id:'3312ad32f9bab61f6b0b234597b1b2278c83782e'}}));
 assert.equal(run.id,'40427623781');assert.equal(run.app.id,'15368');
 assert.equal(run.runner_group_id,'0');
 assert.equal(run.app.client_id,'Iv1.05c79e9ad1f6bdfa');assert.equal(run.check_suite_node_id,'CS_kwDOVRsWxs8AAAAZgyEeUw');
 assert.equal(run.head_commit.id,'6d9904909ca604363ef2c4f97fc59fd3e73193e7');
 assert.equal(run.external_id,'48e5a7ee-5963-5ab6-8c1f-a3cfe90df5e5');
 assert.throws(()=>parseGithubJson('{"owner":{"id":"01","gravatar_id":""}}'));
 assert.throws(()=>parseGithubJson('{"check_suite_id":"01"}'));
 assert.throws(()=>parseGithubJson('{"id":0}'));
 assert.throws(()=>parseGithubJson('{"check_suite_node_id":"invalid!"}'));
});

test('no partial collection escapes a later failure, hostile link, cycle or page budget', async () => {
  const link = '<https://api.github.com/repos/org/core?page=2>; rel="next"';
  for (const second of [response(403), response(200,'{'), response(200,'{}'), response(200,'[{}]')]) {
    const f = fixture([response(200,'[{"id":1}]',{link}), second]);
    const result = await f.provider.collection(base);
    assert.equal(result.outcome, 'incomplete'); assert.equal(result.data, undefined);
  }
  for (const next of ['https://evil.example/x','https://secret@api.github.com/x', 'https://api.github.com/x%0a',
    'https://api.github.com/x#secret', 'not-a-url']) {
    const f = fixture([response(200,'[]',{link:`<${next}>; rel="next"`})]);
    assert.equal((await f.provider.collection(base)).outcome, 'incomplete'); assert.equal(f.calls.length,1);
  }
  const f = fixture([response(200,'[]',{link}),response(200,'[]',{link})]);
  assert.equal((await f.provider.collection(base)).outcome,'incomplete'); assert.equal(f.calls.length,2);
  const limited = fixture([response(200,'[]',{link})],{maxPages:1});
  assert.equal((await limited.provider.collection(base)).outcome,'incomplete');
});

test('status categories, endpoint capability and sanitized public errors', async () => {
  const cases = [[401,'authentication'],[403,'denied'],[404,'not_found_or_inaccessible'],[400,'invalid_request'],
    [422,'invalid_request'],[429,'rate_limited'],[500,'server'],[302,'unsupported']];
  for (const [status, kind] of cases) {
    const f = fixture([response(status,'PRIVATE TOKEN secret')],{attempts:1});
    const result = await f.provider.request({...base, endpoint:'/repos/org/core/actions/runners'});
    assert.equal(result.diagnostic.kind,kind);
    assert.equal(result.diagnostic.capability,'administration:read');
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE|TOKEN|secret/);
  }
  for (const headers of [{'x-ratelimit-remaining':'0','x-ratelimit-reset':'120'}, {'retry-after':'120'}]) {
    const f = fixture([response(403,'private',headers)]);
    assert.equal((await f.provider.request(base)).diagnostic.kind,'rate_limited'); assert.equal(f.calls.length,1);
  }
  const f = fixture([response(403,'secondary rate limit private')]);
  assert.equal((await f.provider.request(base)).diagnostic.kind,'rate_limited');
  assert.equal(f.calls.length,1);
  const ok = fixture([response(200,'{"id":42,"private":"SECRET"}',{'x-github-request-id':'secret\nunsafe'})]);
  const result = await ok.provider.request(base);
  assert.equal(result.data.private,'SECRET');
  assert.doesNotMatch(JSON.stringify(publicDiagnostic(result)),/SECRET|unsafe/);
});

test('safe-read retry budgets and provider timing are observable', async () => {
  const f = fixture([new Error('SECRET'),response()]);
  assert.equal((await f.provider.request(base)).outcome,'read');
  assert.equal(f.calls.length,2); assert.deepEqual(f.waits,[1000]);
  const attempts = fixture([response(500),response(503),response(500)]);
  assert.equal((await attempts.provider.request(base)).diagnostic.kind,'server');
  assert.equal(attempts.calls.length,3); assert.deepEqual(attempts.waits,[1000,2000]);
  const elapsed = fixture([response(503)],{elapsedMs:500});
  assert.equal((await elapsed.provider.request(base)).diagnostic.kind,'server');
  assert.equal(elapsed.calls.length,1); assert.deepEqual(elapsed.waits,[]);
  for (const [headers, expected] of [[{'retry-after':'2'},2000],
    [{'x-ratelimit-remaining':'0','x-ratelimit-reset':'3'},3000]]) {
    const rate = fixture([response(429,'{}',headers),response()]);
    assert.equal((await rate.provider.request(base)).outcome,'read');
    assert.deepEqual(rate.waits,[expected]); assert.equal(rate.calls.length,2);
  }
  const wait = fixture([response(429,'{}',{'retry-after':'31'})]);
  assert.equal((await wait.provider.request(base)).diagnostic.retryAfterMs,31000); assert.equal(wait.calls.length,1);
  for (const r of [response(401),response(403),response(200,'{')]) {
    const f = fixture([r]); await f.provider.request(base); assert.equal(f.calls.length,1);
  }
});

test('cancellation and timeout bound requests and pending waits', async () => {
  const controller = new AbortController();
  const f = fixture([response(500)],{delay:async () => {controller.abort();}});
  assert.equal((await f.provider.request({...base,signal:controller.signal})).diagnostic.kind,'cancelled');
  assert.equal(f.calls.length,1);
  const timeout = createGithubProvider({elapsedMs:15,transport:async () => new Promise(() => {})});
  // Keep the event loop alive while Node's unreferenced AbortSignal timer fires.
  const keepAlive = setInterval(() => {}, 100);
  try { assert.equal((await timeout.request(base)).diagnostic.kind,'timeout'); }
  finally { clearInterval(keepAlive); }
  controller.abort();
  const pre = fixture([]); await pre.provider.request({...base,signal:controller.signal}); assert.equal(pre.calls.length,0);
});

test('trusted authorization binds the particular operation and target; payload booleans grant nothing', async () => {
  const context = Object.freeze({target:'42', operation:'issue', method:'PATCH', endpoint:base.endpoint});
  const f = fixture([response()], {authorize: r => r.context === context && r.target === context.target
    && r.operation === context.operation && r.method === context.method && r.endpoint === context.endpoint});
  for (const bad of [{}, {context:{authorized:true}}, {context,target:'43'}, {context,operation:'merge'},
    {context,endpoint:'/repos/org/other'}]) {
    assert.equal((await f.provider.request({...base,method:'PATCH',body:{authorized:true},...bad})).diagnostic.kind,'unauthorized');
  }
  assert.equal(f.calls.length,0);
  const result = await f.provider.request({...base,method:'PATCH',context,body:{body:'hello " \n $(touch nope)'}});
  assert.equal(result.outcome,'submitted'); assert.equal(f.calls.length,1);
  assert.deepEqual(JSON.parse(f.calls[0].body),{body:'hello " \n $(touch nope)'});
});

test('single submission, independent state readback, ambiguity before/after application and staleness', async () => {
  for (const mode of ['normal','accepted','lost-after','lost-before','server','malformed']) {
    let state = {id:'42', state:'open', revision:1}, writes = 0, reads = 0;
    const p = createGithubProvider({authorize:() => true, transport:async r => {
      if (r.method === 'GET') {reads++; return response(200,JSON.stringify(state));}
      writes++;
      if (!['lost-before','accepted'].includes(mode)) state = {...state,state:'closed',revision:2};
      if (mode.startsWith('lost')) throw Error('PRIVATE');
      if (mode === 'server') return response(503);
      if (mode === 'malformed') return response(200,'{');
      return response(mode === 'accepted' ? 202 : 200,'{}');
    }});
    const submission = await p.request({...base,method:'PATCH',body:{state:'closed'}});
    assert.equal(writes,1);
    assert.equal(submission.outcome,['normal','accepted'].includes(mode) ? 'submitted' : 'unknown');
    assert.equal((await p.reconcile(submission,base,d => d.state === 'closed' && d.revision === 2)).outcome,
      ['lost-before','accepted'].includes(mode) ? 'unknown' : 'verified');
    assert.equal(reads,1); assert.equal(writes,1);
    state = {...state,revision:1};
    assert.equal((await p.reconcile(submission,base,d => d.revision === 2)).outcome,'unknown');
    state.id = '43';
    assert.equal((await p.reconcile(submission,base,() => true)).outcome,'unknown');
    assert.equal((await p.reconcile(submission,{...base,target:'43'},() => true)).outcome,'unknown');
  }
  const f = fixture([response(202,'{}'),response(403)],{authorize:() => true});
  const submission = await f.provider.request({...base,method:'POST'});
  assert.equal((await f.provider.reconcile(submission,base,() => true)).outcome,'unknown');
});

test('hostile endpoints never reach transport and diagnostics contain no untrusted values', async () => {
  const f = fixture([]);
  assert.equal((await f.provider.request({...base,method:'POST',body:{authorized:true}})).diagnostic.kind,'unauthorized');
  for (const endpoint of ['https://secret@evil.test/x','/x/{owner}','/x/../y','/x%0asecret','/x\nSECRET','/$(touch secret)','//evil/x']) {
    const result = await f.provider.request({...base,endpoint});
    assert.equal(result.outcome,'failed'); assert.doesNotMatch(JSON.stringify(result),/SECRET|secret/);
  }
  assert.equal(f.calls.length,0);
  assert.throws(() => createGithubProvider({identity:'guessed'}));
  assert.throws(() => createGithubProvider({identity:'hosted-authorized'}));
  const hosted = fixture([response()],{identity:'hosted-authorized'});
  await hosted.provider.request(base); assert.equal(hosted.calls[0].identity,'hosted-authorized');
});

test('real local spawn boundary uses stored-login environment, headers and stdin without a shell', async () => {
  const dir = mkdtempSync(join(process.cwd(),'.nibfin-gh-'));
  const executable = join(dir,'gh');
  const inherited = ['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN','GH_HOST','GH_REPO','GH_DEBUG','GH_CONFIG_DIR','GH_FORCE_TTY','DEBUG'];
  const before = inherited.map(key => process.env[key]);
  try {
    inherited.forEach(key => {process.env[key] = 'PRIVATE-CREDENTIAL';});
    writeFileSync(executable, `#!/usr/bin/env node
const args=process.argv.slice(2);
if (Object.keys(process.env).some(k=>['${inherited.join("','")}'].includes(k))) process.exit(7);
if (args[0]==='auth') {if(args.join(' ')!=='auth status --hostname github.com')process.exit(8);process.exit(0);}
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
if(!args.includes('Accept: application/vnd.github+json')||!args.includes('X-GitHub-Api-Version: 2022-11-28'))process.exit(9);
console.log('HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n'+JSON.stringify({id:42,args,input}));
});`,{mode:0o755});
    const p = createGithubProvider({transport:localGhTransport({executable}),attempts:1,authorize:() => true});
    const read = await p.request(base); assert.equal(read.outcome,'read',JSON.stringify(read)); assert.equal(read.data.args.at(-1),'https://api.github.com'+base.endpoint);
    const result = await p.request({...base,method:'PATCH',body:{text:'$(touch PWNED) " hi'}});
    assert.equal(result.outcome,'submitted');
    assert.equal(JSON.parse(result.data.input).text,'$(touch PWNED) " hi');
    assert.ok(result.data.args.includes('--input')); assert.ok(result.data.args.includes('PATCH'));
    for (const script of ["process.stderr.write('PRIVATE-CREDENTIAL');process.exit(1);", "if(process.argv[2]==='auth')process.exit(0);process.stderr.write('PRIVATE-CREDENTIAL');process.exit(1);"]) {
      writeFileSync(executable,'#!/usr/bin/env node\n'+script,{mode:0o755});
      const result = await p.request(base);
      assert.ok(['authentication','transport'].includes(result.diagnostic.kind));
      assert.doesNotMatch(JSON.stringify(result),/PRIVATE-CREDENTIAL/);
    }
    for (const [status, kind] of [[401,'authentication'],[403,'denied'],[404,'not_found_or_inaccessible'],[429,'rate_limited'],[503,'server']]) {
      writeFileSync(executable, '#!/usr/bin/env node\nif(process.argv[2]==="auth")process.exit(0);console.log('+JSON.stringify('HTTP/2.0 '+status+' status\r\n\r\n{"private":"PRIVATE-CREDENTIAL"}')+');process.exit(1);', {mode:0o755});
      const result = await p.request(base);
      assert.equal(result.diagnostic.kind,kind);
      assert.doesNotMatch(JSON.stringify(result),/PRIVATE-CREDENTIAL/);
    }
    const missing = createGithubProvider({transport:localGhTransport({executable:join(dir,'absent')}),attempts:1});
    assert.equal((await missing.request(base)).diagnostic.kind,'transport');
  } finally {
    inherited.forEach((key,i) => {if(before[i] === undefined)delete process.env[key];else process.env[key]=before[i];});
    rmSync(dir,{recursive:true,force:true});
  }
});

 test('collection shares its elapsed budget across pages and retries', async () => {
  let time = 0, calls = 0;
  const waits = [];
  const p = createGithubProvider({elapsedMs:2500, now:() => time,
    delay:async ms => {waits.push(ms);time += ms;}, transport:async () => {
      calls++;
      if(calls === 1) {time += 2000;return response(200,'[]',{link:'<https://api.github.com/x?page=2>; rel="next"'});}
      return response(503);
    }});
  assert.equal((await p.collection(base)).outcome,'incomplete');
  assert.equal(calls,2); assert.deepEqual(waits,[]);
});
