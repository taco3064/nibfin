import {sessionId,sessionIdFromEvents,createRoleSession} from './role-session.mjs';
export {sessionId} from './role-session.mjs';
import {existsSync,writeFileSync} from 'node:fs';
import {containsCredentials} from './credential-output.mjs';
// Shared trusted CLI-session owner. Standalone: mounted beside each fixed entrypoint.
// Provider errors are inspected structurally, never matched against model prose.
import {connect as netConnect} from 'node:net';
import {connect as tlsConnect} from 'node:tls';
import {spawnSync} from 'node:child_process';
const fail=code=>{throw Error(`agent-session:${code}`);};
export const dependencyProbeEndpoints=Object.freeze(['registry.npmjs.org','cdn.playwright.dev','playwright.download.prss.microsoft.com']);
export function recoveryPolicy(value,adapter,version) {
  if(value===undefined)return Object.freeze({attempts:1,delayMs:0,model:null,fallbacks:[],models:[]});
  if(!value||Object.keys(value).sort().join(' ')!=='attempts delayMs fallbacks model models'
      ||!Number.isSafeInteger(value.attempts)||value.attempts<1||value.attempts>4
      ||!Number.isSafeInteger(value.delayMs)||value.delayMs<0||value.delayMs>60000
      ||!Array.isArray(value.models)||!Array.isArray(value.fallbacks)||value.models.length>16
      ||value.models.some(m=>!m||Object.keys(m).sort().join(' ')!=='adapter id provider resume version'
        ||m.adapter!==adapter||m.version!==version||m.resume!==true||typeof m.id!=='string'
        ||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(m.id)||m.provider!==adapter)
      ||new Set(value.models.map(m=>m.id)).size!==value.models.length
      ||!value.models.some(m=>m.id===value.model)
      ||value.fallbacks.some(id=>!value.models.some(m=>m.id===id))
      ||new Set(value.fallbacks).size!==value.fallbacks.length)fail('policy');
  return Object.freeze(JSON.parse(JSON.stringify(value)));
}
export function capacityError(adapter,envelope) {
  const error=envelope?.error;
  // These are adapter/provider error fields, never free text. An error that may
  // represent an unknown write/tool interruption is deliberately not replayable.
  if(!error||typeof error!=='object'||Array.isArray(error)||envelope?.unknown_external_write===true)return false;
  if(adapter==='claude')return error.type==='overloaded_error'&&error.status===529;
  if(adapter==='gemini')return error.status==='RESOURCE_EXHAUSTED'&&error.code===429;
  if(adapter==='codex') {
    // exec 0.163.0's ThreadErrorEvent has only message. Accept a complete,
    // structurally decoded provider HTTP 503 body, never model-message text.
    const match=typeof error.message==='string' && /^unexpected status 503(?: Service Unavailable)?: (\{.*\})$/s.exec(error.message);
    if(!match)return false;
    try {const body=JSON.parse(match[1]);return ['model_capacity_exceeded','server_overloaded'].includes(body.error?.code);}
    catch{return false;}
  }
  return false;
}
/** All attempts run in this entrypoint/container. A fresh container implies a fresh
 * session; retries resume only the EXACT observed session and retain the workspace.
 * No fallback exists without an explicitly listed versioned capability and policy.
 */
