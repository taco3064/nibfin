import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {publishPortfolio, createGithubProvider, openPublicationJournal, contentIdentity} from '../src/index.mjs';

// Simulated remote effects only. Shapes follow the official REST Issue and
// dependency responses; these tests never contact GitHub or prove live edges.
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'publisher-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const directory = join(root, 'journal');
  const repos = [{repository:'person/a', repositoryId:'10'}, {repository:'org/b', repositoryId:'20'}];
  const scope = body => ({body, identity:contentIdentity(body)});
  const make = (key, target, body) => ({correlation:key, kind:'issue', target,
    payload:{key, scope:scope(body), request:{title:key, body, labels:['scope'], milestone:null},
      creation:{creatorId:'7', notBefore:'2026-10-25T00:00:00Z', notAfter:'2026-10-25T01:00:00Z'}}});
  const manifest = {version:1, approval:'approval-1', plan:{approved:'exact portfolio'}, operations:[
    make('a', repos[0], 'Raw\n世界\n'), make('b', repos[1], 'B\n'),
    {correlation:'edge', kind:'dependency', target:repos[1], payload:{blocked:'b', blocking:'a'}}]};
  let approved = contentIdentity(manifest), writes = [], calls = [], issues = new Map(), edges = false;
  const state = {allow:true, disclosure:true, protected:{frozen:false,authorized:false,shaped:false,active:false,delivered:false,closed:false},
    lost:null, before:null, after:null, drift:null, oneSided:false, incomplete:false, page:false, approvalCalls:0};
  const response = (data, status = 200, headers = {}) => ({status, body:JSON.stringify(data), headers});
  function issue(op, n) {
    const {request:r} = op.payload;
    return {id:String(100 + n),node_id:`I_${n}`,number:n,repository_url:`https://api.github.com/repos/${op.target.repository}`,
      url:`https://api.github.com/repos/${op.target.repository}/issues/${n}`,title:r.title,body:r.body,labels:r.labels.map(name=>({name})),
      milestone:null,state:'open',assignees:[{id:'8',login:'member'}],user:{id:'7'},created_at:'2026-10-25T00:10:00Z'};
  }
  const transport = async r => {
    calls.push(r);
    if (r.method !== 'GET') {
      // Inspect on-disk records, independently of journal return values.
      const records = fs.readdirSync(directory).filter(n=>/^\d+\.json$/.test(n)).sort().map(n=>JSON.parse(fs.readFileSync(join(directory,n))));
      assert.equal(records.at(-1).event.type, 'submission');
      const derived = records.at(-1).event.derivation;
      assert.deepEqual({method:derived.method,endpoint:derived.endpoint,body:derived.body},
        {method:r.method,endpoint:r.endpoint,body:JSON.parse(r.body)});
      if (r.endpoint.includes('/dependencies/')) assert.deepEqual(derived.endpoints.map(e=>e.issue.id), ['102','101']);
      assert.equal(records.at(-1).event.correlation, r.endpoint.includes('dependencies') ? 'edge' : r.endpoint.includes('person') ? 'a' : 'b');
      assert.ok(records.some(e=>e.event.type==='intent' && e.event.correlation===records.at(-1).event.correlation));
      if (r.method === 'PATCH') assert.deepEqual(derived.assignees, issues.get('a').assignees.map(a=>a.id));
      state.before?.(r);
      writes.push(r);
      if (r.endpoint.includes('dependencies')) {
        assert.equal(r.endpoint, '/repos/org/b/issues/2/dependencies/blocked_by');
        assert.deepEqual(JSON.parse(r.body), {issue_id:101}); edges = true;
      } else {
        const op = manifest.operations.find(o=>o.kind!=='dependency' && r.endpoint.startsWith(`/repos/${o.target.repository}/issues`));
        if (r.method === 'POST') issues.set(op.payload.key, issue(op, op.target.repository===repos[0].repository?1:2));
        else {
          const i = issues.get(op.payload.key), body = JSON.parse(r.body);
          Object.assign(i, {...body, labels:body.labels.map(name=>({name})), milestone:null});
        }
      }
      state.after?.(r);
      if (state.lost === (r.endpoint.includes('dependencies') ? 'edge' : r.endpoint.includes('person') ? 'a' : 'b')) throw Error('SECRET-private-error');
      return response({}, 201); // acknowledgment intentionally contains no identity proof
    }
    const repo = repos.find(o=>r.endpoint.startsWith(`/repos/${o.repository}`));
    assert.ok(repo, r.endpoint);
    const suffix = r.endpoint.slice(`/repos/${repo.repository}`.length);
    if (!suffix) return response({id:repo.repositoryId, full_name:repo.repository, private:false, visibility:'public', owner:{type:repo===repos[0]?'User':'Organization'}, ...state.drift?.('repo', repo)});
    const values = [...issues.values()].filter(i=>i.repository_url.endsWith(repo.repository));
    if (suffix.startsWith('/issues?')) {
      const headers = state.incomplete ? {link:'<https://api.github.com/wrong>; rel="next"'} : {};
      if(state.listLink) headers.link=state.listLink;
      return response(state.drift?.('list', values) ?? values, 200, headers);
    }
    if (suffix.includes('/dependencies/')) {
      if (state.incomplete) return response([], 200, {link:`<https://api.github.com${r.endpoint}>; rel="next"`});
      const reverse = suffix.includes('/blocking');
      const data = edges && !(reverse && state.oneSided) ? [issues.get(manifest.operations[reverse?1:0].payload.key)] : [];
      if (state.page && !suffix.includes('page=2')) return response([],200,{link:`<https://api.github.com${r.endpoint}&page=2>; rel="next"`});
      return response(state.drift?.('edge', data) ?? data);
    }
    const i = values.find(v=>suffix===`/issues/${v.number}`);
    return i ? response({...i,...state.drift?.('issue', i)}) : response({},404);
  };
  const provider = createGithubProvider({transport, authorize:async()=>state.allow, attempts:1});
  const options = {provider, manifest, directory, authorize:async({manifest:m})=>{
    state.approvalCalls++; return state.allow && contentIdentity(m)===approved;
  }, protection:async()=>state.protected, disclose:async()=>state.disclosure};
  return {manifest, state, writes, calls, issues, issue, directory, repos, options,
    approve:()=>{approved=contentIdentity(manifest);}, run:(initialize=true)=>publishPortfolio({...options,initialize})};
}

