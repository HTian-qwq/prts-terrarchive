import assert from 'node:assert/strict';
import { chromium } from '/home/cloudstack/ai-data/prts.chat/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const label='single';
const output='/tmp/rhine-performance-only',url='http://127.0.0.1:4177/';
await mkdir(output,{recursive:true});
const report={label,viewport:{width:1920,height:1080},method:'Read-only local preview in isolated context. Fixed 50 ms RAF steps through initialization, suppressed intermediate GL draws. Same virtual time for every endpoint. Quality changes via existing UI controls only affect isolated browser storage. Three endpoint frames rendered for each variant. SwiftShader timings are diagnostic wall time, not hardware GPU time or FPS.',errors:[],consoleErrors:[],records:[]};
const browser=await chromium.launch({headless:true,executablePath:'/home/cloudstack/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const persist=()=>writeFile(output+'/stats.json',JSON.stringify(report,null,2));
try{
 const context=await browser.newContext({viewport:report.viewport,deviceScaleFactor:1,reducedMotion:'reduce'});
 const fixture=JSON.parse(await readFile('/tmp/rhine-shelf-fixture.json','utf8'));
 const page=await context.newPage();page.setDefaultTimeout(180000);
 page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')report.consoleErrors.push(m.text());});
 await page.route(url,async route=>{const response=await route.fetch();const html=await response.text();await route.fulfill({response,body:html.replace(/const snapshot=\{[^\n]*?\};/,`const snapshot=${JSON.stringify(fixture)};`)});});
 await page.route('**/rhine/rhine.js',async route=>{const bytes=label==='baseline'?await readFile('/tmp/rhine-shelf-baseline.js'):await(await route.fetch()).body();report.bundle={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};await route.fulfill({body:bytes,contentType:'text/javascript'});});
 await page.addInitScript(()=>localStorage.setItem('prts-rhine-quality:v1',JSON.stringify({scale:150,pixelRatio:2,antialias:'smaa',shadows:4096,aoSamples:64,aoResolution:1,depthOfField:100,transmission:1,anisotropy:16})));
 await page.addInitScript(()=>{
  const renderers=[],targets=new Map(),frames=[],scenes=[];let rendererResizeCalls=0;
  let renderCPU=0,suppress=false,msaa=null;
  window.__THREE_DEVTOOLS__=new EventTarget();
  window.__THREE_DEVTOOLS__.addEventListener('observe',event=>{
   const obj=event.detail;if(obj?.isScene)scenes.push(obj);if(!obj?.isWebGLRenderer)return;renderers.push(obj);
   const resize=obj.setSize;obj.setSize=function(...args){rendererResizeCalls++;return resize.apply(this,args);};
   const render=obj.render;obj.render=function(...args){const t=performance.now();try{return render.apply(this,args);}finally{renderCPU+=performance.now()-t;}};
   const setRT=obj.setRenderTarget;obj.setRenderTarget=function(target,...args){
    if(target){targets.set(target.uuid,target);if(msaa!==null&&/^EffectComposer\.rt[12]$/.test(target.texture.name)&&target.samples!==msaa){target.dispose();target.samples=msaa;}}
    return setRT.call(this,target,...args);
   };
  });
  for(const proto of [window.WebGLRenderingContext?.prototype,window.WebGL2RenderingContext?.prototype]){
   if(!proto)continue;for(const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced','drawRangeElements']){const fn=proto[name];if(fn)proto[name]=function(...args){if(!suppress)return fn.apply(this,args);};}
  }
  const nativeRAF=requestAnimationFrame.bind(window),nativeCancel=cancelAnimationFrame.bind(window),queued=new Map();
  let id=0,enabled=true,lastNative=-1,time=1000,mode='current',start=0,lastFrame=0,frozen=false,endpointFrames=0;
  const stop=()=>{enabled=false;for(const task of queued.values()){if(task.native)nativeCancel(task.native);task.native=0;}};
  const schedule=task=>{task.native=nativeRAF(nativeTime=>{
   task.native=0;if(!enabled)return;queued.delete(task.id);if(nativeTime!==lastNative){lastNative=nativeTime;if(!frozen)time+=50;}
   const before=window.rhineWorkbench?.stats?.().renderedFrames||0;suppress=before>0&&!frozen&&before<start+72;renderCPU=0;const began=performance.now();task.callback(time);const cpuMs=performance.now()-began;
   const stats=window.rhineWorkbench?.stats?.();
   if(stats?.loaded&&stats.renderedFrames!==lastFrame){lastFrame=stats.renderedFrames;if(!suppress&&(frozen||lastFrame>start+72)){endpointFrames++;frames.push({mode,frame:lastFrame,time,cpuMs,renderCPU,calls:stats.drawCalls,triangles:stats.triangles});if(endpointFrames>=3&&stats.physicalFiles===12&&!stats.movingCamera){stop();window.edgeProbe.done=mode;}}}
  });};
  window.requestAnimationFrame=callback=>{const task={id:++id,callback,native:0};queued.set(task.id,task);if(enabled)schedule(task);return task.id;};
  window.cancelAnimationFrame=id=>{const task=queued.get(id);if(task?.native)nativeCancel(task.native);queued.delete(id);};
  window.edgeProbe={done:null,frames,read(){const node=document.querySelector('.rhine-scene'),canvas=node.querySelector('canvas');const ancestors=[];for(let el=canvas;el&&ancestors.length<7;el=el.parentElement){const style=getComputedStyle(el),r=el.getBoundingClientRect();ancestors.push({tag:el.tagName,className:el.className,client:[el.clientWidth,el.clientHeight],rect:[r.x,r.y,r.width,r.height],transform:style.transform,filter:style.filter,backdropFilter:style.backdropFilter,imageRendering:style.imageRendering,opacity:style.opacity});}const files=[];for(const scene of scenes)scene.traverse(g=>{if(g.isGroup&&g.userData.sourceId){const cover=g.children.find(m=>m.userData.surface==='Frosted_Polymer'),label=g.getObjectByName('Rhine_Archive_Label');files.push({sourceId:g.userData.sourceId,visible:g.visible,position:g.position.toArray(),clarity:cover?.userData.glassClarity?.value,appearance:cover?.userData.appearance?.value,baseRoughness:cover?.material.roughness,labelSize:label?.material.map?[label.material.map.image.width,label.material.map.image.height]:null,labelAnisotropy:label?.material.map?.anisotropy});}});return {files,rendererResizeCalls,devicePixelRatio,stats:window.rhineWorkbench.stats(),renderQuality:JSON.parse(node.dataset.renderQuality||'{}'),canvas:{width:canvas.width,height:canvas.height},ancestors,targets:[...targets.values()].map(t=>({name:t.texture.name,size:[t.width,t.height],samples:t.samples,type:t.texture.type,depthBuffer:t.depthBuffer})),renderers:renderers.map(r=>({programs:r.info.programs.length,memory:r.info.memory,capabilities:{maxSamples:r.capabilities.maxSamples,maxTextureSize:r.capabilities.maxTextureSize}})),frames:frames.filter(f=>f.mode===mode)};},run(next,samples=0,settle=false){mode=next;msaa=samples;start=lastFrame;endpointFrames=0;frozen=!settle;this.done=null;enabled=true;for(const task of queued.values())if(!task.native)schedule(task);},stop};
 });
 await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
 const capture=async name=>{
  const began=Date.now(),deadline=began+300000;let lastPrint=0;
  for(;;){const state=await page.evaluate(()=>({done:window.edgeProbe.done,stats:window.rhineWorkbench?.stats?.()}));if(state.done===name)break;if(Date.now()>deadline)throw new Error(name+' timeout');if(Date.now()-lastPrint>15000){lastPrint=Date.now();console.log('WAIT',name,state.stats?.renderedFrames,state.stats?.physicalFiles);}await new Promise(r=>setTimeout(r,500));}
  const record={name,...await page.evaluate(()=>window.edgeProbe.read()),waitWallMs:Date.now()-began,screenshot:output+'/'+name+'.png'};report.records.push(record);await persist();const screenshotStart=Date.now();await page.screenshot({path:record.screenshot,timeout:180000,animations:'disabled'});record.screenshotWallMs=Date.now()-screenshotStart;await persist();console.log('CAPTURE',name,JSON.stringify({quality:record.stats.quality,renderQuality:record.renderQuality,canvas:record.canvas,frames:record.frames,screenshot:record.screenshot}));
 };
 await page.waitForFunction(()=>window.rhineWorkbench?.stats?.().loaded,{},{polling:100,timeout:180000});
 await capture('current');

 const expected={scale:100,pixelRatio:1,antialias:'smaa',shadows:1024,aoSamples:0,aoResolution:0.5,depthOfField:0,transmission:0.5,anisotropy:4};
 const state=()=>page.evaluate(()=>({stats:window.rhineWorkbench.stats(),controls:document.querySelectorAll('.rhine-nav-quality,.rhine-quality,[data-quality],#quality-preset').length,stored:JSON.parse(localStorage.getItem('prts-rhine-quality:v1'))}));
 const check=(r,desk=false)=>{assert.deepEqual(r.stats.quality,expected);assert.deepEqual(r.stats.requestedQuality,expected);assert.deepEqual(r.stats.renderQuality,{...expected,transmission:desk?1:0.5});assert.equal(r.controls,0);assert.equal(r.stored.aoSamples,64);assert.equal(r.stats.physicalFiles,12);};
 report.initial=await state();check(report.initial);
 await page.evaluate(()=>{document.querySelector('.rhine-nav-rack').click();window.edgeProbe.run('rack',0,true);});await capture('rack');report.rack=await state();check(report.rack,true);
 await page.setViewportSize({width:1600,height:900});await page.waitForTimeout(350);await page.evaluate(()=>window.edgeProbe.run('rack-resized'));await capture('rack-resized');report.resized=await state();check(report.resized,true);const resized=report.records.at(-1);assert(Math.abs(resized.canvas.width-1600)<=1);assert(Math.abs(resized.canvas.height-900)<=1);
 await page.setViewportSize(report.viewport);await page.waitForTimeout(350);
 await page.evaluate(()=>{document.querySelector('.rhine-location-button').click();window.edgeProbe.run('array-return',0,true);});await capture('array-return');report.returned=await state();check(report.returned);
 assert.equal(report.initial.stats.collectionResources.created,report.returned.stats.collectionResources.created);
 assert.equal(report.errors.length,0);assert.equal(report.consoleErrors.length,0);
 report.assertions='Passed old ultra preference ignored, no quality UI, fixed performance profile, 12 shelf files, full-resolution rack transmission, resize, return restores array transmission, no new model clones and no browser errors.';await persist();console.log('ASSERTIONS',report.assertions);
}catch(e){report.failure=String(e.stack||e);throw e;}finally{await persist();await browser.close();console.log('REPORT',output+'/stats.json');}
