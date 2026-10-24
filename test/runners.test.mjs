import test from 'node:test';
import assert from 'node:assert/strict';
import {createGithubProvider, observeRunners} from '../src/index.mjs';

// Official REST shapes: self-hosted-runners and self-hosted-runner-groups,
// API 2026-03-10. No credentials, host or live-provider certification.
const repoPath = '/repos/example/core';
const orgPath = '/orgs/example';
const target = {owner:'example',repository:'core',id:'9007199254740993',ownerId:'7',ownerType:'Organization'};
const registration = {level:'repository',id:target.id};
const makeRunner = (id = '21', member = '8', patch = {}) => ({id, name:'runner-'+id, os:'linux',status:'online',busy:false,
  labels:['self-hosted','Linux','X64','nibfin-user-'+member].map((name,i) => ({id:String(i+1),name,type:i===3?'custom':'read-only'})),...patch});
const record = (runnerId = '21', memberId = '8') => ({instanceId:'local-'+runnerId,runnerId,memberId,repositoryId:target.id,
  registration,platform:'linux',secret:'LOCAL_SECRET_SENTINEL'});
const input = () => ({target,registration,records:[record()],conditions:{platform:'linux',labels:['SELF-hosted','linux','X64']},correlation:'fixture'});
const page = (envelope, values, total = values.length) => ({total_count:total,[envelope]:values});
const response = (data, headers = {}) => ({status:200,headers,body:JSON.stringify(data)});
const next = path => ({link:`<https://api.github.com${path}?per_page=100&page=2>; rel="next"`});
function fixture(overrides = {}, config = {}) {
  const routes = {
    [repoPath]:{id:target.id,full_name:'Example/Core',private:false,visibility:'public',owner:{id:'7',type:'Organization'}},
    [repoPath+'/actions/runners?per_page=100']:page('runners',[makeRunner()]),...overrides};
  const calls = [];
  const provider = createGithubProvider({attempts:1,...config,transport:async request => {
    calls.push(request.endpoint); assert.equal(request.method,'GET');
    assert.equal(request.body, undefined);
    assert.ok(!/token|dispatch|registration-token/.test(request.endpoint));
    if (!Object.hasOwn(routes,request.endpoint)) throw Error('unexpected endpoint');
    const data = routes[request.endpoint];
    return typeof data === 'function' ? data(request) : data?.status ? data : response(data);
  }});
  return {provider,calls};
}
const run = (options = input(), routes = {}, config = {}) => observeRunners(fixture(routes,config).provider, options);
const codes = result => JSON.stringify(result.diagnostics);

test('public individual/organization repository runners use only repository endpoints and exact IDs', async () => {
  for (const ownerType of ['User','Organization']) {
    const options = input(); options.target = {...target,ownerType};
    const f = fixture({[repoPath]:{id:target.id,full_name:'example/core',private:false,visibility:'public',owner:{id:'7',type:ownerType}}});
    // Exercise a literal numeric ID beyond Number safe precision through provider JSON parsing.
    const original = f.provider;
    const result = await observeRunners(original,options);
    assert.equal(result.outcome,'matched');
    assert.deepEqual(f.calls,[repoPath,repoPath+'/actions/runners?per_page=100']);
  }
  const f = fixture({[repoPath]:{status:200,headers:{},body:'{"id":9007199254740993,"full_name":"example/core","private":false,"visibility":"public","owner":{"id":7,"type":"Organization"}}'}});
  assert.equal((await observeRunners(f.provider,input())).outcome,'matched');
  for (const patch of [{id:'9'},{owner:{id:'9',type:'Organization'}},{full_name:'elsewhere/core'},
    {private:true,visibility:'private'}]) {
    const base = {id:target.id,full_name:'example/core',private:false,visibility:'public',owner:{id:'7',type:'Organization'}};
    assert.notEqual((await run(input(),{[repoPath]:{...base,...patch}})).outcome,'matched');
  }
  for (const id of ['01',1,'1e3','0']) {
    const options = input(); options.target = {...target,id};
    assert.notEqual((await run(options)).outcome,'matched');
  }
  const options = input(); options.registration = {level:'repository',id:'9'};
  assert.match(codes(await run(options)),/registration_scope/);
});

