import test from 'node:test';
import assert from 'node:assert/strict';
import {unlinkSync,writeFileSync,cpSync} from 'node:fs';
import {join} from 'node:path';
import {coreFixture} from '../tooling/core-fixture.mjs';
import {acceptFixture} from '../tooling/accept-fixture.mjs';
import {codexFixture} from '../tooling/codex-fixture.mjs';
import {chain,fixture} from '../tooling/evidence-fixture.mjs';
import {contentIdentity,coreStages,createAgentLifecycle,selectInstructions,compareEvidence,createProtectedRoleHost,supportedRunnerDefaults,captureWorkspace} from '../src/index.mjs';

// Synthetic retained history. Selected owners still verify actual workspaces,
// lifecycle output, both hook passes, custody and their independent expectations.
function position(f,stage,a) {
  const p=f.pin,c=chain(true),candidate=a?.workspace?.candidate??c.receipts.deliver.inputs.candidate;
  p.candidate=candidate;p.base=candidate.base;p.head='c'.repeat(40);p.transition=null;
  const values={shape:fixture('shape'),'shape-validator':fixture('shape-validator'),...c.receipts};
  const refs={deliver:{publication:'publication'},accept:{hooks:'pre-accept-hooks'},'pre-commit-hooks':{accept:'accept'},
    pr:{accept:'accept',hooks:'pre-commit-hooks'},ci:{pr:'pr'},'shaper-review':{pr:'pr',ci:'ci'},
    merge:{review:'shaper-review'},final:{merge:'merge'},closure:{final:'final'},delivered:{closure:'closure'}};
  const order=coreStages.slice(0,14);p.receipts={};p.evidenceCurrent={};
  for(const s of order) {
    let e=values[s];e.binding={...p.binding};
    e.execution={...e.execution,id:s+'-id',request:s+'-request',result:s+'-result'};
    if(s==='deliver'&&a){e=structuredClone(a.pin.deliver);e.inputs.publication=contentIdentity(values.publication);
      a.pin.deliver=structuredClone(e);a.pin.deliverCurrent.expected=structuredClone(e);}
    if(s==='pre-accept-hooks'&&a)e=structuredClone(a.pin.hooks.stage);
    values[s]=e;
    if('body' in e.inputs)e.inputs.body=p.binding.shapeHash;
    if(e.inputs.candidate)e.inputs.candidate=candidate;
    if('base' in e.inputs)e.inputs.base=p.base;if('head' in e.inputs)e.inputs.head=p.head;
    if(s==='shape-validator')e.inputs.author=values.shape.execution.id;
    if(s==='publication'){e.inputs.author=values.shape.execution.id;e.inputs.validator=values['shape-validator'].execution.id;}
    if(s==='ci')e.inputs.policy=p.binding.policy;
    if(s==='accept')e.inputs.deliver=values.deliver.execution.id;
    if(s==='shaper-review')for(const [k,up] of Object.entries({author:'shape',validator:'shape-validator',deliver:'deliver',accept:'accept'}))e.inputs[k]=values[up].execution.id;
    for(const [k,up] of Object.entries(refs[s]??{}))e.inputs[k]=contentIdentity(values[up]);
    if(s===stage)break;
    p.receipts[s]=e;p.evidenceCurrent[s]={expected:structuredClone(e),consumed:[]};
  }
  p.stageInput=null;p.prior={state:'new'};
}
async function run(f,core) {
  const r=f.request(),inspection=await core.inspect(r);assert(inspection.current,JSON.stringify(inspection));
  r.expected=inspection.current;return core.run(r);
}

