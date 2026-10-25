import test from 'node:test';
import assert from 'node:assert/strict';
import {observeGithubCI} from '../src/index.mjs';
import {ciFixture} from './ci-fixture.mjs';
const verify = f => observeGithubCI({provider:f.provider,expected:f.expected,actions:[f.pin]});
const native = f => observeGithubCI({provider:f.provider,expected:f.expected});
const checkPath = f => `/commits/${f.expected.head}/check-runs?filter=latest&per_page=100`;
const statusPath = f => `/commits/${f.expected.head}/statuses?per_page=100`;

test('exact-head package entry observes GET-only policy, run, attempt and job/check identities', async () => {
  const f = ciFixture(), r = await verify(f);
  assert.equal(Object.hasOwn(f.job,'run_attempt'),false);
  assert.equal(r.qualifies,true,JSON.stringify(r));
  assert.equal(r.expected.repositoryId,'9007199254740993');
  assert.equal(r.policy.strict,true);
  assert.equal(r.evaluations.length,2);
  assert.deepEqual(r.evaluations[1].evidence[0],{runId:'31',attempt:1,jobId:'51',checkId:'41',conclusion:'success',blob:f.pin.blob});
  assert.ok(f.calls.every(c => c.method === 'GET' && c.headers['X-GitHub-Api-Version'] === '2026-03-10'));
  assert.equal(f.counts['/pulls/7'],2);
  assert.equal(f.counts['/actions/runs/31'],2);
  assert.equal(f.counts['/actions/runs/31/attempts/1/jobs?per_page=100'],1);
  assert.ok(f.calls.some(c => c.endpoint.includes(`?ref=${f.expected.head}`)));
});

test('individual public owners and encoded target branches use the same contract', async () => {
  const f = ciFixture(f => { f.data[''].owner.type='User';
    f.expected.baseBranch='release/v1'; f.data['/pulls/7'].base.ref='release/v1';
    f.data['/branches/release%2Fv1']={...f.data['/branches/main'],name:'release/v1'};
    f.data['/branches/release%2Fv1/protection']=f.data['/branches/main/protection'];
    f.data['/rules/branches/release%2Fv1?per_page=100']=[];
  });
  assert.equal((await verify(f)).qualifies,true);
});

for (const [name,mutate] of Object.entries({
  repository:f=>{f.data[''].id='9';}, pr:f=>{f.data['/pulls/7'].id='9';}, number:f=>{f.data['/pulls/7'].number=8;},
  head:f=>{f.data['/pulls/7'].head.sha='c'.repeat(40);}, baseRepository:f=>{f.data['/pulls/7'].base.repo.id='9';},
  baseBranch:f=>{f.data['/pulls/7'].base.ref='other';}, baseSha:f=>{f.data['/branches/main'].commit.sha='c'.repeat(40);},
  private:f=>{f.data[''].private=true;}, sourceOwner:f=>{f.data[''].full_name='other/repo';}
})) test(`identity rejects ${name}`, async () => assert.equal((await verify(ciFixture(mutate))).qualifies,false));

test('invalid input performs no transport operation',async()=>{
  const f=ciFixture(); f.expected.head='bad';
  assert.equal((await verify(f)).reason,'invalid_input'); assert.equal(f.calls.length,0);
});

test('rules-only CI, combined policy, provenance, unrestricted checks and legitimate empty set', async()=>{
  for (const combined of [false,true]) {
    const f=ciFixture(f=>{
      if (!combined) f.data['/branches/main/protection'].required_status_checks=null;
      f.data['/rules/branches/main?per_page=100']=[f.rule,{type:'pull_request',ruleset_id:'62',ruleset_source:'example-org/core',ruleset_source_type:'Repository'}];
    });
    const r=await verify(f); assert.equal(r.qualifies,true); assert.equal(r.policy.requirements.length,combined?2:1);
    assert.deepEqual(r.policy.requirements.at(-1).source,{kind:'ruleset',id:'61',source:'example-org',sourceType:'Organization'});
    assert.equal(r.policy.limitations[0].type,'pull_request');
  }
  const unrestricted=ciFixture(f=>{f.data['/branches/main/protection'].required_status_checks.checks[0].app_id=null;});
  assert.equal((await native(unrestricted)).qualifies,true);
  const empty=ciFixture(f=>{f.data['/branches/main/protection'].required_status_checks=null;});
  assert.equal((await native(empty)).qualifies,true);
  const absent=ciFixture(f=>{f.statuses['/branches/main/protection']=404;f.data['/branches/main'].protected=false;});
  assert.equal((await native(absent)).qualifies,true);
});