test('exact cross-repository requests, reciprocal pagination, raw provenance and fresh recovery', async t=>{
  const f=fixture(t); f.state.page=true;
  const result=await f.run(); assert.equal(result.outcome,'verified');
  assert.deepEqual(f.writes.slice(0,2).map(r=>JSON.parse(r.body)), f.manifest.operations.slice(0,2).map(o=>o.payload.request));
  assert.equal(result.handoff.mappings.a.scope.body,'Raw\n世界\n');
  assert.equal(result.handoff.mappings.a.issue.id,'101');
  assert.equal(result.handoff.mappings.b.issue.nodeId,'I_2');
  assert.equal(result.handoff.edges[0].blockedIssueId,'102');
  assert.ok(result.handoff.observations.some(o=>o.path.includes('/blocking')));
  assert.ok(f.calls.some(r=>r.endpoint.includes('page=2')));
  assert.equal((await f.run(false)).outcome,'verified'); assert.equal(f.writes.length,3);
  f.state.allow=false; assert.equal((await f.run(false)).outcome,'unresolved');
  assert.equal(f.writes.length,3);
});

for (const mutation of ['approval','repository','private','assignment','unsupported','provenance','disclosure','missing-capability']) {
  test(`reject ${mutation} before affected writes`,async t=>{
    const f=fixture(t);
    if(mutation==='approval') f.manifest.plan.changed=true;
    if(mutation==='repository') f.state.drift=(type)=>type==='repo'?{id:'999'}:undefined;
    if(mutation==='private') f.state.drift=(type)=>type==='repo'?{private:true,visibility:'private'}:undefined;
    if(mutation==='assignment') {f.manifest.operations[0].payload.request.assignees=['intruder'];f.approve();}
    if(mutation==='unsupported') {f.manifest.operations[0].payload.request.state='closed';f.approve();}
    if(mutation==='provenance') {delete f.manifest.operations[0].payload.scope.identity;f.approve();}
    if(mutation==='disclosure') f.state.disclosure=false;
    if(mutation==='missing-capability') delete f.options.authorize;
    const result=await f.run();assert.equal(result.outcome,'unresolved');assert.equal(f.writes.length,0);
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  });
}