test('selected Accept uses actual captured ignored bytes and lifecycle; no publication successor',async()=>{
  const a=await acceptFixture({empty:true,repository:'example-org/core',issueId:'I_101'});
  try {
    const f=coreFixture();f.adopt(a.pin);position(f,'accept',a);
    const core=f.create({accept:a.capabilities});const before=a.snapshot();
    const result=await run(f,core);assert.equal(result.disposition,'completed',JSON.stringify(result));
    assert.equal(result.executed,'accept');assert.equal(result.owner.output.outcome,'accepted');
    assert.equal(a.records.length,1);assert.equal(a.records[0].role,'accept');
    assert.deepEqual(a.snapshot(),before);assert.deepEqual(a.records[0].input.processEnvironment,{});
    f.pin.receipts.accept=result.owner.output.evidence;f.pin.evidenceCurrent.accept={expected:result.owner.output.evidence,consumed:[]};
    f.pin.invocation={request:'hooks-request',run:{id:'201',attempt:'1'}};
    const hookInput={...a.hookInput,phase:'pre-commit',executionId:'second',firstExecutionId:'first',first:a.first.receipt,
      firstReceiptCurrent:a.pin.hooks.receiptCurrent,firstStage:a.pin.hooks.stage,firstStageCurrent:a.pin.hooks.stageCurrent,
      firstStageIdentity:contentIdentity(a.pin.hooks.stage),accept:result.owner.output.evidence,
      acceptCurrent:a.evidenceCurrent(result.owner.output.evidence.execution.id)};
    const hooks=f.create({hooks:{image:a.runner.profile.image,socket:'/run/user/1000/docker.sock',
      process:async()=>{throw Error('empty inventory must not launch Docker');}},hookInput:()=>hookInput});
    const second=await run(f,hooks);assert.equal(second.executed,'pre-commit-hooks');
    assert.equal(second.disposition,'completed',JSON.stringify(second));assert.equal(second.owner.output.receipt.status,'not-applicable');
    assert.equal(a.records.length,1);assert.deepEqual(a.snapshot(),before);
  }finally{a.close();}
});

test('selected Accept cannot omit ignored artifacts, change Candidate, skip hooks or replay results',async()=>{
  for(const fault of ['missing','tampered','hooks','candidate','replay','role','nonzero','absent']) {
    const a=await acceptFixture({empty:true,repository:'example-org/core',issueId:'I_101'});
    try{
      const f=coreFixture();f.adopt(a.pin);position(f,'accept',a);const core=f.create({accept:{...a.capabilities,workspace:()=>a.recapture()}});
      if(fault==='missing')unlinkSync(join(a.root,'ignored'));
      if(fault==='tampered')writeFileSync(join(a.root,'ignored'),'changed bytes');
      if(fault==='hooks')a.pin.hooks.receiptCurrent.identity='b'.repeat(64);
      if(fault==='candidate')a.pin.workspace.candidate.base='b'.repeat(40);
      if(fault==='nonzero')a.state.exitCode=1;
      else if(['replay','role','absent'].includes(fault))a.state.fault=fault;
      const result=await run(f,core);assert.notEqual(result.disposition,'completed',fault);
      assert.equal(result.executed,'accept');assert(a.records.length<=1);
    }finally{a.close();}
  }
});

test('entry Candidate must match the Accept owner before any role launch',async()=>{
  for(const fault of ['tree','base','artifacts']) {
    const a=await acceptFixture({empty:true,repository:'example-org/core',issueId:'I_101'});
    try {
      const f=coreFixture();f.adopt(a.pin);position(f,'accept',a);
      // Change only the entry chain; retain the owner's independently valid bytes.
      const candidate=structuredClone(f.pin.candidate);
      if(fault==='artifacts')candidate.artifacts[0].digest='d'.repeat(64);
      else candidate[fault]='d'.repeat(40);
      f.pin.candidate=candidate;f.pin.base=candidate.base;
      for(const stage of ['deliver','pre-accept-hooks']) {
        f.pin.receipts[stage]=structuredClone(f.pin.receipts[stage]);
        f.pin.receipts[stage].inputs.candidate=candidate;
        f.pin.evidenceCurrent[stage].expected=structuredClone(f.pin.receipts[stage]);
      }
      const before=a.snapshot(),v=await run(f,f.create({accept:a.capabilities}));
      assert.notEqual(v.disposition,'completed',fault);
      assert.equal(a.records.length,0,fault);assert.deepEqual(a.snapshot(),before);
    }finally{a.close();}
  }
});

