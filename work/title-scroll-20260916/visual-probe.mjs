import assert from 'node:assert/strict';
import { chromium } from '/home/cloudstack/ai-data/prts.chat/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
import { writeFile } from 'node:fs/promises';
const output = new URL('./', import.meta.url).pathname;
const origin = 'http://127.0.0.1:4177';
const report = { status: 'running', viewport: { width: 1743, height: 939 }, errors: [], requests_rejected: [] };
const started = Date.now();
const browser = await chromium.launch({headless:true, executablePath:'/home/cloudstack/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const watchdog = setTimeout(() => { report.errors.push('Overall visual probe exceeded 210 seconds'); void browser.close(); }, 210000);
try {
  const page = await browser.newPage({viewport:report.viewport,reducedMotion:'reduce'});
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => report.errors.push(error.message));
  const response = await page.request.post(origin+'/rpc', {data:{endpoint:'archive.search',payload:{query:'阿米娅'}}});
  assert(response.ok());
  const data = await response.json();
  const source = data.sources.find(item=>item.title==='阿米娅 / 模组文案');
  assert(source, 'Actual Amiya module document is available');
  report.source = { title:source.title, documentId:source.documentId, dataVersion:source.dataVersion };
  const snapshot = {sessionId:'title-scroll-isolated-3d-preview',running:false,searching:false,query:'',tool:'',sources:[source],answer:'# 调查报告\n\n用于检查两处连续滚动标题的独立本地 3D 预览。',records:[],question:'你能从原文考据有哪些原文梗吗',outcome:'completed',investigationId:'title-scroll-visual-check'};
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { report.requests_rejected.push(url.origin+url.pathname); return route.abort(); }
    if (url.pathname === '/') {
      const response = await route.fetch();
      return route.fulfill({response,body:(await response.text()).replace(/const snapshot=\{[^\n]*?\};/,`const snapshot=${JSON.stringify(snapshot)};`)});
    }
    if (url.pathname === '/rpc') {
      assert.equal(request.postDataJSON().endpoint, 'archive.search', 'Only local source search is expected');
      return route.fulfill({json:{...data,sources:[source],page:{has_more:false}}});
    }
    return route.continue();
  });
  // Same test-only frame gate used by test/rhine-browser.mjs: preserve the last
  // real 3D frame while collecting a screenshot on a CPU software renderer.
  await page.addInitScript(()=>{
    const schedule=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window);
    const callbacks=new Map();let sequence=0,enabled=true;
    const enqueue=entry=>{entry.native=schedule(time=>{entry.native=0;if(!enabled)return;callbacks.delete(entry.id);entry.callback(time);});};
    window.requestAnimationFrame=callback=>{const entry={id:++sequence,callback,native:0};callbacks.set(entry.id,entry);if(enabled)enqueue(entry);return entry.id;};
    window.cancelAnimationFrame=id=>{const entry=callbacks.get(id);if(entry?.native)cancel(entry.native);callbacks.delete(id);};
    window.visualProbePauseFrames=()=>{enabled=false;for(const entry of callbacks.values()){if(entry.native)cancel(entry.native);entry.native=0;}};
  });
  console.log('Loading actual WebGL scene');
  await page.goto(origin+'/', {waitUntil:'domcontentloaded',timeout:45000});
  await page.waitForFunction(()=>window.rhineWorkbench?.stats().loaded && window.rhineWorkbench.stats().archiveCount>0 && !window.rhineWorkbench.stats().searchBusy, undefined,{polling:1000,timeout:120000});
  await page.evaluate(()=>document.fonts.ready);
  console.log('Real scene loaded; settling title frame');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.waitForFunction(()=>document.querySelectorAll('.rhine-loop-title-track').length===2 && [...document.querySelectorAll('.rhine-loop-title-track')].every(track=>track.getAnimations().length===1),undefined,{polling:500,timeout:20000});
  report.scene = await page.evaluate(()=>{
    const stats=window.rhineWorkbench.stats();
    const canvas=document.querySelector('#three-scene canvas');
    const gl=canvas?.getContext('webgl2') || canvas?.getContext('webgl');
    const debug=gl?.getExtension('WEBGL_debug_renderer_info');
    return {loaded:stats.loaded,engine:stats.engine,archiveCount:stats.archiveCount,renderedFrames:stats.renderedFrames,triangles:stats.triangles,renderQuality:stats.renderQuality,canvas:canvas?[canvas.width,canvas.height]:null,renderer:gl?gl.getParameter(debug?debug.UNMASKED_RENDERER_WEBGL:gl.RENDERER):null};
  });
  assert(report.scene.renderer && report.scene.triangles>0, 'Screenshot must contain a rendered 3D scene');
  report.titles = await page.evaluate(()=>['.rhine-report-open strong','#selected-title'].map(selector=>{
    const root=document.querySelector(selector),track=root.querySelector('.rhine-loop-title-track');
    const animation=track.getAnimations()[0];
    const timing=animation.effect.getComputedTiming();
    animation.pause();animation.currentTime=200;
    const rect=root.getBoundingClientRect();
    return {selector,title:root.title,visible:rect.width>0&&rect.height>0,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},duration:timing.duration,infinite:timing.iterations===Infinity};
  }));
  assert(report.titles.every(item=>item.visible&&item.infinite));
  assert.equal(await page.locator('.rhine-report-open').isVisible(),true);
  assert.equal(await page.locator('#selected-title').getAttribute('title'),'阿米娅 / 模组文案');
  await page.evaluate(()=>window.visualProbePauseFrames());
  await page.screenshot({path:output+'visual-3d.png',timeout:40000});
  assert.deepEqual(report.errors,[]);
  assert.deepEqual(report.requests_rejected,[]);
  report.status='passed';
  report.note='Actual 3D engine and production quality; reduced-motion only during initial settling, normal motion restored before a paused 200ms title frame. Test-only RAF gate retains the actual rendered scene for capture. Snapshot and local query are isolated from DSH sessions.';
} catch(error) {
  report.status='failed';report.errors.push(error.stack||String(error));process.exitCode=1;
} finally {
  clearTimeout(watchdog);
  report.elapsed_seconds=Math.round((Date.now()-started)/100)/10;
  await writeFile(output+'visual-report.json',JSON.stringify(report,null,2)+'\n');
  await browser.close();
  console.log(JSON.stringify(report,null,2));
}