test('authorization loss stops next operation; reopen rechecks everything',async t=>{
  const f=fixture(t);f.state.after=()=>{f.state.allow=false;};
  const r=await f.run();assert.equal(r.outcome,'unresolved');assert.equal(f.writes.length,1);
  f.state.after=null;f.state.allow=true;
  assert.equal((await f.run(false)).outcome,'verified');assert.equal(f.writes.length,3);
});

for(const lost of ['a','edge']) test(`lost ${lost} response reuses uniquely observed effect`,async t=>{
  const f=fixture(t); f.state.lost=lost;
  // Make the first post-submission read inaccessible, simulating interrupted observation.
  f.state.after=()=>{if(f.state.lost) f.state.incomplete=true;};
  const r=await f.run(); assert.equal(r.outcome,'unresolved');
  const count=f.writes.length; f.state.after=null;f.state.incomplete=false;
  assert.equal((await f.run(false)).outcome,'verified');
  assert.equal(f.writes.length,3); assert.ok(count>=1);
});

for (const fault of ['missing','duplicate','wrong-node','pr','body','labels','repository','incomplete','one-sided','wrong-direction']) {
  test(`contradictory or incomplete ${fault} never completes or blindly resubmits`,async t=>{
    const f=fixture(t);
    if(fault==='incomplete') f.state.incomplete=true;
    else if(fault==='one-sided') f.state.oneSided=true;
    else f.state.drift=(type,data)=>{
      if(type==='list' && fault==='missing') return [];
      if(type==='list' && fault==='duplicate') return [...data,...data];
      if(type==='edge' && fault==='wrong-direction') return [];
      if(type!=='issue') return;
      return fault==='wrong-node'?{node_id:'other'}:fault==='pr'?{pull_request:{}}:fault==='body'?{body:'drift'}:
        fault==='labels'?{labels:[]}:fault==='repository'?{repository_url:'https://api.github.com/repos/wrong/repo'}:undefined;
    };
    assert.equal((await f.run()).outcome,'unresolved'); const count=f.writes.length;
    assert.equal((await f.run(false)).outcome,'unresolved');assert.equal(f.writes.length,count);
  });
}

for(const flag of ['frozen','authorized','shaped','active','delivered','closed','unknown']) {
  for(const kind of ['metadata','dependency']) test(`${flag} blocks ${kind} mutation`,async t=>{
    const f=fixture(t);
    if(kind==='metadata') {
      const op=f.manifest.operations[0];op.kind='metadata';delete op.payload.creation;
      op.payload.issue={id:'101',nodeId:'I_1',number:1};f.issues.set('a',f.issue(op,1));f.approve();
    }
    if(flag==='unknown') f.state.protected=null; else f.state.protected[flag]=true;
    assert.equal((await f.run()).outcome,'unresolved');
    assert.equal(f.writes.length,kind==='metadata'?0:2);
  });
}

test('approved metadata preserves existing assignments without sending assignment fields',async t=>{
  const f=fixture(t);const op=f.manifest.operations[0];op.kind='metadata';delete op.payload.creation;
  op.payload.issue={id:'101',nodeId:'I_1',number:1};
  f.issues.set('a',{...f.issue(op,1),title:'old title',labels:[{name:'old-label'}],milestone:{number:3}});f.approve();
  assert.equal((await f.run()).outcome,'verified');
  assert.equal(f.writes[0].method,'PATCH');assert.equal(Object.hasOwn(JSON.parse(f.writes[0].body),'assignees'),false);
  assert.deepEqual(f.issues.get('a').assignees,[{id:'8',login:'member'}]);
});

test('credential/private proof gate and thrown private diagnostics stay private',async t=>{
  const f=fixture(t); f.options.disclose=async()=>{throw Error('SECRET-private-error');};
  assert.ok(!JSON.stringify(await f.run()).includes('SECRET')); assert.equal(f.writes.length,0);
});

test('submission survives interruption before result; all old submissions reconcile before fresh writes',async t=>{
  const f=fixture(t), op=f.manifest.operations[0];
  const j=openPublicationJournal({directory:f.directory,manifest:f.manifest,initialize:true});
  j.intent(op);j.submission(op); f.issues.set('a',f.issue(op,1));
  assert.equal((await f.run(false)).outcome,'verified');assert.equal(f.writes.length,2);
});

