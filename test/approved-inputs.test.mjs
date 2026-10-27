import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadApprovedInputs,byteDigest,createCore,contentIdentity} from '../src/index.mjs';
import {coreFixture} from '../tooling/core-fixture.mjs';
const copy=structuredClone,h='a'.repeat(64),commit='b'.repeat(40);
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'nibfin-inputs-'));
  await mkdir(join(root,'references'));const bytes=Buffer.from('public read-only configuration\n');
  await writeFile(join(root,'references/config.json'),bytes);
  const requirements={revision:h,scopeHash:h};
  const spec={source:{root,allowedRoot:root,repository:'example-org/core',commit},
    approval:{repository:'example-org/core',commit,requirements:copy(requirements),roles:['shape'],visibility:'public',
      files:[{path:'references/config.json',sha256:byteDigest(bytes)}]},
    expected:{repository:'example-org/core',commit,requirements:copy(requirements),role:'shape',paths:['references/config.json']}};
  return {root,bytes,spec,cleanup:()=>rm(root,{recursive:true,force:true})};
}
test('approved exact bytes available before Shape; no producer verdict or instruction evaluation',async()=>{
  const f=await fixture();
  try {
    const result=await loadApprovedInputs(f.spec);
    assert.equal(result.length,1);assert.equal(result[0].path,'references/config.json');
    assert.deepEqual(result[0].bytes,f.bytes);assert.equal(result[0].sha256,byteDigest(f.bytes));
    // Returned bytes are owned by the consumer; changing them cannot mutate source.
    result[0].bytes[0]=0;assert.deepEqual((await loadApprovedInputs(f.spec))[0].bytes,f.bytes);
  } finally {await f.cleanup();}
});
test('approval, current requirements, scope, role, source and exact paths independently fail closed',async()=>{
  const changes=[
    s=>s.approval=null,s=>s.approval.requirements.revision='c'.repeat(64),s=>s.approval.requirements.scopeHash='c'.repeat(64),
    s=>s.approval.commit='c'.repeat(40),s=>s.source.commit='c'.repeat(40),s=>s.approval.repository='other/core',
    s=>s.source.repository='other/core',s=>s.expected.role='accept',s=>s.approval.roles=[],
    s=>s.approval.visibility='private',s=>s.approval.files[0].sha256='c'.repeat(64),
    s=>s.expected.paths=['references/other.json'],s=>s.expected.paths.push(s.expected.paths[0]),
    s=>s.approval.files[0].path='../outside',s=>s.approval.files[0].path='/etc/passwd',
    s=>s.approval.files[0].path='references\\config.json',s=>s.maxBytes=1,
    s=>s.approval.verdict='approved'
  ];
  const f=await fixture();
  try {for(const change of changes){const spec=copy(f.spec);change(spec);await assert.rejects(()=>loadApprovedInputs(spec),/protected-host:inputs/);}}
  finally {await f.cleanup();}
});
test('missing/changed bytes, unsafe symlinks, and oversize input rejected before consumption',async()=>{
  for(const mode of ['changed','missing','symlink','directory-link','large']) {
    const f=await fixture();
    try {
      const path=join(f.root,'references/config.json');
      if(mode==='changed')await writeFile(path,'changed public bytes');
      if(mode==='missing')await rm(path);
      if(mode==='symlink'){await rm(path);await writeFile(join(f.root,'actual.json'),f.bytes);await symlink('../actual.json',path);}
      if(mode==='directory-link'){await rm(join(f.root,'references'),{recursive:true});await mkdir(join(f.root,'actual'));
        await writeFile(join(f.root,'actual/config.json'),f.bytes);await symlink('actual',join(f.root,'references'));}
      if(mode==='large'){const value=Buffer.alloc(1048577);await writeFile(path,value);f.spec.approval.files[0].sha256=byteDigest(value);}
      await assert.rejects(()=>loadApprovedInputs(f.spec));
    } finally {await f.cleanup();}
  }
});
test('real Core loads approved references before preparing/launching Shape and rejects stale bytes',async()=>{
  for(const bad of ['none','missing','stale','role','scope','commit','changed','omitted','approval']) {
    const f=await fixture(),c=coreFixture();let prepared=0;
    try {
      f.spec.expected.requirements={revision:h,scopeHash:c.pin.binding.scopeHash};
      f.spec.approval.requirements=copy(f.spec.expected.requirements);c.pin.requirementRevision=h;
      c.pin.referenceInputApproval=contentIdentity(f.spec.approval);
      const original=c.owners.shape.prepareRole;
      const owners={shape:{...c.owners.shape,prepareRole:async task=>{
        prepared++;assert.deepEqual(task.referenceInputs[0].bytes,f.bytes);return original(task);
      }}};
      if(bad==='missing')f.spec.approval=null;
      if(bad==='stale')f.spec.expected.requirements.revision='c'.repeat(64);
      if(bad==='scope')f.spec.expected.requirements.scopeHash='c'.repeat(64);
      if(bad==='role')f.spec.expected.role='deliver';
      if(bad==='commit')f.spec.source.commit='c'.repeat(40);
      if(bad==='approval')f.spec.approval.roles.push('deliver');
      if(bad==='changed')await writeFile(join(f.root,'references/config.json'),'changed');
      const core=createCore({provider:c.provider,current:()=>copy(c.pin),authorization:c.authorization,
        dependencies:c.dependencies,selector:c.selector,owners,...(bad==='omitted'?{}:{referenceInputs:async()=>f.spec})});
      const queued=await c.queued(),result=await core.run(queued);
      assert.equal(result.disposition,bad==='none'?'completed':'blocked',bad);
      assert.equal(prepared,bad==='none'?1:0,bad);assert.equal(c.sh.records.length,bad==='none'?1:0,bad);
    } finally {await f.cleanup();}
  }
});