test('first hook pass is a separate actual owner invocation and preserves Candidate bytes',async()=>{
  const a=await acceptFixture({empty:true,repository:'example-org/core',issueId:'I_101'});
  try{
    const f=coreFixture();f.adopt(a.pin);position(f,'pre-accept-hooks',a);const before=a.snapshot();
    const wrong=f.create({hooks:{image:a.runner.profile.image,socket:'/run/user/1000/docker.sock'},hookInput:()=>({...a.hookInput,phase:'pre-commit'})});
    assert.notEqual((await run(f,wrong)).disposition,'completed');
    const core=f.create({hooks:{image:a.runner.profile.image,socket:'/run/user/1000/docker.sock'},hookInput:()=>a.hookInput});
    const result=await run(f,core);assert.equal(result.executed,'pre-accept-hooks');assert.equal(result.disposition,'completed',JSON.stringify(result));
    assert.equal(a.records.length,0);assert.deepEqual(a.snapshot(),before);
  }finally{a.close();}
});

test('Deliver binds the complete selected publication before Writer launch and captures the Candidate',async()=>{
  for(const mismatch of [false,true]) {
  const a=await acceptFixture({empty:true,repository:'example-org/core',issueId:'I_101'});
  try{
    const f=coreFixture();f.adopt(a.pin);position(f,'deliver',a);
    const b={...f.pin.binding,instructions:selectInstructions({skill:'deliver',role:'deliver'}).identity};
    const pin={...a.pin,capture:Object.fromEntries(['root','base','permittedPaths','binding'].map(k=>[k,a.captureInput[k]])),binding:b,publication:f.pin.receipts.publication,publicationCurrent:f.pin.evidenceCurrent.publication};
    if(mismatch){pin.publication=structuredClone(pin.publication);pin.publication.inputs.readback='b'.repeat(64);
      pin.publicationCurrent={expected:structuredClone(pin.publication),consumed:[]};}
    assert.equal(compareEvidence(pin.publication,pin.publicationCurrent).stage,'publication');
    assert.equal(contentIdentity(pin.publication)===contentIdentity(f.pin.receipts.publication),!mismatch);
    const e={role:'deliver',skill:'deliver',id:'new-writer',request:'writer-request',result:'writer-result',source:null};
    const receipt={version:1,stage:'deliver',binding:b,execution:e,
      inputs:{publication:contentIdentity(pin.publication),candidate:a.workspace.candidate},
      result:{version:1,outcome:'ready',failureClass:'none',summary:'recorded writer',conflicts:[]}};
    const expected={expected:receipt,consumed:[]};let starts=0;
    const backend={readiness:async()=>({login:'available',tool:'available',isolation:'verified',read:'verified',write:'verified',evidence:['recording'],limitations:[]}),
      start:async()=>{starts++;return {status:'started'};},collect:async()=>({status:'complete',exitCode:0,evidence:receipt}),
      termination:async()=>({status:'terminated'}),stop:async()=>({status:'requested'}),cleanup:async()=>({status:'completed',residuals:[]})};
    const lifecycle=createAgentLifecycle({environment:{id:'writer-env',agent:'recording',loginSpace:'/fixture/login',
      instances:[{id:'writer-instance',workspace:a.root,registration:'/fixture/registration',service:'/fixture/service'}]},
      instanceId:'writer-instance',backend,
      startCurrent:()=>({expected:{stage:'deliver',execution:e,binding:b,result:receipt.result},consumed:[]}),
      current:()=>{assert.equal(starts,1,'Candidate expectations must not be requested before Writer starts');return expected;}});
    const core=f.create({deliver:{current:()=>structuredClone(pin),captureInput:()=>a.captureInput,evidenceCurrent:()=>expected,
      prepareRole:async({instructions,role,skill})=>{assert.equal(role,'deliver');assert.equal(skill,'deliver');
        return {lifecycle,input:{execution:e,binding:b,instructions:{identity:instructions.identity,content:instructions.content},visibility:'public',ownership:'personal'}};}}});
    const result=await run(f,core);
    if(mismatch){assert.notEqual(result.disposition,'completed');assert.equal(starts,0);continue;}
    assert.equal(result.disposition,'completed',JSON.stringify(result));
    assert.equal(starts,1);assert.equal(result.executed,'deliver');assert.equal(a.records.length,0);
    assert.deepEqual(result.owner.output.evidence.inputs.candidate,a.workspace.candidate);
  }finally{a.close();}
  }
});

