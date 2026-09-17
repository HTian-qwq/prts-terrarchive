import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '/home/cloudstack/ai-data/prts.chat/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const dir = new URL('.', import.meta.url), url = 'http://127.0.0.1:4177/';
const fixture = JSON.parse(await readFile(new URL('../rhine-array-body/sources.json', dir), 'utf8'));
const subjects = ['切尔诺伯格', '乌萨斯', '龙门', '莱茵生命', '罗德岛', '萨米', '卡西米尔', '维多利亚', '拉特兰', '伊比利亚', '谢拉格', '炎国'];
for (let index = fixture.sources.length; index < 49; index++) fixture.sources.push({
  id: `test:tier-source-${index}`, documentUid: `test:tier-source-${index}`,
  title: `${subjects[index % subjects.length]} / 测试资料 ${index + 1}`,
  kind: 'entity_profile', origin: 'cloud', state: 'found',
  excerpt: '双层档案架浏览器验证资料，仅存在于本测试页面，用于检查层间抽取和翻页复用。',
});
const report = { errors: [], checks: [], layouts: [] };
const browser = await chromium.launch({ headless: true, executablePath: '/home/cloudstack/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'no-preference' });
  page.setDefaultTimeout(120000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', item => { if (item.type() === 'error') report.errors.push(item.text().slice(0, 1600)); });
  await page.route(url, async route => { const response = await route.fetch(); await route.fulfill({ response,
    body: (await response.text()).replace(/const snapshot=\{[^\n]*?\};/, `const snapshot=window.__fixture=${JSON.stringify(fixture)};`) }); });
  await page.addInitScript(() => {
    window.__skipDraws = false;
    for (const proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype])
      for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
        const original = proto[name];
        if (original) proto[name] = function(...args) { if (!window.__skipDraws) return original.apply(this, args); };
      }
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' }); console.log('Loaded');
  // Both real interior bakes complete before suppressing only draw submissions.
  await page.waitForFunction(() => window.rhineWorkbench?.stats().preparation?.completed >= 1, null, { polling: 100 });
  await page.evaluate(() => window.__skipDraws = true);
  await page.waitForFunction(() => window.rhineWorkbench.stats().physicalFiles === 24, null, { polling: 100 });
  async function settle() {
    const n = await page.evaluate(() => { window.__skipDraws = true; return window.rhineWorkbench.stats().renderedFrames; });
    await page.waitForFunction(n => window.rhineWorkbench.stats().renderedFrames > n + 100 && !window.rhineWorkbench.stats().movingCamera, n, { polling: 100 });
  }
  async function shot(name) {
    const n = await page.evaluate(() => { window.__skipDraws = false; return window.rhineWorkbench.stats().renderedFrames; });
    await page.waitForFunction(n => window.rhineWorkbench.stats().renderedFrames > n + 1, n, { polling: 100 });
    await page.screenshot({ path: new URL(name + '.png', dir).pathname });
    await page.evaluate(() => window.__skipDraws = true); console.log(name);
  }
  await page.locator('.rhine-nav-rack').click(); await settle();
  report.rack = await page.evaluate(() => window.rhineWorkbench.stats());
  assert.equal(report.rack.reducedMotion, false);
  assert.equal(report.rack.physicalCapacity, 24);
  assert.equal(report.rack.shelfLayout.frameBatches, 3);
  assert.equal(report.rack.shelfLayout.files.filter(file => file.level === 0).length, 12);
  assert.equal(report.rack.shelfLayout.files.filter(file => file.level === 1).length, 12);
  assert.equal(await page.locator('.rhine-desk-item').count(), 24);
  await shot('rack');
  for (const hit of [{ x: 1300, y: 400, index: 23 }, { x: 1300, y: 650, index: 11 }]) {
    await page.mouse.click(hit.x, hit.y); await settle();
    assert.equal(await page.evaluate(() => window.rhineWorkbench.stats().focusedId), fixture.sources[hit.index].id,
      `ray picking must select the actual ${hit.index === 23 ? 'upper' : 'lower'} front cassette`);
  }
  report.checks.push('pointer clicks select the correct upper and lower physical cassette');
  if (!process.env.RHINE_LAYOUT_ONLY) {
  for (const index of [0, 12]) {
    await page.locator(`.rhine-desk-item[data-source-id="${fixture.sources[index].id}"]`).evaluate(element => element.click());
    await settle();
    const before = await page.evaluate(() => window.rhineWorkbench.stats());
    const start = before.shelfLayout.files.find(file => file.id === fixture.sources[index].id);
    await page.evaluate(() => {
      window.__motion = [];
      window.__motionTimer = setInterval(() => { const value = window.rhineWorkbench.stats().inspectedFile;
        if (value) window.__motion.push(value); }, 16);
      document.querySelector('.rhine-shelf-open').click();
    });
    await page.waitForFunction(() => window.rhineWorkbench.stats().inspectedFile?.progress === 1, null, { polling: 100 });
    const trace = await page.evaluate(() => { clearInterval(window.__motionTimer); return window.__motion; });
    const early = trace.filter(file => file.progress > 0 && file.progress < .38);
    assert(early.length > 0, 'normal animation must expose the initial sliding phase');
    assert(early.every(file => Math.abs(file.position[1] - start.position[1]) < .001), 'slide keeps tier height until clear');
    assert(early.some(file => file.position[0] < start.position[0] - .5), 'the cassette slides out of the open front');
    const reader = await page.evaluate(() => window.rhineWorkbench.stats());
    assert.equal(reader.inspectedFile.id, fixture.sources[index].id);
    assert.equal(reader.inspectedFile.visible, true); assert.equal(reader.inspectedFile.representation, 'geometry');
    report[`reader${index}`] = { reader, trace };
    if (index === 12) await shot('upper-reader');
    await page.locator('.rhine-close-reader').click(); await settle();
    const returned = await page.evaluate(() => window.rhineWorkbench.stats());
    const restored = returned.shelfLayout.files.find(file => file.id === fixture.sources[index].id);
    assert.equal(restored.progress, 0);
    assert(Math.abs(restored.position[1] - start.position[1]) < .001);
    assert(returned.shelfLayout.files.every(file => file.visible));
    report.checks.push(`${index === 0 ? 'lower' : 'upper'} tier: horizontal extraction, correct full reader, return to original tier`);
    console.log(report.checks.at(-1));
  }
  // Page two starts before deferred geometry exists and then reuses page one's pool.
  report.pending = await page.evaluate(() => { document.querySelector('.rhine-desk-pagination button:last-child').click();
    document.querySelector('.rhine-shelf-open').click(); return window.rhineWorkbench.stats(); });
  await page.waitForFunction(() => window.rhineWorkbench.stats().inspectedFile?.progress === 1 && window.rhineWorkbench.stats().physicalFiles === 24, null, { polling: 100 });
  report.pageTwo = await page.evaluate(() => window.rhineWorkbench.stats());
  assert.equal(report.pending.inspectedFile, null);
  assert.equal(report.pageTwo.inspectedFile.id, fixture.sources[24].id);
  assert.equal(report.pageTwo.inspectedFile.visible, true);
  assert.equal(report.pageTwo.collectionResources.created, report.rack.collectionResources.created);
  await page.locator('.rhine-close-reader').click(); await settle();
  await page.locator('.rhine-desk-pagination button:last-child').evaluate(element => element.click()); await settle();
  report.lastPage = await page.evaluate(() => window.rhineWorkbench.stats());
  assert.equal(report.lastPage.physicalFiles, 1); assert.equal(report.lastPage.visibleIds[0], fixture.sources[48].id);
  assert.equal(await page.locator('.rhine-shelf-level-empty').count(), 1);
  await page.locator('.rhine-desk-pagination button:first-child').evaluate(element => element.click()); await settle();
  await page.locator('.rhine-desk-pagination button:first-child').evaluate(element => element.click()); await settle();
  report.reused = await page.evaluate(() => window.rhineWorkbench.stats());
  assert.equal(report.reused.physicalFiles, 24);
  assert.equal(report.reused.collectionResources.created, report.rack.collectionResources.created);
  report.checks.push('49 sources: 24/24/1 paging, deferred reader visibility, no additional cassette allocation on return');
  }
  for (const size of [{ width: 2560, height: 1264 }, { width: 900, height: 600 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await page.waitForFunction(() => { const root = document.querySelector('.rhine-workbench'), rect = document.querySelector('.rhine-original-stage').getBoundingClientRect();
      return Math.abs(rect.width - root.clientWidth) < 2 && Math.abs(rect.height - root.clientHeight) < 2; }, null, { polling: 100 });
    await settle();
    const layout = await page.evaluate(() => { const panel = document.querySelector('.rhine-desk-panel'), r = panel.getBoundingClientRect();
      return { width: innerWidth, height: innerHeight, x: r.x, y: r.y, right: r.right, bottom: r.bottom, clientWidth: panel.clientWidth, scrollWidth: panel.scrollWidth,
        levelLabels: [...document.querySelectorAll('.rhine-shelf-level-label')].map(item => item.textContent) }; });
    report.layouts.push(layout); assert(layout.x >= 0 && layout.right <= size.width + 1 && layout.bottom <= size.height + 1);
    assert(layout.scrollWidth <= layout.clientWidth + 1);
    if (size.width === 390) await shot('portrait');
  }
  assert.deepEqual(report.errors, []); await page.evaluate(() => window.rhineWorkbench.dispose());
} catch (error) { report.failure = String(error.stack || error); throw error; }
finally { await writeFile(new URL(process.env.RHINE_LAYOUT_ONLY ? 'layout-final.json' : 'browser.json', dir), JSON.stringify(report, null, 2)); await browser.close(); console.log('Report saved'); }
