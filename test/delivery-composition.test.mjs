// One credential-free public Core path. External model/GitHub/Docker transports
// are fixtures; every selected planner/stage/custody/Git/Hook owner is maintained.
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {coreFixture} from '../tooling/core-fixture.mjs';
import {acceptFixture} from '../tooling/accept-fixture.mjs';
import {candidatePublicationFixture} from '../tooling/candidate-publication-fixture.mjs';
import {finalReviewFixture} from '../tooling/final-review-fixture.mjs';
import {completionFixture} from '../tooling/completion-fixture.mjs';
import {createAgentLifecycle,selectInstructions,bodyDigest,contentIdentity,coreStages} from '../src/index.mjs';
const copy=structuredClone;

test('one composed delivery uses actual predecessor outputs through independent roles, both Hook checkpoints, rebase and factual completion',async()=>{
  const f=coreFixture(),shapeBinding=f.sh.pin.binding,order=[],processes=[];
  const a=await acceptFixture({empty:false,rich:true,child:true,deferHooks:true,ownership:'organization',repository:'example-org/core',issueId:'I_101',configure:p=>f.adopt(p)});
  let published,reviewed;
  try {
    // Align the trusted fixture adapters to one Scope and one signed authority;
    // no predecessor result or successful receipt is installed here.
    Object.assign(shapeBinding,a.pin.binding);f.pin.binding=shapeBinding;f.pin.shapeBody=null;shapeBinding.shapeHash=null;
    f.sh.pin.original={kind:'raw-scope',body:a.pin.scopeBody,hash:bodyDigest(a.pin.scopeBody)};
    f.sh.pin.binding=shapeBinding;f.sh.state.body=a.pin.scopeBody;f.sh.state.proposal=a.pin.shapeBody;
    Object.assign(f.sh.observation,a.pin.obligations);f.sf.routes[f.sf.issuePath].body=a.pin.scopeBody;
    assert.equal(a.first,null);assert.equal(a.records.length,0);assert.deepEqual(f.pin.receipts,{});
    let n=100;
    const stageReceipt=(stage,inputs,result=null)=>({version:1,stage,binding:{...f.pin.binding},
      execution:{role:'deliver',skill:'deliver',id:stage+'-operation',request:stage+'-operation-request',result:stage+'-operation-result',source:null},inputs,result});
    const retain=e=>{f.pin.receipts[e.stage]=copy(e);f.pin.evidenceCurrent[e.stage]={expected:copy(e),consumed:[]};};
    async function execute(stage,owners={}) {
      f.pin.invocation={request:stage+'-request',run:{id:String(n++),attempt:'1'}};
      const core=f.create(owners),r=f.request(),inspection=await core.inspect(r);
      assert.equal(inspection.current?.stage,stage,JSON.stringify(inspection));r.expected=inspection.current;
      const result=await core.run(r);assert.equal(result.disposition,'completed',JSON.stringify(result));assert.equal(result.executed,stage);
      order.push(stage);return result.owner.output;
    }
    const authored=await execute('shape');retain(authored.author.receipt);
    f.pin.shapeBody=authored.author.body;f.pin.binding.shapeHash=bodyDigest(f.pin.shapeBody);f.pin.stageInput=authored;
    const validated=await execute('shape-validator');retain(validated.validator.receipt);f.pin.stageInput=validated;
    const publication=await execute('publication');
    retain(stageReceipt('publication',{body:f.pin.binding.shapeHash,author:authored.author.receipt.execution.id,
      validator:validated.validator.receipt.execution.id,validation:contentIdentity(validated.validator.receipt),readback:contentIdentity(publication.publication)}));
    f.sf.routes[f.sf.issuePath].body=f.pin.shapeBody;
    assert.equal(f.sh.records.length,2);assert.equal(a.records.length,0);

    const selected=selectInstructions({role:'deliver',skill:'deliver'}),binding={...a.pin.binding,instructions:selected.identity};
    const execution={role:'deliver',skill:'deliver',id:'writer',request:'writer-request',result:'writer-result',source:null};
    const writerPin={...a.pin,binding,capture:Object.fromEntries(['root','base','permittedPaths','binding'].map(k=>[k,a.captureInput[k]])),
      publication:f.pin.receipts.publication,publicationCurrent:f.pin.evidenceCurrent.publication};
    let started=false;
    const writerEvidence=()=>({version:1,stage:'deliver',binding,execution,
      inputs:{publication:contentIdentity(writerPin.publication),candidate:a.recapture().candidate},
      result:{version:1,outcome:'ready',failureClass:'none',summary:'Actual fixture Writer edit',conflicts:[]}});
    const expected=()=>({expected:writerEvidence(),consumed:[]});
    const backend={readiness:async()=>({login:'available',tool:'available',isolation:'verified',read:'verified',write:'verified',evidence:['fixture-process'],limitations:['No live isolation certification']}),
      start:async()=>{assert.equal(started,false);started=true;processes.push('writer');writeFileSync(join(a.root,'binary'),Buffer.from([0,255,3,1,0]));return {status:'started'};},
      collect:async()=>({status:'complete',exitCode:0,evidence:writerEvidence()}),termination:async()=>({status:'terminated'}),
      stop:async()=>({status:'requested'}),cleanup:async()=>({status:'completed',residuals:[]})};
    const lifecycle=createAgentLifecycle({environment:{id:'writer-env',agent:'recording',loginSpace:'/fixture/writer/login',instances:[
      {id:'writer-instance',workspace:a.root,registration:'/fixture/writer/reg',service:'/fixture/writer/service'}]},instanceId:'writer-instance',backend,
      startCurrent:()=>({expected:{stage:'deliver',execution,binding,result:writerEvidence().result},consumed:[]}),current:expected});
    f.pin.base=a.captureInput.base;f.pin.stageInput=null;
    const delivery=await execute('deliver',{deliver:{current:()=>copy(writerPin),captureInput:()=>a.captureInput,evidenceCurrent:expected,
      prepareRole:async({instructions})=>({lifecycle,input:{execution,binding,instructions:{identity:instructions.identity,content:instructions.content},visibility:'public',ownership:'organization'}})}});
    retain(delivery.evidence);a.pin.deliver=copy(delivery.evidence);a.pin.deliverCurrent={expected:copy(delivery.evidence),consumed:[]};
    f.pin.candidate=a.workspace.candidate;a.refreshHookInput();
    assert.equal(started,true);assert.equal(a.records.length,0);
    const first=await execute('pre-accept-hooks',{hooks:a.hookConfiguration,hookInput:()=>a.hookInput});
    const firstStage=stageReceipt('pre-accept-hooks',{candidate:f.pin.candidate,phase:'pre-accept',receipt:first.receipt.identity});
    retain(firstStage);a.installFirst(first,firstStage);
    const accepted=await execute('accept',{accept:a.capabilities});retain(accepted.evidence);
    assert.equal(a.records.length,1);assert(a.events.includes('child-serialized'));processes.push('accept');
    const secondInput={...a.hookInput,phase:'pre-commit',executionId:'second',firstExecutionId:'first',first:first.receipt,
      firstReceiptCurrent:a.pin.hooks.receiptCurrent,firstStage,firstStageCurrent:a.pin.hooks.stageCurrent,
      firstStageIdentity:contentIdentity(firstStage),accept:accepted.evidence,acceptCurrent:a.evidenceCurrent(accepted.evidence.execution.id)};
    const second=await execute('pre-commit-hooks',{hooks:a.hookConfiguration,hookInput:()=>secondInput});
    const secondStage=stageReceipt('pre-commit-hooks',{candidate:f.pin.candidate,phase:'pre-commit',accept:contentIdentity(accepted.evidence),receipt:second.receipt.identity});retain(secondStage);
    assert.notEqual(first.receipt.binding.executionId,second.receipt.binding.executionId);
    published=await candidatePublicationFixture({ownership:'organization',a,accepted,second,shape:{
      author:authored.author.receipt,validator:validated.validator.receipt,publication:f.pin.receipts.publication,secondStage}});
    assert.equal(published.o.writes().length,0);
    const pr=await execute('pr',{publication:published.capabilities});f.pin.head=pr.value.commit;
    reviewed=await finalReviewFixture({ownership:'organization',published,publication:pr,ciObservation:'github-repository'});
    retain(reviewed.pin.evidence.pr.value);
    f.pin.stageInput={expected:reviewed.pin.observation.ci.expected};
    const ci=await execute('ci',{ci:{provider:reviewed.provider,mode:'github-repository'}});
    // Repository-controlled CI remains a factual observation, never a fabricated
    // pass. Explicit source-policy proof is covered by the separate CI contracts.
    assert.equal(ci.qualifies,false);assert.equal(ci.status,'pending');
    assert.deepEqual(ci,reviewed.pin.observation.ci);retain(reviewed.pin.evidence.ci.value);f.pin.stageInput=null;
    const review=await execute('shaper-review',{review:reviewed.capabilities});retain(review.evidence);processes.push('shaper-review');
    reviewed.pin.review={value:review.evidence,current:{expected:copy(review.evidence),consumed:[]},context:review.context};
    const merge=await execute('merge',{merge:reviewed.mergeCaps});retain(merge.evidence);
    assert.equal(JSON.parse(reviewed.ops.writes()[0].body).merge_method,'rebase');assert.equal(reviewed.ops.writes().length,1);
    const disposition={mode:'not-applicable',reason:'Explicit authorized source-only fixture: no deployment obligation'};
    f.pin.stageInput={policy:disposition};const final=await execute('final');
    retain(stageReceipt('final',{merge:contentIdentity(merge.evidence),commit:merge.evidence.inputs.commit,
      postMerge:{mode:'not-applicable',identities:[],reason:'No post-merge checks in synthetic policy'},deployment:final.proof}));
    f.pin.stageInput=null;
    const receipts=Object.fromEntries(coreStages.slice(2,12).map(s=>[s,f.pin.receipts[s]]));
    const completion=await completionFixture(undefined,undefined,{receipts,target:{...f.pin.target,cycle:published.pin.target.cycle},
      ownership:'organization',scopeBody:a.pin.scopeBody,shapeBody:a.pin.shapeBody,candidate:a.workspace.expected.identity,mergeOperation:merge.operation});
    const closure=await execute('closure',{completion:completion.capabilities});retain(closure.evidence);
    assert.equal(completion.label.writes().length,0);f.sf.routes[f.sf.issuePath].state='closed';
    const complete=await execute('delivered',{completion:completion.capabilities});
    assert.equal(complete.outcome,'completed');assert.equal(completion.close.writes().length,1);assert.equal(completion.label.writes().length,1);
    assert.equal(complete.receipt.payload.receipts.merge.inputs.commit,merge.evidence.inputs.commit);
    assert.equal(complete.receipt.payload.receipts.deliver.inputs.candidate.tree,a.workspace.candidate.tree);
    assert.deepEqual(order,coreStages.slice(0,14));assert.deepEqual(processes,['writer','accept','shaper-review']);
    const ids=[authored.author.receipt,validated.validator.receipt,delivery.evidence,accepted.evidence,review.evidence].map(e=>e.execution.id);
    assert.equal(new Set(ids).size,5);assert.equal(f.sh.writes().length,2);
  } finally {if(reviewed)reviewed.close();else if(published)published.close();else a.close();}
});