test('multiple trusted instances reconcile independently; no binding mutation or replacement by name/Label', async () => {
  const options = input(); options.records = [record(),record('22'),record('23','9')];
  const before = structuredClone(options);
  const result = await run(options,{[repoPath+'/actions/runners?per_page=100']:page('runners',[makeRunner(),makeRunner('22'),makeRunner('23','9')])});
  assert.equal(result.outcome,'matched'); assert.equal(result.instances.length,3); assert.deepEqual(options,before);
  const replacement = await run(input(),{[repoPath+'/actions/runners?per_page=100']:page('runners',[makeRunner('99','8',{name:'runner-21'})])});
  assert.equal(replacement.instances[0].observation,undefined);
  assert.match(JSON.stringify(replacement),/missing_or_replaced_id/);
  assert.match(codes(replacement),/unrecognized_member_registration/);
  for (const mutate of [o=>o.records.push(record()),o=>delete o.records[0].runnerId,
    o=>o.records[0].registration={level:'organization',id:'7'},o=>o.records[0].repositoryId='99']) {
    const options = structuredClone(input()); mutate(options);
    assert.notEqual((await run(options)).outcome,'matched');
  }
  for (const labels of [[{name:'nibfin-user-9',type:'custom'}],
    [...makeRunner().labels,{name:'nibfin-user-9',type:'custom'}]]) {
    const result = await run(input(),{[repoPath+'/actions/runners?per_page=100']:page('runners',[makeRunner('21','8',{labels})])});
    assert.match(JSON.stringify(result),/member_label/);
  }
});

test('all Label/platform conditions apply together and online/busy/offline remain separate', async () => {
  for (const platform of ['linux','windows','macos']) {
    for (const [status,busy] of [['online',false],['online',true],['offline',false]]) {
      const options = structuredClone(input()); options.conditions.platform=platform; options.conditions.labels=['X64','self-hosted',platform];
      options.records[0].platform=platform;
      const remote = makeRunner('21','8',{os:platform,status,busy}); remote.labels[1].name=platform;
      const result = await run(options,{[repoPath+'/actions/runners?per_page=100']:page('runners',[remote])});
      assert.equal(result.outcome,'matched');
      assert.equal(result.instances[0].observation.status,status); assert.equal(result.instances[0].observation.busy,busy);
    }
  }
  for (const patch of [{os:'windows'},{labels:makeRunner().labels.filter(l=>l.name!=='X64')},
    {labels:[...makeRunner().labels,{name:'Windows',type:'read-only'}]}]) {
    assert.equal((await run(input(),{[repoPath+'/actions/runners?per_page=100']:page('runners',[makeRunner('21','8',patch)])})).outcome,'mismatch');
  }
  for (const patch of [{os:'unknown'},{busy:'false'},{busy:undefined},{status:'idle'},{labels:undefined},{name:undefined}]) {
    const result = await run(input(),{[repoPath+'/actions/runners?per_page=100']:page('runners',[makeRunner('21','8',patch)])});
    assert.equal(result.outcome,'unavailable'); assert.equal(result.instances,undefined);
  }
});

