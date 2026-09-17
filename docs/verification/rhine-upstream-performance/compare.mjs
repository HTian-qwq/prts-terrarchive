import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {chromium} from '/home/cloudstack/ai-data/prts.chat/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const root='/home/cloudstack/ai-data',plugin=root+'/prts.chat/prts-terrarchive',upstream=root+'/RhineLabUI';
const require=createRequire(plugin+'/package.json'),esbuild=createRequire(require.resolve('vite/package.json'))('esbuild');
const output='/tmp/rhine-upstream-comparison';await mkdir(output,{recursive:true});
const report={viewport:{width:1280,height:720},dpr:1,method:'Actual upstream and plugin ArchiveScene sources compiled with the same esbuild settings; both use installed Three 0.183.2. Identical 16:9 camera and explicit quality controls. No adapter, rack, UI, search or prewarm. State convergence skips composer.render, then three real endpoint frames per case. Software renderer times are diagnostic only, not hardware FPS. Assets served from the corresponding repository. Fresh browser context per repository.',sources:{},cases:[],errors:[]};
const html='<!doctype html><style>html,body,#scene{margin:0;width:100%;height:100%;overflow:hidden}canvas{display:block}</style><div id="scene"></div><script type="module" src="/__rhine_perf/scene.js"></script>';
for(const [variant,dir,scenePath] of [['upstream',upstream,'src/scene.ts'],['plugin',plugin,'ui/rhine/original/scene.ts']]){
 const dataPath=scenePath.replace('scene.ts','data.ts');
 const result=await esbuild.build({absWorkingDir:dir,stdin:{contents:`import {ArchiveScene} from './${scenePath}'; import {fileAtSlot} from './${dataPath}'; window.sceneModule={ArchiveScene,fileAtSlot};`,resolveDir:dir,sourcefile:'performance-entry.js'},bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,define:{'import.meta.env.BASE_URL':'"/"'},write:false,metafile:true});
 const bytes=result.outputFiles[0].contents;await writeFile(output+'/'+variant+'.js',bytes);
 const inputs={};for(const name of Object.keys(result.metafile.inputs)){if(name==='performance-entry.js')continue;const path=name.startsWith('/')?name:dir+'/'+name;const b=await readFile(path);inputs[name]={bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')};}
 report.sources[variant]={dir,scenePath,bundleBytes:bytes.length,bundleSHA256:createHash('sha256').update(bytes).digest('hex'),inputs};
}
const persist=()=>writeFile(output+'/report.json',JSON.stringify(report,null,2));await persist();
const browser=await chromium.launch({headless:true,executablePath:'/home/cloudstack/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 for(const variant of ['upstream','plugin']){
  const context=await browser.newContext({viewport:report.viewport,deviceScaleFactor:1});const page=await context.newPage();page.setDefaultTimeout(180000);
  page.on('pageerror',e=>report.errors.push({variant,type:'pageerror',message:e.message}));page.on('console',m=>{if(m.type()==='error')report.errors.push({variant,type:'console',message:m.text()});});
  await page.route('http://127.0.0.1:4177/**',async route=>{const path=new URL(route.request().url()).pathname;if(path==='/__rhine_perf/')return route.fulfill({body:html,contentType:'text/html'});if(path==='/__rhine_perf/scene.js')return route.fulfill({body:await readFile(output+'/'+variant+'.js'),contentType:'text/javascript'});if(path==='/assets/archive-cassette.glb')return route.fulfill({body:await readFile((variant==='upstream'?upstream+'/public':plugin+'/lib/rhine')+path),contentType:'model/gltf-binary'});return route.abort();});
  await page.goto('http://127.0.0.1:4177/__rhine_perf/',{waitUntil:'load'});await page.waitForFunction(()=>window.sceneModule);
  const init=await page.evaluate(async()=>{
   const begin=performance.now(),s=new window.sceneModule.ArchiveScene(document.querySelector('#scene'));window.s=s;
   const constructionMs=performance.now()-begin;
   const quality={scale:100,pixelRatio:1,antialias:'smaa',shadows:1024,aoSamples:0,aoResolution:0.5,depthOfField:0,transmission:0.5,anisotropy:4};s.setQuality(quality);
   const t=performance.now();await s.load('/assets/archive-cassette.glb');const loadMs=performance.now()-t;
   s.setReduced(true);s.setMode('archive');s.select(window.sceneModule.fileAtSlot(76));
   const gl=s.renderer.getContext(),debug=gl.getExtension('WEBGL_debug_renderer_info');
   window.probe={time:0,quality,phase:[],shadow:0,settle(mode){s.setMode(mode);if(mode==='detail')s.finishDecryption();const render=s.composer.render;s.composer.render=()=>{};try{for(let i=0;i<200;i++)s.update(this.time+=0.05);}finally{s.composer.render=render;}},read(){const inst=s.instances;return {stats:s.getStats(),canvas:[s.renderer.domElement.width,s.renderer.domElement.height],quality:{...s.quality},camera:{position:s.camera.position.toArray(),quaternion:s.camera.quaternion.toArray(),fov:s.camera.fov,near:s.camera.near,far:s.camera.far},model:{position:s.model.position.toArray(),quaternion:s.model.quaternion.toArray()},instances:inst.map(m=>({surface:m.userData.surface||m.material.name,count:m.count,capacity:m.instanceMatrix.count,trianglesPerInstance:(m.geometry.index?.count||m.geometry.attributes.position.count)/3,castShadow:m.castShadow})),memory:{...s.renderer.info.memory},programs:s.renderer.info.programs.length,phase:[...this.phase],shadowDraws:this.shadow};},frame(){this.phase=[];this.shadow=0;const t=performance.now();s.update(this.time+=0.05);return {...this.read(),wallMs:performance.now()-t};}};
   const render=s.renderer.render;s.renderer.render=function(scene,camera){const before={...this.info.render};render.call(this,scene,camera);window.probe.phase.push({override:scene.overrideMaterial?.type||null,calls:this.info.render.calls-before.calls,triangles:this.info.render.triangles-before.triangles});};
   s.scene.traverse(m=>{if(!m.isMesh||!m.castShadow)return;const before=m.onBeforeShadow;m.onBeforeShadow=function(...args){window.probe.shadow++;return before.apply(this,args);};});
   return {constructionMs,loadMs,renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)};
  });report.sources[variant].initialization=init;await persist();console.log('INITIALIZED',variant,JSON.stringify(init));
  for(const tier of ['performance','original']){
   const quality=tier==='performance'?{scale:100,pixelRatio:1,antialias:'smaa',shadows:1024,aoSamples:0,aoResolution:0.5,depthOfField:0,transmission:0.5,anisotropy:4}:{scale:100,pixelRatio:1.5,antialias:'off',shadows:2048,aoSamples:32,aoResolution:1,depthOfField:100,transmission:1,anisotropy:16};
   await page.evaluate(q=>window.s.setQuality(q),quality);
   for(const view of ['archive','detail']){
    await page.evaluate(view=>window.probe.settle(view),view);
    const frames=[];for(let i=0;i<3;i++){console.log('RENDER',variant,tier,view,i);frames.push(await page.evaluate(()=>window.probe.frame()));}
    const record={variant,tier,view,frames};report.cases.push(record);await persist();
    if(tier==='performance'){record.screenshot=output+'/'+variant+'-'+tier+'-'+view+'.png';await page.screenshot({path:record.screenshot,timeout:180000});}
    console.log('RESULT',variant,tier,view,JSON.stringify({calls:frames.at(-1).stats.drawCalls,triangles:frames.at(-1).stats.triangles,visible:frames.at(-1).stats.arrayVisibility?.visibleSlots,shadows:frames.at(-1).shadowDraws}));await persist();
   }
  }
  await context.close();
 }
 for(const tier of ['performance','original'])for(const view of ['archive','detail']){
  const [a,b]=['upstream','plugin'].map(v=>report.cases.find(r=>r.variant===v&&r.tier===tier&&r.view===view).frames.at(-1));
  assert.deepEqual(a.canvas,b.canvas);assert.deepEqual(a.quality,b.quality);assert.deepEqual(a.stats.selectedCell,b.stats.selectedCell);
  for(const key of ['position','quaternion'])for(let i=0;i<a.camera[key].length;i++)assert(Math.abs(a.camera[key][i]-b.camera[key][i])<1e-6,`${tier}/${view} camera ${key} mismatch`);
  assert(Math.abs(a.camera.fov-b.camera.fov)<1e-6);assert.deepEqual(a.model,b.model);
  for(const variant of ['upstream','plugin']){const frames=report.cases.find(r=>r.variant===variant&&r.tier===tier&&r.view===view).frames;assert(frames.every(f=>f.stats.triangles===frames[0].stats.triangles&&f.stats.drawCalls===frames[0].stats.drawCalls));}
 }
 assert.equal(report.errors.length,0);report.assertions='Passed identical camera, selected cell, model pose, drawing buffer and quality; all three rendered frames have stable draw counts; no browser errors.';console.log(report.assertions);
}catch(e){report.failure=String(e.stack||e);throw e;}finally{await persist();await browser.close();console.log('REPORT',output+'/report.json');}
