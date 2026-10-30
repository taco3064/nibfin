import {githubId, repositoryCoordinates, canonicalJSON, contentIdentity, controlledIntent,
  verifyCompletion, byteDigest, nativeConcurrency} from './index.mjs';
const copy = structuredClone;
const same = (a,b) => canonicalJSON(a) === canonicalJSON(b);
const need = (v,reason) => {if (!v) throw {reason};};
const path = n => `/repos/${n.repository}/issues/${n.number}`;
const key = n => `${n.repositoryId}:${n.issueId}`;
function node(n) {
  for (const k of ['repositoryId','databaseId','number']) githubId(n[k]);
  need(typeof n.repository === 'string' && repositoryCoordinates(...n.repository.split('/')).key === n.repository
    && n.repository.split('/').length === 2 && /^[A-Za-z0-9_=-]{1,256}$/.test(n.issueId),'identity');
  return Object.fromEntries(['repository','repositoryId','issueId','databaseId','number'].map(k=>[k,n[k]]));
}
const matches = (d,n) => d?.id === n.databaseId && d.node_id === n.issueId && String(d.number) === n.number
  && !Object.hasOwn(d,'pull_request') && d.url === `https://api.github.com${path(n)}`
  && d.repository_url === `https://api.github.com/repos/${n.repository}`;
function row(d) {
  const u=new URL(d.url);need(u.origin==='https://api.github.com'&&!u.search&&!u.hash&&!u.username&&!u.password,'identity');
  const m=u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]*)$/);need(m,'identity');
  const n={repository:m[1],number:m[2],issueId:d.node_id,databaseId:d.id};
  githubId(n.databaseId);githubId(n.number);
  need(repositoryCoordinates(...n.repository.split('/')).key===n.repository
    &&typeof n.issueId==='string'&&/^[A-Za-z0-9_=-]{1,256}$/.test(n.issueId)&&matches(d,n),'identity');
  return n;
}
const publicRepo = (d,n) => d?.id === n.repositoryId && d.full_name?.toLowerCase() === n.repository
  && d.private === false && d.visibility === 'public' && ['User','Organization'].includes(d.owner?.type);
const safe = e => ['identity','completion','source-changed','target-changed','unauthorized','repository',
  'membership','discovery','pagination','limit','timeout','cancelled','read','request'].includes(e?.reason) ? e.reason : 'unavailable';