test('journal initialization/append failures stop writes and corruption never replaces history',async t=>{
  const f=fixture(t);
  assert.equal((await publishPortfolio({...f.options,initialize:true,journalIO:{...fs,fsyncSync(){throw Error('SECRET');}}})).outcome,'unresolved');
  assert.equal(f.writes.length,0);
  assert.equal((await f.run(false)).outcome,'unresolved');assert.equal(f.writes.length,0);
});

test('append failure before submission prevents transport; corrupted history blocks reopen',async t=>{
  const f=fixture(t);
  const io={...fs,writeFileSync(fd,data){if(String(data).includes('"type":"submission"')) throw Error('SECRET');return fs.writeFileSync(fd,data);}};
  assert.equal((await publishPortfolio({...f.options,initialize:true,journalIO:io})).outcome,'unresolved');assert.equal(f.writes.length,0);
  assert.equal((await f.run(false)).outcome,'unresolved');assert.equal(f.writes.length,0);
});

for(const mutation of ['number','database-id','missing-labels','missing-assignees','missing-body','milestone']) {
  test(`independent GET rejects ${mutation} despite a successful acknowledgment`,async t=>{
    const f=fixture(t); f.state.drift=(type)=>type!=='issue'?undefined:
      mutation==='number'?{number:99}:mutation==='database-id'?{id:'999'}:
      mutation==='missing-labels'?{labels:null}:mutation==='missing-assignees'?{assignees:null}:
      mutation==='missing-body'?{body:null}:{milestone:{number:9}};
    assert.equal((await f.run()).outcome,'unresolved');assert.equal(f.writes.length,1);
    assert.equal((await f.run(false)).outcome,'unresolved');assert.equal(f.writes.length,1);
  });
}

test('metadata cannot replace changed original Scope even with metadata approval',async t=>{
  const f=fixture(t),op=f.manifest.operations[0];op.kind='metadata';delete op.payload.creation;
  op.payload.issue={id:'101',nodeId:'I_1',number:1};f.issues.set('a',{...f.issue(op,1),body:'changed original'});f.approve();
  const result=await f.run();assert.equal(result.diagnostic,'original-provenance');assert.equal(f.writes.length,0);
});

test('body drift after Issue verification blocks dependent native write',async t=>{
  const f=fixture(t);f.state.after=r=>{
    if(r.endpoint.includes('/org/b/')) f.issues.get('a').body='changed after readback';
  };
  assert.equal((await f.run()).outcome,'unresolved');assert.equal(f.writes.length,2);
});

test('recovered complete identity cannot silently become another database identity',async t=>{
  const f=fixture(t);assert.equal((await f.run()).outcome,'verified');
  f.issues.get('a').id='901';
  const r=await f.run(false);assert.equal(r.outcome,'unresolved');assert.equal(f.writes.length,3);
});

test('preflight or missing/corrupt committed records blocks all continuation',async t=>{
  const f=fixture(t);assert.equal((await f.run()).outcome,'verified');
  const original=fs.readFileSync(join(f.directory,'00000001.json'));
  fs.writeFileSync(join(f.directory,'00000001.json'),'{}');
  assert.equal((await f.run(false)).outcome,'unresolved');assert.equal(f.writes.length,3);
  assert.equal(fs.readFileSync(join(f.directory,'00000001.json'),'utf8'),'{}');
  fs.writeFileSync(join(f.directory,'00000001.json'),original);
  const io={...fs,openSync(path,...args){if(String(path).endsWith('/PREFLIGHT')) throw Error('SECRET');return fs.openSync(path,...args);}};
  assert.equal((await publishPortfolio({...f.options,journalIO:io})).outcome,'unresolved');assert.equal(f.writes.length,3);
  fs.unlinkSync(join(f.directory,'00000001.json'));
  assert.equal((await f.run(false)).outcome,'unresolved');assert.equal(f.writes.length,3);
});


