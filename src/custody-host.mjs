import {canonicalJSON, contentIdentity, byteDigest, githubId, repositoryCoordinates,
  prepareCustodyManifest, validateCustodyManifest, createArtifactCustody, publishCustody,
  skillForRole, compareEvidence,compareStageCollection,safeObligationPath} from './index.mjs';
import {readCustodyZip} from './custody-zip.mjs';

const same=(a,b)=>canonicalJSON(a)===canonicalJSON(b);
const need=ok=>{if(!ok)throw Error('custody-host:unresolved');};
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const word=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,256}$/.test(v);
const fields=(v,keys)=>need(v&&same(Object.keys(v).sort(),keys.split(' ').sort()));
const copy=v=>JSON.parse(canonicalJSON(v));
const kinds=['resolution','stage-attempt','stage-result','registration-intent','registration-result','registration-response','registration-publication','role-output','verification','repair-input'];
const statuses=['diagnostic','capacity-failure','validation-failure','unknown-write','validated'];
function repository(v){const p=v?.split('/');need(p?.length===2&&repositoryCoordinates(...p).key===v);}
/** Independent expectations are protected Core configuration, not retained JSON. */
export function custodySlotIdentity(slot) {
  fields(slot,'kind key binding');need(kinds.includes(slot.kind)&&word(slot.key));
  const b=slot.binding;
  if(b?.purpose==='registration') {
    fields(b,'purpose source request');fields(b.source,'repository repositoryId revision runId attempt');
    repository(b.source.repository);for(const k of ['repositoryId','runId','attempt'])githubId(b.source[k]);
    need(/^[a-f0-9]{40}$/.test(b.source.revision)&&hash(b.request)
      &&['registration-intent','registration-result','registration-response','registration-publication'].includes(slot.kind));
    return contentIdentity(slot);
  }
  fields(b,'source target requirements authorization cycle role stage request result candidate');
  fields(b.source,'repository repositoryId revision runId attempt');repository(b.source.repository);
  for(const k of ['repositoryId','runId','attempt'])githubId(b.source[k]);
  need(/^[a-f0-9]{40}$/.test(b.source.revision));
  fields(b.target,'repository repositoryId issueId');repository(b.target.repository);githubId(b.target.repositoryId);need(word(b.target.issueId));
  fields(b.requirements,'revision scopeHash shapeHash');
  need(hash(b.requirements.revision)&&hash(b.requirements.scopeHash)
    &&(hash(b.requirements.shapeHash)||b.requirements.shapeHash===null&&['shape','authorization'].includes(b.stage)));
  need(hash(b.authorization)&&[b.cycle,b.stage,b.request,b.result].every(word));
  skillForRole(b.role);need(['resolve','registration','authorization','shape','shape-validator','shape-diagnosis','publication','deliver',
    'pre-accept-hooks','accept','pre-commit-hooks','pr','ci','shaper-review','merge','final','closure','delivered','fanout','recovery','repair'].includes(b.stage));
  need(b.candidate===null||b.candidate&&hash(b.candidate.identity)&&Array.isArray(b.candidate.payloads)
    &&b.candidate.payloads.length<=64&&b.candidate.payloads.every(p=>safeObligationPath(p.path)&&p.path!=='host-record.json'&&hash(p.digest))
    &&new Set(b.candidate.payloads.map(p=>p.path)).size===b.candidate.payloads.length);
  if(b.candidate!==null){fields(b.candidate,'identity payloads');for(const p of b.candidate.payloads)fields(p,'path digest');}
  return contentIdentity(slot);
}
function binding(slot,phase) {
  const b=slot.binding,s=b.source;
  if(b.purpose==='registration') return {purpose:'registration',...s,request:b.request,phase};
  return {repository:s.repository,repositoryId:s.repositoryId,issueId:b.target.issueId,cycle:b.cycle,
    scopeHash:b.requirements.scopeHash,shapeHash:b.requirements.shapeHash,authorization:b.authorization,
    runId:s.runId,attempt:s.attempt,stage:b.requirements.shapeHash===null?'authorization':'candidate',result:phase+'-'+custodySlotIdentity(slot),candidate:phase==='result'?b.candidate:null};
}
function name(slot,phase){return 'nibfin-'+phase+'-'+custodySlotIdentity(slot);}
function payload(slot,phase,value,attachments=new Map()){
  need(attachments instanceof Map);
  const files=new Map([...attachments].map(([path,bytes])=>[path,Buffer.from(bytes)]));
  need(!files.has('host-record.json'));files.set('host-record.json',Buffer.from(canonicalJSON({version:1,slot,phase,value})));return files;
}
function checkedRecord(result,slot,phase) {
  need(result.outcome==='retrieved'&&result.payloads.size===1+(phase==='result'?(slot.binding.candidate?.payloads.length??0):0));
  const r=JSON.parse(result.payloads.get('host-record.json').toString('utf8'));
  fields(r,'version slot phase value');need(r.version===1&&r.phase===phase&&same(r.slot,slot));
  return r.value;
}
/** A deterministic provider-backed discovery. Metadata/source/content are all checked;
 * names locate candidates but never authenticate their bytes. No latest-name selection.
 */
