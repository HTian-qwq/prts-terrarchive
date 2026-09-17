// Functional input/animation test. Real RAF and wall clock; GL draws are skipped
// during the input stress phase to keep SwiftShader from dominating its timing.
// Final image uses full GL draws. No hardware FPS/performance improvement claim.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '/home/cloudstack/ai-data/prts.chat/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const output = new URL('.', import.meta.url), url = 'http://127.0.0.1:4177/';
const fixture = JSON.parse(await readFile(new URL('../rhine-array-body/sources.json',import.meta.url),'utf8'));
const report = { method:'Real browser input handlers and actual RAF/wall clock. GL draws suppressed during stress, restored for the final image. No synthetic RAF timestamps; no hardware FPS claim.', errors:[], checks:[] };
const browser = await chromium.launch({headless:true,executablePath:'/home/cloudstack/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
  const page = await browser.newPage({viewport:{width:960,height:640},reducedMotion:'no-preference'});
  page.setDefaultTimeout(120000); page.on('pageerror',e=>report.errors.push(e.message));
  await page.route(url,async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replace(/const snapshot=\{[^\n]*?\};/,`const snapshot=${JSON.stringify(fixture)};`)});});
  await page.addInitScript(()=>{
    window.__navSkipDraws = false;
    for (const proto of [WebGLRenderingContext.prototype,WebGL2RenderingContext.prototype]) for(const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced','drawRangeElements']) {
      const original = proto[name]; if(original)proto[name]=function(...args){if(!window.__navSkipDraws)return original.apply(this,args);};
    }
  });
  await page.goto(url,{waitUntil:'domcontentloaded'});
  // Finish all render-to-texture bakes before suppressing stress-test draws.
  await page.waitForFunction(()=>window.rhineWorkbench?.stats().loaded&&window.rhineWorkbench.stats().physicalFiles===12&&window.rhineWorkbench.stats().preparation.completed>=16,null,{polling:100});
  const preparedFrames=await page.evaluate(()=>{window.__navSkipDraws=true;return window.rhineWorkbench.stats().renderedFrames;});
  await page.waitForFunction(n=>window.rhineWorkbench.stats().renderedFrames>n+90,preparedFrames,{polling:100});
  await page.evaluate(()=>{
    const trace=[];
    const send=kind=>{
      const before=window.rhineWorkbench.stats(), at=performance.now();
      if(kind==='key')document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',repeat:true,bubbles:true,cancelable:true}));
      else if(kind==='lane')document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',repeat:true,bubbles:true,cancelable:true}));
      else if(kind==='reverse')document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}));
      else if(kind==='button')document.querySelector('[data-action=next]').click();
      else if(kind==='wheel')document.querySelector('.rhine-scene canvas').dispatchEvent(new WheelEvent('wheel',{deltaY:120,bubbles:true,cancelable:true}));
      else if(kind==='tick')document.querySelector('#file-ticks button[aria-pressed=false]')?.click();
      const after=window.rhineWorkbench.stats();
      trace.push({kind,at,accepted:after.navigation.accepted>before.navigation.accepted,source:after.archiveSourceId,uiSource:after.archiveIndex,
        cell:after.selectedCell,returning:after.returningFiles,navigation:after.navigation,
        tick:document.querySelector('#file-ticks [aria-pressed=true]')?.dataset.sourceId||null});
      return after;
    };
    window.__navTest={send,trace};
  });
  const initial=await page.evaluate(()=>window.rhineWorkbench.stats());
  const burst=await page.evaluate(()=>{for(let i=0;i<30;i++)window.__navTest.send(['key','lane','button','wheel','tick'][i%5]);return window.rhineWorkbench.stats();});
  assert.equal(burst.navigation.accepted-initial.navigation.accepted,1,'all inputs must share one cooldown');
  assert.equal(burst.selectedCell.row,initial.selectedCell.row+1);
  assert.equal(burst.selectedCell.lane,initial.selectedCell.lane);
  report.checks.push('mixed burst advances exactly one row, with no independent button/wheel/lane budget');

  await page.waitForTimeout(400);
  const reversed=await page.evaluate(()=>window.__navTest.send('reverse'));
  assert.equal(reversed.selectedCell.row,initial.selectedCell.row,'direction changes work once cooldown ends');
  const stream = await page.evaluate(()=>new Promise(resolve=>{
    let i=0, maxReturning=0;
    // Same-direction steps ensure the test actually accumulates returning boxes;
    // choosing an already-returning tick can reclaim one and relieve the backlog.
    const timer=setInterval(()=>{const s=window.__navTest.send(['key','button','wheel'][i++%3]);maxReturning=Math.max(maxReturning,s.returningFiles);},25);
    setTimeout(()=>{clearInterval(timer);resolve({attempts:i,maxReturning,stats:window.rhineWorkbench.stats()});},6500);
  }));
  report.stream=stream;
  assert(stream.attempts>50);assert(stream.maxReturning<=3);assert(stream.stats.navigation.busyLimited>0,'slow returns must apply backpressure');
  const heldSource=stream.stats.archiveIndex, heldCell=stream.stats.selectedCell, accepted=stream.stats.navigation.accepted;
  await page.waitForTimeout(1200);
  const released=await page.evaluate(()=>window.rhineWorkbench.stats());
  assert.equal(released.navigation.accepted,accepted);assert.equal(released.archiveIndex,heldSource);assert.deepEqual(released.selectedCell,heldCell);
  assert.equal(released.navigation.queued,0);
  report.stream=stream; report.checks.push('40Hz mixed repeat keeps at most three outgoing copies; release produces no queued movement');
  report.trace=await page.evaluate(()=>window.__navTest.trace);
  for(const point of report.trace){assert.equal(point.source,point.uiSource,'rejected input cannot change only the UI');if(point.source)assert.equal(point.tick,point.source);}
  const acceptedTrace=report.trace.filter(p=>p.accepted);
  for(let i=1;i<acceptedTrace.length;i++)assert(acceptedTrace[i].at-acceptedTrace[i-1].at>=340,'sampling outside callback permits small bookkeeping jitter');

  await page.waitForFunction(()=>window.rhineWorkbench.stats().returningFiles===0,null,{polling:100});
  const recovered=await page.evaluate(()=>window.__navTest.send('key'));
  assert.equal(recovered.navigation.accepted,released.navigation.accepted+1);
  // Open remains immediate even immediately after a navigation accepted its token.
  await page.evaluate(()=>document.querySelector('.read-file').click());
  assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().readerOpen),true);
  assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().archiveIndex),recovered.archiveIndex);
  const beforeReading=await page.evaluate(()=>window.rhineWorkbench.stats().navigation.accepted);
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().navigation.accepted),beforeReading);
  await page.evaluate(()=>document.querySelector('.rhine-close-reader').click());
  report.checks.push('navigation recovers; immediate Open keeps source identity; arrows in reader do not navigate array');

  await page.locator('.rhine-nav-index').click();
  await page.locator('#rhine-query').fill('阿米娅');
  const beforeEditing=await page.evaluate(()=>window.rhineWorkbench.stats().navigation.accepted);
  await page.keyboard.press('ArrowLeft');await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().navigation.accepted),beforeEditing);
  await page.evaluate(()=>document.querySelector('.rhine-close-results').click());
  report.checks.push('editing and search modal keyboard handling remain isolated');
  const beforeDraw=await page.evaluate(()=>{window.__navSkipDraws=false;return window.rhineWorkbench.stats().renderedFrames;});
  await page.waitForFunction(n=>window.rhineWorkbench.stats().renderedFrames>n+2,beforeDraw,{polling:100});
  await page.screenshot({path:new URL('array.png',output).pathname});
  report.final=await page.evaluate(()=>window.rhineWorkbench.stats());
  assert.equal(report.errors.length,0);
  await page.evaluate(()=>window.rhineWorkbench.dispose());

  // The same budget also protects the DOM fallback before/without a WebGL scene.
  await page.addInitScript(()=>{const get=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return /^webgl/.test(type)?null:get.call(this,type,...args);};});
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.rhineWorkbench?.stats().resultCount>0&&!window.rhineWorkbench.stats().searchBusy,null,{polling:100});
  const fallback=await page.evaluate(()=>{const before=window.rhineWorkbench.stats();for(let i=0;i<100;i++)document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',repeat:true,bubbles:true,cancelable:true}));return {before,after:window.rhineWorkbench.stats()};});
  assert.equal(fallback.after.navigation.accepted-fallback.before.navigation.accepted,1);
  assert.equal(fallback.after.navigation.rateLimited-fallback.before.navigation.rateLimited,99);
  report.checks.push('WebGL unavailable fallback shares the rate limit');report.fallback=fallback;
  await page.evaluate(()=>window.rhineWorkbench.dispose());
}catch(error){report.failure=String(error.stack||error);throw error;}
finally{await writeFile(new URL('browser.json',output),JSON.stringify(report,null,2));await browser.close();console.log('REPORT',new URL('browser.json',output).pathname);}
