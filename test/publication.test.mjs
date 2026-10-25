import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {openPublicationJournal, publicationManifest} from '../src/index.mjs';

const op = (kind, correlation = kind) => ({kind, correlation,
  target:{repository:kind === 'metadata' ? 'example-org/core' : 'person/core',repositoryId:'42'},
  payload:kind === 'issue' ? {body:'Original Scope\n世界',labels:['scope']} : kind === 'metadata'
    ? {issue:'planned-a',labels:['scope']} : {blocked:'planned-b',blocking:'planned-a'}});
const manifest = () => ({version:1,approval:'approved-plan-1',plan:{
  repositories:[{name:'person/core',id:'42'},{name:'example-org/core',id:'43'}],
  scopes:[{id:'planned-a',body:'Original Scope\n世界'},{id:'planned-b',body:'B'}],
  metadata:{labels:['scope']},dependencies:[['planned-b','planned-a']]},
operations:['issue','metadata','dependency'].map(k => op(k))});
function fixture(t) {
  const parent = fs.mkdtempSync(join(tmpdir(),'publication-'));
  t.after(() => fs.rmSync(parent,{recursive:true,force:true}));
  const directory = join(parent,'journal'), value = manifest();
  return {parent,directory,value,open:(options={}) => openPublicationJournal({directory,manifest:value,...options})};
}
const observation = (operation, resolved={issueId:'123'}) => ({complete:true,matches:[{intent:operation,resolved}]});
function fault(method, predicate = () => true) {
  return {...fs,[method]:(...args) => {if (predicate(...args)) throw Error('ghp_SECRET token=private'); return fs[method](...args);}};
}

test('AC1 exact manifest and correlation binding, distinct operations and immutable assigned identities', t => {
  const f = fixture(t), j = f.open({initialize:true});
  for (const operation of f.value.operations) j.intent(operation);
  assert.equal(f.open().identity,j.identity);
  for (const change of [v=>v.approval+='x',v=>v.plan.scopes[0].body+='x',
    v=>v.operations[0].target.repository='other/core',v=>v.operations[0].target.repositoryId='99',
    v=>v.operations[0].payload.body+='x',v=>v.operations[1].payload.labels.push('shaped'),
    v=>v.operations[2].payload.blocking='different',v=>v.operations[0].kind='metadata']) {
    const changed = structuredClone(f.value); change(changed);
    assert.throws(()=>openPublicationJournal({directory:f.directory,manifest:changed}));
  }
  for (const change of [v=>v.kind='metadata',v=>v.payload.body='changed',v=>v.target.repository='other/core']) {
    const changed = op('issue'); change(changed); assert.throws(()=>j.submission(changed),/correlation-conflict/);
  }
  j.submission(op('dependency')); j.result(op('dependency'),'submitted');
  j.readback(op('dependency'),observation(op('dependency'),{blockedIssueId:'124',blockingIssueId:'123'}));
  assert.equal(f.open().recover('dependency').phase,'complete');
  assert.deepEqual(j.history()[0].event.value,f.value);
  assert.equal(publicationManifest(f.value).identity,j.identity);
});

test('AC2 preflight failure prevents simulated writes and returns safe diagnostics', t => {
  const f=fixture(t); let writes=0;
  for (const options of [{directory:undefined},{directory:f.parent+'/../escape'},
    {directory:join(f.parent,'missing','journal')},{io:fault('fsyncSync')},
    {io:fault('writeFileSync')},{io:fault('readFileSync')}]) {
    const target=join(f.parent,'failure-'+Math.random());
    assert.throws(()=>{openPublicationJournal({directory:target,manifest:f.value,initialize:true,...options}); writes++;},
      error=>!error.message.includes('SECRET') && error.message.startsWith('publication:'));
  }
  assert.equal(writes,0);
  assert.throws(()=>f.open(),/storage/);
  f.open({initialize:true});
  assert.throws(()=>f.open({initialize:true}),/storage/);
  const link=join(f.parent,'link'); fs.symlinkSync(f.directory,link);
  assert.throws(()=>openPublicationJournal({directory:link,manifest:f.value}),/unsafe/);
  fs.writeFileSync(join(f.directory,'HEAD'),'{"version":99,"sequence":0,"identity":"x"}');
  assert.throws(()=>f.open(),/head-invalid/);
});