/** Core-owned capabilities only. operations must install beforeSubmit at its mutation guard. */
export function createDownstreamFanout({provider, currentSource, retrieveReceipt, currentTarget, operations,
  maxPages=10, maxTargets=100, maxReads=500, timeoutMs=30000} = {}) {
  need([provider?.request,provider?.collection,currentSource,retrieveReceipt,currentTarget,operations].every(f=>typeof f==='function'),'request');
  need([maxPages,maxTargets,maxReads,timeoutMs].every(v=>Number.isSafeInteger(v)&&v>0)
    && maxPages<=1000 && maxTargets<=10000 && maxReads<=100000 && timeoutMs<=86400000,'limit');
  const request=provider.request.bind(provider), collection=provider.collection.bind(provider);
  return Object.freeze({wake:async(input,{signal:caller}={})=>{
    const outcomes=[],started=performance.now(); let timer,abort,signal;
    try {
      const source=node(copy(input.source)), catalog=copy(input.issues).map(node);
      const seen=new Set(), paths=new Set(), ids=new Set(), nodes=new Set(), repos=new Map(), repoIds=new Map();
      for(const n of [source,...catalog]) {
        need(!seen.has(key(n))&&!nodes.has(n.issueId)&&!paths.has(path(n))&&!ids.has(n.databaseId),'identity');
        need((!repos.has(n.repository)||repos.get(n.repository)===n.repositoryId)
          &&(!repoIds.has(n.repositoryId)||repoIds.get(n.repositoryId)===n.repository),'identity');
        seen.add(key(n));nodes.add(n.issueId);paths.add(path(n));ids.add(n.databaseId);repos.set(n.repository,n.repositoryId);repoIds.set(n.repositoryId,n.repository);
      }
      signal=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(caller?[caller]:[])]);
      const deadline=new Promise((_,reject)=>{
        abort=()=>reject({reason:caller?.aborted?'cancelled':'timeout'});
        signal.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,timeoutMs);
      });
      let reads=0;
      const call=async (fn,clone=true)=>{
        need(!signal.aborted&&performance.now()-started<timeoutMs,caller?.aborted?'cancelled':'timeout');
        const v=await Promise.race([Promise.resolve().then(fn),deadline]);
        need(!signal.aborted&&performance.now()-started<timeoutMs,caller?.aborted?'cancelled':'timeout');return clone?copy(v):v;
      };
      const read=async n=>{need(++reads<=maxReads,'limit');const r=await call(()=>request({...n,method:'GET',signal}));need(r?.outcome==='read','read');return r.data;};
      const options=n=>({target:n.repositoryId,operation:'fanout',correlation:'fanout'});
      const list=async(n,relation)=>{
        const endpoint=path(n)+'/dependencies/'+relation;let pages=0;
        const result=await call(()=>collection({...options(n),method:'GET',endpoint:endpoint+'?per_page=100',signal,
          allowPage:p=>{
            if(signal.aborted||performance.now()-started>=timeoutMs||++pages>maxPages||++reads>maxReads)return false;
            try{const u=new URL(p,'https://api.github.com');return u.origin==='https://api.github.com'
              &&u.pathname===endpoint&&!u.hash&&!u.username&&!u.password
              &&[...u.searchParams.keys()].every(k=>['page','per_page'].includes(k)&&u.searchParams.getAll(k).length===1)
              &&[...u.searchParams.values()].every(v=>/^[1-9][0-9]*$/.test(v));}catch{return false;}
          }}));
        need(result?.outcome==='complete'&&Array.isArray(result.data),'discovery');
        need(result.data.length<=maxTargets,'limit');return result.data;
      };
      const completion=async()=>{
        const c=await call(()=>currentSource(copy(source),{signal}));
        const retrieved=await call(()=>retrieveReceipt(copy(source),{signal,expected:{cycle:c.cycle,identity:c.identity}}));
        need(retrieved?.cycle===c.cycle&&retrieved.identity===c.identity,'completion');
        const bytes=retrieved.bytes;
        let receipt;try {need(bytes instanceof Uint8Array,'completion');receipt=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
          receipt=verifyCompletion(receipt,c.expected);}catch{throw {reason:'completion'};}
        const b=receipt.payload.receipts.publication.binding;
        need(b.repositoryId===source.repositoryId&&b.issueId===source.issueId&&receipt.identity===c.identity,'completion');
        need(typeof c.cycle==='string'&&c.cycle.length>0&&c.provenance?.repositoryId===source.repositoryId,'completion');
        return {identity:receipt.identity,cycle:c.cycle,provenance:c.provenance};
      };
      const origin=await completion();
      need(publicRepo(await read({...options(source),endpoint:'/repos/'+source.repository}),source),'repository');
      need(matches(await read({...options(source),endpoint:path(source)}),source),'identity');
      const discovered=await list(source,'blocking'), targets=[], discoveredIds=new Set(), discoveredPaths=new Set(), discoveredDatabase=new Set();
      // Validate the entire collection before considering any submission, including unlisted rows.
      for(const d of discovered) {
        const n=row(d);
        need(!discoveredIds.has(n.issueId)&&!discoveredPaths.has(d.url)&&!discoveredDatabase.has(n.databaseId),'identity');
        discoveredDatabase.add(n.databaseId);discoveredIds.add(n.issueId);discoveredPaths.add(d.url);
        const known=[source,...catalog].find(x=>path(x)===path(n)||x.issueId===n.issueId||x.databaseId===n.databaseId);
        if(known)need(matches(d,known),'identity');
        targets.push(known??n);
      }
      for(const target of targets) {
        let executing=false,requestId;
        try {
          need(target.repositoryId,'unauthorized');
          const check=async()=>{
            need(same(await completion(),origin),'source-changed');
            const t=await call(()=>currentTarget(copy(target),{signal}));
            need(t?.ok===true&&t.binding.repository===target.repository&&t.binding.repositoryId===target.repositoryId
              &&t.binding.issueId===target.issueId&&t.binding.number===target.number,'unauthorized');
            const o=options(target);
            need(publicRepo(await read({...o,endpoint:'/repos/'+target.repository}),target),'repository');
            need(matches(await read({...o,endpoint:path(target)}),target),'identity');
            need(t.workflow && /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,119}$/.test(t.workflow.ref)
              &&!t.workflow.ref.startsWith('refs/')&&!/^[a-f0-9]{40}$/.test(t.workflow.ref)
              && /^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/.test(t.workflow.path),'request');
            githubId(t.workflow.id);
            const root='/repos/'+target.repository;
            const wf=await read({...o,endpoint:root+'/actions/workflows/'+t.workflow.id});
            need(wf.id===t.workflow.id&&wf.path===t.workflow.path,'target-changed');
            const commit=await read({...o,endpoint:root+'/commits/'+encodeURIComponent(t.workflow.ref)});
            need(commit.sha===t.workflow.sha,'target-changed');
            const file=await read({...o,endpoint:root+'/contents/'+t.workflow.path+'?ref='+encodeURIComponent(t.workflow.sha)});
            need(file.type==='file'&&file.path===t.workflow.path&&file.encoding==='base64'
              && typeof file.content==='string'&&byteDigest(Buffer.from(file.content,'base64'))===t.workflow.digest,'target-changed');
            const parents=await list(target,'blocked_by');
            const seenParents=new Set(),parentDB=new Set(),parentPaths=new Set();
            for(const d of parents) {
              const n=row(d);need(!seenParents.has(n.issueId)&&!parentDB.has(n.databaseId)&&!parentPaths.has(path(n)),'membership');
              seenParents.add(n.issueId);parentDB.add(n.databaseId);parentPaths.add(path(n));
              if(n.issueId===source.issueId||n.databaseId===source.databaseId||path(n)===path(source))need(matches(d,source),'membership');
            }
            need(seenParents.has(source.issueId),'membership');
            need(same(await call(()=>currentTarget(copy(target),{signal})),t),'target-changed');
            need(same(await completion(),origin),'source-changed');
            return t;
          };
          const t=await check();
          // Pin and provenance are part of the retained intent identity, never HTTP inputs.
          const seed={source,origin,target,binding:t.binding,workflow:t.workflow};
          const id='fanout-'+contentIdentity(seed);
          const intent=controlledIntent({version:1,kind:'dispatch',correlation:id,
            source:{...origin.provenance,request:id},binding:t.binding,
            target:{id:t.workflow.id,number:null,workflow:t.workflow.id},
            payload:{handoff:{source,origin,target,workflow:t.workflow},ref:t.workflow.ref,refIdentity:{sha:t.workflow.sha,workflowDigest:t.workflow.digest},
              display:{repository:target.repository,issue:target.number,stage:'resolve'},
              inputs:{nibfin_request:id,nibfin_correlation:id,nibfin_issue:target.number,nibfin_stage:'resolve'}}});
          need(intent.payload.refIdentity,'request');
          requestId=id;
          const retained={id,source,origin,target,intent};
          const beforeSubmit=async actual=>{need(same(actual,intent),'request');need(same(await check(),t),'target-changed');};
          const ops=await call(()=>operations({request:copy(retained),beforeSubmit,
            concurrency:nativeConcurrency({repository:target.repository,repositoryId:target.repositoryId,scope:'repository-write'})}),false);
          // Do not clone the capability object returned by the factory.
          executing=true;
          const result=await call(()=>ops.execute(intent,{signal}));
          outcomes.push({target:copy(target),request:id,outcome:result.outcome,operation:result});
        }catch(e){outcomes.push({target:copy(target),outcome:executing?'unknown':'blocked',reason:safe(e),...(requestId?{request:requestId}:{})});}
      }
      return {outcome:'discovered',continuation:false,outcomes};
    }catch(e){return {outcome:'blocked',continuation:false,reason:safe(e),outcomes};}
    finally{clearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort);}
  }});
}