for (const [name,mutate] of Object.entries({
  denied:f=>{f.statuses['/branches/main/protection']=403;}, inaccessible:f=>{f.statuses['/branches/main/protection']=404;},
  malformed:f=>{delete f.data['/branches/main/protection'].required_status_checks;}, rulesDenied:f=>{f.statuses['/rules/branches/main?per_page=100']=403;},
  unsupported:f=>{f.data['/rules/branches/main?per_page=100']=[{...f.rule,type:'workflows'}];},
  ruleParameters:f=>{f.rule.parameters.future_semantics=true;f.data['/rules/branches/main?per_page=100']=[f.rule];}
})) test(`policy fails closed: ${name}`,async()=>assert.equal((await native(ciFixture(mutate))).qualifies,false));

for (const [status,conclusion,wanted] of [
  ['queued',null,'pending'],['in_progress',null,'pending'],['completed','failure','failed'],
  ['completed','cancelled','failed'],['completed','stale','stale'],['completed','timed_out','failed'],['completed','action_required','failed'],
  ['completed','neutral','satisfied'],['completed','skipped','satisfied'],['completed','unexpected','unknown']
]) test(`native check ${status}/${conclusion}`,async()=>{
  const f=ciFixture(f=>Object.assign(f.check,{status,conclusion}));
  assert.equal((await native(f)).status,wanted);
  if (['neutral','skipped'].includes(conclusion)) {
    const r=await verify(f); assert.equal(r.qualifies,false);
    assert.equal(r.evaluations[0].evidence[0].conclusion,conclusion);
    assert.equal(r.evaluations[0].status,'satisfied');
  }
});

test('wrong App, old head, missing checks and competing sources cannot go green',async()=>{
  for (const mutate of [f=>{f.check.app.id='8';}, f=>{f.check.head_sha='c'.repeat(40);},
    f=>{f.data[checkPath(f)]={total_count:0,check_runs:[]};},
    f=>{f.data['/branches/main/protection'].required_status_checks.checks[0].app_id=null;
      f.data[checkPath(f)].check_runs.push({...f.check,id:'42',app:{id:'8'}});f.data[checkPath(f)].total_count++;}])
    assert.equal((await native(ciFixture(mutate))).qualifies,false);
});

for (const status of ['success','pending','failure','error']) test(`commit status native latest ${status}`,async()=>{
  const f=ciFixture(f=>{
    f.data['/branches/main/protection'].required_status_checks.checks=[];
    f.data[checkPath(f)]={total_count:0,check_runs:[]};
    f.data[statusPath(f)]=[{id:'72',context:'build',state:status,created_at:'2026-01-02T00:00:00Z'},
      {id:'71',context:'build',state:'failure',created_at:'2026-01-01T00:00:00Z'}];
  });
  assert.equal((await native(f)).status,status==='success'?'satisfied':status==='pending'?'pending':'failed');
});

test('check and status collisions require both native obligations; pinned App cannot use a status',async()=>{
  const f=ciFixture(f=>{f.data['/branches/main/protection'].required_status_checks.checks[0].app_id=null;
    f.data[statusPath(f)]=[{id:'71',context:'build',state:'failure',created_at:'2026-01-01T00:00:00Z'}];});
  assert.equal((await native(f)).status,'failed');
  const pinned=ciFixture(f=>{f.check.app.id='9';f.data[statusPath(f)]=[{id:'71',context:'build',state:'success',created_at:'2026-01-01T00:00:00Z'}];});
  assert.equal((await native(pinned)).qualifies,false);
});

for (const [name,mutate] of Object.entries({
  path:f=>{f.run.path='.github/workflows/other.yml';}, content:f=>{f.data[`/contents/${f.pin.path}?ref=${f.pin.revision}`].content='YmFk';},
  repository:f=>{f.run.repository.id='8';}, headRepository:f=>{f.run.head_repository.id='8';}, event:f=>{f.run.event='pull_request';},
  head:f=>{f.run.head_sha='c'.repeat(40);}, run:f=>{f.run.id='32';}, jobRun:f=>{f.job.run_id='32';},
  jobHead:f=>{f.job.head_sha='c'.repeat(40);}, check:f=>{f.job.check_run_url=f.job.check_run_url.replace('/41','/42');},
  checkRepository:f=>{f.job.check_run_url=f.job.check_run_url.replace('example-org','wrong');},
  attempt:f=>{f.run.run_attempt=2;}, jobAttempt:f=>{f.job.run_attempt=2;},
  bytes:f=>{delete f.data[`/contents/${f.pin.path}?ref=${f.pin.revision}`].content;},
  jobsDenied:f=>{f.statuses['/actions/runs/31/attempts/1/jobs?per_page=100']=403;},
  runsDenied:f=>{f.statuses['/actions/runs/31']=403;}
})) test(`pinned Actions rejects ${name}`,async()=>assert.equal((await verify(ciFixture(mutate))).qualifies,false));

