// Fixed, credential-free MCP surface for read-only model roles. No shell tool,
// checkout configuration, caller environment, server command or host capability.
import {readFile,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import http from 'node:http';
import {containsCredentials} from './credential-output.mjs';
import {runVerification,validateBudget,mountedSecrets,verificationBudget} from './verification-runner.mjs';
export const readonlyToolNames=Object.freeze(['verify','github_read']);
export const readonlyMcpServer=Object.freeze({command:'/usr/local/bin/node',args:['/readonly-tools.mjs'],
  env:{ANTHROPIC_API_KEY:'',GEMINI_API_KEY:'',NODE_OPTIONS:''}});
const strings={type:'array',items:{type:'string'},maxItems:256};
export const readonlyTools=Object.freeze([
  {name:'verify',description:'Run a guarded command in a writable test copy. For a locked Node project, prepare its inputs first: file=/usr/local/bin/node, args=[/verification-prepare.mjs,/work,/tmp], cwd=/tmp. Use the returned directory as cwd for locked project tests. Source-only regression harnesses without npm manifests may use bounded temporary fixtures in this same guarded lane, preserving the read-only Candidate. Never interpret non-passed results as passes. Receipts and logs are retained by Core.',
    inputSchema:{type:'object',additionalProperties:false,required:['file','args','cwd'],properties:{file:{type:'string'},args:strings,cwd:{type:'string'},timeoutMs:{type:'integer',minimum:1,maximum:3600000}}}},
  {name:'github_read',description:'Read authorized public repositories through the narrow host broker. Use native gh read arguments with an explicit --repo. Mutation commands are rejected by the broker.',
    inputSchema:{type:'object',additionalProperties:false,required:['args'],properties:{args:strings}}}
]);
const cleanEnvironment=Object.freeze({PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp/home',LANG:'C',
  HTTP_PROXY:'http://nibfin-egress:8080',HTTPS_PROXY:'http://nibfin-egress:8080',NODE_USE_ENV_PROXY:'1',NO_PROXY:''});
const invalid=()=>{throw Error('readonly-tools: invalid request');};
export async function createReadonlyTools({input='/input',directory='/verification/commands',scratch='/tmp',
  socket='/github-read/read.sock',secrets}={}) {
  const budget=validateBudget(JSON.parse(await readFile(input+'/verification-budget.json','utf8')));
  const pathMappings=JSON.parse(await readFile(input+'/verification-paths.json','utf8'));
  const protectedSecrets=secrets??await mountedSecrets();
  const writable=[await realpath(scratch),await realpath(resolve(directory,'..'))];
  return async (name,value,signal)=>{
    if(!value||typeof value!=='object'||Array.isArray(value)||!Array.isArray(value.args)||value.args.length>256||
      value.args.some(v=>typeof v!=='string'||v.includes('\0')||v.length>65536))invalid();
    if(name==='verify') {
      if(Object.keys(value).some(k=>!['file','args','cwd','timeoutMs'].includes(k))||
        typeof value.file!=='string'||!value.file.startsWith('/')||typeof value.cwd!=='string'||!value.cwd.startsWith('/')||
        (value.timeoutMs!==undefined&&(!Number.isSafeInteger(value.timeoutMs)||value.timeoutMs<1||value.timeoutMs>3600000)))invalid();
      const cwd=await realpath(value.cwd);
      if(!writable.some(root=>cwd===root||cwd.startsWith(root+'/')))invalid();
      const stop=Math.min(budget.stopVerificationAt,Date.now()+(value.timeoutMs??3600000));
      const bounded={...verificationBudget(Math.max(1,stop-budget.startedAt),budget.startedAt,0),execution:budget.execution};
      const result=await runVerification(value.file,value.args,{directory,budget:bounded,cwd,env:cleanEnvironment,
        signal,stdout:null,stderr:null,secrets:protectedSecrets,pathMappings,maxBytes:1048576});
      return {content:[{type:'text',text:JSON.stringify(result)}],isError:result.status!=='passed'};
    }
    if(name!=='github_read'||Object.keys(value).some(k=>k!=='args'))invalid();
    if(Date.now()>=budget.stopVerificationAt||signal.aborted)throw Error('readonly-tools: budget exhausted or cancelled');
    return new Promise((done,reject)=>{
      const request=http.request({socketPath:socket,path:'/read',method:'POST',signal,
        headers:{'content-type':'application/json'}},response=>{
        let size=0;const parts=[];
        response.on('data',part=>{size+=part.length;if(size>1048576)response.destroy(Error('readonly-tools: response too large'));else parts.push(part);});
        response.on('error',reject);response.on('end',()=>{
          try {const value=JSON.parse(Buffer.concat(parts));
            if(response.statusCode!==200||value.exitCode!==0||typeof value.stdout!=='string'||containsCredentials(value.stdout,protectedSecrets))throw Error('readonly-tools: GitHub read rejected');
            done({content:[{type:'text',text:value.stdout}],isError:false});
          }catch{reject(Error('readonly-tools: GitHub read rejected'));}
        });
      });
      request.on('error',reject);request.setTimeout(Math.min(40000,Math.max(1,budget.stopVerificationAt-Date.now())),()=>request.destroy());
      request.end(JSON.stringify({args:value.args}));
    });
  };
}
// MCP stdio is newline-delimited JSON-RPC. EOF, cancellation and termination
// abort owned work; the existing verification subreaper reconciles descendants.
export async function serveReadonlyTools({input=process.stdin,output=process.stdout,invoke}={}) {
  invoke??=await createReadonlyTools();
  let buffer='',closed=false;const active=new Map(),pending=new Set();
  const send=value=>{if(!closed)try{output.write(JSON.stringify(value)+'\n');}catch{stop();}};
  const stop=()=>{closed=true;for(const controller of active.values())controller.abort();input.destroy();};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);output.once('error',stop);
  async function dispatch(message) {
    if(message?.method==='notifications/cancelled'){active.get(message.params?.requestId)?.abort();return;}
    if(message?.id===undefined)return;
    const id=message.id;
    if(message.jsonrpc!=='2.0'||!['string','number'].includes(typeof id))return;
    if(active.has(id)){send({jsonrpc:'2.0',id,error:{code:-32600,message:'Duplicate active request'}});return;}
    const controller=new AbortController();active.set(id,controller);
    try {
      let result;
      if(message.method==='initialize')result={protocolVersion:['2024-11-05','2025-03-26','2025-06-18'].includes(message.params?.protocolVersion)?message.params.protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'nibfin',version:'1.0.0'}};
      else if(message.method==='ping')result={};
      else if(message.method==='tools/list')result={tools:readonlyTools};
      else if(message.method==='tools/call')result=await invoke(message.params?.name,message.params?.arguments,controller.signal);
      else {send({jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}});return;}
      send({jsonrpc:'2.0',id,result});
    } catch {send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:'Read-only utility failed or rejected the request; inspect retained command evidence.'}],isError:true}});}
    finally{active.delete(id);}
  }
  input.setEncoding('utf8');
  try {
    for await(const chunk of input) {
      buffer+=chunk.toString('utf8');
      if(Buffer.byteLength(buffer)>1048576){stop();break;}
      let newline;
      while((newline=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
        let value;try{value=JSON.parse(line);}catch{send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON'}});continue;}
        const work=dispatch(value);pending.add(work);work.finally(()=>pending.delete(work));
      }
    }
  } finally {stop();await Promise.allSettled([...pending]);process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);output.removeListener('error',stop);}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)
  serveReadonlyTools().catch(()=>{console.error('readonly-tools: unavailable');process.exitCode=1;});