function orgFixture(patch = {}, overrides = {}) {
  const options = structuredClone(input()); options.registration={level:'organization',organization:'example',id:'7'};
  options.records[0].registration=options.registration; options.conditions.groupId='3';
  const prefix = orgPath+'/actions';
  const group = {id:'3',name:'build',visibility:'selected',allows_public_repositories:true,
    restricted_to_workflows:false,selected_workflows:[],...patch};
  const routes = {[orgPath]:{id:'7',login:'example',type:'Organization'},
    [prefix+'/runners?per_page=100']:page('runners',[makeRunner()]),
    [prefix+'/runner-groups?per_page=100']:page('runner_groups',[group]),
    [prefix+'/runner-groups/3/runners?per_page=100']:page('runners',[makeRunner()]),
    [prefix+'/runner-groups/3/repositories?per_page=100']:page('repositories',[{id:target.id,full_name:'example/core',private:false}]),...overrides};
  return {options,routes,prefix};
}
test('local organization scope requires a valid matching coordinate independently of stable ID', async () => {
  for (const organization of ['example', 'EXAMPLE', 'different-org', undefined, '', 'bad/org', null]) {
    const {options,routes} = orgFixture();
    // Keep request and local state independent so changing the record cannot alter the request.
    options.records[0].registration = {...options.registration};
    if (organization === undefined) delete options.records[0].registration.organization;
    else options.records[0].registration.organization = organization;
    const before = structuredClone(options);
    const f = fixture(routes);
    const result = await observeRunners(f.provider, options);
    if (organization === 'example' || organization === 'EXAMPLE') {
      assert.equal(result.outcome, 'matched');
      assert.equal(result.instances[0].outcome, 'matched');
    } else {
      assert.equal(result.outcome, 'mismatch');
      assert.match(codes(result), /record_scope/);
      assert.equal(result.instances, undefined);
      assert.deepEqual(f.calls, []);
    }
    assert.deepEqual(options, before);
  }
});

test('organization groups require actual target access, membership and applicable workflow context', async () => {
  for (const [patch,expected] of [[{},'matched'],[{visibility:'all'},'matched'],[{visibility:'private'},'group_access'],
    [{allows_public_repositories:false},'group_access'],[{restricted_to_workflows:true},'workflow_unresolved']]) {
    const {options,routes} = orgFixture(patch); const result = await run(options,routes);
    if(expected==='matched') assert.equal(result.outcome,expected); else assert.match(JSON.stringify(result),new RegExp(expected));
  }
  const workflow='example/core/.github/workflows/build.yml@refs/heads/main';
  for (const allowed of [true,false]) {
    const {options,routes} = orgFixture({restricted_to_workflows:true,selected_workflows:allowed?[workflow]:[]});
    options.conditions.workflow=workflow;
    const result=await run(options,routes); assert.equal(result.outcome,allowed?'matched':'mismatch');
  }
  const {options,routes,prefix}=orgFixture();
  options.conditions.groupId='4'; assert.match(JSON.stringify(await run(options,routes)),/group_membership/);
  options.conditions.groupId='3';
  routes[prefix+'/runner-groups/3/repositories?per_page=100']=page('repositories',[]);
  assert.match(JSON.stringify(await run(options,routes)),/group_access/);
  routes[prefix+'/runner-groups/3/runners?per_page=100']=page('runners',[]);
  assert.equal((await run(options,routes)).outcome,'unavailable');
  for (const patch of [{allows_public_repositories:undefined},{restricted_to_workflows:'false'},{selected_workflows:null},{visibility:'unknown'}]) {
    const {options,routes}=orgFixture(patch); assert.equal((await run(options,routes)).outcome,'unavailable');
  }
  const bad=orgFixture(); bad.routes[orgPath]={id:'99',login:'example',type:'Organization'};
  assert.equal((await run(bad.options,bad.routes)).outcome,'unavailable');
});

test('all organization inventories paginate and a late conflicting or denied page prevents success', async () => {
  const {options,routes,prefix}=orgFixture();
  for (const [path,envelope,values] of [[prefix+'/runners','runners',[makeRunner()]],
    [prefix+'/runner-groups','runner_groups',routes[prefix+'/runner-groups?per_page=100'].runner_groups],
    [prefix+'/runner-groups/3/runners','runners',[makeRunner()]],
    [prefix+'/runner-groups/3/repositories','repositories',[{id:target.id,full_name:'example/core',private:false}]]]) {
    // Use an irrelevant first page, decisive record on the next page.
    const first = envelope==='runners' ? [makeRunner('99','99')] : envelope==='runner_groups'
      ? [{id:'4',name:'empty',visibility:'all',allows_public_repositories:true,restricted_to_workflows:false,selected_workflows:[]}]
      : [{id:'99',full_name:'example/other',private:false}];
    routes[path+'?per_page=100']=response(page(envelope,first,2),next(path));
    routes[path+'?per_page=100&page=2']=page(envelope,values,2);
  }
  routes[prefix+'/runner-groups/4/runners?per_page=100']=page('runners',[]);
  // 99 occurs in group 3 and global inventory, so correspondence remains complete.
  assert.equal((await run(options,routes)).outcome,'matched');
  routes[prefix+'/runner-groups/3/repositories?per_page=100&page=2']={status:403,headers:{},body:'PRIVATE_RESPONSE_SENTINEL'};
  const result=await run(options,routes); assert.equal(result.outcome,'unavailable'); assert.equal(result.instances,undefined);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_RESPONSE_SENTINEL'));
});

