import test from 'node:test';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {userInfo} from 'node:os';
import {candidatePublicationFixture} from '../tooling/candidate-publication-fixture.mjs';
import {createCandidatePublication,createPublicationGit,importWorkspace,exportWorkspace} from '../src/index.mjs';
const pushes=f=>f.commands.filter(c=>c.args.includes('push'));
const blocked=async f=>{const r=await f.run();assert.equal(r.outcome,'blocked');return r;};

for(const empty of [false,true])for(const ownership of ['personal','organization'])test(`accepted exact publication; empty=${empty}, owner=${ownership}`,async()=>{
  const f=await candidatePublicationFixture({empty,ownership});try{
    const bytes=f.a.snapshot();
    const r=await f.run();assert.equal(r.outcome,'published');const v=r.value;
    const raw=f.git('--git-dir='+f.remote,'cat-file','commit',v.commit);
    const boundary=raw.indexOf(Buffer.from('\n\n'));
    assert(raw.subarray(boundary+2).equals(Buffer.from(f.pin.hooks.message,'base64')));
    assert.match(raw.toString(),new RegExp(`^tree ${f.a.workspace.candidate.tree}\\nparent ${f.a.workspace.candidate.base}\\nauthor `));
    assert.equal(raw.toString().match(/^parent /gm).length,1);
    const files=f.git('--git-dir='+f.remote,'ls-tree',v.commit).toString();
    assert.match(files,/100755 blob .*\tbinary/);assert(!files.includes('deleted'));assert(!files.includes('ignored'));
    assert.equal(v.candidate.candidate.artifacts[0].path,'ignored');
    assert.deepEqual(f.a.snapshot(),bytes);
    assert(f.events.indexOf('intent')<f.events.indexOf('constructed'));
    assert(f.events.indexOf('push-attempt')<f.events.indexOf('push'));
    assert.equal(pushes(f).length,1);assert.equal(f.o.writes().length,1);
    const again=await f.run();assert.equal(again.outcome,'published');
    assert.equal(pushes(f).length,1);assert.equal(f.o.writes().length,1);
    assert.equal(again.value.commit,v.commit);
  }finally{f.close();}
});

const badInputs={
  'missing Acceptance':p=>{delete p.evidence.accept;},
  'rejected Acceptance':p=>{p.evidence.accept.value.result.outcome='changes_required';},
  'foreign Acceptance':p=>{p.evidence.accept.value.binding.issueId='I_foreign';},
  'consumed Acceptance':p=>{p.evidence.accept.current.consumed.push(p.evidence.accept.value.execution.result);},
  'mismatched current Acceptance':p=>{p.evidence.accept.current.expected.inputs.deliver='other';},
  'missing second hooks':p=>{delete p.hooks.receipt;},
  'consumed second hooks':p=>{p.hooks.receiptCurrent.consumed.push(p.hooks.receipt.identity);},
  'consumed first hooks':p=>{p.hooks.firstReceiptCurrent.consumed.push(p.hooks.first.identity);},
  'changed message':p=>{p.hooks.message=Buffer.from('substitution').toString('base64');},
  'changed backend':p=>{p.hooks.profile.image='sha256:'+'b'.repeat(64);},
  'changed Shape':p=>{p.shapeBody+='changed';},
  'missing publication':p=>{delete p.evidence.publication;},
  'foreign Shape validator':p=>{p.evidence.validator.value.inputs.author='foreign';},
  'consumed Shape':p=>{p.evidence.author.current.consumed.push(p.evidence.author.value.execution.result);},
  'changed artifact':p=>{p.workspace.candidate.artifacts[0].digest='b'.repeat(64);},
  'changed tree':p=>{p.workspace.candidate.tree='b'.repeat(40);},
  'changed base':p=>{p.workspace.candidate.base='b'.repeat(40);},
  'changed diff':p=>{p.workspace.candidate.diff='b'.repeat(64);},
  'policy drift':p=>{p.binding.policy='b'.repeat(64);},
  'wrong repository ID':p=>{p.target.repositoryId='43';},
  'wrong repository coordinates':p=>{p.target.repository='foreign/core';},
  'private repository':p=>{p.visibility='private';},
  'unauthorized paths':p=>{p.target.paths=['binary'];},
  'unsafe ref':p=>{p.target.headRef='nibfin/../main';},
  'outside branch namespace':p=>{p.target.headRef='foreign/101';},
  'target base equals head':p=>{p.target.baseRef=p.target.headRef;},
  'incorrect base branch':p=>{p.target.baseRef='missing';}
};
for(const [label,mutate] of Object.entries(badInputs))test(`rejects ${label} without publication`,async()=>{
  const f=await candidatePublicationFixture({empty:true});try{mutate(f.pin);await blocked(f);
    assert.equal(pushes(f).length,0);assert.equal(f.o.writes().length,0);
    if(label!=='incorrect base branch')assert(!f.events.includes('constructed'));
  }finally{f.close();}
});

