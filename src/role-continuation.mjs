import { rescueNeed as need, rescueSame as same } from './rescue-policy.mjs';

/** Internal continuity owner shared by Rescue and explicit Owner handover.
 * Each public entry supplies its own fixed identity/authority validator. This
 * mechanism never invents a historical Runner, Action source or passing verdict.
 */
export function createPreservedRoleContinuation({
  validateTarget,
  identityField,
  load,
  retain,
  prepare,
  now = Date.now,
}) {
  need(
    [validateTarget, load, retain, prepare, now].every(
      (f) => typeof f === 'function',
    ) && ['caseId', 'handoverId'].includes(identityField),
    'continuation-capability',
  );
  return async (request) => {
    const { target, proof, plan } = request;
    const t = validateTarget(target);
    const before = await load(t);
    need(
      before?.status === 'UNACCEPTED' &&
        same(before.target, t) &&
        before.terminated === true &&
        /^[a-f0-9]{64}$/.test(before.workspace) &&
        before.session === t.session &&
        before.memberId === t.memberId,
      'preservation',
    );
    const input = {
      version: 1,
      status: 'UNACCEPTED',
      [identityField]: request[identityField],
      target: t,
      proof,
      plan: plan ?? null,
      workspace: before.workspace,
      session: t.session,
      originalExecution: t.execution,
      at: now(),
      requiredGates: [
        'candidate',
        'hooks',
        'accept',
        'exact-head-ci',
        'shaper-review',
        'protected-merge',
        'closure',
      ],
    };
    need((await retain(input))?.outcome === 'retained', 'repair-retention');
    need(same(await load(t), before), 'source-changed');
    const next = await prepare(structuredClone(input));
    need(
      next?.execution &&
        next.execution !== t.execution &&
        next.session === t.session &&
        next.memberId === t.memberId &&
        next.role === t.role &&
        next.freshBudget === true &&
        next.status === 'UNACCEPTED' &&
        next.workspace === before.workspace &&
        next.access === (t.role === 'deliver' ? 'writer' : 'read-only'),
      'original-role',
    );
    return { ...input, next };
  };
}
