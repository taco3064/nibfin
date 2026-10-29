import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const workflow=(await readFile('examples/workflows/actions-public-caller.yml','utf8')).replaceAll('\r\n','\n');
const script=workflow.split("node <<'NODE'\n")[2].split('\n          NODE')[0].split('\n').map(l=>l.slice(10)).join('\n');
async function run(responses){
  let calls=0,waits=0,clock=0;const records=[];
  const process={env:{EVENT_ENDPOINT:'https://example.test/event',ENVELOPE:Buffer.from(JSON.stringify({payload:{runId:'123'}})).toString('base64')}};
  class Clock extends Date {static now(){return clock;}}
  await vm.runInNewContext(script,{process,URL,Buffer,Date:Clock,AbortSignal:{timeout:()=>undefined},
    console:{log:x=>records.push(x),error:x=>records.push(x)},setTimeout:fn=>{waits++;clock+=5000;fn();},
    fetch:async()=>{const value=responses[Math.min(calls++,responses.length-1)];if(value instanceof Error)throw value;return value;}});
  return {calls,waits,records,exit:process.exitCode};
}
const pending={ok:false,status:425,json:async()=>({code:'ACTION_EVENT_SIGNER_PENDING'})};
test('actual caller sends one signed event without signer status polling',async()=>{
  const r=await run([{ok:true,status:202}]);assert.equal(r.calls,1);assert.equal(r.waits,0);assert.equal(r.exit,undefined);
});
test('actual caller never repeats unknown dispatch writes or foreign retry codes',async()=>{
  for(const response of [new Error('network timeout'),{ok:false,status:409},{ok:false,status:500},{ok:false,status:400},{ok:false,status:425,json:async()=>({code:'OTHER'})}]){
    const r=await run([response]);assert.equal(r.calls,1);assert.equal(r.waits,0);assert.equal(r.exit,1);
  }
});
test('actual caller reports authentication failures and never retries pending or rejected notifications',async()=>{
  for (const response of [pending,{ok:false,status:401},{ok:false,status:403}]) {
    const r=await run([response]);assert.equal(r.calls,1);assert.equal(r.waits,0);assert.equal(r.exit,1);assert.match(r.records.at(-1),new RegExp('HTTP '+response.status));
  }
});