test('actual publisher process killed after transport entry reconciles durable attempt without recreating',async t=>{
  const f=fixture(t), op=f.manifest.operations[0];
  const remote=join(f.directory,'..','remote-effect.json');
  const script=`import fs from 'node:fs';
    import {publishPortfolio,createGithubProvider} from ${JSON.stringify(import.meta.resolve('../src/index.mjs'))};
    const manifest=${JSON.stringify(f.manifest)};
    const directory=${JSON.stringify(f.directory)};
    const provider=createGithubProvider({authorize:async()=>true,attempts:1,transport:async r=>{
      if(r.method==='GET') return {status:200,body:JSON.stringify({id:'10',full_name:'person/a',
        private:false,visibility:'public',owner:{type:'User'}})};
      const files=fs.readdirSync(directory).filter(n=>/^\\d+\\.json$/.test(n)).sort();
      if(JSON.parse(fs.readFileSync(directory+'/'+files.at(-1))).event.type!=='submission') process.exit(7);
      fs.writeFileSync(${JSON.stringify(remote)},JSON.stringify(${JSON.stringify(f.issue(op,1))}));
      process.kill(process.pid,'SIGKILL');
    }});
    await publishPortfolio({provider,manifest,directory,initialize:true,authorize:async()=>true,
      protection:async()=>({frozen:false,authorized:false,shaped:false,active:false,delivered:false,closed:false}),
      disclose:async()=>true});`;
  const child=spawnSync(process.execPath,['--input-type=module'],{input:script,encoding:'utf8',env:{PATH:process.env.PATH}});
  assert.equal(child.signal,'SIGKILL',child.stderr);
  f.issues.set('a',JSON.parse(fs.readFileSync(remote)));
  assert.equal((await f.run(false)).outcome,'verified');
  assert.equal(f.writes.length,2);assert.ok(f.writes.every(r=>!r.endpoint.startsWith('/repos/person/a/issues')));
});

for(const material of ['PRIVATE-PROOF','CREDENTIAL-SENTINEL']) test(`trusted disclosure refuses ${material} in approved public content`,async t=>{
  const f=fixture(t),p=f.manifest.operations[0].payload;
  p.scope.body=material;p.scope.identity=contentIdentity(material);p.request.body=material;f.approve();
  f.options.disclose=async({operation})=>!operation.payload.request?.body.includes(material);
  const result=await f.run();assert.equal(result.outcome,'unresolved');assert.equal(f.writes.length,0);
  assert.ok(!JSON.stringify(result).includes(material));
});

for(const query of ['state=closed&per_page=100','state=all&per_page=1','state=all&per_page=100&page=2&page=3']) {
  test(`collection cannot change approved observation filters: ${query}`,async t=>{
    const f=fixture(t);f.state.listLink=`<https://api.github.com/repos/person/a/issues?${query}>; rel="next"`;
    assert.equal((await f.run()).outcome,'unresolved');assert.equal(f.writes.length,1);
    assert.equal((await f.run(false)).outcome,'unresolved');assert.equal(f.writes.length,1);
  });
}

test('temporary keys are own properties, including JavaScript prototype names',async t=>{
  const f=fixture(t);f.manifest.operations[0].payload.key='__proto__';
  f.manifest.operations[2].payload.blocking='__proto__';f.approve();
  const r=await f.run();assert.equal(r.outcome,'verified');
  assert.equal(Object.hasOwn(r.handoff.mappings,'__proto__'),true);
  assert.equal(JSON.parse(JSON.stringify(r.handoff)).mappings.__proto__.issue.id,'101');
});

for (const component of ['nodeId','number']) {
  for (const partial of [false,true]) test(`restart rejects changed ${component} after ${partial?'partial':'complete'} publication`,async t=>{
    const f=fixture(t);
    if (partial) f.state.after=()=>{f.state.allow=false;};
    const first=await f.run();assert.equal(first.outcome,partial?'unresolved':'verified');
    const writes=f.writes.length;
    const stored=openPublicationJournal({directory:f.directory,manifest:f.manifest}).recover('a');
    assert.deepEqual(stored.observations.at(-1).matches[0].resolved,
      {issueId:'101',repository:'person/a',repositoryId:'10',nodeId:'I_1',number:1});
    const original={...f.issues.get('a')};
    f.state.after=null;f.state.allow=true;
    const remote=f.issues.get('a');
    if(component==='nodeId') remote.node_id='DIFFERENT_NODE';
    else {remote.number=55;remote.url='https://api.github.com/repos/person/a/issues/55';}
    const restarted=await f.run(false);
    assert.equal(restarted.outcome,'unresolved');
    assert.equal(restarted.handoff,undefined);assert.equal(f.writes.length,writes);
    f.issues.set('a',original);
    assert.equal((await f.run(false)).outcome,'unresolved');assert.equal(f.writes.length,writes);
  });
}

