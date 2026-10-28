import {mkdir,readFile,writeFile,rename,lstat,realpath,open,unlink,rm} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonicalJSON} from './grants.mjs';
import {openRegistrationResponse} from './registration.mjs';
import {verifyRepositoryIdentity,validateMemberBinding} from './collaboration.mjs';

const need=ok=>{if(!ok)throw Error('runner-lifecycle:contract');};
const id=v=>typeof v==='string'&&/^[1-9][0-9]*$/.test(v);
const word=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v);
const exact=(v,keys)=>need(v&&Object.getPrototypeOf(v)===Object.prototype
  &&Object.keys(v).sort().join(' ')===keys.split(' ').sort().join(' '));
const same=(a,b)=>canonicalJSON(a)===canonicalJSON(b);
const safe=(outcome,reason)=>({outcome,...(reason?{reason}:{})});
/** Count means the total in ONE new environment, never a per-target multiplier. */
export function localRunnerCount(value=2) {
  need(Number.isSafeInteger(value)&&value>0);return value;
}
async function directory(path) {
  need(resolve(path)===path&&path!=='/');
  for(let part=path;part!=='/';part=dirname(part))need(!(await lstat(part)).isSymbolicLink());
  const s=await lstat(path);
  need(s.isDirectory()&&s.uid===process.getuid()&&(s.mode&0o077)===0&&await realpath(path)===path);
}
/** Core contract consumed by onboarding; not a CLI or a delivery-state engine.
 * All executable capabilities and the root are trusted local configuration.
 * No event, Issue text, shell command or caller-selected module is accepted.
 * The OS account owns the root. This is filesystem hygiene, not an isolation
 * certification against a malicious host administrator. */
