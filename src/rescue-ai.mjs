// Typed original-role plan and immutable-target rechecks adapted from Kairo PR54.
import {contentIdentity} from './evidence.mjs';
import {githubId,repositoryCoordinates} from './index.mjs';
import {rescueNeed as need,rescueSame as same,rescueHash} from './rescue-policy.mjs';
export function validateAiRepairPlan(result) {
  need(result?.outcome==='ready'&&['external_failure','implementation_defect'].includes(result.failureClass)
    &&Array.isArray(result.contractConflicts)&&!result.contractConflicts.length
    &&Array.isArray(result.evidenceReferences)&&result.evidenceReferences.length>0
    &&typeof result.rootCause==='string'&&result.rootCause.trim(),'ai-unresolved');
  let p;try{p=JSON.parse(result.body);}catch{need(false,'ai-plan');}
  need(p&&Object.keys(p).sort().join(',')==='action,steps'&&p.action==='retry-original-role'
    &&Array.isArray(p.steps)&&p.steps.length>=1&&p.steps.length<=8
    &&p.steps.every(s=>typeof s==='string'&&s.trim()&&s.length<=1500),'ai-plan');
  return structuredClone(p);
}
export function validateRescueTarget(t) {
  need(t&&Object.keys(t).sort().join(' ')==='access adapter authority candidate cycle execution issueId memberId number repository repositoryId requirements role runnerId runnerMemberId scopeHash session sessionMemberId shapeHash source status','target-fields');
  const parts=t.repository?.split('/');need(parts?.length===2&&repositoryCoordinates(...parts).key===t.repository,'target-repository');
  for(const k of ['repositoryId','number','memberId','runnerId','sessionMemberId','runnerMemberId'])githubId(t[k]);
  need(typeof t.issueId==='string'&&/^[A-Za-z0-9_=-]{1,256}$/.test(t.issueId)&&/^[A-Za-z0-9_-]{1,80}$/.test(t.cycle),'target-identity');
  need(t&&['shape','shape-validator','deliver','accept','shaper-review'].includes(t.role)
    &&['codex','claude','gemini'].includes(t.adapter)&&t.access==='read-only'
    &&t.status==='UNACCEPTED'&&typeof t.session==='string'&&t.session.length>0
    &&typeof t.execution==='string'&&t.execution.length>0&&typeof t.memberId==='string'
    &&t.memberId===t.sessionMemberId&&t.memberId===t.runnerMemberId
    &&typeof t.runnerId==='string'&&typeof t.cycle==='string'
    &&['scopeHash','authority','requirements'].every(k=>rescueHash(t[k]))
    &&(rescueHash(t.shapeHash)||t.role==='shape'&&t.shapeHash===null)
    &&(rescueHash(t.candidate)||['shape','shape-validator'].includes(t.role)&&t.candidate===null)
    &&t.source&&Object.keys(t.source).sort().join(' ')==='attempt runId','target');
  githubId(t.source.runId);githubId(t.source.attempt);
  return structuredClone(t);
}
export async function diagnoseRescueTarget({target,adapter,capture,retain,signal}) {
  const t=validateRescueTarget(target);
  need(typeof capture==='function'&&typeof retain==='function','ai-capability');
  if(adapter?.capabilities?.rescueReadOnly!==true||typeof adapter.diagnose!=='function')
    return {status:'unsupported',adapter:t.adapter};
  const before=await capture(t);
  const result=await adapter.diagnose({role:'rescue-diagnosis',skill:'rescue',access:'read-only',
    target:structuredClone(t),timeoutMs:180000,signal});
  // Retain even invalid/no plans and failed diagnoses before interpreting them.
  const record={target:contentIdentity(t),result:structuredClone(result)};
  need((await retain(record))?.outcome==='retained','ai-retention');
  need(same(await capture(t),before),'ai-mutation');
  need(result?.execution&&result.execution!==t.execution&&result.terminated===true
    &&result.memberId===t.memberId&&result.adapter===t.adapter,'ai-session');
  return {status:'completed',record,plan:validateAiRepairPlan(result.result)};
}
