import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { load } from 'cheerio';
import assert from 'node:assert/strict';
export function checkLinks(root = 'dist', inspectSite = true) {
  const base = resolve(root), html = [];
  function walk(dir) { for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.html')) html.push(p);
  }}
  walk(base);
  assert.ok(html.length, 'HTML output required');
  for (const file of html) {
    const $ = load(readFileSync(file, 'utf8'));
    const url = new URL(`/nibfin/${relative(base, file)}`, 'https://taco3064.github.io');
    $('[href], [src]').each((_, el) => {
      const ref = $(el).attr('href') ?? $(el).attr('src');
      if (!ref || /^(data:|mailto:|tel:|javascript:)/.test(ref)) return;
      const target = new URL(ref, url);
      if (target.origin !== url.origin) return;
      assert.ok(target.pathname.startsWith('/nibfin/'), `${file}: unprefixed ${ref}`);
      let path = resolve(base, decodeURIComponent(target.pathname.slice('/nibfin/'.length)));
      assert.ok(path === base || path.startsWith(base + '/'), 'path escape');
      if (existsSync(path) && statSync(path).isDirectory()) path = resolve(path, 'index.html');
      assert.ok(existsSync(path), `${file}: missing ${ref}`);
      if (target.hash && path.endsWith('.html')) {
        const doc = load(readFileSync(path, 'utf8'));
        assert.ok(doc('[id]').toArray().some(e => doc(e).attr('id') === decodeURIComponent(target.hash.slice(1))), `${file}: missing fragment ${ref}`);
      }
    });
  }
  if (inspectSite) {
    for (const route of ['', 'quick-start', 'concepts', 'guides', 'architecture', 'reference', 'troubleshooting']) {
      const file = resolve(base, route, 'index.html');
      assert.ok(existsSync(file), `missing route ${route}`);
      const $ = load(readFileSync(file, 'utf8'));
      assert.equal($('html').attr('lang'), 'en');
      assert.ok($('meta[name="description"]').attr('content'));
      assert.ok($('link[rel="canonical"]').attr('href')?.startsWith('https://taco3064.github.io/nibfin/'));
      for (const slug of ['quick-start', 'concepts', 'guides', 'architecture', 'reference', 'troubleshooting']) assert.ok($(`a[href="/nibfin/${slug}/"]`).length);
    }
    assert.ok(existsSync(resolve(base, 'pagefind/pagefind.js')), 'Pagefind build missing');
    const searchFiles = readdirSync(resolve(base, '_astro')).filter(name => name.startsWith('Search.') && name.endsWith('.js'));
    assert.ok(searchFiles.length, 'Starlight search client missing');
    const search = searchFiles.map(name => readFileSync(resolve(base, '_astro', name), 'utf8')).join('\n');
    assert.match(search, /baseUrl:\s*["']\/nibfin\/["']/);
    assert.ok(search.includes('/pagefind/'), 'Search bundle must resolve its Pagefind output');
    const css = readdirSync(resolve(base, '_astro')).filter(name => name.endsWith('.css')).map(name => readFileSync(resolve(base, '_astro', name), 'utf8')).join('\n');
    assert.ok(css.includes('bg-purple-100') && css.includes('data-theme=dark'), 'Compiled Flowbite utilities and Starlight dark integration required');

    assert.match(readFileSync(resolve(base, 'index.html'), 'utf8'), /Unverified.*product integration and deployment/);
  }
  return html.length;
}
if (process.argv[1]?.endsWith('/links.mjs')) console.log(`Validated ${checkLinks()} generated HTML files, local targets and fragments`);
