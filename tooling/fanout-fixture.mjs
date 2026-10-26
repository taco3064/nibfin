// Retained local provider/cryptographic custody proof, never live Dispatch evidence.
import {createDownstreamFanout,resolveFanoutWakeup,createDependencyEvaluator,createGithubProvider,
  createCompletion,byteDigest} from '../src/index.mjs';
import {chain,chainContext} from './evidence-fixture.mjs';
import {operationInput,operationsFixture} from './operations-fixture.mjs';
export function fanoutFixture(source,configure) {
  const make=(repository,repositoryId,issueId,number,databaseId)=>({repository,repositoryId,issueId,number,databaseId});
  const [b,c,d,e,a,z]=[
    make('example-org/source','41','I_B','101','11'),make('example-org/core','42','I_C','101','12'),
    make('person/target','43','I_D','101','13'),make('example-org/other','44','I_E','101','14'),
    make('example-org/source','41','I_A','102','15'),make('example-org/core','42','I_Z','103','16')];
  if(source){Object.assign(b,source);c.number='102';}
  const nodes=[b,c,d,e,a,z], edges=new Map([[c.issueId,[b,e]],[d.issueId,[b]],[z.issueId,[c]]]);
  const completions=new Map(),contexts=new Map(),calls=[],requests=new Map(),op=new Map();
  const body=n=>({id:n.databaseId,node_id:n.issueId,number:Number(n.number),url:'https://api.github.com/repos/'+n.repository+'/issues/'+n.number,
    repository_url:'https://api.github.com/repos/'+n.repository,state:'closed',labels:[{name:'delivered'}]});
  const state={denied:new Set(),private:new Set(),owners:new Map([[d.repository,'User']]),discovery:[c,d],readHook:async()=>{},targetHook:async()=>{},sourceHook:async()=>{}};
  const workflow={id:'50',ref:'main',sha:'b'.repeat(40),path:'.github/workflows/resolve.yml',digest:byteDigest(Buffer.from('trusted workflow'))};
  function complete(n) {
    const make=()=>chain(false,false,r=>{for(const v of Object.values(r)){v.binding.repositoryId=n.repositoryId;v.binding.issueId=n.issueId;
      if(n===b&&configure){configure({scopeBody:'original scope',shapeBody:'published shape',binding:v.binding});v.execution.request=v.execution.id+'-request';}}});
    const expected=chainContext(make()),receipt=createCompletion(make(),expected);
    contexts.set(n.issueId,expected);completions.set(n.issueId,receipt);return receipt;
  }
  complete(b);
  const provider=createGithubProvider({attempts:1,transport:async r=>{
    calls.push(r);const intercepted=await state.readHook(r);if(intercepted)return intercepted;
    let data;const n=nodes.find(n=>r.endpoint.startsWith('/repos/'+n.repository+'/issues/'+n.number));
    if(n) data=r.endpoint.includes('/dependencies/blocking')?state.discovery.map(body)
      :r.endpoint.includes('/dependencies/blocked_by')?(edges.get(n.issueId)??[]).map(body):body(n);
    else {
      const repo=nodes.find(n=>r.endpoint.startsWith('/repos/'+n.repository));
      if(!repo)return {status:404,body:'secret'};
      if(r.endpoint.includes('/actions/workflows/'))data={id:workflow.id,path:workflow.path};
      else if(r.endpoint.includes('/commits/'))data={sha:workflow.sha};
      else if(r.endpoint.includes('/contents/'))data={path:workflow.path,type:'file',encoding:'base64',content:Buffer.from('trusted workflow').toString('base64')};
      else data={id:repo.repositoryId,full_name:repo.repository,private:state.private.has(repo.repository),visibility:'public',owner:{type:state.owners.get(repo.repository)??'Organization'}};
    }
    return {status:200,body:JSON.stringify(data)};
  }});
  const options={provider,currentSource:async()=>{await state.sourceHook();return {identity:completions.get(b.issueId)?.identity,
    expected:contexts.get(b.issueId),cycle:state.cycle??'cycle-1',provenance:{event:'workflow_dispatch',repositoryId:b.repositoryId,runId:'99',attempt:'1',actorId:'7'}};},
    retrieveReceipt:async()=>({cycle:state.receiptCycle??'cycle-1',identity:completions.get(b.issueId)?.identity,
      bytes:state.bytes??Buffer.from(JSON.stringify(completions.get(b.issueId)??null))}),
    currentTarget:async n=>{await state.targetHook(n);const v=operationInput('dispatch');Object.assign(v.binding,{repository:n.repository,repositoryId:n.repositoryId,issueId:n.issueId,number:n.number});
      return {ok:!state.denied.has(n.issueId),binding:v.binding,workflow:structuredClone(workflow)};},
    operations:async({request,beforeSubmit})=>{
      requests.set(request.id,structuredClone(request));
      let f=op.get(request.id);if(!f){f=operationsFixture(request.intent);op.set(request.id,f);}
      f.state.ownership=state.owners.get(request.target.repository)??'Organization';
      return f.fresh(undefined,beforeSubmit);
    }};
  const dependencyOptions={provider,authorize:async n=>({ok:!state.denied.has(n.issueId),observation:{repositoryId:n.repositoryId,issueId:n.issueId,
    operation:'readiness',startedAt:1,observedAt:2}}),current:async n=>({identity:completions.get(n.issueId)?.identity,expected:contexts.get(n.issueId)}),
    retrieve:async n=>completions.get(n.issueId)};
  const consumer=async(request,target,changes={})=>resolveFanoutWakeup({inputs:request.intent.payload.inputs,
    authenticate:async r=>r.intent.payload.refIdentity.sha===workflow.sha&&r.intent.payload.refIdentity.workflowDigest===workflow.digest,
    lookup:async id=>requests.get(id),dependencies:createDependencyEvaluator(dependencyOptions),dependencyInput:{target,issues:nodes},...changes});
  return {b,c,d,e,a,z,nodes,edges,state,workflow,provider,options,contexts,completions,requests,op,calls,body,complete,consumer,
    fresh:(overrides={})=>createDownstreamFanout({...options,...overrides}),input:{source:b,issues:[c,d,e,a,z]},
    writes:()=>[...op.values()].flatMap(f=>f.writes())};
}
