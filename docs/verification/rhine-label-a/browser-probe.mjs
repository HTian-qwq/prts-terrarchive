import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { chromium } from '/home/cloudstack/ai-data/prts.chat/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const dir=new URL('.',import.meta.url),url='http://127.0.0.1:4177/';
const fixture=JSON.parse(await readFile(new URL('../rhine-array-body/sources.json',dir),'utf8'));fixture.sources=[fixture.sources[8],fixture.sources[1]];
const report={errors:[],checks:[]};
const browser=await chromium.launch({headless:true,executablePath:'/home/cloudstack/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:1600,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(180000);page.on('pageerror',e=>report.errors.push(e.message));page.on('console',e=>{if(e.type()==='error')report.errors.push(e.text().slice(0,2000));});
 await page.route(url,async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replace(/const snapshot=\{[^\n]*?\};/,`const snapshot=${JSON.stringify(fixture)};`)});});
 await page.addInitScript(()=>{window.__skipDraws=false;for(const proto of [WebGLRenderingContext.prototype,WebGL2RenderingContext.prototype])for(const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced','drawRangeElements']){const orig=proto[name];if(orig)proto[name]=function(...args){if(!window.__skipDraws)return orig.apply(this,args);};}});
 await page.addInitScript(()=>{
   window.__printedLabels=[];
   const clear=CanvasRenderingContext2D.prototype.clearRect,fill=CanvasRenderingContext2D.prototype.fillText;
   CanvasRenderingContext2D.prototype.clearRect=function(...args){if(this.canvas.width===1536&&this.canvas.height===714){if(!this.canvas.__labelCalls)window.__printedLabels.push(this.canvas);this.canvas.__labelCalls=[];}return clear.apply(this,args);};
   CanvasRenderingContext2D.prototype.fillText=function(text,x,y,...rest){if(this.canvas.__labelCalls)this.canvas.__labelCalls.push({text,x,y,font:this.font,width:this.measureText(text).width});return fill.call(this,text,x,y,...rest);};
 });
 await page.goto(url,{waitUntil:'domcontentloaded'});console.log('Loaded');
 await page.waitForFunction(()=>window.rhineWorkbench?.stats().loaded&&window.rhineWorkbench.stats().physicalFiles===2&&window.rhineWorkbench.stats().preparation.completed>=6,null,{polling:200});
 async function settle(){const n=await page.evaluate(()=>{window.__skipDraws=true;return window.rhineWorkbench.stats().renderedFrames;});await page.waitForFunction(n=>window.rhineWorkbench.stats().renderedFrames>n+30,n,{polling:100});}
 async function shot(name){const n=await page.evaluate(()=>{window.__skipDraws=false;return window.rhineWorkbench.stats().renderedFrames;});await page.waitForFunction(n=>window.rhineWorkbench.stats().renderedFrames>n+1,n,{polling:100});await page.screenshot({path:new URL(name+'.png',dir).pathname});await page.evaluate(()=>window.__skipDraws=true);console.log(name);}
 await settle();
 await page.locator('#file-ticks button[title="阿米娅 / 干员语音"]').click();
 await page.waitForFunction(()=>window.rhineWorkbench.stats().archiveLabel?.title==='阿米娅 / 干员语音'&&window.rhineWorkbench.stats().returningFiles===0&&window.rhineWorkbench.stats().selectionPhase==='settled',null,{polling:100});
 await settle();
 report.print=await page.evaluate(()=>{
  const canvas=window.__printedLabels.find(c=>c.__labelCalls.some(call=>call.text==='干员语音'));
  return {calls:canvas.__labelCalls,image:canvas.toDataURL()};
 });
 const titleCalls=report.print.calls.filter(call=>['阿米娅','/','干员语音'].includes(call.text));
 assert.equal(titleCalls.length,3);assert.equal(new Set(titleCalls.map(call=>call.y)).size,1);
 assert(titleCalls.every(call=>call.y<714*.35&&call.x+call.width<=1460));
 await writeFile(new URL('plate.png',dir),Buffer.from(report.print.image.split(',')[1],'base64'));delete report.print.image;
 report.checks.push('name and full document type share one exposed line without exceeding the plate');
 report.array=await page.evaluate(()=>({...window.rhineWorkbench.stats(),surface:JSON.parse(document.querySelector('.rhine-scene').dataset.renderQuality)}));
 assert.equal(report.array.surface.labelWidth,report.array.surface.width*2);assert.equal(report.array.surface.labelHeight,report.array.surface.height*2);
 assert.equal(report.array.archiveLabel.sourceId,report.array.archiveSourceId);assert.equal(report.array.archiveLabel.title,fixture.sources.find(s=>s.id===report.array.archiveSourceId).title);
 await shot('array');console.log(JSON.stringify({surface:report.array.surface,calls:report.array.drawCalls,triangles:report.array.triangles}));report.checks.push('original-size plate remains on the selected cover and retains its document title');
 const point=await page.evaluate(()=>{const {labelCorners:c}=window.rhineWorkbench.stats(),canvas=document.querySelector('.rhine-scene canvas'),r=canvas.getBoundingClientRect();const u=.5,v=.14;const p=[0,1].map(axis=>(c[0][axis]*(1-u)+c[1][axis]*u)*(1-v)+(c[3][axis]*(1-u)+c[2][axis]*u)*v);return{x:r.left+p[0]/canvas.parentElement.clientWidth*r.width,y:r.top+p[1]/canvas.parentElement.clientHeight*r.height};});
 await page.mouse.click(point.x,point.y);
 await page.waitForFunction(()=>window.rhineWorkbench.stats().readerOpen,null,{polling:100,timeout:15000});
 await settle();report.detail=await page.evaluate(()=>window.rhineWorkbench.stats());
 assert.equal(report.detail.archiveIndex,report.array.archiveLabel.sourceId);
 await shot('detail');report.checks.push('visible upper portion remains clickable and opens its document');
 assert.deepEqual(report.errors,[]);await page.evaluate(()=>window.rhineWorkbench.dispose());
}catch(e){report.failure=String(e.stack||e);throw e;}finally{await writeFile(new URL('browser.json',dir),JSON.stringify(report,null,2));await browser.close();console.log('REPORT',new URL('browser.json',dir).pathname);}
