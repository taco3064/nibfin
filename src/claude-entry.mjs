import {probeVerificationSupervisor} from './verification-child.mjs';
// Trusted container entrypoint; never imports checkout modules or configuration.
import {probeGateway,executeSession,capacityError,rejectSecrets} from './agent-session.mjs';
import {spawnSync} from 'node:child_process';
import {readFileSync, existsSync, openSync, fstatSync, readSync, closeSync, constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const tool='/usr/local/bin/claude';
const version='2.1.285 (Claude Code)';
export const claudeFeatures=Object.freeze(['--print','--bare','--tools','--allowedTools','--disallowedTools',
  '--permission-mode','--setting-sources','--settings','--strict-mcp-config','--mcp-config',
  '--system-prompt-file','--json-schema','--output-format','--no-session-persistence','--session-id']);
export function readClaudeFile(path) {
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
export function claudeEnvironment(key) {
  return {HTTP_PROXY:'http://nibfin-egress:8080',HTTPS_PROXY:'http://nibfin-egress:8080',NODE_USE_ENV_PROXY:'1',NO_PROXY:'',PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp/home',CLAUDE_CONFIG_DIR:'/tmp/home/.claude',
    ANTHROPIC_API_KEY:key,DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
}
export function claudeInvocation(request,schema,key) {
  if(!['read','write'].includes(request.access))throw Error('claude:access');
  const tools=request.access==='write'?'Read,Glob,Grep,Edit,Write,Bash':'Read,Glob,Grep';
  return {file:tool,args:['--print','--bare','--output-format','json','--json-schema',schema,
    '--system-prompt-file','/input/instructions.md','--tools',tools,'--allowedTools',tools,
    '--disallowedTools','mcp__*','--permission-mode','dontAsk','--setting-sources','',
    '--settings','{"disableAllHooks":true}','--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
    ...(request.recovery?[]:['--no-session-persistence']),
    ...(request.session?['--resume',request.session]:['--session-id',request.initialSession??randomUUID()]),
    ...(request.model?['--model',request.model]:[])],options:{env:claudeEnvironment(key),
      input:request.prompt,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:request.timeout,
      killSignal:'SIGKILL',maxBuffer:1048576}};
}
// Scan the entire decoded envelope, including discarded metadata and property names.
export function claudeResult(output,context,secrets) {
  if(typeof output!=='string' || Buffer.byteLength(output)>1048576)throw Error('claude:output');
  const envelope=JSON.parse(output), pending=[envelope];rejectSecrets(envelope,secrets);
  while(pending.length) {
    const v=pending.pop();
    if(typeof v==='string' && secrets.some(s=>v.includes(s)))throw Error('claude:credential-output');
    if(v && typeof v==='object')for(const [k,item] of Object.entries(v))pending.push(k,item);
  }
  if(envelope?.type!=='result' || envelope.subtype!=='success' || envelope.is_error!==false
      || !envelope.structured_output || typeof envelope.structured_output!=='object'
      || Array.isArray(envelope.structured_output))throw Error('claude:final-result');
  return {...context,result:envelope.structured_output};
}
const options=env=>({env,encoding:'utf8',timeout:10000,killSignal:'SIGKILL',maxBuffer:65536});
export function probeClaude(env,run=spawnSync,unsafe=()=>
  ['/etc/claude-code','/usr/local/etc/claude-code'].some(existsSync)) {
  // Managed policy may install executable customizations even when project sources are disabled.
  if(unsafe())return {diagnostic:'unsafe-configuration'};
  const v=run(tool,['--version'],options(env));
  if(v.error || v.status!==0)return {diagnostic:'cli-unavailable'};
  if(v.stdout.trim()!==version)return {diagnostic:'unsupported-version'};
  const help=run(tool,['--help'],options(env));
  if(help.error || help.status!==0 || !claudeFeatures.every(flag=>help.stdout.includes(flag)))
    return {diagnostic:'unsupported-features'};
  const auth=run(tool,['auth','status'],options(env));
  let login;try {login=JSON.parse(auth.stdout);}catch {return {diagnostic:'login-rejected'};}
  if(auth.error || auth.status!==0 || login.loggedIn!==true || login.authMethod!=='api_key')
    return {diagnostic:'login-rejected'};
  return {diagnostic:'ready',version,login:true};
}
function authenticationFailure(r) {
  return /authentication_error|invalid_api_key|not logged in|invalid api key|expired|\b401\b/i
    .test(String(r.stdout ?? '') + String(r.stderr ?? ''));
}
export function executeClaude(request,schema,key,run=spawnSync) {
  const initialSession=randomUUID();
  return executeSession({request:{...request,initialSession},adapter:'claude',version,run,
    invoke:r=>claudeInvocation(r,schema,key),
    inspect:r=>{
      if(authenticationFailure(r))return {authentication:true};
      const e=JSON.parse(r.stdout);rejectSecrets(e,[key]);
      if(e.session_id!==initialSession)throw Error();
      return {session:e.session_id,success:e.type==='result'&&e.subtype==='success'&&e.is_error===false,
        capacity:capacityError('claude',e),authentication:authenticationFailure(r)};
    },decode:output=>claudeResult(output,request.context,[key])});
}
export async function runClaudeEntry() {
  try {
    const login=JSON.parse(readClaudeFile('/login.json'));
    if(login.auth_mode!=='anthropic-api-key' || typeof login.api_key!=='string' || !login.api_key)throw Error();
    const env=claudeEnvironment(login.api_key);
    if(process.argv[2]==='probe') {
      const p=probeClaude(env), os=readFileSync('/etc/os-release','utf8');
      process.stdout.write(JSON.stringify({...p,node:process.version,platform:process.platform,arch:process.arch,
        verificationSupervisor:probeVerificationSupervisor(),network:await probeGateway([...["api.anthropic.com"],...(process.env.NIBFIN_NODE_WORKLOAD==='1'?['registry.npmjs.org']:[])]),
        guest:/^ID=debian$/m.test(os) && /^VERSION_ID="12"$/m.test(os)}));
    } else {
      const request=JSON.parse(readClaudeFile('/input/request.json'));
      const result=executeClaude(request,readClaudeFile('/input/schema.json'),login.api_key);
      process.stdout.write(JSON.stringify(result.evidence ?? result));
      if(!result.evidence)process.exitCode=1;
    }
  } catch {process.exitCode=1;}
}
if(process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url)runClaudeEntry();
