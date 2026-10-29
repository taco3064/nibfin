import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {withRoleSession,sessionIdFromEvents} from '../src/role-session.mjs';
import {CodexAgent} from '../src/agent.mjs';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const ctx={issue:{id:'I_A',repository:'owner/repo',scopeHash:'scope'},binding:{policyHash:'approved'}};
test('Shaper resumes for review; original Deliver resumes through CI and base repairs; role and Issue stores are isolated',async t=>{
 const root=await mkdtemp(join(tmpdir(),'kairo-sessions-'));t.after(()=>rm(root,{recursive:true}));
 const first=async (stage,id)=>withRoleSession(root,stage,ctx,async s=>{assert.equal(s.id,null);await writeFile(join(s.directory,'rollout-'+id+'.jsonl'),'session');return {session:{id},executionId:stage};});
 await first('shape',A);await first('deliver',B);
 for(const stage of ['shaper-review','deliver','deliver'])await withRoleSession(root,stage,ctx,async s=>{assert.equal(s.id,stage==='deliver'?B:A);return {session:{id:s.id},executionId:stage};});
 await assert.rejects(withRoleSession(root,'shaper-review',{...ctx,issue:{...ctx.issue,id:'I_B'}},()=>assert.fail()),/missing/);
 await withRoleSession(root,'accept',ctx,async s=>{assert.equal(s,null)});
});
test('failed or missing session cannot silently start another conversation',async t=>{
 const root=await mkdtemp(join(tmpdir(),'kairo-session-fail-'));t.after(()=>rm(root,{recursive:true}));
 await assert.rejects(withRoleSession(root,'deliver',ctx,async()=>{throw Error('uncertain')}),/uncertain/);
 await assert.rejects(withRoleSession(root,'deliver',ctx,()=>assert.fail()),/recovery/);
 assert.equal(sessionIdFromEvents(JSON.stringify({type:'thread.started',thread_id:A})),A);
 assert.throws(()=>sessionIdFromEvents('no session'));
});
test('resumed review retains a read-only workspace, explicit ID and schema; only role session files persist',()=>{
 const c={image:'sha256:'+'a'.repeat(64),network:'isolated',user:'1000:1000',authDirectory:'/auth-dir'};
 const a=new CodexAgent(c,'/core','/state');
 const args=a.executionArgs('/work-dir','/io-dir',false,{directory:'/role-data',id:A});
 assert.ok(args.includes('resume'));assert.ok(args.includes(A));assert.ok(args.includes('--json'));assert.equal(args.includes('--ephemeral'),false);
 assert.ok(args.some(x=>x.includes('dst=/work,readonly')));assert.ok(args.some(x=>x.includes('dst=/sessions')));
 assert.ok(args.includes('--output-schema'));assert.ok(a.executionArgs('/w','/io',false).includes('--ephemeral'));
});
