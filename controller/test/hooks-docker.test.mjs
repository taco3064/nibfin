import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Workspace} from '../src/workspace.mjs';
import {runHooks} from '../src/hooks.mjs';
import {command} from '../src/process.mjs';
import {digest} from '../src/core.mjs';

// Explicit local Docker verification; ordinary CI does not assume Docker or
// silently download an unpinned execution image.
const image=process.env.KAIRO_HOOK_TEST_IMAGE;
for(const [name,event,script,expected] of [
  ['index-only mutation','pre-commit','git update-index --force-remove extra.txt\n','failed'],
  ['message-only mutation','commit-msg','printf "rewritten\\n" > "$1"\n','failed'],
  ['prepare-message mutation','prepare-commit-msg','printf "rewritten\\n" > "$1"\n','failed'],
  ['unchanged hook','pre-commit','git diff --cached --name-only | grep -qx extra.txt\n','passed'],
  ['incorrect staged inventory','pre-commit','exit 0\n','failed'],
]) test(`real Git/Docker hook fidelity: ${name}`,{skip:!image},async t=>{
  const root=await mkdtemp(join(tmpdir(),'kairo-hook-fidelity-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const seed=join(root,'seed');await mkdir(seed);
  const git=async args=>(await command('git',args,{cwd:seed})).stdout.trim();
  await git(['init','--template=']);await git(['config','user.name','Fixture']);await git(['config','user.email','fixture@localhost']);
  await writeFile(join(seed,'hook.sh'),'#!/bin/sh\nset -eu\n'+script);
  await writeFile(join(seed,'baseline.txt'),'baseline\n');
  await git(['add','.']);await git(['-c','core.hooksPath=/dev/null','commit','-m','Initialize fixture']);
  const base=await git(['rev-parse','HEAD']);
  const workspace=new Workspace(join(root,'workspace'),{repository:'example/hooks',number:1},'fixture',async(exe,args,options)=>command(exe,args.map(x=>x==='https://github.com/example/hooks.git'?seed:x),options));
  await workspace.prepare(base);await writeFile(join(workspace.work,'extra.txt'),'candidate\n');
  const hooks=[{path:'hook.sh',event}],obligations={artifacts:[],hooks};
  const candidate=await workspace.capture(base,false,obligations);
  const gitState=await workspace.hookRepository(base,candidate);
  if(name==='incorrect staged inventory')gitState.paths=['not-staged.txt'];
  const result=await runHooks({image,user:`${process.getuid()}:${process.getgid()}`},workspace.work,hooks,undefined,gitState);
  assert.equal(result.status,expected,JSON.stringify(result));
  // All counterexamples leave the working files and Controller capture intact.
  assert.equal(await readFile(join(workspace.work,'extra.txt'),'utf8'),'candidate\n');
  assert.equal(digest(await workspace.capture(base,false,obligations)),digest(candidate));
  if(expected==='failed')assert.match(result.output.stderr,name==='incorrect staged inventory'?/staged path inventory/:event==='pre-commit'?/index tree/:/message rewrite/);
  else {
    assert.equal(result.execution.exitCode,0);assert.deepEqual(result.stagedPaths,['extra.txt']);
    assert.equal(result.stagedPathsVerified,true);assert.equal(result.execution.isolation.network,'none');
    assert.deepEqual(result.execution.invocations,[{event,command:'sh',arguments:['/work/hook.sh']}]);
    assert.equal(result.indexTree,candidate.tree);assert.equal(result.messageHash,digest(workspace.commitMessage(candidate)));
    assert.equal(result.commitMessage,workspace.commitMessage(candidate));
    assert.equal(digest(result.commitMessage),result.messageHash);
    const commit=await workspace.commit(candidate,new Date().toISOString());
    assert.equal(await workspace.git(['rev-parse',commit+'^{tree}']),result.indexTree);
    const raw=(await command('git',[`--git-dir=${workspace.gitDir}`,'cat-file','commit',commit])).stdout;
    assert.equal(raw.slice(raw.indexOf('\n\n')+2),result.commitMessage);
  }
});
