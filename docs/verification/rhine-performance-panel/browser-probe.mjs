// Functional verification using actual RAF and GL commands. SwiftShader numbers
// are NOT a hardware benchmark. No synthetic RAF clock or suppressed GL draws.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = await import(pathToFileURL(process.env.PRTS_PLAYWRIGHT_MODULE || require.resolve('playwright')).href);
const output = pathToFileURL(resolve(process.env.PRTS_RHINE_PERF_OUTPUT || 'work/performance-monitor-v3') + '/');
await mkdir(fileURLToPath(output), { recursive: true });
const preview = process.env.PRTS_RHINE_PREVIEW_URL || 'http://127.0.0.1:4177';
const hardware = process.env.PRTS_RHINE_TEST_HARDWARE === '1';
const fixture = JSON.parse(await readFile(new URL('../rhine-array-body/sources.json', import.meta.url), 'utf8'));
// The fixture contains stable document IDs but a historical corpus version.
// Resolve the current version through a real read before opening the measured page.
const currentRead = await fetch(preview + '/rpc', {method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({endpoint:'read',payload:{locator:{document_id:fixture.sources[0].documentId},
    selection:{mode:'document'},max_lines:1,max_chars:1000}})});
const currentBody = await currentRead.json();
assert(currentRead.ok && currentBody.ok !== false);
const currentVersion = currentBody.response?.data_version;
assert(currentVersion);
for(const source of fixture.sources) {
  if(source.dataVersion) source.id=source.id.replace(source.dataVersion,currentVersion);
  source.dataVersion=currentVersion;
}
const browser = await chromium.launch({headless:true, ...(process.env.PRTS_BROWSER_EXECUTABLE ? {executablePath:process.env.PRTS_BROWSER_EXECUTABLE} : {}),
  args: hardware ? [] : ['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const evidence = { hardwareRequested: hardware, method:'Functional browser check with actual RAF and all GL draws on the recorded browser adapter. Contains a deliberately injected 85ms main-thread task and visibility simulations; timings are not a hardware benchmark.', errors:[], checkpoints:[] };
try {
  const page = await browser.newPage({viewport:{width:640,height:480},reducedMotion:'reduce',acceptDownloads:true});
  page.setDefaultTimeout(180000);
  page.on('pageerror', e => evidence.errors.push(e.message));
  await page.addInitScript(() => {
    window.__testRenderers = [];
    window.__THREE_DEVTOOLS__ = new EventTarget();
    window.__THREE_DEVTOOLS__.addEventListener('observe', e => { if(e.detail?.isWebGLRenderer)window.__testRenderers.push(e.detail); });
  });
  await page.route(preview + '/', async route => {
    const response = await route.fetch(); const body = (await response.text()).replace(/const snapshot=\{[^\n]*?\};/, `const snapshot=${JSON.stringify(fixture)};`);
    await route.fulfill({response,body});
  });
  // Test this checkout's built package even when the existing preview serves another checkout.
  const root = new URL('../../../', import.meta.url);
  for (const name of ['rhine.js', 'rhine.css']) await page.route(preview + '/rhine/' + name, async route => {
    await route.fulfill({ body: await readFile(new URL('lib/rhine/' + name, root)),
      contentType: name.endsWith('.js') ? 'text/javascript' : 'text/css' });
  });
  await page.goto(preview + '/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => window.rhineWorkbench?.stats().renderedFrames >= 4, null, {polling:200});
  console.log('READY', await page.evaluate(() => window.rhineWorkbench.stats().renderedFrames));
  await page.locator('.rhine-perf-toggle').click();
  assert((await page.locator('.rhine-perf-panel header').innerText()).includes('v3'), 'preview must use current built profiler');
  await page.locator('.rhine-perf-panel select').selectOption('120');
  await page.locator('[data-perf=start]').click();
  const frames = async n => {const start = await page.evaluate(() => window.rhineWorkbench.stats().renderedFrames);await page.waitForFunction(start=>window.rhineWorkbench.stats().renderedFrames>=start, start+n,{polling:100});};
  await frames(3);
  // A new session clears retained sources, forcing deferred preparation during capture.
  fixture.sessionId += "-perf-monitor";
  await page.evaluate(fixture=>window.rhineWorkbench.update({...fixture,sources:fixture.sources.slice(0,6)}),fixture);
  await frames(2);
  await page.evaluate(fixture=>window.rhineWorkbench.update(fixture),fixture);
  await frames(3);
  await page.evaluate(fixture=>window.rhineWorkbench.update({...fixture,phase:'searching',running:true,searching:true,outcome:'running'}),fixture);
  await frames(2);
  await page.evaluate(fixture=>window.rhineWorkbench.update(fixture),fixture);
  assert(await page.locator('[data-perf=start]').isDisabled());
  await page.evaluate(() => {const end=performance.now()+85;while(performance.now()<end){};});
  await frames(3);
  await page.screenshot({path:fileURLToPath(new URL('array-panel.png',output))});
  await page.locator('[data-perf=mark]').click();
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
  await page.screenshot({path:fileURLToPath(new URL('viewer-panel.png',output))});
  const downloaded = page.waitForEvent('download');
  await page.locator('[data-perf=export]').click();
  const download = await downloaded; await download.saveAs(fileURLToPath(new URL('capture.json',output)));
  const capture = JSON.parse(await readFile(new URL('capture.json',output),'utf8'));
  assert.equal(capture.schema,'rhine-render-capture/v3'); assert.equal(capture.running,false); assert.equal(capture.pendingGpu,0);
  assert(capture.frames.length>15); assert.equal(capture.summary.failedFrames,0);
  assert(capture.frames.some(f=>f.state.startsWith('array'))); assert(capture.frames.some(f=>f.state.startsWith('rack')));
  assert(capture.frames.some(f=>f.state.includes(':search')));
  assert(capture.frames.some(f=>f.state.startsWith('detail'))); assert(capture.frames.some(f=>f.state==='viewer'));
  assert(capture.frames.filter(f=>f.state==='viewer').every(f=>f.calls>1),'viewer counts must include every pass');
  assert(capture.frames.some(f=>f.intervalMs>50));
  assert(capture.events.some(e=>e.kind==='pause-boundary'&&e.detail==='hidden'));
  if(capture.longTasksSupported)assert(capture.longTasks.some(t=>t.durationMs>=80));
  if (!hardware) assert(capture.adapters.every(a=>a.software));
  evidence.adapters = capture.adapters;
  assert(!JSON.stringify(capture).includes(fixture.sources[0].title),'export must not include document content');
  assert(capture.events.some(e=>e.kind==='user-hitch-marker'));
  assert(capture.events.some(e=>e.kind==='input'&&e.detail.surface==='profiler'));
  assert(capture.diagnostics.heartbeat.length > 0);
  assert(capture.diagnostics.backgroundWork.some(e=>e.kind==='archive-preparation-sync'&&e.succeeded));
  assert(capture.diagnostics.backgroundWork.some(e=>e.kind==='archive-preparation-lifetime'&&e.succeeded));
  assert(capture.diagnostics.overhead.some(e=>e.kind==='panel' && e.count > 0 && e.max >= 0));
  assert(capture.diagnostics.uiWork.some(e=>e.kind==='snapshot-update'));
  assert(capture.diagnostics.loads.some(e=>e.kind==='api:read' && e.status==='complete'));
  assert(capture.diagnostics.loads.some(e=>e.kind==='viewer-setup' && e.status==='complete'));
  assert(capture.diagnostics.loads.some(e=>e.asset==='archive-assembly.glb' && e.status==='complete'));
  assert(capture.initialLoading.recent.some(e=>e.asset==='archive-cassette.glb'));
  for(const f of capture.frames) {
    assert.equal(Object.values(f.submissions).reduce((n,stage)=>n+stage.calls,0),f.calls);
    assert.equal(Object.values(f.submissions).reduce((n,stage)=>n+stage.triangles,0),f.triangles);
  }
  assert(capture.frames.some(f=>f.counters.arrayPartInstances > 0));
  assert(capture.diagnostics.heartbeat.some(h=>h.renderers.scene?.content.array.batches.length>0));
  assert(capture.diagnostics.overhead.some(e=>e.kind==='heartbeat'));
  assert(capture.frames.some(f=>f.stages.composer >= 0 && f.stages.labelOverlay >= 0));
  assert(capture.frames.some(f=>f.stages.viewerRender >= 0));
  assert(capture.frames.some(f=>f.callbackIntervalMs > 50));
  for(const f of capture.frames) assert(Math.abs(Object.values(f.stages).reduce((a,b)=>a+b,0)-f.cpuMs)<0.001);
  const sceneHeartbeat=capture.diagnostics.heartbeat.find(h=>h.renderers.scene?.buffers.composer.width>1);
  assert(sceneHeartbeat); assert(sceneHeartbeat.renderers.scene.buffers.output.width >= sceneHeartbeat.renderers.scene.buffers.composer.width);
  assert.equal(sceneHeartbeat.renderers.scene.quality.scale,100);assert.equal(sceneHeartbeat.renderers.scene.quality.shadows,1024);
  if(capture.capabilities['long-animation-frame'].active) assert(capture.diagnostics.longAnimationFrames.some(e=>e.duration>=80));
  evidence.capabilities=capture.capabilities;
  evidence.checkpoints.push({test:'scene + rack + detail + viewer + pauses + v3 diagnostics + export',frames:capture.frames.length,states:Object.keys(capture.byState),gpu:capture.summary.gpuStatuses});
  const queryState = await page.evaluate(() => window.__testRenderers.map(r => {const gl=r.getContext(),ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');return {active:ext?Boolean(gl.getQuery(ext.TIME_ELAPSED_EXT,gl.CURRENT_QUERY)):false,autoReset:r.info.autoReset};}));
  assert(queryState.every(q=>!q.active));assert.equal(queryState.at(-1).autoReset,true);
  console.log('FULL_CAPTURE_VERIFIED',capture.frames.length,capture.summary.gpuStatuses);
  await page.evaluate(()=>window.rhineWorkbench.dispose());
  assert.equal(await page.locator('.rhine-perf-tools').count(),0);


  if (process.env.PRTS_RHINE_PERF_SOAK === '1') {
    await page.setViewportSize({width:2048,height:1104});
    await page.reload({waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.rhineWorkbench?.stats().renderedFrames>=3,null,{polling:100});
    await page.locator('.rhine-perf-toggle').click();
    await page.locator('select[aria-label="性能测试时长"]').selectOption('120');
    await page.locator('[data-perf=start]').click();
    const tableCell = await page.locator('.rhine-perf-panel tbody td').first().elementHandle();
    await page.evaluate(node=>window.__perfOriginalCell=node,tableCell);
    // This recording leaves the profiler open for the full maximum duration.
    for(let part=0;part<4;part++){await page.waitForTimeout(30000);console.log('SOAK',30*(part+1));}
    await page.waitForFunction(()=>!document.querySelector('[data-perf=export]').disabled,null,{polling:100});
    assert(await page.evaluate(()=>document.querySelector('.rhine-perf-panel tbody td')===window.__perfOriginalCell));
    const soakDownload=page.waitForEvent('download');await page.locator('[data-perf=export]').click();
    await(await soakDownload).saveAs(fileURLToPath(new URL('idle-120s.json',output)));
    const soak=JSON.parse(await readFile(new URL('idle-120s.json',output),'utf8'));
    assert(soak.elapsedMs>=120000 && soak.elapsedMs<123000);
    assert.deepEqual(soak.dropped,{});
    const panels=soak.diagnostics.overhead.filter(e=>e.kind==='panel');
    assert(panels.length>=115);assert(panels.at(-1).lastAt>118000);
    assert(soak.diagnostics.heartbeat.at(-1).at>118000);
    assert.equal(soak.summary.failedFrames,0);
    evidence.soak={frames:soak.frames.length,elapsedMs:soak.elapsedMs, dropped:soak.dropped,
      panels:panels.reduce((n,e)=>n+e.count,0),panelMeanMs:panels.reduce((n,e)=>n+e.total,0)/panels.reduce((n,e)=>n+e.count,0),
      panelMaxMs:Math.max(...panels.map(e=>e.max)),lastPanelAt:panels.at(-1).lastAt};
    console.log('SOAK_VERIFIED',JSON.stringify(evidence.soak));
    await page.evaluate(()=>window.rhineWorkbench.dispose());
  }

  // Reopen in the same real browser with only timer extension support withheld.
  await page.addInitScript(() => {const original=WebGL2RenderingContext.prototype.getExtension;WebGL2RenderingContext.prototype.getExtension=function(name){return name==='EXT_disjoint_timer_query_webgl2'?null:original.call(this,name);};});
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.rhineWorkbench?.stats().renderedFrames>=3,null,{polling:100});
  await page.locator('.rhine-perf-toggle').click();await page.locator('[data-perf=start]').click();await frames(4);
  await page.locator('[data-perf=stop]').click();
  const noTimerDownload=page.waitForEvent('download');await page.locator('[data-perf=export]').click();
  await(await noTimerDownload).saveAs(fileURLToPath(new URL('unsupported.json',output)));
  const unsupported=JSON.parse(await readFile(new URL('unsupported.json',output),'utf8'));
  assert(unsupported.frames.length>0);assert.equal(unsupported.summary.gpuMs.count,0);assert.equal(unsupported.summary.gpuMs.mean,null);
  assert(unsupported.frames.every(f=>f.gpuStatus==='unsupported'&&f.gpuMs===null));
  assert((await page.locator('.rhine-perf-gpu').innerText()).includes('不支持 GPU 计时'));
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:fileURLToPath(new URL('mobile-panel.png',output))});
  const rect=await page.locator('.rhine-perf-panel').boundingBox();assert(rect.x>=0&&rect.x+rect.width<=391);
  evidence.checkpoints.push({test:'unsupported GPU timer + mobile fit + dispose',frames:unsupported.frames.length});
  await page.evaluate(()=>window.rhineWorkbench.dispose());
  // Disabled GPU timing and browser APIs must still produce a useful CPU/heartbeat capture.
  await page.addInitScript(() => Object.defineProperty(PerformanceObserver,'supportedEntryTypes',{configurable:true,value:[]}));
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.rhineWorkbench?.stats().renderedFrames>=3,null,{polling:100});
  await page.locator('.rhine-perf-toggle').click();await page.locator('[data-perf=gpu]').uncheck();
  await page.locator('[data-perf=start]').click(); await frames(4);
  await page.locator('[data-perf=stop]').click();
  const offDownload=page.waitForEvent('download');await page.locator('[data-perf=export]').click();
  await(await offDownload).saveAs(fileURLToPath(new URL('disabled.json',output)));
  const disabled=JSON.parse(await readFile(new URL('disabled.json',output),'utf8'));
  assert.equal(disabled.options.gpuTiming,false);assert(disabled.frames.every(f=>f.gpuStatus==='disabled'));
  assert(disabled.diagnostics.heartbeat.length>0);assert.equal(disabled.capabilities['long-animation-frame'].supported,false);
  assert.equal(disabled.summary.gpuMs.mean,null);
  await page.evaluate(()=>window.rhineWorkbench.dispose());
  evidence.checkpoints.push({test:'GPU disabled + unsupported observers + heartbeat + cleanup',frames:disabled.frames.length});
  assert.equal(evidence.errors.length,0);
} catch(error) { evidence.failure=String(error.stack||error); throw error; }
finally { await writeFile(new URL('browser.json',output),JSON.stringify(evidence,null,2));await browser.close(); }
