import { chromium } from '/home/cloudstack/ai-data/prts.chat/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const label=process.argv[2]||'diagnostic';
if(label==='dpr-check'){await import('./rhine-dpr-probe.mjs');process.exit(0);}
if(label==='stop-diagnostic'){const {execFileSync}=await import('node:child_process');let ids=[];try{ids=execFileSync('pgrep',['-f','^node /tmp/rhine-edge-compare.mjs diagnostic$'],{encoding:'utf8'}).trim().split(/\s+/).filter(Boolean);}catch{}for(const id of ids){process.kill(Number(id),'SIGINT');console.log('Stopped own diagnostic process',id);}process.exit(0);}
const output=`/tmp/rhine-edge-${label}`,url='http://127.0.0.1:4177/';
await mkdir(output,{recursive:true});
const report={label,viewport:{width:1302,height:950},method:'Read-only local preview in isolated context. Fixed 50 ms RAF steps through initialization, suppressed intermediate GL draws. Same virtual time for every endpoint. Quality changes via existing UI controls only affect isolated browser storage. Three endpoint frames rendered for each variant. SwiftShader timings are diagnostic wall time, not hardware GPU time or FPS.',errors:[],consoleErrors:[],records:[]};
const browser=await chromium.launch({headless:true,executablePath:'/home/cloudstack/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const persist=()=>writeFile(output+'/stats.json',JSON.stringify(report,null,2));
try{
 const context=await browser.newContext({viewport:report.viewport,deviceScaleFactor:1,reducedMotion:'reduce'});
 const fixture=JSON.parse(await readFile('/tmp/rhine-shelf-fixture.json','utf8'));
 const page=await context.newPage();page.setDefaultTimeout(180000);
 page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')report.consoleErrors.push(m.text());});
 await page.route(url,async route=>{const response=await route.fetch();const html=await response.text();await route.fulfill({response,body:html.replace(/const snapshot=\{[^\n]*?\};/,`const snapshot=${JSON.stringify(fixture)};`)});});
 await page.route('**/rhine/rhine.js',async route=>{const bytes=['diagnostic','performance'].includes(label)?await readFile('/tmp/rhine-edge-baseline.js'):await(await route.fetch()).body();report.bundle={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};await route.fulfill({body:bytes,contentType:'text/javascript'});});
 if(['performance','after','after-final'].includes(label))await page.addInitScript(()=>localStorage.setItem('prts-rhine-quality:v1',JSON.stringify({scale:80,pixelRatio:1,antialias:'off',shadows:1024,aoSamples:0,aoResolution:0.5,depthOfField:0,transmission:0.5,anisotropy:4})));
 await page.addInitScript(()=>{
  const renderers=[],targets=new Map(),frames=[];let rendererResizeCalls=0;
  let renderCPU=0,suppress=false,msaa=null;
  window.__THREE_DEVTOOLS__=new EventTarget();
  window.__THREE_DEVTOOLS__.addEventListener('observe',event=>{
   const obj=event.detail;if(!obj?.isWebGLRenderer)return;renderers.push(obj);
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
   const before=window.rhineWorkbench?.stats?.().renderedFrames||0;suppress=before>0&&!frozen&&before<72;renderCPU=0;const began=performance.now();task.callback(time);const cpuMs=performance.now()-began;
   const stats=window.rhineWorkbench?.stats?.();
   if(stats?.loaded&&stats.renderedFrames!==lastFrame){lastFrame=stats.renderedFrames;if(!suppress&&(frozen||lastFrame>72)){endpointFrames++;frames.push({mode,frame:lastFrame,time,cpuMs,renderCPU,calls:stats.drawCalls,triangles:stats.triangles});if(endpointFrames>=3&&stats.physicalFiles===12&&!stats.movingCamera){stop();window.edgeProbe.done=mode;}}}
  });};
  window.requestAnimationFrame=callback=>{const task={id:++id,callback,native:0};queued.set(task.id,task);if(enabled)schedule(task);return task.id;};
  window.cancelAnimationFrame=id=>{const task=queued.get(id);if(task?.native)nativeCancel(task.native);queued.delete(id);};
  window.edgeProbe={done:null,frames,read(){const node=document.querySelector('.rhine-scene'),canvas=node.querySelector('canvas');const ancestors=[];for(let el=canvas;el&&ancestors.length<7;el=el.parentElement){const style=getComputedStyle(el),r=el.getBoundingClientRect();ancestors.push({tag:el.tagName,className:el.className,client:[el.clientWidth,el.clientHeight],rect:[r.x,r.y,r.width,r.height],transform:style.transform,filter:style.filter,backdropFilter:style.backdropFilter,imageRendering:style.imageRendering,opacity:style.opacity});}return {rendererResizeCalls,devicePixelRatio,stats:window.rhineWorkbench.stats(),renderQuality:JSON.parse(node.dataset.renderQuality||'{}'),canvas:{width:canvas.width,height:canvas.height},ancestors,targets:[...targets.values()].map(t=>({name:t.texture.name,size:[t.width,t.height],samples:t.samples,type:t.texture.type,depthBuffer:t.depthBuffer})),renderers:renderers.map(r=>({programs:r.info.programs.length,memory:r.info.memory,capabilities:{maxSamples:r.capabilities.maxSamples,maxTextureSize:r.capabilities.maxTextureSize}})),frames:frames.filter(f=>f.mode===mode)};},run(next,samples=0){mode=next;msaa=samples;start=lastFrame;endpointFrames=0;frozen=true;this.done=null;enabled=true;for(const task of queued.values())if(!task.native)schedule(task);},stop};
 });
 await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
 const capture=async name=>{
  const began=Date.now(),deadline=began+300000;let lastPrint=0;
  for(;;){const state=await page.evaluate(()=>({done:window.edgeProbe.done,stats:window.rhineWorkbench?.stats?.()}));if(state.done===name)break;if(Date.now()>deadline)throw new Error(name+' timeout');if(Date.now()-lastPrint>15000){lastPrint=Date.now();console.log('WAIT',name,state.stats?.renderedFrames,state.stats?.physicalFiles);}await new Promise(r=>setTimeout(r,500));}
  const record={name,...await page.evaluate(()=>window.edgeProbe.read()),waitWallMs:Date.now()-began,screenshot:output+'/'+name+'.png'};report.records.push(record);await persist();const screenshotStart=Date.now();await page.screenshot({path:record.screenshot,timeout:180000,animations:'disabled'});record.screenshotWallMs=Date.now()-screenshotStart;await persist();console.log('CAPTURE',name,JSON.stringify({quality:record.stats.quality,renderQuality:record.renderQuality,canvas:record.canvas,frames:record.frames,screenshot:record.screenshot}));
 };
 await capture('current');
 if(['diagnostic','after','after-final'].includes(label)){
  await page.setViewportSize({width:1953,height:1425});await new Promise(r=>setTimeout(r,700));
  report.resizeProbe={viewport:{width:1953,height:1425},...await page.evaluate(()=>window.edgeProbe.read())};await persist();
  console.log('RESIZE',JSON.stringify({renderQuality:report.resizeProbe.renderQuality,canvas:report.resizeProbe.canvas,ancestors:report.resizeProbe.ancestors}));
  await page.setViewportSize(report.viewport);await new Promise(r=>setTimeout(r,300));
 }
 const change=async(name,values,samples=0)=>{
  await page.evaluate(({name,values,samples})=>{for(const [key,value]of Object.entries(values)){const input=document.querySelector(`[data-quality="${key}"]`);input.value=String(value);input.dispatchEvent(new Event('change',{bubbles:true}));}window.edgeProbe.run(name,samples);},{name,values,samples});await capture(name);
 };

 if(['after','after-final'].includes(label)){
  if(label==='after-final'){await page.evaluate(()=>window.dispatchEvent(new Event('resize')));await new Promise(r=>setTimeout(r,200));}
  const before=await page.evaluate(()=>window.edgeProbe.read());
  await page.evaluate(()=>{for(let i=0;i<20;i++)window.dispatchEvent(new Event('resize'));});await new Promise(r=>setTimeout(r,200));
  const after=await page.evaluate(()=>window.edgeProbe.read());report.resizeDedup={before:before.rendererResizeCalls,after:after.rendererResizeCalls,delta:after.rendererResizeCalls-before.rendererResizeCalls};
  if(label==='after-final'){await page.evaluate(()=>{const input=document.querySelector('[data-quality="pixelRatio"]');input.value='2';input.dispatchEvent(new Event('change',{bubbles:true}));});await new Promise(r=>setTimeout(r,200));report.beforeDpr=await page.evaluate(()=>window.edgeProbe.read());}
  const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setDeviceMetricsOverride',{...report.viewport,deviceScaleFactor:2,mobile:false});await new Promise(r=>setTimeout(r,500));
  report.dprProbe=await page.evaluate(()=>window.edgeProbe.read());report.dprProbe.resizeDelta=report.dprProbe.rendererResizeCalls-(report.beforeDpr||after).rendererResizeCalls;await persist();console.log('DPR',JSON.stringify({dpr:report.dprProbe.devicePixelRatio,resizeDelta:report.dprProbe.resizeDelta,buffer:report.dprProbe.canvas,quality:report.dprProbe.stats.quality,dedup:report.resizeDedup}));
  if(label==='after-final'){await cdp.send('Emulation.setDeviceMetricsOverride',{...report.viewport,deviceScaleFactor:1,mobile:false});await new Promise(r=>setTimeout(r,500));report.dprReturnProbe=await page.evaluate(()=>window.edgeProbe.read());report.dprReturnProbe.resizeDelta=report.dprReturnProbe.rendererResizeCalls-report.dprProbe.rendererResizeCalls;await persist();console.log('DPR_RETURN',JSON.stringify({dpr:report.dprReturnProbe.devicePixelRatio,resizeDelta:report.dprReturnProbe.resizeDelta,buffer:report.dprReturnProbe.canvas}));}
 }
 if(label==='performance'){
  await change('native-smaa',{scale:100,antialias:'smaa'});
 }
 if(label==='diagnostic'){
  await change('dof0',{depthOfField:0});
  await change('smaa-off',{depthOfField:100,antialias:'off'});
  await change('smaa-off-dof0',{depthOfField:0});
  await change('msaa4',{depthOfField:100,antialias:'smaa'},4);
  await change('msaa4-dof0',{depthOfField:0},4);
  await change('ao0',{depthOfField:100,aoSamples:0,antialias:'smaa'});
 }
}catch(e){report.failure=String(e.stack||e);throw e;}finally{await persist();await browser.close();console.log('REPORT',output+'/stats.json');}