test('AC3 independent disk reads prove intent and submission risk precede transport; result failures block continuation', t => {
  const f=fixture(t), j=f.open({initialize:true}); const a=op('issue'), b=op('metadata');
  let calls=0;
  const transport=operation=>{
    const recovered=f.open().recover(operation.correlation);
    assert.equal(recovered.phase,'unknown'); assert.deepEqual(recovered.operation,operation);
    assert.deepEqual(f.open().history().slice(-2).map(r=>r.event.type),['intent','submission']); calls++;
  };
  j.intent(a); j.submission(a); transport(a); j.result(a,'submitted');
  assert.equal(f.open().recover(a.correlation).phase,'unknown');
  j.readback(a,observation(a));
  j.intent(b); j.submission(b); transport(b);
  let armed=false;
  const broken=f.open({io:{...fs,writeFileSync:(...args)=>{if(armed) throw Error('ghp_SECRET'); return fs.writeFileSync(...args);}}});
  armed=true;
  assert.throws(()=>broken.result(b,'submitted'),/storage/);
  assert.throws(()=>f.open(),/partial-or-conflicting/);
  assert.equal(calls,2);
  assert.equal(j.history instanceof Function,true);
  // Result failure left the last committed attempt, never a completed receipt.
  const head=JSON.parse(fs.readFileSync(join(f.directory,'HEAD')));
  assert.equal(JSON.parse(fs.readFileSync(join(f.directory,String(head.sequence).padStart(8,'0')+'.json'))).event.type,'submission');
});

test('AC3 unresolved attempts block dependent submissions, intent failure permits no callback', t => {
  const f=fixture(t), j=f.open({initialize:true});
  j.intent(op('issue')); j.submission(op('issue')); j.intent(op('dependency'));
  assert.throws(()=>j.submission(op('dependency')),/unresolved-operation/);
  assert.equal(j.recover('dependency').phase,'intent');
  const g=fixture(t); g.open({initialize:true}); let calls=0;
  const broken=g.open({io:fault('openSync',p=>String(p).endsWith('00000001.json'))});
  assert.throws(()=>{broken.intent(op('issue')); calls++;}); assert.equal(calls,0);
});

// The child imports the public API, with all disposable state owned by this test.
function child(f, source) {
  const entry=import.meta.resolve('../src/index.mjs');
  // Installed-consumer tests resolve the installed package instead.
  const module=process.env.PUBLICATION_ENTRY || entry;
  return spawnSync(process.execPath,['--input-type=module','-e',`
    import * as fs from 'node:fs';
    import {openPublicationJournal} from ${JSON.stringify(module)};
    const directory=${JSON.stringify(f.directory)}, manifest=${JSON.stringify(f.value)};
    const operation=manifest.operations[0];
    ${source}
  `],{encoding:'utf8'});
}

test('AC4 fresh processes recover after SIGKILL at intent, submission/effect and partial-write boundaries', t => {
  for (const stage of ['before-intent','intent','effect','partial']) {
    const f=fixture(t); f.open({initialize:true});
    const code=`const io={...fs,writeFileSync:(fd,bytes)=>{
        if (${JSON.stringify(stage)}==='partial' && fs.readlinkSync('/proc/self/fd/'+fd).endsWith('00000001.json')) {
          fs.writeSync(fd,bytes.slice(0,10)); process.kill(process.pid,'SIGKILL');
        }
        return fs.writeFileSync(fd,bytes);
      }};
      const j=openPublicationJournal({directory,manifest,io});
      ${stage==='partial' ? `j.intent(operation);` :
        stage==='before-intent' ? '' : `j.intent(operation);${stage==='effect' ? `j.submission(operation);fs.writeFileSync(directory+'/../effect','created');` : ''}`}
      process.kill(process.pid,'SIGKILL');`;
    assert.equal(child(f,code).signal,'SIGKILL');
    if (stage==='partial') { assert.throws(()=>f.open(),/partial-or-conflicting/); continue; }
    const expected=stage==='before-intent'?'absent':stage==='intent'?'intent':'unknown';
    const result=child(f,`console.log(openPublicationJournal({directory,manifest}).recover(operation.correlation).phase);`);
    assert.equal(result.status,0,result.stderr); assert.equal(result.stdout.trim(),expected);
    if (stage==='effect') assert.equal(fs.readFileSync(join(f.parent,'effect'),'utf8'),'created');
  }
});

