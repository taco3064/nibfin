import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {verifyDeployment, checkDeploymentHealth, deploymentHealthDisposition,
  readDeploymentObservation, createGithubProvider, createDeploymentFinal} from '@nibfin/core';

const clone = structuredClone;
const source = {repositoryId:'42',workflow:'.github/workflows/deploy.yml',runId:'7',attempt:'2'};
function fixture(url) {
  const checks = [{url,status:200,body:'ok'}];
  const policy = {mode:'required',reason:'Release obligation',repositoryId:'42',commit:'a'.repeat(40),version:'1',
    environment:'production',deploymentId:'3',statusId:'4',baseline:'b1',source,checks,maxAgeMs:100};
  const observation = {...policy,state:'success',observedAt:1000};
  return {policy,observation,health:{allowlist:[url],checks,timeoutMs:5000,maxBytes:32,maxRequests:1},now:()=>1100};
}
async function server(t) {
  let contacts = 0;
  const s = createServer((req,res) => {
    contacts++;
    if (req.url === '/slow') { setTimeout(() => res.end('ok'),200).unref(); return; }
    if (req.url === '/redirect') {res.writeHead(302,{location:'/secret'});res.end();return;}
    if (req.url === '/bad') {res.statusCode=503;res.end('private body');return;}
    res.end(req.url === '/big' ? 'x'.repeat(100) : req.url === '/wrong' ? 'private body' : 'ok');
  });
  s.listen(0,'127.0.0.1');await once(s,'listening');
  t.after(() => {s.closeAllConnections();s.close();});
  return {url:`http://127.0.0.1:${s.address().port}/ok`, contacts:()=>contacts};
}
test('public applicability, exact identities and freshness boundaries',async t => {
  const s=await server(t), f=fixture(s.url);
  const initial=await verifyDeployment(f);assert.equal(initial.status,'qualified',JSON.stringify(initial));
  assert.equal((await verifyDeployment({policy:{mode:'not-applicable',reason:'No deployment'}})).status,'not-applicable');
  for (const policy of [undefined,{}, {mode:'not-applicable'}, {...f.policy,mode:'not-applicable'}, {...f.policy,maxAgeMs:Infinity}]) {
    assert.equal((await verifyDeployment({...f,policy})).status,'blocked');
  }
  for (const key of ['repositoryId','commit','version','environment','deploymentId','statusId','baseline']) {
    for (const value of [undefined,'other']) {
      const x=clone(f.observation);x[key]=value;
      assert.equal((await verifyDeployment({...f,observation:x})).status,'blocked',key);
    }
  }
  for (const key of Object.keys(source)) {
    const x=clone(f.observation);x.source[key]='other';
    assert.equal((await verifyDeployment({...f,observation:x})).status,'blocked',key);
  }
  for (const state of ['failure','pending','unknown',undefined]) {
    assert.equal((await verifyDeployment({...f,observation:{...f.observation,state}})).status,'blocked');
  }
  for (const observation of [{state:'success'},{release:'1'},{...f.observation,observedAt:999},{...f.observation,observedAt:1101}]) {
    assert.equal((await verifyDeployment({...f,observation})).status,'blocked');
  }
  assert.equal((await verifyDeployment({...f,now:()=>1099})).status,'qualified');
  assert.equal((await verifyDeployment({...f,now:()=>1101})).status,'blocked');
  assert.equal((await verifyDeployment({...f,health:{...f.health,checks:[]}})).status,'blocked');
});
test('real bounded HTTP checks prevent forbidden contact and redact diagnostics',async t => {
  const s=await server(t),f=fixture(s.url),run=path => {
    const url=s.url.replace('/ok',path);
    return checkDeploymentHealth({...f.health,timeoutMs:path === '/slow' ? 100 : f.health.timeoutMs,checks:[{url,status:200,body:'ok'}],allowlist:[url]});
  };
  assert.equal((await run('/ok')).status,'healthy');
  for (const path of ['/bad','/wrong','/big','/slow','/redirect']) {
    const before=s.contacts();const r=await run(path);
    assert.equal(r.status,'blocked',path);
    assert.equal(s.contacts(),before+1);
    assert.doesNotMatch(JSON.stringify(r),/private|127\.0\.0\.1|secret|password/);
  }
  const before=s.contacts();
  for (const url of ['file:///etc/passwd','http://user:password@127.0.0.1/',s.url.replace('/ok','/secret')]) {
    assert.equal((await checkDeploymentHealth({...f.health,checks:[{url,status:200}]})).status,'blocked');
  }
  assert.equal(s.contacts(),before);
  for (const change of [{timeoutMs:Infinity},{maxBytes:0},{maxRequests:0},{checks:[...f.health.checks,...f.health.checks]}]) {
    assert.equal((await checkDeploymentHealth({...f.health,...change})).status,'blocked');
  }
  const dead=createServer();dead.listen(0,'127.0.0.1');await once(dead,'listening');
  const url=`http://127.0.0.1:${dead.address().port}/`;await new Promise(r=>dead.close(r));
  assert.equal((await checkDeploymentHealth({...f.health,allowlist:[url],checks:[{url,status:200}]})).status,'blocked');
});
test('GitHub read mapping requires all four exact read resources',async t => {
  const s=await server(t),f=fixture(s.url);
  const data=[{id:42},{id:3,sha:f.policy.commit,environment:'production',payload:{version:'1',baseline:'b1'}},
    {id:4,state:'success',environment:'production',log_url:'https://github.com/org/repo/actions/runs/7/attempts/2'},
    {id:7,run_attempt:2,repository:{id:42},head_sha:f.policy.commit,path:source.workflow,status:'completed',conclusion:'success'}];
  async function read(values,status=200) {
    const calls=[];
    const provider=createGithubProvider({attempts:1,transport:async req=>{
      calls.push(req);return {status,headers:{},body:JSON.stringify(values[calls.length-1])};}});
    const result=await readDeploymentObservation(provider,{repository:'org/repo',policy:f.policy,now:()=>1000});
    assert.ok(calls.every(c=>c.method==='GET'));
    return result;
  }
  const r=await read(data);assert.equal(r.status,'observed');
  assert.equal((await verifyDeployment({...f,observation:r.observation})).status,'qualified');
  for (let i=0;i<data.length;i++) {
    const bad=clone(data);bad[i]={};assert.equal((await read(bad)).status,'blocked');
  }
  for (const [i,key,value] of [[1,'sha','b'.repeat(40)],[1,'payload',{version:'2'}],[2,'log_url','other'],
    [3,'run_attempt',3],[3,'path','other'],[3,'conclusion','failure']]) {
    const bad=clone(data);bad[i][key]=value;assert.equal((await read(bad)).status,'blocked');
  }
  for (const status of [403,404,500]) assert.equal((await read(data,status)).status,'blocked');
});
function selector(environment='production',kind='environment') {
  return {kind,repositoryId:'42',environment,releaseLine:'stable',output:'core'};
}
test('latest scoped obligations and narrowly incident-bound repair',async t => {
  const s=await server(t),f=fixture(s.url);
  const b={id:'latest',selector:selector(),effectiveAt:1000,incident:'incident',policy:f.policy};
  const input={target:{issueId:'I1'},selectors:[selector()],baselines:[b],observations:[{...f.observation,state:'failure'}],health:{latest:f.health},now:f.now};
  assert.equal((await deploymentHealthDisposition(input)).status,'blocked');
  const unrelated={...b,id:'unrelated',selector:selector('staging')};
  assert.equal((await deploymentHealthDisposition({...input,baselines:[unrelated,b]})).status,'blocked');
  assert.equal((await deploymentHealthDisposition({...input,selectors:[selector('elsewhere')],baselines:[]})).status,'blocked');
  assert.equal((await deploymentHealthDisposition({...input,selectors:[]})).status,'eligible');
  const repair={classification:'implementation_defect',responsibleIssue:'I1',incident:'incident',unknownWrites:false,
    classifiedAt:1000,maxAgeMs:100,authorization:{issueId:'I1',incident:'incident',operation:'deliver-repair',grant:'fresh-grant',revoked:false,validFrom:1000,expiresAt:1200}};
  const result=await deploymentHealthDisposition({...input,repair});
  assert.equal(result.status,'repair-health-exception');assert.equal(result.permission,false);
  assert.equal(result.completion,'unqualified');assert.equal(result.otherGates,'required');
  for (const change of [{classification:'external_failure'},{responsibleIssue:'I2'},{incident:'other'},
    {unknownWrites:true},{classifiedAt:999},{authorization:undefined},
    {authorization:{...repair.authorization,expiresAt:1100}},{authorization:{...repair.authorization,revoked:true}},
    {authorization:{...repair.authorization,incident:'other'}}]) {
    assert.equal((await deploymentHealthDisposition({...input,repair:{...repair,...change}})).status,'blocked');
  }
  // Authorization/classification must still be current after asynchronous evaluation.
  const clock = values => { let i=0; return () => values[Math.min(i++,values.length-1)]; };
  for (const [times, change] of [
    [[1000,1200], {}], // Independent review reproduction: entry time is insufficient.
    [[1000,1000,1100], {maxAgeMs:500,authorization:{...repair.authorization,expiresAt:1100}}], // Authorization expires exactly at decision.
    [[1000,1000,1101], {authorization:{...repair.authorization,expiresAt:1500}}],
    [[1000,1000,1000,1200], {}], // Expiration after provisional bypass, before return.
    [[1000,1000,1000,1101], {authorization:{...repair.authorization,expiresAt:1500}}]
  ]) {
    const expired=await deploymentHealthDisposition({...input,repair:{...repair,...change},now:clock(times)});
    assert.equal(expired.status,'blocked');
    assert.deepEqual(expired.bypassed,[]);
    assert.ok(expired.blocked.some(x=>x.obligation==='latest'));
  }
  for (const invalid of [NaN,Infinity,1000.5,999]) {
    assert.equal((await deploymentHealthDisposition({...input,repair,now:clock([1000,1000,1000,invalid])})).status,'blocked');
  }
  assert.equal((await deploymentHealthDisposition({...input,repair,now:clock([1000,1000,1099])})).status,'repair-health-exception');
  assert.equal((await deploymentHealthDisposition({...input,repair:{...repair,authorization:{...repair.authorization,expiresAt:1200}},now:clock([1000,1000,1100])})).status,'repair-health-exception');
  // A later healthy obligation consumes time after the first incident was bypassed.
  const later={...b,id:'later',selector:selector('staging'),policy:{...f.policy,environment:'staging',baseline:'b2',maxAgeMs:500}};
  const laterResult=await deploymentHealthDisposition({...input,repair,selectors:[selector(),later.selector],
    baselines:[b,later],observations:[...input.observations,{...f.observation,environment:'staging',baseline:'b2'}],
    health:{latest:f.health,later:f.health},now:clock([1000,1000,1000,1000,1200,1200])});
  assert.equal(laterResult.status,'blocked');
  assert.deepEqual(laterResult.bypassed,[]);
  assert.deepEqual(laterResult.blocked,[{obligation:'latest',reason:'repair-freshness'}]);
  // Every required healthy observation must remain fresh at the aggregate decision.
  for (const [finalTime, expectedStatus] of [[1099,'eligible'],[1100,'eligible'],[1101,'blocked'],[1200,'blocked']]) {
    const disposition=await deploymentHealthDisposition({...input,observations:[f.observation],
      now:clock([1000,1000,1000,finalTime])});
    assert.equal(disposition.status,expectedStatus);
    assert.deepEqual(disposition.blocked,expectedStatus==='blocked' ? [{obligation:'latest',reason:'freshness'}] : []);
  }
  for (const kind of ['environment','dependency']) {
    const first={...b,selector:selector('production',kind)};
    const disposition=await deploymentHealthDisposition({...input,selectors:[first.selector,later.selector],
      baselines:[first,later],observations:[f.observation,{...f.observation,environment:'staging',baseline:'b2'}],
      health:{latest:f.health,later:f.health},now:clock([1000,1000,1000,1000,1200,1200])});
    assert.equal(disposition.status,'blocked');
    assert.deepEqual(disposition.selected,['latest','later']);
    assert.deepEqual(disposition.blocked,[{obligation:'latest',reason:'freshness'}]);
    assert.deepEqual(disposition.bypassed,[]);
  }
  // A still-valid repair exception cannot mask another proof expiring before return.
  const shortLater={...later,policy:{...later.policy,maxAgeMs:100}};
  const mixed=await deploymentHealthDisposition({...input,repair:{...repair,maxAgeMs:500,
    authorization:{...repair.authorization,expiresAt:1500}},selectors:[selector(),later.selector],
    baselines:[b,shortLater],observations:[...input.observations,{...f.observation,environment:'staging',baseline:'b2'}],
    health:{latest:f.health,later:f.health},now:clock([1000,1000,1000,1000,1000,1200])});
  assert.equal(mixed.status,'blocked');
  assert.deepEqual(mixed.blocked,[{obligation:'later',reason:'freshness'}]);
  assert.deepEqual(mixed.bypassed,['latest']);
  const dependency={...b,id:'dep',selector:selector('production','dependency'),incident:'incident'};
  assert.equal((await deploymentHealthDisposition({...input,repair,selectors:[selector(),dependency.selector],baselines:[b,dependency]})).status,'blocked');
  for (const baselines of [[],[{...b,effectiveAt:1101}],[b,{...b,id:'duplicate'}]]) {
    assert.equal((await deploymentHealthDisposition({...input,baselines})).status,'blocked');
  }
  const old={...b,id:'old',effectiveAt:900,policy:{...f.policy,baseline:'old'}};
  const healthy={...f.observation,baseline:'old'};
  assert.equal((await deploymentHealthDisposition({...input,baselines:[old,b],observations:[healthy,...input.observations]})).status,'blocked');
  assert.equal((await deploymentHealthDisposition({...input,observations:[f.observation]})).status,'eligible');
  assert.equal((await deploymentHealthDisposition({...input,observations:[{...f.observation,version:'2'}]})).status,'blocked');
});
test('qualified proof reaches final evidence and is invalidated by current inputs',async t => {
  const s=await server(t),f=fixture(s.url),q=await verifyDeployment(f),h='a'.repeat(64);
  const expected={version:1,stage:'final',binding:{authority:h,grant:h,policy:h,core:h,runtime:h,instructions:h,
    repositoryId:'42',issueId:'I1',scopeHash:h,shapeHash:h},
    execution:{role:'deliver',skill:'deliver',id:'final',request:'r',result:'result',source:null},
    inputs:{merge:h,commit:f.policy.commit,postMerge:{mode:'not-applicable',identities:[],reason:'None'},deployment:q.proof},result:null};
  const current={expected,consumed:[]};
  assert.deepEqual(await createDeploymentFinal(current,q,f),expected);
  await assert.rejects(createDeploymentFinal(current,clone(q),f));
  for (const change of [{policy:{...f.policy,version:'2'}},{policy:{...f.policy,baseline:'b2'}},
    {policy:{...f.policy,commit:'b'.repeat(40)}},{observation:{...f.observation,state:'failure'}},
    {observation:{...f.observation,state:'pending'}},{observation:null},{now:()=>1101}]) {
    await assert.rejects(createDeploymentFinal(current,q,{...f,...change}));
  }
  await assert.rejects(createDeploymentFinal(current,{status:'repair-health-exception'},f));
  const repaired={...f,policy:{...f.policy,commit:'b'.repeat(40)},observation:{...f.observation,commit:'b'.repeat(40)}};
  const fresh=await verifyDeployment(repaired);
  assert.equal(fresh.status,'qualified');
  const next=clone(current);next.expected.inputs.commit=repaired.policy.commit;next.expected.inputs.deployment=fresh.proof;
  assert.equal((await createDeploymentFinal(next,fresh,repaired)).stage,'final');
});
