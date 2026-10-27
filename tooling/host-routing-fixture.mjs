// Deterministic signed Actions identity, official REST shapes and durable remote
// artifact bytes. No live GitHub, host or model verification is implied.
import * as core from '../src/index.mjs';
import {configure} from '../host/entry.mjs';
import {coreFixture} from './core-fixture.mjs';
import {hostIdentityFixture} from './host-identity-fixture.mjs';
import {custodyHostFixture} from './custody-host-fixture.mjs';

export async function hostRoutingFixture(stage='shape') {
  const f=coreFixture(),source=await hostIdentityFixture();
  for(const p of f.sf.payload.permissions)p.operations.push('core-read','runner-observation');
  // Re-sign the actual fixture authority after adding the read operations.
  f.adopt({scopeBody:f.pin.scopeBody,shapeBody:null,binding:f.pin.binding});
  f.sf.routes[f.sf.issuePath].body=f.pin.scopeBody;
  f.sf.routes[f.sf.prefix].permissions={admin:true};
  if(stage==='publication') {
    const authored=(await f.core.run(await f.queued())).owner.output,receipt=authored.author.receipt;
    f.pin.shapeBody=authored.author.body;f.pin.binding.shapeHash=core.bodyDigest(f.pin.shapeBody);
    f.pin.receipts.shape=receipt;f.pin.evidenceCurrent.shape={expected:structuredClone(receipt),consumed:[]};
    f.pin.stageInput=authored;f.pin.invocation={request:'validator',run:{id:'101',attempt:'1'}};
    const validated=(await f.core.run(await f.queued())).owner.output,vr=validated.validator.receipt;
    f.pin.receipts['shape-validator']=vr;f.pin.evidenceCurrent['shape-validator']={expected:structuredClone(vr),consumed:[]};
    f.pin.stageInput=validated;f.pin.invocation={request:'publication',run:{id:'102',attempt:'1'}};
  }
  const request=await f.queued(),remote=custodyHostFixture('example-org/core',request.run.id);
  source.policy.run_id=request.run.id;source.association.run_id=request.run.id;
  source.policy.runnerId='21';source.association.runnerId='21';
  Object.assign(source.policy,{repository:'example-org/core',repository_id:'42',repository_owner_id:'7',
    workflow_ref:'example-org/core/.github/workflows/stage.yml@refs/heads/main'});
  source.association.repository_id='42';
  source.state.token=await source.sign(Object.fromEntries(['run_id','repository','repository_id',
    'repository_owner_id','workflow_ref'].map(k=>[k,source.policy[k]])));
  const input={issue:'101',nibfin_request:request.request,nibfin_correlation:'correlation'};
  const context={repository:'example-org/core',repositoryId:'42',run:request.run};
  const targets=[f.sf.prefix,f.sf.issuePath,'/users/zed','/users/amy',
    f.sf.prefix+'/collaborators/zed/permission',f.sf.prefix+'/collaborators/amy/permission',
    f.sf.prefix+'/actions/runners',f.sf.issuePath+'/dependencies/blocked_by'];
  const slots=new Map();
  function register(kind,key,value) {
    const s=remote.slot(kind,key);s.binding.requirements.scopeHash=f.pin.binding.scopeHash;
    s.binding.requirements.shapeHash=f.pin.binding.shapeHash;s.binding.authorization=f.pin.binding.grant;
    s.binding.cycle=request.cycle;s.binding.stage=request.expected.stage;s.binding.role='shape';
    s.binding.request=request.request;s.binding.result=kind+'-result';
    remote.register(s);slots.set(kind+':'+key,s);return s;
  }
  register('resolution',request.request);register('stage-result',request.request);register('stage-attempt',request.request);
  const custody={provider:remote.provider,archive:remote.archive,
    expect:async({kind,key})=>{
      let s=remote.remote.slots.get(kind+':'+key);
      if(kind==='stage-result' && !s)s=register(kind,key);
      if(!s)throw Error('unapproved');return structuredClone(s);
    },publication:async()=>({client:remote.client,runtime:remote.runtime}),
    authorizeNew:async s=>{const id=core.custodySlotIdentity(s);if(remote.remote.reserved.has(id))return false;
      remote.remote.reserved.add(id);return true;},now:()=>remote.remote.clock};
  const state={actual:'21',missing:false,afterIdentity:null};
  const transport=async r=>{
    f.calls.push(r);await f.state.onRead?.(r);
    if(f.state.denied)return {status:403,body:'PRIVATE-SENTINEL'};
    if(r.endpoint==='/user')return {status:200,body:JSON.stringify({id:'7',login:'operator'})};
    if(r.endpoint.includes('/dependencies/blocked_by'))return {status:200,body:JSON.stringify(f.state.dependencies)};
    const data=f.sf.routes[r.endpoint];
    return data?{status:200,body:JSON.stringify(data)}:{status:404,body:'PRIVATE-SENTINEL'};
  };
  function make(mode,override={}) {
    const member=['compute','execute'].includes(mode),options={version:1,repository:context.repository,repositoryId:'42',
      environment:member?'nibfin-member':'nibfin-hosted',authentication:'actions-oidc',routing:'authenticated',
      ...(f.pin.selectionInput.conditions.groupId?{groupId:f.pin.selectionInput.conditions.groupId}:{})};
    const registered=f.pin.selectionInput.records.find(r=>r.runnerId===state.actual);
    const operator=member?(state.operator??f.sf.members.find(m=>m.id===registered?.memberId)??f.sf.members[0]):{id:'7',login:'operator'};
    const localTransport=async r=>{
      if(member&&r.endpoint==='/user') {f.calls.push(r);return {status:200,body:JSON.stringify(operator)};}
      return transport(r);
    };
    const identity={now:()=>f.state.time,source:{policy:source.policy,getToken:()=>source.state.token,
      getAssociation:()=>state.missing?undefined:{...source.association,runnerId:state.actual},continuation:{kind:'none'}},
      api:{kind:member?'local':'hosted',...(f.pin.selectionInput.registration.level==='organization'?{organization:'example-org'}:{}),operator,...(member?{}:{getCredential:()=>{throw Error('no real credential');}})},
      authorization:{getCheckpoint:intent=>({request:{...f.context.request,operation:intent.operation??'shape'},
        // Protected management reader is independent of the routing candidate.
        member:f.sf.members[1],grant:f.grant,grantContext:f.context}),maxCheckpointMs:50},
      operations:['readiness','shape','core-read','runner-observation','publish-shape','shape-validator'].flatMap(operation=>targets.map(endpoint=>({method:'GET',endpoint,target:'42',operation})))};
    const facade={...core,createHostIdentityAdapters:c=>core.createHostIdentityAdaptersForTest(c,{...source.facility,transport:localTransport})};
    const capabilities={delivery:async({routing:{provider,eligibility}})=>({request:structuredClone(request),config:{provider,
      current:()=>structuredClone(f.pin),authorization:{eligibility},
      dependencies:core.createDependencyEvaluator({provider,authorize:()=>eligibility({operation:'readiness'}),
        current:()=>null,retrieve:()=>null}),owners:f.owners}})};
    const host=configure({core:facade,mode,context,deployment:{options,identity,custody,capabilities,...override}});
    return {host,entry:core.createWorkflowEntry(host),invoke:resolution=>core.createWorkflowEntry(host).invoke(mode,
      mode==='resolve'?input:{...input,resolution},context)};
  }
  return {...f,source,remote,custody,targets,grantContext:f.context,stateRouting:state,request,input,context,make,
    requeue:async()=>{
      const h=make('resolve').host,identity=await h.authenticate({mode:'resolve',context});
      const spec=await h.delivery({identity,input,context}),inspected=await core.createCore(spec.config).inspect(request);
      if(inspected.reason!=='evaluated')throw Error(JSON.stringify(inspected));
      request.expected=inspected.current;return request;
    },
    resolve:()=>make('resolve').invoke(),execute:(resolution,mode='compute')=>make(mode).invoke(resolution)};
}
