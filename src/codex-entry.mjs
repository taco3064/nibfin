import {probeVerificationSupervisor} from './verification-child.mjs';
// Fixed container entrypoint. No repository code is loaded by this module.
import {probeGateway,executeSession,codexEvents,capacityError} from './agent-session.mjs';
import {spawnSync} from 'node:child_process';
import {readFileSync, readSync, openSync, fstatSync, closeSync, constants} from 'node:fs';
import {pathToFileURL} from 'node:url';
const env = {HTTP_PROXY:'http://nibfin-egress:8080',HTTPS_PROXY:'http://nibfin-egress:8080',NODE_USE_ENV_PROXY:'1',NO_PROXY:'',PATH:'/usr/local/bin:/usr/bin:/bin', HOME:'/tmp/home', CODEX_HOME:'/tmp/home/.codex'};
const tool = '/usr/local/bin/codex';
export function readCodexFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.size > 1048576) throw Error();
    const buffer=Buffer.alloc(1048577);let size=0, n;
    while(size < buffer.length && (n=readSync(fd,buffer,size,buffer.length-size,null))) size+=n;
    if(size > 1048576 || size !== s.size || fstatSync(fd).size !== s.size) throw Error();
    return buffer.subarray(0,size).toString('utf8');
  } finally { closeSync(fd); }
}
export function codexInvocation(request) {
  if(!['write','read'].includes(request.access))throw Error('codex:access');
  const args = ['--no-daemon','--ask-for-approval','never','exec',
      ...(request.session?['resume']:[]),'--ignore-user-config','--ignore-rules',
      '--skip-git-repo-check','--json',
      ...(request.session?[]:['--cd','/work','--sandbox',request.access === 'write' ? 'workspace-write' : 'read-only']),
      '-c','model_instructions_file="/input/instructions.md"',
      // Resume's saved policy is also explicitly pinned; it cannot inherit a broader sandbox.
      '-c',`sandbox_mode="${request.access === 'write' ? 'workspace-write' : 'read-only'}"`,
      '--output-schema','/input/schema.json',...(request.model?['--model',request.model]:[]),
      ...(request.session?[request.session]:[]),'-'];
  return {file:tool,args,options:{env,input:request.prompt,encoding:'utf8',stdio:['pipe','pipe','ignore'],
    cwd:'/work',timeout:request.timeout,killSignal:'SIGKILL',maxBuffer:1048576}};
}
export function executeCodex(request,secrets=[],run=spawnSync) {
  return executeSession({request,adapter:'codex',version:'codex-cli 0.163.0',invoke:codexInvocation,run,
    inspect:r=>{const o=codexEvents(r.stdout??'',secrets);return {...o,capacity:capacityError('codex',o.terminal),
      authentication:['unauthorized','authentication_error'].includes(o.terminal.error?.code)};},
    decode:output=>({...request.context,result:codexEvents(output,secrets).result})});
}
export async function runCodexEntry() {
try {
  if (process.argv[2] === 'probe') {
    const version = spawnSync(tool, ['--version'], {env, encoding:'utf8', timeout:10000, killSignal:'SIGKILL', maxBuffer:4096});
    const login = spawnSync(tool, ['login','status'], {env, stdio:'ignore', timeout:10000, killSignal:'SIGKILL'});
    const os = readFileSync('/etc/os-release','utf8');
    console.log(JSON.stringify({node:process.version, platform:process.platform, arch:process.arch,
      guest:/^ID=debian$/m.test(os) && /^VERSION_ID="12"$/m.test(os),
      verificationSupervisor:probeVerificationSupervisor(),network:await probeGateway([...["chatgpt.com", "auth.openai.com"],...(process.env.NIBFIN_NODE_WORKLOAD==='1'?['registry.npmjs.org']:[])]),
      version:version.status === 0 ? version.stdout.trim() : null, login:login.status === 0}));
  } else {
    const request = JSON.parse(readCodexFile('/input/request.json'));
    const auth=JSON.parse(readCodexFile('/tmp/home/.codex/auth.json'));
    const secrets=Object.values(auth.tokens??{}).filter(v=>typeof v==='string'&&v);
    const result=executeCodex(request,secrets);
    process.stdout.write(JSON.stringify(result.evidence??result));
    if(!result.evidence)process.exitCode=1;
  }
} catch { process.exitCode = 1; }

}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) runCodexEntry();