test('successful rerun uses only its current attempt; incomplete/failed attempts never inherit success',async()=>{
  for (const outcome of ['success','failure',null]) {
    const f=ciFixture(f=>{
      f.pin.attempt=2;f.run.run_attempt=2;
      f.data[`/actions/workflows/ci.yml/runs?head_sha=${f.expected.head}&per_page=100`].workflow_runs[0].run_attempt=2;
      const jobs=structuredClone(f.data['/actions/runs/31/attempts/1/jobs?per_page=100']);
      Object.assign(jobs.jobs[0],{id:'52',conclusion:outcome,status:outcome?'completed':'in_progress'});
      f.data['/actions/runs/31/attempts/2/jobs?per_page=100']=jobs;
    });
    assert.equal((await verify(f)).qualifies,outcome==='success');
    assert.equal(f.counts['/actions/runs/31/attempts/1/jobs?per_page=100'],undefined);
    assert.equal(f.counts['/actions/runs/31/attempts/2/jobs?per_page=100'],1);
  }
});

for (const collection of ['checks','statuses','rules','runs','jobs']) test(`complete pagination includes later ${collection} evidence`,async()=>{
  const f=ciFixture(f=>{
    const [path,envelope]=collection==='checks'?[checkPath(f),'check_runs']:collection==='statuses'?[statusPath(f),null]:
      collection==='rules'?['/rules/branches/main?per_page=100',null]:collection==='runs'?
      [`/actions/workflows/ci.yml/runs?head_sha=${f.expected.head}&per_page=100`,'workflow_runs']:['/actions/runs/31/attempts/1/jobs?per_page=100','jobs'];
    const second=path+'&page=2';
    f.links[path]=`<https://api.github.com/repos/${f.expected.repository}${second}>; rel="next"`;
    const late=collection==='checks'?{...f.check,id:'42',app:{id:'9'}}:collection==='statuses'?
      {id:'71',context:'build',state:'failure',created_at:'2026-01-01T00:00:00Z'}:collection==='rules'?
      {...f.rule,parameters:{...f.rule.parameters,required_status_checks:[{context:'absent',integration_id:'15368'}]}}:
      collection==='runs'?{...f.run}:{...f.job,id:'52'};
    if (collection==='checks'||collection==='statuses') f.data['/branches/main/protection'].required_status_checks.checks[0].app_id=null;
    f.data[second]=envelope?{total_count:2,[envelope]:[late]}:[late];
    if(envelope) f.data[path].total_count=2;
  });
  assert.equal((await verify(f)).qualifies,false);
  assert.ok(f.calls.some(c=>c.endpoint.endsWith('page=2')));
});

for (const mode of ['denied','loop','bad-link','cross-path','limit','total']) test(`partial reads: ${mode}`,async()=>{
  const f=ciFixture(f=>{
    const path=checkPath(f), next=path+'&page=2';
    f.links[path]=mode==='bad-link'?'secret-invalid-link':`<https://api.github.com/repos/${f.expected.repository}${mode==='cross-path'?'/elsewhere':next}>; rel="next"`;
    f.data[path].total_count=2;f.data[next]={total_count:2,check_runs:[f.check]};
    if(mode==='denied')f.statuses[next]=403;
    if(mode==='loop')f.links[next]=f.links[path];
    if(mode==='total'){delete f.links[path];}
  });
  const r=await observeGithubCI({provider:f.provider,expected:f.expected,actions:[f.pin],maxPages:mode==='limit'?1:50});
  assert.equal(r.qualifies,false); assert.ok(!JSON.stringify(r).includes('secret-invalid-link'));
});

