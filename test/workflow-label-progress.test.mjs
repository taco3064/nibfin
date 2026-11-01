import test from 'node:test';
import assert from 'node:assert/strict';
import { nextDeliveryStage } from '../src/index.mjs';

const labels = (...names) => names.map((name) => ({ name }));
const receipt = { result: null };
test('shaped labels never restart Shape when local receipts are missing', () => {
  assert.throws(() => nextDeliveryStage({}, null, labels('scope', 'shaped')), {
    code: 'ORIGINAL_WORK_HANDOVER_REQUIRED',
  });
  assert.equal(nextDeliveryStage({}, null, labels('scope')), 'shape');
  const retained = Object.fromEntries(
    ['shape', 'shape-validator', 'publication'].map((stage) => [stage, receipt]),
  );
  assert.equal(
    nextDeliveryStage(retained, null, labels('scope', 'shaped')),
    'deliver',
  );
  assert.throws(() => nextDeliveryStage(retained, null, labels('scope')), {
    code: 'WORKFLOW_RESET_RECONCILIATION_REQUIRED',
  });
  assert.throws(() => nextDeliveryStage({}, null, []), {
    code: 'WORKFLOW_NOT_ENROLLED',
  });
  assert.throws(() =>
    nextDeliveryStage({}, null, labels('scope', 'shaped', 'delivered')),
  );
});
