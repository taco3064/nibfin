import { assertCapturedCandidate } from './delivery-contract.mjs';
import { bodyDigest } from './grants.mjs';
import {
  contentIdentity,
  compareEvidence,
  compareStageCollection,
  skillForRole,
} from './evidence.mjs';
import { captureWorkspace, exportWorkspace } from './workspace.mjs';
import { selectInstructions } from './instructions.mjs';
import { need, same, freeze, copy } from './core-contract.mjs';

/** Writer seam: lifecycle owns isolation/result parsing, workspace owns capture.
 * A retained unresolved execution is collected again, never launched again.
 */
export function createDeliverFlow({
  current,
  captureInput,
  prepareRole,
  evidenceCurrent,
} = {}) {
  need(
    [current, captureInput, prepareRole, evidenceCurrent].every(
      (f) => typeof f === 'function',
    ),
    'capabilities',
  );
  let active = null,
    busy = false;
  const used = new Set();
  async function checkpoint(pin) {
    need(same(await current(), pin), 'drift');
  }
  async function finish() {
    const a = active;
    await checkpoint(a.pin);
    // Capture only after the Writer has stopped. The maintained role bridge can
    // then bind this owner's Candidate without asking the model to predict edits.
    const terminal = await a.lifecycle.termination(a.input.execution.id);
    need(terminal.termination?.status === 'terminated', 'termination');
    const source = await captureInput();
    need(
      same(
        {
          root: source.root,
          base: source.base,
          permittedPaths: source.permittedPaths,
          binding: source.binding,
        },
        a.pin.capture,
      ) &&
        source.scopeBody === a.pin.scopeBody &&
        source.shapeBody === a.pin.shapeBody,
      'capture-binding',
    );
    const w = captureWorkspace(source);
    if (a.bindCandidate) await a.bindCandidate(w.candidate);
    const collected =
      a.collected ?? (await a.lifecycle.collect(a.input.execution.id));
    if (['valid', 'rejected'].includes(collected.result?.status))
      a.collected = collected;
    if (['valid', 'rejected', 'invalid', 'absent'].includes(collected.result?.status))
      active = null;
    const raw = collected.result?.evidence ?? collected.result?.collection;
    const checked = compareStageCollection(
      raw,
      await evidenceCurrent(a.input.execution.id),
      a.pin,
    );
    need(
      raw.stage === 'deliver' &&
        same(raw.execution, a.input.execution) &&
        same(raw.binding, a.input.binding),
      'role',
    );
    await checkpoint(a.pin);
    if (checked.status !== 'valid') {
      active = null;
      return { outcome: 'rejected', collection: checked.collection };
    }
    need(
      same(raw.inputs.candidate, w.candidate) &&
        raw.inputs.publication === contentIdentity(a.pin.publication),
      'candidate',
    );
    assertCapturedCandidate(w, a.pin.shapeBody, checked.evidence);
    await checkpoint(a.pin);
    active = null;
    return {
      outcome: 'ready',
      evidence: checked.evidence,
      workspace: JSON.parse(exportWorkspace(w)),
    };
  }
  async function exclusive(fn) {
    if (busy) return { outcome: 'blocked' };
    busy = true;
    try {
      return await fn();
    } catch (e) {
      return {
        outcome: 'blocked',
        finding:
          typeof e?.message === 'string' &&
          /^(?:core|evidence|workspace|role-host):[a-z-]{1,100}$/.test(e.message)
            ? e.message
            : 'core:deliver-unavailable',
        ...(active ? { reconciliationRequired: active.input.execution.id } : {}),
      };
    } finally {
      busy = false;
    }
  }
  return Object.freeze({
    run() {
      return exclusive(async () => {
        need(!active, 'active');
        const pin = freeze(copy(await current()));
        await checkpoint(pin);
        const publication = compareEvidence(pin.publication, pin.publicationCurrent);
        need(
          publication.stage === 'publication' &&
            publication.binding.scopeHash === bodyDigest(pin.scopeBody) &&
            publication.binding.shapeHash === bodyDigest(pin.shapeBody),
          'publication',
        );
        const instructions = selectInstructions({
          ...pin.instructions,
          skill: 'deliver',
          role: 'deliver',
        });
        const task = freeze({
          version: 1,
          role: 'deliver',
          skill: 'deliver',
          repository: pin.repository,
          scopeBody: pin.scopeBody,
          shapeBody: pin.shapeBody,
          binding: pin.binding,
          capture: pin.capture,
          decisions: pin.decisions ?? [],
          publication: pin.publication,
        });
        const { lifecycle, input, bindCandidate } = await prepareRole({
          role: 'deliver',
          skill: 'deliver',
          instructions,
          task,
        });
        need(
          bindCandidate === undefined || typeof bindCandidate === 'function',
          'candidate-handoff',
        );
        need(
          input.execution.role === 'deliver' &&
            input.execution.skill === skillForRole('deliver') &&
            same(input.binding, pin.binding) &&
            same(input.instructions, instructionsFor(instructions)),
          'role',
        );
        for (const k of ['id', 'request', 'result'])
          need(!used.has(input.execution[k]), 'reuse');
        await checkpoint(pin);
        for (const k of ['id', 'request', 'result']) used.add(input.execution[k]);
        active = { pin, input: freeze(copy(input)), lifecycle, bindCandidate };
        const started = await lifecycle.start(input);
        if (started.start?.status === 'rejected') active = null;
        need(started.start?.status === 'started', 'start');
        return finish();
      });
    },
    reconcile() {
      return exclusive(async () => {
        need(active, 'active');
        return finish();
      });
    },
  });
}
const instructionsFor = (i) => ({ identity: i.identity, content: i.content });
