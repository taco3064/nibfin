// Outcome semantics adapted from Kairo PR54 rescue-result.mjs.
import {rescueNeed as need} from './rescue-policy.mjs';
const gray=['STAGE_RECOVERED','DEFERRED','PENDING_VERIFICATION','SUPERSEDED','NOT_NEEDED'];
export function rescueConclusion(outcome) {
  if(outcome==='RESOLVED')return 'success';
  if(gray.includes(outcome))return 'neutral';
  return 'failure';
}
export function rescueReport(state) {
  const cases=Object.values(state.cases),eligible=cases.filter(c=>c.eligible===true);
  const attempts=eligible.filter(c=>c.repairAttempt),automatic=attempts.filter(c=>c.outcome==='RESOLVED'&&c.resolution==='automatic');
  const ratio=(n,d)=>({numerator:n,denominator:d,rate:d?n/d:null});
  return {eligibleBlocks:eligible.length,triggeredCases:eligible.filter(c=>c.triggered).length,
    aiDiagnoses:eligible.filter(c=>c.diagnosis?.attempted).length,repairAttempts:attempts.length,
    repairDispatches:attempts.filter(c=>c.continuation?.outcome==='confirmed-success').length,
    verifiedAutomaticResolutions:automatic.length,
    triggerCoverage:ratio(eligible.filter(c=>c.triggered).length,eligible.length),
    verifiedRepairSuccess:ratio(automatic.length,attempts.length),
    cases:cases.map(c=>({id:c.id,outcome:c.outcome,reason:typeof c.code==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(c.code)&&!/(?:gh[pousr]_|github_pat_|token|secret|credential)/i.test(c.code)?c.code:'UNAVAILABLE',source:{runId:c.source.runId,attempt:c.source.attempt},
      continuation:c.continuation?.observation?.id??null,automatic:c.resolution==='automatic',
      ai:c.diagnosis?.status??'not-invoked',attempted:Boolean(c.repairAttempt)}))};
}
/** No source/continuation cancellation. Separate neutral Checks are insufficient
 * for final Run presentation; the installed workflow reports that limit explicitly.
 */
export async function reportRescueOutcome({outcome,reportingRun,capability,report}) {
  need(typeof report==='function'&&typeof reportingRun==='string','reporting');
  const conclusion=rescueConclusion(outcome);
  // A neutral Check cannot make the enclosing single-job workflow neutral.
  // No safely Run-scoped final-Run presentation mechanism is installed here.
  // Fail visibly even if a host can publish a separate neutral Check.
  if(conclusion==='neutral')
    return {outcome:'unsupported',conclusion,reason:'neutral-run-reporting-unavailable'};
  try {
    need(capability?.runId===reportingRun&&capability.scope==='reporting-run','reporting-scope');
    const r=await report({runId:reportingRun,conclusion,outcome});
    need(r?.confirmed===true,'reporting-readback');return {outcome:'reported',conclusion};
  } catch {return {outcome:'failed',conclusion:'failure',reason:'reporting-unconfirmed'};}
}
