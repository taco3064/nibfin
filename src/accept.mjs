import {canonicalJSON,bodyDigest} from './grants.mjs';
import {compareEvidence,compareStageCollection,contentIdentity} from './evidence.mjs';
import {selectInstructions} from './instructions.mjs';
import {verifyWorkspace,exportWorkspace} from './workspace.mjs';
import {verifyHookReceipt} from './hooks.mjs';
import {parseCandidateObligations,reconcileCandidateObligations} from './obligations.mjs';

const clone = structuredClone;
const same = (a,b) => canonicalJSON(a) === canonicalJSON(b);
const require = (ok,code) => {if(!ok) throw Error(`accept:${code}`);};
const freeze = v => {if(v && typeof v==='object') {Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const shared = ['authority','grant','policy','core','runtime','repositoryId','issueId','scopeHash','shapeHash'];
const findings = new Set(['capabilities','current-drift','product-scope','provenance','workspace-binding',
  'repository','obligations','inventory','upstream-stage','candidate','upstream-binding','hook-correspondence',
  'execution-unresolved','result-invalid-or-unresolved','foreign-result','result-inputs','instruction-configuration',
  'instructions','task-limit','role','independence','execution-reuse','role-binding','expectations','execution-start']);
const safeFinding = e => findings.has(e?.message?.slice(7)) && e.message.startsWith('accept:')
  ? e.message : 'accept:invalid-or-unavailable';

/** Core-owned capabilities. prepareRole must bind the entire task through its
 * trusted backend task channel; it must reject unsupported transport limits.
 * No capability or protected expectation is obtained from reviewer output.
 */
export function createAcceptFlow({current,workspace,prepareRole,evidenceCurrent} = {}) {
  require([current,workspace,prepareRole,evidenceCurrent].every(f=>typeof f==='function'),'capabilities');
  let active=null, busy=false;
  const used=new Set();
  async function checkpoint(pin) {
    require(same(await current(),pin),'current-drift');
    const w=await workspace();
    verifyWorkspace(w,pin.workspace);
    require(pin.visibility==='public' && ['personal','organization'].includes(pin.ownership),'product-scope');
    require(bodyDigest(pin.scopeBody)===pin.binding.scopeHash && bodyDigest(pin.shapeBody)===pin.binding.shapeHash,'provenance');
    for(const k of ['scopeHash','shapeHash','policy']) require(pin.workspace.binding[k]===pin.binding[k],'workspace-binding');
    require(pin.workspace.binding.repository===pin.repository,'repository');
    const parsed=parseCandidateObligations(pin.shapeBody);
    require(reconcileCandidateObligations(parsed,pin.obligations).ok,'obligations');
    require(same(parsed.inventory,w.metadata.inventory),'inventory');
    const d=compareEvidence(pin.deliver,pin.deliverCurrent);
    const h=compareEvidence(pin.hooks.stage,pin.hooks.stageCurrent);
    require(d.stage==='deliver' && h.stage==='pre-accept-hooks','upstream-stage');
    require(same(d.inputs.candidate,w.candidate) && same(h.inputs.candidate,w.candidate),'candidate');
    for(const k of shared) require(d.binding[k]===pin.binding[k] && h.binding[k]===pin.binding[k],'upstream-binding');
    const hookInput={workspace:w,expected:pin.workspace,phase:'pre-accept',profile:pin.hooks.profile,
      message:Buffer.from(pin.hooks.message,'base64'),observation:pin.obligations.hookObservation,
      executionId:pin.hooks.executionId};
    verifyHookReceipt(pin.hooks.receipt,hookInput,pin.hooks.receiptCurrent);
    require(h.inputs.receipt===pin.hooks.receipt.identity,'hook-correspondence');
    require(same(await current(),pin),'current-drift');
    return w;
  }
  async function finish() {
    const a=active;
    try {
      await checkpoint(a.pin);
      let collected,terminal;
      try {
        collected=a.collected ?? await a.lifecycle.collect(a.input.execution.id);
        if(['valid','rejected'].includes(collected.result?.status)) a.collected=collected;
      }
      finally {terminal=await a.lifecycle.termination(a.input.execution.id);}
      require(terminal.termination?.status==='terminated','execution-unresolved');
      // A terminated invalid/absent result is a known failure, not an unresolved writer.
      if(!['pending','unknown','unresolved'].includes(collected.result?.status)) active=null;
      require(['valid','rejected'].includes(collected.result?.status),'result-invalid-or-unresolved');
      const raw=collected.result.evidence ?? collected.result.collection;
      const checked=compareStageCollection(raw,await evidenceCurrent(a.input.execution.id),
        {scopeBody:a.pin.scopeBody,shapeBody:a.pin.shapeBody});
      require(same(raw.execution,a.input.execution) && same(raw.binding,a.input.binding),'foreign-result');
      require(same(raw.inputs,a.inputs),'result-inputs');
      await checkpoint(a.pin);
      active=null;
      return checked.status==='valid'?{outcome:'accepted',evidence:checked.evidence}:
        {outcome:'rejected',result:checked.collection.result,execution:checked.collection.execution};
    } catch(e) {
      return {outcome:'blocked',finding:safeFinding(e),...(active?{reconciliationRequired:active.input.execution.id}:{})};
    }
  }
  async function exclusive(fn) {
    if(busy) return {outcome:'blocked',finding:'accept:concurrent-operation'};
    busy=true;try{return await fn();}finally{busy=false;}
  }
  return Object.freeze({
    run() {return exclusive(async()=>{
      if(active) return {outcome:'blocked',finding:'accept:reconciliation-required',reconciliationRequired:active.input.execution.id};
      try {
        const pin=freeze(clone(await current()));
        const w=await checkpoint(pin);
        require(pin.instructions && Object.keys(pin.instructions).every(k=>['repository','shared','approvals'].includes(k)),'instruction-configuration');
        const selected=selectInstructions({...pin.instructions,skill:'accept',role:'accept'});
        require(selected.identity===pin.binding.instructions,'instructions');
        const inputs={candidate:w.candidate,hooks:contentIdentity(pin.hooks.stage),deliver:pin.deliver.execution.id};
        // Canonical workspace transfer contains complete binary diff, Git objects,
        // changed paths and all ignored artifact/hook source bytes, never digests alone.
        const task=freeze({version:1,role:'accept',skill:'accept',repository:pin.repository,
          scopeBody:pin.scopeBody,shapeBody:pin.shapeBody,decisions:pin.decisions,binding:pin.binding,
          workspace:JSON.parse(exportWorkspace(w).toString('utf8')),expected:pin.workspace,
          deliver:pin.deliver,hooks:pin.hooks,obligations:pin.obligations});
        require(Buffer.byteLength(canonicalJSON(task))<=64*1024*1024,'task-limit');
        const {lifecycle,input}=await prepareRole({role:'accept',skill:'accept',instructions:selected,task});
        require(input.execution.role==='accept' && input.execution.skill==='accept','role');
        require(['id','request','result'].every(k=>!['id','request','result'].some(d=>input.execution[k]===pin.deliver.execution[d])),'independence');
        require(['id','request','result'].every(k=>!used.has(input.execution[k])),'execution-reuse');
        require(same(input.binding,pin.binding) && same(input.instructions,{identity:selected.identity,content:selected.content}),'role-binding');
        require(input.visibility===pin.visibility && input.ownership===pin.ownership,'product-scope');
        await checkpoint(pin);
        const expected=(await evidenceCurrent(input.execution.id)).expected;
        require(expected.stage==='accept' && same(expected.inputs,inputs)
          && same(expected.execution,input.execution) && same(expected.binding,input.binding),'expectations');
        for(const k of ['id','request','result']) used.add(input.execution[k]);
        active={pin,lifecycle,input:freeze(clone(input)),inputs};
        const started=await lifecycle.start(input);
        if(!started.id || started.start?.status==='rejected') active=null;
        require(started.start?.status==='started','execution-start');
        return await finish();
      } catch(e) {return {outcome:'blocked',finding:safeFinding(e),...(active?{reconciliationRequired:active.input.execution.id}:{})};}
    });},
    reconcile() {return exclusive(async()=>active?finish():{outcome:'blocked',finding:'accept:no-active-execution'});},
    stop() {return exclusive(async()=>{
      if(!active) return {outcome:'blocked',finding:'accept:no-active-execution'};
      try {
        const id=active.input.execution.id;
        const state=await active.lifecycle.termination(id);
        if(state.termination?.status!=='terminated') await active.lifecycle.stop(id);
        return await finish();
      }
      catch {return {outcome:'blocked',finding:'accept:execution-unresolved',reconciliationRequired:active.input.execution.id};}
    });}
  });
}
