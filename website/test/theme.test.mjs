import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrast, checkSample } from '../tooling/theme-metrics.mjs';
test('rendered measurements reject mixed themes, disconnected adapters and low contrast', () => {
  const sample = { rootTheme: 'dark', expectedTheme: 'dark', surface: 'rgb(16, 20, 43)', tokenSurface: 'rgb(16, 20, 43)', badge: { color: 'rgb(228, 217, 255)' }, tokenStatus: 'rgb(228, 217, 255)', overflow: 0, pairs: [{ name: 'body', foreground: 'rgb(233, 231, 245)', background: 'rgb(16, 20, 43)', minimum: 4.5 }] };
  assert.doesNotThrow(() => checkSample(sample));
  assert.throws(() => checkSample({ ...sample, rootTheme: 'light' }), /Theme mismatch/);
  assert.throws(() => checkSample({ ...sample, surface: 'rgb(255, 255, 255)' }), /token mapping/);
  assert.throws(() => checkSample({ ...sample, badge: { color: 'rgb(255, 255, 255)' } }), /Flowbite/);
  assert.throws(() => checkSample({ ...sample, pairs: [{ ...sample.pairs[0], foreground: sample.surface }] }), /contrast/);
  assert.throws(() => checkSample({ ...sample, overflow: 20 }), /overflow/);
  assert.throws(() => checkSample({ ...sample, brandOverflow: 20 }), /Clipped site title/);
  assert.equal(contrast('rgb(0, 0, 0)', 'rgb(255, 255, 255)'), 21);
});