import {candidatePublicationFixture} from '../tooling/candidate-publication-fixture.mjs';
import {finalReviewFixture} from '../tooling/final-review-fixture.mjs';
import {completionFixture} from '../tooling/completion-fixture.mjs';
import {recoveryFixture} from '../tooling/recovery-fixture.mjs';
import {repairFixture} from '../tooling/repair-fixture.mjs';
import {fanoutFixture} from '../tooling/fanout-fixture.mjs';
import {ciFixture} from './ci-fixture.mjs';

test('CI, deployment and fanout retain denied prerequisites',async()=>{
  const fanout=fanoutFixture();
  const f=coreFixture();f.pin.shapeBody=f.sh.body;f.pin.binding.shapeHash=(await import('../src/index.mjs')).bodyDigest(f.sh.body);
  position(f,'fanout');f.sf.routes[f.sf.issuePath].body=f.pin.shapeBody;f.pin.stageInput={...fanout.input,source:f.pin.target};
  fanout.state.denied.add(fanout.c.issueId);fanout.state.denied.add(fanout.d.issueId);
  const noWake=await run(f,f.create({fanout:fanout.options}));assert.equal(noWake.executed,'fanout');
  assert.notEqual(noWake.disposition,'completed');assert.equal(fanout.writes().length,0);
  for(const stage of ['ci','final']){
    const x=coreFixture();x.pin.shapeBody=x.sh.body;x.pin.binding.shapeHash=(await import('../src/index.mjs')).bodyDigest(x.sh.body);
    position(x,stage);x.sf.routes[x.sf.issuePath].body=x.pin.shapeBody;
    const ci=ciFixture();x.pin.stageInput=stage==='ci'?{expected:{...ci.expected,repositoryId:x.pin.target.repositoryId,head:x.pin.head,baseSha:x.pin.base},actions:[ci.pin]}:
      {policy:{mode:'required'},observation:null,health:null};
    const v=await run(x,x.create({ci:{provider:ci.provider}}));assert.equal(v.executed,stage);
    assert.notEqual(v.disposition,'completed');
  }
});

// Configure authority before any receipt/link is constructed; never rewrite
// producer hashes or their independent expectations after collection.
function eligible(f,pin,stage) {
  const aliases={author:'shape',validator:'shape-validator',secondStage:'pre-commit-hooks'};
  const values={...pin.receipts,...Object.fromEntries(Object.entries(pin.evidence??{})
    .filter(([,v])=>v.value).map(([k,v])=>[aliases[k]??k,v.value]))};
  values['pre-accept-hooks']??=pin.hooks?.firstStage;values['shaper-review']??=pin.review?.value;
  for(const [s,key] of [['shape','author'],['shape-validator','validator']])if(!values[s]) {
    const e=fixture(s);e.binding={...f.pin.binding};e.inputs.body=f.pin.binding.shapeHash;
    e.execution.id=values.publication?.inputs[key]??s+'-id';e.execution.request=s+'-request';
    if(s==='shape-validator')e.inputs.author=values.shape.execution.id;values[s]=e;
  }
  Object.assign(f.pin,{receipts:{},evidenceCurrent:{},candidate:values.deliver?.inputs.candidate??null,
    head:values.pr?.inputs.head??pin.observation?.head??null,base:values.deliver?.inputs.candidate.base??null,
    transition:['repair','recovery'].includes(stage)?stage:null,stageInput:stage==='repair'?pin.raw??null:null});
  for(const s of coreStages.slice(0,14)){if(s===stage||f.pin.transition)break;
    assert(values[s],s);f.pin.receipts[s]=values[s];f.pin.evidenceCurrent[s]={expected:structuredClone(values[s]),consumed:[]};}
  f.sf.routes[f.sf.issuePath].body=f.pin.receipts.publication?f.pin.shapeBody:f.pin.scopeBody;
}

function successorGuards(key,successors) {return Object.fromEntries(['shape','deliver','accept','publication','review','merge','completion','recovery','repair','fanout','ci']
        .filter(k=>k!==key).map(k=>{const stop=()=>{successors.push(k);throw Error('unexpected successor');};
          Object.assign(stop,Object.fromEntries('eligibility evaluate request collection open locate retain retrieve'.split(' ').map(n=>[n,stop])));
          return [k,Object.fromEntries('current workspace captureInput prepareRole readBody operations evidenceCurrent obligations provider authorization dependencies history git observe custody publication locate stageCurrent postMerge authenticate installInvalidation classify repairAuthorization authorize retain retrieve mergeCurrent currentSource retrieveReceipt currentTarget'.split(' ').map(n=>[n,stop]))];}));}

