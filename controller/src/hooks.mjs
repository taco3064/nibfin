import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { command } from './process.mjs';
import { digest } from './core.mjs';
import { safeCandidatePath } from './candidate-contract.mjs';
import {dockerCommand,assertContainerUser,verifyDockerSecurity} from './docker-security.mjs';

// Hooks never run in the controller or authenticated Agent. Git metadata is
// disposable and contains no remote, token, signing key or host configuration.
export async function runHooks(config, work, hooks, run = command, gitState) {
  if (!hooks.length) return {executionId:randomUUID(), status:'not-applicable', hooks:[]};
  if (!/^(?:[^\s]+@)?sha256:[a-f0-9]{64}$/.test(config.image) || /[,\r\n]/.test(work)) throw new Error('Invalid hook sandbox configuration');
  assertContainerUser(config);
  run=dockerCommand(config,run);
  await verifyDockerSecurity(config,run);
  for (const hook of hooks) if (!safeCandidatePath(hook.path) || !['pre-commit','prepare-commit-msg','commit-msg'].includes(hook.event)) throw new Error('Invalid hook');
  if (!gitState || !/^[a-f0-9]{40}$/.test(gitState.tree) || typeof gitState.commitMessage !== 'string' || !/^[a-f0-9]{40}$/.test(gitState.base) || /[,\r\n]/.test(gitState.directory)) throw new Error('Exact hook baseline required');
  if (!Array.isArray(gitState.paths) || !gitState.paths.every(safeCandidatePath)) throw new Error('Exact staged path inventory required');
  const executionId = randomUUID(), container = 'nibfin-hooks-' + executionId;
  const script = 'set -eu\numask 077\ncp -R /baseline-git /tmp/hooks.git\nexport GIT_DIR=/tmp/hooks.git GIT_WORK_TREE=/work\ngit read-tree ' + gitState.base + '\ngit -c core.hooksPath=/dev/null -c core.autocrlf=false add --all -- .\nprintf "%s" "$UPSTREAM_COMMIT_MESSAGE" >/tmp/message\n' + hooks.map(h => `sh /work/${h.path}${h.event === 'pre-commit' ? '' : h.event === 'commit-msg' ? ' /tmp/message' : ' /tmp/message message'}`).join('\n') + '\nactual_tree=$(git --git-dir=/tmp/hooks.git write-tree)\nif [ "$actual_tree" != "$UPSTREAM_CANDIDATE_TREE" ]; then echo "Hook changed the Candidate index tree; fresh delivery and acceptance required" >&2; exit 1; fi\nprintf "%s" "$UPSTREAM_COMMIT_MESSAGE" | cmp - /tmp/message || { echo "Hook message rewrite is unsupported; commit refused" >&2; exit 1; }\n';
  const args = ['run','--rm','--name',container,'--read-only','--network','none','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=128','--memory=1g','--cpus=1','--user',config.user,'--tmpfs','/tmp:rw,nosuid,nodev,size=256m,mode=1777','--mount',`type=bind,src=${resolve(work)},dst=/work`,'--mount',`type=bind,src=${resolve(gitState.directory)},dst=/baseline-git,readonly`,'--workdir','/work','--env','UPSTREAM_CANDIDATE_TREE='+gitState.tree,'--env','UPSTREAM_COMMIT_MESSAGE='+gitState.commitMessage,'--env','HOME=/tmp','--env','GIT_CONFIG_NOSYSTEM=1',config.image,'sh','-c',script];
  const expectedPaths = Buffer.from(gitState.paths.map(p=>p+'\0').join('')).toString('base64');
  const verifyIndex = `git diff --cached --name-only -z ${gitState.base} -- >/tmp/staged-paths\nprintf "%s" "$UPSTREAM_STAGED_PATHS_BASE64" | base64 -d >/tmp/expected-staged-paths\ncmp /tmp/expected-staged-paths /tmp/staged-paths || { echo "Hook staged path inventory differs from Candidate" >&2; exit 1; }\n[ "$(git write-tree)" = "$UPSTREAM_CANDIDATE_TREE" ] || { echo "Hook initial index differs from Candidate" >&2; exit 1; }\n`;
  args[args.length-1] = script.replace('printf "%s" "$UPSTREAM_COMMIT_MESSAGE" >/tmp/message\n', verifyIndex+'printf "%s" "$UPSTREAM_COMMIT_MESSAGE" >/tmp/message\n');
  args.splice(args.indexOf(config.image),0,'--env','UPSTREAM_STAGED_PATHS_BASE64='+expectedPaths);
  const execution = {command:'docker',arguments:args,timeoutMs:120000,startedAt:new Date().toISOString(),invocations:hooks.map(h=>({event:h.event,command:'sh',arguments:['/work/'+h.path,...(h.event==='pre-commit'?[]:h.event==='commit-msg'?['/tmp/message']:['/tmp/message','message'])]})),isolation:{network:'none',credentialsMounted:false,readOnlyRoot:true,disposableGitMetadata:true}};
  try {
    const output = await run('docker',args,{timeout:120000});
    // Reviewers need the exact bytes as well as their identity. A hash alone
    // cannot establish what message the isolated hooks actually validated.
    return {executionId,status:'passed',base:gitState.base,indexTree:gitState.tree,stagedPaths:[...gitState.paths],stagedPathsVerified:true,commitMessage:gitState.commitMessage,messageHash:digest(gitState.commitMessage),hooks,execution:{...execution,completedAt:new Date().toISOString(),exitCode:0},outputHash:digest(output),output};
  } catch (error) {
    // A timed-out client must not leave a writer alive while acceptance runs.
    try {
      const active = await run('docker',['ps','-aq','--filter',`name=^/${container}$`]);
      if (active.stdout.trim()) await run('docker',['rm','--force',container]);
    } catch { throw Object.assign(new Error('Hook container cleanup unconfirmed'),{recoveryRequired:true}); }
    const output = {message:error.message,stdout:error.stdout || '',stderr:error.stderr || ''};
    return {executionId,status:'failed',base:gitState.base,hooks,execution:{...execution,completedAt:new Date().toISOString(),exitCode:Number.isInteger(error.exitCode)?error.exitCode:null},outputHash:digest(output),output};
  }
}
