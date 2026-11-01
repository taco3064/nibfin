const ownerDiagnosticPattern = new RegExp(
  '^(?:core|shape|operations|runtime|evidence|authority|lifecycle)' +
    ':[a-z-]{1,100}$',
);
import { protectedWorkRestriction } from './owner-hold.mjs';
import { executeDeliveryOperation } from './runtime.mjs';
import { contentIdentity, compareEvidence } from './evidence.mjs';
import { verifyAuthority } from './authority.mjs';
import { createShapeFlow } from './shape.mjs';
import { createHookRunner } from './hooks.mjs';
import { createAcceptFlow } from './accept.mjs';
import { createCandidatePublication } from './candidate-publication.mjs';
import { createFinalReview, createProtectedMerge } from './final-review.mjs';
import { createCompletionFlow } from './completion.mjs';
import { createRecoveryFlow } from './recovery.mjs';
import { createRepairFlow } from './repair.mjs';
import { supportsStartCheckpoint } from './lifecycle.mjs';
import { loadApprovedInputs } from './host-source.mjs';
import { createDownstreamFanout } from './fanout.mjs';

import {
  copy,
  same,
  need,
  hash,
  freeze,
  operations,
  shared,
  intake,
  plan,
  ownerContext,
  ownerEvidence,
  shapeChain,
  shapeResult,
} from './core-contract.mjs';
import { createDeliverFlow } from './core-deliver.mjs';
import { nextDeliveryStage } from './delivery-planner.mjs';
export { createDeliverFlow } from './core-deliver.mjs';
export { coreStages } from './delivery-planner.mjs';

/** Inert composition of maintained owners. Configuration is a trusted host boundary.
 * current() resolves independent expectations/custody; it must not trust receipts
 * to choose their own expectations. No callback supplied by request data is used.
 */