test('eligible later stages preserve actual owner outputs and selected evidence without successors',async()=>{
  for(const stage of ['pr','shaper-review','merge','closure','delivered','recovery','repair']) {
    const f=coreFixture(),configure=p=>f.adopt(p);let a,key,config;
    if(stage==='pr'){a=await candidatePublicationFixture({empty:true,configure});key='publication';config=a.capabilities;}
    if(['shaper-review','merge'].includes(stage)){a=await finalReviewFixture({configure});key=stage==='merge'?'merge':'review';config=stage==='merge'?a.mergeCaps:a.capabilities;
      if(stage==='merge'){assert.equal((await a.approve()).outcome,'approved');}}
    if(['closure','delivered'].includes(stage)){a=await completionFixture(undefined,configure);key='completion';config=a.capabilities;
      if(stage==='delivered')assert.equal((await a.fresh().close()).outcome,'closed');}
    if(stage==='recovery'){a=await recoveryFixture(false,configure);key='recovery';config=a.caps;}
    if(stage==='repair'){a=await repairFixture(configure);key='repair';config=a.caps;}
    try {
      eligible(f,stage==='delivered'?{...a.pin,receipts:{...a.pin.receipts,closure:a.state.closure}}:a.pin,stage);if(stage==='repair')f.pin.stageInput=a.raw;
      if(stage==='merge'){f.pin.receipts['shaper-review']=a.pin.review.value;f.pin.evidenceCurrent['shaper-review']=a.pin.review.current;}
      const seen=[],successors=[],other=successorGuards(key,successors);
      const owner={...config,current:async()=>{const p=await config.current();seen.push(structuredClone(p));return p;}};
      const record=stage==='pr'?a.pin.evidence.accept:stage==='shaper-review'?a.pin.evidence.ci:null;
      const state=stage==='merge'?a.ops.state:stage==='recovery'?a.local:a.state;
      const flag=stage==='merge'?'allowed':stage==='recovery'?'authenticated':stage==='repair'?'authorized':'auth';
      if(record)record.current.consumed=[record.value.execution.result];else state[flag]=false;
      const denied=await run(f,f.create({...other,[key]:owner}));assert.equal(denied.executed,stage);assert.notEqual(denied.disposition,'completed');
      if(stage==='pr')assert.equal(a.o.writes().length,0);if(stage==='merge')assert.equal(a.ops.writes().length,0);
      if(['closure','delivered'].includes(stage))assert.equal(a.label.writes().length,0);if(stage==='repair')assert.equal(a.saved.length,0);
      if(record)record.current.consumed=[];else state[flag]=true;
      f.pin.invocation={request:'eligible-request',run:{id:'101',attempt:'1'}};
      const v=await run(f,f.create({...other,[key]:owner}));
      assert.equal(v.executed,stage,JSON.stringify(v));assert.equal(v.disposition,'completed',JSON.stringify(v));
      assert.equal(v.owner.identity,contentIdentity(v.owner.output));assert(seen.length>0);assert.deepEqual(successors,[]);
      for(const p of seen){assert.equal(p.binding.grant,f.pin.binding.grant);assert.equal(p.binding.scopeHash,f.pin.binding.scopeHash);
        for(const [k,item] of Object.entries(p.evidence??{})){const s=({author:'shape',validator:'shape-validator',secondStage:'pre-commit-hooks'})[k]??k;
          if(item.value&&f.pin.receipts[s])assert.deepEqual(item.value,f.pin.receipts[s]);}
        for(const [s,e] of Object.entries(p.receipts??{}))assert.deepEqual(e,f.pin.receipts[s]);}
      const expected={pr:'published','shaper-review':'approved',merge:'merged',closure:'closed',delivered:'completed',recovery:'handoff',repair:'handoff'};
      assert.equal(v.owner.output.outcome,expected[stage]);
      if(stage==='pr'){assert.equal(v.owner.output.value.accept,contentIdentity(f.pin.receipts.accept));assert.equal(a.o.writes().length,1);}
      if(stage==='shaper-review')assert.deepEqual(v.owner.output.evidence.inputs.pr,contentIdentity(f.pin.receipts.pr));
      if(stage==='merge')assert.equal(v.owner.output.evidence.inputs.review,contentIdentity(f.pin.receipts['shaper-review']));
      if(stage==='closure')assert.equal(a.label.writes().length,0);
      if(stage==='delivered')assert.equal(v.owner.output.receipt.payload.receipts.final.inputs.merge,contentIdentity(f.pin.receipts.merge));
      if(stage==='recovery')assert.deepEqual(v.owner.output.record.next,a.pin.next);
      if(stage==='repair')assert.deepEqual(v.owner.output.record.reporter,a.raw.execution);
    }finally{if(typeof a.close==='function')a.close();}
  }
});

