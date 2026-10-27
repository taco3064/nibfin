import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {releaseHash,releaseVersion} from '../src/release.mjs';
import {githubApiVersion} from '../src/provider.mjs';
import {verifyPreparedRelease} from './release.mjs';
const repository='taco3064/nibfin',repositoryId='1427838662';
const requireValue=(ok,reason)=>{if(!ok) throw Error('publication:'+reason);};
/** Official API orchestration; a failed/unknown write never triggers a blind retry. */
export async function publishRelease({manifest,assets,run,request,record,immutabilityPolicy='api-preflight'}) {
  requireValue(['api-preflight','repository-enforced'].includes(immutabilityPolicy),'immutability-policy');
  releaseVersion(manifest?.version);
  requireValue(manifest.source?.kind==='merged' && /^[a-f0-9]{40}$/.test(manifest.source.commit),'merged-source');
  const sha=manifest.source.commit,tag='v'+manifest.version,base='/repos/'+repository;
  requireValue(run?.repository===repository && run.repositoryId===repositoryId && run.ref==='refs/heads/main'
    && ['push','workflow_dispatch'].includes(run.event) && run.sha===sha
    && /^\d+$/.test(run.id) && /^\d+$/.test(run.attempt),'run-source');
  const expectedNames=['nibfin-core.tgz','compatibility.json','release-manifest.json'];
  requireValue(assets instanceof Map && assets.size===3 && expectedNames.every(n=>Buffer.isBuffer(assets.get(n))),'assets');
  requireValue(releaseHash(assets.get('nibfin-core.tgz'))===manifest.archive.sha256
    && releaseHash(assets.get('compatibility.json'))===manifest.compatibility.sha256
    && JSON.stringify(JSON.parse(assets.get('release-manifest.json')))===JSON.stringify(manifest),'asset-content');
  const mapping=[...assets].map(([name,bytes])=>({name,size:bytes.length,digest:'sha256:'+releaseHash(bytes)}));
  const body=JSON.stringify({format:1,source:sha,manifest:releaseHash(assets.get('release-manifest.json'))});
  const receipt={format:1,status:'checking',repository,source:sha,tag,version:manifest.version,run:{...run,
    url:`https://github.com/${repository}/actions/runs/${run.id}/attempts/${run.attempt}`},assets:mapping};
  record(receipt);
  const get=async(path,absent=false)=>{
    const r=await request({method:'GET',path});
    if(absent && r.status===404)return null;
    requireValue(r.status===200,'readback-'+r.status);return r.data;
  };
  const tagTarget=async reference=>{
    let object=reference?.object;const seen=new Set();
    for(let depth=0;depth<4;depth++) {
      requireValue(object && /^[a-f0-9]{40}$/.test(object.sha),'tag-object');
      if(object.type==='commit')return object.sha;
      requireValue(object.type==='tag' && !seen.has(object.sha),'tag-object');seen.add(object.sha);
      const annotated=await get(base+'/git/tags/'+object.sha);
      requireValue(annotated.sha===object.sha,'tag-object');object=annotated.object;
    }
    throw Error('publication:tag-depth');
  };
  const write=async(method,path,data,bytes)=>{
    record({...receipt,status:'write-intent',operation:{method,path}});
    let response;
    try {response=await request({method,path,data,bytes});}
    catch {record({...receipt,status:'unknown',operation:{method,path}});throw Error('publication:unknown-outcome-reconcile-before-retry');}
    if(![200,201].includes(response.status)) {
      record({...receipt,status:response.status>=500?'unknown':'failed',operation:{method,path},httpStatus:response.status});
      throw Error('publication:write-'+response.status+'-reconcile-before-retry');
    }
    return response.data;
  };
  try {
    const repo=await get(base);
    requireValue(String(repo.id)===repositoryId && repo.full_name===repository && repo.visibility==='public','repository');
    const branch=await get(base+'/branches/main');
    requireValue(branch.protected===true,'protected-main');
    // A protected main push is necessary but does not by itself prove a PR merge.
    const prs=await get(base+'/commits/'+sha+'/pulls?per_page=100');
    requireValue(Array.isArray(prs) && prs.some(p=>p.merged_at && p.merge_commit_sha===sha
      && p.base?.ref==='main' && String(p.base.repo?.id)===repositoryId),'protected-merge');
    // This endpoint returns 200 only when enabled; 404/permission failure blocks.
    if(immutabilityPolicy==='api-preflight')requireValue((await get(base+'/immutable-releases'))?.enabled===true,'immutable-setting');
    let ref=await get(base+'/git/ref/tags/'+tag,true);
    if(ref) requireValue(await tagTarget(ref)===sha,'conflicting-tag');
    // Authenticated list releases includes drafts; release-by-tag is published-only.
    const matches=[];
    for(let page=1; ;page++) {
      requireValue(page<=100,'release-discovery-limit');
      const releases=await get(base+'/releases?per_page=100&page='+page);
      requireValue(Array.isArray(releases) && releases.length<=100,'release-list');
      matches.push(...releases.filter(r=>r.tag_name===tag));
      if(releases.length<100)break;
    }
    requireValue(matches.length<=1,'ambiguous-release');
    let release=matches[0] ?? null;
    const identity=r=>requireValue(r.tag_name===tag && r.target_commitish===sha && r.body===body
      && Number.isSafeInteger(r.id) && r.id>0,'conflicting-release');
    if(release) {
      identity(release);
      const id=release.id;
      release=await get(base+'/releases/'+id);identity(release);
      requireValue(release.id===id,'release-id');
    }
    else {
      requireValue(!ref,'unowned-tag');
      const created=await write('POST',base+'/releases',{tag_name:tag,target_commitish:sha,name:tag,body,draft:true,prerelease:false});
      identity(created);requireValue(created.draft===true,'created-draft');
      release=await get(base+'/releases/'+created.id);identity(release);
      requireValue(release.id===created.id,'release-id');
    }
    const readAssets=()=>get(base+'/releases/'+release.id+'/assets?per_page=100');
    let existing=await readAssets();
    const validate=(list,complete)=>{
      requireValue(Array.isArray(list) && list.length<=mapping.length,'asset-inventory');
      const names=new Set();
      for(const a of list) {
        const e=mapping.find(x=>x.name===a.name);
        requireValue(e && !names.has(a.name) && a.state==='uploaded' && a.size===e.size && a.digest===e.digest,'conflicting-asset');
        names.add(a.name);
      }
      if(complete)requireValue(names.size===mapping.length,'missing-asset');
    };
    validate(existing,!release.draft);
    if(release.draft) {
      for(const asset of mapping) if(!existing.some(a=>a.name===asset.name)) {
        // Construct the official upload URL locally, never forward credentials to an API-provided host.
        await write('POST',`https://uploads.github.com${base}/releases/${release.id}/assets?name=${asset.name}`,null,assets.get(asset.name));
        existing=await readAssets();validate(existing,false);
        requireValue(existing.some(a=>a.name===asset.name),'upload-readback');
      }
      validate(existing,true);
      if(immutabilityPolicy==='api-preflight')requireValue((await get(base+'/immutable-releases'))?.enabled===true,'immutable-setting');
      await write('PATCH',base+'/releases/'+release.id,{draft:false});
    }
    release=await get(base+'/releases/tags/'+tag);identity(release);
    requireValue(release.draft===false && release.immutable===true && !!release.published_at,'not-immutable-published');
    ref=await get(base+'/git/ref/tags/'+tag);
    requireValue(await tagTarget(ref)===sha,'published-tag');
    existing=await readAssets();validate(existing,true);
    const result={...receipt,status:'published',release:{id:release.id,url:release.html_url,immutable:true,publishedAt:release.published_at},
      assets:existing.map(a=>({name:a.name,id:a.id,size:a.size,digest:a.digest,url:a.browser_download_url}))};
    record(result);return result;
  } catch(error) {
    // Preserve the write-intent/unknown record; outer orchestration must not report success.
    throw error;
  }
}
export function githubReleaseRequest(token) {
  requireValue(typeof token==='string' && token.length>0,'missing-token');
  return async({method,path,data,bytes})=>{
    const url=path.startsWith('/')?'https://api.github.com'+path:path;
    requireValue(url.startsWith('https://api.github.com/repos/'+repository+'/') || url==='https://api.github.com/repos/'+repository
      || url.startsWith('https://uploads.github.com/repos/'+repository+'/releases/'),'request-origin');
    const response=await fetch(url,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{
      // The provenance contract needs merge_commit_sha, removed in 2026-03-10.
      Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':githubApiVersion,
      'Content-Type':bytes?'application/octet-stream':'application/json'},body:bytes ?? (data?JSON.stringify(data):undefined)});
    const text=await response.text();
    return {status:response.status,data:text?JSON.parse(text):null};
  };
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const manifest=verifyPreparedRelease();
  const assets=new Map(['nibfin-core.tgz','compatibility.json','release-manifest.json'].map(n=>[n,readFileSync('out/'+n)]));
  const env=process.env;
  await publishRelease({manifest,assets,run:{repository:env.GITHUB_REPOSITORY,repositoryId:env.GITHUB_REPOSITORY_ID,
    ref:env.GITHUB_REF,event:env.GITHUB_EVENT_NAME,sha:env.GITHUB_SHA,id:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT},
    request:githubReleaseRequest(env.NIBFIN_RELEASE_TOKEN),immutabilityPolicy:env.NIBFIN_RELEASE_IMMUTABILITY_POLICY||'api-preflight',record:r=>writeFileSync('out/publication-result.json',JSON.stringify(r,null,2)+'\n')});
}
