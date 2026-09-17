import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {chromium} from '/home/cloudstack/ai-data/prts.chat/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const dir=new URL('.',import.meta.url),url='http://127.0.0.1:4177/';
const all=JSON.parse(await readFile(new URL('../rhine-array-body/sources.json',dir),'utf8'));
all.sources.push({id:'test:deferred-cloud-source',documentUid:'test:deferred-cloud-source',title:'延迟准备 / 云端测试资料',kind:'entity_profile',origin:'cloud',state:'found',excerpt:'用于验证翻页后立即打开时，尚未准备的档案模型仍能正确创建。'});
assert.equal(all.sources.length,13);
const fixture={...all,sources:all.sources.slice(0,2)};
const report={errors:[],checks:[],layouts:[]};
const browser=await chromium.launch({headless:true,executablePath:'/home/cloudstack/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});page.setDefaultTimeout(180000);
 page.on('pageerror',e=>report.errors.push(e.message));page.on('console',e=>{if(e.type()==='error')report.errors.push(e.text().slice(0,1800));});
 await page.route(url,async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replace(/const snapshot=\{[^\n]*?\};/,`const snapshot=window.__fixture=${JSON.stringify(fixture)};`)});});
 await page.addInitScript(()=>{window.__skipDraws=false;for(const proto of [WebGLRenderingContext.prototype,WebGL2RenderingContext.prototype])for(const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced','drawRangeElements']){const orig=proto[name];if(orig)proto[name]=function(...args){if(!window.__skipDraws)return orig.apply(this,args);};}});
 await page.goto(url,{waitUntil:'domcontentloaded'});console.log('Loaded');
 await page.waitForFunction(()=>window.rhineWorkbench?.stats().loaded&&window.rhineWorkbench.stats().physicalFiles===2&&window.rhineWorkbench.stats().preparation.completed>=6,null,{polling:200});
 async function settle(){const n=await page.evaluate(()=>{window.__skipDraws=true;return window.rhineWorkbench.stats().renderedFrames;});await page.waitForFunction(n=>window.rhineWorkbench.stats().renderedFrames>n+35,n,{polling:100});}
 async function shot(name){const n=await page.evaluate(()=>{window.__skipDraws=false;return window.rhineWorkbench.stats().renderedFrames;});await page.waitForFunction(n=>window.rhineWorkbench.stats().renderedFrames>n+1,n,{polling:100});await page.screenshot({path:new URL(name+'.png',dir).pathname});await page.evaluate(()=>window.__skipDraws=true);console.log(name);}
 await settle();await page.locator('.rhine-nav-rack').click();await page.waitForFunction(()=>window.rhineWorkbench.stats().location==='desk'&&!window.rhineWorkbench.stats().movingCamera,null,{polling:100});await settle();
 await page.locator('.rhine-shelf-open').click();
 await page.waitForFunction(()=>window.rhineWorkbench.stats().readerOpen&&window.rhineWorkbench.stats().cameraDetail>.99&&window.rhineWorkbench.stats().inspectedFile?.progress===1,null,{polling:100});await settle();
 report.reader=await page.evaluate(()=>window.rhineWorkbench.stats());
 assert.equal(report.reader.inspectedFile.visible,true,'the shelf reader must retain its selected model');
 assert.equal(report.reader.inspectedFile.representation,'geometry');assert.equal(report.reader.inspectedFile.id,fixture.sources[0].id);
 await page.waitForFunction(()=>document.querySelectorAll('.rhine-reader-line').length>0,null,{polling:100});
 if(!process.env.RHINE_PROBE_NO_SHOTS)await shot('reader');report.checks.push('shelf reader keeps its complete model visible and opens the correct source');
 await page.setViewportSize({width:1440,height:900});await page.locator('.rhine-close-reader').click();await settle();
 report.returned=await page.evaluate(()=>window.rhineWorkbench.stats());assert.equal(report.returned.readerOpen,false);assert.equal(report.returned.location,'desk');assert.equal(report.returned.physicalFiles,2);
 // Open page two in the same task that changes page, before deferred geometry exists.
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.evaluate(sources=>{window.__fixture={...window.__fixture,sources};window.rhineWorkbench.update(window.__fixture);},all.sources.slice(0,13));
 report.beforeDeferred=await page.evaluate(()=>{
  const buttons=[...document.querySelectorAll('.rhine-desk-pagination button')];buttons.at(-1).click();
  document.querySelector('.rhine-shelf-open').click();return window.rhineWorkbench.stats();
 });
 await page.waitForFunction(()=>window.rhineWorkbench.stats().readerOpen&&window.rhineWorkbench.stats().shelfPage===1&&window.rhineWorkbench.stats().inspectedFile?.progress===1,null,{polling:100});await settle();
 report.deferred=await page.evaluate(()=>window.rhineWorkbench.stats());assert.equal(report.beforeDeferred.inspectedFile,null);assert.equal(report.deferred.inspectedFile.visible,true);assert.equal(report.deferred.inspectedFile.representation,'geometry');assert.equal(report.deferred.inspectedFile.id,all.sources[12].id);
 report.checks.push('opening an unprepared page-two cassette keeps it visible after deferred construction');
 await page.locator('.rhine-close-reader').click();await settle();assert.equal((await page.evaluate(()=>window.rhineWorkbench.stats())).readerOpen,false);
 assert.deepEqual(report.errors,[]);await page.evaluate(()=>window.rhineWorkbench.dispose());
}catch(e){report.failure=String(e.stack||e);throw e;}finally{await writeFile(new URL('browser-final.json',dir),JSON.stringify(report,null,2));await browser.close();console.log('REPORT',new URL('browser-final.json',dir).pathname);}