test('eligible CI, deployment and fanout preserve exact inputs and successful owner dispositions',async t=>{
  const {createServer}=await import('node:http'),{once}=await import('node:events');
  let contacts=0;const server=createServer((req,res)=>{contacts++;res.end('healthy');});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  for(const stage of ['ci','final','fanout']) {
    const f=coreFixture();f.pin.shapeBody=f.sh.body;f.pin.binding.shapeHash=(await import('../src/index.mjs')).bodyDigest(f.sh.body);
    position(f,stage);f.sf.routes[f.sf.issuePath].body=f.pin.shapeBody;const successors=[];
    const ci=ciFixture(()=>{},{head:f.pin.head,baseSha:f.pin.base,repositoryId:f.pin.target.repositoryId});
    const fanout=stage==='fanout'?fanoutFixture(f.pin.target,p=>f.adopt(p)):fanoutFixture(),url=`http://127.0.0.1:${server.address().port}/health`;
    if(stage==='fanout'){const receipt=fanout.completions.get(f.pin.target.issueId);eligible(f,{receipts:receipt.payload.receipts},stage);
      f.pin.completion=receipt;f.pin.completionCurrent=fanout.contexts.get(f.pin.target.issueId);f.sf.routes[f.sf.issuePath].state='closed';}
    const policy={mode:'required',reason:'Synthetic service',repositoryId:'42',commit:f.pin.receipts.merge?.inputs.commit??'d'.repeat(40),
      version:'1',environment:'production',deploymentId:'3',statusId:'4',baseline:'baseline',maxAgeMs:10000,
      source:{repositoryId:'42',workflow:'.github/workflows/deploy.yml',runId:'7',attempt:'1'},checks:[{url,status:200,body:'healthy'}]};
    f.pin.stageInput=stage==='ci'?{expected:ci.expected,actions:[ci.pin]}:stage==='fanout'?fanout.input:
      {policy,observation:{...policy,state:'success',observedAt:Date.now()},health:{allowlist:[url],checks:policy.checks,timeoutMs:1000,maxBytes:32,maxRequests:1}};
    if(stage==='fanout'){fanout.state.denied=new Set([fanout.c.issueId,fanout.d.issueId]);
      assert.notEqual((await run(f,f.create({fanout:fanout.options}))).disposition,'completed');assert.equal(fanout.writes().length,0);fanout.state.denied.clear();}
    if(stage==='final'){const selected=structuredClone(f.pin.stageInput);
      for(const [key,value] of [['commit','f'.repeat(40)],['repositoryId','999']]){
        f.pin.stageInput=structuredClone(selected);f.pin.stageInput.policy[key]=value;f.pin.stageInput.observation[key]=value;
        const before=contacts,bad=await run(f,f.create(successorGuards(null,successors)));
        assert.equal(bad.executed,'final');assert.notEqual(bad.disposition,'completed',key);assert.notEqual(bad.owner?.output.status,'qualified');
        assert.equal(contacts,before,'foreign deployment must not contact health endpoint');assert.deepEqual(successors,[]);
      }f.pin.stageInput=selected;}
    const input=structuredClone(f.pin.stageInput),v=await run(f,f.create({...successorGuards(null,successors),ci:{provider:ci.provider},...(stage==='fanout'?{fanout:fanout.options}:{}),
      hookInput:()=>{successors.push('hooks');throw Error('successor');}}));
    assert.equal(v.executed,stage,JSON.stringify(v));assert.equal(v.disposition,'completed',JSON.stringify(v));assert.deepEqual(f.pin.stageInput,input);assert.equal(v.inputs.stageInput,contentIdentity(input));
    assert.equal(v.owner.identity,contentIdentity(v.owner.output));assert.deepEqual(successors,[]);
    if(stage==='ci'){assert.equal(v.owner.output.status,'satisfied');assert.equal(v.owner.output.qualifies,true);assert(ci.calls.every(c=>c.method==='GET'));}
    if(stage==='final'){assert.equal(v.owner.output.status,'qualified');assert.equal(v.owner.output.proof.mode,'required');assert.equal(fanout.writes().length,0);
      f.pin.stageInput={policy:{mode:'not-applicable',reason:'Synthetic policy has no deployment obligation'}};const na=await run(f,f.create(successorGuards(null,successors)));
      assert.equal(na.disposition,'completed');assert.equal(na.owner.output.status,'not-applicable');assert.deepEqual(successors,[]);}
    if(stage==='fanout'){assert.equal(v.inputs.completion,fanout.completions.get(f.pin.target.issueId).identity);assert.deepEqual(v.owner.output.outcomes.map(o=>o.outcome),['confirmed-success','confirmed-success']);
      assert.equal(fanout.writes().length,2);for(const r of fanout.requests.values())assert.equal(r.origin.identity,fanout.completions.get(f.pin.target.issueId).identity);}
  }
});