export function createCustodyHost({provider,archive,expect,publication,authorizeNew,
  now=Date.now,maxBytes=1024*1024,maxFiles=8,timeoutMs=30000,retentionDays=7,secrets=[]}={}) {
  need(typeof expect==='function'&&typeof authorizeNew==='function'&&typeof publication==='function'
    &&typeof provider?.request==='function'&&typeof provider?.collection==='function'&&typeof archive==='function');
  need([maxBytes,maxFiles,timeoutMs,retentionDays].every(n=>Number.isSafeInteger(n)&&n>0)
    &&maxBytes<=16*1024*1024&&maxFiles<=256&&timeoutMs<=300000&&retentionDays<=90
    &&Array.isArray(secrets)&&secrets.every(s=>typeof s==='string'&&s.length>0));
  const custody=createArtifactCustody({provider,archive,now,maxBytes,maxFiles,timeoutMs});
  const attempted=new Set();let busy=false;
  const safe=value=>{
    const text=canonicalJSON(value);need(Buffer.byteLength(text)<=maxBytes);
    // Reject, never silently rewrite exact role output. Only public-safe bytes may
    // enter Actions artifacts. Diagnostic errors below contain no supplied strings.
    need(!secrets.some(s=>text.includes(s))&&!/https?:\/\/[^\s"<>]*\?[^\s"<>]+|Bearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})/.test(text));
  };
  async function slotFor(argument) {
    const slot=copy(await expect({kind:argument.kind,key:argument.key}));
    const id=custodySlotIdentity(slot);
    need(slot.kind===argument.kind&&(argument.key===slot.key||argument.key===id));
    if(argument.identity){const target=slot.binding.purpose==='registration'?slot.binding.source:slot.binding.target;
      need(argument.identity.repository===target.repository&&argument.identity.repositoryId===target.repositoryId);}
    return slot;
  }
  async function discover(slot,phase,signal) {
    const expected=binding(slot,phase),s=slot.binding.source;
    const options={method:'GET',signal,operation:'custody-discovery',correlation:custodySlotIdentity(slot),target:s.repositoryId};
    const repo=await provider.request({...options,endpoint:`/repos/${s.repository}`});
    need(!signal.aborted&&repo.outcome==='read'&&repo.data.id===s.repositoryId
      &&repo.data.full_name?.toLowerCase()===s.repository&&repo.data.private===false);
    const attempt=await provider.request({...options,endpoint:`/repos/${s.repository}/actions/runs/${s.runId}/attempts/${s.attempt}`});
    const run=attempt.data;
    need(!signal.aborted&&attempt.outcome==='read'&&run.id===s.runId
      &&Number.isSafeInteger(run.run_attempt)&&String(run.run_attempt)===s.attempt
      &&run.head_sha===s.revision&&run.repository?.id===s.repositoryId
      &&run.repository?.full_name?.toLowerCase()===s.repository&&run.repository?.private===false);
    const path=`/repos/${s.repository}/actions/runs/${s.runId}/artifacts`;
    let total;
    const listing=await provider.collection({endpoint:path+'?per_page=100',envelope:'artifacts',signal,
      operation:'custody-discovery',correlation:custodySlotIdentity(slot),target:s.repositoryId,
      allowPage:p=>p.split('?')[0]===path,validate:d=>{
        if(!Number.isSafeInteger(d?.total_count)||d.total_count<0||d.total_count>1000||total!==undefined&&total!==d.total_count)return false;
        total=d.total_count;return true;
      }});
    need(!signal.aborted&&listing.outcome==='complete'&&listing.data.length===total
      &&new Set(listing.data.map(a=>a.id)).size===total);
    const matches=listing.data.filter(a=>a.name===name(slot,phase));
    need(matches.length<=1);if(!matches.length)return null;
    const m=matches[0];githubId(m.id);
    need(m.expired===false&&Date.parse(m.expires_at)>now()&&m.workflow_run?.id===s.runId
      &&m.workflow_run?.repository_id===s.repositoryId&&Number.isSafeInteger(m.size_in_bytes)
      &&m.size_in_bytes>0&&m.size_in_bytes<=maxBytes&&/^sha256:[a-f0-9]{64}$/.test(m.digest));
    const downloaded=await archive({endpoint:`/repos/${s.repository}/actions/artifacts/${m.id}/zip`,signal,maxBytes});
    need(!signal.aborted&&downloaded.status===200&&downloaded.bytes instanceof Uint8Array
      &&downloaded.bytes.length===m.size_in_bytes&&'sha256:'+byteDigest(downloaded.bytes)===m.digest);
    const files=readCustodyZip(downloaded.bytes,{maxBytes,maxFiles});
    const manifest=JSON.parse(files.get('custody-manifest.json').toString('utf8'));files.delete('custody-manifest.json');
    validateCustodyManifest(manifest,expected,files);
    const ref={repository:s.repository,repositoryId:s.repositoryId,runId:s.runId,artifactId:m.id,
      manifestIdentity:contentIdentity(manifest),archiveDigest:byteDigest(downloaded.bytes)};
    // Reuse the downloaded immutable bytes, but independently re-read repository,
    // complete listing and artifact metadata through the existing custody verifier.
    const verified=createArtifactCustody({provider,archive:async()=>downloaded,now,maxBytes,maxFiles,timeoutMs});
    const result=await verified.retrieve({ref,expected,signal});
    const value=checkedRecord(result,slot,phase);safe(value);
    const attachments=new Map(result.payloads);attachments.delete('host-record.json');
    for(const bytes of attachments.values())safe(bytes.toString('utf8'));
    return {ref,value,payloads:attachments};
  }
  async function publish(slot,phase,value,signal,attachments,trace) {
    safe(value);const expected=binding(slot,phase),payloads=payload(slot,phase,value,attachments);
    const manifest=prepareCustodyManifest(expected,payloads);
    const facilities=await publication({slot:copy(slot),phase,expected:copy(expected),signal});
    // Capabilities only. Do not permit deployment to override manifests or limits.
    const result=await publishCustody({manifest,payloads,expected,client:facilities?.client,runtime:facilities?.runtime,
      custody,name:name(slot,phase),retentionDays,signal,timeoutMs,maxBytes});
    if(result.ref&&trace)trace.refs[phase]=copy(result.ref);
    need(result.outcome==='retained');return result.ref;
  }
  async function perform(argument,write,signal,trace) {
    const slot=await slotFor(argument),id=custodySlotIdentity(slot);trace.key=id;
    if(write){
      const files=payload(slot,'result',argument.value,argument.payloads);
      const manifest=prepareCustodyManifest(binding(slot,'result'),files);
      need(files.size===1+(slot.binding.candidate?.payloads.length??0)&&files.size+1<=maxFiles
        &&Buffer.byteLength(canonicalJSON(manifest))+[...files.values()].reduce((n,b)=>n+b.length,0)<=maxBytes);
      for(const bytes of files.values())safe(bytes.toString('utf8'));
    }
    const intent=await discover(slot,'intent',signal);
    const found=await discover(slot,'result',signal);
    if(found){
      fields(intent?.value,'resultDigest');need(intent.value.resultDigest===contentIdentity(found.value));
      if(write)need(same(found.value,argument.value));return {outcome:'recovered',key:id,slot:copy(slot),value:found.value,ref:found.ref,payloads:found.payloads};}
    if(!write)return {outcome:'unresolved',key:id,diagnostic:{kind:'missing-result'}};
    safe(argument.value);
    // A missing listing is never newness. The independent Core checkpoint must
    // positively authorize THIS first attempt, under native Actions concurrency.
    need(!attempted.has(id));
    if(intent)return {outcome:'unresolved',key:id,diagnostic:{kind:'publication-unknown'}};
    if(argument.identity)need(argument.identity.run?.id===slot.binding.source.runId
      &&argument.identity.run?.attempt===slot.binding.source.attempt);
    need(await authorizeNew(copy(slot),{signal})===true&&!signal.aborted);
    attempted.add(id); // reserve before any asynchronous external publication
    await publish(slot,'intent',{resultDigest:contentIdentity(argument.value)},signal,undefined,trace);
    const ref=await publish(slot,'result',argument.value,signal,argument.payloads,trace);
    return {outcome:'retained',key:id,ref};
  }
  async function run(argument,write) {
    if(busy)return {outcome:'unresolved',diagnostic:{kind:'busy'}};
    busy=true;
    const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(),timeoutMs);
    let signal=timeout.signal,abort;const trace={refs:{}};
    try {
      need(argument&&typeof argument==='object');
      if(argument.signal!==undefined){need(argument.signal instanceof AbortSignal);signal=AbortSignal.any([timeout.signal,argument.signal]);}
      need(!signal.aborted);
      // Bound even a misbehaving injected transport. It receives the abort signal;
      // publishCustody owns deferred upload-file cleanup until its SDK settles.
      return await Promise.race([perform(argument,write,signal,trace),new Promise((_,reject)=>{
        abort=()=>reject(Error('cancelled'));signal.addEventListener('abort',abort,{once:true});
      })]);
    } catch {return {outcome:'unresolved',...(trace.key?{key:trace.key}:{}),
      ...(Object.keys(trace.refs).length?{refs:copy(trace.refs)}:{}),diagnostic:{kind:signal.aborted?(argument?.signal?.aborted?'cancelled':'timeout'):'invalid-or-unavailable'}};}
    finally {clearTimeout(timer);if(abort)signal.removeEventListener('abort',abort);busy=false;}
  }
  return Object.freeze({retain:argument=>run(argument,true),recover:argument=>run(argument,false),
    async beginStage(argument){
      // A fresh workflow never relaunches an original stage merely because the
      // final process output vanished or a current-state callback is stale.
      const query={key:argument.key,identity:argument.identity,signal:argument.signal};
      const result=await run({...query,kind:'stage-result'},false);
      if(result.outcome==='recovered')return result;
      if(result.diagnostic?.kind!=='missing-result')return {outcome:'unresolved'};
      const prior=await run({...query,kind:'stage-attempt'},false);
      if(prior.outcome==='recovered'||prior.diagnostic?.kind!=='missing-result')return {outcome:'unresolved'};
      const attempt=await run({...query,kind:'stage-attempt',value:argument.value},true);
      return attempt.outcome==='retained'?{outcome:'started'}:{outcome:'unresolved'};
    },
    // These two callbacks plug directly into maintained protected-host capabilities.
    async retainValue(argument){const r=await run(argument,true);need(['retained','recovered'].includes(r.outcome));return r.key;},
    async retrieve(argument){const r=await run(argument,false);need(r.outcome==='recovered');return r.value;}});
}