export function executeSession({request,adapter,version,invoke,decode,inspect,run=spawnSync,now=Date.now,
  wait=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms),persisted}={}) {
  const policy=recoveryPolicy(request.recovery,adapter,version);
  const deadline=Math.min(request.deadlineAt??now()+request.timeout,now()+request.timeout);
  if(!Number.isSafeInteger(deadline)||!Number.isSafeInteger(request.timeout)||request.timeout<=0)fail('deadline');
  const continuity=createRoleSession(request,adapter,version,{persisted});
  let session=continuity.id,model=policy.model,attempt=0;
  const fallbacks=[...policy.fallbacks];
  while(attempt++<policy.attempts) {
    if(request.signal?.aborted)return {diagnostic:'cancelled'};
    const left=deadline-now();if(left<=0)return {diagnostic:'budget-exhausted'};
    try{continuity.start();}catch{return {diagnostic:'invalid-result'};}
    const command=invoke({...request,timeout:left,session,model,attempt});
    let response;try{response=run(command.file,command.args,command.options);}catch{return {diagnostic:'provider-failure'};}
    let observation;try{observation=inspect(response);}catch{return {diagnostic:response.error||response.status!==0?'provider-failure':'invalid-result'};}
    if(observation.authentication===true)return {diagnostic:'login-rejected'};
    // A successful terminal result or replayable capacity response must establish
    // a valid session. Once established, every later observation must name it.
    if(observation.success===true||observation.capacity===true||session!==null||observation.session!==undefined) {
      if(!sessionId(observation.session)||session!==null&&session!==observation.session)return {diagnostic:'invalid-result'};
      try{continuity.observe(observation.session);}catch{return {diagnostic:'invalid-result'};}
      session=continuity.id;
    }
    if(!response.error&&response.status===0&&observation.success===true) {
      try{return {evidence:decode(response.stdout,request.context),session:{id:session,adapter,version}};}catch{return {diagnostic:'invalid-result'};}
    }
    if(observation.capacity!==true||observation.unknownExternalWrite===true||!session||response.error)return {diagnostic:'provider-failure'};
    if(attempt===policy.attempts)return {diagnostic:'capacity-exhausted'};
    continuity.end(true);
    if(fallbacks.length)model=fallbacks.shift();
    if(deadline-now()<=policy.delayMs)return {diagnostic:'budget-exhausted'};
    wait(policy.delayMs);
  }
  return {diagnostic:'capacity-exhausted'};
}
/** Strict bounded JSONL decoding; duplicate terminal events or post-terminal events
 * fail. All lines are parsed, including discarded tool metadata.
 */