export function createLocalRunnerLifecycle(configuration) {
  exact(configuration,'version root member checkLocal'+(Object.hasOwn(configuration,'registration')?' registration':''));
  const {version,root,checkLocal}=configuration,member=structuredClone(configuration.member);
  exact(member,'id login');
  need(version===1&&id(member.id)&&/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(member.login)
    &&typeof root==='string'&&resolve(root)===root&&root!=='/'&&typeof checkLocal==='function');
  const registration={...configuration.registration};
  need(configuration.registration===undefined
    ||['authorize','acquire','configure','observe'].every(k=>typeof registration[k]==='function'));
  const location=name=>{need(word(name));return join(root,name);};
  const resources=(path,instance)=>({instanceId:instance.id,login:join(path,'login'),
    work:join(path,'instances',instance.id,'work'),registration:join(path,'instances',instance.id,'registration'),
    service:join(path,'instances',instance.id,'service')});
  const summary=m=>({version:1,name:m.name,agent:m.agent,memberId:m.member.id,
    instances:m.instances.map(i=>({instanceId:i.id,state:i.state,...(i.binding?{binding:structuredClone(i.binding)}:{})}))});
  async function load(name) {
    await directory(root);const path=location(name);await directory(path);
    const file=join(path,'environment.json');need(!(await lstat(file)).isSymbolicLink());
    const m=JSON.parse(await readFile(file,'utf8'));
    exact(m,'version name agent member instances');
    need(m.version===1&&m.name===name&&same(m.member,member)&&['codex','claude','gemini'].includes(m.agent)
      &&Array.isArray(m.instances)&&m.instances.length>0&&new Set(m.instances.map(i=>i.id)).size===m.instances.length);
    await directory(join(path,'login'));
    for(const i of m.instances) {
      need(word(i.id)&&['unregistered','pending','registered','revoked'].includes(i.state));
      exact(i,'id state'+(i.state==='pending'?' intent':i.state==='registered'?' binding':''));
      if(i.state==='pending'){exact(i.intent,'target method');target(i.intent.target);need(['auto','manual'].includes(i.intent.method));}
      if(i.state==='registered') {
        const b=i.binding;exact(b,'version active instanceId runnerId platform memberId repositoryId registration');
        need(b.version===1&&b.active===true&&b.instanceId===i.id&&b.memberId===member.id&&id(b.repositoryId));
        const r=b.registration;
        need(['repository','organization'].includes(r?.level)&&id(r.id));
        exact(r,r.level==='repository'?'level id':'level id organization');
        need(r.level==='repository'?r.id===b.repositoryId:typeof r.organization==='string'&&/^[a-z0-9-]+$/.test(r.organization));
        validateMemberBinding(b,{repositoryId:b.repositoryId,registration:r});
      }
      const r=resources(path,i);
      for(const key of ['work','registration','service'])await directory(r[key]);
    }
    return {path,m};
  }
  async function save(path,m) {
    const tmp=join(path,randomUUID()+'.tmp');
    await writeFile(tmp,canonicalJSON(m)+'\n',{flag:'wx',mode:0o600});
    await rename(tmp,join(path,'environment.json'));
  }
  async function local(path,m,stage) {
    const observation=await checkLocal({stage,member:structuredClone(member),agent:m.agent,
      login:join(path,'login'),instances:m.instances.map(i=>resources(path,i))});
    need(observation?.status==='ready'&&observation.memberId===member.id&&observation.agent===m.agent);
  }
  async function locked(name,work) {
    // Adapted donor registryLock/service-check: never remove another attempt's
    // lock, even if its PID is dead. Unknown official effects stay pending.
    await directory(root);const path=location(name);await directory(path);
    let handle;
    try {handle=await open(join(path,'mutation.lock'),'wx',0o600);}
    catch {return safe('blocked','local_reconciliation_required');}
    try {return await work();}
    finally {await handle.close();await unlink(join(path,'mutation.lock'));}
  }
  function target(input) {
    exact(input,'version repository repositoryId ownerId ownerType level registrationId');
    need(input.version===1&&id(input.repositoryId)&&id(input.ownerId)&&id(input.registrationId)
      &&typeof input.repository==='string'&&/^[a-z0-9-]+\/[a-z0-9_.-]+$/.test(input.repository)
      &&!input.repository.split('/').includes('..')&&['User','Organization'].includes(input.ownerType)
      &&['repository','organization'].includes(input.level));
    need(input.level==='repository'?input.registrationId===input.repositoryId:
      input.ownerType==='Organization'&&input.registrationId===input.ownerId);
    return structuredClone(input);
  }
  const scope=t=>({level:t.level,id:t.registrationId,...(t.level==='organization'?{organization:t.repository.split('/')[0]}:{})});
  async function authority(t,method,signal) {
    const a=await registration.authorize({target:structuredClone(t),member:structuredClone(member),method,signal});
    need(a?.ok===true&&a.memberId===member.id&&a.registrationId===t.registrationId&&a.level===t.level
      &&['write','maintain','admin'].includes(a.memberPermission)
      &&a.management===(t.level==='repository'?'administration:write':'organization_self_hosted_runners:write')
      &&(method!=='auto'||a.policyEnabled===true));
    verifyRepositoryIdentity(a.repository,{version:1,repository:t.repository,repositoryId:t.repositoryId,
      ownerId:t.ownerId,ownerType:t.ownerType});
  }
  function binding(observation,t,i) {
    need(observation?.confirmed===true&&observation.memberId===member.id&&id(observation.runnerId)
      &&['linux','windows','macos'].includes(observation.platform)
      &&same(observation.registration,scope(t))&&observation.repositoryId===t.repositoryId
      &&same(observation.labels.filter(l=>l.startsWith('nibfin-user-')),['nibfin-user-'+member.id]));
    return validateMemberBinding({version:1,active:true,instanceId:i.id,runnerId:observation.runnerId,
      platform:observation.platform,memberId:member.id,repositoryId:t.repositoryId,registration:scope(t)},
      {repositoryId:t.repositoryId,registration:scope(t)});
  }
  return Object.freeze({
    async create(input) {
      let path,created=false;
      try {
        need(input&&Object.keys(input).every(k=>['name','agent','count'].includes(k)));
        const {name,agent}=input,count=localRunnerCount(input.count);
        need(word(name)&&['codex','claude','gemini'].includes(agent));
        await directory(root);path=location(name);
        await mkdir(path,{mode:0o700});created=true;
        await mkdir(join(path,'login'),{mode:0o700});
        await mkdir(join(path,'instances'),{mode:0o700});
        const m={version:1,name,agent,member,instances:[]};
        for(let n=0;n<count;n++) {
          const i={id:randomUUID(),state:'unregistered'};m.instances.push(i);
          const base=join(path,'instances',i.id);await mkdir(base,{mode:0o700});
          for(const key of ['work','registration','service'])await mkdir(join(base,key),{mode:0o700});
        }
        await local(path,m,'create');await save(path,m);
        return {outcome:'created',environment:summary(m)};
      } catch {
        if(created) {try {await rm(path,{recursive:true});}catch{return safe('blocked','cleanup_incomplete');}}
        return safe('blocked','invalid_or_unavailable');
      }
    },
    async list(name) {
      try {return {outcome:'listed',environment:summary((await load(name)).m)};}
      catch {return safe('blocked','invalid_or_unavailable');}
    },
    async register(input,{signal}={}) {
      try {
        input=structuredClone(input);
        exact(input,'name target method');need(['auto','manual'].includes(input.method)
          &&['authorize','acquire','configure','observe'].every(k=>typeof registration[k]==='function'));
        const t=target(input.target);
        return await locked(input.name,async()=>{
          let pending=false;
          try {
            const {path,m}=await load(input.name);
            if(m.instances.some(i=>i.state==='pending'))return safe('blocked','registration_reconciliation_required');
            const i=m.instances.find(i=>i.state==='unregistered');
            if(!i)return safe('blocked','instances_exhausted');
            await local(path,m,'register');await authority(t,input.method,signal);need(!signal?.aborted);
            // Persist before issuance/configuration; a lost response cannot make
            // the instance look unused and silently issue/configure again.
            i.state='pending';i.intent={target:t,method:input.method};await save(path,m);pending=true;
            const r=resources(path,i);
            const acquired=await registration.acquire({target:structuredClone(t),member:structuredClone(member),
              method:input.method,instanceId:i.id,signal});
            // Auto is the delivered #198 encrypted channel, consumed using its
            // existing verifier; no new credential exchange or trust protocol.
            let token;
            if(input.method==='auto') {
              const e=acquired?.expected;
              need(e?.requesterId===member.id&&e.repository===t.repository&&e.repositoryId===t.repositoryId
                &&e.level===t.level&&e.registrationId===t.registrationId);
              token=openRegistrationResponse(acquired.bytes,{privateKey:acquired.privateKey,expected:e});
            } else token=acquired;
            need(token?.outcome==='available'&&typeof token.token==='string'&&token.token.length>0
              &&token.token.length<=8192&&Date.parse(token.expires_at)>Date.now()
              &&token.url==='https://github.com/'+(t.level==='repository'?t.repository:t.repository.split('/')[0]));
            await authority(t,input.method,signal);need(!signal?.aborted&&Date.parse(token.expires_at)>Date.now());
            await registration.configure({...r,target:structuredClone(t),member:structuredClone(member),
              url:token.url,token:token.token,labels:['nibfin-user-'+member.id],signal});
            const observed=await registration.observe({...r,target:structuredClone(t),member:structuredClone(member),signal});
            i.binding=binding(observed,t,i);
            need(!m.instances.some(other=>other!==i&&other.binding?.runnerId===i.binding.runnerId
              &&same(other.binding.registration,i.binding.registration)));
            i.state='registered';delete i.intent;await save(path,m);
            return {outcome:'registered',environment:summary(m)};
          } catch {return safe(pending?'unknown':'blocked',pending?'registration_reconciliation_required':'invalid_or_unavailable');}
        });
      } catch {return safe('blocked','invalid_or_unavailable');}
    },
    async reconcile(name,{signal}={}) {
      try {return await locked(name,async()=>{
        const {path,m}=await load(name);
        for(const i of m.instances.filter(i=>i.state==='pending')) {
          const t=target(i.intent.target);
          // Read only: never reacquire or run official configuration on recovery.
          const observed=await registration.observe({...resources(path,i),target:t,member:structuredClone(member),signal});
          const b=binding(observed,t,i);
          need(!m.instances.some(other=>other!==i&&other.binding?.runnerId===b.runnerId
            &&same(other.binding.registration,b.registration)));
          i.binding=b;i.state='registered';delete i.intent;
        }
        await save(path,m);return {outcome:'reconciled',environment:summary(m)};
      });}catch{return safe('unknown','registration_reconciliation_required');}
    },
    async standby(name,{signal}={}) {
      try {
        const {path,m}=await load(name);
        try {await lstat(join(path,'mutation.lock'));return safe('blocked','local_reconciliation_required');}
        catch(e){if(e.code!=='ENOENT')throw e;}
        await local(path,m,'standby');
        need(!signal?.aborted&&!m.instances.some(i=>i.state==='pending'));
        const registered=m.instances.filter(i=>i.state==='registered');need(registered.length>0);
        for(const i of registered) {
          const b=i.binding,t={version:1,repositoryId:b.repositoryId,registration:b.registration};
          // Observe must independently confirm the persisted registration; no
          // Issue or Owner Grant is required simply to wait for GitHub work.
          const o=await registration.observe({...resources(path,i),binding:structuredClone(b),member:structuredClone(member),signal});
          need(o?.confirmed===true&&o.runnerId===b.runnerId&&o.memberId===member.id&&o.platform===b.platform
            &&o.repositoryId===t.repositoryId&&same(o.registration,t.registration)
            &&same(o.labels.filter(l=>l.startsWith('nibfin-user-')),['nibfin-user-'+member.id]));
        }
        return safe('ready');
      }catch{return safe('blocked','invalid_or_unavailable');}
    }
  });
}