/** Hydrate only independently named destinations. Retained values never select
 * current expectations, authorization, role or a new invocation. */
export function createCustodyCurrent({load,custody}={}) {
  need(typeof load==='function'&&typeof custody?.retrieve==='function');
  return async()=>{
    const {pin,records}=await load();const value=structuredClone(pin);
    need(Array.isArray(records)&&records.length<=64);
    const seen=new Set();
    for(const record of records) {
      fields(record,'destination query expected');
      need(['prior','stageInput',...Object.keys(value.evidenceCurrent??{}).map(k=>'receipts.'+k)].includes(record.destination)
        &&!seen.has(record.destination));seen.add(record.destination);
      const recovered=await custody.retrieve(record.query);
      need(contentIdentity(recovered)===record.expected.digest);
      if(record.destination.startsWith('receipts.')) {
        const stage=record.destination.slice(9);
        value.receipts[stage]=compareEvidence(recovered,value.evidenceCurrent[stage]);
      } else value[record.destination]=recovered;
    }
    return value;
  };
}

/** Diagnostic/repair data has an explicit original status. This is never a
 * stage evidence envelope and cannot satisfy compareEvidence/Acceptance. */
export function retainedRoleRecord({status,output=null,verification=[],repair=null}={}) {
  need(statuses.includes(status)&&Array.isArray(verification)&&verification.length<=32);
  for(const v of verification){fields(v,'command digest outcome log');need(typeof v.command==='string'&&v.command.length<=1024
    &&hash(v.digest)&&['passed','failed','cancelled','budget-exhausted','unrun'].includes(v.outcome)
    &&typeof v.log==='string'&&Buffer.byteLength(v.log)<=8192);}
  need(output===null||typeof output==='string'&&Buffer.byteLength(output)<=131072);
  need(status!=='validated'||output!==null);
  return copy({version:1,status,output,verification,repair});
}

