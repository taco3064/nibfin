import test from 'node:test';import assert from 'node:assert/strict';import{GitHub}from'../src/github.mjs';
test('repository controls read head without reconstructing protection requirements',async()=>{
 const paths=[];const g=new GitHub('test',async url=>{paths.push(url);return new Response(JSON.stringify({commit:{sha:'a'.repeat(40)},protected:true}));});
 const r=await g.protections('owner/repo','main','github-repository');assert.equal(r.head,'a'.repeat(40));assert.deepEqual(r.requiredChecks,[]);assert.equal(paths.length,1);assert.ok(paths[0].endsWith('/branches/main'));
});

import { ready } from '../src/dynamic.mjs';
import { digest } from '../src/core.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('owner dependency scheduling uses delivered labels without reconstructing upstream execution history',async t=>{
 const stateDirectory=await mkdtemp(join(tmpdir(),'kairo-controls-'));t.after(()=>rm(stateDirectory,{recursive:true,force:true}));
 const upstream={id:'B',number:2,repository:'owner/repo',repositoryId:'1'},downstream={id:'D',number:4,repository:'owner/repo',repositoryId:'1'};
 const grant={recordId:'own',manifest:{issues:[upstream,downstream]},policy:{controlMode:'owner-project',repositories:{'owner/repo':{}}}};
 let delivered=true;
 const runtime={config:{stateDirectory},grant:async()=>grant,github:{repository:async()=>({id:1}),issue:async i=>({node_id:i.id,labels:[{name:'scope'},...(i.id==='B'&&delivered?[{name:'delivered'}]:[])]}),dependencies:async i=>i.id==='D'?[{node_id:'B'}]:[]}};
 assert.deepEqual((await ready(runtime,grant,downstream)).proofs,[{issueId:'B',completionHash:digest({issueId:'B',status:'delivered'})}]);
 delivered=false;await assert.rejects(ready(runtime,grant,downstream),{code:'DEPENDENCY_WAIT'});
});
