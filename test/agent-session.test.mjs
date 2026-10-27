import test from 'node:test';
import assert from 'node:assert/strict';
import {executeSession,recoveryPolicy,capacityError,codexEvents,rejectSecrets} from '@nibfin/core';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const result={version:1,outcome:'ready',failureClass:'none',summary:'done',conflicts:[]};
const stream=(end={type:'turn.completed',usage:{}},text=JSON.stringify(result))=>[
  {type:'thread.started',thread_id:id},{type:'turn.started'},
  {type:'item.completed',item:{id:'final',type:'agent_message',text}},end].map(v=>JSON.stringify(v)).join('\n')+'\n';
const versions={codex:'codex-cli 0.163.0',claude:'2.1.285 (Claude Code)',gemini:'0.65.0'};
const capacity=agent=>({error:agent==='codex'?{message:'unexpected status 503 Service Unavailable: {"error":{"code":"server_overloaded"}}'}:
  agent==='claude'?{type:'overloaded_error',status:529}:{status:'RESOURCE_EXHAUSTED',code:429}});
const policy=agent=>({attempts:3,delayMs:5,model:'primary',models:['primary','fallback'].map(model=>
  ({id:model,adapter:agent,provider:agent,version:versions[agent],resume:true})),fallbacks:['fallback']});
test('Codex versioned terminal stream rejects stale/missing/truncated/oversized/duplicate/failed/foreign output and secrets',async()=>{
  assert.deepEqual(codexEvents(stream()).result,result);
  const entry=await import(new URL('codex-entry.mjs',import.meta.resolve('@nibfin/core')));
  const request={access:'read',prompt:'task',timeout:100,context:{execution:{id:'current'},binding:{instructions:'current'}}};
  const collected=entry.executeCodex(request,[],()=>({status:0,stdout:stream()}));
  assert.deepEqual(collected.evidence,{...request.context,result});
  for(const text of ['',stream().slice(0,-1),stream()+JSON.stringify({type:'turn.completed'})+'\n',
    stream().replace(JSON.stringify({type:'turn.completed',usage:{}}),'not-json'),stream().replace('thread.started','foreign.started'),
    stream({type:'turn.failed',error:{message:'failed'}}),stream({type:'turn.completed'},'not-json'),'x'.repeat(1048577)])
    assert.equal(entry.executeCodex(request,[],()=>({status:0,stdout:text})).evidence,undefined);
  assert.equal(entry.executeCodex(request,[],()=>({status:1,stdout:stream()})).evidence,undefined);
  const duplicate=stream().replace('"type":"turn.completed"', '"type":"turn.completed"');
  const lines=duplicate.trimEnd().split('\n');lines.splice(3,0,lines[2]);assert.throws(()=>codexEvents(lines.join('\n')+'\n'));
  const encoded='"'+[...'token-secret'].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"';
  assert.throws(()=>rejectSecrets({discarded:JSON.stringify({nested:encoded})},['token-secret']),/credential-output/);
  assert.throws(()=>codexEvents(stream(undefined,JSON.stringify({...result,summary:'token-secret'})),['token-secret']));
});

test('recognized provider capacity alone can resume the original session; explicitly permitted same-provider model fallback preserves state',()=>{
  for(const agent of Object.keys(versions)) {
    let time=1000,attempts=0;const seen=[];let writer='';
    const request={access:'write',prompt:'task',timeout:1000,deadlineAt:2000,recovery:policy(agent),context:{execution:'writer'}};
    const value=executeSession({request,adapter:agent,version:versions[agent],now:()=>time,wait:ms=>{time+=ms;},
      invoke:r=>{seen.push({...r});return {file:'/cli',args:[],options:{timeout:r.timeout}};},
      run:()=>{attempts++;time+=10;if(attempts===1){writer='kept edits';return {status:1,stdout:'capacity'};}
        assert.equal(writer,'kept edits');return {status:0,stdout:'success'};},
      inspect:r=>({session:id,success:r.status===0,capacity:r.status!==0&&capacityError(agent,capacity(agent))}),
      decode:()=>result});
    assert.deepEqual(value.evidence,result);assert.equal(attempts,2);assert.equal(seen[0].session,null);
    assert.equal(seen[1].session,id);assert.equal(seen[0].model,'primary');assert.equal(seen[1].model,'fallback');
    assert(seen[1].timeout<seen[0].timeout);
  }
});