test('complete empty inventory differs from missing evidence; late unknown member registration is diagnosed', async () => {
  const path=repoPath+'/actions/runners';
  const empty=await run(input(),{[path+'?per_page=100']:page('runners',[])});
  assert.equal(empty.inventory,'complete'); assert.match(JSON.stringify(empty),/missing_or_replaced_id/);
  const result=await run(input(),{[path+'?per_page=100']:response(page('runners',[makeRunner()],2),next(path)),
    [path+'?per_page=100&page=2']:page('runners',[makeRunner('99')],2)});
  assert.equal(result.outcome,'mismatch'); assert.match(codes(result),/unrecognized_member_registration/);
});

test('later-page errors preserve provider categories, expose no partial successes or secrets', async () => {
  const path=repoPath+'/actions/runners';
  for (const [status,kind,headers] of [[401,'authentication',{}],[403,'denied',{}],[404,'not_found_or_inaccessible',{}],
    [429,'rate_limited',{}],[500,'server',{}]]) {
    const result=await run(input(),{[path+'?per_page=100']:response(page('runners',[makeRunner()],2),next(path)),
      [path+'?per_page=100&page=2']:{status,headers,body:'PRIVATE_RESPONSE_SENTINEL token=SECRET'}});
    assert.equal(result.outcome,'unavailable'); assert.equal(result.instances,undefined); assert.match(codes(result),new RegExp(kind));
    assert.ok(!JSON.stringify(result).includes('SENTINEL')); assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
});

test('reject malformed, cross-collection, unsafe, cyclic, duplicate and exhausted pagination', async () => {
  const path=repoPath+'/actions/runners';
  const endpoint=path+'?per_page=100';
  for (const link of ['<https://evil.invalid'+path+'?page=2>; rel="next"',
    '<https://api.github.com/repos/other/core/actions/runners?page=2>; rel="next"',
    '<https://api.github.com'+path+'?page=2&secret=x>; rel="next"','broken',
    '<https://api.github.com'+path+'?page=2#fragment>; rel="next"']) {
    const result=await run(input(),{[endpoint]:response(page('runners',[makeRunner()],2),{link})});
    assert.equal(result.outcome,'unavailable');
  }
  const second=path+'?per_page=100&page=2';
  for (const data of [page('runners',[makeRunner()],2),page('runners',[makeRunner('22')],3),{runners:[]},page('runners',[{}],2)]) {
    assert.equal((await run(input(),{[endpoint]:response(page('runners',[makeRunner()],2),next(path)),[second]:data})).outcome,'unavailable');
  }
  const options=input(); options.maxPages=1;
  assert.match(codes(await run(options,{[endpoint]:response(page('runners',[makeRunner()],2),next(path))})),/pagination_limit/);
  const result=await run(input(),{[endpoint]:response(page('runners',[makeRunner()],3),next(path)),
    [second]:response(page('runners',[makeRunner('22')],3),next(path))});
  assert.match(codes(result),/pagination_cycle/);
});

test('cancellation and timeout propagate without assumed offline or cache reuse', async () => {
  const path=repoPath+'/actions/runners?per_page=100';
  const controller=new AbortController(); controller.abort();
  const options=input(); options.signal=controller.signal;
  assert.match(codes(await run(options)),/cancelled/);
  const keepAlive=setInterval(()=>{},1000);
  let result;
  try { result=await run(input(),{[path]:()=>new Promise(()=>{})},{elapsedMs:10}); }
  finally { clearInterval(keepAlive); }
  assert.equal(result.outcome,'unavailable'); assert.match(codes(result),/timeout/);
  assert.equal(result.runners,undefined);
});
