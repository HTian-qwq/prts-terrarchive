import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '/home/cloudstack/ai-data/prts.chat/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const output=new URL('.',import.meta.url), url='http://127.0.0.1:4177/';
const fixture=JSON.parse(await readFile(new URL('../rhine-array-body/sources.json',import.meta.url),'utf8'));
const report={errors:[],checks:[]};
const browser=await chromium.launch({headless:true,executablePath:'/home/cloudstack/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
 const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
 page.setDefaultTimeout(180000);page.on('pageerror',e=>report.errors.push(e.message));
 await page.route(url,async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replace(/const snapshot=\{[^\n]*?\};/,`const snapshot=${JSON.stringify(fixture)}; window.__titleFixture = snapshot;`)});});
 await page.addInitScript(()=>{
  window.__skipDraws=false;window.__labelPaints=[];
  for(const proto of [WebGLRenderingContext.prototype,WebGL2RenderingContext.prototype])for(const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced','drawRangeElements']){
   const orig=proto[name];if(orig)proto[name]=function(...args){if(!window.__skipDraws)return orig.apply(this,args);};
  }
  const fill=CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText=function(...args){if(this.canvas.width===1536&&this.canvas.height===714)window.__labelPaints.push({text:args[0],at:performance.now()});return fill.apply(this,args);};
 });
 await page.goto(url,{waitUntil:'domcontentloaded'});console.log('Loaded document');
 await page.waitForFunction(()=>window.rhineWorkbench?.stats().loaded&&window.rhineWorkbench.stats().preparation.completed>=16,null,{polling:200});
 async function settle(){const n=await page.evaluate(()=>{window.__skipDraws=true;return window.rhineWorkbench.stats().renderedFrames;});await page.waitForFunction(n=>window.rhineWorkbench.stats().renderedFrames>n+50,n,{polling:100});}
 async function shot(name){const n=await page.evaluate(()=>{window.__skipDraws=false;return window.rhineWorkbench.stats().renderedFrames;});await page.waitForFunction(n=>window.rhineWorkbench.stats().renderedFrames>n+1,n,{polling:100});await page.screenshot({path:new URL(name+'.png',output).pathname});console.log('Screenshot',name);await page.evaluate(()=>window.__skipDraws=true);}
 await settle();console.log('Prepared models');
 report.initial=await page.evaluate(()=>window.rhineWorkbench.stats());
 assert.equal(report.initial.archiveLabel.sourceId,report.initial.archiveSourceId);
 assert.equal(report.initial.archiveLabel.title,fixture.sources.find(s=>s.id===report.initial.archiveSourceId).title);
 await shot('array');
 report.checks.push('selected array plate shows the real document title');
 const paints=await page.evaluate(()=>window.__labelPaints.length);await settle();
 assert.equal(await page.evaluate(()=>window.__labelPaints.length),paints,'idle frames do not rerasterize title textures');
 await page.evaluate(()=>document.querySelector('[data-action=next]').click());await settle();
 report.next=await page.evaluate(()=>window.rhineWorkbench.stats());
 assert.notEqual(report.next.archiveLabel.sourceId,report.initial.archiveLabel.sourceId);
 assert.equal(report.next.archiveLabel.sourceId,report.next.archiveSourceId);
 report.checks.push('navigation changes the title and idle frames perform no text repaint');
 await page.evaluate(()=>{const s=window.rhineWorkbench.stats();window.__titleFixture={...window.__titleFixture,sources:window.__titleFixture.sources.map(source=>source.id===s.archiveSourceId?{...source,title:'切尔诺伯格事件 / 资料修订与事件发展时间线'}:source)};window.rhineWorkbench.update(window.__titleFixture);});
 await settle();report.revised=await page.evaluate(()=>window.rhineWorkbench.stats());
 assert.equal(report.revised.archiveLabel.title,'切尔诺伯格事件 / 资料修订与事件发展时间线');
 await shot('array-long-title');
 report.checks.push('same source identity receives updated title metadata');
 const corners=report.revised.labelCorners;
 const point=await page.evaluate(corners=>{const canvas=document.querySelector('.rhine-scene canvas'),rect=canvas.getBoundingClientRect();return {x:rect.left+corners.reduce((v,p)=>v+p[0],0)/4/canvas.parentElement.clientWidth*rect.width,y:rect.top+corners.reduce((v,p)=>v+p[1],0)/4/canvas.parentElement.clientHeight*rect.height};},corners);
 await page.mouse.click(point.x,point.y);
 await page.waitForFunction(()=>window.rhineWorkbench.stats().readerOpen,null,{polling:100,timeout:15000});
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().archiveIndex),report.revised.archiveLabel.sourceId);
 await settle();await shot('detail');report.checks.push('clicking the physical plate opens its linked document');
 await page.evaluate(()=>document.querySelector('.rhine-close-reader').click());await settle();
 await page.evaluate(()=>document.querySelector('.rhine-nav-rack').click());await settle();await shot('rack');
 report.final=await page.evaluate(()=>window.rhineWorkbench.stats());
 assert.equal(report.errors.length,0);await page.evaluate(()=>window.rhineWorkbench.dispose());
}catch(e){report.failure=String(e.stack||e);throw e;}finally{await writeFile(new URL('browser.json',output),JSON.stringify(report,null,2));await browser.close();console.log('REPORT',new URL('browser.json',output).pathname);}
