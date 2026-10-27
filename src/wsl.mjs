import {spawn} from 'node:child_process';
import {posix} from 'node:path';
import {createAgentEnvironments} from './lifecycle.mjs';
import {canonicalJSON} from './grants.mjs';

const fail = code => { throw new TypeError(`wsl:${code}`); };
const same = (a,b) => canonicalJSON(a) === canonicalJSON(b);
const copy = v => JSON.parse(canonicalJSON(v));
const limit = 2097152;
const token = v => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(v);
export const wslLaunchEnvironment = Object.freeze({SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows'});
export function windowsLocalPath(value, drive='C') {
  if (typeof value !== 'string' || !/^[a-zA-Z]:\\/.test(value) || value[0].toUpperCase() !== drive.toUpperCase()
      || /[\x00-\x1f\x7f<>:"/|?*;&`$!]/.test(value.slice(2)) || value.endsWith('\\')) fail('windows-path');
  const parts=value.slice(3).split('\\');
  if (!parts.length || parts.some(p=>!p || p==='.' || p==='..' || /[. ]$/.test(p)
      || /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(p))) fail('windows-path');
  return value[0].toUpperCase()+value.slice(1);
}
// Conversion is lexical only. It grants no access and does not validate a mount.
export function windowsToWslPath(value, drive='C') {
  const p=windowsLocalPath(value,drive); return '/mnt/'+p[0].toLowerCase()+'/'+p.slice(3).replaceAll('\\','/');
}
export function wslToWindowsPath(value, drive='C') {
  const prefix='/mnt/'+drive.toLowerCase()+'/';
  if (typeof value !== 'string' || !value.startsWith(prefix)) fail('linux-path');
  const result=windowsLocalPath(drive.toUpperCase()+':\\'+value.slice(prefix.length).replaceAll('/','\\'),drive);
  if (windowsToWslPath(result,drive)!==value) fail('linux-path');
  return result;
}
const guestPath = p => typeof p === 'string' && posix.normalize(p)===p && p.startsWith('/') && p!=='/'
  && !/[\x00-\x20,:\\;&`$!]/.test(p) && !/^\/(mnt|media)(\/|$)/.test(p);

/** Persistent bounded JSON-line transport; loss never starts a replacement guest. */
const launchWsl = command => spawn(command.file,command.args,{cwd:command.cwd,env:command.env,
  shell:false,windowsHide:true,stdio:['pipe','pipe','ignore']});
export function wslSession(command, launch=launchWsl) {
  let child, dead=false, buffer=Buffer.alloc(0), sequence=0;
  const pending=new Map();
  function broken() {
    if (dead) return;
    dead=true; child?.kill();
    for (const p of pending.values()) {clearTimeout(p.timer);p.reject(Error('wsl:transport-unresolved'));}
    pending.clear();
  }
  try {
    child=launch(command);
    child.on('error',broken);child.on('close',broken);child.stdin.on('error',broken);
    child.stdout.on('data',data=>{
      buffer=Buffer.concat([buffer,data]);
      if (buffer.length>limit) return broken();
      let end;
      while((end=buffer.indexOf(10))!==-1) {
        const line=buffer.subarray(0,end);buffer=buffer.subarray(end+1);
        try {
          const value=JSON.parse(line.toString('utf8')), p=pending.get(value.id);
          if (!p || !same(Object.keys(value).sort(),['id','ok','value']) || typeof value.ok!=='boolean') return broken();
          clearTimeout(p.timer);pending.delete(value.id);
          if (value.ok) p.resolve(value.value);else p.reject(Error('wsl:guest-failure'));
        } catch {broken();}
      }
    });
  } catch {broken();}
  return Object.freeze({
    request(op,value,timeout=30000) {
      return new Promise((resolve,reject)=>{
        if (dead) return reject(Error('wsl:transport-unresolved'));
        const id=++sequence, frame=JSON.stringify({id,op,value})+'\n';
        if (Buffer.byteLength(frame)>limit) return reject(Error('wsl:input-bound'));
        const timer=setTimeout(broken,timeout);
        pending.set(id,{resolve,reject,timer});
        child.stdin.write(frame);
      });
    },
    close() {broken();}
  });
}

/** Trusted Core supplies OS observations, never a readiness or permission override. */
export function createWindowsWslBackend(config) {
  const {profile,linux,observeHost,process:launch=launchWsl}=config;
  if (Object.keys(config).some(k=>!['profile','linux','observeHost','process'].includes(k))
      || typeof observeHost!=='function' || typeof launch!=='function') fail('configuration');
  const p=copy(profile), {task:taskProvider,...rawLinux}=linux;
  const l={...copy(rawLinux),task:taskProvider};
  if (!same(Object.keys(p).sort(),['arch','bridge','bridgeHash','context','cwd','distribution','files','node','nodeHash','nodeVersion','sid','user','uid','wsl','wslHash'].sort())
      || p.arch!=='x64' || !['service','interactive'].includes(p.context) || !/^S-1-5-(?:[0-9]+-)*[0-9]+$/.test(p.sid)
      || !token(p.distribution) || !token(p.user) || p.user==='root' || !Number.isInteger(p.uid) || p.uid<1
      || !guestPath(p.node) || !guestPath(p.bridge) || !/^v22\.[0-9]+\.[0-9]+$/.test(p.nodeVersion)
      || ![p.nodeHash,p.bridgeHash,p.wslHash].every(h=>/^[a-f0-9]{64}$/.test(h))) fail('profile');
  p.cwd=windowsLocalPath(p.cwd); p.wsl=windowsLocalPath(p.wsl);
  if (p.wsl!=='C:\\Windows\\System32\\wsl.exe' || !Array.isArray(p.files) || p.files.length!==2
      || !same(p.files.map(f=>f.path),[p.cwd,p.wsl]) || p.files.some(f=>!token(f.identity))) fail('host-files');
  if (Object.keys(l).some(k=>!['root','image','socket','environment','instanceId','timeout','task','egress','recovery','deadlineAt','reserveMs'].includes(k))
      || typeof l.task!=='function' || !guestPath(l.root) || l.socket!==`/run/user/${p.uid}/docker.sock`
      || [p.node,p.bridge].some(path=>path===l.root || path.startsWith(l.root+'/'))) fail('linux-configuration');
  const environment=createAgentEnvironments().describe(l.environment), instance=environment.instances.find(i=>i.id===l.instanceId);
  if (!instance || !['codex','claude','gemini'].includes(environment.agent)) fail('environment');
  const resources=[environment.loginSpace,...environment.instances.flatMap(i=>[i.workspace,i.registration,i.service])];
  if (resources.some(r=>!guestPath(r) || !r.startsWith(l.root+'/'))) fail('guest-resources');
  const owned=[instance.workspace,instance.registration,instance.service];
  const verificationRefs=new Map();let verificationBusy=false;
  let client=null, initialized=false, uncertain=false, retired=false, diagnostic='not-checked', hostPins=null;
  const executions=new Map();
  const unavailable=()=>({login:'unavailable',tool:'unavailable',isolation:'unsupported',read:'unsupported',write:'unsupported',
    evidence:['diagnostic:'+diagnostic],limitations:['Windows-hosted WSL/model execution Unverified; local contracts only']});
  async function host() {
    let timer;
    const o=await Promise.race([Promise.resolve().then(observeHost),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(Error('wsl:host-timeout')),15000);
    })]).finally(()=>clearTimeout(timer)).catch(()=>fail('host-context'));
    if (!o || o.platform!=='win32' || o.arch!==p.arch || o.sid!==p.sid || o.context!==p.context
        || o.distribution!==p.distribution || o.wslVersion!==2 || o.available!==true
        || !Array.isArray(o.files) || o.files.length!==2) fail('host-context');
    for(let n=0;n<2;n++) {
      const f=o.files[n], expected=p.files[n];
      if (!f || windowsLocalPath(f.path)!==expected.path || windowsLocalPath(f.canonical)!==expected.path
          || f.identity!==expected.identity || f.reparse!==false || f.storage!=='local'
          || f.kind!==(n===0?'directory':'file') || (n===1 && f.hash!==p.wslHash)) fail('host-path-identity');
    }
    const pin=canonicalJSON(o);
    if(hostPins!==null && hostPins!==pin) fail('host-changed');hostPins=pin;
  }
  async function rpc(op,value) {
    if (!client || uncertain) fail('transport-unresolved');
    try {
      const result=await client.request(op,copy(value),op==='readiness'?60000:['verificationCommand','prepareNode','nodeCommand'].includes(op)?Math.max(1,(l.deadlineAt??Date.now()+30000)-Date.now()):30000);
      if (Buffer.byteLength(JSON.stringify(result))>limit) throw Error();
      return result;
    } catch {uncertain=true;diagnostic='transport-unresolved';throw Error('wsl:transport-unresolved');}
  }
  async function retained(op,value,retain,signal) {
    if(verificationBusy)return {status:'busy'};
    if(typeof retain!=='function'||!executions.has(value.execution)||uncertain)fail('verification-unresolved');
    if(signal?.aborted)return {status:'cancelled'};
    verificationBusy=true;
    const abort=()=>{rpc('stop',executions.get(value.execution)).catch(()=>{});};
    signal?.addEventListener('abort',abort,{once:true});
    try {
      const envelope=await rpc(op,value);
      if(!envelope||!Array.isArray(envelope.payloads))fail('verification-response');
      for(const payload of envelope.payloads) {
        if(typeof payload.reference!=='string'||payload.record?.execution!==value.execution||typeof payload.log!=='string')fail('verification-response');
        const ref=await retain({record:payload.record,log:payload.log});if(typeof ref!=='string'||!ref)fail('retention');
        verificationRefs.set(payload.reference,ref);
      }
      const project=v=>{
        if(v&&typeof v==='object')for(const [k,item]of Object.entries(v)) {
          if(k==='logReference') {if(!verificationRefs.has(item))fail('retention');v[k]=verificationRefs.get(item);}
          else project(item);
        }return v;
      };
      if(signal?.aborted)return {status:'cancelled'};
      return project(envelope.result);
    }catch{uncertain=true;fail('verification-unresolved');}
    finally{verificationBusy=false;signal?.removeEventListener('abort',abort);}
  }
  function query(v) {
    const old=executions.get(v.execution);
    if (!old || !same(v,old)) fail('query');
  }
  return Object.freeze({
    diagnostic:()=>diagnostic,
    async readiness() {
      if (retired || uncertain) {diagnostic='transport-unresolved';return unavailable();}
      try {
        diagnostic='host-context';await host();
        if (!client) {
          try {client=wslSession(Object.freeze({file:p.wsl,args:Object.freeze(['--distribution',p.distribution,'--user',p.user,
          '--exec','/usr/bin/env','-i','PATH=/usr/bin:/bin','LANG=C',p.node,p.bridge]),cwd:p.cwd,env:wslLaunchEnvironment}),launch);}
          catch {uncertain=true;diagnostic='launch-unresolved';throw Error();}
        }
        if (!initialized) {
          diagnostic='guest-context';
          const {task:ignored,...guestConfig}=l;
          const result=await rpc('initialize',{profile:p,linux:guestConfig});
          if (!same(result,{status:'initialized'})) fail('guest-context'); initialized=true;
        }
        diagnostic='guest-backend'; const result=await rpc('readiness',{});
        // Only known readiness categories cross into Core; arbitrary guest text never does.
        if (!result || !['available','unavailable'].includes(result.login) || !['available','unavailable'].includes(result.tool)
            || !['isolation','read','write'].every(k=>['verified','unsupported','unverified'].includes(result[k]))) fail('guest-response');
        diagnostic=result.login==='available' && result.tool==='available'?'ready':'guest-backend';
        return {...unavailable(),...Object.fromEntries(['login','tool','isolation','read','write'].map(k=>[k,result[k]]))};
      } catch {return unavailable();}
    },
    async start(v) {
      if (!initialized || uncertain || retired || executions.has(v.execution)) return {status:'rejected'};
      diagnostic='host-context';await host();
      let task;
      try {task=l.task(copy(v.executionIdentity));} catch {fail('task');}
      executions.set(v.execution,copy({environment:v.environment,agent:v.agent,instance:v.instance,execution:v.execution,request:v.request}));
      return rpc('start',{input:v,task});
    },
    async verificationCommand(execution,command,retain,{reuse=false,signal}={}) {
      return retained('verificationCommand',{execution,command,reuse},retain,signal);
    },
    async prepareNode(execution,options,retain,{signal}={}) {
      const p=await retained('prepareNode',{execution,project:options.project??'.'},retain,signal);
      if(p.status!=='prepared')return Object.freeze(p);
      return Object.freeze({...p,command:(command,{reuse=false,signal}={})=>
        retained('nodeCommand',{execution,id:p.id,command,reuse},retain,signal)});
    },
    verificationRoot:()=>instance.service+'/verification',
    async verificationProcess(execution,command) {
      if(!executions.has(execution)||uncertain)fail('verification-unresolved');
      await host();return rpc('verificationProcess',{execution,command});
    },
    async collect(v) {query(v);return rpc('collect',v);},
    async stop(v) {query(v);return rpc('stop',v);},
    async termination(v) {query(v);if(uncertain)return {status:'unknown'};return rpc('termination',v);},
    async cleanup(v) {
      if (!same(v,{environment:environment.id,agent:environment.agent,instance:instance.id,resources:owned})) fail('cleanup');
      if (retired) return {status:'completed',residuals:[]};
      if (uncertain) return {status:'unresolved',residuals:owned};
      try {
        await host();const result=await rpc('cleanup',v);
        if (same(result,{status:'completed',residuals:[]})) {retired=true;try {client.close();} catch { /* Guest removal is already verified. */ }}
        return result;
      } catch {return {status:'unresolved',residuals:owned};}
    }
  });
}