test('AC4 interrupted commit ordering, torn/missing history and stale writers fail closed', t => {
  for (const failure of ['record','pending','rename','directory']) {
    const f=fixture(t); f.open({initialize:true});
    const method=failure==='record'||failure==='pending'?'writeFileSync':failure==='rename'?'renameSync':'fsyncSync';
    let armed=false;
    const io={...fs,[method]:(...args)=>{
      if (armed) {
        if (failure==='record'||failure==='pending') {
          const name=fs.readlinkSync('/proc/self/fd/'+args[0]);
          if (name.endsWith(failure==='record'?'00000001.json':'HEAD.pending')) {
            fs.writeSync(args[0],'{'); throw Error('torn');
          }
        } else if (failure==='rename') throw Error('rename');
        else if (fs.fstatSync(args[0]).isDirectory()) throw Error('flush');
      }
      return fs[method](...args);
    }};
    const j=f.open({io}); armed=true; assert.throws(()=>j.intent(op('issue')));
    assert.throws(()=>f.open());
    assert.equal(JSON.parse(fs.readFileSync(join(f.directory,'00000000.json'))).event.type,'manifest');
  }
  const f=fixture(t), first=f.open({initialize:true}), stale=f.open();
  first.intent(op('issue')); assert.throws(()=>stale.intent(op('metadata')),/stale-writer/);
  fs.unlinkSync(join(f.directory,'00000001.json')); assert.throws(()=>f.open());
  fs.rmSync(f.directory,{recursive:true}); assert.throws(()=>f.open());
});

test('AC5 lost Issue/dependency responses reconcile without another write; acknowledgments are insufficient', t => {
  const f=fixture(t); let j=f.open({initialize:true}), writes=0;
  for (const operation of [op('issue'),op('dependency')]) {
    j.intent(operation); j.submission(operation); writes++;
    // Simulate a lost response: no result record, but remote effect exists.
    j=f.open(); assert.equal(j.recover(operation.correlation).phase,'unknown');
    j.readback(operation,observation(operation,operation.kind==='issue'?{issueId:'123'}:{blockedIssueId:'124',blockingIssueId:'123'}));
    assert.equal(j.recover(operation.correlation).phase,'complete');
    assert.throws(()=>j.submission(operation),/submission-replay/);
  }
  assert.equal(writes,2);
  assert.equal(f.open().recover('issue').reconciliationRequired,true);
  assert.equal(f.open().history().filter(r=>r.event.type==='result').length,0);
});

test('AC5 incomplete, duplicate, contradictory and unavailable observations remain unknown', t => {
  for (const observations of [
    [{complete:false,matches:[]}], [{complete:true,matches:[]}],
    [{complete:true,matches:[observation(op('issue')).matches[0],observation(op('issue')).matches[0]]}],
    [observation({...op('issue'),payload:{body:'other'}})],
    [observation(op('issue')),observation(op('issue'),{issueId:'999'})]
  ]) {
    const f=fixture(t), j=f.open({initialize:true}); j.intent(op('issue')); j.submission(op('issue')); j.result(op('issue'),'submitted');
    for (const o of observations) j.readback(op('issue'),o);
    assert.equal(f.open().recover('issue').phase,'unknown');
    assert.throws(()=>f.open().submission(op('issue')));
  }
  const f=fixture(t), j=f.open({initialize:true}); j.intent(op('issue')); j.submission(op('issue'));
  j.readback(op('issue'),{complete:false,matches:[]}); j.readback(op('issue'),observation(op('issue')));
  assert.equal(j.recover('issue').phase,'complete');
  j.readback(op('issue'),{complete:false,matches:[]}); assert.equal(j.recover('issue').phase,'unknown');
});