test('exhausted attempts/time, cancellation, invalid capability, changed sessions and denied fallback never reset budgets or blindly replay',()=>{
  for(const agent of Object.keys(versions)) {
    for(const scenario of ['attempts','deadline','cancel','foreign','no-session','auth','prose','403','unknown-write','no-policy']) {
      let time=1000,attempts=0,aborted=false;
      const request={timeout:100,deadlineAt:1100,recovery:policy(agent),context:{},signal:{get aborted(){return aborted;}}};
      if(scenario==='no-policy')delete request.recovery;
      const value=executeSession({request,adapter:agent,version:versions[agent],now:()=>time,
        wait:ms=>{time+=scenario==='deadline'?100:ms;if(scenario==='cancel')aborted=true;},
        invoke:()=>({file:'/cli',args:[],options:{}}),run:()=>{attempts++;return {status:1,stdout:'failure'};},
        inspect:()=>({session:scenario==='no-session'?null:scenario==='foreign'&&attempts>1?other:id,
          success:false,authentication:scenario==='auth',capacity:!['prose','403','unknown-write'].includes(scenario)}),decode:()=>result});
      assert.equal(value.evidence,undefined);assert(attempts<=3);
      if(['no-session','auth','prose','403','unknown-write','no-policy'].includes(scenario))assert.equal(attempts,1,scenario);
      if(scenario==='cancel')assert.equal(value.diagnostic,'cancelled');
      if(scenario==='foreign')assert.equal(value.diagnostic,'invalid-result');
    }
    for(const mutation of [p=>p.models[0].provider='other',p=>p.models[1].resume=false,p=>p.models[1].version='other',
      p=>p.fallbacks=['unconfirmed'],p=>p.attempts=100]) {
      const p=policy(agent);mutation(p);assert.throws(()=>recoveryPolicy(p,agent,versions[agent]));
    }
    assert.equal(capacityError(agent,{message:'capacity exhausted'}),false);
    assert.equal(capacityError(agent,{...capacity(agent),unknown_external_write:true}),false);
    assert.equal(capacityError(agent,{error:{code:403,message:'capacity exhausted'}}),false);
  }
});

test('selected official CLI entrypoints actually apply explicit model policy and resume the same session after recognized capacity',async()=>{
  for(const agent of ['codex','claude','gemini']) {
    const entry=await import(new URL(agent+'-entry.mjs',import.meta.resolve('@nibfin/core')));let attempts=0,session=id;const commands=[];
    const request={access:'write',prompt:'Continue the original task',timeout:1000,context:{execution:{id:'writer'}},recovery:policy(agent)};
    const run=(file,args,options)=>{
      commands.push({file,args,timeout:options.timeout});attempts++;
      if(agent==='claude'&&attempts===1)session=args[args.indexOf('--session-id')+1];
      if(attempts===2) {
        assert.equal(args[args.indexOf('--model')+1],'fallback');
        if(agent==='codex'){assert(args.includes('resume'));assert(args.includes(session));}
        else assert.equal(args[args.indexOf('--resume')+1],session);
      }
      const stdout=agent==='codex'?(attempts===1?stream({type:'turn.failed',...capacity('codex')},'no result'):stream()):
        JSON.stringify(agent==='claude'?(attempts===1?{type:'result',subtype:'error_during_execution',is_error:true,session_id:session,...capacity(agent)}:
          {type:'result',subtype:'success',is_error:false,session_id:session,structured_output:result}):
          (attempts===1?{session_id:session,...capacity(agent)}:{session_id:session,response:JSON.stringify(result)}));
      return {status:attempts===1?1:0,stdout};
    };
    const outcome=agent==='codex'?entry.executeCodex(request,[],run):agent==='claude'?entry.executeClaude(request,'{}','private-key',run):entry.executeGemini(request,'private-key',run);
    assert.deepEqual(outcome.evidence,{...request.context,result});assert.equal(attempts,2);assert(commands[1].timeout<=commands[0].timeout);
  }
});
