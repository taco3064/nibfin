// Synthetic provider/custody contract; never live completion or execution authority.
import {readFile} from 'node:fs/promises';
import {relative} from 'node:path';
import {chain,chainContext,context} from './evidence-fixture.mjs';
import {operationInput,operationsFixture} from './operations-fixture.mjs';
import {zipFixture} from './custody-fixture.mjs';
import {createCompletionFlow,observeClosure,observeControlledOperation,createGithubProvider,
  createArtifactCustody,contentIdentity,byteDigest,verifyDeployment,readDeploymentObservation,createDeploymentFinal} from '../src/index.mjs';
export async function completionFixture(deployment) {
  const c=chain(true,false,r=>{
    for(const e of Object.values(r)){e.binding.repositoryId='42';e.binding.issueId='I_101';}
    r.final.inputs.postMerge={mode:'not-applicable',identities:[],reason:'No post-merge checks in synthetic policy'};
  });
  const b=c.receipts.final.binding;
  const target={repository:'example-org/core',repositoryId:'42',issueId:'I_101',databaseId:'61',number:'101',cycle:'cycle-1'};
  const inputs={};
  for(const kind of ['close','label','merge']) {
    const v=operationInput(kind);v.correlation='completion-'+kind;
    Object.assign(v.binding,{scopeHash:b.scopeHash,shapeHash:b.shapeHash,authorization:b.grant,
      head:c.receipts.pr.inputs.head,base:c.receipts.pr.inputs.base});
    if(kind==='merge')v.payload.sha=v.binding.head;
    inputs[kind]=v;
  }
  const close=operationsFixture(inputs.close),label=operationsFixture(inputs.label);
  const state={closed:false,ownership:'Organization',event:'200',at:'2026-10-24T12:00:00Z',actor:'7',
    reason:'completed',failed:false,private:false,postMerge:true,auth:true,dependencies:true,mutations:[],
    stageExpectations:{},records:new Map(),history:new Map(),attempted:new Set(),hooks:{},next:1200};
  const root='/repos/'+target.repository;
  const issue=()=>({id:'61',node_id:'I_101',number:101,repository_url:'https://api.github.com'+root,
    state:state.closed?'closed':'open',state_reason:state.closed?state.reason:null,closed_at:state.closed?state.at:null,...state.issueMetadata});
  close.state.mutate=()=>issue();label.state.mutate=()=>issue();
  close.state.onWrite=()=>{state.closed=true;state.mutations.push('close');};
  label.state.onWrite=()=>state.mutations.push('label');
  const provider=createGithubProvider({attempts:1,transport:async r=>{
    await state.hooks.read?.(r);
    const path=r.endpoint.slice(root.length);let data;
    if(state.deploymentData?.[path])return {status:200,body:JSON.stringify(state.deploymentData[path])};
    if(path==='')data={id:'42',full_name:target.repository,private:state.private,visibility:state.private?'private':'public',owner:{type:state.ownership}};
    else if(path==='/issues/101')data=issue();
    else if(path==='/issues/101/events?per_page=100')data=state.events??(state.closed?[{id:state.event,event:'closed',created_at:state.at,actor:{id:state.actor}}]:[]);
    else if(path==='/issues/101/labels?per_page=100')data=label.state.effect?[{id:'80',name:'delivered'}]:[];
    else if(path==='/pulls/102')data={id:'60',number:102,base:{ref:'main',sha:c.receipts.pr.inputs.base,repo:{id:'42'}},
      head:{sha:c.receipts.pr.inputs.head,repo:{id:'42'}},merged:true,state:'closed',merge_commit_sha:state.commit??'d'.repeat(40),merged_at:'2026-10-24T11:00:00Z'};
    else if(path.startsWith('/commits/'))data={sha:'d'.repeat(40)};
    else if(path==='/branches/main')data={name:'main',commit:{sha:'d'.repeat(40)}};
    else if(path.startsWith('/compare/'))data={base_commit:{sha:'d'.repeat(40)},merge_base_commit:{sha:'d'.repeat(40)},status:'identical',behind_by:0,ahead_by:0};
    else if(path.match(/^\/actions\/runs\/\d+\/artifacts\?/))data={total_count:state.records.size,artifacts:[...state.records.values()].map(r=>r.metadata)};
    else if(path.startsWith('/actions/artifacts/'))data=state.records.get(path.split('/').at(-1))?.metadata;
    else throw Error('unexpected fixture read '+path);
    return {status:state.failed||200,body:JSON.stringify(state.override?.[path]??data??{})};
  }});
  const observe=()=>observeClosure({provider,target,mergeIntent:inputs.merge});
  const mergeOperation={outcome:'confirmed-success',continuation:true,refs:{},
    observation:await observeControlledOperation(provider,inputs.merge)};
  // Rebuild chain references after updating the actual producer merge readback.
  let qualified, deploymentInputs;
  if(deployment) {
    const policy=deployment.policy;
    state.deploymentData={
      ['/deployments/'+policy.deploymentId]:{id:policy.deploymentId,sha:policy.commit,environment:policy.environment,payload:{version:policy.version,baseline:policy.baseline}},
      ['/deployments/'+policy.deploymentId+'/statuses/'+policy.statusId]:{id:policy.statusId,state:'success',environment:policy.environment,
        log_url:root.replace('/repos/','https://github.com/')+'/actions/runs/'+policy.source.runId+'/attempts/'+policy.source.attempt},
      ['/actions/runs/'+policy.source.runId+'/attempts/'+policy.source.attempt]:{id:policy.source.runId,run_attempt:Number(policy.source.attempt),
        repository:{id:'42'},head_sha:policy.commit,path:policy.source.workflow,status:'completed',conclusion:'success'}};
    const observed=await readDeploymentObservation(provider,{repository:target.repository,policy,now:deployment.now});
    deploymentInputs={...deployment,observation:observed.observation};qualified=await verifyDeployment(deploymentInputs);
    if(qualified.status!=='qualified')throw Error('invalid deployment fixture');
  }
  const freshChain=chain(true,false,r=>{
    for(const e of Object.values(r)){e.binding.repositoryId='42';e.binding.issueId='I_101';}
    r.merge.inputs.readback=contentIdentity(mergeOperation);
    r.final.inputs.postMerge=c.receipts.final.inputs.postMerge;
    if(deployment)r.final.inputs.deployment=qualified.proof;
  });
  if(deployment)await createDeploymentFinal(context(freshChain.receipts.final),qualified,deploymentInputs);
  const receipts=structuredClone(freshChain.receipts);delete receipts.closure;delete receipts.delivered;
  const contexts=chainContext({receipts});
  const pin={binding:b,target,visibility:'public',ownership:'organization',scopeBody:'original scope',shapeBody:'published shape',
    decision:'decision-1',writerId:'7',deploymentObservation:deploymentInputs?.observation??null,candidate:inputs.close.binding.candidate,intents:{close:inputs.close,label:inputs.label},
    mergeIntent:inputs.merge,mergeOperation,receipts,contexts,postMerge:{mode:'not-applicable',reason:c.receipts.final.inputs.postMerge.reason},
    deployment:deployment?.policy??{mode:'not-applicable',reason:freshChain.receipts.final.inputs.deployment.reason},health:deployment?.health??null,source:{runId:'100',attempt:'1'}};
  const custody=()=>createArtifactCustody({provider,now:()=>Date.parse('2026-10-24'),archive:async r=>{
    const v=state.records.get(r.endpoint.match(/artifacts\/(\d+)/)?.[1]);
    return {status:200,bytes:state.corrupt?Buffer.from('broken'):v?.bytes};
  }});
  const publication=async({phase,identity,expected})=>({
    runtime:{facility:'@actions/artifact@2.3.2',available:true,repository:target.repository,repositoryId:'42',runId:'100',attempt:'1'},
    client:{uploadArtifact:async(name,paths,directory)=>{
      state.attempted.add(phase);
      await state.hooks.publish?.(phase);
      state.mutations.push(phase);
      if(state.failPublish===phase)throw Error('fixture upload failed');
      const entries=await Promise.all(paths.map(async p=>[relative(directory,p),await readFile(p)]));
      const bytes=zipFixture(entries),id=String(state.next++),manifest=JSON.parse(entries.find(([p])=>p==='custody-manifest.json')[1]);
      const ref={repository:target.repository,repositoryId:'42',runId:'100',artifactId:id,manifestIdentity:contentIdentity(manifest),archiveDigest:byteDigest(bytes)};
      state.records.set(id,{bytes,metadata:{id,name,size_in_bytes:bytes.length,expired:false,expires_at:'2030-01-01T00:00:00Z',
        digest:'sha256:'+byteDigest(bytes),workflow_run:{id:'100',repository_id:'42'}}});
      state.history.set(phase,{outcome:'found',ref,source:{runId:'100',attempt:'1'}});
      if(state.lostPublish===phase)throw Error('fixture lost upload response');
      return {id,digest:byteDigest(bytes)};
    }}});
  const fresh=()=>createCompletionFlow({current:async()=>{await state.hooks.current?.();return pin;},
    authorization:{eligibility:async()=>{await state.hooks.authorization?.();return {ok:state.auth,observation:{repositoryId:'42',issueId:'I_101'}};}},
    dependencies:{evaluate:async()=>{await state.hooks.dependencies?.();return {outcome:state.dependencies?'ready':'waiting',target};}},dependencyInput:{target},
    provider,observe,now:deployment?.now??Date.now,operations:async({intent,beforeSubmit,causalClose})=>{
      const f=intent.kind==='close'?close:label;return f.fresh(undefined,beforeSubmit,{causalClose:state.omitCausal?false:causalClose});
    },custody:custody(),publication,
    locate:async({identity,phase})=>{await state.hooks.locate?.(phase);return state.missingHistory?{outcome:'unavailable'}:state.history.get(phase)??(state.attempted.has(phase)?{outcome:'unavailable'}:{outcome:'new',identity});},
    stageCurrent:async(name,record)=>{
      await state.hooks.stage?.(name);
      const r=structuredClone(freshChain.receipts[name]);r.inputs.readback=contentIdentity(record);
      if(name==='closure')r.inputs.final=contentIdentity(pin.receipts.final);
      else r.inputs.closure=contentIdentity(state.closure);
      state.stageExpectations[name]=context(r);
      if(name==='closure')state.closure=r;
      return context(r);
    },postMerge:async()=>{await state.hooks.postMerge?.();return state.postMerge?pin.receipts.final.inputs.postMerge:{};}});
  return {state,pin,fresh,close,label,provider,custody,publication,observe};
}