/** Wrap an existing role backend's collection boundary, before its final process
 * response can be lost. A fresh wrapper can collect retained bytes without a
 * producer process. Lifecycle still independently validates the recovered evidence.
 */
export function createRetainedRoleBackend({backend,custody,query}={}) {
  need(typeof custody?.retain==='function'&&typeof custody?.recover==='function'&&typeof query==='function');
  const wrapped={};
  for(const op of ['readiness','start','stop','termination','cleanup']) {
    need(typeof backend?.[op]==='function');wrapped[op]=backend[op].bind(backend);
  }
  need(typeof backend?.collect==='function');
  wrapped.collect=async input=>{
    try {
      const q=await query(structuredClone(input));
      need(q.kind==='role-output');
      const held=await custody.recover(q);
      if(held.outcome==='recovered') {
        const r=held.value;
        fields(r,'version status output verification repair');need(r.version===1&&statuses.includes(r.status));
        // The original result is revalidated by createAgentLifecycle, never its
        // producer's status. Invalid/rejected output remains diagnostic data.
        const value=JSON.parse(r.output);fields(value,'status exitCode evidence');
        need(value.status==='complete'&&Number.isSafeInteger(value.exitCode));return value;
      }
      const result=await backend.collect(structuredClone(input));
      if(result?.status==='pending')return {status:'pending',exitCode:null,evidence:null};
      fields(result,'status exitCode evidence');need(result.status==='complete'&&Number.isSafeInteger(result.exitCode));
      const record=retainedRoleRecord({status:result.exitCode===0?'diagnostic':'validation-failure',output:canonicalJSON(result)});
      const retained=await custody.retain({...q,value:record});
      need(['retained','recovered'].includes(retained.outcome));return result;
    } catch {return {status:'pending',exitCode:null,evidence:null};}
  };
  return Object.freeze(wrapped);
}