test('database-only legacy readback cannot manufacture a complete identity binding',async t=>{
  const f=fixture(t),op=f.manifest.operations[0];
  const j=openPublicationJournal({directory:f.directory,manifest:f.manifest,initialize:true});
  j.intent(op);j.submission(op);j.result(op,'submitted');
  j.readback(op,{complete:true,matches:[{intent:op,resolved:{issueId:'101'}}]});
  f.issues.set('a',f.issue(op,1));
  const result=await f.run(false);assert.equal(result.outcome,'unresolved');
  assert.equal(result.handoff,undefined);assert.equal(f.writes.length,0);
});

for (const interrupted of [false,true]) test(`metadata assignment contradiction survives ${interrupted?'lost observation':'readback'} and restart`,async t=>{
  const f=fixture(t),op=f.manifest.operations[0];op.kind='metadata';delete op.payload.creation;
  op.payload.issue={id:'101',nodeId:'I_1',number:1};f.issues.set('a',f.issue(op,1));f.approve();
  f.state.after=()=>{f.issues.get('a').assignees=[{id:'9',login:'other'}];
    if(interrupted) f.state.drift=type=>type==='issue'?{labels:null}:undefined;};
  assert.equal((await f.run()).outcome,'unresolved');assert.equal(f.writes.length,1);
  f.state.after=null;f.state.drift=null;
  assert.equal((await f.run(false)).outcome,'unresolved');assert.equal(f.writes.length,1);
  const stored=openPublicationJournal({directory:f.directory,manifest:f.manifest}).recover('a');
  assert.deepEqual(stored.derivation.assignees,['8']);
  assert.deepEqual(stored.observations.at(-1).matches[0].resolved.assignees,['9']);
  f.issues.get('a').assignees=[{id:'8',login:'member'}];
  assert.equal((await f.run(false)).outcome,'unresolved');assert.equal(f.writes.length,1);
});

for (const assignments of [[],['8','9']]) test(`metadata lost observation preserves baseline ${JSON.stringify(assignments)}`,async t=>{
  const f=fixture(t),op=f.manifest.operations[0];op.kind='metadata';delete op.payload.creation;
  op.payload.issue={id:'101',nodeId:'I_1',number:1};
  f.issues.set('a',{...f.issue(op,1),assignees:assignments.map(id=>({id}))});f.approve();
  f.state.after=()=>{f.state.drift=type=>type==='issue'?{labels:null}:undefined;};
  assert.equal((await f.run()).outcome,'unresolved');assert.equal(f.writes.length,1);
  f.state.after=null;f.state.drift=null;
  const r=await f.run(false);assert.equal(r.outcome,'verified');assert.equal(f.writes.length,3);
  assert.deepEqual(r.handoff.mappings.a.assignees,assignments);
  if(assignments.length) {
    f.issues.get('a').assignees.reverse();
    assert.equal((await f.run(false)).outcome,'unresolved');assert.equal(f.writes.length,3);
  }
});

test('legacy metadata submission without assignment baseline cannot infer preservation',async t=>{
  const f=fixture(t),op=f.manifest.operations[0];op.kind='metadata';delete op.payload.creation;
  op.payload.issue={id:'101',nodeId:'I_1',number:1};f.issues.set('a',f.issue(op,1));f.approve();
  const j=openPublicationJournal({directory:f.directory,manifest:f.manifest,initialize:true});
  j.intent(op);j.submission(op);
  const r=await f.run(false);assert.equal(r.diagnostic,'assignment-baseline-missing');
  assert.equal(r.outcome,'unresolved');assert.equal(f.writes.length,0);
});

