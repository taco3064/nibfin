// Adapted Kairo d1b47d5 tests; dynamic personal/Organization public repositories.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {githubReadRequest,createGithubReadService} from '../src/agent-gh-read.mjs';
const repository='public-owner/project',repositories=[repository,'example-org/other'];
const parse=(...args)=>githubReadRequest({repository,args},repositories);

test('native read profiles force approved public repos and structured fields',()=>{
 assert.deepEqual(parse('issue','view','190','--json','number,title').args,['issue','view','190','--repo',repository,'--json','number,title']);
 assert.equal(parse('pr','checks','221','--required').repository,repository);
 assert.equal(parse('run','view','40493959301','--log-failed').repository,repository);
 assert.deepEqual(parse('repo','view').args.slice(0,3),['repo','view',repository]);
 assert.equal(parse('issue','list','--repo=example-org/other','--limit','10').repository,'example-org/other');
 assert.equal(parse('api','repos/public-owner/project/issues/190','--jq','.number').repository,repository);
 assert.equal(parse('--version').repository,null);
});

test('writes, arbitrary GraphQL, host execution, cross-repo access and traversal never reach gh',()=>{
 for(const args of [
  ['issue','edit','190'],['issue','comment','190'],['pr','merge','221'],['pr','checkout','221'],['run','rerun','1'],['workflow','run','core-release.yml'],
  ['auth','token'],['extension','exec','x'],['repo','delete'],['run','download','1'],['release','download','v0.1.0'],
  ['issue','view','1','--repo','unauthorized/private'],['issue','view','1','--web'],['issue','view','1','--search','repo:private'],
  ['issue','view','1','--json','projectItems'],['issue','view','https://github.com/private/repo/issues/1'],['pr','view'],
  ['api','graphql'],['api','repos/unauthorized/private/issues'],['api','repos/public-owner/project/issues','-X','POST'],
  ['api','repos/public-owner/project/../../kairo/issues'],['api','repos/public-owner/project/contents/%2e%2e'],
  ['api','repos/public-owner/project/actions/secrets'],['api','repos/public-owner/project/issues','--header','Authorization: bad'],
  ['issue','list','--limit','999'],['issue','view','1','--json','title\n--web'],
  ['api','repos/public-owner/project','--jq','env'],['issue','view','1','--jq','include "file"; .'],
 ])assert.throws(()=>parse(...args),/gh-read:/,JSON.stringify(args));
});

async function service(t,run){
 const server=createGithubReadService({repositories,run});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
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
