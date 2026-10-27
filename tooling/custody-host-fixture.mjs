// Local provider service: owns immutable remote bytes, never producer temp files.
import {readFile} from 'node:fs/promises';
import {relative} from 'node:path';
import {createGithubProvider,artifactArchiveTransport,createCustodyHost,
  custodySlotIdentity,byteDigest,canonicalJSON} from '../src/index.mjs';
import {zipFixture} from './custody-fixture.mjs';
export function custodyHostFixture(repository='example-org/core',run='9007199254740993') {
  const remote={artifacts:new Map(),reserved:new Set(),slots:new Map(),uploads:0,reads:0,storage:[],
    ownership:repository.startsWith('example-org/')?'organization':'personal',error:null,hang:false,
    incomplete:false,duplicate:false,runChange:r=>r,archiveChange:b=>b,metadataChange:m=>m,
    lostUpload:null,failUpload:null,afterUpload:null,readbackFail:false,clock:Date.parse('2026-10-27')};
  const h='a'.repeat(64);
  const slot=(kind='role-output',key='request-1')=>({kind,key,binding:{
    source:{repository,repositoryId:'42',revision:'b'.repeat(40),runId:run,attempt:'1'},
    target:{repository,repositoryId:'42',issueId:'I_101'},requirements:{revision:h,scopeHash:h,shapeHash:h},
    authorization:h,cycle:'cycle-1',role:'deliver',stage:'deliver',request:key,result:'result-1',candidate:null}});
  function register(s){const v=structuredClone(s);remote.slots.set(v.kind+':'+v.key,v);
    remote.slots.set(v.kind+':'+custodySlotIdentity(v),v);return v;}
  const metadata=a=>remote.metadataChange({id:a.id,name:a.name,size_in_bytes:a.bytes.length,expired:false,
    expires_at:'2030-01-01T00:00:00Z',digest:'sha256:'+byteDigest(a.bytes),
    workflow_run:{id:run,repository_id:'42'}});
  const transport=async r=>{
    remote.reads++;
    if(remote.hang)return new Promise(()=>{});
    if(remote.error)return {status:remote.error,body:JSON.stringify({private:'PRIVATE-SENTINEL',url:'https://storage.example/?sig=secret'})};
    const prefix=`/repos/${repository}/actions`;
    let data;
    if(r.endpoint===`/repos/${repository}`)data={id:'42',full_name:repository,private:false,
      owner:{type:remote.ownership==='personal'?'User':'Organization'}};
    else if(r.endpoint===`${prefix}/runs/${run}/attempts/1`)data=remote.runChange({id:run,run_attempt:1,head_sha:'b'.repeat(40),repository:{id:'42',full_name:repository,private:false}});
    else if(r.endpoint===`${prefix}/runs/${run}/artifacts?per_page=100`){
      const artifacts=[...remote.artifacts.values()].map(metadata);
      data={total_count:artifacts.length+(remote.incomplete?1:0),artifacts:remote.duplicate&&artifacts.length?[...artifacts,artifacts[0]]:artifacts};
    } else if(r.endpoint.startsWith(prefix+'/artifacts/')){
      const a=remote.artifacts.get(r.endpoint.split('/').at(-1));if(!a)return {status:404,body:'{}'};data=metadata(a);
    } else throw Error('unexpected fixture endpoint');
    return {status:200,body:JSON.stringify(data)};
  };
  const archive=artifactArchiveTransport({api:async r=>{
    const id=r.endpoint.split('/').at(-2);if(!remote.artifacts.has(id))return {status:404};
    if(remote.readbackFail)throw Error('PRIVATE-SENTINEL');
    return {status:302,headers:{location:`https://storage.example/${id}?sig=PRIVATE-SENTINEL`}};
  },fetch:async(url,options)=>{
    remote.storage.push({url,options});const id=new URL(url).pathname.slice(1);
    return new Response(remote.archiveChange(remote.artifacts.get(id).bytes),{status:200});
  }});
  const provider=createGithubProvider({transport,attempts:1});
  const client={uploadArtifact:async(name,paths,root)=>{
    remote.uploads++;const phase=name.startsWith('nibfin-intent-')?'intent':'result';
    if(remote.failUpload===phase)throw Error('PRIVATE-SENTINEL');
    const entries=await Promise.all(paths.map(async p=>[relative(root,p),await readFile(p)]));
    const bytes=zipFixture(entries),id=String(100+remote.uploads);
    remote.artifacts.set(id,{id,name,bytes,entries});
    await remote.afterUpload?.({phase,id,root});
    if(remote.lostUpload===phase)throw Error('https://storage.example/?sig=PRIVATE-SENTINEL');
    return {id,digest:byteDigest(bytes)};
  }};
  const runtime={facility:'@actions/artifact@2.3.2',repository,repositoryId:'42',runId:run,attempt:'1',available:true};
  function fresh(overrides={}) {
    return createCustodyHost({provider,archive,expect:async({kind,key})=>{
      const expected=remote.slots.get(kind+':'+key);if(!expected)throw Error('unapproved');return structuredClone(expected);
    },publication:async()=>({client,runtime}),authorizeNew:async s=>{
      // Simulated durable Core original-attempt history, separate from artifacts.
      const id=custodySlotIdentity(s);if(remote.reserved.has(id))return false;
      remote.reserved.add(id);return true;
    },now:()=>remote.clock,secrets:['PRIVATE-SENTINEL'],...overrides});
  }
  const argument=(s,value)=>({kind:s.kind,key:s.key,identity:{repository,repositoryId:'42',visibility:'public',
    ownership:remote.ownership,run:{id:run,attempt:'1'}},...(value===undefined?{}:{value})});
  function rewrite(s,phase,change) {
    const a=[...remote.artifacts.values()].find(a=>a.name===`nibfin-${phase}-${custodySlotIdentity(s)}`);
    const files=new Map(a.entries.map(([p,b])=>[p,Buffer.from(b)]));change(files);a.bytes=zipFixture(files);
  }
  function changeRecord(s,phase,change) {
    const a=[...remote.artifacts.values()].find(a=>a.name===`nibfin-${phase}-${custodySlotIdentity(s)}`);
    // Kept here only for malformed-byte negative tests; tests normally treat the
    // remote provider as immutable. No success is inherited from fixture state.
    a.bytes=change(a.bytes);
  }
  return {remote,slot,register,provider,transport,archive,client,runtime,fresh,argument,changeRecord,rewrite,canonicalJSON};
}
