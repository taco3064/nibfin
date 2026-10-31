import { coreStages, modelRoleStages } from './delivery-planner.mjs';

// This retry budget covers failures before an AI diagnosis, independently of
// the original issue repair budget. An attempted diagnosis needs reconciliation.
export function protectedStageDiagnosisPlan({
  stage,
  attemptPhase,
  marker,
  diagnosis,
  quota,
  active = false,
} = {}) {
  if (
    modelRoleStages.includes(stage) ||
    !coreStages.includes(stage) ||
    attemptPhase !== 'unresolved'
  )
    return { outcome: 'not-applicable' };
  if (!marker) return { outcome: 'start' };
  if (marker.status === 'diagnosed' && !diagnosis?.record) {
    return { outcome: 'correct-marker', status: 'diagnosis-unavailable' };
  }
  if (marker.status === 'notification-unresolved') {
    return { outcome: 'unknown', reason: 'original-notification-readback-required' };
  }
  if (marker.status !== 'diagnosis-unavailable') return { outcome: marker.status };
  if (quota)
    return {
      outcome: 'waiting',
      reason: 'github-api-rate-limit-until-' + new Date(quota.resetAt).toISOString(),
    };
  if (diagnosis?.attempted) {
    return {
      outcome: 'unknown',
      reason: 'original-diagnosis-reconciliation-required',
    };
  }
  if ((marker.attempts ?? 1) >= 3) {
    return { outcome: 'unknown', reason: 'protected-diagnosis-retry-exhausted' };
  }
  if (active)
    return { outcome: 'waiting', reason: 'protected-diagnosis-runner-drain' };
  return { outcome: 'retry', attempts: (marker.attempts ?? 1) + 1 };
}

export function protectedStageDiagnosisResult(result) {
  const diagnosed = Boolean(result.diagnosis?.record);
  return {
    outcome: 'UNRESOLVED',
    nextCheckAt: null,
    status: diagnosed ? 'diagnosed' : 'diagnosis-unavailable',
    code: diagnosed
      ? 'PROTECTED_STAGE_DIAGNOSED'
      : (result.code ?? 'DIAGNOSIS_NOT_STARTED'),
  };
}
