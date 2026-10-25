import { verifyBuild } from './build-identity.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { platform, release } from 'node:os';
import { chromium } from 'playwright';
import { contrast, checkSample } from './theme-metrics.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const build = verifyBuild();
// Reject stale build proof before measuring a different source tree.
for (const [path, digest] of Object.entries(build.inputs)) assert.equal(hash(readFileSync(resolve('..', path))), digest, `Stale build: ${path}`);
assert.equal(hash(readFileSync('out/site.tar.gz')), build.archive.sha256);
assert.equal(spawnSync('tar', ['-dzf', 'out/site.tar.gz', '-C', 'dist']).status, 0, 'Served build differs from retained archive');
const root = resolve('dist');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/nibfin/')) { res.writeHead(404).end(); return; }
    let path = resolve(root, '.' + decodeURIComponent(url.pathname.slice('/nibfin'.length)));
    if (!path.startsWith(root + '/') && path !== root) throw new Error('Path outside build');
    if (statSync(path).isDirectory()) path += '/index.html';
    res.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream');
    res.end(readFileSync(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.THEME_BROWSER_PATH || undefined, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const report = { schemaVersion: 1, createdAt: new Date().toISOString(), browser: browser.version(), playwright: JSON.parse(readFileSync('node_modules/playwright/package.json')).version, os: { platform: platform(), release: release() }, browserExecutable: process.env.THEME_BROWSER_PATH ? { path: process.env.THEME_BROWSER_PATH, sha256: hash(readFileSync(process.env.THEME_BROWSER_PATH)) } : 'Playwright managed Chromium', commands: ['npm run evidence', 'npm run evidence:theme'], buildArchive: build.archive, inputs: build.inputs, samples: [], preferences: [], keyboard: [], boundaries: [], screenshots: [], limits: 'Local built site only; no Pages deployment, product E2E or independent Acceptance claimed.' };
mkdirSync('out/theme-screenshots', { recursive: true });
async function screenshot(page, name) {
  const path = `out/theme-screenshots/${name}.png`;
  if (!name.endsWith('-focus') && !name.endsWith('-search')) await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path, fullPage: !name.endsWith('-focus') && !name.endsWith('-search') });
  report.screenshots.push({ member: `${name}.png`, sha256: hash(readFileSync(path)) });
}
async function sample(page, expectedTheme) {
  const data = await page.evaluate(() => {
    const style = e => getComputedStyle(e);
    const background = e => {
      for (let node = e; node; node = node.parentElement) { const c = style(node).backgroundColor; if (c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c; }
      return style(document.body).backgroundColor;
    };
    const root = document.documentElement, main = document.querySelector('.sl-markdown-content');
    const body = main.querySelector('p'), link = main.querySelector('p a'), badge = document.querySelector('[data-testid="flowbite-badge"]');
    const css = style(root), token = name => css.getPropertyValue(name).trim();
    // Resolve custom properties to rendered RGB through a hidden probe, not string guesses.
    const color = name => { const e = document.createElement('span'); e.style.color = `var(${name})`; root.append(e); const c = style(e).color; e.remove(); return c; };
    const visible = selector => [...document.querySelectorAll(selector)].find(e => e.getClientRects().length > 0);
    const pairs = [];
    const pair = (name, e, minimum = 4.5) => { if (e) pairs.push({ name, foreground: style(e).color, background: background(e), minimum }); };
    pair('body', body); pair('content-link', link); pair('heading', document.querySelector('h1'), 3);
    pair('muted TOC', visible('starlight-toc a'));
    pair('theme selector', visible('starlight-theme-select select'));
    pair('search button', document.querySelector('[data-open-modal]'));
    pair('menu icon', visible('starlight-menu-button button'), 3);
    const input = visible('dialog[open] input');
    if (input) pairs.push({ name: 'search placeholder', foreground: getComputedStyle(input, '::placeholder').color, background: background(input), minimum: 4.5 });
    pair('open search input', document.querySelector('dialog[open] input'));
    pair('open search result', document.querySelector('dialog[open] .pagefind-ui__result-link')); 
    pair('selected navigation', visible('[aria-current="page"]'));
    pair('status', badge);
    for (const [name, e] of [['search boundary', visible('[data-open-modal]')], ['status boundary', badge], ['open search boundary', visible('dialog[open] input')]]) {
      if (e && parseFloat(style(e).borderTopWidth) > 0) pairs.push({ name, foreground: style(e).borderTopColor, background: background(e), minimum: 3 });
    }
    const selected = visible('.sidebar [aria-current="page"]');
    if (selected) pairs.push({ name: 'selected navigation indicator', foreground: background(selected), background: background(selected.parentElement), minimum: 3 });
    const focused = document.activeElement;
    if (focused && style(focused).outlineStyle === 'solid') pairs.push({ name: 'rendered focus outline', foreground: style(focused).outlineColor, background: background(focused.parentElement), minimum: 3 });
    pairs.push({ name: 'meaningful border', foreground: color('--nf-border'), background: color('--nf-raised'), minimum: 3 });
    pairs.push({ name: 'focus on surface', foreground: color('--nf-focus'), background: color('--nf-surface'), minimum: 3 });
    pairs.push({ name: 'focus on raised', foreground: color('--nf-focus'), background: color('--nf-raised'), minimum: 3 });
    return { rootTheme: root.dataset.theme, surface: style(document.body).backgroundColor, tokenSurface: color('--nf-surface'), tokenStatus: color('--nf-status-text'), badge: badge ? { color: style(badge).color, background: background(badge), text: badge.textContent } : null, overflow: root.scrollWidth - root.clientWidth, brandOverflow: document.querySelector('.site-title span').scrollWidth - document.querySelector('.site-title span').clientWidth, rootFontSize: css.fontSize, bodyFontSize: style(body).fontSize, bodyFont: style(body).fontFamily, headingFont: style(document.querySelector('h1')).fontFamily, fonts: [...document.fonts].filter(f => f.status === 'loaded').map(f => ({ family: f.family, status: f.status })), pairs, motion: { reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, violations: [...document.querySelectorAll('*')].filter(e => { const s = style(e); return s.animationName !== 'none' || s.transitionDuration.split(',').some(v => parseFloat(v) > 0) || s.scrollBehavior === 'smooth'; }).length }, spacing: token('--sl-content-pad-x') };
  });
  data.expectedTheme = expectedTheme;
  data.pairs = data.pairs.map(p => ({ ...p, ratio: contrast(p.foreground, p.background) }));
  checkSample(data);
  if (data.motion.reduced) assert.equal(data.motion.violations, 0, 'Reduced motion leaves nonessential motion');
  return data;
}
async function menu(page) {
  const button = page.locator('starlight-menu-button button');
  if (await button.isVisible() && await button.getAttribute('aria-expanded') !== 'true') { await button.focus(); await page.keyboard.press('Enter'); }
}
async function keyboard(page, name, mobile) {
  // Reach each real control with Tab. Mobile theme choice lives inside Starlight's menu.
  const targets = mobile ? ['starlight-menu-button button', 'starlight-theme-select select'] : ['starlight-theme-select select'];
  const reached = [];
  const initialMode = await page.locator('html').getAttribute('data-theme');
  for (const selector of targets) {
    let found = false;
    for (let n = 0; n < 60; n++) {
      await page.keyboard.press('Tab');
      if (await page.locator(selector).evaluateAll(es => es.includes(document.activeElement))) { found = true; break; }
    }
    assert(found, `Keyboard unreachable: ${selector}`);
    reached.push(selector);
    if (selector.includes('menu-button')) await page.keyboard.press('Enter');
  }
  const select = page.locator('starlight-theme-select select:visible');
  await select.focus(); await page.keyboard.press('Home');
  if (initialMode === 'light') await page.keyboard.press('ArrowDown');
  assert.equal(await select.inputValue(), initialMode, 'Native keyboard theme selection');
  const focus = await select.evaluate(e => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return { outline: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor, top: r.top, bottom: r.bottom, viewport: innerHeight }; });
  assert.equal(focus.outline, 'solid'); assert.equal(focus.width, '3px'); assert(focus.top >= 0 && focus.bottom <= focus.viewport);
  await screenshot(page, `${name}-focus`);
  const selectedMode = await page.locator('html').getAttribute('data-theme');
  const focusSample = await sample(page, selectedMode);
  // Close mobile menu using keyboard, then find search in normal tab order.
  if (mobile) { const b = page.locator('starlight-menu-button button'); await b.focus(); await page.keyboard.press('Enter'); }
  let found = false;
  for (let n = 0; n < 60; n++) { await page.keyboard.press('Tab'); if (await page.locator('[data-open-modal]').evaluate(e => e === document.activeElement)) { found = true; break; } }
  assert(found, 'Search unreachable with Tab');
  await page.keyboard.press('Enter');
  await page.locator('dialog[open]').waitFor();
  await page.locator('dialog input').waitFor();
  const searchSample = await sample(page, selectedMode);
  await screenshot(page, `${name}-search`);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog[open]').count(), 0);
  assert(await page.locator('[data-open-modal]').evaluate(e => document.activeElement === e), 'Search focus restoration');
  if (mobile) await menu(page);
  async function tabTo(selector) {
    for (let n = 0; n < 80; n++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(selector => document.activeElement.matches(selector), selector)) return;
    }
    throw new Error(`Keyboard unreachable: ${selector}`);
  }
  await tabTo('.sidebar a[href]');
  await Promise.all([page.waitForEvent('domcontentloaded'), page.keyboard.press('Enter')]); await page.waitForLoadState('networkidle');
  if (mobile) { const b = page.locator('starlight-menu-button button'); if (await b.getAttribute('aria-expanded') === 'true') { await b.focus(); await page.keyboard.press('Enter'); } }
  await tabTo('.sl-markdown-content p a[href]');
  await Promise.all([page.waitForEvent('domcontentloaded'), page.keyboard.press('Enter')]); await page.waitForLoadState('networkidle');
  report.keyboard.push({ name, reached, focus, focusSample, searchSample, search: 'Tab → Enter opens, Escape dismisses and returns focus to opener', navigation: 'Enter follows native navigation link', contentLink: 'Tab reaches and Enter follows a real content link', disabled: 'Search is transiently disabled before its native script initializes; no persistent disabled controls or interactive badge exist.' });
}
try {
  const routes = ['', 'quick-start/'];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    for (const mode of ['light', 'dark']) {
      const context = await browser.newContext({ viewport, colorScheme: mode, reducedMotion: 'reduce' });
      await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
      const page = await context.newPage();
      for (const path of routes) {
        await page.goto(`${origin}/nibfin/${path}`); await page.waitForLoadState('networkidle'); await page.evaluate(() => document.fonts.ready);
        const name = `${path ? 'docs' : 'home'}-${viewport.width}-${mode}`;
        const data = await sample(page, mode);
        assert(data.bodyFont.includes('DM Sans Variable') && data.headingFont.includes('Space Grotesk Variable'), 'Typography adapter disconnected');
        assert(data.fonts.some(f => f.family.includes('DM Sans')) && data.fonts.some(f => f.family.includes('Space Grotesk')), 'Declared fonts not loaded');
        report.samples.push({ name, viewport, ...data }); await screenshot(page, name);
        const link = page.locator('.sl-markdown-content p a[href]').first();
        await link.hover();
        report.samples.push({ name: `${name}-hover`, viewport, ...await sample(page, mode) });
        await page.mouse.move(0, 0);
        await keyboard(page, name, viewport.width < 800);
        await page.evaluate(() => localStorage.removeItem('starlight-theme')); // Isolate the next system-mode case.
      }
      await context.close();
    }
  }
  // Fresh system preference changes and explicit persistence override the system.
  const context = await browser.newContext({ colorScheme: 'dark' }), page = await context.newPage();
  await page.goto(`${origin}/nibfin/`); await page.waitForLoadState('networkidle');
  for (const mode of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme: mode });
    await page.waitForFunction(mode => document.documentElement.dataset.theme === mode, mode);
    report.preferences.push({ choice: 'fresh/system', mode, sample: await sample(page, mode) });
  }
  for (const mode of ['dark', 'light']) {
    await page.locator('starlight-theme-select select:visible').selectOption(mode);
    await page.emulateMedia({ colorScheme: mode === 'dark' ? 'light' : 'dark' });
    await page.goto(`${origin}/nibfin/quick-start/`); await page.reload(); await page.waitForLoadState('networkidle');
    report.preferences.push({ choice: 'explicit/navigation/reload', mode, stored: await page.evaluate(() => localStorage.getItem('starlight-theme')), sample: await sample(page, mode) });
  }
  await page.locator('starlight-theme-select select:visible').selectOption('auto');
  report.preferences.push({ choice: 'return to system', sample: await sample(page, 'dark') });
  // Longest source page, 320px reflow, 200% text enlargement and blocked font requests.
  await page.goto(`${origin}/nibfin/`); await page.waitForLoadState('networkidle');
  const broken = await page.addStyleTag({ content: '.nf-status { color: rgb(0, 0, 0) !important; }' });
  await assert.rejects(() => sample(page, 'dark'), /Broken Flowbite token mapping/);
  await broken.evaluate(e => e.remove());
  report.negativeCase = 'Injected a broken Flowbite color adapter in the live page; rendered check rejected it, then the injected style was removed.';
  const longest = readdirSync('src/content/docs').filter(p => p.endsWith('.mdx')).sort((a, b) => statSync(`src/content/docs/${b}`).size - statSync(`src/content/docs/${a}`).size)[0];
  for (const path of new Set(['', 'quick-start/', longest === 'index.mdx' ? '' : longest.replace('.mdx', '/')])) {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto(`${origin}/nibfin/${path}`); await page.waitForLoadState('networkidle');
    report.boundaries.push({ path, width: 320, sample: await sample(page, 'dark') });
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    const enlarged = await sample(page, 'dark');
    assert(parseFloat(enlarged.bodyFontSize) >= 32, 'Text enlargement was not applied');
    report.boundaries.push({ path, width: 320, textZoom: '200% root font size; not deviceScaleFactor', sample: enlarged });
    await menu(page);
    const theme = page.locator('starlight-theme-select select:visible');
    await theme.focus(); await page.keyboard.press('Home');
    assert(await theme.isVisible(), 'Theme control inaccessible after reflow');
    const toggle = page.locator('starlight-menu-button button'); await toggle.focus(); await page.keyboard.press('Enter');
    await page.locator('[data-open-modal]').focus(); await page.keyboard.press('Enter');
    const zoomInput = page.locator('dialog[open] input'); await zoomInput.waitFor();
    const textArea = await zoomInput.evaluate(e => { const s = getComputedStyle(e); return e.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight); });
    assert(textArea >= 80, 'Search text area clipped after text enlargement');
    await zoomInput.focus(); await zoomInput.pressSequentially('Nibfin');
    assert.equal(await zoomInput.inputValue(), 'Nibfin');
    report.boundaries.push({ path, width: 320, textZoom: '200%', searchTextArea: textArea, searchSample: await sample(page, 'dark') });
    await screenshot(page, `reflow-${path.replaceAll('/', '') || 'home'}-search`);
    await page.keyboard.press('Escape');
    await screenshot(page, `reflow-${path.replaceAll('/', '') || 'home'}`);
  }
  await context.close();
  const fallback = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  await fallback.route('**/*.woff2', route => route.abort());
  const fp = await fallback.newPage(); await fp.goto(`${origin}/nibfin/`); await fp.waitForLoadState('networkidle');
  report.fallback = await sample(fp, 'dark');
  assert.equal(report.fallback.fonts.length, 0, 'Font blocking failed');
  await screenshot(fp, 'fallback-home');
  await keyboard(fp, 'fallback', true);
  report.motion = await fp.evaluate(() => {
    const nodes = [document.documentElement, ...document.querySelectorAll('body *')];
    return { preference: matchMedia('(prefers-reduced-motion: reduce)').matches, violations: nodes.filter(e => { const s = getComputedStyle(e); return s.animationName !== 'none' || s.transitionDuration.split(',').some(v => parseFloat(v) !== 0) || s.scrollBehavior === 'smooth'; }).map(e => e.tagName) };
  });
  assert(report.motion.preference); assert.deepEqual(report.motion.violations, []);
  await fallback.close();
  const tar = spawnSync('tar', ['-czf', 'out/theme-screenshots.tar.gz', '-C', 'out/theme-screenshots', ...report.screenshots.map(s => s.member)]);
  assert.equal(tar.status, 0);
  report.screenshotArchive = { path: 'website/out/theme-screenshots.tar.gz', sha256: hash(readFileSync('out/theme-screenshots.tar.gz')) };
  report.criteria = { AC1: 'Shared adapters and computed samples', AC2: 'Loaded/fallback fonts, viewport/reflow samples and screenshots', AC3: 'Fresh system and persisted explicit navigation/reload', AC4: 'Keyboard control and focus observations', AC5: 'Rendered contrast and reduced-motion observations', AC6: 'Build report plus retained browser/negative checks; visual inspection recorded separately' };
  writeFileSync('out/theme-evidence.json', JSON.stringify(report, null, 2) + '\n');
  console.log(`Retained ${report.samples.length} rendered samples and ${report.screenshots.length} screenshots.`);
} finally { await browser.close(); await new Promise(r => server.close(r)); }