test('AC6 no provider capability or permission, safe sensitive failures, malformed versions and symlink records', t => {
  const f=fixture(t), j=f.open({initialize:true}); let providerWrites=0;
  const provider=()=>providerWrites++;
  assert.equal(j.submit,undefined); assert.equal(j.authorized,undefined);
  j.intent(op('issue')); j.submission(op('issue')); j.result(op('issue'),'unknown');
  j.readback(op('issue'),observation(op('issue')));
  assert.equal(providerWrites,0); assert.equal(typeof provider,'function');
  const recovered=f.open().recover('issue'); recovered.operation.payload.body='mutated';
  assert.equal(j.recover('issue').operation.payload.body,op('issue').payload.body);
  assert.throws(()=>j.result(op('issue'),'ghp_SECRET'),e=>!e.message.includes('SECRET'));
  const changed=manifest(); changed.version=2; assert.throws(()=>publicationManifest(changed),/version/);
  const dup=manifest(); dup.operations.push(op('issue')); assert.throws(()=>publicationManifest(dup),/correlation/);
  const file=join(f.directory,'00000001.json'); fs.renameSync(file,join(f.parent,'saved'));
  fs.symlinkSync(join(f.parent,'saved'),file); assert.throws(()=>f.open(),/unsafe-record/);
});

test('AC5 prior complete receipts require fresh independent reconciliation before other submissions', t => {
  const f=fixture(t), j=f.open({initialize:true});
  j.intent(op('issue')); j.submission(op('issue')); j.result(op('issue'),'submitted');
  j.readback(op('issue'),observation(op('issue')));
  const fresh=f.open(); fresh.intent(op('dependency'));
  assert.equal(fresh.recover('issue').reconciliationRequired,true);
  assert.throws(()=>fresh.submission(op('dependency')),/fresh-reconciliation-required/);
  fresh.readback(op('issue'),observation(op('issue')));
  assert.equal(fresh.recover('issue').reconciliationRequired,false);
  fresh.submission(op('dependency'));
  assert.equal(fresh.recover('dependency').phase,'unknown');
  assert.throws(()=>fresh.recover('unplanned'),/unknown-correlation/);
});

test('AC6 simulated publisher requires current authorization despite journal approval and recovered success', t => {
  const f=fixture(t), j=f.open({initialize:true}); let authorized=false, writes=0;
  const publish=operation=>{
    if (!authorized) throw Error('publisher:authorization-required');
    j.intent(operation); j.submission(operation);
    writes++; j.result(operation,'submitted'); j.readback(operation,observation(operation));
  };
  assert.throws(()=>publish(op('issue')),/authorization/); assert.equal(j.recover('issue').phase,'absent');
  authorized=true; publish(op('issue')); authorized=false;
  assert.equal(f.open().recover('issue').phase,'complete');
  assert.throws(()=>publish(op('dependency')),/authorization/);
  assert.equal(j.recover('dependency').phase,'absent'); assert.equal(writes,1);
  // Failed transport details are never an outcome or a journal diagnostic.
  assert.throws(()=>j.result(op('issue'),new Error('Bearer secret-token')),e=>!e.message.includes('secret-token'));
});

test('AC2/AC4 corrupt committed bytes, missing head and non-directory storage parents stop reopening', t => {
  for (const damage of ['record','head']) {
    const f=fixture(t), j=f.open({initialize:true}); j.intent(op('issue'));
    const earlier=fs.readFileSync(join(f.directory,'00000000.json'));
    if (damage==='record') fs.writeFileSync(join(f.directory,'00000001.json'),'{"version":99}');
    else fs.unlinkSync(join(f.directory,'HEAD'));
    assert.throws(()=>f.open());
    assert.deepEqual(fs.readFileSync(join(f.directory,'00000000.json')),earlier);
  }
  const f=fixture(t); fs.writeFileSync(join(f.parent,'file'),'not a directory');
  assert.throws(()=>openPublicationJournal({directory:join(f.parent,'file','journal'),manifest:f.value,initialize:true}));
});

test('AC3 result persistence failure before record creation retains recoverable risk and blocks another operation', t => {
  const f=fixture(t), j=f.open({initialize:true}); j.intent(op('issue')); j.submission(op('issue'));
  const broken=f.open({io:fault('openSync',p=>String(p).endsWith('00000003.json'))});
  assert.throws(()=>broken.result(op('issue'),'unknown'),e=>!e.message.includes('SECRET'));
  const fresh=f.open(); assert.equal(fresh.recover('issue').phase,'unknown');
  fresh.intent(op('dependency')); assert.throws(()=>fresh.submission(op('dependency')),/unresolved/);
  assert.ok(!JSON.stringify(fresh.history()).includes('SECRET'));
});
