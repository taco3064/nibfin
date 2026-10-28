import {readonlyMcpServer,readonlyToolNames} from './readonly-tools.mjs';
import {prepareReadonlyVerification} from './agent-session.mjs';
import {probeVerificationSupervisor} from './verification-child.mjs';
// Trusted standalone container entrypoint. Never import checkout modules.
import {probeGateway,executeSession,capacityError,rejectSecrets} from './agent-session.mjs';
import {spawnSync} from 'node:child_process';
import {readFileSync,existsSync,openSync,fstatSync,readSync,closeSync,constants,mkdirSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const tool='/usr/local/bin/gemini', version='0.65.0';
export const geminiFeatures=Object.freeze(['--prompt','--output-format','--approval-mode','--admin-policy','--extensions']);
export const geminiSettings=Object.freeze({
  general:{enableAutoUpdate:false,enableAutoUpdateNotification:false,checkpointing:{enabled:false}},
  advanced:{ignoreLocalEnv:true},hooksConfig:{enabled:false},
  admin:{mcp:{enabled:false},extensions:{enabled:false},skills:{enabled:false}},
  experimental:{enableAgents:false,extensionManagement:false,extensionConfig:false},
  security:{auth:{selectedType:'gemini-api-key',enforcedType:'gemini-api-key'}},
  telemetry:{enabled:false},mcpServers:{},
});
export function geminiRoleSettings(access) {
  if(!['read','write'].includes(access))throw Error('gemini:access');
  return access==='write'?geminiSettings:{...geminiSettings,admin:{...geminiSettings.admin,mcp:{enabled:true}},
    mcpServers:{nibfin:{...readonlyMcpServer,includeTools:readonlyToolNames,timeout:3600000}}};
}
export function geminiPolicy(access) {
  if(!['read','write'].includes(access))throw Error('gemini:access');
  const tools=['read_file','read_many_files','list_directory','glob','grep_search',
    ...(access==='write'?['write_file','replace','run_shell_command']:[])];
  return '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 900\n'+tools.map(tool=>
    `\n[[rule]]\ntoolName = "${tool}"\ndecision = "allow"\npriority = 999\n`).join('')+(access==='read'?readonlyToolNames.map(tool=>`\n[[rule]]\nmcpName = "nibfin"\ntoolName = "${tool}"\ndecision = "allow"\npriority = 999\n`).join(''):'');
}
export function readGeminiFile(path) {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const s=fstatSync(fd);
    if(!s.isFile() || s.nlink!==1 || s.size>1048576)throw Error();
    const b=Buffer.alloc(1048577);let n=0,k;
    while(n<b.length && (k=readSync(fd,b,n,b.length-n,null)))n+=k;
    if(n>1048576 || n!==s.size || fstatSync(fd).size!==s.size)throw Error();
    return b.subarray(0,n).toString('utf8');
  } finally {closeSync(fd);}
}
export function geminiEnvironment(key,probe=false) {
  return {HTTP_PROXY:'http://nibfin-egress:8080',HTTPS_PROXY:'http://nibfin-egress:8080',NODE_USE_ENV_PROXY:'1',NO_PROXY:'',PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp/home',GEMINI_API_KEY:key,
    GEMINI_SYSTEM_MD:'/input/gemini-system.md',
    GEMINI_CLI_SYSTEM_SETTINGS_PATH:probe?'/tmp/probe-settings.json':'/input/gemini-settings.json',
    GEMINI_CLI_SYSTEM_DEFAULTS_PATH:probe?'/tmp/probe-settings.json':'/input/gemini-settings.json',CI:'true',NO_BROWSER:'true'};
}
export function geminiInvocation(request,key) {
  geminiPolicy(request.access);
  return {file:tool,args:['--prompt','Complete the task supplied on stdin.',
    '--output-format','json','--approval-mode','default','--admin-policy','/input/gemini-policy.toml',
    ...(request.session?['--resume',request.session]:[]),...(request.model?['--model',request.model]:[])],
    options:{env:geminiEnvironment(key),cwd:'/work',input:request.prompt,encoding:'utf8',
      stdio:['pipe','pipe','pipe'],timeout:request.timeout,killSignal:'SIGKILL',maxBuffer:1048576}};
}
function scan(value,secrets) {
  const pending=[value];
  while(pending.length) {
    const v=pending.pop();
    if(typeof v==='string' && secrets.some(s=>v.includes(s)))throw Error('gemini:credential-output');
    if(v && typeof v==='object')for(const [k,item] of Object.entries(v))pending.push(k,item);
  }
}
export function geminiResult(output,context,secrets) {
  if(typeof output!=='string' || Buffer.byteLength(output)>1048576)throw Error('gemini:output');
  const envelope=JSON.parse(output);rejectSecrets(envelope,secrets);scan(envelope,secrets);
  if(!envelope || typeof envelope!=='object' || Array.isArray(envelope) || 'error' in envelope
      || typeof envelope.response!=='string' || !envelope.response.trim())throw Error('gemini:final-result');
  const result=JSON.parse(envelope.response);scan(result,secrets);
  if(!result || typeof result!=='object' || Array.isArray(result))throw Error('gemini:result');
  return {...context,result}; // Core lifecycle independently validates StageResult and current bindings.
}
const options=env=>({env,cwd:'/tmp',encoding:'utf8',timeout:10000,killSignal:'SIGKILL',maxBuffer:65536});
export function probeGemini(env,run=spawnSync,unsafe=()=>existsSync('/etc/gemini-cli')) {
  if(unsafe())return {diagnostic:'unsafe-configuration'};
  const v=run(tool,['--version'],options(env));
  if(v.error || v.status!==0)return {diagnostic:'cli-unavailable'};
  if(v.stdout.trim()!==version)return {diagnostic:'unsupported-version'};
  const h=run(tool,['--help'],options(env));
  if(h.error || h.status!==0 || !geminiFeatures.every(f=>h.stdout.includes(f)))return {diagnostic:'unsupported-features'};
  // API-key selection is local only; provider validity is diagnosed at execution.
  return {diagnostic:'ready',version,login:true};
}
function authenticationFailure(r) {
  return /UNAUTHENTICATED|API_KEY_INVALID|invalid.api.key|not logged in|expired|\b401\b/i
    .test(String(r.stdout??'')+String(r.stderr??''));
}
export function executeGemini(request,key,run=spawnSync) {
  return executeSession({request,adapter:'gemini',version,run,invoke:r=>geminiInvocation(r,key),
    inspect:r=>{
      if(authenticationFailure(r))return {authentication:true};
      const e=JSON.parse(r.stdout);
      if('error' in e)return {session:e.session_id,success:false,capacity:capacityError('gemini',e),authentication:false};
      rejectSecrets(e,[key]);
      return {session:e.session_id,success:!('error' in e)&&typeof e.response==='string',
        capacity:capacityError('gemini',e),authentication:authenticationFailure(r)};
    },decode:output=>geminiResult(output,request.context,[key])});
}
export async function runGeminiEntry() {
  try {
    const login=JSON.parse(readGeminiFile('/login.json'));
    if(login.auth_mode!=='gemini-api-key' || typeof login.api_key!=='string' || !login.api_key)throw Error();
    mkdirSync('/tmp/home',{recursive:true,mode:0o700});
    if(process.argv[2]==='probe') {
      writeFileSync('/tmp/probe-settings.json',JSON.stringify(geminiSettings),{flag:'wx',mode:0o400});
      const p=probeGemini(geminiEnvironment(login.api_key,true)),os=readFileSync('/etc/os-release','utf8');
      process.stdout.write(JSON.stringify({...p,node:process.version,platform:process.platform,arch:process.arch,
        verificationSupervisor:probeVerificationSupervisor(),network:await probeGateway([...["generativelanguage.googleapis.com"],...(process.env.NIBFIN_NODE_WORKLOAD==='1'?['registry.npmjs.org']:[])]),
        guest:/^ID=debian$/m.test(os) && /^VERSION_ID="12"$/m.test(os)}));
    } else {
      const request=prepareReadonlyVerification(JSON.parse(readGeminiFile('/input/request.json')));
      const r=executeGemini(request,login.api_key);
      process.stdout.write(JSON.stringify(r.evidence??r));if(!r.evidence)process.exitCode=1;
    }
  } catch {process.exitCode=1;}
}
if(process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url)runGeminiEntry();
