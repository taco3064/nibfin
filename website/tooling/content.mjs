import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
export const areas = ['Overview', 'Quick Start', 'Concepts', 'Guides', 'Architecture', 'Reference', 'Troubleshooting'];
export function checkContent(root = 'src/content/docs') {
  const titles = [];
  for (const name of readdirSync(root)) {
    const text = readFileSync(`${root}/${name}`, 'utf8');
    assert.match(text, /^---\ntitle: .+\ndescription: .+\n---\n/);
    assert.doesNotMatch(text, /[\u3400-\u9fff]/, `${name}: public copy must be English`);
    assert.ok(text.length > 400, `${name}: meaningful shell copy required`);
    titles.push(text.match(/\ntitle: (.+)/)[1]);
  }
  assert.deepEqual(titles.sort(), [...areas].sort());
}
if (process.argv[1]?.endsWith('/content.mjs')) { checkContent(); console.log('Seven English shell areas validated'); }