test('retained Candidate wins over modified checkout and index; transfer corruption fails',async()=>{
  const f=await candidatePublicationFixture({empty:true});try{
    writeFileSync(join(f.a.root,'binary'),'malicious checkout');f.a.git('add','binary');
    const wire=JSON.parse(exportWorkspace(f.a.workspace));wire.objects[0].data='AAAA';
    assert.throws(()=>importWorkspace(Buffer.from(JSON.stringify(wire)),{expected:f.a.workspace.expected}));
    assert.equal((await f.run()).outcome,'published');
    const commit=f.git('--git-dir='+f.remote,'rev-parse','refs/heads/nibfin/101').toString().trim();
    assert(f.git('--git-dir='+f.remote,'show',commit+':binary').equals(Buffer.from([0,255,128,3])));
    const real=f.capabilities.git;f.capabilities.git={...real,open(w,...args){return real.open({...w,objects:[]},...args);}};
    await blocked(f);
  }finally{f.close();}
});

for(const checkpoint of ['onEligibility','onRetain','onOperations'])test(`drift while awaiting ${checkpoint} prevents next mutation`,async()=>{
  const f=await candidatePublicationFixture({empty:true});try{
    if(checkpoint==='onRetain')f.state.onRetain=async r=>{if(r.event.kind==='push-attempt')f.pin.decisions.push('new');};
    else f.state[checkpoint]=async()=>{f.pin.decisions.push('new');};
    await blocked(f);assert.equal(f.o.writes().length,0);
    if(checkpoint!=='onOperations')assert.equal(pushes(f).length,0);
  }finally{f.close();}
});

for(const label of ['base advancement','conflicting head','authorization loss','history unavailable','retention failure'])test(label,async()=>{
  const f=await candidatePublicationFixture({empty:true});try{
    if(label==='base advancement'){
      f.a.git('-c','core.hooksPath=/dev/null','commit','--allow-empty','-qm','advance');
      f.git('-C',f.a.root,'push',f.remote,'HEAD:refs/heads/main');
    }
    if(label==='conflicting head')f.git('--git-dir='+f.remote,'update-ref','refs/heads/nibfin/101',f.a.workspace.candidate.base);
    if(label==='authorization loss')f.o.state.allowed=false;
    if(label==='history unavailable')f.state.historyUnavailable=true;
    if(label==='retention failure')f.state.onRetain=()=>{throw Error('credential-sentinel');};
    const r=await blocked(f);assert(!JSON.stringify(r).includes('credential-sentinel'));
    assert.equal(pushes(f).length,0);assert.equal(f.o.writes().length,0);
  }finally{f.close();}
});

test('unknown push never blindly retries; matching remote resolves lost push acknowledgment',async()=>{
  const f=await candidatePublicationFixture({empty:true});try{
    f.state.onPush=()=>{throw Error('lost-before-push');};
    await blocked(f);f.state.onPush=null;await blocked(f);assert.equal(pushes(f).length,0);
    const commit=[...f.records.values()][0].find(r=>r.event.kind==='commit').event.value.commit;
    // Transfer exact retained objects through the same production transport in verifier-owned storage.
    const s=createPublicationGit({repository:f.pin.target.repository,repositoryId:'42',localFixture:f.remote})
      .open(f.a.workspace,Buffer.from(f.pin.hooks.message,'base64'),f.pin.author);
    try{assert.equal(s.commit,commit);s.push({head:f.pin.target.headRef,base:'main'});}finally{s.close();}
    assert.equal((await f.run()).outcome,'published');assert.equal(pushes(f).length,0);
  }finally{f.close();}
});