/** Authenticated opaque hint -> trusted retained request -> fresh native evaluator.
 * A ready result is dependency eligibility only; host still checks Runner and stage gates.
 */
export async function resolveFanoutWakeup({inputs,authenticate,lookup,dependencies,dependencyInput,signal:caller,timeoutMs=30000}) {
  let timer,abort,signal;const started=performance.now();
  try {
    need(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=86400000,'limit');
    inputs=copy(inputs);dependencyInput=copy(dependencyInput);
    signal=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(caller?[caller]:[])]);
    const deadline=new Promise((_,reject)=>{abort=()=>reject({reason:'cancelled'});
      signal.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,timeoutMs);});
    const call=async fn=>{need(!signal.aborted&&performance.now()-started<timeoutMs,'cancelled');const value=await Promise.race([Promise.resolve().then(fn),deadline]);need(!signal.aborted&&performance.now()-started<timeoutMs,'cancelled');return value;};
    const evaluate=dependencies.evaluate.bind(dependencies);
    need(inputs&&same(Object.keys(inputs).sort(),['nibfin_correlation','nibfin_request',...(inputs.nibfin_stage!==undefined?['nibfin_issue','nibfin_stage']:[])].sort())
      &&/^fanout-[a-f0-9]{64}$/.test(inputs.nibfin_request)&&inputs.nibfin_request===inputs.nibfin_correlation,'request');
    const retained=copy(await call(()=>lookup(inputs.nibfin_request,{signal})));
    need(retained.id===inputs.nibfin_request,'request');
    const intent=controlledIntent(retained.intent);
    need(same(intent.payload.handoff,{source:retained.source,origin:retained.origin,target:retained.target,
      workflow:intent.payload.handoff?.workflow}),'request');
    need(intent.correlation===retained.id&&same(intent.payload.inputs,inputs),'request');
    need(intent.binding.repositoryId===retained.target.repositoryId&&intent.binding.issueId===retained.target.issueId
      &&intent.binding.repository===retained.target.repository&&intent.binding.number===retained.target.number,'identity');
    need(await call(()=>authenticate(copy(retained),{signal}))===true,'unauthorized');
    need(same(node(dependencyInput.target),retained.target),'identity');
    return await call(()=>evaluate(dependencyInput,{signal}));
  }catch{return {outcome:'blocked',continuation:false,reason:'wakeup'};}
  finally{clearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort);}
}
