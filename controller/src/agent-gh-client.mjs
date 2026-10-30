#!/usr/bin/env node
// Credential-free command bridge; the host executes restricted native gh.
import http from 'node:http';
import {readFileSync} from 'node:fs';
let repository=process.env.GH_REPO;
if(!repository)try{repository=JSON.parse(readFileSync('/io/context.json','utf8')).issue?.repository;}catch{}
const args=process.argv.slice(2);
if(!args.length||args.includes('--help')||args.includes('-h'))console.log('upstream read-only gh bridge: issue view/list, pr view/list/checks/diff, run view/list, repo view, release view/list, api GET, --version.\nUse --repo OWNER/REPO for the three approved public Nibfin repositories. Default output is JSON. Writes, arbitrary GraphQL, host downloads, browser commands and extensions are unavailable.');
else{
 const request=http.request({socketPath:'/github-read/read.sock',path:'/read',method:'POST',headers:{'content-type':'application/json'}},response=>{
  let size=0,parts=[];response.on('data',part=>{size+=part.length;if(size>17*1024*1024){response.destroy(Error('gh-read: response too large'));return;}parts.push(part);});
  response.on('error',error=>{console.error(error.message);process.exitCode=1;});response.on('end',()=>{try{const result=JSON.parse(Buffer.concat(parts));if(response.statusCode!==200)throw Error(result.error);process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.exitCode;}catch(error){console.error(error.message);process.exitCode=1;}});
 });request.setTimeout(40000,()=>request.destroy(Error('gh-read: timed out')));request.on('error',error=>{console.error(error.message);process.exitCode=1;});request.end(JSON.stringify({repository,args}));
}
