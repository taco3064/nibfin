import {command} from './process.mjs';

export function dockerSecurity(config) {
  const policy=config.dockerSecurity;
  if(policy===undefined)return null; // Historical signed runtimes retain their original boundary.
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
  if(!info.SecurityOptions?.includes('name=rootless')||!info.SecurityOptions.includes('name=seccomp,profile=builtin')||
      info.CgroupVersion!=='2'||info.CgroupDriver!=='systemd'||
      !['MemoryLimit','PidsLimit','CpuCfsPeriod','CpuCfsQuota'].every(k=>info[k]===true))
    throw Error('Rootless Docker, seccomp and enforced systemd cgroup v2 memory/PID/CPU limits are required; no rootful fallback');
}