for(const change of ['head','base','policy','attempt']) test(`refresh invalidates ${change}`,async()=>{
  const f=ciFixture(f=>{f.reply=(path,count)=>{
    let changed;
    if(change==='head'&&path==='/pulls/7'&&count===2){changed=structuredClone(f.data[path]);changed.head.sha='c'.repeat(40);}
    if(change==='base'&&path==='/branches/main'&&count===2){changed=structuredClone(f.data[path]);changed.commit.sha='c'.repeat(40);}
    if(change==='policy'&&path==='/branches/main/protection'&&count===2){changed=structuredClone(f.data[path]);changed.required_status_checks.strict=false;}
    if(change==='attempt'&&path==='/actions/runs/31'&&count===2){changed={...f.run,run_attempt:2};}
    return changed?{status:200,body:JSON.stringify(changed)}:null;
  };});
  const r=await verify(f);assert.equal(r.qualifies,false);assert.equal(r.status,'stale');
});

test('new invocation reads current state; malformed bodies and provider failures stay secret-free',async()=>{
  const f=ciFixture();assert.equal((await verify(f)).qualifies,true);
  f.check.conclusion='failure';assert.equal((await verify(f)).qualifies,false);
  const broken=ciFixture(f=>{f.reply=()=>({status:403,body:'private-secret-response'});});
  const r=await verify(broken);assert.equal(r.qualifies,false);assert.ok(!JSON.stringify(r).includes('private-secret'));
  const malformed=ciFixture(f=>{f.reply=()=>({status:200,body:'{broken-secret'});});
  assert.equal((await verify(malformed)).qualifies,false);
});

test('raw check output is excluded; malformed evidence and unsafe encoded paths fail closed',async()=>{
  const f=ciFixture(f=>{f.check.output={text:'raw-provider-secret'};});
  assert.ok(!JSON.stringify(await verify(f)).includes('raw-provider-secret'));
  for(const endpoint of ['/x%0a','/x%2f..%2fy','/x%2f%2fy','/x%252fy']) {
    const before=f.calls.length;
    assert.equal((await f.provider.request({endpoint,operation:'observe-ci',correlation:'ci',target:'42'})).outcome,'failed');
    assert.equal(f.calls.length,before);
  }
  for(const mutate of [f=>{f.check.status='invented';},f=>{f.data[statusPath(f)]=[{}];},
    f=>{f.rule.ruleset_id='bad';f.data['/rules/branches/main?per_page=100']=[f.rule];}])
    assert.equal((await native(ciFixture(mutate))).qualifies,false);
});

for (const collection of ['checks','statuses','rules','runs','jobs']) test(`successful multi-page ${collection} retains complete evidence`,async()=>{
  const f=ciFixture(f=>{
    const [path,envelope]=collection==='checks'?[checkPath(f),'check_runs']:collection==='statuses'?[statusPath(f),null]:
      collection==='rules'?['/rules/branches/main?per_page=100',null]:collection==='runs'?
      [`/actions/workflows/ci.yml/runs?head_sha=${f.expected.head}&per_page=100`,'workflow_runs']:['/actions/runs/31/attempts/1/jobs?per_page=100','jobs'];
    const second=path+'&page=2';
    f.links[path]=`<https://api.github.com/repos/${f.expected.repository}${second}>; rel="next"`;
    const late=collection==='checks'?{...f.check,id:'42',name:'unrelated'}:collection==='statuses'?
      {id:'71',context:'unrelated',state:'failure',created_at:'2026-01-01T00:00:00Z'}:collection==='rules'?
      {type:'pull_request',ruleset_id:'62',ruleset_source:'example-org',ruleset_source_type:'Organization'}:
      collection==='runs'?{...f.run,id:'32'}:{...f.job,id:'52',name:'unrelated'};
    f.data[second]=envelope?{total_count:2,[envelope]:[late]}:[late];
    if(envelope) f.data[path].total_count=2;
  });
  assert.equal((await verify(f)).qualifies,true);
  assert.ok(f.calls.some(c=>c.endpoint.endsWith('page=2')));
});

test('equivalent timestamp spellings cannot choose a green status arbitrarily',async()=>{
  const f=ciFixture(f=>{
    f.data['/branches/main/protection'].required_status_checks.checks[0].app_id=null;
    f.data[statusPath(f)]=[{id:'71',context:'build',state:'success',created_at:'2026-01-01T00:00:00Z'},
      {id:'72',context:'build',state:'failure',created_at:'2026-01-01T01:00:00+01:00'}];
  });
  assert.equal((await native(f)).status,'unknown');
});
