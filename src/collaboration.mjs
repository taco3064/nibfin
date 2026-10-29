import {createPublicKey,verify} from 'node:crypto';
import {canonicalJSON} from './grants.mjs';
import {validateExecutionPool} from './execution-pool.mjs';

// Adapted from Kairo d1b47d5: owner-identity, authority, runner-binding,
// dynamic and owner-issue-session. See docs/collaboration.md for the mapping.
const need=ok=>{if(!ok)throw Error('collaboration:contract');};
const id=v=>typeof v==='string'&&/^[1-9][0-9]*$/.test(v);
const repo=v=>typeof v==='string'&&/^[a-z0-9-]+\/[a-z0-9_.-]+$/.test(v)&&!v.split('/').includes('..');
export const collaborationVersion=1;
/** Independent expected identity comes from protected configuration, never the
 * response itself. Ownership type and registration level are separate axes. */
export function verifyRepositoryIdentity(actual,expected) {
  need(expected?.version===collaborationVersion&&repo(expected.repository)&&id(expected.repositoryId));
  need(actual?.id===expected.repositoryId&&actual.full_name?.toLowerCase()===expected.repository
    &&actual.private===false&&actual.visibility==='public'
    &&['User','Organization'].includes(actual.owner?.type)
    &&(expected.ownerId!==undefined&&actual.owner.login===undefined
      ||actual.owner.login?.toLowerCase()===expected.repository.split('/')[0]));
  if(expected.ownerId!==undefined)need(id(expected.ownerId)&&actual.owner.id===expected.ownerId);
  if(expected.ownerType!==undefined)need(['User','Organization'].includes(expected.ownerType)&&actual.owner.type===expected.ownerType);
  return true;
}
/** The donor's Ed25519 check, consuming Nibfin's existing domain-separated bytes.
 * No single deployed Owner ID or donor grant schema is imported. */
export function verifyOwnerSignature(bytes,signature,publicKey) {
  try {
    const key=createPublicKey(publicKey);
    return key.asymmetricKeyType==='ed25519'&&verify(null,bytes,key,signature);
  } catch {return false;}
}
/** Registry descriptor comparison/revocation, without the donor's root-key or
 * dispatch protocol. Legacy descriptors are v1; explicit other versions fail. */
export function validateMemberBinding(record,{repositoryId,registration,executionPool}) {
  if(executionPool!==undefined){
    const pool=validateExecutionPool(executionPool);
    need(pool.targets.some(t=>t.repositoryId===repositoryId)&&registration?.level==='repository'
      &&registration.id===pool.source.repositoryId&&record?.version===2
      &&record.executionRepositoryId===pool.source.repositoryId);
  }
  need(id(repositoryId)&&registration&&['repository','organization'].includes(registration.level)&&id(registration.id)
    &&(registration.level==='repository'?executionPool!==undefined||registration.id===repositoryId:
      typeof registration.organization==='string'&&/^[a-z0-9-]+$/i.test(registration.organization)));
  need(record&&(executionPool!==undefined?record.version===2:record.version===undefined||record.version===1)
    &&(record.active===undefined||record.active===true)
    &&id(record.runnerId)&&id(record.memberId)&&record.repositoryId===repositoryId
    &&typeof record.instanceId==='string'&&record.instanceId.length>0&&record.instanceId.length<=256
    &&['linux','windows','macos'].includes(record.platform));
  const r=record.registration;
  need(r&&r.level===registration.level&&r.id===registration.id);
  if(r.level==='organization')need(typeof r.organization==='string'
    &&r.organization.toLowerCase()===registration.organization.toLowerCase());
  return record;
}
/** Donor prerequisiteIds DFS, adapted to bounded async GitHub reads. Traversal
 * is scoped to one target; completion and per-target authorization stay with
 * createDependencyEvaluator. No queue, local Store or second state authority. */
export function prerequisiteTraversal({key,enter,leave,limit,cycle}) {
  const visiting=new Set(),visited=new Set();
  async function walk(node,depth=0,upstream=false) {
    const k=key(node);
    if(visiting.has(k))cycle(node);
    if(visited.has(k))return;
    limit(node,depth,visited.size+visiting.size);
    visiting.add(k);
    const parents=await enter(node,depth,upstream);
    for(const parent of parents)await walk(parent,depth+1,true);
    await leave(node,upstream);
    visiting.delete(k);visited.add(k);
  }
  return walk;
}
/** Donor session completion/readback check, projected onto the existing custody
 * result. A wakeup never changes the operation, principal or retained candidate.
 * The caller owns durable intents and independent role execution. */
export function verifySessionResult(value,request) {
  need(value?.version===1&&canonicalJSON(value.target)===canonicalJSON(request.target)
    &&value.cycle===request.cycle&&value.request===request.request
    &&canonicalJSON(value.run)===canonicalJSON(request.run)
    &&canonicalJSON(value.requested)===canonicalJSON(request.expected)
    &&['completed','blocked','waiting','superseded','rejected','unresolved'].includes(value.disposition));
  return true;
}