/** Fresh validation of retained role output, including rejected collections.
 * No producer validation status is inherited and no role is relaunched. */
export async function recoverRoleCollection({custody,query,current,context={}}={}) {
  try {
    need(query?.kind==='role-output'&&typeof custody?.recover==='function');
    const held=await custody.recover(query);need(held.outcome==='recovered');
    const record=held.value;fields(record,'version status output verification repair');
    need(record.version===1&&statuses.includes(record.status));
    const output=JSON.parse(record.output);fields(output,'status exitCode evidence');
    need(output.status==='complete'&&output.exitCode===0&&output.evidence);
    const b=held.slot.binding,v=output.evidence;
    need(v.stage===b.stage&&v.execution?.role===b.role&&v.execution?.request===b.request&&v.execution?.result===b.result
      &&v.binding?.repositoryId===b.target.repositoryId&&v.binding?.issueId===b.target.issueId
      &&v.binding?.scopeHash===b.requirements.scopeHash&&v.binding?.shapeHash===b.requirements.shapeHash
      &&v.binding?.grant===b.authorization
      &&(b.candidate===null||contentIdentity(v.inputs?.candidate)===b.candidate.identity));
    if(v.execution.source)need(v.execution.source.repositoryId===b.source.repositoryId
      &&v.execution.source.runId===b.source.runId&&v.execution.source.attempt===b.source.attempt);
    const checked=compareStageCollection(v,current,context);
    return checked.status==='valid'?{outcome:'validated',evidence:checked.evidence}
      :{outcome:'rejected',collection:checked.collection};
  } catch {return {outcome:'blocked',diagnostic:{kind:'invalid-or-unavailable'}};}
}
