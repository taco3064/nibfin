import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import {createRegistrationHost,createRegistrationArtifactChannel,registrationArtifactReader,createGithubProvider} from '../src/index.mjs';
import {zipFixture} from './custody-fixture.mjs';
const pair = () => {
  const k = generateKeyPairSync('rsa',{modulusLength:2048});
  return {publicKey:k.publicKey.export({type:'spki',format:'pem'}),privateKey:k.privateKey.export({type:'pkcs8',format:'pem'})};
};
const keys = pair(), sentinel = 'SENTINEL-registration-secret';
function fixture() {
  const s = {authenticated:true,event:'workflow_dispatch',requestId:'request-1',requester:{id:'8',login:'member'},
    repository:'example/core',repositoryId:'42',runId:'91',attempt:'1',level:'repository',publicKey:keys.publicKey};
  const p = {enabled:true,repository:s.repository,repositoryId:'42',capabilities:{'administration:write':true,
    'organization_self_hosted_runners:write':true},organization:{enabled:true,login:'example',id:'7'}};
  const state = {now:Date.parse('2026-10-25T00:00:00Z'),permission:'write',ownerType:'User',
    expiry:'2026-10-25T01:00:00Z',change:x=>x,readChange:x=>x};
  const calls = [], staged = [], paths = []; let zip, captured, posts = 0;
  const transport = async r => {
    calls.push(r);
    let d;
    if (r.method === 'POST') {
      posts++;
      if (state.loss) throw Error(sentinel);
      if (state.hang) return new Promise(()=>{});
      if (state.status) return {status:state.status,headers:{},body:sentinel};
      d = {token:sentinel,expires_at:state.expiry};
      if (state.tokenChange) d = state.tokenChange(d);
    } else if (r.endpoint === '/repos/example/core') d = {id:'42',full_name:'example/core',private:false,
      visibility:'public',owner:{id:'7',login:'example',type:state.ownerType}};
    else if (r.endpoint === '/repos/example/core/collaborators/member/permission')
      d = {permission:state.permission,user:{id:'8',login:'member'}};
    else if (r.endpoint === '/users/member') d = {id:'8',login:'member'};
    else if (r.endpoint === '/orgs/example') d = {id:'7',login:'example'};
    else if (r.endpoint === '/repos/example/core/actions/runs/91') d = {id:'91',run_attempt:1,repository:{id:'42'}};
    else if (r.endpoint === '/repos/example/core/actions/runs/91/artifacts?per_page=100') d = {total_count:1,artifacts:[{
      id:'92',name:'registration-request-1-1',expired:false,expires_at:'2030-01-01T00:00:00Z',
      workflow_run:{id:'91'},size_in_bytes:zip.length}]};
    else throw Error('Unexpected endpoint');
    return {status:200,headers:{},body:JSON.stringify(state.change(d,r))};
  };
  const reader = registrationArtifactReader({provider:createGithubProvider({transport,attempts:1}),archive:async r=> {
    assert.equal(r.endpoint,'/repos/example/core/actions/artifacts/92/zip');
    return {status:200,bytes:state.zipChange?state.zipChange(zip):zip};
  }});
  const client = {async uploadArtifact(name, files, root, options) {
    assert.equal(name,'registration-request-1-1'); assert.deepEqual(options,{retentionDays:1,compressionLevel:6});
    assert.equal(files.length,1); assert.equal((await stat(root)).mode & 0o777,0o700);
    paths.push(root);
    captured = await readFile(files[0]); staged.push(captured.toString());
    assert.equal((await stat(files[0])).mode & 0o777,0o600);
    zip = zipFixture([['response.json',captured]]);
    if (state.uploadLoss) throw Error(sentinel);
    return {id:'92'};
  }};
  const runtime = {facility:'@actions/artifact@2.3.2',available:true,repository:'example/core',repositoryId:'42',runId:'91',attempt:'1'};
  const channel = createRegistrationArtifactChannel({client,runtime,now:()=>state.now,
    read:async arg => {if (state.readFailure) throw Error(sentinel); const back = await reader(arg); return state.readChange(back);},
    ...(state.remove?{remove:state.remove}:{})});
  let policyCalls = 0;
  const host = options => createRegistrationHost({authenticate:async handle => {
    assert.equal(handle,'opaque-host-handle'); return s;
  },policy:async () => {policyCalls++; if (state.policyChange && policyCalls % 2 === 0) return {...p,enabled:false}; return p;},
  transport,channel,now:()=>state.now,...options});
  return {s,p,state,calls,staged,paths,host,channel,reader,client,runtime,transport,
    issue:options=>host(options).issue('opaque-host-handle'),bytes:()=>captured,posts:()=>posts};
}

export {fixture as registrationFixture,keys as registrationKeys,sentinel as registrationSentinel,pair};
