import { chromium } from '/home/cloudstack/ai-data/prts.chat/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const runLabel=process.argv[3]||'baseline';
const output=`/tmp/rhine-dynamic-${runLabel}`,url='http://127.0.0.1:4177/';
await mkdir(output,{recursive:true});
const sources=JSON.parse(await readFile('/tmp/rhine-shelf-fixture.json','utf8')).sources;
const report={runLabel,method:'Independent read-only preview, browser-only snapshots, normal motion. Fixed 50 ms steps, most GL draws suppressed for CPU attribution; only initial and three phase-end frames draw normally. Timings are instrumented JS wall time on SwiftShader, not FPS or GPU time.',phases:[],snapshots:[],errors:[],consoleErrors:[],warnings:[]};
const browser=await chromium.launch({headless:true,executablePath:'/home/cloudstack/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const persist=()=>writeFile(output+'/profile.json',JSON.stringify(report,null,2));
try{
 const page=await browser.newPage({viewport:{width:960,height:540},deviceScaleFactor:1,reducedMotion:'no-preference'});page.setDefaultTimeout(240000);
 page.on('pageerror',error=>report.errors.push(error.message));
 page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push({text:message.text(),location:message.location()});if(message.type()==='warning'&&report.warnings.length<10)report.warnings.push(message.text());});
 await page.route('**/rhine/rhine.js',async route=>{const bytes=runLabel==='baseline'?await readFile('/tmp/rhine-dynamic-before-20260912.js'):await (await route.fetch()).body();report.bundle={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};await route.fulfill({body:bytes,contentType:'text/javascript'});});
 await page.addInitScript(()=>{
  const counters={canvasCreated:0,labelPaints:0,fillText:0,groupClones:0,meshClones:0,materialClones:0,canvasTexturesObserved:0,explicitCompile:0,glCreateProgram:0,glLinkProgram:0,glCompileShader:0};
  const scenes=[],renderers=[],patched=new WeakSet(),textures=new Set(),canvasText=new WeakMap(),preparationTasks=[];let renderCpu=0;
  const own=(value,key)=>{for(let p=value;p;p=Object.getPrototypeOf(p))if(Object.prototype.hasOwnProperty.call(p,key))return p;};
  const patchClone=(value,kind)=>{const p=own(value,'clone');if(!p||patched.has(p))return;patched.add(p);const original=p.clone;p.clone=function(...args){if(kind==='material')counters.materialClones++;else if(this.isGroup)counters.groupClones++;else if(this.isMesh)counters.meshClones++;return original.apply(this,args);};};
  const create=document.createElement;document.createElement=function(name,...args){if(String(name).toLowerCase()==='canvas')counters.canvasCreated++;return create.call(this,name,...args);};
  const fill=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function(...args){counters.fillText++;const lines=canvasText.get(this.canvas)||[];lines.push(String(args[0]));canvasText.set(this.canvas,lines);return fill.apply(this,args);};
  const rect=CanvasRenderingContext2D.prototype.fillRect;CanvasRenderingContext2D.prototype.fillRect=function(x,y,w,h){if(x===0&&y===0&&w===1024&&h===440){counters.labelPaints++;canvasText.set(this.canvas,[]);}return rect.call(this,x,y,w,h);};
  window.__THREE_DEVTOOLS__=new EventTarget();
  window.__THREE_DEVTOOLS__.addEventListener('observe',event=>{
   const value=event.detail;
   if(value?.isScene){scenes.push(value);patchClone(value,'object');}
   if(value?.isWebGLRenderer){renderers.push(value);const render=value.render;value.render=function(...args){const start=performance.now();try{return render.apply(this,args);}finally{renderCpu+=performance.now()-start;}};for(const key of ['compile','compileAsync']){const fn=value[key];value[key]=function(...args){counters.explicitCompile++;return fn.apply(this,args);};}}
  });
  const scan=()=>{for(const scene of scenes)scene.traverse(mesh=>{if(!mesh.isMesh)return;for(const mat of Array.isArray(mesh.material)?mesh.material:[mesh.material]){patchClone(mat,'material');for(const key of ['map','normalMap','roughnessMap','aoMap']){const texture=mat[key];if(texture?.isCanvasTexture&&!textures.has(texture.uuid)){textures.add(texture.uuid);counters.canvasTexturesObserved++;}}}});};
  const nativeRAF=requestAnimationFrame.bind(window),nativeCancel=cancelAnimationFrame.bind(window),queued=new Map();let id=0,enabled=true,lastNative=-1,time=1000,mode='idle',startFrame=0,wanted=72,drawEnd=true,lastFrame=-1,suppress=false;
  const nativeTimeout=window.setTimeout;window.setTimeout=function(callback,delay,...args){if(typeof callback!=='function')return nativeTimeout.call(this,callback,delay,...args);return nativeTimeout.call(this,function(...values){const before=window.rhineWorkbench?.stats?.(),counts={...counters},started=performance.now();const result=callback.apply(this,values),cpuMs=performance.now()-started,after=window.rhineWorkbench?.stats?.();if(before?.preparation&&after?.preparation&&(after.preparation.running!==before.preparation.running||after.collectionResources?.created!==before.collectionResources?.created)){const task={phase:mode,frame:before.renderedFrames,cpuMs,before:{preparation:before.preparation,resources:before.collectionResources},after:{preparation:after.preparation,resources:after.collectionResources},delta:Object.fromEntries(Object.entries(counters).map(([key,value])=>[key,value-counts[key]]))};preparationTasks.push(task);queueMicrotask(()=>{const stats=window.rhineWorkbench?.stats?.();task.settled={preparation:stats?.preparation,resources:stats?.collectionResources};});}return result;},delay,...args);};
  for(const proto of [window.WebGLRenderingContext?.prototype,window.WebGL2RenderingContext?.prototype]){
   if(!proto)continue;for(const [name,countKey] of [['createProgram','glCreateProgram'],['linkProgram','glLinkProgram'],['compileShader','glCompileShader']]){const fn=proto[name];if(fn)proto[name]=function(...args){counters[countKey]++;return fn.apply(this,args);};}
   for(const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced','drawRangeElements']){const fn=proto[name];if(fn)proto[name]=function(...args){if(!suppress)return fn.apply(this,args);};}
  }
  const stop=()=>{enabled=false;for(const item of queued.values()){if(item.native)nativeCancel(item.native);item.native=0;}};
  const schedule=item=>{item.native=nativeRAF(nativeTime=>{item.native=0;if(!enabled)return;queued.delete(item.id);if(lastNative!==nativeTime){lastNative=nativeTime;time+=50;}const before=window.rhineWorkbench?.stats?.().renderedFrames||0;suppress=before>0&&(!drawEnd||before-startFrame<wanted);renderCpu=0;const started=performance.now();item.callback(time);const cpu=performance.now()-started;const stats=window.rhineWorkbench?.stats?.();if(stats?.loaded&&stats.renderedFrames!==lastFrame){lastFrame=stats.renderedFrames;scan();const renderer=renderers[0];window.dynamicProbe.frames.push({phase:mode,frame:lastFrame,virtualTime:time,glSuppressed:suppress,cpuMs:cpu,renderCpuMs:renderCpu,nonRenderCpuMs:Math.max(0,cpu-renderCpu),calls:stats.drawCalls,triangles:stats.triangles,activeFiles:stats.archiveActivities?.length||0,activities:stats.archiveActivities,returningFiles:stats.returningFiles,physicalFiles:stats.physicalFiles,preparation:stats.preparation,collectionResources:stats.collectionResources,queue:stats.transferQueue,programs:renderer?.info.programs?.length,memory:renderer?{...renderer.info.memory}:null,counters:{...counters}});if(lastFrame-startFrame>=wanted+(drawEnd?1:0)){stop();window.dynamicProbe.done=mode;}}});};
  window.requestAnimationFrame=callback=>{const item={id:++id,callback,native:0};queued.set(item.id,item);if(enabled)schedule(item);return item.id;};
  window.cancelAnimationFrame=id=>{const item=queued.get(id);if(item?.native)nativeCancel(item.native);queued.delete(id);};
  window.dynamicProbe={frames:[],done:null,counters,scan,preparationTasks,inspectShelf(){const rows=[];for(const scene of scenes)scene.traverse(group=>{if(!group.isGroup||!group.userData.sourceId)return;const label=group.getObjectByName('Rhine_Archive_Label'),canvas=label?.material?.map?.image;rows.push({sourceId:group.userData.sourceId,visible:group.visible,key:label?.userData.archiveLabelKey,canvasSize:canvas?[canvas.width,canvas.height]:null,text:canvasText.get(canvas)||[]});});return rows;},run(next,count,draw){mode=next;wanted=count;drawEnd=draw;startFrame=window.rhineWorkbench.stats().renderedFrames;this.done=null;enabled=true;for(const item of queued.values())if(!item.native)schedule(item);},snapshot(next,count=1){scan();const before={...counters},rows=[];for(let i=0;i<count;i++){const start=performance.now();window.rhineWorkbench.update(next);rows.push(performance.now()-start);}scan();return {iterations:count,cpuMs:rows,delta:Object.fromEntries(Object.entries(counters).map(([key,value])=>[key,value-before[key]])),stats:window.rhineWorkbench.stats()};}};
 });
 await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
 const phase=async(name,frames,draw)=>{
  if(name!=='idle')await page.evaluate(({name,frames,draw})=>window.dynamicProbe.run(name,frames,draw),{name,frames,draw});
  const deadline=Date.now()+300000;
  while(await page.evaluate(()=>window.dynamicProbe.done)!==name){if(Date.now()>deadline)throw new Error(name+' timeout');await new Promise(resolve=>setTimeout(resolve,500));}
  const data=await page.evaluate(name=>({name,frames:window.dynamicProbe.frames.filter(frame=>frame.phase===name),stats:window.rhineWorkbench.stats(),preparationTasks:window.dynamicProbe.preparationTasks.filter(task=>task.phase===name)}),name);
  report.phases.push(data);await persist();
  const peak=data.frames.reduce((a,b)=>a.triangles>b.triangles?a:b);const maxCpu=Math.max(...data.frames.map(f=>f.cpuMs));
  console.log('PHASE',name,JSON.stringify({frames:data.frames.length,maxCpu,peak:{frame:peak.frame,calls:peak.calls,triangles:peak.triangles,active:peak.activeFiles,returning:peak.returningFiles,programs:peak.programs},counters:data.frames.at(-1).counters,finalStats:{active:data.stats.archiveActivities,queue:data.stats.transferQueue}}));
 };
 const snapshot=async(name,value,n=1)=>{const data=await page.evaluate(({value,n})=>window.dynamicProbe.snapshot(value,n),{value,n});report.snapshots.push({name,...data});await persist();console.log('SNAPSHOT',name,JSON.stringify({n,cpuMs:data.cpuMs,delta:data.delta,physicalFiles:data.stats.physicalFiles}));};
 await phase('idle');
 const base={sessionId:'preview-local-v1',investigationId:'dynamic-profile-local',running:true,searching:true,phase:'searching',query:'测试检索动态',tool:'corpus_search',sources:[],answer:'',records:[],operations:[{id:'dynamic-search',tool:'corpus_search',kind:'search',state:'active',sourceIds:[],startedAt:Date.now()}]};
 await snapshot('search-start',base);await phase('search',36,false);
 const found={...base,searching:false,sources:sources.map(source=>({...source,state:'found',callId:'dynamic-search'})),operations:[{...base.operations[0],state:'complete',sourceIds:sources.map(s=>s.id),completedAt:Date.now()}]};
 await snapshot('sources-arrived',found);await snapshot('same-sources-repeat-40',found,40);await phase('arrivals',36,true);
 const reading={...found,phase:'reading',tool:'corpus_read',operations:[...found.operations,{id:'dynamic-read',tool:'corpus_read',kind:'read',state:'active',sourceIds:[sources[3].id],documentId:sources[3].documentId,dataVersion:sources[3].dataVersion,startedAt:Date.now()}]};
 await snapshot('read-start',reading);await phase('reading',120,true);
 const complete={...reading,running:false,phase:'complete',operations:reading.operations.map(op=>({...op,state:'complete',completedAt:Date.now()})),sources:reading.sources.map((source,index)=>index===3?{...source,state:'read'}:source)};
 await snapshot('read-complete',complete);await phase('completed',60,false);
 if(runLabel!=='baseline'){await page.locator('.rhine-nav-rack').click();await phase('rack',72,true);report.rack=await page.evaluate(()=>({labels:window.dynamicProbe.inspectShelf(),stats:window.rhineWorkbench.stats()}));report.rack.expected=sources.map((source,index)=>({id:source.id,code:'NO.'+String(index+1).padStart(3,'0')}));await page.screenshot({path:output+'/rack.png'});await persist();console.log('RACK',JSON.stringify(report.rack.labels));}
}catch(error){report.failure=String(error.stack||error);throw error;}
finally{await persist();await browser.close();console.log('REPORT',output+'/profile.json');}
