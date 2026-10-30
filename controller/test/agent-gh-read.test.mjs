import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {githubReadRequest,createGithubReadService} from '../src/agent-gh-read.mjs';
import {CodexAgent} from '../src/agent.mjs';
import {generateKeyPairSync} from 'node:crypto';
import {signGrant,verifyCoreUpgrade} from '../src/authority.mjs';
import {digest} from '../src/core.mjs';
const repository='taco3064/nibfin';
const parse=(...args)=>githubReadRequest({repository,args});

test('capability needs the exact signed Core amendment and cannot be enabled by editing payload bytes',()=>{
 const keys=generateKeyPairSync('ed25519'),pub=keys.publicKey.export({type:'spki',format:'pem'}),priv=keys.privateKey.export({type:'pkcs8',format:'pem'});
 const grant={recordId:'original',manifest:{id:'cohort'},policy:{controlMode:'owner-project',runtimeHash:'r',coreDigest:'a'.repeat(64)}};
 const payload={schemaVersion:1,kind:'owner-core-upgrade',grantRecordId:grant.recordId,manifestHash:digest(grant.manifest),policyHash:digest(grant.policy),runtimeHash:'r',fromCoreDigest:grant.policy.coreDigest,toCoreDigest:'b'.repeat(64),sourceCommit:'c'.repeat(40),reason:'Owner approved scoped gh reads',agentGithubRead:true};
 const signed=signGrant(payload,priv);assert.equal(verifyCoreUpgrade(signed,grant,payload.toCoreDigest,pub).agentGithubRead,true);
 const forged=structuredClone(signed);forged.payload.agentGithubRead=false;assert.throws(()=>verifyCoreUpgrade(forged,grant,payload.toCoreDigest,pub));
 for(const value of [false,'true',{},null])assert.throws(()=>verifyCoreUpgrade(signGrant({...payload,agentGithubRead:value},priv),grant,payload.toCoreDigest,pub));
});

test('native read profiles force approved public repos and structured fields',()=>{
 assert.deepEqual(parse('issue','view','190','--json','number,title').args,['issue','view','190','--repo',repository,'--json','number,title']);
 assert.equal(parse('pr','checks','221','--required').repository,repository);
 assert.equal(parse('run','view','40493959301','--log-failed').repository,repository);
 assert.deepEqual(parse('repo','view').args.slice(0,3),['repo','view',repository]);
 assert.equal(parse('issue','list','--repo=taco3064/gh-nibfin','--limit','10').repository,'taco3064/gh-nibfin');
 assert.equal(parse('api','repos/taco3064/nibfin/issues/190','--jq','.number').repository,repository);
 assert.equal(parse('--version').repository,null);
});

test('writes, arbitrary GraphQL, host execution, cross-repo access and traversal never reach gh',()=>{
 for(const args of [
  ['issue','edit','190'],['issue','comment','190'],['pr','merge','221'],['pr','checkout','221'],['run','rerun','1'],['workflow','run','core-release.yml'],
  ['auth','token'],['extension','exec','x'],['repo','delete'],['run','download','1'],['release','download','v0.1.0'],
  ['issue','view','1','--repo','retired-private-source'],['issue','view','1','--web'],['issue','view','1','--search','repo:private'],
  ['issue','view','1','--json','projectItems'],['issue','view','https://github.com/private/repo/issues/1'],['pr','view'],
  ['api','graphql'],['api','repos/retired-private-source/issues'],['api','repos/taco3064/nibfin/issues','-X','POST'],
  ['api','repos/taco3064/nibfin/../../nibfin/issues'],['api','repos/taco3064/nibfin/contents/%2e%2e'],
  ['api','repos/taco3064/nibfin/actions/secrets'],['api','repos/taco3064/nibfin/issues','--header','Authorization: bad'],
  ['issue','list','--limit','999'],['issue','view','1','--json','title\n--web'],
  ['api','repos/taco3064/nibfin','--jq','env'],['issue','view','1','--jq','include "file"; .'],
 ])assert.throws(()=>parse(...args),/gh-read:/,JSON.stringify(args));
});

async function service(t,run){
 const server=createGithubReadService(run);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 return body=>new Promise((resolve,reject)=>{const r=http.request({host:'127.0.0.1',port:server.address().port,path:'/read',method:'POST'},response=>{const parts=[];response.on('data',p=>parts.push(p));response.on('end',()=>resolve({status:response.statusCode,...JSON.parse(Buffer.concat(parts))}));});r.on('error',reject);r.end(JSON.stringify(body));});
}
test('RPC checks public identity, uses native gh without caller env and never discloses native error secrets',async t=>{
 const calls=[];let privateRepo=false,fail=false;
 const invoke=await service(t,async(executable,args,options)=>{
  calls.push(args);assert.equal(executable,'gh');assert.equal(options.cwd,'/');assert(!options.env.GH_TOKEN);assert(!options.env.GH_DEBUG);
  if(args[0]==='api')return{stdout:JSON.stringify({full_name:repository,private:privateRepo})};
  if(fail)throw Object.assign(Error('secret signed URL'),{stderr:'secret-token'});
  return{stdout:'{"number":190}',stderr:'not exposed'};
 });
 let result=await invoke({repository,args:['issue','view','190','--json','number']});assert.equal(result.status,200);assert.equal(result.stdout,'{"number":190}');assert.equal(result.stderr,'');assert.equal(calls.length,2);
 result=await invoke({repository,args:['pr','merge','221']});assert.equal(result.status,403);assert.equal(calls.length,2);
 privateRepo=true;result=await invoke({repository,args:['issue','view','190']});assert.equal(result.status,403);assert.equal(calls.length,3);
 privateRepo=false;fail=true;result=await invoke({repository,args:['issue','view','190']});assert.equal(result.status,403);assert(!JSON.stringify(result).includes('secret'));
});
test('unsigned/default Agents have no gh mount; enabled Agents get only client and socket',()=>{
 const agent=new CodexAgent({image:'sha256:'+'a'.repeat(64),network:'restricted',user:'1000:1000',authDirectory:'/auth'},'/trusted/core','/state');
 assert(!agent.executionArgs('/work','/io',false).some(a=>a.includes('github-read')));
 agent.githubRead=true;const args=agent.executionArgs('/work','/io',false);
 assert(args.some(a=>a.endsWith('dst=/usr/local/bin/gh,readonly')));assert(args.some(a=>a.endsWith('dst=/github-read,readonly')));
 assert(!args.some(a=>a.includes('.config/gh')||a.includes('hosts.yml')||a.includes('GH_TOKEN')));
 assert(args.some(a=>a.endsWith('dst=/work,readonly')));
});
