import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderActionsCaller } from '../scripts/render-actions-caller.mjs';

test('enrollment caller listens to the approved project workflow name', async () => {
  const template = (await readFile('examples/workflows/actions-public-caller.yml', 'utf8')).replaceAll('\r\n', '\n');
  const result = renderActionsCaller(template, [{ name: 'Fixture checks', path: '.github/workflows/ci.yml' }]);
  assert.match(result, /workflows: \["Fixture checks"\]/);
  assert.ok(!result.includes('workflows: [Project CI, Deployment]'));
  assert.ok(!/^\s*schedule:/m.test(result));
  for (const workflows of [[], [{name: '*', path: '.github/workflows/ci.yml'}], [{name: 'Kairo', path: '.github/workflows/kairo.yml'}], [{name: 'CI', path: '.github/workflows/a.yml'}, {name: 'CI', path: '.github/workflows/b.yml'}]]) {
    assert.throws(() => renderActionsCaller(template, workflows));
  }
});
