import {bodyDigest, canonicalJSON, contentIdentity, compareEvidence, selectInstructions,
  parseCandidateObligations, reconcileCandidateObligations, controlledIntent,
  nativeConcurrency, githubId, repositoryCoordinates} from './index.mjs';

const same = (a,b) => canonicalJSON(a) === canonicalJSON(b);
const clone = structuredClone;
const finding = e => /^shape:[a-z-]+$/.test(e?.message) ? e.message : 'shape:unavailable';
const require = (ok, code) => {if (!ok) throw Error(`shape:${code}`);};
const freeze = v => {if (v && typeof v === 'object') {Object.values(v).forEach(freeze);Object.freeze(v);} return v;};
const shared = ['authority','grant','policy','core','runtime','repositoryId','issueId','scopeHash'];

/** Core-owned capabilities only. No capability is taken from Agent output. */
export function createShapeFlow({provider, authorization, dependencies, dependencyInput,
  current, prepareRole, readBody, operations, evidenceCurrent, obligations} = {}) {
  require([current,prepareRole,readBody,operations,evidenceCurrent,obligations].every(f=>typeof f==='function')
    && typeof provider?.request==='function' && typeof provider?.collection==='function'
    && typeof authorization?.eligibility==='function' && typeof dependencies?.evaluate==='function','capabilities');
  async function checkpoint(pin, stage) {
    const live = clone(await current());
    require(same(live,pin),'current-binding-drift');
    const a = await authorization.eligibility({operation:stage});
    require(a?.ok === true && a.observation?.repositoryId === pin.target.repositoryId
      && a.observation?.issueId === pin.target.issueId,'authorization');
    const d = await dependencies.evaluate(clone(dependencyInput));
    require(d?.outcome === 'ready' && d.target?.repositoryId === pin.target.repositoryId
      && d.target?.issueId === pin.target.issueId,'dependencies');
    require(same(await current(),pin),'current-binding-drift');
  }
  function intake(v) {
    const t=v.target;
    require(v.instructions && Object.keys(v.instructions).every(k=>['repository','shared','approvals'].includes(k)),'instruction-configuration');
    require(typeof v.decision==='string' && /^[a-f0-9]{64}$/.test(v.decision),'decision');
    githubId(t.repositoryId); githubId(t.databaseId); githubId(t.number);
    require(repositoryCoordinates(...t.repository.split('/')).key===t.repository,'repository');
    require(v.original?.kind==='raw-scope' && typeof v.original.body==='string'
      && bodyDigest(v.original.body)===v.binding.scopeHash && v.original.hash===v.binding.scopeHash,'original-scope');
    require(v.binding.repositoryId===t.repositoryId && v.binding.issueId===t.issueId,'identity');
    for (const k of shared.filter(k=>!['repositoryId','issueId'].includes(k)))
      require(/^[a-f0-9]{64}$/.test(v.binding[k]),'authority');
    return freeze(v);
  }
  async function observe(pin, body) {
    const t=pin.target, root=`/repos/${t.repository}`;
    const options={operation:'shape-read',correlation:pin.correlation,target:t.databaseId};
    const repo=await provider.request({...options,endpoint:root});
    require(repo.outcome==='read' && repo.data.id===t.repositoryId
      && repo.data.full_name?.toLowerCase()===t.repository && repo.data.private===false,'repository-readback');
    const r=await provider.request({...options,endpoint:`${root}/issues/${t.number}`});
    const d=r.data;
    require(r.outcome==='read' && d?.id===t.databaseId && d.node_id===t.issueId
      && String(d.number)===t.number && !d.pull_request && d.repository_url===`https://api.github.com${root}`
      && d.body===body && d.state==='open','body-drift');
    const path=`${root}/issues/${t.number}/labels`;
    const labels=await provider.collection({...options,endpoint:path+'?per_page=100',allowPage:p=>p.split('?')[0]===path});
    require(labels.outcome==='complete','labels-readback');
    return {issue:contentIdentity(d),labels:contentIdentity(labels.data),shaped:labels.data.some(l=>l.name==='shaped'),
      endpoint:r.endpoint ?? `${root}/issues/${t.number}`,observedAt:r.observedAt};
  }
  async function role(pin, name, body, author) {
    await checkpoint(pin,name);
    const selected=selectInstructions({...pin.instructions,skill:'shape',role:name});
    // prepareRole binds task to the existing lifecycle/backend task capability.
    const task=freeze({target:pin.target,original:pin.original,authority:pin.binding,
      proposedBody:body,author,obligations:await obligations()});
    const prepared=await prepareRole({role:name,skill:'shape',instructions:selected,task});
    const {lifecycle,input}=prepared;
    require(input.execution.role===name && input.execution.skill==='shape'
      && input.instructions.identity===selected.identity && input.instructions.content===selected.content,'role-instructions');
    for (const k of shared) require(input.binding[k]===pin.binding[k],'role-binding');
    require(name==='shape' || input.execution.id!==author,'independence');
    const start=await lifecycle.start(input);
    require(start.start?.status==='started','execution-start');
    const collected=await lifecycle.collect(input.execution.id);
    const terminated=await lifecycle.termination(input.execution.id);
    require(collected.result?.status==='valid' && terminated.termination?.status==='terminated','execution-unresolved');
    const receipt=compareEvidence(collected.result.evidence,await evidenceCurrent(input.execution.id));
    require(receipt.stage===name && receipt.execution.id===input.execution.id,'foreign-result');
    const proposed=name==='shape' ? await readBody(input.execution.id) : body;
    require(typeof proposed==='string' && proposed!==pin.original.body
      && receipt.inputs.body===bodyDigest(proposed),'body-evidence');
    if (name==='shape-validator') require(receipt.inputs.author===author && receipt.binding.shapeHash===bodyDigest(body),'validator-body');
    await checkpoint(pin,name);
    return {body:proposed,receipt};
  }
  async function validate(pin, author, validator) {
    const a=compareEvidence(author.receipt,await evidenceCurrent(author.receipt.execution.id));
    const v=compareEvidence(validator.receipt,await evidenceCurrent(validator.receipt.execution.id));
    require(a.stage==='shape' && v.stage==='shape-validator' && author.body===validator.body
      && a.execution.id!==v.execution.id && v.inputs.author===a.execution.id,'independence');
    for (const receipt of [a,v]) {
      for (const k of shared) require(receipt.binding[k]===pin.binding[k],'stale-evidence');
      const selected=selectInstructions({...pin.instructions,skill:'shape',role:receipt.stage});
      require(receipt.binding.instructions===selected.identity && receipt.inputs.body===bodyDigest(author.body),'instruction-or-body');
    }
    require(v.binding.shapeHash===bodyDigest(author.body),'shape-binding');
    const parsed=parseCandidateObligations(author.body);
    const reconciled=reconcileCandidateObligations(parsed,await obligations());
    require(reconciled.ok,'obligations');
    return {a,v,inventory:parsed.inventory};
  }
  return Object.freeze({
    async propose() {
      try {
        const pin=intake(clone(await current()));
        await checkpoint(pin,'shape');
        const before=await observe(pin,pin.original.body);
        require(!before.shaped,'already-shaped');
        const author=await role(pin,'shape',null,null);
        const validator=await role(pin,'shape-validator',author.body,author.receipt.execution.id);
        const validation=await validate(pin,author,validator);
        return {outcome:'validated',original:clone(pin.original),author,validator,inventory:validation.inventory};
      } catch(e) {return {outcome:'blocked',finding:finding(e)};}
    },
    async publish(candidate) {
      let phase='validation', bodyResult, labelResult;
      try {
        const pin=intake(clone(await current()));
        const c=clone(candidate);
        require(c.outcome==='validated' && same(c.original,pin.original),'candidate');
        const {a,v,inventory}=await validate(pin,c.author,c.validator);
        require(same(inventory,c.inventory),'inventory');
        const body=c.author.body;
        const make=kind=>controlledIntent({version:1,kind,correlation:`${pin.correlation}-${kind}`,
          source:pin.source,binding:{...pin.operationBinding,repository:pin.target.repository,
            repositoryId:pin.target.repositoryId,issueId:pin.target.issueId,number:pin.target.number,
            scopeHash:pin.binding.scopeHash,shapeHash:bodyDigest(body),authorization:pin.binding.grant},
          target:{id:pin.target.databaseId,number:pin.target.number,workflow:null},
          payload:kind==='issue-body'?{body}:{labels:['shaped']}});
        // Factory MUST return createControlledOperations with this beforeSubmit guard.
        // It resolves retained custody history; missing history is not newness.
        const guard=async intent=>{
          await checkpoint(pin,'publish-shape');
          await validate(pin,c.author,c.validator);
          const o=await observe(pin,intent.kind==='issue-body'?pin.original.body:body);
          if(intent.kind==='issue-body') require(!o.shaped,'manual-label');
        };
        const ops=await operations({beforeSubmit:guard,concurrency:nativeConcurrency({
          repository:pin.target.repository,repositoryId:pin.target.repositoryId,scope:'repository-write'})});
        await checkpoint(pin,'publish-shape');
        phase='body'; bodyResult=await ops.execute(make('issue-body'));
        require(bodyResult.continuation===true && bodyResult.outcome==='confirmed-success','body-unknown');
        await checkpoint(pin,'publish-shape'); await validate(pin,c.author,c.validator);
        await observe(pin,body);
        phase='label'; labelResult=await ops.execute(make('label'));
        require(labelResult.continuation===true && labelResult.outcome==='confirmed-success','label-unknown');
        await checkpoint(pin,'publish-shape'); await validate(pin,c.author,c.validator);
        const readback=await observe(pin,body);
        require(readback.shaped,'shaped-readback');
        const publication={version:1,original:pin.original,shapeHash:bodyDigest(body),author:a.execution,
          validator:v.execution,validation:contentIdentity(v),decision:pin.decision,
          bodyResult,labelResult,readback,binding:pin.binding};
        require(typeof pin.decision==='string' && /^[a-f0-9]{64}$/.test(pin.decision),'decision');
        return {outcome:'published',publication,identity:contentIdentity(publication)};
      } catch(e) {return {outcome:'blocked',phase,finding:finding(e),bodyResult,labelResult};}
    }
  });
}
