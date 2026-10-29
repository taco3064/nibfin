import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { CodexAgent } from '../src/agent.mjs';

test('reviewers can execute disposable test fixtures while the candidate stays read-only',()=>{
  const agent=new CodexAgent({image:'sha256:'+'a'.repeat(64),network:'kairo-agent-private',user:'1000:1000',authDirectory:'/operator/auth'},'/core','/state');
  const args=agent.args('/candidate','/io',false),scratch=args[args.indexOf('--tmpfs')+1],options=scratch.split(':')[1].split(',');
  assert.equal(scratch.split(':')[0],'/tmp');
  for(const option of ['rw','exec','nosuid','nodev','size=512m'])assert.ok(options.includes(option));
  assert.ok(!options.includes('noexec'));
  assert.ok(args.includes(`type=bind,src=${resolve('/candidate')},dst=/work,readonly`));
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--cap-drop=ALL'));
  assert.ok(args.includes('--security-opt=no-new-privileges'));
  assert.equal(args[args.indexOf('--user')+1],'1000:1000');
});
