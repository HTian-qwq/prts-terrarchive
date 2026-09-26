// Exercise the packaged WebUI through real React, CSS, fonts and WebGL assets.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const hostDir = resolve(process.env.PRTS_DSH_SOURCE_DIR || join(root, '../deepseek-harness'));
const hostRequire = createRequire(join(hostDir, 'packages/client/ui-conversation/package.json'));
const localRequire = createRequire(new URL('../package.json', import.meta.url));
const { build } = createRequire(localRequire.resolve('vite/package.json'))('esbuild');
const playwright = process.env.PRTS_PLAYWRIGHT_MODULE || createRequire(join(hostDir, 'package.json')).resolve('playwright');
const { chromium } = await import(pathToFileURL(resolve(playwright)).href);
const output = process.env.PRTS_RHINE_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'prts-skin-loading-'));
let fixture = await readFile(new URL('./fixtures/rhine-host.js', import.meta.url), 'utf8');
fixture += `
window.renderSkinCard=()=>{const host=document.createElement('div');document.body.append(host);window.skinRoot=createRoot(host);window.skinRoot.render(React.createElement(window.hostPlugin.__skinStateForTest.SkinCard,{skin:'rhine-lab',onChanged:()=>{}}));};`;
await build({ stdin: { contents: fixture.replace('"@host-react"', JSON.stringify(hostRequire.resolve('react'))).replace('"@host-react-dom"', JSON.stringify(hostRequire.resolve('react-dom/client'))), resolveDir: root }, bundle: true, format: 'iife', outfile: join(output, 'react.js') });
const browser = await chromium.launch({ headless: true, ...(process.env.PRTS_BROWSER_EXECUTABLE ? { executablePath: process.env.PRTS_BROWSER_EXECUTABLE } : {}), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, reducedMotion: 'no-preference' });
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  let releaseModel;
  let modelGate = new Promise(resolve => { releaseModel = resolve; });
  let releaseCatalogue;
  const catalogueGate = new Promise(resolve => { releaseCatalogue = resolve; });
  await page.route('http://prts-skin.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><meta charset="utf-8"><style>body{margin:0}#host{height:100vh}</style><div id="host"></div></html>' });
    if (path === '/api/prts-corpus/ui-skin.json') return route.fulfill({ json: { uiSkin: 'rhine-lab' } });
    if (path === '/api/prts-corpus/rpc') {
      const { endpoint } = route.request().postDataJSON();
      if (endpoint === 'archive.search') await catalogueGate;
      if (endpoint.startsWith('investigation.')) return route.fulfill({ json: { ok: false, error: { message: 'Investigation service unavailable in fixture' } } });
      if (endpoint === 'config.update') await new Promise(resolve => setTimeout(resolve, 500));
      return route.fulfill({ json: { ok: true, value: endpoint === 'status' ? { config: { uiSkin: 'rhine-lab' } } : { sources: [], page: { has_more: false } } } });
    }
    const relative = path.replace('/api/prts-corpus/', '');
    if (!/^(skins|rhine)\/[\w./-]+$/.test(relative) || relative.includes('..')) return route.fulfill({ status: 404 });
    if (relative.endsWith('archive-cassette.glb')) await modelGate;
    const type = relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.woff2') ? 'font/woff2' : 'model/gltf-binary';
    await route.fulfill({ contentType: type, body: await readFile(join(root, 'lib', relative)) });
  });
  await page.goto('http://prts-skin.test/');
  await page.addScriptTag({ path: join(output, 'react.js') });
  await page.evaluate(() => { window.__ModuleLoader__ = { load({ factory }) { window.hostPlugin = factory(() => window.hostReact); } }; });
  await page.addScriptTag({ path: join(root, 'lib/client.js') });
  await page.evaluate(() => {
    const cleanups = [], slots = [];
    let tokenOwner;
    const ctx = { theme: { overrideTokens(_source, tokens) {
      const owner = {}; tokenOwner = owner;
      const values = Object.entries(tokens);
      for (const [key, value] of values) document.body.style.setProperty(key, value.light);
      return () => { if (tokenOwner === owner) for (const [key] of values) document.body.style.removeProperty(key); };
    } }, sessions: { binding: () => ({ session: {} }) }, slots: {
      inject: (_name, fn) => fn(), register: (entry, Component) => { slots.push({ entry, Component }); return () => {}; },
    }, effect: fn => { const dispose = fn(); cleanups.push(dispose); return dispose; } };
    window.hostPlugin.apply(ctx); window.renderRhineHost(slots);
    window.hostCleanup = () => { window.hostRoot.unmount(); cleanups.reverse().forEach(fn => fn?.()); };
  });
  await page.waitForSelector('.rhine-scene-loader');
  const loadingState = () => page.evaluate(() => {
    const root = document.querySelector('.rhine-workbench'), loader = root.querySelector('.rhine-scene-loader'), stage = root.querySelector('.rhine-original-stage');
    const box = loader.getBoundingClientRect();
    return { state: root.dataset.sceneState, opaque: getComputedStyle(loader).backgroundColor, stage: getComputedStyle(stage).visibility, inert: stage.inert, width: box.width, height: box.height, covering: loader.contains(document.elementFromPoint(innerWidth / 2, innerHeight / 2)), animation: loader.querySelector('i').getAnimations()[0]?.playState };
  });
  let state = await loadingState();
  assert.equal(state.state, 'loading'); assert.equal(state.stage, 'hidden'); assert.equal(state.inert, true);
  assert.equal(state.opaque, 'rgb(235, 232, 226)'); assert.equal(state.width, 1000); assert.equal(state.height, 700); assert.equal(state.covering, true); assert.equal(state.animation, 'running');
  await page.screenshot({ path: join(output, 'loading.png') });
  console.log('PASS opaque animated loader while model is pending');
  releaseModel();
  await page.waitForFunction(() => window.rhineWorkbench?.stats().loaded, undefined, { polling: 100 });
  // A downloaded model still must not expose an incomplete catalogue/scene.
  state = await loadingState(); assert.equal(state.state, 'loading'); assert.equal(state.stage, 'hidden');
  console.log('PASS loader retained after model download while catalogue is pending');
  releaseCatalogue();
  await page.waitForFunction(() => document.querySelector('.rhine-workbench')?.dataset.sceneState === 'ready', undefined, { polling: 100 });
  assert.equal(await page.locator('.rhine-scene-loader').isVisible(), false);
  const stats = await page.evaluate(() => { const stats = window.rhineWorkbench.stats(); window.rhineWorkbench.setActive(false); return stats; });
  assert.equal(stats.preparation.pending, 0);
  assert.equal(stats.preparation.running, false);
  assert.equal(stats.preparation.pendingShelf, 0);
  assert.ok(stats.renderedFrames > 0);
  console.log('PASS scene revealed after preparation and first frame');
  assert.equal(await page.locator('.rhine-original-stage').evaluate(el => el.inert), false);
  // Host-owned settings: the header seat is shared by inline and portal versions.
  await page.evaluate(() => {
    const panel = document.createElement('div'); panel.id = 'settings-fixture'; panel.role = 'dialog'; panel.setAttribute('aria-modal', 'true');
    panel.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:1000;display:flex';
    panel.innerHTML = '<nav><h3 data-slot="settings.header">设置</h3><button aria-current="true">内置插件</button></nav><main style="padding:24px;min-width:0;flex:1"><h2>PRTS 语料</h2><div class="prts-settings-wrap"><div class="prts-skin-options"><button class="prts-skin-option" aria-pressed="true">莱茵生命资料馆</button><button class="prts-skin-option">PRTS Agent</button></div></div></main>';
    document.body.append(panel);
  });
  const panelStyle = await page.locator('#settings-fixture').evaluate(el => ({ background: getComputedStyle(el).backgroundColor, radius: getComputedStyle(el).borderRadius, nav: getComputedStyle(el.querySelector('nav')).backgroundColor }));
  assert.deepEqual(panelStyle, { background: 'rgb(243, 240, 232)', radius: '4px', nav: 'rgb(231, 227, 217)' });
  await page.screenshot({ path: join(output, 'settings.png') });
  await page.setViewportSize({ width: 390, height: 760 });
  const panelBounds = await page.locator('#settings-fixture').boundingBox();
  assert.ok(panelBounds.x >= 0 && panelBounds.x + panelBounds.width <= 390);
  await page.locator('#settings-fixture').evaluate(el => el.remove());
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.evaluate(() => { window.renderSkinCard(); window.rhineWorkbench.setActive(false); });
  // Programmatic click reaches the settings card behind the workbench fixture.
  await page.getByRole('button', { name: /PRTS Agent/ }).evaluate(el => el.click());
  await page.waitForSelector('.aic-boot[data-skin="prts-agent"]');
  assert.equal(await page.locator('.aic-boot-logo').textContent(), 'PRTS');
  assert.ok(!(await page.locator('.aic-boot').textContent()).includes('ENDFIELD'));
  await page.waitForFunction(() => document.body.dataset.prtsSkin === 'agent');
  // Match the real sidebar's elevated-fill and text tokens from both DSH versions.
  await page.evaluate(() => {
    const sidebar = document.createElement('aside'); document.body.append(sidebar); sidebar.innerHTML = '<div><div data-slot="sidebar"><button id="new-session" style="background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary)"><span>新会话</span></button></div><div></div><div data-shell-overlay="true"></div></div>';
  });
  const button = await page.locator('#new-session').evaluate(el => ({ fill: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }));
  assert.deepEqual(button, { fill: 'rgb(41, 45, 42)', color: 'rgb(247, 247, 244)' });
  await page.locator('[data-slot="sidebar"]').evaluate(el => {
    el.insertAdjacentHTML('beforeend', '<div role="dialog"><button id="legacy-settings-button" style="background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary)">旧版设置</button></div>');
  });
  assert.deepEqual(await page.locator('#legacy-settings-button').evaluate(el => ({ fill: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color })), { fill: 'rgba(255, 255, 255, 0.92)', color: 'rgb(17, 18, 20)' });

  await page.evaluate(async () => {
    const original = HTMLCanvasElement.prototype.getContext;
    window.restoreContext = () => { HTMLCanvasElement.prototype.getContext = original; };
    HTMLCanvasElement.prototype.getContext = function(type, ...args) { return /^webgl/.test(type) ? null : original.call(this, type, ...args); };
    await window.hostPlugin.__skinStateForTest.setSkin('rhine-lab');
  });
  await page.waitForFunction(() => document.querySelector('.rhine-workbench')?.dataset.sceneState === 'unavailable');
  assert.equal(await page.locator('.rhine-scene-loader').isVisible(), false);
  assert.equal(await page.locator('.rhine-original-stage').evaluate(el => el.inert), false);
  console.log('PASS WebGL failure releases loader into reading mode');
  await page.evaluate(async () => { window.restoreContext(); await window.hostPlugin.__skinStateForTest.setSkin('harness'); });
  modelGate = new Promise(resolve => { releaseModel = resolve; });
  await page.evaluate(() => window.hostPlugin.__skinStateForTest.setSkin('rhine-lab'));
  await page.waitForSelector('.rhine-scene-loader');
  await page.locator('.rhine-loader-skip').click();
  assert.equal(await page.locator('.rhine-workbench').getAttribute('data-scene-state'), 'unavailable');
  releaseModel();
  // Leaving during a pending model load must not resurrect its overlay.
  await page.evaluate(() => window.hostPlugin.__skinStateForTest.setSkin('harness'));
  assert.equal(await page.locator('.prts-rhine-overlay').count(), 0);
  console.log('PASS pending scene can be skipped and unloaded');
  assert.deepEqual(errors, []);
  await page.evaluate(() => { window.skinRoot.unmount(); window.hostCleanup(); });
  await writeFile(join(output, 'result.json'), JSON.stringify({ state, stats, panelStyle, button, errors }, null, 2));
  console.log(`Skin loading browser check passed. Artifacts: ${output}`);
} finally { await browser.close(); }
