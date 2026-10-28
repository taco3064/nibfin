// Adapted from Kairo d1b47d5e073cf15bdcdc1fbbec098401649878d9; no legacy daemon mode.
import {command} from './process.mjs';

export function dockerSecurity(config) {
  const policy=config.dockerSecurity;
  if(policy===undefined)throw Error('Explicit rootless Docker policy required');
  if(!policy||policy.mode!=='rootless'||Object.keys(policy).some(k=>!['mode','socket'].includes(k))||
      !/^\/run\/user\/[1-9]\d*\/docker\.sock$/.test(policy.socket||'')||config.user!=='0:0')
    throw Error('Rootless Docker requires its explicit local user socket and mapped container user 0:0');
  return policy;
}
export function assertContainerUser(config) {
  if(dockerSecurity(config))return;
  if(!/^\d+:\d+$/.test(config.user||'')||/^0+$/.test(config.user.split(':')[0]))throw Error('Root Agent containers are forbidden on the legacy daemon');
}
export function dockerCommand(config,run=command) {
  return (executable,args,options={})=>{
    const policy=dockerSecurity(config);
    if(executable!=='docker'||!policy)return run(executable,args,options);
    const env={...(options.env||process.env)};
    for(const key of ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH','DOCKER_API_VERSION'])delete env[key];
    return run(executable,['--host','unix://'+policy.socket,...args],{...options,env});
  };
}
export async function verifyDockerSecurity(config,run) {
  if(!dockerSecurity(config))return;
  const info=JSON.parse((await run('docker',['info','--format','{{json .}}'])).stdout);
  assertDockerInfo(info);
}

/** Fixed explicit socket transport. Ambient Docker settings never participate. */
export function dockerArguments(socket,args) {
  dockerSecurity({dockerSecurity:{mode:'rootless',socket},user:'0:0'});
  return ['--host','unix://'+socket,...args];
}
export function assertDockerInfo(info) {
  if(!info?.SecurityOptions?.includes('name=rootless')||!info.SecurityOptions.includes('name=seccomp,profile=builtin')||
    info.CgroupVersion!=='2'||info.CgroupDriver!=='systemd'||
    !['MemoryLimit','PidsLimit','CpuCfsPeriod','CpuCfsQuota'].every(k=>info[k]===true))
    throw Error('docker-security: rootless seccomp and effective systemd cgroup v2 limits required');
}
/** Compare actual daemon observation to the fixed builder, including the COMPLETE
 * mount/environment set. An image default cannot silently add a host capability. */
export function assertContainerConfiguration(container,args) {
  const values=key=>args.flatMap((v,i)=>v===key?[args[i+1]]:v.startsWith(key+'=')?[v.slice(key.length+1)]:[]);
  const one=key=>values(key)[0];
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const h=container.HostConfig,c=container.Config;
  if(!h||!c||h.Privileged!==false||h.ReadonlyRootfs!==true||!same(h.CapDrop,['ALL'])||
    (h.CapAdd?.length??0)!==0||!h.SecurityOpt?.includes('no-new-privileges')||h.SecurityOpt.some(v=>v!=='no-new-privileges')||
    h.Memory!==Number(one('--memory')?.replace('g',''))*1073741824&&h.Memory!==Number(one('--memory')?.replace('m',''))*1048576||
    h.PidsLimit!==Number(one('--pids-limit'))||h.NanoCpus!==Number(one('--cpus'))*1e9||
    h.NetworkMode!==one('--network')||c.User!=='0:0'||
    !same(c.Entrypoint,[one('--entrypoint')])||
    !same([...(c.Env??[])].sort(),values('--env').sort())||
    (h.Devices?.length??0)!==0||Object.keys(h.PortBindings??{}).length||h.PidMode==='host'||h.IpcMode==='host')
    throw Error('docker-security: container configuration mismatch');
  const expected=values('--mount').map(value=>{
    const parts=Object.fromEntries(value.split(',').map(v=>{const i=v.indexOf('=');return i<0?[v,true]:[v.slice(0,i),v.slice(i+1)];}));
    if(parts.type!=='bind'||typeof parts.src!=='string'||typeof parts.dst!=='string'||parts['bind-recursive']!=='disabled')throw Error('docker-security: mount');
    return {Source:parts.src,Destination:parts.dst,RW:!parts.readonly,Type:'bind'};
  });
  const observed=(container.Mounts??[]).filter(m=>m.Type!=='tmpfs').map(({Source,Destination,RW,Type})=>({Source,Destination,RW,Type}));
  const sorted=xs=>xs.sort((a,b)=>a.Destination.localeCompare(b.Destination));
  if(!same(sorted(expected),sorted(observed)))throw Error('docker-security: mount mismatch');
}