export function createCore({
  current,
  provider,
  authorization,
  dependencies,
  selector,
  owners,
  referenceInputs,
  checkpoint,
  onDiagnostic,
} = {}) {
  need(
    typeof current === 'function' &&
      typeof authorization?.eligibility === 'function' &&
      typeof provider?.request === 'function' &&
      typeof dependencies?.evaluate === 'function' &&
      typeof selector?.select === 'function' &&
      owners,
    'capabilities',
  );
  const read = current,
    request = provider.request.bind(provider),
    eligibility = authorization.eligibility.bind(authorization),
    evaluate = dependencies.evaluate.bind(dependencies),
    select = selector.select.bind(selector);
  const factories = {
    shape: createShapeFlow,
    deliver: createDeliverFlow,
    hooks: createHookRunner,
    accept: createAcceptFlow,
    publication: createCandidatePublication,
    review: createFinalReview,
    merge: createProtectedMerge,
    completion: createCompletionFlow,
    fanout: createDownstreamFanout,
    recovery: createRecoveryFlow,
    repair: createRepairFlow,
  };
  need(checkpoint === undefined || typeof checkpoint === 'function', 'checkpoint');
  need(
    onDiagnostic === undefined || typeof onDiagnostic === 'function',
    'diagnostic',
  );
  let executing = null,
    executionSignal,
    executionDependencies,
    confirmedClose = false;
  const checkExecution = async () => {
    need(
      protectedWorkRestriction((await read()).restrictions) === null,
      'execution-restriction',
    );
    if (checkpoint) {
      need(!executionSignal?.aborted, 'cancelled');
      await checkpoint({ signal: executionSignal });
      if (executing) {
        const live = await read();
        need(
          same(plan(live), plan(executing)) &&
            same(live.invocation, executing.invocation),
          'checkpoint-drift',
        );
        const deps = await evaluate(copy(executing.dependencyInput), {
          signal: executionSignal,
        });
        need(
          deps.outcome === 'ready' &&
            same(deps.target, executing.target) &&
            same(
              { edges: deps.edges, completions: deps.completions },
              executionDependencies,
            ),
          'checkpoint-dependencies',
        );
        const target = executing.target,
          stage = plan(executing).stage;
        const issue = await request({
          method: 'GET',
          endpoint: '/repos/' + target.repository + '/issues/' + target.number,
          target: target.repositoryId,
          operation: 'core-read',
          correlation: executing.invocation.request,
          signal: executionSignal,
        });
        need(
          issue.outcome === 'read' &&
            issue.data?.id === target.databaseId &&
            issue.data.node_id === target.issueId &&
            (issue.data.state === 'open' ||
              Boolean(executing.receipts.closure) ||
              executing.transition === 'recovery' ||
              (stage === 'closure' &&
                confirmedClose &&
                issue.data.state === 'closed' &&
                issue.data.state_reason === 'completed')) &&
            (issue.data.body ===
              (executing.unacceptedHandover
                ? executing.scopeBody
                : executing.receipts.publication
                  ? executing.shapeBody
                  : executing.scopeBody) ||
              (stage === 'publication' && issue.data.body === executing.shapeBody)),
          'checkpoint-scope',
        );
      }
    }
  };
  const owned = {};
  for (const [name, factory] of Object.entries(factories))
    if (owners[name]) {
      const config = { ...owners[name] },
        ownerCurrent = config.current;
      if (checkpoint && typeof config.operations === 'function') {
        const operations = config.operations;
        config.operations = async (options) => {
          const before = options.beforeSubmit;
          const ownedOperations = await operations({
            ...options,
            beforeSubmit: async (...args) => {
              if (before) await before(...args);
              await checkExecution();
            },
          });
          return {
            ...ownedOperations,
            execute: async (...args) => {
              const result = await ownedOperations.execute(...args),
                intent = args[0];
              if (
                executing &&
                plan(executing).stage === 'closure' &&
                ownedOperations.causalClose === true &&
                intent.kind === 'close' &&
                intent.binding.repositoryId === executing.target.repositoryId &&
                intent.binding.issueId === executing.target.issueId &&
                intent.binding.cycle === executing.cycle &&
                intent.binding.authorization === executing.binding.grant &&
                result.outcome === 'confirmed-success' &&
                result.continuation === true
              )
                confirmedClose = true;
              return result;
            },
          };
        };
      }
      if (typeof ownerCurrent === 'function')
        config.current = async (...args) => {
          const value = await ownerCurrent(...args),
            live = await read(),
            p = executing ?? live;
          if (executing) {
            need(!executionSignal?.aborted, 'cancelled');
            need(same(plan(live), plan(p)), 'owner-drift');
          }
          for (const k of shared)
            need(value.binding?.[k] === p.binding[k], 'owner-binding');
          need(value.binding.shapeHash === p.binding.shapeHash, 'owner-binding');
          const repository = value.target?.repository ?? value.repository;
          need(repository === p.target.repository, 'owner-binding');
          ownerContext(value, executing ?? p, name);
          await checkExecution();
          return value;
        };
      if (typeof config.prepareRole === 'function') {
        const prepare = config.prepareRole;
        config.prepareRole = async (task) => {
          const before = await read();
          let references;
          if (before.referenceInputApproval)
            need(
              hash(before.referenceInputApproval) &&
                typeof referenceInputs === 'function',
              'reference-inputs',
            );
          if (referenceInputs !== undefined) {
            need(typeof referenceInputs === 'function', 'reference-inputs');
            const spec = await referenceInputs({
              role: task.role,
              scopeHash: before.binding.scopeHash,
            });
            if (before.referenceInputApproval)
              need(
                contentIdentity(spec.approval) === before.referenceInputApproval,
                'reference-approval',
              );
            need(
              spec.expected.role === task.role &&
                spec.expected.requirements.scopeHash === before.binding.scopeHash &&
                spec.expected.requirements.revision === before.requirementRevision,
              'reference-inputs',
            );
            references = await loadApprovedInputs(spec);
            need(same(plan(await read()), plan(before)), 'reference-drift');
          }
          const prepared = await prepare(
              references ? { ...task, referenceInputs: references } : task,
            ),
            p = await read(),
            e = prepared.input.execution;
          if (executing) {
            need(!executionSignal?.aborted, 'cancelled');
            need(same(plan(p), plan(executing)), 'owner-drift');
          }
          need(e.role === task.role && e.skill === task.skill, 'role');
          const used = Object.values(p.receipts).flatMap((r) =>
            ['id', 'request', 'result'].map((k) => r.execution[k]),
          );
          need(
            ['id', 'request', 'result'].every((k) => !used.includes(e[k])),
            'independence',
          );
          const signal = executionSignal,
            lifecycle = prepared.lifecycle;
          need(
            !checkpoint || supportsStartCheckpoint(lifecycle),
            'lifecycle-checkpoint-unavailable',
          );
          return {
            ...prepared,
            lifecycle: {
              ...lifecycle,
              start: async (input) => {
                await checkExecution();
                need(!signal?.aborted, 'cancelled');
                return lifecycle.start(input, {
                  signal,
                  ...(checkpoint ? { beforeStart: checkExecution } : {}),
                });
              },
            },
          };
        };
      }
      owned[name] = factory(config);
    }
  const ciProvider = owners.ci?.provider,
    ciMode = owners.ci?.mode,
    hookInput = owners.hookInput;
  need(
    ciMode === undefined || ['github-repository', 'signed'].includes(ciMode),
    'ci-mode',
  );
  let busy = false;
  const invoked = new Set(),
    runStages = new Map();
  const observe = (r, signal) =>
    typeof provider.freshReadObservation === 'function'
      ? provider.freshReadObservation(() => observeFresh(r, signal))
      : observeFresh(r, signal);
  async function observeFresh(r, signal) {
    const p = freeze(copy(await read()));
    need(
      same(p.target, r.target) &&
        p.cycle === r.cycle &&
        same(p.invocation, { request: r.request, run: r.run }),
      'binding',
    );
    const decision = plan(p);
    const refuse = (ok, gate, observation = null) => {
      if (!ok)
        throw {
          decision: {
            ...decision,
            identity: contentIdentity({
              decision: decision.identity,
              gate,
              observation,
            }),
          },
          gate,
        };
    };
    refuse(
      protectedWorkRestriction(p.restrictions) === null,
      'execution-restriction',
    );
    refuse(
      !Object.values(p.receipts).some((e) => e.execution.source?.runId === r.run.id),
      'historical-run-reuse',
    );
    const options = {
      method: 'GET',
      target: p.target.repositoryId,
      operation: 'core-read',
      correlation: r.request,
      signal,
    };
    const root = '/repos/' + p.target.repository;
    const repository = await request({ ...options, endpoint: root });
    refuse(
      repository.outcome === 'read' &&
        repository.data?.id === p.target.repositoryId &&
        repository.data.full_name?.toLowerCase() === p.target.repository &&
        repository.data.private === false,
      'repository',
    );
    const issue = await request({
      ...options,
      endpoint: root + '/issues/' + p.target.number,
    });
    const actual = issue.data;
    if (p.unacceptedHandover && actual)
      nextDeliveryStage(p.receipts, p.transition, actual.labels);
    refuse(
      issue.outcome === 'read' &&
        actual?.id === p.target.databaseId &&
        actual.node_id === p.target.issueId &&
        String(actual.number) === p.target.number &&
        !actual.pull_request &&
        actual.repository_url === 'https://api.github.com' + root &&
        (actual.body ===
          (p.unacceptedHandover
            ? p.scopeBody
            : p.receipts.publication
              ? p.shapeBody
              : p.scopeBody) ||
          (decision.stage === 'publication' &&
            p.prior?.state === 'unresolved' &&
            actual.body === p.shapeBody)),
      'issue',
    );
    refuse(
      actual.state === 'open' ||
        Boolean(p.receipts.closure) ||
        p.transition === 'recovery',
      'issue-state',
    );
    need(!signal?.aborted, 'cancelled');
    const operation = operations[decision.stage] ?? decision.stage;
    const auth = await eligibility({ operation, correlation: r.request }, { signal });
    refuse(
      auth.ok === true &&
        auth.observation.repositoryId === p.target.repositoryId &&
        auth.observation.issueId === p.target.issueId &&
        auth.observation.operation === operation,
      'authorization',
    );
    const authority = verifyAuthority(p.authority.export, p.authority.context);
    refuse(
      authority.ok &&
        authority.binding.identity === p.binding.authority &&
        authority.binding.cycle === p.cycle,
      'authority',
    );
    const deps = await evaluate(copy(p.dependencyInput), { signal });
    refuse(
      deps.outcome === 'ready' && same(deps.target, p.target),
      'dependencies',
      deps,
    );
    refuse(
      p.selectionInput.operation === operation &&
        p.selectionInput.execution.operation === operation,
      'selection-operation',
    );
    const selection = await select(copy(p.selectionInput), { signal });
    refuse(
      selection.outcome === 'selected' &&
        selection.observation.repositoryId === p.target.repositoryId &&
        selection.observation.issueId === p.target.issueId,
      'selection',
      selection,
    );
    // Bind semantic graph/routing data, not observation timestamps, to queued work.
    decision.identity = contentIdentity({
      decision: decision.identity,
      edges: deps.edges,
      completions: deps.completions,
      member: selection.memberId,
      routing: selection.routing,
    });
    const after = freeze(copy(await read()));
    need(same(plan(after), plan(p)) && same(after.invocation, p.invocation), 'drift');
    need(!signal?.aborted, 'cancelled');
    return {
      pin: p,
      decision,
      dependencies: { edges: deps.edges, completions: deps.completions },
    };
  }
  function result(r, d, disposition, reason, stage = null, owner = null) {
    return {
      version: 1,
      target: r.target,
      cycle: r.cycle,
      request: r.request,
      run: r.run,
      requested: r.expected,
      current: d ? { stage: d.stage, decision: d.identity } : null,
      executed: stage,
      disposition,
      reason,
      inputs: d?.inputs ?? null,
      owner: owner
        ? {
            outcome: owner.outcome ?? owner.status ?? null,
            identity: contentIdentity(owner),
            output: owner,
          }
        : null,
    };
  }
  async function dispatch(p, stage, signal, resume) {
    if (['shape-validator', 'publication'].includes(stage))
      shapeChain(p.stageInput, p, stage === 'publication');
    return executeDeliveryOperation({
      p,
      stage,
      signal,
      resume,
      owned,
      hookInput,
      ciProvider,
      ciMode,
    });
  }

  return Object.freeze({
    async inspect(input, { signal } = {}) {
      let r;
      try {
        r = intake(copy(input));
        const { decision } = await observe(r, signal);
        return result(r, decision, 'waiting', 'evaluated');
      } catch (e) {
        return r
          ? result(
              r,
              e?.decision ?? null,
              'blocked',
              e?.gate ?? 'invalid-or-unavailable',
            )
          : { version: 1, disposition: 'rejected', reason: 'invalid-request' };
      }
    },
    async run(input, { signal } = {}) {
      let r,
        d,
        launched = false,
        acquired = false;
      try {
        r = intake(copy(input));
        if (busy) return result(r, null, 'blocked', 'busy');
        busy = true;
        acquired = true;
        const observed = await observe(r, signal),
          p = observed.pin;
        d = observed.decision;
        if (r.expected.stage !== d.stage || r.expected.decision !== d.identity)
          return result(r, d, 'superseded', 'fresh-decision-required');
        const prior = p.prior;
        need(
          prior && ['new', 'resolved', 'unresolved'].includes(prior.state),
          'prior-evidence',
        );
        if (prior.state === 'resolved')
          return result(r, d, 'waiting', 'original-result-retained');
        const resume = prior.state === 'unresolved';
        if (resume)
          need(
            prior.request?.request === r.request && prior.stage === d.stage,
            'reconciliation',
          );
        // Owners guard writes after their own awaited reads. This additional boundary
        // refuses an operation if queued inputs drifted during Core's reads.
        const fresh = await observe(r, signal);
        if (fresh.decision.identity !== d.identity)
          return result(r, fresh.decision, 'superseded', 'checkpoint-drift');
        if (runStages.has(r.run.id) && runStages.get(r.run.id) !== d.stage)
          return result(r, d, 'blocked', 'run-stage-already-bound');
        const invocation = contentIdentity(r.run);
        if (!resume && invoked.has(invocation))
          return result(r, d, 'blocked', 'invocation-already-attempted');
        invoked.add(invocation);
        runStages.set(r.run.id, d.stage);
        executing = p;
        executionSignal = signal;
        executionDependencies = fresh.dependencies;
        launched = true;
        const owner = await dispatch(p, d.stage, signal, resume);
        if (owner?.evidence) ownerEvidence(owner.evidence, p, d.stage);
        if (['shape', 'shape-validator', 'publication'].includes(d.stage))
          shapeResult(owner, p, d.stage);
        const descriptor =
          owner?.value?.candidate ?? owner?.receipt?.binding?.workspace;
        if (descriptor)
          need(same(descriptor.candidate, p.candidate), 'owner-candidate');
        if (d.stage === 'delivered' && owner?.receipt?.payload)
          for (const [stage, e] of Object.entries(p.receipts))
            if (!['shape', 'shape-validator'].includes(stage))
              need(same(owner.receipt.payload.receipts[stage], e), 'owner-evidence');
        const value = owner?.outcomes?.some((x) =>
          ['blocked', 'waiting', 'failed'].includes(x.outcome),
        )
          ? 'blocked'
          : (owner?.outcome ?? owner?.status);
        const unresolved =
          owner?.reconciliationRequired ||
          owner?.disposition === 'reconcile' ||
          owner?.outcomes?.some((x) => x.outcome === 'unknown') ||
          [owner?.operation, owner?.bodyResult, owner?.labelResult].some(
            (x) => x?.outcome === 'unknown',
          );
        const disposition = unresolved
          ? 'unresolved'
          : [
                'blocked',
                'failed',
                'rejected',
                'waiting',
                'pending',
                'unknown',
                'cancelled',
              ].includes(value)
            ? ['waiting', 'pending'].includes(value)
              ? 'waiting'
              : value === 'rejected'
                ? 'rejected'
                : value === 'unknown'
                  ? 'unresolved'
                  : 'blocked'
            : owner?.ok === false
              ? 'blocked'
              : [
                    'authored',
                    'validated',
                    'published',
                    'ready',
                    'accepted',
                    'approved',
                    'confirmed-success',
                    'closed',
                    'completed',
                    'delivered',
                    'observed',
                    'qualified',
                    'not-applicable',
                    'retained',
                    'woken',
                    'success',
                    'satisfied',
                    'merged',
                    'handoff',
                    'discovered',
                  ].includes(value) || owner?.ok === true
                ? 'completed'
                : 'blocked';
        return result(
          r,
          d,
          signal?.aborted && disposition === 'completed' ? 'blocked' : disposition,
          signal?.aborted ? 'cancelled' : 'owner-result',
          d.stage,
          owner,
        );
      } catch (e) {
        if (onDiagnostic)
          try {
            await onDiagnostic({
              phase: launched ? 'owner' : 'intake',
              stage: d?.stage ?? null,
              code:
                typeof e?.message === 'string' &&
                ownerDiagnosticPattern.test(e.message)
                  ? e.message
                  : 'core:unavailable',
            });
          } catch {
            /* Diagnostics never change the disposition. */
          }
        return r
          ? result(
              r,
              e?.decision ?? d,
              launched ? 'unresolved' : 'blocked',
              e?.decision ? e.gate : 'invalid-or-unavailable',
              launched ? d.stage : null,
            )
          : { version: 1, disposition: 'rejected', reason: 'invalid-request' };
      } finally {
        if (acquired) {
          executing = null;
          executionSignal = undefined;
          executionDependencies = undefined;
          confirmedClose = false;
          busy = false;
        }
      }
    },
  });
}
