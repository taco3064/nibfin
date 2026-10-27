import {readFileSync} from 'node:fs';

/** Pre-delivery asset only: never a protected Runtime Skill selection. */
export function scopeInstructions() {
  return readFileSync(new URL('../instructions/scope.md', import.meta.url), 'utf8');
}
const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && v.trim().length > 0;
const list = v => Array.isArray(v) ? v : [];
const ref = v => obj(v) && text(v.source) && text(v.revision);
const edgeKey = e => JSON.stringify([e?.from,e?.to]);

/** Pure, deterministic structural review of caller-supplied JSON; no authentication. */
export function checkPortfolio(input) {
  const diagnostics = [];
  const add = (code,path,reason,severity='error',remediation='Revise the plan for independent review.') =>
    diagnostics.push({code,path,reason,severity,remediation});
  if (!obj(input)) return {ok:false,graph:'unknown',resources:'unknown',diagnostics:[
    {code:'schema',path:'$',reason:'Expected a portfolio object.',severity:'error',remediation:'Supply the documented JSON schema.'}]};
  const p=input;
  for (const field of ['requirements','items','coverage','exclusions','dependencies','nativeDependencies','resources','claims']) {
    if (!Array.isArray(p[field])) add('schema',field,'Expected an explicit array, including when empty.');
  }
  if (!Array.isArray(p.handoffs) && !Array.isArray(p.sourceInputs))
    add('schema','sourceInputs','Supply explicit sourceInputs or legacy handoffs, including when empty.');
  for (const field of ['handoffs','sourceInputs','projects'])
    if (p[field]!==undefined && !Array.isArray(p[field])) add('schema',field,'Expected an array when supplied.');
  if (p.version!==1) add('schema','version','Expected version 1.');
  if (!ref(p.authority)) add('authority','authority','Preserve current source and revision; references do not authenticate authority.');
  if (!obj(p.boundary) || !['whole','subset'].includes(p.boundary.kind)) add('boundary','boundary','Declare whole or subset planning.');
  if (p.boundary?.kind==='subset' && !text(p.boundary.approval)) add('subset-approval','boundary.approval','An explicitly approved subset needs an approval reference.');
  const unique = (values,path) => {
    const map=new Map();
    list(values).forEach((v,i)=>{
      if (!obj(v) || !text(v.id)) add('schema',`${path}[${i}]`,'Expected an object with a nonempty id.');
      else if (map.has(v.id)) add('duplicate',`${path}[${i}].id`,'Duplicate identity creates ambiguous/conflicting work.');
      else map.set(v.id,v);
    });
    return map;
  };
  const requirements=unique(p.requirements,'requirements'), items=unique(p.items,'items');
  if (!requirements.size || !items.size) add('empty-plan','$','A reviewable plan needs requirements and independently verifiable work.');
  for (const [id,r] of requirements) {
    if (!text(r.statement) || !ref(r)) add('requirement',`requirements.${id}`,'Requirement needs statement, source and revision.');
    if (ref(p.authority) && (r.source!==p.authority.source || r.revision!==p.authority.revision))
      add('authority-drift',`requirements.${id}`,'Requirement differs from the declared current authority.');
    const coverage=list(p.coverage).filter(c=>c?.requirement===id);
    const excluded=list(p.exclusions).filter(c=>c?.requirement===id);
    if (coverage.length+excluded.length===0) add('omission',`requirements.${id}`,'Requirement has no work coverage or explicit exclusion.');
    if (coverage.length+excluded.length>1) add('coverage-conflict',`requirements.${id}`,'Use one coverage entry with all cooperating items, or one exclusion.');
  }
  list(p.coverage).forEach((c,i)=>{
    if (!requirements.has(c?.requirement) || !Array.isArray(c?.items) || !c.items.length || !text(c?.rationale))
      add('coverage',`coverage[${i}]`,'Reference a known requirement, nonempty item list and coverage rationale.');
    const seen=new Set();
    for (const id of list(c?.items)) {
      if (!items.has(id) || seen.has(id)) add('coverage',`coverage[${i}].items`,'Unknown or duplicate work reference.');
      seen.add(id);
    }
  });
  list(p.exclusions).forEach((e,i)=>{
    if (!requirements.has(e?.requirement) || !text(e?.reason)) add('exclusion',`exclusions[${i}]`,'Exclusions need known requirements and explicit reasons.');
    if (p.boundary?.kind==='whole') add('whole-exclusion',`exclusions[${i}]`,'A whole-project plan cannot exclude an authority requirement.');
  });
  const outcomes=new Set();
  for (const [id,item] of items) {
    const path=`items.${id}`;
    if (!text(item.repository) || !/^[^/\s]+\/[^/\s]+$/.test(item.repository) || !text(item.ownership))
      add('ownership',path,'Declare one normative owner/repository and its authority rationale.');
    if (!text(item.outcome) || !text(item.verification)) add('outcome',path,'Provide an independent observable outcome and verification.');
    else {
      const key=JSON.stringify([item.repository,item.outcome]);
      if (outcomes.has(key)) add('conflicting-work',path,'Duplicate outcome in the same repository needs consolidation or distinct boundaries.');
      outcomes.add(key);
    }
    const e=item.estimate;
    if (!obj(e) || !Number.isInteger(e.lines) || e.lines<1 || !['low','medium','high'].includes(e.confidence)
        || !text(e.basis) || (e.lines>1000 && !text(e.exception)))
      add('estimate',path+'.estimate','Supply positive maintained lines, confidence, basis and an exception reason above 1,000 lines.');
    if (!list(p.coverage).some(c=>list(c?.items).includes(id))) add('untraced-work',path,'Work has no authority coverage.');
    if (Object.hasOwn(item,'priority') || Object.hasOwn(item,'executionOrder')) add('ordering',path,'List order does not authorize product priority or execution order.');
  }
  list(p.handoffs).forEach((h,i)=>{
    if (!items.has(h?.producer) || !items.has(h?.consumer) || !text(h?.contract) || !text(h?.verification))
      add('handoff',`handoffs[${i}]`,'Name known producer/consumer, source interface and a local integration test method; no separate report is required.');
  });
  list(p.sourceInputs).forEach((source,i)=>{
    if (!items.has(source?.producer) || !items.has(source?.consumer) || !ref(source)
        || !text(source?.interface) || !Array.isArray(source?.paths) || !source.paths.length
        || source.paths.some(path=>!text(path) || path.startsWith('/') || path.split('/').includes('..')))
      add('source-input',`sourceInputs[${i}]`,'Identify known producer/consumer, actual source revision, relative paths and consumed interface.');
  });
  const graphCoverage=p.graphCoverage;
  if (!['complete','partial'].includes(graphCoverage)) add('graph-coverage','graphCoverage','Declare complete or partial observed graph coverage.');
  let bounded=graphCoverage!=='complete';
  const edges=list(p.dependencies);
  const checkEdges=(values,path)=>{
    const seen=new Set();
    values.forEach((e,i)=>{
      if (!obj(e) || !text(e.from) || !text(e.to)) {add('edge',`${path}[${i}]`,'Expected from (blocked item) and to (blocker).');return;}
      const key=edgeKey(e);
      if(seen.has(key)) add('duplicate-edge',`${path}[${i}]`,'Duplicate dependency.');
      seen.add(key);
      if(e.from===e.to) add('self-edge',`${path}[${i}]`,'An item cannot block itself.');
      if(!items.has(e.from)||!items.has(e.to)) {
        bounded=true;
        add('endpoint',`${path}[${i}]`,'Unresolved endpoint: obtain graph evidence; never assume completed.',graphCoverage==='complete'?'error':'warning');
      }
    });
    return seen;
  };
  const planned=checkEdges(edges,'dependencies'), native=checkEdges(list(p.nativeDependencies),'nativeDependencies');
  for(const k of new Set([...planned,...native])) if(planned.has(k)!==native.has(k))
    add('dependency-drift','nativeDependencies','Planned/native edge mismatch; propose review without editing native relationships.');
  const analyze=(observed,path)=>{
    const graph=new Map([...items.keys()].map(id=>[id,[]]));
    for(const e of observed) if(graph.has(e?.from)&&graph.has(e?.to))graph.get(e.from).push(e.to);
    const reaches=(start,target,skip,seen=new Set())=>{
      if(start===target)return true;
      if(seen.has(start))return false;
      seen.add(start);
      return (graph.get(start)??[]).some(to=>edgeKey({from:start,to})!==skip && reaches(to,target,skip,seen));
    };
    for(const [id,next] of graph) if(next.some(to=>reaches(to,id,null)))
      add('cycle',`${path}.${id}`,'Known observed dependency cycle.');
    for(const e of observed) {
      if(!items.has(e?.from)||!items.has(e?.to)||e.from===e.to)continue;
      if(reaches(e.from,e.to,edgeKey(e))) add('redundant-edge',path,'A known alternate path makes this direct blocker redundant; propose review only.');
      if(items.get(e.from).repository!==items.get(e.to).repository && ![...list(p.handoffs),...list(p.sourceInputs)].some(h=>h?.producer===e.to&&h?.consumer===e.from))
        add('missing-handoff','handoffs','Cross-repository dependency requires a source/interface reference (sourceInputs or legacy handoffs), not a proof package.');
    }
  };
  analyze(edges,'dependencies');
  analyze(list(p.nativeDependencies),'nativeDependencies');
  // Optional v1 extension: explicit project observations, not inferred setup truth.
  if (Array.isArray(p.projects)) {
    const projects=unique(p.projects,'projects');
    for (const [id,item] of items) if (!projects.has(item.project))
      add('project',`items.${id}.project`,'Reference one declared project when projects are supplied.');
    for (const [id,project] of projects) {
      const path=`projects.${id}`, members=[...items.values()].filter(item=>item.project===id);
      const bootstraps=members.filter(item=>item.type==='bootstrap');
      if (!members.length) add('project',path,'Project has no planned work.');
      if (!['empty','initialized'].includes(project.baseline))
        add('baseline',path,'Declare empty or initialized; baseline truth requires source inspection.');
      if (project.baseline==='initialized') {
        if (!ref(project)) add('baseline',path,'Identify the existing usable baseline source and revision.');
        if (bootstraps.length || project.bootstrap!==undefined)
          add('bootstrap',path,'Reuse the initialized baseline without another bootstrap.');
      }
      if (project.baseline==='empty') {
        const root=items.get(project.bootstrap);
        if (bootstraps.length!==1 || root?.project!==id || root?.type!=='bootstrap') {
          add('bootstrap',path,'An empty project needs exactly one declared minimal bootstrap.');
          continue;
        }
        const reaches=(start,seen=new Set())=>{
          if(start===root.id)return true;
          if(seen.has(start))return false;
          seen.add(start);
          return edges.filter(e=>e?.from===start && items.has(e?.to)).some(e=>reaches(e.to,seen));
        };
        for(const item of members) if(!reaches(item.id))
          add('bootstrap-path',`items.${item.id}`,'Every item in an empty project must depend directly or transitively on its bootstrap.');
      }
    }
  } else if ([...items.values()].some(item=>item.project!==undefined || item.type==='bootstrap')) {
    add('project','projects','Explicit project/bootstrap annotations require project declarations.');
  }
  if(bounded)add('partial-graph','graphCoverage','Only known subgraph conclusions are possible; global acyclicity/minimality is unproven.','warning');
  let resourceStatus='observed';
  if(!list(p.resources).length){resourceStatus='unknown';add('resource-observation','resources','No resource inventory supplied.','warning');}
  const resourceNames=new Set();
  list(p.resources).forEach((r,i)=>{
    if(resourceNames.has(r?.name))add('resource-conflict',`resources[${i}]`,'Duplicate resource observations need reconciliation.');
    resourceNames.add(r?.name);
    if(!obj(r)||!text(r.name)||!['tool','artifact','hook','resource'].includes(r.kind)||!['observed','unknown','unavailable','unsupported','unverified'].includes(r.status))
      add('resource',`resources[${i}]`,'Declare resource kind, name and supported observation status.');
    if(r?.status==='observed'&&!text(r.evidence))add('invented-availability',`resources[${i}]`,'Observed availability needs concrete evidence.');
    if(r?.status!=='observed'){resourceStatus='limited';add('resource-limit',`resources[${i}]`,'Resource availability is not verified; plan quality is assessed separately.','warning');}
  });
  list(p.claims).forEach((c,i)=>{
    if(!obj(c)||!['availability','target-completion','live-provider','global-graph'].includes(c.kind)||!text(c.evidence))
      add('claim',`claims[${i}]`,'Claims need a documented kind and concrete evidence.');
    if(c?.kind==='global-graph'&&bounded)add('unsafe-graph-claim',`claims[${i}]`,'Partial evidence cannot establish a global graph claim.');
    if(['target-completion','live-provider'].includes(c?.kind)&&c.origin!=='target-live')
      add('unsafe-completion',`claims[${i}]`,'Source-project, fixture and package checks cannot prove target live completion.');
    if(c?.kind==='availability'&&(!text(c.resource)||!list(p.resources).some(r=>
      obj(r)&&text(r.name)&&r.name===c.resource&&r.status==='observed'&&text(r.evidence))))
      add('unsafe-availability',`claims[${i}]`,'Availability claim lacks an observed resource.');
  });
  if(p.audit!==undefined){
    if(!obj(p.audit)||!ref(p.audit.authority)||!Array.isArray(p.audit.issues))add('audit','audit','Supply current authority and explicit Issue observations.');
    if(p.audit?.authority?.source!==p.authority?.source||p.audit?.authority?.revision!==p.authority?.revision)
      add('authority-drift','audit.authority','Current authority differs from the plan; replan coverage.');
    const issues=list(p.audit?.issues), counts=new Map();
    issues.forEach((issue,i)=>{
      const path=`audit.issues[${i}]`, item=items.get(issue?.item);
      if (!obj(issue) || !Array.isArray(issue.states) || !issue.states.length || issue.states.some(s=>!['raw','frozen','authorized','shaped','active','delivered','closed'].includes(s)))
        add('audit-state',path,'Supply explicit known lifecycle states; unknown protection status requires reauthorization/recovery review.');
      counts.set(issue?.item,(counts.get(issue?.item)??0)+1);
      const protectedWork=!Array.isArray(issue?.states) || !issue.states.length || issue.states.some(s=>s!=='raw');
      const remediation=protectedWork?'Use applicable reauthorization and safe recovery; ordinary publication approval is insufficient.':'Prepare a corrected plan for explicit publication approval.';
      const report=(code,reason)=>add(code,path,reason,'error',remediation);
      if(!item)report('extra-issue','Observed Issue has no planned work identity.');
      else {
        if(issue.repository!==item.repository)report('ownership-drift','Observed owning repository differs from the normative plan.');
        if(issue.outcome!==item.outcome)report('requirement-conflict','Observed Scope outcome differs from the planned outcome.');
      }
      if(!ref(issue?.scope)||!text(issue?.scope?.identity))report('scope-provenance','Original Scope source/revision/identity is missing.');
      if(list(issue?.states).includes('shaped') && !obj(issue?.shape))report('shape-provenance','Shaped work needs separate Shape provenance.');
      if(issue?.shape && (!ref(issue.shape)||!text(issue.shape.identity)||issue.shape.identity===issue.scope?.identity))report('conflated-provenance','Shape must preserve its separate source/revision/identity.');
    });
    for(const id of items.keys())if((counts.get(id)??0)!==1)add('audit-work',`audit.issues.${id}`,'Missing or duplicate observed work; protected work requires reauthorization/recovery before correction.');
  }
  return {ok:!diagnostics.some(d=>d.severity==='error'),graph:bounded?'known-subgraph':'complete-observation',resources:resourceStatus,diagnostics};
}
