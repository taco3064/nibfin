import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validateEndpoints} from './egress-gateway.mjs';
const fail = code => {throw Error(`egress:${code}`);};
export const endpointProfiles=Object.freeze({
  'dependency-download':Object.freeze(['registry.npmjs.org']),
  codex:Object.freeze(['chatgpt.com','auth.openai.com']),
  claude:Object.freeze(['api.anthropic.com']),
  gemini:Object.freeze(['generativelanguage.googleapis.com']),
  management:Object.freeze(['api.github.com','github.com']),
  hooks:Object.freeze([])
});
/** Existing Docker boundary, not an OS sandbox. Only the credential-free gateway
 * has an external route. The role belongs solely to the owned INTERNAL network.
 * command is the maintained rootless Docker transport, never a model callback.
 */
export function createContainerEgress({command,image,profile,node=false}={}) {
  if(typeof command!=='function'||!/^sha256:[a-f0-9]{64}$/.test(image)
      ||!['codex','claude','gemini','hooks','dependency-download'].includes(profile)||typeof node!=='boolean')fail('configuration');
  const endpoints=validateEndpoints([...new Set([...endpointProfiles[profile],...(node?endpointProfiles['dependency-download']:[])])]);
  const network='nibfin-net-'+randomUUID(), gateway='nibfin-gateway-'+randomUUID();
  let reserved=false,created=false,ready=false,unresolved=false,closed=false;
  const entry=fileURLToPath(new URL('./egress-gateway.mjs',import.meta.url));
  const environment=Object.freeze({HTTP_PROXY:'http://nibfin-egress:8080',HTTPS_PROXY:'http://nibfin-egress:8080',
    http_proxy:'http://nibfin-egress:8080',https_proxy:'http://nibfin-egress:8080',NO_PROXY:'',no_proxy:''});
  async function checked(args) {const r=await command(args);if(!r.ok)fail('process');return r.output;}
  async function inspect() {
    const [n]=JSON.parse(await checked(['network','inspect',network]));
    if(n.Name!==network||n.Internal!==true||n.Driver!=='bridge'||n.EnableIPv6!==false
      ||n.Options?.['com.docker.network.bridge.gateway_mode_ipv4']!=='isolated'||n.Labels?.['nibfin.egress']!==network)fail('network');
    const [g]=JSON.parse(await checked(['inspect',gateway]));
    if(g.Name!=='/'+gateway||g.Image!==image||g.Config?.Labels?.['nibfin.egress']!==network||g.State?.Running!==true
        ||g.HostConfig?.Privileged!==false||g.HostConfig?.ReadonlyRootfs!==true
        ||Object.keys(g.NetworkSettings?.Networks??{}).sort().join(',')!==['bridge',network].sort().join(','))fail('gateway');
  }
  return Object.freeze({network,environment,
    async ensure() {
      if(closed)fail('retired');if(ready){await inspect();return;}if(reserved)fail('unresolved');reserved=true;
      try {
        created=true;await checked(['network','create','--internal','--driver','bridge','--ipv6=false','--opt','com.docker.network.bridge.gateway_mode_ipv4=isolated','--label',`nibfin.egress=${network}`,network]);
        await checked(['create','--name',gateway,'--label',`nibfin.egress=${network}`,'--pull','never','--read-only',
          '--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','32','--memory','128m',
          '--network','bridge','--log-driver','none','--env',`NIBFIN_ENDPOINTS=${JSON.stringify(endpoints)}`,
          '--mount',`type=bind,src=${entry},dst=/gateway.mjs,readonly,bind-recursive=disabled`,
          '--entrypoint','/usr/local/bin/node',image,'/gateway.mjs']);
        await checked(['network','connect','--alias','nibfin-egress',network,gateway]);
        await checked(['start',gateway]);await inspect();ready=true;
      }catch{unresolved=true;fail('enforcement-unavailable');}
    },
    async verifyRole(container) {
      await inspect();
      if(Object.keys(container.NetworkSettings?.Networks??{}).join(',')!==network
          ||container.HostConfig?.NetworkMode!==network
          ||JSON.stringify(container.HostConfig?.Dns)!=='["127.0.0.1"]'
          ||JSON.stringify(container.HostConfig?.DnsSearch)!=='["."]')fail('direct-route');
    },
    async cleanup() {
      if(!reserved||closed)return {status:'completed'};
      // Never rm an uncorrelated or running role. Backend first removes its owned roles.
      try {
        const listing=await checked(['container','ls','--all','--filter',`label=nibfin.egress=${network}`,'--format','{{.Names}}']);
        const names=listing.trim().split('\n').filter(Boolean);
        if(names.some(n=>n!==gateway))fail('ownership');
        if(names.includes(gateway))await checked(['rm','--force',gateway]);
        const left=await checked(['container','ls','--all','--filter',`label=nibfin.egress=${network}`,'--format','{{.Names}}']);
        if(left.trim())fail('residual');
        if(created) {
          const listing=JSON.parse(await checked(['network','inspect',network]));
          if(listing.length!==1||listing[0].Name!==network||listing[0].Labels?.['nibfin.egress']!==network)fail('network-ownership');
          await checked(['network','rm',network]);
        }
        const networks=await checked(['network','ls','--filter',`label=nibfin.egress=${network}`,'--format','{{.Name}}']);
        if(networks.trim())fail('network-residual');
        ready=false;closed=true;return {status:'completed'};
      }catch{unresolved=true;return {status:'unresolved'};}
    },
    diagnostic:()=>unresolved?'enforcement-unresolved':ready?'enforced':'unprobed'
  });
}
