// Fixed container entrypoint. No repository code is loaded by this module.
import {spawnSync} from 'node:child_process';
import {readFileSync, readSync, openSync, fstatSync, closeSync, constants} from 'node:fs';
import {pathToFileURL} from 'node:url';
const env = {PATH:'/usr/local/bin:/usr/bin:/bin', HOME:'/tmp/home', CODEX_HOME:'/tmp/home/.codex'};
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
  const args = ['--no-daemon','--ask-for-approval','never','exec','--ignore-user-config','--ignore-rules',
      '--ephemeral','--skip-git-repo-check','--cd','/work','--sandbox',request.access === 'write' ? 'workspace-write' : 'read-only',
      '-c','model_instructions_file="/input/instructions.md"','--output-schema','/input/schema.json',
      '--output-last-message','/tmp/result.json','-'];
  return {file:tool,args,options:{env,input:request.prompt,stdio:['pipe','ignore','ignore'],
    timeout:request.timeout,killSignal:'SIGKILL',maxBuffer:1048576}};
}
export function runCodexEntry() {
try {
  if (process.argv[2] === 'probe') {
    const version = spawnSync(tool, ['--version'], {env, encoding:'utf8', timeout:10000, killSignal:'SIGKILL', maxBuffer:4096});
    const login = spawnSync(tool, ['login','status'], {env, stdio:'ignore', timeout:10000, killSignal:'SIGKILL'});
    const os = readFileSync('/etc/os-release','utf8');
    console.log(JSON.stringify({node:process.version, platform:process.platform, arch:process.arch,
      guest:/^ID=debian$/m.test(os) && /^VERSION_ID="12"$/m.test(os),
      version:version.status === 0 ? version.stdout.trim() : null, login:login.status === 0}));
  } else {
    const request = JSON.parse(readCodexFile('/input/request.json'));
    const command = codexInvocation(request);
    const run = spawnSync(command.file,command.args,command.options);
    if (run.status !== 0) process.exit(1);
    // Only a regular, bounded final JSON file is returned. Never forward CLI logs.
    const result = JSON.parse(readCodexFile('/tmp/result.json'));
    process.stdout.write(JSON.stringify({...request.context,result}));
  }
} catch { process.exitCode = 1; }

}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) runCodexEntry();