for (const field of ['labels','title','body','milestone','invalid-labels','invalid-milestone']) {
  for (const recovery of [false,true]) test(`combined assignment/${field} drift persists from ${recovery?'recovery':'initial'} observation`,async t=>{
    const f=fixture(t),op=f.manifest.operations[0];op.kind='metadata';delete op.payload.creation;
    op.payload.issue={id:'101',nodeId:'I_1',number:1};f.issues.set('a',f.issue(op,1));f.approve();
    const drift=()=>{const i=f.issues.get('a');i.assignees=[{id:'9'}];
      if(field==='invalid-labels') i.labels=null;
      else if(field==='invalid-milestone') i.milestone={number:'invalid'};
      else i[field]=field==='labels'?[]:field==='milestone'?{number:9}:'changed';};
    f.state.after=()=>{if(recovery) f.state.drift=type=>type==='issue'?{labels:null}:undefined;else drift();};
    if(recovery) f.state.lost='a';
    assert.equal((await f.run()).outcome,'unresolved');assert.equal(f.writes.length,1);
    f.state.after=null;f.state.drift=null;
    if(recovery) {drift();assert.equal((await f.run(false)).diagnostic,field.startsWith('invalid-')?'issue-readback':'content-readback');}
    const stored=openPublicationJournal({directory:f.directory,manifest:f.manifest}).recover('a');
    assert.equal(stored.phase,'unknown');assert.deepEqual(stored.derivation.assignees,['8']);
    assert.ok(stored.observations.some(o=>!o.complete && o.matches[0]?.resolved.assignees[0]==='9'));
    f.issues.set('a',f.issue(op,1));
    for(let attempt=0;attempt<2;attempt++) {
      const r=await f.run(false);assert.equal(r.outcome,'unresolved');assert.equal(r.handoff,undefined);
      assert.deepEqual(r.completed,[]);assert.equal(f.writes.length,1);
    }
  });
}

for(const approval of ['absent','partial','changed-authority','changed-body','revoked']) {
  test(`${approval} exact-manifest approval cannot authorize public writes`,async t=>{
    const f=fixture(t);
    if(approval==='absent')delete f.manifest.approval;
    if(approval==='partial') {
      const subset={...f.manifest,operations:f.manifest.operations.slice(0,1)};
      f.options.authorize=async({manifest})=>contentIdentity(manifest)===contentIdentity(subset);
    }
    if(approval==='changed-authority') f.manifest.plan.authorityRevision='unapproved-2';
    if(approval==='changed-body') {
      const p=f.manifest.operations[0].payload;
      p.scope.body+='unapproved';p.scope.identity=contentIdentity(p.scope.body);p.request.body=p.scope.body;
    }
    if(approval==='revoked')f.state.allow=false;
    const result=await f.run();assert.equal(result.outcome,'unresolved');assert.equal(f.writes.length,0);
  });
}

test('complete multiline Unicode raw content survives without hidden markers or normalization',async t=>{
  const f=fixture(t),body='# Raw Scope\r\n\r\n世界 🐟 e\u0301 é\n```js\nconst s = "raw";\n```\n  trailing spaces  \n';
  const p=f.manifest.operations[0].payload;
  p.scope={body,identity:contentIdentity(body)};p.request.body=body;f.approve();
  const result=await f.run();assert.equal(result.outcome,'verified');
  assert.equal(JSON.parse(f.writes[0].body).body,body);
  assert.equal(f.issues.get('a').body,body);assert.equal(result.handoff.mappings.a.scope.body,body);
  assert.equal((await f.run(false)).outcome,'verified');assert.equal(f.writes.length,3);
});

test('Markdown relationships cannot replace the native dependency request',async t=>{
  const f=fixture(t);f.manifest.operations[2].payload.markdown='Blocked by person/a#1';f.approve();
  assert.equal((await f.run()).outcome,'unresolved');assert.equal(f.writes.length,0);
});

for(const source of ['provider','authorize','protection','storage']) {
  test(`arbitrary ${source} exception text stays out of public diagnostics`,async t=>{
    const f=fixture(t),secret='CREDENTIAL-SENTINEL-private-provider-response';
    const fail=()=>{throw Error(secret);};
    if(source==='provider')f.options.provider={request:fail,collection:fail};
    else if(source==='storage')f.options.journalIO={...fs,fsyncSync:fail};
    else f.options[source]=fail;
    if(source==='protection') {
      const op=f.manifest.operations[0];op.kind='metadata';delete op.payload.creation;
      op.payload.issue={id:'101',nodeId:'I_1',number:1};f.issues.set('a',f.issue(op,1));f.approve();
    }
    const result=await f.run();assert.equal(result.outcome,'unresolved');assert.equal(f.writes.length,0);
    assert.ok(!JSON.stringify(result).includes(secret));
  });
}
