import test from 'node:test';
import assert from 'node:assert/strict';
import {GitHub} from '../src/github.mjs';
import {continueCohort} from '../src/continuation.mjs';
import {transientDispatchRead} from '../src/dispatch.mjs';

test('conditional reads require a fresh authenticated 304 and cannot hide revocation',async()=>{
  let calls=0;
  const gh=new GitHub('fixture',async(url,options)=>{
    calls++;assert.equal(options.headers.Authorization,'Bearer fixture');
    if(calls===1)return Response.json({revoked:false},{headers:{etag:'"grant-1"'}});
    assert.equal(options.headers['If-None-Match'],calls<4?'"grant-1"':'"grant-2"');
    if(calls===2)return new Response(null,{status:304});
    if(calls===3)return Response.json({revoked:true},{headers:{etag:'"grant-2"'}});
    return new Response(null,{status:403});
  });
  const first=await gh.api('/grant');first.revoked=true;
  assert.equal((await gh.api('/grant')).revoked,false);
  assert.equal((await gh.api('/grant')).revoked,true);
  await assert.rejects(gh.api('/grant'),e=>e.status===403&&!e.code);
  assert.equal(calls,4);
});

test('cache entries do not bypass failed reads and are invalidated before writes',async()=>{
  const requests=[];let fail=false;
  const gh=new GitHub('fixture',async(url,o)=>{requests.push(o);if(fail)return new Response(null,{status:503});return o.method==='GET'?Response.json({value:1},{headers:{etag:'"v1"'}}):new Response(null,{status:204});},async()=>{});
  await gh.api('/same');await gh.api('/write','POST',{});await gh.api('/same');
  assert.equal(requests[2].headers['If-None-Match'],undefined);
  fail=true;await assert.rejects(gh.api('/same'),/HTTP 503/);
  assert.equal(requests.length,6);
});

test('confirmed primary rate exhaustion defers all reads until reset without blind retries',async()=>{
  let now=100000,calls=0;
  const gh=new GitHub('fixture',async()=>++calls===1?new Response(null,{status:403,headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':'220'}}):Response.json({fresh:true}),async()=>assert.fail('adapter must return control'),()=>now);
  await assert.rejects(gh.api('/grant'),e=>e.code==='GITHUB_RATE_LIMIT'&&e.retryAt===221000&&transientDispatchRead(e));
  await assert.rejects(gh.api('/another'),e=>e.code==='GITHUB_RATE_LIMIT');assert.equal(calls,1);
  now=221000;assert.deepEqual(await gh.api('/grant'),{fresh:true});assert.equal(calls,2);
});

test('secondary backoff is explicit and permission errors or rate-limited writes never become resumable reads',async()=>{
  for(const headers of [{},{'x-ratelimit-remaining':'1','x-ratelimit-reset':'220'},{'x-ratelimit-remaining':'0','x-ratelimit-reset':'invalid'}]){
    const gh=new GitHub('fixture',async()=>new Response(null,{status:403,headers}),async()=>assert.fail('no retry'),()=>100000);
    await assert.rejects(gh.api('/grant'),e=>e.status===403&&!transientDispatchRead(e));
  }
  for(const method of ['GET','PUT']){
    let calls=0;const gh=new GitHub('fixture',async()=>{calls++;return new Response(null,{status:403,headers:{'retry-after':'90'}});},async()=>assert.fail('no blind retry'),()=>100000);
    await assert.rejects(gh.api('/grant',method),e=>e.retryAt===191000&&transientDispatchRead(e)===(method==='GET'));assert.equal(calls,1);
  }
});

test('continuation waits through reset then reenters fresh authority; revocation still stops',async()=>{
  for(const revoked of [false,true]){
    let now=100000,calls=0;const waits=[];
    const runtime={resume:async()=>{if(++calls===1)throw Object.assign(new Error('rate limited'),{code:'GITHUB_RATE_LIMIT',requestMethod:'GET',retryAt:221000});assert.ok(now>=221000);if(revoked)throw Error('Grant revoked');return {status:'COMPLETE'};}};
    const options={now:()=>now,delay:async ms=>{assert.ok(ms<=60000);waits.push(ms);now+=ms;}};
    if(revoked)await assert.rejects(continueCohort(runtime,options),/Grant revoked/);else assert.equal((await continueCohort(runtime,options)).status,'COMPLETE');
    assert.equal(calls,2);assert.equal(waits.reduce((a,b)=>a+b,0),121000);
  }
});
