import {createGithubProvider, createDependencyEvaluator} from '../src/index.mjs';

// Real REST response shapes with lossless IDs, not observed GitHub execution.
export const dynamicNode = (number, repository = 'example-org/core', repositoryId = '42') =>
  ({repository,repositoryId,number:String(number),issueId:'I_'+number,databaseId:String(9007199254740992n+BigInt(number))});
export function dynamicFixture() {
  const nodes = ['1','2','3','4','5'].map(n=>dynamicNode(n));
  const edges = new Map(), receipts = new Map(), contexts = new Map(), calls = [], denied = new Set();
  const input = {target:nodes[0],issues:nodes};
  const body = n => ({id:n.databaseId,node_id:n.issueId,number:Number(n.number),
    repository_url:`https://api.github.com/repos/${n.repository}`,
    url:`https://api.github.com/repos/${n.repository}/issues/${n.number}`,state:'closed',labels:[{name:'delivered'}]});
  const f = {nodes,edges,receipts,contexts,calls,denied,input,body,
    changeResponse:(_request,response)=>response, authorization:null,
    current:async n=>contexts.get(n.issueId), retrieve:async n=>receipts.get(n.issueId)};
  f.provider = createGithubProvider({identity:'hosted-authorized',attempts:1,transport:async r=>{
    calls.push({method:r.method,endpoint:r.endpoint});
    let data;
    const repo = nodes.find(n=>r.endpoint===`/repos/${n.repository}`);
    if (repo) data = {id:repo.repositoryId,full_name:repo.repository,private:false,visibility:'public',owner:{type:'Organization'}};
    else {
      const n = nodes.find(n=>r.endpoint===`/repos/${n.repository}/issues/${n.number}`
        || r.endpoint.startsWith(`/repos/${n.repository}/issues/${n.number}/dependencies/blocked_by`));
      if (!n) return {status:404,body:'private diagnostic',headers:{}};
      data = r.endpoint.includes('/dependencies/') ? (edges.get(n.number)??[]).map(num=>body(nodes.find(v=>v.number===num))) : body(n);
    }
    return f.changeResponse(r,{status:200,headers:{},body:JSON.stringify(data).replace(/"id":"([1-9][0-9]*)"/g,'"id":$1')});
  }});
  f.options = {provider:f.provider,authorize:async(n)=> f.authorization ? f.authorization(n) : ({ok:!denied.has(n.issueId),observation:{
    repositoryId:n.repositoryId,issueId:n.issueId,operation:'readiness',startedAt:1000,observedAt:1001,memberId:'7',source:'hosted-authorized'}}),
    current:(...args)=>f.current(...args),retrieve:(...args)=>f.retrieve(...args)};
  f.evaluate = (options={},request=input,control={})=>createDependencyEvaluator({...f.options,...options}).evaluate(request,control);
  return f;
}
