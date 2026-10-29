import { createPublicKey, verify, createHash } from 'node:crypto';
import { canonical, digest } from './core.mjs';
import { Store } from './store.mjs';

const verified=new WeakSet(),attached=new WeakMap();
const need=(v,code)=>{if(!v)throw Object.assign(new Error(code),{code});};
const same=(a,b)=>canonical(a)===canonical(b),hash=x=>/^[a-f0-9]{64}$/.test(x||'');
const sorted=x=>[...x].sort();
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
export const websiteTargets=Object.freeze([
  Object.freeze({number:46,issueId:'I_kwDOVRsWxs8AAAABZBxG0A',databaseId:5974542032,oldRawHash:'4b890f9612693876fa412dbcb9bef58ba060dc16ad7baae3d314ee0cbd63f9fd',newRawHash:'7c25438e8f848542b8c7faeea57b7321682f3c514fdcf19f866db85ed0124f83'}),
  Object.freeze({number:52,issueId:'I_kwDOVRsWxs8AAAABZBxTsw',databaseId:5974545331,oldRawHash:'6e0864b7fd09035c5e24fd3b854a747232b84284e9e4251e296a853be75d3ed0',newRawHash:'5080298e922a61245ef7e79b276f87a03defdbb371e29189a16ff5e59fb8214c'})
]);
export const rawBodyHash=s=>createHash('sha256').update(s,'utf8').digest('hex');
export const websiteRevisionStore=(root,g)=>new Store(root,'website-requirement-revision:'+g.recordId);
export function verifyWebsiteRevision(bundle,g,key,priorSixHash,priorAssigneeHash){
 const p=bundle?.payload,k=createPublicKey(key);
 need(p&&k.asymmetricKeyType==='ed25519'&&verify(null,Buffer.from(canonical(p)),k,Buffer.from(bundle.signature||'','base64')),'WEBSITE_SIGNATURE_INVALID');
 need(p.schemaVersion===1&&p.kind==='owner-website-requirement-revision'&&p.profile==='nibfin-website-46-52-20261024'&&g.approval?.verified&&g.policy.controlMode==='owner-project'&&
  p.parentRecordId===g.recordId&&p.parentManifestHash===digest(g.manifest)&&p.parentPolicyHash===digest(g.policy)&&p.parentPayloadHash===digest(Object.fromEntries(Object.entries(g).filter(([k])=>k!=='approval')))&&
  hash(priorSixHash)&&hash(priorAssigneeHash)&&p.priorSixRevisionHash===priorSixHash&&p.priorAssigneeRevisionHash===priorAssigneeHash,'WEBSITE_PARENT_INVALID');
 need(hash(p.planHash)&&hash(p.requiredCoreDigest)&&hash(p.priorSixJournalHash)&&hash(p.priorAssigneeJournalHash)&&typeof p.proposal==='string'&&p.proposal.trim()&&digest(p.proposal)===p.proposalHash&&p.proposalRevision==='v0.12.0'&&
  [p.recordId,p.freezeRevision,p.cycleRevision].every(x=>typeof x==='string'&&x.trim())&&p.recordId!==g.recordId&&p.freezeRevision!==g.manifest.freezeRevision&&p.cycleRevision!==g.policy.revision,'WEBSITE_AUTHORITY_INVALID');
 need(Array.isArray(p.subjects)&&p.subjects.length===2&&same(sorted(p.subjects.map(s=>s.issueId)),sorted(websiteTargets.map(s=>s.issueId)))&&
  same(p.operations,['replace-46-body','replace-52-body']),'WEBSITE_SUBJECTS_INVALID');
 for(const s of p.subjects){const t=websiteTargets.find(t=>t.issueId===s.issueId),i=g.manifest.issues.find(i=>i.id===s.issueId);
  need(t&&i&&s.number===t.number&&i.number===t.number&&s.databaseId===t.databaseId&&s.repository==='taco3064/nibfin'&&i.repository===s.repository&&s.repositoryId==='1427838662'&&i.repositoryId===s.repositoryId&&
   s.oldScopeHash===i.scopeHash&&s.oldBodyHash===i.scopeHash&&rawBodyHash(i.scopeBody)===t.oldRawHash&&s.oldRawBodyHash===t.oldRawHash&&typeof s.newScopeBody==='string'&&rawBodyHash(s.newScopeBody)===t.newRawHash&&
   s.newRawBodyHash===t.newRawHash&&digest(s.newScopeBody)===s.newScopeHash&&hash(s.oldStateHash)&&s.oldShapeHash===null&&s.oldMetadata?.state==='open'&&same(s.oldMetadata.labels,['scope'])&&
   same(s.oldMetadata.assignees,[])&&s.oldMetadata.milestone===null&&Array.isArray(s.oldMetadata.projects)&&s.metadataHash===digest(s.oldMetadata)&&s.oldStateReason===null&&
   Array.isArray(s.blockedBy)&&Array.isArray(s.blocking)&&new Set(s.blockedBy).size===s.blockedBy.length&&new Set(s.blocking).size===s.blocking.length&&
   s.deploymentDisposition===(s.number===46?'source-only':'required'),'WEBSITE_SCOPE_INVALID');
 }
 const affected=new Set(p.subjects.map(s=>s.issueId)),edges=new Set();for(const s of p.subjects){for(const x of s.blockedBy)edges.add(x+':'+s.issueId);for(const x of s.blocking)edges.add(s.issueId+':'+x);}
 const scope=id=>p.subjects.find(s=>s.issueId===id)?.newScopeHash||g.manifest.issues.find(i=>i.id===id)?.scopeHash;
 need(Array.isArray(p.compatibility)&&p.compatibility.length===edges.size&&new Set(p.compatibility.map(e=>e.producer+':'+e.consumer)).size===edges.size&&p.compatibility.every(e=>edges.has(e.producer+':'+e.consumer)&&hash(scope(e.producer))&&hash(scope(e.consumer))&&e.producerScopeHash===scope(e.producer)&&e.consumerScopeHash===scope(e.consumer)),'WEBSITE_COMPATIBILITY_INVALID');
 need(Array.isArray(p.unaffected)&&p.unaffected.length===g.manifest.issues.length-2&&same(sorted(p.unaffected.map(x=>x.issueId)),sorted(g.manifest.issues.filter(i=>!affected.has(i.id)).map(i=>i.id)))&&
  p.unaffected.every(x=>hash(x.stateHash)&&hash(x.projectionHash)&&typeof x.unitId==='string')&&p.unaffectedHash===digest(p.unaffected),'WEBSITE_UNAFFECTED_INVALID');
 const r=freeze({...structuredClone(p),revisionHash:digest(bundle)});verified.add(r);return r;
}
export function attachWebsiteRevision(g,r){need(verified.has(r),'WEBSITE_UNVERIFIED');attached.set(g,r);return g;}
export const websiteRevisionFor=(g,i)=>{const r=attached.get(g),s=r?.subjects.find(s=>s.issueId===i.id);return s?{...s,revisionHash:r.revisionHash}:null;};
export function websiteRevisionProjection(g,i){const s=websiteRevisionFor(g,i),r=attached.get(g);return s?{issue:{...i,scopeBody:s.newScopeBody,scopeHash:s.newScopeHash},recordId:r.recordId,cycleRevision:r.cycleRevision,freezeRevision:r.freezeRevision,proposalRevision:r.proposalRevision,proposal:r.proposal,proposalHash:r.proposalHash,revisionHash:r.revisionHash,
 issueDeployment:{mode:s.deploymentDisposition,issueId:s.issueId,revisionHash:r.revisionHash,baseline:'preserve-repository'}}:null;}
