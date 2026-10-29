// Synthetic signed authority/provider and recording process composition only.
import {generateKeyPairSync} from 'node:crypto';
import {createCore,createAuthorizationBoundary,createGithubProvider,createDependencyEvaluator,
  createAssigneeSelector,exportAuthority,authoritySnapshot,bodyDigest,signGrant,contentIdentity,coreStages} from '../src/index.mjs';
import {selectionFixture} from './selection-fixture.mjs';
import {shapeFixture} from './shape-fixture.mjs';
export function coreFixture() {
  const sh=shapeFixture(), sf=selectionFixture(),calls=[];
  const authority=exportAuthority({source:'https://app.notion.com/p/40006b644a2080dab1a8c2e562f95373',revision:'1',approvalId:'owner-1',cycle:'cycle-1',
    components:[{id:'scope',kind:'section',body:sh.pin.original.body,references:[]}]});
  const keys=generateKeyPairSync('ed25519'), payload=sf.payload;
  payload.authority=authoritySnapshot(authority);
  for(const w of payload.work){w.repository.id='42';w.scope.body=sh.pin.original.body;w.scope.hash=bodyDigest(w.scope.body);
    w.currentBody=structuredClone(w.scope);}
  for(const p of payload.permissions){p.repository.id='42';p.operations=[...coreStages,'readiness','publish-shape','commit-pr','close','mark-delivered','verify-deployment','observe-ci'];}
  const grant=signGrant(payload,{keyId:'owner-1',privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'})});
  const context=sf.context;Object.assign(context,{expectedAuthority:payload.authority,expectedWork:payload.work,
    expectedPolicy:payload.policy,trustedKeys:new Map([['owner-1',keys.publicKey.export({type:'spki',format:'pem'})]])});
  context.request.repository.id='42';context.request.issueId=sh.pin.target.issueId;
  sf.input.target.id='42';sf.input.registration.id='42';sf.input.records.forEach(r=>r.repositoryId='42');sf.input.execution.repositoryId='42';
  sf.routes[sf.prefix].id='42';sf.routes[sf.issuePath].id=sh.pin.target.databaseId;
  Object.assign(sf.routes[sf.issuePath],{body:sh.pin.original.body,state:'open',url:'https://api.github.com'+sf.issuePath});
  const state={denied:false,dependencies:[],effects:null,reads:0,onRead:null,time:1100};
  const transport=async r=>{
    calls.push(r);await state.onRead?.(r);
    if(state.denied)return {status:403,body:'private provider error'};
    if(r.endpoint.includes('/dependencies/blocked_by'))return {status:200,body:JSON.stringify(state.dependencies)};
    const value=sf.routes[r.endpoint];
    return value?{status:200,body:JSON.stringify(value)}:{status:404,body:'not found'};
  };
  const provider=createGithubProvider({transport,now:()=>state.time,attempts:1});
  const boundary=member=>createAuthorizationBoundary({transport,now:()=>state.time,maxCheckpointMs:50,attempts:1,
    getCheckpoint:intent=>({request:{...context.request,operation:intent.operation},member,
      operator:{id:'7',login:'operator'},grant,grantContext:context})});
  const member=sf.members[0],authorization=boundary(member);
  const selector=createAssigneeSelector({provider,now:()=>state.time,maxCheckpointMs:50,authorizationFor:boundary});
  const dependencies=createDependencyEvaluator({provider,authorize:n=>authorization.eligibility({operation:'readiness'}),
    current:()=>null,retrieve:()=>null});
  Object.assign(sh.pin.binding,{authority:authority.identity,grant:contentIdentity(grant)});
  const pin={restrictions:{restrictionsChecked:true,hold:null,paused:false,unknownWrite:false},target:sh.pin.target,cycle:'cycle-1',visibility:'public',ownership:'organization',
    binding:sh.pin.binding,scopeBody:sh.pin.original.body,shapeBody:null,
    authority:{export:authority,context:{grant,grantContext:context,
      expected:{source:authority.source,revision:authority.revision,approvalId:authority.approvalId,cycle:authority.cycle}}},
    receipts:{},evidenceCurrent:{},candidate:null,base:null,head:null,ciIdentity:null,completion:null,
    completionCurrent:null,transition:null,operationIdentity:null,stageInput:null,
    dependencyInput:{target:sh.pin.target,issues:[sh.pin.target]},selectionInput:sf.input,
    invocation:{request:'request-1',run:{id:'100',attempt:'1'}},prior:{state:'new'}};
  // Context contains a key Map, so structuredClone deliberately retains it.
  const owners={shape:sh.capabilities};
  const core=createCore({provider,current:()=>{state.reads++;return structuredClone(pin);},authorization,dependencies,selector,owners});
  const request=()=>{const s=pin.transition??coreStages.slice(0,14).find(s=>!pin.receipts[s])??'fanout';
    const op=({publication:'publish-shape',pr:'commit-pr',ci:'observe-ci',final:'verify-deployment',closure:'close',delivered:'mark-delivered'})[s]??s;
    pin.selectionInput.operation=op;pin.selectionInput.execution.operation=op;
    return {version:1,target:structuredClone(pin.target),cycle:pin.cycle,
    request:pin.invocation.request,run:structuredClone(pin.invocation.run),expected:{stage:'shape',decision:'a'.repeat(64)}};};
  async function queued(){const r=request(),p=await core.inspect(r);if(!p.current)throw Error(JSON.stringify(p));r.expected=p.current;return r;}
  function adopt(value) {
    pin.scopeBody=value.scopeBody;pin.shapeBody=value.shapeBody;
    for(const w of payload.work){w.scope.body=value.scopeBody;w.scope.hash=bodyDigest(value.scopeBody);w.currentBody=structuredClone(w.scope);}
    Object.assign(grant,signGrant(payload,{keyId:'owner-1',privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'})}));
    const walk=v=>{if(v&&typeof v==='object'){
      if(v.binding?.authority){v.binding.authority=authority.identity;v.binding.grant=contentIdentity(grant);}
      Object.values(v).forEach(walk);
    }};walk(value);pin.binding=value.binding;
    sf.routes[sf.issuePath].body=value.shapeBody;
  }
  return {adopt,core,pin,state,sh,sf,owners,calls,grant,context,provider,authorization,dependencies,selector,request,queued,
    create:extra=>createCore({provider,current:()=>structuredClone(pin),authorization,dependencies,selector,owners:{...owners,...extra}})};
}
