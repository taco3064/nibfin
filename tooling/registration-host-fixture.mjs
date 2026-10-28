import {generateKeyPairSync} from 'node:crypto';
import * as core from '../src/index.mjs';
import {hostIdentityFixture} from './host-identity-fixture.mjs';
import {custodyHostFixture} from './custody-host-fixture.mjs';
export async function registrationHostFixture() {
  const f=await hostIdentityFixture('registration');
  const remote=custodyHostFixture(f.context.repository,'44',f.context.repositoryId);
  remote.remote.clock=f.state.time;
  const keys=generateKeyPairSync('rsa',{modulusLength:2048});
  const input={nibfin_registration:'registration_1',public_key:keys.publicKey.export({type:'spki',format:'pem'}),level:'repository'};
  const request={input,requester:{id:'42',login:'member'}};
  const policy={enabled:true,repository:f.context.repository,repositoryId:f.context.repositoryId,
    capabilities:{'administration:write':true,'organization_self_hosted_runners:write':true},
    organization:{enabled:true,login:'example-org',id:'17'}};
  const sentinel='SYNTHETIC-REGISTRATION-TOKEN';
  let posts=0,policyReads=0;
  const state=Object.assign(f.state,{failResult:false,lostPost:false,policyHook:null,credentialHook:null});
  const transport=async r=>{
    if(r.method==='POST'){
      posts++;if(state.postStatus)return {status:state.postStatus,body:JSON.stringify({private:sentinel})};
      if(state.lostPost)throw Error('lost');
      return {status:200,body:JSON.stringify({token:sentinel,expires_at:'2030-01-01T00:00:00Z'})};
    }
    if(r.endpoint==='/orgs/example-org')return {status:200,body:JSON.stringify({id:'17',login:'example-org'})};
    return f.facility.transport(r);
  };
  Object.defineProperty(transport,'prepareMutation',{value:async()=>{await state.credentialHook?.();return transport;}});
  const identityConfiguration=f.identityConfiguration();
  delete identityConfiguration.authorization;
  const facade={...core,createHostIdentityAdapters:c=>core.createHostIdentityAdaptersForTest(c,{...f.facility,transport})};
  const custody={provider:remote.provider,archive:remote.archive,now:()=>f.state.time,
    publication:async({slot,phase})=>{
      if(state.failResult&&slot.kind==='registration-result')throw Error('result retention unavailable');
      return {client:remote.client,runtime:remote.runtime,...(phase==='response'&&state.remove?{remove:state.remove}:{})};
    },authorizeNew:async s=>{
      const id=core.custodySlotIdentity(s);if(remote.remote.reserved.has(id))return false;
      remote.remote.reserved.add(id);return true;
    }};
  delete custody.now;
  const deployment=()=>({options:f.config.options,identity:identityConfiguration,custody,capabilities:{},
    registration:{request:structuredClone(request),policy:async()=>{policyReads++;await state.policyHook?.(policyReads);return structuredClone(policy);},
      now:()=>f.state.time,timeoutMs:2000}});
  return {...f,remote,keys,input,request,policy,sentinel,state,facade,deployment,posts:()=>posts,
    response:()=>[...remote.remote.artifacts.values()].find(a=>a.name.startsWith('registration-'))};
}

/** Exact approved source checkout used by loader/CLI contract tests, including
 * installed archive consumers. Only the already locked jose runtime is copied. */
export async function registrationSourceFixture() {
  const {mkdtemp,mkdir,readFile,writeFile,cp,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join,dirname}=await import('node:path');
  const {fileURLToPath}=await import('node:url');
  const producer=dirname(dirname(fileURLToPath(import.meta.resolve('../src/index.mjs'))));
  const root=await mkdtemp(join(tmpdir(),'nibfin-registration-source-'));
  const bundle=join(root,'nibfin-bundle'),host=join(root,'nibfin-host');
  const manifest=JSON.parse(await readFile(join(producer,'package.json')));
  const paths=['package.json','package-lock.json','README.md',...manifest.files];
  try {
    for(const path of paths) {
      await mkdir(dirname(join(bundle,path)),{recursive:true});
      if(path==='package-lock.json')await writeFile(join(bundle,path),await readFile(join(producer,path))
        .catch(()=>readFile(join(process.cwd(),'core-lock-fixture.json'))));
      else await cp(join(producer,path),join(bundle,path));
    }
    for(const path of core.protectedHostFiles) {
      await mkdir(dirname(join(host,path)),{recursive:true});await cp(join(producer,path),join(host,path));
    }
    await mkdir(join(bundle,'node_modules'));
    await cp(dirname(dirname(dirname(fileURLToPath(import.meta.resolve('jose'))))),join(bundle,'node_modules/jose'),{recursive:true});
    const approval=async(where,paths,commit)=>({repository:'taco3064/nibfin',commit,
      files:await Promise.all(paths.map(async path=>({path,sha256:core.byteDigest(await readFile(join(where,path)))})))});
    const bundleApproval=await approval(bundle,paths,'a'.repeat(40));
    const hostApproval=await approval(host,core.protectedHostFiles,'b'.repeat(40));
    return {root,bundle,host,bundleApproval,hostApproval,cleanup:()=>rm(root,{recursive:true,force:true})};
  } catch(error){await rm(root,{recursive:true,force:true});throw error;}
}
