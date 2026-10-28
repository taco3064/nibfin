// Read-observation owner adapted from src/github.mjs at
// taco3064/kairo@d1b47d5e073cf15bdcdc1fbbec098401649878d9.
// Nibfin retains its permission-checked transport, lossless IDs, endpoint policy
// and safe diagnostics. No credentials, private-runner gate or mutation retry
// capability is introduced by the observation owner.
import {AsyncLocalStorage} from 'node:async_hooks';
const cacheableReadOptions=new Set(['method','endpoint','target','operation','correlation','signal','context']);
export class GithubObservation {
  constructor(request) {
    if(typeof request!=='function')throw Error('github:request');
    this.send=request;this.observations=new AsyncLocalStorage();this.readGeneration=0;
  }
  async readObservation(work) {
    if(this.observations.getStore()?.active)return work();
    const scope={reads:new Map(),generation:this.readGeneration,active:true};
    try{return await this.observations.run(scope,work);}
    finally{scope.active=false;scope.reads.clear();}
  }
  async freshReadObservation(work) {
    // Invalidate enclosing observations too. A nested fresh read cannot leave
    // the older authority snapshot usable after it returns.
    this.readGeneration++;
    const scope={reads:new Map(),generation:this.readGeneration,active:true};
    try{return await this.observations.run(scope,work);}
    finally{scope.active=false;scope.reads.clear();}
  }
  async request(options) {
    const method=options.method??'GET',scope=this.observations.getStore();
    if(method!=='GET') {
      this.readGeneration++;
      if(scope?.active)throw Error('Writes are forbidden inside a read observation');
    }
    // Cache only unconstrained observations. Provider results already include
    // request-local validation, so expectedId, validators (even the same mutable
    // callback), and future request options must run through the provider anew.
    if(method==='GET'&&scope?.active&&options.context===undefined
      &&options.expectedId===undefined&&options.validate===undefined
      &&Reflect.ownKeys(options).every(key=>cacheableReadOptions.has(key))) {
      if(options.signal?.aborted)return this.send(options);
      if(scope.generation!==this.readGeneration){scope.reads.clear();scope.generation=this.readGeneration;}
      // Preserve target, operation and correlation; permission decisions for one
      // operation must never serve another. AbortSignals are request-local.
      const key=JSON.stringify([options.endpoint,options.target,options.operation,options.correlation]);
      let reads=scope.reads.get(options.signal);
      if(!reads){reads=new Map();scope.reads.set(options.signal,reads);}
      if(!reads.has(key))reads.set(key,Promise.resolve().then(()=>this.send(options)));
      return structuredClone(await reads.get(key));
    }
    return this.send(options);
  }
}

// Endpoint/payload construction retained from GitHub.label/updateIssue/
// createPull/merge. The existing Nibfin operations owner supplies a validated,
// authorized intent and retains/reconciles each submission before any retry.
export function deliveryWriteRequest(v) {
  const repository=v.binding.repository;
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))throw Error('Invalid repository identity');
  const root='/repos/'+repository,t=v.target;
  const route={pr:['POST','/pulls'],merge:['PUT',`/pulls/${t.number}/merge`],
    close:['PATCH',`/issues/${t.number}`],reopen:['PATCH',`/issues/${t.number}`],
    'issue-body':['PATCH',`/issues/${t.number}`],label:['POST',`/issues/${t.number}/labels`],
    comment:['POST',`/issues/${t.number}/comments`],dispatch:['POST',`/actions/workflows/${t.workflow}/dispatches`]}[v.kind];
  if(!route)throw Error('Unsupported delivery operation');
  return {method:route[0],endpoint:root+route[1],operation:v.kind,target:t.id,correlation:v.correlation,
    body:v.kind==='dispatch'?{ref:v.payload.ref,inputs:v.payload.inputs}:v.payload};
}
export function requireMergeIdentity(pr) {
  // GitHub's supported 2022 representation includes the actual merge commit.
  // Never infer it from the branch head or a successful PUT acknowledgment.
  if(pr.merged&&!/^[a-f0-9]{40}$/.test(pr.merge_commit_sha??''))throw Error('Merged PR lacks an actual merge commit identity');
  return pr;
}

/** Donor GitHub.checks/protections repository-controlled mode. All observations
 * are exact-head, but required policy is deliberately enforced by GitHub rather
 * than invented from the names of visible checks. No success verdict is created.
 */
export async function observeRepositoryCI({provider,expected:e,signal}={}) {
  const root='/repos/'+e.repository;
  const options={operation:'observe-ci',correlation:'repository-ci',target:e.repositoryId,signal};
  const read=async endpoint=>{
    const r=await provider.request({...options,method:'GET',endpoint:root+endpoint});
    if(r.outcome!=='read')throw Error('GitHub repository observation unavailable');return r.data;
  };
  const pr=await read('/pulls/'+e.pr),branch=await read('/branches/'+encodeURIComponent(e.baseBranch));
  if(pr.id!==e.prId||String(pr.number)!==String(e.pr)||pr.head?.sha!==e.head||pr.base?.sha!==e.baseSha
    ||pr.base?.ref!==e.baseBranch||pr.base?.repo?.id!==e.repositoryId||pr.head?.repo?.id!==e.repositoryId
    ||branch.name!==e.baseBranch||branch.commit?.sha!==e.baseSha||typeof branch.protected!=='boolean')
    throw Error('Stale PR head, Base or repository protection observation');
  const path=root+'/commits/'+e.head+'/check-runs';
  const result=await provider.collection({...options,endpoint:path+'?filter=latest&per_page=100',envelope:'check_runs',
    allowPage:p=>p.split('?')[0]===path});
  if(result.outcome!=='complete')throw Error('Check observation unavailable');
  const checks=result.data.map(r=>{
    if(typeof r.id!=='string'||r.head_sha!==e.head||typeof r.name!=='string')throw Error('Stale check source');
    return {id:r.id,name:r.name,head:r.head_sha,status:r.status,conclusion:r.conclusion,appId:r.app?.id??null};
  });
  // Retain exact observations. They are not an assertion that all server-required
  // checks exist, or that a workflow is trusted by an explicit signed CI policy.
  const failed=pr.mergeable_state==='blocked'&&checks.some(c=>c.status==='completed'&&['failure','timed_out','cancelled','action_required'].includes(c.conclusion));
  return {outcome:'observed',qualifies:false,status:failed?'failed':'pending',expected:e,
    policy:{mode:'github-repository',protected:branch.protected,requirements:[],limitations:[],strict:false},
    evaluations:[],checks,checkpointOnly:true};
}