for(const fault of ['existing','lost','duplicate','foreign','head','base','detail','incomplete','denied','zero after lost'])test(`PR ${fault} reconciliation`,async()=>{
  const f=await candidatePublicationFixture({empty:true});try{
    if(fault==='existing')f.o.state.effect=true;
    if(fault==='lost'||fault==='zero after lost')f.o.state.lost=true;
    if(fault==='duplicate'){f.o.state.effect=true;f.o.state.prs=d=>[d,{...d,id:'62',number:103}];}
    if(fault==='foreign')f.o.state.mutate=d=>({...d,head:{...d.head,repo:{id:'43'}}});
    if(fault==='head')f.o.state.mutate=d=>({...d,head:{...d.head,sha:'c'.repeat(40)}});
    if(fault==='base')f.o.state.mutate=d=>({...d,base:{...d.base,sha:'d'.repeat(40)}});
    if(fault==='detail')f.o.state.detail=d=>({...d,title:'changed'});
    if(fault==='incomplete')f.o.state.incomplete=true;
    if(fault==='denied')f.o.state.failRead=true;
    if(fault==='zero after lost')f.o.state.onWrite=()=>{f.o.state.effect=false;};
    const r=await f.run();
    assert.equal(r.outcome,['existing','lost'].includes(fault)?'published':'blocked');
    const writes=f.o.writes().length;
    if(['existing','duplicate','incomplete','denied'].includes(fault))assert.equal(writes,0);
    if(fault==='zero after lost'){await blocked(f);assert.equal(f.o.writes().length,writes);}
  }finally{f.close();}
});

test('Git process environment and transport are isolated from checkout and token overrides',async()=>{
  const f=await candidatePublicationFixture({empty:true});try{
    const prior=process.env.GH_TOKEN;process.env.GH_TOKEN='credential-sentinel';
    try{f.a.git('config','core.hooksPath','/should-never-run');assert.equal((await f.run()).outcome,'published');}
    finally{if(prior===undefined)delete process.env.GH_TOKEN;else process.env.GH_TOKEN=prior;}
    for(const c of f.commands){assert.equal(c.file,'/usr/bin/git');assert(!JSON.stringify(c).includes('credential-sentinel'));
      assert.equal(c.env.HOME,'/nonexistent');assert.equal(c.env.GIT_CONFIG_GLOBAL,'/dev/null');
      assert(c.args.includes('core.hooksPath=/dev/null'));assert(!c.cwd.startsWith(f.a.root));
      if(c.transport)assert(c.args.includes(f.remote));}
    assert.throws(()=>createPublicationGit({repository:'example-org/core',repositoryId:'42',localFixture:'--evil'}));
    assert.throws(()=>createPublicationGit({repository:'example-org/core;evil',repositoryId:'42'}));
  }finally{f.close();}
});

test('cancellation, busy flow, corrupt durable history and unresolved cleanup fail closed',async()=>{
  const f=await candidatePublicationFixture({empty:true});try{
    const aborted=new AbortController();aborted.abort();await blocked({...f,run:()=>f.run({signal:aborted.signal})});
    let release;const wait=new Promise(r=>{release=r;});let entered;
    const reached=new Promise(r=>{entered=r;});f.state.onEligibility=async()=>{entered();await wait;};
    const flow=f.fresh(),pending=flow.run();await reached;assert.equal((await flow.run()).outcome,'blocked');
    release();assert.equal((await pending).outcome,'published');f.state.onEligibility=null;
    const records=[...f.records.values()][0];records[0].event.pin.target.number='999';await blocked(f);
    records[0].event.pin.target.number='101';
    const original=f.capabilities.git;f.capabilities.git={...original,open(...args){const s=original.open(...args);return {...s,close(){s.close();throw Error('secret cleanup');}};}};
    const retired=createCandidatePublication(f.capabilities);assert.equal((await retired.run()).finding,'candidate-publication:cleanup-unresolved');
    assert.equal((await retired.run()).outcome,'blocked');
  }finally{f.close();}
});


