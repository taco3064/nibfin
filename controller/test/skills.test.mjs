import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectSkill, validateSkillPolicy } from '../src/skills.mjs';
import { resolveSkill } from '../src/agent.mjs';
import { digest, plan } from '../src/core.mjs';
import { fixture, shape, deliver, NOW } from './fixtures.mjs';

test('all four Shape execution roles share the owning repository Skill without cross-repository leakage',()=>{
  const a={mode:'extend',path:'/approved/a.md',hash:'a'.repeat(64)}, b={mode:'override',path:'/approved/b.md',hash:'b'.repeat(64)};
  const policy={repositories:{'owner/a':{skills:{shape:a}},'owner/b':{skills:{shape:b}}}};
  for(const stage of ['shape','shape-validator','shape-diagnosis','shaper-review']) {
    const selected=selectSkill(policy,'owner/a',stage);
    assert.equal(selected.identity,'shape');assert.equal(selected.stage,stage);assert.equal(selected.scope,'repository');assert.deepEqual(selected.customization,a);
    assert.deepEqual(selectSkill(policy,'owner/b',stage).customization,b);
    selected.customization.path='mutated';assert.equal(policy.repositories['owner/a'].skills.shape.path,a.path);
  }
  assert.equal(selectSkill(policy,'owner/b','accept').identity,'accept');
  assert.equal(selectSkill(policy,'owner/b','deliver').scope,'builtin');
  assert.throws(()=>selectSkill(policy,'owner/other','shape'),/outside/);
});

test('repository selection overrides cohort defaults and explicit default resets to the standard Skill',()=>{
  const common={mode:'extend',path:'/approved/shared.md',hash:'c'.repeat(64)};
  const policy={skills:{shape:common},repositories:{'owner/a':{skills:{shape:{mode:'default'}}},'owner/b':{}}};
  assert.equal(selectSkill(policy,'owner/a','shaper-review').customization.mode,'default');
  assert.equal(selectSkill(policy,'owner/b','shape-diagnosis').scope,'cohort');
  assert.deepEqual(selectSkill(policy,'owner/b','shape-validator').customization,common);
});

test('unknown Skill types, stage aliases and identity-changing configuration fail before execution',()=>{
  for(const key of ['shape-validator','shape-diagnosis','shaper-review','arbitrary']) {
    for(const policy of [{skills:{[key]:{mode:'default'}}},{repositories:{'owner/a':{skills:{[key]:{mode:'default'}}}}}]) assert.throws(()=>validateSkillPolicy(policy),/Unknown Skill/);
  }
  assert.throws(()=>validateSkillPolicy({skills:{shape:{mode:'override',path:'/x',hash:'bad'}}}),/hash/);
  assert.throws(()=>validateSkillPolicy({skills:{shape:{mode:'default',identity:'other'}}}),/Unsupported/);
});

test('default, extend and override preserve fixed identities and record actual instruction sources',async t=>{
  const root=await mkdtemp(join(tmpdir(),'kairo-skills-'));t.after(()=>rm(root,{recursive:true}));
  const path=join(root,'product.md'), text='Product-specific Claim, Oracle and Evidence Obligations.';
  await writeFile(path,text);
  for(const stage of ['shape','shape-validator','shape-diagnosis','shaper-review','deliver','accept']) {
    const identity=stage.startsWith('shape')?'shape':stage;
    const standard=await resolveSkill(process.cwd(),stage);
    assert.equal(standard.identity,identity);assert.match(standard.content,new RegExp('name: '+identity+'\\r?\\n'));
    const extended=await resolveSkill(process.cwd(),stage,{mode:'extend',path,hash:digest(text)});
    assert.equal(extended.content,standard.content+'\n\n'+text);assert.equal(extended.sources.length,2);
    const replaced=await resolveSkill(process.cwd(),stage,{mode:'override',path,hash:digest(text)});
    assert.equal(replaced.identity,identity);assert.equal(replaced.stage,stage);assert.equal(replaced.content,text);assert.deepEqual(replaced.sources,[{kind:'customization',path,hash:digest(text)}]);
  }
  await writeFile(path,'changed after approval');
  await assert.rejects(resolveSkill(process.cwd(),'accept',{mode:'override',path,hash:digest(text)}),/approved digest/);
  assert.match(await readFile('skills/shape/SKILL.md','utf8'),/name: shape\r?\n/);
});

test('repository overrides cannot skip independent acceptance or exact-head CI',()=>{
  const f=fixture();f.policy.repositories['example/one'].skills={accept:{mode:'override',path:'/approved/skip-gates.md',hash:'a'.repeat(64)}};
  f.snapshot.policyHash=digest(f.policy);f.snapshot.approval.policyHash=digest(f.policy);
  for(const i of f.manifest.issues)shape(f,i.id);
  deliver(f,'I_A');delete f.snapshot.issues.I_A.accept;
  assert.equal(plan(f.manifest,f.policy,f.snapshot,NOW).operation,'accept');
  deliver(f,'I_A');f.snapshot.issues.I_A.accept.executionId=f.snapshot.issues.I_A.delivery.executionId;
  assert.equal(plan(f.manifest,f.policy,f.snapshot,NOW).code,'NOT_INDEPENDENT');
  deliver(f,'I_A');f.snapshot.issues.I_A.checks=[];
  assert.equal(plan(f.manifest,f.policy,f.snapshot,NOW).code,'CI_PENDING_OR_FAILED');
});