export function codexEvents(output,secrets=[]) {
  if(typeof output!=='string'||Buffer.byteLength(output)>1048576||!output.endsWith('\n'))fail('output');
  const identified=sessionIdFromEvents(output);
  let session=null,started=false,terminal=null,result=null,reportedError=null;const pendingTools=new Set();
  for(const line of output.trimEnd().split('\n')) {
    const value=JSON.parse(line);rejectSecrets(value,secrets);
    if(terminal)fail('post-terminal');
    if(['item.started','item.updated'].includes(value.type)&&['command_execution','mcp_tool_call','collab_tool_call'].includes(value.item?.type))pendingTools.add(value.item.id);
    if(value.type==='item.completed')pendingTools.delete(value.item?.id);
    if(value.type==='thread.started') {
      if(session!==null||!sessionId(value.thread_id))fail('session');session=value.thread_id;
    }else if(value.type==='turn.started'){if(started)fail('turn');started=true;}
    else if(value.type==='turn.completed'||value.type==='turn.failed') {
      if(!started)fail('turn');terminal=value;
    }else if(value.type==='error') {
      // CLI may emit error then turn.failed. Preserve only structured recognized fields.
      if(typeof value.message!=='string'||reportedError!==null)fail('error');reportedError=value.message;
    }else if(value.type==='item.completed'&&value.item?.type==='agent_message') {
      try {
        const parsed=JSON.parse(value.item.text);
        if(parsed&&typeof parsed==='object'&&Object.hasOwn(parsed,'outcome')) {
          if(result!==null)fail('duplicate-result');result=parsed;
        }
      }catch(e){if(e.message==='agent-session:duplicate-result')throw e;}
    }
  }
  if(session!==identified||!terminal||reportedError!==null && (terminal.type!=='turn.failed'||terminal.error?.message!==reportedError))fail('terminal');
  return {session,terminal,result,unknownExternalWrite:pendingTools.size>0,success:terminal.type==='turn.completed'&&result!==null};
}
export function rejectSecrets(value,secrets) {
  const pending=[value];let count=0;
  while(pending.length) {
    if(++count>50000)fail('output');const v=pending.pop();
    if(typeof v==='string') {
      if(containsCredentials(v,secrets))fail('credential-output');
      // Decode nested JSON strings too, including discarded metadata and JSON-escaped sentinels.
      if(v.length<1048576 && /^[\s]*[\[{\"]/.test(v))try{const decoded=JSON.parse(v);if(decoded!==v)pending.push(decoded);}catch(e){if(e.message==='agent-session:credential-output')throw e;}
    }else if(v&&typeof v==='object')for(const[k,item]of Object.entries(v))pending.push(k,item);
  }
}

/** Runs inside the selected internal network. Observe DNS/proxy/TLS at the actual
 * boundary without model credentials or a paid-model request. Hosts are fixed by
 * trusted adapter/profile code. No response bodies or sensitive URLs leave here.
 */
export async function probeGateway(hosts,timeoutMs=10000,{connect=netConnect}={}) {
  const results=[];
  for(const hostname of hosts) {
    const result=await new Promise(resolve=>{
      let socket=null,tls=null,buffer=Buffer.alloc(0),finished=false;
      const finish=kind=>{if(finished)return;finished=true;clearTimeout(timer);
        // Once wrapped, TLS owns the underlying socket. Destroying the raw
        // transport first can invalidate its native TLS handle during a callback.
        if(tls)tls.destroy();else socket?.destroy();resolve({hostname,kind});};
      const timer=setTimeout(()=>finish('timeout'),timeoutMs);
      try {
        socket=connect({host:'nibfin-egress',port:8080});
        socket.on('error',e=>finish(['ENOTFOUND','EAI_AGAIN'].includes(e.code)?'dns':'proxy'));
        socket.once('connect',()=>socket.write(`CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\n\r\n`));
        const response=data=>{
          buffer=Buffer.concat([buffer,data]);if(buffer.length>4096)return finish('proxy');
          const end=buffer.indexOf('\r\n\r\n');if(end===-1)return;
          socket.removeListener('data',response);
          const headers=buffer.toString('ascii',0,end);
          if(!headers.startsWith('HTTP/1.1 200 ')) {
            const category=/\r\nNibfin-Egress-Error: (dns|timeout|proxy|policy-denial)(?:\r\n|$)/.exec(headers)?.[1];
            const status={dns:'502',timeout:'504',proxy:'503','policy-denial':'403'}[category];
            return finish(status&&headers.startsWith(`HTTP/1.1 ${status} `)?category:'proxy');
          }
          if(buffer.length!==end+4)return finish('proxy');
          tls=tlsConnect({socket,servername:hostname,rejectUnauthorized:true,minVersion:'TLSv1.2'});
          tls.once('secureConnect',()=>finish('verified'));tls.on('error',()=>finish('tls'));
        };
        socket.on('data',response);socket.on('end',()=>finish(tls?'tls':'proxy'));
      }catch{finish('proxy');}
    });
    results.push(result);
  }
  return results;
}

/** Adapted upstream read-only bootstrap: dependency work happens in a writable
 * copy before the model begins; failure remains a diagnostic, never a test pass. */
export function prepareReadonlyVerification(request,run=spawnSync,{exists=existsSync,write=writeFileSync}={}) {
  if(request.access!=='read'||!exists('/work/package.json'))return request;
  const log='/verification/node-preparation.log';
  const response=run('/usr/local/bin/node',['/verification-runner.mjs','--','node','/verification-prepare.mjs','/work','/tmp'],
    {cwd:'/work',env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp/home'},encoding:'utf8',
      timeout:Math.max(1,(request.verificationPolicy?.budget?.stopVerificationAt??Date.now())-Date.now()+3000),killSignal:'SIGTERM',maxBuffer:16777216});
  write(log,String(response.stdout??'')+String(response.stderr??''),{mode:0o600});
  return {...request,prompt:request.prompt+'\nRead-only Node bootstrap attempted dependency preparation before this model started. Inspect /verification/node-preparation.log and its command receipt; reuse its prepared directory only while source is unchanged. Failure is not a test result and must be diagnosed.'};
}