test('drift during final authorization reads rejects before the provider mutation',async()=>{
  const f=await candidatePublicationFixture({empty:true});try{
    f.state.onOperations=()=>{let reads=0;f.o.state.onAuthorizationRead=r=>{
      if(r.endpoint.endsWith('/permission')&&++reads===3)f.pin.decisions.push('drift during authorization');
    };};
    await blocked(f);assert.equal(f.o.writes().length,0);
  }finally{f.close();}
});

for(const phase of ['intent','attempt','result'])test(`PR custody ${phase} interruption blocks or reconciles`,async()=>{
  const f=await candidatePublicationFixture({empty:true});try{
    f.o.state.retainFail=phase;await blocked(f);
    const count=f.o.writes().length;assert.equal(count,phase==='result'?1:0);
    f.o.state.retainFail=false;
    const r=await f.run();assert.equal(r.outcome,phase==='intent'?'published':phase==='result'?'published':'blocked');
    if(phase!=='intent')assert.equal(f.o.writes().length,count);
  }finally{f.close();}
});


test('an absent-ref lease rejects a racing fast-forward-compatible branch without overwriting it',async()=>{
  const f=await candidatePublicationFixture({empty:true});try{
    f.state.onCommand=c=>{if(c.args.includes('push'))f.git('--git-dir='+f.remote,'update-ref','refs/heads/nibfin/101',f.a.workspace.candidate.base);};
    await blocked(f);assert.equal(f.o.writes().length,0);
    assert.equal(f.git('--git-dir='+f.remote,'rev-parse','refs/heads/nibfin/101').toString().trim(),f.a.workspace.candidate.base);
  }finally{f.close();}
});

test('production stored-login Git selects only canonical HTTPS and the fixed trusted helper',async()=>{
  const f=await candidatePublicationFixture({empty:true});let session;try{
    const commands=[];
    const backend=createPublicationGit({repository:'example-org/core',repositoryId:'42',onCommand:c=>{
      commands.push(c);if(c.transport)throw Error('stop before network');
    }});
    session=backend.open(f.a.workspace,Buffer.from(f.pin.hooks.message,'base64'),f.pin.author);
    assert.throws(()=>session.observe({head:'nibfin/101',base:'main'}));
    const c=commands.find(c=>c.transport);assert(c.args.includes('https://github.com/example-org/core.git'));
    assert(c.args.includes('credential.helper=!/usr/bin/gh auth git-credential'));
    assert.equal(c.env.GIT_ALLOW_PROTOCOL,'https');assert.equal(c.env.GH_CONFIG_DIR,join(userInfo().homedir,'.config','gh'));assert(!('GH_TOKEN' in c.env));assert(!('GITHUB_TOKEN' in c.env));
  }finally{session?.close();f.close();}
});


test('real push subprocess termination retires transport and retains reconciliation-required intent',async()=>{
  const f=await candidatePublicationFixture({empty:true});try{
    const parentGroup=execFileSync('/bin/ps',['-o','pgid=','-p',String(process.pid)],{encoding:'utf8'}).trim();
    assert.match(parentGroup,/^[1-9][0-9]*$/);
    // Fault injection lives only in the disposable bare server. Never kill the verifier's group.
    mkdirSync(join(f.remote,'hooks'));
    writeFileSync(join(f.remote,'hooks','pre-receive'),`#!/bin/sh
pgid=$(/bin/ps -o pgid= -p $$ | /usr/bin/tr -d ' ')
[ "$pgid" = "${parentGroup}" ] && exit 1
[ "$pgid" -gt 1 ] || exit 1
/bin/kill -TERM -- -"$pgid"
`,{mode:0o755});
    const r=await blocked(f);assert.equal(r.finding,'candidate-publication:cleanup-unresolved');
    assert.equal(r.reconciliationRequired,true);assert.equal(f.o.writes().length,0);
    assert([...f.records.values()][0].some(r=>r.event.kind==='push-attempt'));
    await blocked(f);assert.equal(pushes(f).length,1);
  }finally{f.close();}
});