test('Core Deliver captures real Writer edits after termination and hands off only the trusted Candidate',async()=>{
  for(const agent of ['codex','claude','gemini']) for(const fault of ['none','unchanged','candidate','publication','binding','execution','inputs','result','expectation','replay']) {
    const a=await acceptFixture({empty:true,repository:'example-org/core',issueId:'I_101'}),fixtures=[];
    try {
      const f=coreFixture();f.adopt(a.pin);position(f,'deliver',a);
      const instructions=selectInstructions({role:'deliver',skill:'deliver'});
      const binding={...f.pin.binding,instructions:instructions.identity};
      const pin={...a.pin,binding,capture:Object.fromEntries(['root','base','permittedPaths','binding'].map(k=>[k,a.captureInput[k]])),
        publication:f.pin.receipts.publication,publicationCurrent:f.pin.evidenceCurrent.publication};
      const profiles=[];
      for(const role of ['shape','shape-validator','shape-diagnosis','shaper-review','deliver','accept']) {
        const fixture=codexFixture(role,undefined,agent);fixtures.push(fixture);
        fixture.environment.id=role+'-environment';
        fixture.environment.instances.forEach((i,n)=>i.id=role+'-instance-'+n);
        fixture.config.instanceId=role+'-instance-0';
        const {process:ignored,task,...backend}=fixture.config;
        profiles.push({id:role,agent,os:'linux',backend});
      }
      const writer=fixtures.find(x=>x.input.execution.role==='deliver'),execution=writer.input.execution;
      cpSync(a.root,writer.environment.instances[0].workspace,{recursive:true});
      a.captureInput.root=writer.environment.instances[0].workspace;pin.capture.root=a.captureInput.root;
      const initial=structuredClone(a.workspace.candidate),launchInputs={publication:contentIdentity(pin.publication),candidate:initial};
      Object.assign(writer.expected.result,{summary:'Writer completed actual file edit'});
      if(fault!=='unchanged')writer.flags.edit={path:'binary',content:'post-launch Writer bytes'};
      if(['candidate','publication','binding','execution','inputs','result'].includes(fault))writer.flags.mutateCollected=e=>{
        if(fault==='candidate')e.inputs.candidate.tree='f'.repeat(40);
        if(fault==='publication')e.inputs.publication='f'.repeat(64);
        if(fault==='binding')e.binding.policy='f'.repeat(64);
        if(fault==='execution')e.execution.id='foreign-writer';
        if(fault==='inputs')delete e.inputs;
        if(fault==='result')e.result={authorized:true};
      };
      let prepared,captures=0;
      const expected=()=>({expected:{version:1,stage:'deliver',execution,binding,
        inputs:{...launchInputs,candidate:fault==='expectation'?initial:captureWorkspace(a.captureInput).candidate},
        result:writer.expected.result},consumed:fault==='replay'?[execution.result]:[]});
      const host=createProtectedRoleHost({configuration:{runner:{version:1,platform:'linux',arch:'x64',account:{user:'member',uid:1000,githubUserId:'42'},
        path:supportedRunnerDefaults.path,interpreter:supportedRunnerDefaults.interpreter,work:'/fixture/work',scratch:'/fixture/scratch',cache:'/fixture/cache'},
        profiles,assignments:Object.fromEntries(profiles.map(p=>[p.id,p.id]))},
        probe:async()=>({status:'verified',userId:'42'}),observe:()=>({platform:'linux',arch:'x64',user:'member',uid:1000,tokenOverride:false,roots:{work:true,scratch:true,cache:true}}),
        retain:async()=> 'custody:writer',process:writer.config.process,bind:async task=>({
          input:{...writer.input,binding,instructions:{identity:task.instructions.identity,content:task.instructions.content}},
          current:expected,startCurrent:()=>({expected:{stage:'deliver',execution,binding,result:writer.expected.result},consumed:[]}),
          resultContext:()=>pin,deadlineAt:Date.now()+360000,reserveMs:30000,prompt:'Edit binary in the approved workspace',inputs:launchInputs})});
      const owners=host.owners({deliver:{current:()=>structuredClone(pin),captureInput:()=>{captures++;return a.captureInput;},evidenceCurrent:expected}});
      const prepare=owners.deliver.prepareRole;
      owners.deliver.prepareRole=async task=>{
        prepared=await prepare(task);
        await assert.rejects(prepared.bindCandidate(initial),'handoff before launch must fail');
        return prepared;
      };
      const runtime=f.create(owners);
      let result=await run(f,runtime);
      for(let n=0;n<100&&result.disposition!=='completed'&&captures===0;n++) {
        await new Promise(r=>setTimeout(r,10));
        f.pin.prior={state:'unresolved',stage:'deliver',request:f.request()};result=await run(f,runtime);
      }
      // Reconciliation is driven by the same Core owner/run, never a second launch.
      if(result.disposition!=='completed'&&captures===0)throw Error(JSON.stringify(result));
      const good=['none','unchanged'].includes(fault);
      assert.equal(result.disposition==='completed',good,JSON.stringify({agent,fault,result}));
      assert.equal(writer.calls.filter(c=>c.args.at(-1)==='execute').length,1);
      if(good) {
        const candidate=result.owner.output.evidence.inputs.candidate;
        assert.deepEqual(candidate,captureWorkspace(a.captureInput).candidate);
        assert.equal(candidate.tree===initial.tree,fault==='unchanged');
        assert.equal(result.owner.output.workspace.metadata.tree,candidate.tree);
        await assert.rejects(prepared.bindCandidate({...candidate,tree:'f'.repeat(40)}),/candidate-rebinding/);
      }
      await prepared.lifecycle.cleanup();
    }finally{a.close();for(const fixture of fixtures)await fixture.dispose();}
  }
});

test('grouped approved Owner history permits a fresh dispatched Accept, never reuse of a historical Run',async()=>{
  const a=await acceptFixture({empty:true,repository:'example-org/core',issueId:'I_101'});
  try{
    const f=coreFixture();f.adopt(a.pin);position(f,'accept',a);
    assert.equal(f.pin.receipts.shape.execution.source.runId,f.pin.receipts['shape-validator'].execution.source.runId);
    const history=structuredClone(f.pin.receipts);
    f.pin.invocation.run.id=f.pin.receipts.shape.execution.source.runId;
    assert.equal((await f.create({accept:a.capabilities}).inspect(f.request())).disposition,'blocked');
    f.pin.invocation.run.id='999';
    const result=await run(f,f.create({accept:a.capabilities}));
    assert.equal(result.disposition,'completed',JSON.stringify(result));assert.equal(result.executed,'accept');
    assert.deepEqual(f.pin.receipts,history);
  }finally{a.close();}
});
