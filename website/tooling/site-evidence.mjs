import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { verifyBuild, hash } from './build-identity.mjs';
const build = verifyBuild();
const live = process.argv.includes('--live');
const target = 'https://taco3064.github.io/nibfin/';
const negative = process.env.SITE_NEGATIVE_CASE;
const output = negative ? `negative-${negative}` : live ? 'live' : 'site';
mkdirSync('out', { recursive: true });
rmSync(`out/${output}-evidence.json`, { force: true });
const mime = { '.html': 'text/html', '.js': 'javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    assert(url.pathname.startsWith('/nibfin/'));
    let p = resolve('dist', '.' + decodeURIComponent(url.pathname.slice(7)));
    assert(p === resolve('dist') || p.startsWith(resolve('dist') + '/'));
    if (statSync(p).isDirectory()) p += '/index.html';
    res.setHeader('Content-Type', mime[extname(p)]?.replace('javascript','text/javascript') ?? 'application/octet-stream');
    res.end(readFileSync(p));
  } catch { res.writeHead(404).end(); }
});
if (!live) await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = live ? target : `http://127.0.0.1:${server.address().port}/nibfin/`;
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), target: base, buildArchive: build.archive, inputs: build.inputs, execution: build.execution, cases: [], resources: [], screenshots: [], applicability: 'Starlight navigation/menu, search, theme selector, mobile table-of-contents details are interactive; the current output has no code-copy controls or additional islands. Flowbite Badge is static server-rendered content.' };
async function identity() {
  const response = await fetch(`${base}build-identity.json`, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
  assert(response.ok, 'Missing deployed build identity');
  assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(readFileSync('dist/build-identity.json')), 'Stale deployed build');
}
if (live) {
  assert.equal(process.env.PAGES_URL, target, 'Unexpected official page_url');
  assert.equal(process.env.DEPLOYMENT_RESULT, 'success', 'Deployment did not succeed');
  assert.equal(build.execution.commit, process.env.GITHUB_SHA);
  const deadline = Date.now() + 120000;
  for (;;) { try { await identity(); break; } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(r => setTimeout(r, 5000)); } }
  report.deployment = { repository: process.env.GITHUB_REPOSITORY, commit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, environment: 'github-pages', result: process.env.DEPLOYMENT_RESULT, page_url: process.env.PAGES_URL, configuration: JSON.parse(readFileSync('out/pages-configuration.json')) };
} else await identity();
const browser = await chromium.launch({ executablePath: process.env.THEME_BROWSER_PATH || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage'] }).catch(error => { if (!live) server.close(); throw error; });
report.browser = browser.version();
mkdirSync(`out/${output}-screenshots`, { recursive: true });
const routes = ['', 'quick-start/', 'concepts/', 'guides/', 'architecture/', 'reference/', 'troubleshooting/'];
const errors = [];
report.cancelledRequests = [];
async function bytes(response) {
  try { return await response.body(); } catch { const r = await fetch(response.url()); assert(r.ok); return Buffer.from(await r.arrayBuffer()); }
}
async function capture(page, name) {
  const path = `out/${output}-screenshots/${name}.png`;
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path, fullPage: true });
  report.screenshots.push({ member: `${name}.png`, sha256: hash(readFileSync(path)) });
}
async function search(page) {
  const opener = page.locator('[data-open-modal]');
  await opener.focus(); await page.keyboard.press('Enter');
  const input = page.locator('dialog[open] input'); await input.waitFor();
  for (const [term, destination] of [['Owner Grant', 'concepts/'], ['runner', 'guides/']]) {
    await input.fill(term);
    const result = page.locator(`.pagefind-ui__result-link[href*="${destination}"]`).first();
    await result.waitFor({ timeout: 15000 });
    assert((await result.getAttribute('href')).includes('/nibfin/'));
    const destinationURL = new URL(await result.getAttribute('href'), page.url()).href;
    await Promise.all([page.waitForURL(destinationURL, { waitUntil: 'networkidle' }), result.click()]);
    assert(new URL(page.url()).pathname.includes(`/nibfin/${destination}`));
    await opener.click(); await input.waitFor();
  }
  await input.fill('zzzznibfinnomatch987654');
  await page.locator('.pagefind-ui__message').filter({ hasText: /No results/i }).waitFor();
  await input.fill('runner'); await page.locator('.pagefind-ui__result-link').first().waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog[open]').count(), 0);
  assert(await opener.evaluate(e => e === document.activeElement), 'Search focus not restored');
}
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: 'reduce' });
    const page = await context.newPage();
    if (negative === 'missing-asset') await page.route('**/*.css', route => route.fulfill({ status: 404, body: 'missing' }));
    if (negative === 'wrong-base') await page.addInitScript(() => addEventListener('DOMContentLoaded', () => document.querySelector('link[rel=canonical]')?.setAttribute('href', 'https://taco3064.github.io/')));
    if (negative === 'unusable-search') await page.route('**/pagefind/**', route => route.fulfill({ status: 404, body: 'missing index' }));
    const pending = [];
    page.on('response', r => pending.push((async () => {
      const u = new URL(r.url());
      assert.equal(u.origin, new URL(base).origin, 'Unexpected external resource');
      assert(u.pathname.startsWith('/nibfin/'), 'Request escapes base');
      assert(r.ok(), `Resource HTTP ${r.status()}: ${u.pathname}`);
      const expected = mime[extname(u.pathname)];
      if (expected) assert(r.headers()['content-type']?.includes(expected), `Resource MIME: ${u.pathname}`);
      let member = u.pathname.slice('/nibfin/'.length); if (!member || member.endsWith('/')) member += 'index.html';
      const digest = hash(await bytes(r));
      assert.equal(digest, build.outputs[member], `Resource differs from archive: ${member}`);
      report.resources.push({ url: u.pathname, status: r.status(), contentType: r.headers()['content-type'], sha256: digest });
    })().catch(e => errors.push(e.message))));
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('requestfailed', r => { if (r.failure()?.errorText === 'net::ERR_ABORTED') report.cancelledRequests.push(r.url()); else errors.push(`${r.url()}: ${r.failure()?.errorText}`); });
    page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
    for (const route of routes) {
      const response = await page.goto(base + route); assert.equal(response.status(), 200);
      await page.reload(); await page.waitForLoadState('networkidle'); await page.evaluate(() => document.fonts.ready);
      assert.deepEqual(errors, [], 'Browser resource/console defects');
      const data = await page.evaluate(() => ({ lang: document.documentElement.lang, title: document.title, description: document.querySelector('meta[name="description"]')?.content, canonical: document.querySelector('link[rel="canonical"]')?.href, og: document.querySelector('meta[property="og:url"]')?.content, overflow: document.documentElement.scrollWidth - innerWidth, theme: document.documentElement.dataset.theme, resources: [...document.querySelectorAll('link[href],script[src]')].map(e => e.href || e.src).filter(u => new URL(u).origin === location.origin), fragments: [...document.querySelectorAll('.sl-markdown-content a[href*="#"]')].map(e => e.href) }));
      assert.equal(data.lang, 'en'); assert(data.title && data.description); assert.equal(data.canonical, target + route); assert.equal(data.og, target + route); assert.equal(data.theme, theme); assert(data.overflow <= 1, `Horizontal clipping: ${route}`);
      for (const url of data.resources) {
        const u = new URL(url); assert(u.pathname.startsWith('/nibfin/'), `Asset escapes base: ${url}`);
        const r = await context.request.get(url); assert(r.ok(), `Missing resource: ${url}`);
        const expected = mime[extname(u.pathname)]; if (expected) assert(r.headers()['content-type']?.includes(expected), `Wrong MIME: ${url}`);
        report.resources.push({ url: u.pathname, status: r.status(), contentType: r.headers()['content-type'], sha256: hash(await r.body()) });
        if (live) assert.equal(hash(await r.body()), hash(readFileSync(resolve('dist', '.' + u.pathname.slice(7)))), `Stale live resource: ${url}`);
      }
      const fragment = data.fragments.find(u => new URL(u).pathname === new URL(page.url()).pathname);
      if (fragment) { await page.goto(fragment); assert(await page.locator(`[id="${decodeURIComponent(new URL(fragment).hash.slice(1))}"]`).count()); }
      await capture(page, `${route.replaceAll('/', '') || 'home'}-${viewport.width}-${theme}`);
      report.cases.push({ route, viewport, theme, directLoad: true, reload: true, ...data });
    }
    await page.goto(base); await page.waitForLoadState('networkidle');
    await page.keyboard.press('Tab');
    assert(await page.locator('a[href="#_top"]').evaluateAll(es => es.includes(document.activeElement)), 'Skip link not first');
    await page.keyboard.press('Enter');
    await search(page);
    if (viewport.width < 800) {
      const menu = page.locator('starlight-menu-button button'); await menu.focus(); await page.keyboard.press('Enter'); assert.equal(await page.locator('starlight-menu-button').getAttribute('aria-expanded'), 'true');
      await page.locator('starlight-theme-select select:visible').selectOption(theme);
      await menu.click();
    } else await page.locator('starlight-theme-select select:visible').selectOption(theme);
    await page.reload(); await page.waitForLoadState('networkidle'); assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    if (viewport.width < 800) {
      const summary = page.locator('summary:visible').first();
      await summary.focus(); await page.keyboard.press('Enter');
      assert(await summary.evaluate(e => e.parentElement.open), 'Mobile table of contents did not open');
      await page.keyboard.press('Enter'); assert(await summary.evaluate(e => !e.parentElement.open));
    }
    await Promise.all(pending);
    report.cases.push({ viewport, theme, search: 'two terms followed, no-results and recovery, Escape focus restoration', skipLink: true, themePersistence: true });
    await context.close();
  }
  for (const url of new Set(report.cancelledRequests)) {
    const u = new URL(url); assert(u.pathname.startsWith('/nibfin/'));
    const r = await fetch(url); assert(r.ok, 'Cancelled resource cannot be loaded');
    assert.equal(hash(Buffer.from(await r.arrayBuffer())), build.outputs[u.pathname.slice(8)], 'Cancelled resource differs from build');
  }
  assert.deepEqual(errors, [], 'Browser console/request defects');
  // The generated 404 is a real file, not a normal directory route.
  const r = await fetch(base + '404.html'); const html = await r.text();
  assert.equal(hash(Buffer.from(html)), build.outputs['404.html'], '404 differs from retained output');
  assert(html.includes(target + '404.html'), '404 canonical missing');
  if (!live && !negative) {
    report.negativeCases = [];
    for (const fixture of ['missing-asset', 'wrong-base', 'unusable-search']) {
      const result = spawnSync(process.execPath, ['tooling/site-evidence.mjs'], { env: { ...process.env, SITE_NEGATIVE_CASE: fixture }, encoding: 'utf8', timeout: 90000 });
      assert.notEqual(result.status, 0, `Negative fixture passed: ${fixture}`);
      const failure = JSON.parse(readFileSync(`out/negative-${fixture}-failure.json`));
      assert.equal(failure.status, 'failed');
      assert.deepEqual(failure.inputs, build.inputs);
      assert.match(failure.error, fixture === 'wrong-base' ? /AssertionError/ : /Timeout|resource|HTTP|Missing|clipping/i);
      report.negativeCases.push({ fixture, exitCode: result.status, error: failure.error, browserErrors: failure.errors, buildArchive: failure.buildArchive });
    }
  }
  report.completedAt = new Date().toISOString(); report.status = 'passed';
  assert.equal(spawnSync('tar', ['-czf', `out/${output}-screenshots.tar.gz`, '-C', `out/${output}-screenshots`, ...report.screenshots.map(s => s.member)]).status, 0);
  report.screenshotArchive = { path: `website/out/${output}-screenshots.tar.gz`, sha256: hash(readFileSync(`out/${output}-screenshots.tar.gz`)) };
  writeFileSync(`out/${output}-evidence.json`, JSON.stringify(report, null, 2) + '\n');
} catch (error) {
  writeFileSync(`out/${output}-failure.json`, JSON.stringify({ ...report, status: 'failed', error: error.stack, errors }, null, 2)); throw error;
} finally { await browser.close(); if (!live) await new Promise(r => server.close(r)); }