function active(s,r){need(r&&s.phase==='active'&&s.revisionHash===r.revisionHash&&same(s.subjects,r.subjects.map(s=>s.issueId))&&s.activation?.revisionHash===r.revisionHash&&Number.isFinite(Date.parse(s.activation.at))&&
 s.activation.archivesHash===digest(s.archives)&&s.activation.operationsHash===digest(s.operations)&&same(s.operations.map(o=>o.id),r.operations)&&s.operations.every(o=>o.status==='matching')&&s.archives.length===2,'WEBSITE_MIGRATION_HELD');}
export async function websiteRevisionBoundary(runtime,g,i){if(!websiteTargets.some(s=>s.issueId===i.id))return null;const r=attached.get(g),s=await websiteRevisionStore(runtime.config.stateDirectory,g).read();if(!r&&!s.revisionHash)return null;need(r?.subjects.some(s=>s.issueId===i.id),'WEBSITE_MIGRATION_HELD');active(s,r);return{revisionHash:r.revisionHash,activatedAt:Date.parse(s.activation.at),activationAt:s.activation.at};}
export async function assertWebsiteRevision(runtime,g,i,requested){const b=await websiteRevisionBoundary(runtime,g,i);if(!b)return null;need(runtime.installedCoreDigest===attached.get(g).requiredCoreDigest,'WEBSITE_CORE_NOT_INSTALLED');if(requested!==undefined)need(requested===b.revisionHash,'STALE_WEBSITE_REQUEST');need(runtime.actionIdentity?.runId,'WEBSITE_FRESH_ACTION_REQUIRED');const run=await runtime.github.api('/repos/'+g.policy.actionExecution.repository+'/actions/runs/'+runtime.actionIdentity.runId);need(String(run.id)===String(runtime.actionIdentity.runId)&&Date.parse(run.created_at)>=b.activatedAt,'STALE_WEBSITE_RUN');return b.revisionHash;}
export async function websiteRevisionDependency(runtime,g,a,b){const r=attached.get(g),state=await websiteRevisionStore(runtime.config.stateDirectory,g).read();const relevant=websiteTargets.some(t=>t.issueId===a.id||t.issueId===b.id);if(!relevant||!r&&!state.revisionHash)return null;active(state,r);const scope=i=>websiteRevisionFor(g,i)?.newScopeHash||i.scopeHash;need(r.compatibility.some(e=>e.producer===a.id&&e.consumer===b.id&&e.producerScopeHash===scope(a)&&e.consumerScopeHash===scope(b)),'WEBSITE_CROSS_CYCLE_DENIED');return true;}
async function observe(record,host,done){const evidence=[];for(const s of record.subjects){const o=await host.observe(s),changed=done.has('replace-'+s.number+'-body');need(o?.complete===true&&o.issueId===s.issueId&&o.repositoryId===s.repositoryId&&o.databaseId===s.databaseId&&o.bodyHash===(changed?s.newScopeHash:s.oldBodyHash)&&rawBodyHash(o.body)===(changed?s.newRawBodyHash:s.oldRawBodyHash)&&same(o.metadata,s.oldMetadata)&&o.metadataHash===s.metadataHash&&o.stateReason===s.oldStateReason&&same(sorted(o.blockedBy),sorted(s.blockedBy))&&same(sorted(o.blocking),sorted(s.blocking))&&Array.isArray(o.evidence)&&o.evidence.length,'WEBSITE_PROVIDER_DRIFT');evidence.push(...o.evidence);}return evidence;}
export async function migrateWebsiteRequirements(record,host){
 need(verified.has(record),'WEBSITE_UNVERIFIED');need(host.installedCoreDigest===record.requiredCoreDigest,'WEBSITE_CORE_NOT_INSTALLED');
 return host.store.lease(()=>host.withSubjectLeases(record.subjects,async()=>{
  let state=await host.store.read();const save=async patch=>{state=await host.store.transaction(state.revision,s=>({...s,...patch}));await host.syncJournal();};
  const validate=async()=>{await host.authorize(record);await host.verifyUnaffected(record.unaffected);};await validate();
  if(!state.revisionHash){await observe(record,host,new Set());const archives=[];for(const s of record.subjects){const h=await host.history(s);need(h.stateHash===s.oldStateHash&&h.pending===null&&!h.candidate&&!h.completed&&h.shapeHash===null&&h.quiescent===true,'WEBSITE_OLD_CYCLE_NOT_QUIESCENT');const a=await host.archive(s,h);need(a.issueId===s.issueId&&hash(a.digest)&&a.verified===true,'WEBSITE_ARCHIVE_UNVERIFIED');archives.push(a);}await save({phase:'fenced',revisionHash:record.revisionHash,subjects:record.subjects.map(s=>s.issueId),archives,operations:record.operations.map(id=>({id,status:'intent'}))});}
  need(state.revisionHash===record.revisionHash&&same(state.subjects,record.subjects.map(s=>s.issueId))&&same(state.operations?.map(o=>o.id),record.operations)&&state.archives?.length===2&&['fenced','active'].includes(state.phase),'WEBSITE_JOURNAL_INVALID');
  let frontier=false,uncertain=false;for(const o of state.operations){if(o.status==='matching')need(!frontier&&o.evidence?.length,'WEBSITE_JOURNAL_INVALID');else if(o.status==='intent')frontier=true;else{need(['attempted','unknown'].includes(o.status)&&!frontier&&!uncertain,'WEBSITE_JOURNAL_INVALID');frontier=true;uncertain=true;}}
  await host.verifyArchives(state.archives);if(state.phase==='active'){active(state,record);await observe(record,host,new Set(record.operations));await validate();return{status:'ACTIVE',revisionHash:record.revisionHash};}
  for(const id of record.operations){let op=state.operations.find(x=>x.id===id);if(op.status==='matching')continue;const done=new Set(state.operations.filter(x=>x.status==='matching').map(x=>x.id));const update=async patch=>{await save({operations:state.operations.map(x=>x.id===id?{...x,...patch}:x)});op=state.operations.find(x=>x.id===id);};
   if(op.status==='intent'){await observe(record,host,done);await validate();await host.verifyArchives(state.archives);await update({status:'attempted'});try{await host.mutate(id,record);}catch{await update({status:'unknown'});throw Object.assign(new Error('WEBSITE_WRITE_OUTCOME_UNKNOWN'),{code:'WEBSITE_WRITE_OUTCOME_UNKNOWN'});}}
   done.add(id);const evidence=await observe(record,host,done);await update({status:'matching',evidence});}
  await validate();await host.verifyArchives(state.archives);await observe(record,host,new Set(record.operations));await save({phase:'active',activation:{revisionHash:record.revisionHash,at:new Date().toISOString(),archivesHash:digest(state.archives),operationsHash:digest(state.operations)}});return{status:'ACTIVE',revisionHash:record.revisionHash};
 }));
}
