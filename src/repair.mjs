import {canonicalJSON, bodyDigest} from './grants.mjs';
import {compareEvidence, compareStageCollection, contentIdentity, byteDigest} from './evidence.mjs';
import {verifyWorkspace, exportWorkspace, importWorkspace} from './workspace.mjs';
import {prepareCustodyManifest, validateCustodyManifest} from './custody.mjs';
import {selectInstructions} from './instructions.mjs';

const same = (a,b) => canonicalJSON(a) === canonicalJSON(b);
const copy = structuredClone;
const require = (ok,code) => {if (!ok) throw Error(`repair:${code}`);};
const freeze = v => {if(v && typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const shared = ['authority','grant','policy','core','runtime','repositoryId','issueId','scopeHash','shapeHash'];
const order = ['publication','deliver','pre-accept-hooks','accept','pre-commit-hooks','pr','ci',
  'shaper-review','merge','final','closure','delivered'];
const codes = new Set(['configuration','current-drift','provenance','workspace','policy','checkpoint','effects',
  'source','intake','replay','attempt','history','retention','diagnosis','independence','role','merged',
  'recovery-permission','bounded','execution-unresolved','expectations','instructions']);
const safe = e => e?.message?.startsWith('repair:') && codes.has(e.message.slice(7))
  ? e.message : 'repair:invalid-or-unavailable';

/** Retain records; revoke applicability through the same current envelopes consumed
 * by compareEvidence/verifyCompletion and the native dependency evaluator.
 * The caller must persist/install returned currents before releasing a transition.
 */
export function invalidateRepairEvidence({records,current,from=null}) {
  require(from===null || order.includes(from.stage),'source');
  const invalidated=[], next=copy(current), items=records.map(r=>{
    require(order.includes(r.stage),'source');
    const id=contentIdentity(r);
    let invalid=false;
    try {compareEvidence(r,current[id]);} catch {invalid=true;}
    if(from && from.repositoryId===r.binding.repositoryId && from.issueId===r.binding.issueId
      && order.indexOf(r.stage)>=order.indexOf(from.stage)) invalid=true;
    return {r,id,invalid};
  });
  // Follow actual receipt/execution/Candidate references. A stale historical chain
  // must not poison a separately bound, fresh chain of the same Issue.
  let changed=true;
  while(changed) {
    changed=false;
    for(const item of items.filter(v=>!v.invalid)) {
      const r=item.r;
      // Execution IDs may be shared by Core-produced receipts. A reference
      // propagates invalidation only toward a later lifecycle stage.
      const upstream=items.filter(v=>v.invalid && order.indexOf(v.r.stage)<order.indexOf(r.stage) && shared.every(k=>v.r.binding[k]===r.binding[k]));
      if(upstream.some(v=>Object.values(r.inputs).some(x=>typeof x==='string'
          && (x===v.id || x===v.r.execution.id))
        || v.r.stage==='deliver' && r.inputs.candidate && same(r.inputs.candidate,v.r.inputs.candidate))) {
        item.invalid=true;changed=true;
      }
    }
  }
  for(const {r,id,invalid} of items) if(invalid) {
    invalidated.push(id);
    const c=current[id];
    if(c) next[id]={...copy(c),consumed:[...new Set([...c.consumed,r.execution.result])]};
  }
  return {invalidated,current:next};
}

/** Construction capabilities belong to Core. No Agent result supplies gates,
 * policy, attempt identities, custody references or operation permissions.
 * authorize and dependencies use the existing boundary/evaluator interfaces.
 */
export function createRepairFlow({current,workspace,evidenceCurrent,authorize,dependencies,
  retain,retrieve,prepareRole,now=Date.now}={}) {
  require([current,workspace,evidenceCurrent,authorize,dependencies,retain,retrieve,prepareRole,now]
    .every(f=>typeof f==='function'),'configuration');
  let busy=false, active=null, uncertain=false;
  const used=new Set(), released=new Map();
  async function checkpoint(pin,operation='repair') {
    require(same(await current(),pin),'current-drift');
    require(bodyDigest(pin.scopeBody)===pin.binding.scopeHash && bodyDigest(pin.shapeBody)===pin.binding.shapeHash,'provenance');
    require(pin.visibility==='public' && ['personal','organization'].includes(pin.ownership),'provenance');
    const p=pin.policy;
    require(p && ['until-conformant','bounded'].includes(p.mode)
      && (p.mode!=='bounded' || Number.isSafeInteger(p.maxRepairs) && p.maxRepairs>=0)
      && p.identity===pin.binding.policy,'policy');
    require(Number.isFinite(p.expiresAt) && now()<p.expiresAt && p.revoked===false,'checkpoint');
    const intent=freeze({repository:pin.repository,repositoryId:pin.binding.repositoryId,
      issueId:pin.binding.issueId,operation,policy:pin.binding.policy,repairPolicy:p});
    require((await authorize(intent)).ok===true,'checkpoint');
    const d=await dependencies(intent);
    require(d.outcome==='ready','checkpoint');
    require(pin.gates?.every(g=>g.status==='valid') && Array.isArray(pin.gates),'checkpoint');
    require(pin.effects?.execution==='terminated' && pin.effects?.writes==='reconciled','effects');
    require(same(await current(),pin),'current-drift');
  }
  async function candidate(pin) {
    const w=await workspace(); verifyWorkspace(w,pin.workspace);
    require(same(w.candidate,pin.attempt.candidate) && w.expected.binding.repository===pin.repository
      && w.expected.binding.scopeHash===pin.binding.scopeHash
      && w.expected.binding.shapeHash===pin.binding.shapeHash && w.expected.binding.policy===pin.binding.policy,'workspace');
    require(typeof pin.attempt.id==='string' && pin.attempt.id.length>0 && typeof pin.nextAttempt==='string'
      && pin.nextAttempt.length>0 && pin.nextAttempt!==pin.attempt.id,'attempt');
    require(Array.isArray(pin.history) && pin.history.every(r=>r.issueId===pin.binding.issueId
      && r.repositoryId===pin.binding.repositoryId
      && ['attempt','predecessor','policy','source'].every(k=>typeof r[k]==='string' && r[k].length>0)
      && /^[a-f0-9]{64}$/.test(r.policy) && /^[a-f0-9]{64}$/.test(r.source)
      && ['repair','scope-recovery','replan','wait'].includes(r.disposition)
      && (!released.has(r.attempt) || ['predecessor','policy','source','disposition'].every(k=>r[k]===released.get(r.attempt)[k])))
      && new Set(pin.history.map(r=>r.attempt)).size===pin.history.length
      && new Set(pin.history.map(r=>r.source)).size===pin.history.length,'history');
    require(!pin.history.some(r=>r.attempt===pin.nextAttempt) && !released.has(pin.nextAttempt),'attempt');
    return w;
  }
  async function intake(pin,raw) {
    require(['accept','shaper-review','ci'].includes(pin.source.kind),'source');
    if(pin.source.kind==='ci') {
      // A failed check is not a diagnosis. Core supplies the exact trusted CI
      // observation and, optionally, a separately assigned reviewer collection.
      require(same(raw,pin.source.observation) && raw?.status==='failed'
        && same(raw.binding,pin.binding) && same(raw.candidate,pin.attempt.candidate),'intake');
      if(!pin.source.classification) {
        const key=contentIdentity(raw);
        require(!used.has(key) && !pin.history.some(r=>r.source===key),'replay');
        return {failureClass:'external_failure',key,reporter:null,evidence:raw};
      }
      raw=pin.source.classification;
    }
    require(['accept','shaper-review'].includes(raw?.stage),'source');
    if(pin.source.kind!=='ci') require(raw.stage===pin.source.kind,'source');
    const checked=compareStageCollection(raw,await evidenceCurrent(raw.execution.id),pin);
    require(checked.status==='rejected','intake');
    require(shared.every(k=>raw.binding[k]===pin.binding[k]) && same(raw.inputs.candidate,pin.attempt.candidate),'attempt');
    require(raw.execution.id!==pin.attempt.deliverExecution,'independence');
    const key=contentIdentity({execution:raw.execution,binding:raw.binding,inputs:raw.inputs});
    require(!used.has(key) && !pin.history.some(r=>r.source===key),'replay');
    return {failureClass:raw.result.failureClass,key,reporter:raw.execution,result:checked.collection.result,
      evidence:checked.collection,...(pin.source.kind==='ci'?{ci:pin.source.observation}:{})};
  }
  async function preserve(pin,w,record) {
    const bytes=exportWorkspace(w);
    const payloads=new Map([['workspace.json',bytes],['history.json',Buffer.from(canonicalJSON(pin.history))],
      ['repair.json',Buffer.from(canonicalJSON(record))]]);
    const custody=copy(pin.custody);
    require(custody.stage==='candidate' && custody.issueId===pin.binding.issueId
      && custody.repositoryId===pin.binding.repositoryId && custody.repository===pin.repository
      && custody.scopeHash===pin.binding.scopeHash && custody.shapeHash===pin.binding.shapeHash
      && custody.authorization===pin.binding.grant && custody.cycle===w.expected.binding.cycle,'retention');
    custody.result=record.identity;
    custody.candidate={identity:contentIdentity(w.candidate),payloads:[{path:'workspace.json',digest:byteDigest(bytes)}]};
    const manifest=prepareCustodyManifest(custody,payloads);
    // Unknown persistence is latched: a new run must reconcile custody before reuse.
    uncertain=true;
    const saved=await retain({manifest:copy(manifest),
      payloads:new Map([...payloads].map(([p,b])=>[p,Buffer.from(b)]))});
    require(saved.outcome==='retained','retention');
    const read=await retrieve({ref:copy(saved.ref),expected:copy(custody)});
    require(read.outcome==='retrieved','retention');
    validateCustodyManifest(read.manifest,custody,read.payloads);
    require(same(read.manifest,manifest),'retention');
    for(const [p,b] of payloads) require(Buffer.from(read.payloads.get(p)).equals(b),'retention');
    importWorkspace(read.payloads.get('workspace.json'),{expected:pin.workspace});
    return saved.ref;
  }
  async function release(pin,w,intake,disposition,diagnosis=null) {
    const repair=disposition==='repair';
    if(repair) {
      const starts=new Set([...pin.history,...released.values()]
        .filter(r=>r.disposition==='repair' && r.policy===pin.binding.policy).map(r=>r.attempt)).size;
      require(pin.policy.mode!=='bounded' || starts<pin.policy.maxRepairs,'bounded');
    }
    const from={repositoryId:pin.binding.repositoryId,issueId:pin.binding.issueId,
      stage:disposition==='scope-recovery'?'publication':'deliver'};
    const invalidation=invalidateRepairEvidence({records:pin.evidence.records,current:pin.evidence.current,from});
    const record={version:1,repositoryId:pin.binding.repositoryId,issueId:pin.binding.issueId,
      attempt:pin.nextAttempt,predecessor:pin.attempt.id,candidate:pin.workspace,
      binding:pin.binding,policy:pin.binding.policy,source:intake.key,reporter:intake.reporter,
      sourceStage:pin.source.kind,sourceEvidence:intake.evidence,ci:intake.ci??null,
      disposition,diagnosis,invalidation};
    record.identity=contentIdentity(record);freeze(record);
    await checkpoint(pin,disposition==='scope-recovery'?'invalidate-shape':'repair');
    const ref=await preserve(pin,w,record);
    await checkpoint(pin,disposition==='scope-recovery'?'invalidate-shape':'repair');
    uncertain=false;used.add(intake.key);released.set(record.attempt,record);
    return {outcome:disposition==='replan'?'decision_required':disposition==='wait'?'blocked':'handoff',disposition,record,ref,...(disposition==='scope-recovery'
      ?{scopeBody:pin.scopeBody,stopCycle:true}:{}),
      requiredGates:[...(disposition==='scope-recovery'?['authorization','shape','shape-validator','publication']:[]),'deliver','pre-accept-hooks','accept','pre-commit-hooks','pr','ci','shaper-review','merge','final','closure','delivered']};
  }
  async function route(pin,w,i,diagnosis=null) {
    if(i.failureClass==='authority_gap') return release(pin,w,i,'replan',diagnosis);
    if(i.failureClass==='external_failure') return release(pin,w,i,'wait',diagnosis);
    if(i.failureClass==='implementation_defect') return release(pin,w,i,'repair',diagnosis);
    require(i.failureClass==='shape_defect','intake');
    if(!diagnosis) return diagnose(pin,w,i);
    require(pin.merged===false,'merged');
    require(pin.recovery?.allowed===true,'recovery-permission');
    return release(pin,w,i,'scope-recovery',diagnosis);
  }
  async function finish() {
    const a=active;
    await checkpoint(a.pin,'diagnose-shape');
    let collected,terminal;
    try {collected=a.collected??await a.lifecycle.collect(a.input.execution.id);
      if(['valid','rejected'].includes(collected.result?.status)) a.collected=collected;
    } finally {terminal=await a.lifecycle.termination(a.input.execution.id);}
    require(terminal.termination?.status==='terminated','execution-unresolved');
    require(['valid','rejected'].includes(collected.result?.status),'execution-unresolved');
    const raw=collected.result.evidence??collected.result.collection;
    require(same(raw.execution,a.input.execution) && same(raw.binding,a.input.binding),'diagnosis');
    const result=compareStageCollection(raw,await evidenceCurrent(a.input.execution.id),a.pin);
    require(raw.stage==='shape-diagnosis' && same(raw.inputs,{body:a.pin.binding.shapeHash}),'diagnosis');
    if(raw.result.failureClass==='shape_defect') require(Array.isArray(a.pin.conflictReferences)
      && raw.result.conflicts.every(c=>a.pin.conflictReferences.includes(c.evidenceReference)),'diagnosis');
    await checkpoint(a.pin,'diagnose-shape');
    // Collection and termination are resolved before releasing a replacement.
    active=null;
    const i={...a.intake,failureClass:raw.result.failureClass==='none'?'implementation_defect':raw.result.failureClass};
    return route(a.pin,a.w,i,result.status==='valid'?result.evidence:result.collection);
  }
  async function diagnose(pin,w,i) {
    await checkpoint(pin,'diagnose-shape');
    const instructions=selectInstructions({...pin.instructions,skill:'shape',role:'shape-diagnosis'});
    const task=freeze({version:1,role:'shape-diagnosis',skill:'shape',repository:pin.repository,
      scopeBody:pin.scopeBody,shapeBody:pin.shapeBody,binding:pin.binding,attempt:pin.attempt,
      workspace:JSON.parse(exportWorkspace(w)),history:pin.history,source:i,conflictReferences:pin.conflictReferences??[]});
    const {lifecycle,input}=await prepareRole({role:'shape-diagnosis',skill:'shape',instructions,task});
    require(input.execution.role==='shape-diagnosis' && input.execution.skill==='shape','role');
    require(shared.every(k=>input.binding[k]===pin.binding[k]) && input.binding.instructions===instructions.identity
      && same(input.instructions,{identity:instructions.identity,content:instructions.content}),'instructions');
    const forbidden=[i.reporter,...pin.executions].filter(Boolean).flatMap(e=>[e.id,e.request,e.result]);
    require(['id','request','result'].every(k=>!forbidden.includes(input.execution[k]) && !used.has(input.execution[k])),'independence');
    const expected=(await evidenceCurrent(input.execution.id)).expected;
    require(expected.stage==='shape-diagnosis' && same(expected.execution,input.execution)
      && same(expected.binding,input.binding) && same(expected.inputs,{body:pin.binding.shapeHash}),'expectations');
    await checkpoint(pin,'diagnose-shape');
    for(const k of ['id','request','result']) used.add(input.execution[k]);
    active={pin,w,intake:i,input:freeze(copy(input)),lifecycle};
    const started=await lifecycle.start(input);
    if(started.start?.status==='rejected') active=null;
    require(started.start?.status==='started','execution-unresolved');
    return finish();
  }
  async function exclusive(fn) {
    if(busy) return {outcome:'blocked',disposition:'reconcile',finding:'repair:concurrent-operation'};
    busy=true;
    try {return await fn();}
    catch(e) {return {outcome:'blocked',disposition:active||uncertain?'reconcile':'blocked',finding:safe(e)};}
    finally {busy=false;}
  }
  return Object.freeze({
    run(raw) {return exclusive(async()=>{
      if(active||uncertain) return {outcome:'blocked',disposition:'reconcile'};
      const pin=freeze(copy(await current()));
      await checkpoint(pin);
      const w=await candidate(pin), i=await intake(pin,copy(raw));
      return route(pin,w,i);
    });},
    reconcile() {return exclusive(async()=>{
      require(active && !uncertain,'execution-unresolved');return finish();
    });},
    stop() {return exclusive(async()=>{
      require(active,'execution-unresolved');await active.lifecycle.stop(active.input.execution.id);return finish();
    });}
  });
}
