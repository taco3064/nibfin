import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm}from'node:fs/promises';
import {tmpdir}from'node:os';
import {join}from'node:path';
import {setTimeout as delay}from'node:timers/promises';
import {Store}from'../src/store.mjs';
test('concurrent metadata updates retain both inbox records without rerunning failed work',async t=>{
 const root=await mkdtemp(join(tmpdir(),'kairo-meta-'));t.after(()=>rm(root,{recursive:true}));
 const a=new Store(root,'inbox'),b=new Store(root,'inbox');
 const save=(store,key)=>store.metadataLease(async()=>{const s=await store.read();await delay(40);return store.transaction(s.revision,s=>({...s,seen:{...s.seen,[key]:true}}));});
 await Promise.all([save(a,'A'),save(b,'B')]);assert.deepEqual((await a.read()).seen,{A:true,B:true});
 let calls=0;await assert.rejects(a.metadataLease(async()=>{calls++;throw Object.assign(Error('inner failure'),{code:'EEXIST'});}));assert.equal(calls,1);
});
test('bounded execution lease waits only for acquisition, times out explicitly and never retries work',async t=>{
 const root=await mkdtemp(join(tmpdir(),'kairo-lease-'));t.after(()=>rm(root,{recursive:true}));
 const a=new Store(root,'repository'),b=new Store(root,'repository');let release,entered;
 const gate=new Promise(r=>release=r),held=new Promise(r=>entered=r);
 const first=a.lease(async()=>{entered();await gate;});await held;
 await assert.rejects(b.lease(async()=>assert.fail('Lock is held'),{waitMs:30}),{code:'LEASE_WAIT_TIMEOUT'});
 let calls=0;const second=b.lease(async()=>{calls++;throw Object.assign(Error('work failed'),{code:'EEXIST'});},{waitMs:1000});
 release();await first;await assert.rejects(second,/work failed/);assert.equal(calls,1);
});
