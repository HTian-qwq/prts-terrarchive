// Functional verification using actual RAF and GL commands. SwiftShader numbers
// are NOT a hardware benchmark. No synthetic RAF clock or suppressed GL draws.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '/home/cloudstack/ai-data/prts.chat/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const output = new URL('.', import.meta.url);
const fixture = JSON.parse(await readFile(new URL('../rhine-array-body/sources.json', import.meta.url), 'utf8'));
const browser = await chromium.launch({headless:true, executablePath:'/home/cloudstack/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const evidence = { method:'Functional browser check with actual RAF and all GL draws on SwiftShader. Contains a deliberately injected 85ms main-thread task and visibility simulations; timings are not a hardware benchmark.', errors:[], checkpoints:[] };
try {
  const page = await browser.newPage({viewport:{width:640,height:480},reducedMotion:'reduce',acceptDownloads:true});
  page.setDefaultTimeout(180000);
  page.on('pageerror', e => evidence.errors.push(e.message));
  await page.addInitScript(() => {
    window.__testRenderers = [];
    window.__THREE_DEVTOOLS__ = new EventTarget();
    window.__THREE_DEVTOOLS__.addEventListener('observe', e => { if(e.detail?.isWebGLRenderer)window.__testRenderers.push(e.detail); });
  });
  await page.route('http://127.0.0.1:4177/', async route => {
    const response = await route.fetch(); const body = (await response.text()).replace(/const snapshot=\{[^\n]*?\};/, `const snapshot=${JSON.stringify(fixture)};`);
    await route.fulfill({response,body});
  });
  await page.goto('http://127.0.0.1:4177/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => window.rhineWorkbench?.stats().renderedFrames >= 4, null, {polling:200});
  console.log('READY', await page.evaluate(() => window.rhineWorkbench.stats().renderedFrames));
  await page.locator('.rhine-perf-toggle').click();
  await page.locator('.rhine-perf-panel select').selectOption('120');
  await page.locator('[data-perf=start]').click();
  const frames = async n => {const start = await page.evaluate(() => window.rhineWorkbench.stats().renderedFrames);await page.waitForFunction(start=>window.rhineWorkbench.stats().renderedFrames>=start, start+n,{polling:100});};
  await frames(3);
  await page.evaluate(fixture=>window.rhineWorkbench.update({...fixture,phase:'searching',running:true,searching:true,outcome:'running'}),fixture);
  await frames(2);
  await page.evaluate(fixture=>window.rhineWorkbench.update(fixture),fixture);
  assert(await page.locator('[data-perf=start]').isDisabled());
  await page.evaluate(() => {const end=performance.now()+85;while(performance.now()<end){};});
  await frames(3);
  await page.screenshot({path:new URL('array-panel.png',output).pathname});
  await page.locator('[data-perf=close]').click();
  await page.evaluate(() => document.querySelector('[data-action=next]').click());
  await frames(3);
  await page.evaluate(() => window.rhineWorkbench.setActive(false));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.rhineWorkbench.setActive(true));
  await frames(2);
  console.log('ARRAY_CAPTURED');
  await page.evaluate(() => document.querySelector('.rhine-nav-rack').click());
  await page.waitForFunction(() => window.rhineWorkbench.stats().location==='desk'&&!window.rhineWorkbench.stats().movingCamera,null,{polling:100});
  await frames(3);
  await page.evaluate(() => document.querySelector('.rhine-shelf-open').click());
  await frames(3);
  console.log('RACK_AND_DETAIL_CAPTURED');
  await page.evaluate(() => document.querySelector('[data-action=inspect]').click());
  await page.waitForFunction(() => JSON.parse(document.querySelector('.model-viewer')?.dataset.stats||'{}').ready,null,{polling:100});
  await page.waitForTimeout(1500);
  await page.evaluate(() => {Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForTimeout(250);
  const viewerBefore = await page.evaluate(() => window.__testRenderers.at(-1).info.render.frame);
  await page.evaluate(() => {delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(before=>window.__testRenderers.at(-1).info.render.frame>before+8,viewerBefore,{polling:100});
  await page.locator('.rhine-perf-toggle').click();
  if(await page.locator('[data-perf=stop]').isEnabled()) await page.locator('[data-perf=stop]').click();
  await page.waitForFunction(()=>!document.querySelector('[data-perf=export]').disabled,null,{polling:100});
  await page.screenshot({path:new URL('viewer-panel.png',output).pathname});
  const downloaded = page.waitForEvent('download');
  await page.locator('[data-perf=export]').click();
  const download = await downloaded; await download.saveAs(new URL('capture.json',output).pathname);
  const capture = JSON.parse(await readFile(new URL('capture.json',output),'utf8'));
  assert.equal(capture.schema,'rhine-render-capture/v1'); assert.equal(capture.running,false); assert.equal(capture.pendingGpu,0);
  assert(capture.frames.length>15); assert.equal(capture.summary.failedFrames,0);
  assert(capture.frames.some(f=>f.state.startsWith('array'))); assert(capture.frames.some(f=>f.state.startsWith('rack')));
  assert(capture.frames.some(f=>f.state.includes(':search')));
  assert(capture.frames.some(f=>f.state.startsWith('detail'))); assert(capture.frames.some(f=>f.state==='viewer'));
  assert(capture.frames.filter(f=>f.state==='viewer').every(f=>f.calls>1),'viewer counts must include every pass');
  assert(capture.frames.some(f=>f.intervalMs>50));
  assert(capture.events.some(e=>e.kind==='pause-boundary'&&e.detail==='hidden'));
  if(capture.longTasksSupported)assert(capture.longTasks.some(t=>t.durationMs>=80));
  assert(capture.adapters.every(a=>a.software));
  assert(!JSON.stringify(capture).includes(fixture.sources[0].title),'export must not include document content');
  evidence.checkpoints.push({test:'scene + rack + detail + viewer + pauses + export',frames:capture.frames.length,states:Object.keys(capture.byState),gpu:capture.summary.gpuStatuses});
  const queryState = await page.evaluate(() => window.__testRenderers.map(r => {const gl=r.getContext(),ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');return {active:ext?Boolean(gl.getQuery(ext.TIME_ELAPSED_EXT,gl.CURRENT_QUERY)):false,autoReset:r.info.autoReset};}));
  assert(queryState.every(q=>!q.active));assert.equal(queryState.at(-1).autoReset,true);
  console.log('FULL_CAPTURE_VERIFIED',capture.frames.length,capture.summary.gpuStatuses);
  await page.evaluate(()=>window.rhineWorkbench.dispose());
  assert.equal(await page.locator('.rhine-perf-tools').count(),0);

  // Reopen in the same real browser with only timer extension support withheld.
  await page.addInitScript(() => {const original=WebGL2RenderingContext.prototype.getExtension;WebGL2RenderingContext.prototype.getExtension=function(name){return name==='EXT_disjoint_timer_query_webgl2'?null:original.call(this,name);};});
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.rhineWorkbench?.stats().renderedFrames>=3,null,{polling:100});
  await page.locator('.rhine-perf-toggle').click();await page.locator('[data-perf=start]').click();await frames(4);
  await page.locator('[data-perf=stop]').click();
  const noTimerDownload=page.waitForEvent('download');await page.locator('[data-perf=export]').click();
  await(await noTimerDownload).saveAs(new URL('unsupported.json',output).pathname);
  const unsupported=JSON.parse(await readFile(new URL('unsupported.json',output),'utf8'));
  assert(unsupported.frames.length>0);assert.equal(unsupported.summary.gpuMs.count,0);assert.equal(unsupported.summary.gpuMs.mean,null);
  assert(unsupported.frames.every(f=>f.gpuStatus==='unsupported'&&f.gpuMs===null));
  assert((await page.locator('.rhine-perf-gpu').innerText()).includes('不支持 GPU 计时'));
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:new URL('mobile-panel.png',output).pathname});
  const rect=await page.locator('.rhine-perf-panel').boundingBox();assert(rect.x>=0&&rect.x+rect.width<=391);
  evidence.checkpoints.push({test:'unsupported GPU timer + mobile fit + dispose',frames:unsupported.frames.length});
  await page.evaluate(()=>window.rhineWorkbench.dispose());
  assert.equal(evidence.errors.length,0);
} catch(error) { evidence.failure=String(error.stack||error); throw error; }
finally { await writeFile(new URL('browser.json',output),JSON.stringify(evidence,null,2));await browser.close(); }
