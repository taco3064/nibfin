import {userInfo} from 'node:os';
import {lstatSync,realpathSync,accessSync,constants} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {canonicalJSON} from './grants.mjs';
import {linuxCodexProfile} from './codex.mjs';
import {linuxClaudeProfile} from './claude.mjs';
import {linuxGeminiProfile} from './gemini.mjs';
const fail = code => {throw Error(`runner:${code}`);};
const freeze = v => {if(v && typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export const supportedRunnerDefaults=freeze({version:1,platform:'linux',arch:'x64',isolation:'rootless-docker',
  node:linuxCodexProfile.node,docker:linuxCodexProfile.docker,npm:'10.9.9',verificationSupervisor:{interpreter:'/usr/bin/python3',version:'3.11',kernel:'child-subreaper'},
  tools:{codex:linuxCodexProfile.codex,claude:linuxClaudeProfile.claude,gemini:linuxGeminiProfile.gemini},
  path:'/usr/local/bin:/usr/bin:/bin',interpreter:'/usr/local/bin/node',
  acquisition:{dependencies:'dependency-download',images:'preprovisioned-pinned',lifecycleScripts:false},
  network:{boundary:'internal-docker-gateway',proxy:'http://nibfin-egress:8080',dns:'gateway-public-only',tls:'system-ca',
    management:'outside-agent',hooks:'offline'},
  status:'Unverified'});
const absolute = p => typeof p==='string' && p!=='/' && resolve(p)===p && !/[\x00-\x20,:]/.test(p);
/** Only deployment identities/locations vary in this version. Pins/security semantics
 * require a new supported profile, not a permissive merge of arbitrary overrides.
 */
export function runnerConfiguration(input) {
  if(!input||Object.getPrototypeOf(input)!==Object.prototype
      ||Object.keys(input).sort().join(' ')!=='account arch cache interpreter path platform scratch version work'
      ||input.version!==1||!['linux','wsl'].includes(input.platform)||input.arch!=='x64'
      ||input.path!==supportedRunnerDefaults.path||input.interpreter!==supportedRunnerDefaults.interpreter
      ||!['work','scratch','cache'].every(k=>absolute(input[k]))
      ||new Set([input.work,input.scratch,input.cache]).size!==3)fail('configuration');
  const roots=[input.work,input.scratch,input.cache];
  if(roots.some((p,n)=>roots.some((q,m)=>n!==m && p.startsWith(q+'/'))))fail('root-overlap');
  const a=input.account;
  if(!a||Object.keys(a).sort().join(' ')!=='githubUserId uid user'||!Number.isSafeInteger(a.uid)||a.uid<1
      ||typeof a.user!=='string'||!/^[a-z_][a-z0-9_-]*$/.test(a.user)||a.user==='root'
      ||typeof a.githubUserId!=='string'||!/^[1-9][0-9]*$/.test(a.githubUserId))fail('account');
  return freeze({...JSON.parse(canonicalJSON(supportedRunnerDefaults)),...JSON.parse(canonicalJSON(input))});
}
/** OS observations contain no arbitrary error text or inherited credentials. */
export function observeRunnerLocal(config) {
  const account=userInfo();
  const roots=Object.fromEntries(['work','scratch','cache'].map(k=>{
    try {
      const p=config[k];if(realpathSync(p)!==p)throw Error();
      for(let part=p;part!=='/';part=dirname(part))if(lstatSync(part).isSymbolicLink())throw Error();
      const s=lstatSync(p);if(!s.isDirectory()||s.uid!==account.uid||(s.mode&0o077))throw Error();
      accessSync(p,constants.R_OK|constants.W_OK|constants.X_OK);return [k,true];
    }catch{return [k,false];}
  }));
  return {platform:process.platform,arch:process.arch,uid:account.uid,user:account.username,roots,
    tokenOverride:!!(process.env.GH_TOKEN||process.env.GITHUB_TOKEN)};
}
const kinds=['policy-denial','authentication','proxy','dns','tls','timeout','offline-cache','missing-tool','unprobed'];
/** Probe selection is fixed and required; a missing probe never produces readiness.
 * External observations are injectable for local contract tests. No provider prose is
 * included in a public diagnostic, and configuration locations are owned here.
 */
export async function preflightRunner({configuration:config,observe=observeRunnerLocal,probe}={}) {
  if(!config||typeof observe!=='function'||typeof probe!=='function')fail('preflight-configuration');
  const diagnostics=[];
  const block=(capability,kind,hostname)=>diagnostics.push({capability,kind,configuration:`runner.v1.${capability}`,
    ...(typeof hostname==='string' && /^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(hostname)?{hostname}:{})});
  let local;try{local=await observe(config);}catch{local=null;}
  if(!local||local.platform!=='linux'||local.arch!==config.arch||local.uid!==config.account.uid
      ||local.user!==config.account.user||local.tokenOverride!==false)block('account','authentication');
  for(const key of ['work','scratch','cache'])if(local?.roots?.[key]!==true)block(key,key==='cache'?'offline-cache':'policy-denial');
  for(const capability of ['github-identity','tools','image','isolation','dependency-download','model-network','proxy','dns','tls']) {
    let result;try{result=await probe({capability,configuration:config});}catch{result={status:'blocked',kind:'unprobed'};}
    if(result?.status!=='verified'||capability==='github-identity'&&result.userId!==config.account.githubUserId)
      block(capability,kinds.includes(result?.kind)?result.kind:capability==='github-identity'?'authentication':'unprobed',result?.hostname);
  }
  return freeze({status:diagnostics.length?'blocked':'ready',diagnostics});
}
