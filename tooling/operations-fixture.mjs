// Disposable provider-contract proof, never a real provider observation.
import {generateKeyPairSync} from 'node:crypto';
import {grantFixture, grantContext} from './grant-fixture.mjs';
import {readFile} from 'node:fs/promises';
import {relative} from 'node:path';
import {zipFixture} from './custody-fixture.mjs';
import {createGithubProvider, createArtifactCustody, byteDigest, contentIdentity,
  createControlledOperations, nativeExecutionPlan, createAuthorizationBoundary, bodyDigest, signGrant, canonicalJSON} from '../src/index.mjs';

export function operationInput(kind = 'close') {
  const h = 'a'.repeat(64), head = 'b'.repeat(40), base = 'c'.repeat(40);
  const payload = {close: {state: 'closed', state_reason: 'completed'}, label: {labels: ['delivered']},
    dispatch: {ref: head, inputs: {nibfin_correlation: 'request-1'}},
    pr: {title: 'Candidate', body: 'Candidate\n<!-- nibfin-operation:request-1 -->', head: 'nibfin/101', base: 'main'},
    merge: {sha: head, merge_method: 'rebase'}}[kind];
  return {version: 1, kind, correlation: 'request-1', source: {request: 'source-1', event: 'workflow_dispatch',
    repositoryId: '42', runId: '100', attempt: '1', actorId: '7'},
    binding: {repository: 'example-org/core', repositoryId: '42', issueId: 'I_101', number: '101', cycle: 'cycle-1',
      scopeHash: h, shapeHash: h, authorization: h, runId: '100', attempt: '1', candidate: h, base, head, ...(kind === 'merge' ? {baseRef:'main'} : {})},
    target: {id: kind === 'dispatch' ? '50' : kind === 'pr' ? '42' : kind === 'merge' ? '60' : '61',
      number: ['pr', 'dispatch'].includes(kind) ? null : kind === 'merge' ? '102' : '101', workflow: kind === 'dispatch' ? '50' : null}, payload};
}
export function operationsFixture(input = operationInput()) {
  let execution = {runId:'100',attempt:'1'};
  const b = input.binding, root = `/repos/${b.repository}`, records = new Map(), history = new Map(), calls = [];
  const state = {effect: false, allowed: true, lost: false, status: 200, failRead: false, incomplete: false,
    retainFail: false, corrupt: false, expired: false, mutate: d => d, beforeWrite: () => {}};
  let next = 900;
  const response = (data, status = 200, headers = {}) => ({status, headers, body: JSON.stringify(data)});
  function effectData() {
    if (input.kind === 'dispatch') return {id: '70', workflow_id: '50', event: 'workflow_dispatch',
      display_title: 'nibfin-operation:request-1', head_sha: b.head, repository: {id: '42'}, status: 'queued'};
    if (['pr', 'merge'].includes(input.kind)) return {id: '60', number: 102, title: input.payload.title, body: input.payload.body,
      head: {ref: input.payload.head, sha: b.head, repo: {id: '42'}}, base: {ref: input.kind === 'merge' ? b.baseRef : input.payload.base, sha: b.base, repo: {id: '42'}},
      merged: input.kind === 'merge', state: input.kind === 'merge' ? 'closed' : 'open', merge_commit_sha: 'd'.repeat(40)};
    return {id: '61', node_id: 'I_101', number: 101, repository_url: `https://api.github.com${root}`,
      state: input.kind === 'close' ? 'closed' : 'open', state_reason: 'completed', closed_at: '2026-10-24T12:00:00Z'};
  }
  const transport = async r => {
    calls.push(r);
    if (r.method !== 'GET') {
      state.beforeWrite(r);
      state.effect = true;
      if (state.onWrite) await state.onWrite(r);
      if (state.lost) throw Error('lost fixture response');
      return response({id: input.target.id});
    }
    if (state.failRead && !r.endpoint.includes('/artifacts') && r.endpoint !== root) return response({}, 500);
    if (r.endpoint === root) return response({id: '42', full_name: b.repository, private: false});
    const all = [...records.values()].map(x => x.metadata);
    if (/\/actions\/runs\/\d+\/artifacts\?per_page=100$/.test(r.endpoint)) {
      const runId=r.endpoint.match(/\/runs\/(\d+)\//)[1], filtered=all.filter(a=>a.workflow_run.id===runId);
      return response({total_count:filtered.length,artifacts:filtered});
    }
    const match = r.endpoint.match(/\/actions\/artifacts\/(\d+)$/);
    if (match) return records.has(match[1]) ? response(records.get(match[1]).metadata) : response({}, 404);
    const d = state.mutate(effectData());
    const headers = state.incomplete ? {link: `<https://evil.example/page>; rel="next"`} : {};
    if (r.endpoint.startsWith(`${root}/actions/workflows/`)) return response({total_count:state.total ?? (state.effect ? 1 : 0),workflow_runs: state.runs ?? (state.effect ? [d] : [])}, state.status, headers);
    if (r.endpoint === `${root}/pulls?state=all&per_page=100`) return response(state.effect ? [d] : [], state.status, headers);
    if (r.endpoint.includes('/labels')) return response(state.effect ? [{id: '80', name: 'delivered'}] : [], state.status, headers);
    if (r.endpoint.includes('/commits/')) return response({sha: 'd'.repeat(40)}, state.status);
    return response(state.effect ? (state.detail ? state.detail(d) : d) : {id: input.target.id, state: 'open'}, state.status);
  };
  const provider = createGithubProvider({transport, attempts: 1});
  const grantInput = grantFixture(bodyDigest);
  for (const work of grantInput.work) work.repository.id = '42';
  grantInput.permissions[0].repository.id = '42'; grantInput.permissions[0].operations = [input.kind];
  const keys = generateKeyPairSync('ed25519');
  const context = grantContext(grantInput, keys.publicKey.export({type:'spki',format:'pem'}));
  context.request.operation = input.kind;
  context.request.number = b.number; context.request.issueId = b.issueId;
  const grant = signGrant(grantInput, {keyId:'owner-1', privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'})});
  const authorization = createAuthorizationBoundary({identity:'hosted-authorized',maxCheckpointMs:1000,now:()=>1100,attempts:1,
    getCheckpoint: intent => {
      if (canonicalJSON(intent.context) !== canonicalJSON(b)) throw Error('changed checkpoint');
      return {request:context.request,grant,grantContext:context,member:{id:'7',login:'member'},
        operator:{id:'fixture-service',kind:'service',source:'hosted-authorized',trusted:true},
        write:{method:intent.method,endpoint:intent.endpoint,target:input.target.id}};
    }, transport: async r => {
      if (r.method !== 'GET') return transport(r);
      calls.push({...r,checkpoint:true});
      const data = r.endpoint === root ? {id:'42',full_name:b.repository,private:false,visibility:'public',owner:{login:'example-org',type:'Organization'}}
        : r.endpoint === root+'/issues/'+b.number ? {id:'61',node_id:b.issueId,number:Number(b.number),repository_url:'https://api.github.com'+root,assignees:[{id:'7',login:'member'}]}
        : r.endpoint.endsWith('/permission') ? {permission:state.allowed?'write':'read',user:{id:'7',login:'member'}}
        : {id:'7',login:'member'};
      return response(data);
    }});
  const custody = () => createArtifactCustody({provider, archive: async r => {
    const artifact = records.get(r.endpoint.match(/\/artifacts\/(\d+)\/zip$/)?.[1]);
    return {status: 200, bytes: state.corrupt ? Buffer.from('corrupt') : artifact.bytes};
  }, now: () => Date.parse(state.expired ? '2031-01-01' : '2026-10-24')});
  const publication = async ({intent, phase, expected}) => ({
    runtime: {facility: '@actions/artifact@2.3.2', available: true, repository: b.repository,
      repositoryId: '42', runId: expected.runId, attempt: expected.attempt},
    client: {uploadArtifact: async (name, paths, directory) => {
      calls.push({phase, name});
      if (state.onPublish) await state.onPublish(phase);
      if (state.retainFail === phase || state.retainFail === true) throw Error('retention unavailable');
      const entries = await Promise.all(paths.map(async p => [relative(directory, p), await readFile(p)]));
      const bytes = zipFixture(entries), id = String(next++);
      records.set(id, {bytes, metadata: {id, name, size_in_bytes: bytes.length, expired: false,
        expires_at: '2030-01-01T00:00:00Z', digest: `sha256:${byteDigest(bytes)}`,
        workflow_run: {id: expected.runId, repository_id: '42'}}});
      const manifest = JSON.parse(entries.find(([p]) => p === 'custody-manifest.json')[1]);
      const refs = history.get(intent.correlation) ?? {};
      refs[phase] = {ref:{repository: b.repository, repositoryId: '42', runId: expected.runId, artifactId: id,
        manifestIdentity: contentIdentity(manifest), archiveDigest: byteDigest(bytes)},source:{runId:expected.runId,attempt:expected.attempt}};
      history.set(intent.correlation, refs);
      return {id, digest: byteDigest(bytes)};
    }}
  });
  const fresh = (source={runId:'100',attempt:'1'}) => {execution=source; return createControlledOperations({authorization, provider, custody: custody(), publication, execution,
    locate: ({identity, correlation}) => state.historyUnavailable ? {outcome:'unavailable'} : history.has(correlation)
      ? {outcome: 'found', refs: structuredClone(history.get(correlation))} : {outcome: 'new', identity}});};
  return {input, state, calls, records, history, fresh, writes: () => calls.filter(r => r.method && r.method !== 'GET')};
}
/** A generator fixture, not a deployed workflow. Its outputs are actual GitHub configuration fields. */
export function concurrencyConsumer(input) {
  const plan = nativeExecutionPlan(input);
  return {on: {workflow_dispatch: {}}, concurrency: plan.concurrency, jobs: {
    compute: {'runs-on': 'ubuntu-latest', strategy: {...plan.jobs.compute.strategy, matrix: {part: ['implementation', 'verification']}},
      steps: [{run: 'echo local-consumer-fixture'}]},
    write: {'runs-on': 'ubuntu-latest', ...plan.jobs.write, steps: [{run: 'echo authorized-core-write-boundary'}]}
  }};
}
