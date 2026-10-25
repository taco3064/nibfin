import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLinks } from '../tooling/links.mjs';
import { checkContent } from '../tooling/content.mjs';
test('generated-link checker accepts a valid fragment and rejects broken destinations and fragments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nibfin-links-'));
  try {
    writeFileSync(join(dir, 'index.html'), '<a href="/nibfin/target/#ok">target</a>');
    mkdirSync(join(dir, 'target'));
    writeFileSync(join(dir, 'target/index.html'), '<h1 id="ok">Target</h1>');
    assert.equal(checkLinks(dir, false), 2);
    writeFileSync(join(dir, 'index.html'), '<a href="/nibfin/missing/">bad</a>');
    assert.throws(() => checkLinks(dir, false), /missing/);
    writeFileSync(join(dir, 'index.html'), '<a href="/nibfin/target/#absent">bad</a>');
    assert.throws(() => checkLinks(dir, false), /missing fragment/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('content checker rejects malformed frontmatter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nibfin-content-'));
  try { writeFileSync(join(dir, 'bad.mdx'), 'missing metadata'); assert.throws(() => checkContent(dir)); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
