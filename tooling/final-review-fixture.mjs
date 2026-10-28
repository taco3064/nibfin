// Credential-free contract evidence: stubbed reviewer, disposable Git and provider.
import {candidatePublicationFixture} from './candidate-publication-fixture.mjs';
import {operationsFixture,operationInput} from './operations-fixture.mjs';
import {createFinalReview,createProtectedMerge,observeFinalReview,createGithubProvider,createAgentLifecycle,
  contentIdentity,selectInstructions} from '../src/index.mjs';
export async function finalReviewFixture({ownership='personal',method='rebase',configure,published:providedPublished,publication:providedPublication,ciObservation='signed'}={}) {
  const published=providedPublished??await candidatePublicationFixture({empty:true,ownership,configure}),a=published.a;
  const publication=providedPublication??await published.run();if(publication.outcome!=='published')throw Error('fixture publication');
  const pin=structuredClone(published.pin),b=pin.binding;
  const selected=selectInstructions({skill:'shape',role:'shaper-review'});b.instructions=selected.identity;
  const execution=(role,id)=>({role,skill:role==='shaper-review'?'shape':'deliver',id,request:id+'-request',result:id+'-result',source:null});
  const wrap=value=>({value,current:{expected:structuredClone(value),consumed:[]}});
  const envelope=(stage,id,inputs,result=null)=>({version:1,stage,binding:{...b},execution:execution(stage==='shaper-review'?stage:'deliver',id),inputs,result});
  pin.publication=publication.value;
  pin.target.prId='60';pin.target.prNumber='102';
  const head=publication.value.commit,base=publication.value.base;
  const pr=envelope('pr','published-pr',{candidate:a.workspace.candidate,accept:publication.value.accept,hooks:publication.value.hooks,
    head,base,readback:contentIdentity(publication.value.pr.observation)});
  pin.evidence.pr=wrap(pr);
  const input=operationInput('merge');Object.assign(input.binding,{...Object.fromEntries(['scopeHash','shapeHash'].map(k=>[k,b[k]])),
    authorization:b.grant,cycle:pin.target.cycle,head,base,candidate:a.workspace.expected.identity});
  input.payload.sha=head;input.payload.merge_method=method;input.correlation='merge-one';
  const ops=operationsFixture(input),state={fault:null,result:null,pending:false,termination:'terminated',exitCode:0,
    onPrepare:null,onCollect:null,onNative:null,onCurrent:null,onEligibility:null,onDependency:null};
  const native={repo:{id:'42',full_name:pin.repository,private:false,visibility:'public',owner:{type:ownership==='personal'?'User':'Organization'},
    permissions:{push:true},allow_merge_commit:true,allow_squash_merge:true,allow_rebase_merge:true},
    pr:{id:'60',number:102,head:{ref:pin.target.headRef,sha:head,repo:{id:'42'}},base:{ref:'main',sha:base,repo:{id:'42'}},
      state:'open',merged:false,draft:false,mergeable:true,mergeable_state:'clean'},
    protection:{enforce_admins:{enabled:true},required_status_checks:{strict:true,contexts:['build'],checks:[{context:'build',app_id:'15368'}]}},
    rules:[],checks:[{id:'44',name:'build',head_sha:head,app:{id:'15368'},status:'completed',conclusion:'success'}],tree:a.workspace.candidate.tree};
  const provider=createGithubProvider({attempts:1,transport:async r=>{
    await state.onNative?.(r);const p=r.endpoint.slice(('/repos/'+pin.repository).length);
    let data=p===''?native.repo:p==='/pulls/102'?native.pr:p===`/commits/${head}`?{sha:head,commit:{tree:{sha:native.tree}}}:
      p==='/branches/main'?{name:'main',protected:native.protected??true,commit:{sha:native.pr.base.sha}}:
      p==='/branches/main/protection'?native.protection:p.startsWith('/rules/branches/')?native.rules:
      p.includes('/check-runs?')?{total_count:native.checks.length,check_runs:native.checks}:p.includes('/statuses?')?[]:null;
    return {status:data===null?500:200,body:JSON.stringify(data)};
  }});
  const observe=()=>observeFinalReview({provider,target:pin.target,head,base,actions:pin.actions??[],ciMode:ciObservation});
  pin.observation=await observe();
  const ci=envelope('ci','ci-observed',{pr:contentIdentity(pr),head,base,policy:b.policy,checks:contentIdentity(pin.observation.ci)});
  pin.evidence.ci=wrap(ci);pin.instructions={};pin.method=method;pin.ciMode='github-repository';pin.mergeCorrelation=input.correlation;
  const expected=new Map(),records=[],lives=[];let n=0;
  const evidenceCurrent=id=>({expected:structuredClone(expected.get(id)),consumed:state.fault==='replay'?[expected.get(id)?.execution.result]:[]});
  const current=async()=>{await state.onCurrent?.();return structuredClone(pin);};
  const capabilities={current,workspace:()=>a.workspace,observe,evidenceCurrent,prepareRole:async request=>{
    await state.onPrepare?.(request);const id='final-'+(++n),e=execution('shaper-review',id);
    if(state.fault?.startsWith('reuse:')){const [,name,key]=state.fault.split(':');e.request=pin.evidence[name].value.execution[key];}
    if(state.fault==='repeat')Object.assign(e,records[0].e);
    const inputs={candidate:a.workspace.candidate,pr:contentIdentity(pr),ci:contentIdentity(ci),head,base,
      author:pin.evidence.author.value.execution.id,validator:pin.evidence.validator.value.execution.id,
      deliver:pin.evidence.deliver.value.execution.id,accept:pin.evidence.accept.value.execution.id};
    const value=envelope('shaper-review',id,inputs,{version:1,outcome:'approved',failureClass:'none',summary:'Stubbed contract review only',conflicts:[]});
    value.execution=e;expected.set(e.id,structuredClone(value));
    const input={execution:e,binding:{...b},instructions:{identity:request.instructions.identity,content:request.instructions.content},visibility:'public',ownership};
    const backend={readiness:async()=>({login:'available',tool:'available',isolation:'verified',read:'verified',write:'unsupported',
      evidence:['recording-contract'],limitations:['Stubbed; no real model or native isolation proof']}),
      start:async actual=>{records.push({request,actual,e});return {status:'started'};},
      collect:async()=>{await state.onCollect?.();let output=structuredClone(value);
        if(state.result)output.result=state.result;
        if(state.fault==='foreign')output.execution.id='foreign';
        if(state.fault==='invalid')output.result={authorized:true};
        return {status:state.pending?'pending':'complete',exitCode:state.exitCode,evidence:state.fault==='absent'?null:output};},
      termination:async()=>({status:state.termination}),stop:async()=>{state.termination='terminated';state.pending=false;return {status:'requested'};},
      cleanup:async()=>({status:'completed',residuals:[]})};
    const lifecycle=createAgentLifecycle({environment:{id:id+'-env',agent:'stub',loginSpace:'/fixture/'+id+'/login',
      instances:[{id,workspace:a.root,registration:'/fixture/'+id+'/reg',service:'/fixture/'+id+'/service'}]},instanceId:id,backend,
      current:evidenceCurrent,collectFailures:true,resultContext:()=>({scopeBody:pin.scopeBody,shapeBody:pin.shapeBody})});
    lives.push(lifecycle);return {input,lifecycle,taskIdentity:state.fault==='truncated'?contentIdentity({truncated:true}):contentIdentity(request.task)};
  }};
  const review=createFinalReview(capabilities);
  const mergeCaps={current,workspace:()=>a.workspace,observe,
    authorization:{eligibility:async()=>{await state.onEligibility?.();return {ok:ops.state.allowed,observation:{repositoryId:'42',issueId:'I_101'}};}},
    dependencies:{evaluate:async()=>{await state.onDependency?.();return {outcome:state.dependencyDenied?'waiting':'ready',target:{repositoryId:'42',issueId:'I_101'}};}},dependencyInput:{},
    operations:async options=>{state.operationsOptions=options;return ops.fresh({runId:'100',attempt:'1'},options.beforeSubmit);},
    mergeCurrent:async result=>({expected:envelope('merge','merge-readback',{review:contentIdentity(pin.review.value),head,base,
      commit:result.observation.mergeCommit,readback:contentIdentity(result)}),consumed:[]})};
  return {pin,state,native,ops,records,provider,capabilities,mergeCaps,review,lives,observe,a,published,
    async approve(){const r=await review.run();if(r.outcome==='approved')pin.review={...wrap(r.evidence),context:r.context};return r;},
    merge:()=>createProtectedMerge(mergeCaps).run(),close:()=>published.close()};
}
