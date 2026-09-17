import { chromium } from '/home/cloudstack/ai-data/prts.chat/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

if(process.argv[2]==='dynamic'){await import('./rhine-dynamic-profile.mjs');process.exit(0);}

const label=process.argv[2]||'baseline';
const output=`/tmp/rhine-visibility-${label}`;
const url='http://127.0.0.1:4177/';
const viewport={width:960,height:540};
await mkdir(output,{recursive:true});
const report={label,url,viewport,method:'Read-only local preview. Twelve real sources in browser-only initial snapshot. Original quality, explicit motion mode and fixed 50 ms RAF steps; intermediate GL draws suppressed, final three full frames render normally after the requested view is ready; moving background waves need not freeze. Three devtools observe hook reads actual scene objects without modifying product bundle.',errors:[],consoleErrors:[],warnings:[],requestFailures:[],records:[]};
const browser=await chromium.launch({headless:true,executablePath:'/home/cloudstack/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const persist=()=>writeFile(`${output}/stats.json`,JSON.stringify(report,null,2));
try{
  const context=await browser.newContext({viewport,deviceScaleFactor:1,reducedMotion:'reduce'});
  const fixture=JSON.parse(await readFile('/tmp/rhine-shelf-fixture.json','utf8'));
  report.sources=fixture.sources.map(({id,title,documentId,dataVersion})=>({id,title,documentId,dataVersion}));
  const page=await context.newPage();page.setDefaultTimeout(240000);
  page.on('pageerror',e=>report.errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')report.consoleErrors.push({text:m.text(),location:m.location()});if(m.type()==='warning'&&report.warnings.length<20)report.warnings.push(m.text());});
  page.on('requestfailed',r=>report.requestFailures.push({url:r.url(),error:r.failure()}));
  await page.route(url,async route=>{
    const response=await route.fetch();const html=await response.text();
    await route.fulfill({response,body:html.replace(/const snapshot=\{[^\n]*?\};/,`const snapshot=${JSON.stringify(fixture)};`)});
  });
  await page.route('**/rhine/rhine.js',async route=>{
    let bytes;
    if(label==='baseline')bytes=await readFile('/tmp/rhine-before-visibility-20260911/rhine.js');
    else bytes=await (await route.fetch()).body();
    report.bundle={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
    await route.fulfill({body:bytes,contentType:'text/javascript'});
  });
  await page.addInitScript(()=>{
    window.shelfObservedScenes=[];
    window.coverHistory={frames:0,minClarity:1,maxRoughness:0,phases:[]};
    window.__THREE_DEVTOOLS__=new EventTarget();
    window.visShadowHistory=[];window.visDrawSuppressed=false;
    const shadowHooked=new WeakSet();
    const emptyShadow=()=>({invocations:0,actualRounds:0,callbacks:0,casters:{},passes:[]});
    window.visShadowFrame=emptyShadow();
    window.__THREE_DEVTOOLS__.addEventListener('observe',event=>{
      const object=event.detail;
      if(object?.isScene)window.shelfObservedScenes.push(object);
      if(object?.isWebGLRenderer){
        const render=object.render;
        object.render=function(scene,...args){
          scene.traverse(mesh=>{
            if(!mesh.isMesh||shadowHooked.has(mesh))return;shadowHooked.add(mesh);
            const before=mesh.onBeforeShadow;
            mesh.onBeforeShadow=function(...args){
              if(!window.visDrawSuppressed){const frame=window.visShadowFrame;frame.callbacks++;const key=mesh.uuid;frame.casters[key]=(frame.casters[key]||0)+1;}
              return before.apply(this,args);
            };
          });
          return render.call(this,scene,...args);
        };
        const shadowRender=object.shadowMap.render;
        object.shadowMap.render=function(...args){
          const frame=window.visShadowFrame,before=frame.callbacks;
          if(!window.visDrawSuppressed)frame.invocations++;
          const result=shadowRender.apply(this,args);
          if(!window.visDrawSuppressed&&frame.callbacks>before){frame.actualRounds++;frame.passes.push(frame.callbacks-before);}
          return result;
        };
      }
    });
    window.shelfMaterials=()=>{
      const files=new Map(),arrayEdges=[],arrayCovers=[],entityCovers=[],instances=[];
      const material=mesh=>{const m=mesh.material;return {surface:mesh.userData.surface,name:mesh.name,visible:mesh.visible,color:m.color?.getHexString(),roughness:m.roughness,metalness:m.metalness,transmission:m.transmission,thickness:m.thickness,attenuationDistance:m.attenuationDistance,transparent:m.transparent,opacity:m.opacity,side:m.side,depthWrite:m.depthWrite,clarity:mesh.userData.glassClarity?.value,appearance:mesh.userData.appearance?.value};};
      for(const scene of window.shelfObservedScenes)scene.traverse(object=>{
        if(object.isGroup&&object.userData.sourceId){
          const meshes=[];object.traverse(child=>{if(child.isMesh&&['Frosted_Polymer','Ivory_Edges'].includes(child.userData.surface))meshes.push(material(child));});
          files.set(object.userData.sourceId,{id:object.userData.sourceId,visible:object.visible,position:object.position.toArray(),rotation:object.rotation.toArray().slice(0,3),meshes});
        }
        if(object.isInstancedMesh)instances.push({name:object.name,count:object.count,visible:object.visible,castShadow:object.castShadow,triangles:object.geometry.index?object.geometry.index.count/3:object.geometry.attributes.position.count/3});
        if(object.isInstancedMesh&&object.name==='Ivory_Edges')arrayEdges.push(material(object));
        if(object.isInstancedMesh&&object.name==='Frosted_Polymer')arrayCovers.push(material(object));
        if(object.isMesh&&object.userData.surface==='Frosted_Polymer')entityCovers.push(material(object));
      });
      return {observedScenes:window.shelfObservedScenes.length,files:[...files.values()],arrayEdges,arrayCovers,entityCovers,instances};
    };
    const nativeRAF=requestAnimationFrame.bind(window),nativeCancel=cancelAnimationFrame.bind(window);
    const queued=new Map();let sequence=0,enabled=true,lastNative=-1,virtualTime=1000,mode='array',startFrame=0,lastFrame=-1,lastSignature='',stable=0,realFinalFrames=0,suppress=false,realDraws=0;
    for(const proto of [window.WebGLRenderingContext?.prototype,window.WebGL2RenderingContext?.prototype]){
      if(!proto)continue;for(const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced','drawRangeElements']){
        const original=proto[name];if(typeof original!=='function')continue;proto[name]=function(...args){if(suppress)return;realDraws++;return original.apply(this,args);};
      }
    }
    const stop=()=>{enabled=false;for(const entry of queued.values()){if(entry.native)nativeCancel(entry.native);entry.native=0;}};
    const check=()=>{
      const s=window.rhineWorkbench?.stats?.();if(!s?.loaded||s.renderedFrames===lastFrame)return;lastFrame=s.renderedFrames;
      const covers=window.shelfMaterials();const h=window.coverHistory;h.frames++;
      for(const m of covers.entityCovers)if(typeof m.clarity==='number')h.minClarity=Math.min(h.minClarity,m.clarity);
      for(const m of [...covers.entityCovers,...covers.arrayCovers])h.maxRoughness=Math.max(h.maxRoughness,m.roughness||0);
      if(!h.phases.includes(s.decryption?.phase))h.phases.push(s.decryption?.phase);
      if(!suppress&&s.renderedFrames-startFrame>=72){realFinalFrames++;const shadow=window.visShadowFrame;window.visShadowHistory.push({mode,frame:s.renderedFrames,invocations:shadow.invocations,actualRounds:shadow.actualRounds,callbacks:shadow.callbacks,uniqueCasters:Object.keys(shadow.casters).length,maxCallsPerCaster:Math.max(0,...Object.values(shadow.casters)),passes:shadow.passes});}
      const ready=s.physicalFiles===12&&s.cameraLocation===(mode==='shelf'?'desk':'archive')&&!s.movingCamera&&(mode==='detail'?s.cameraDetail===1&&s.decryption?.phase==='clear'&&s.readerOpen:s.cameraDetail===0&&!s.readerOpen);
      const signature=JSON.stringify([s.cameraPosition,s.modelPosition,s.cameraDetail,s.drawCalls,s.triangles,s.selectedId,s.focusedId]);
      stable=ready&&signature===lastSignature?stable+1:0;lastSignature=signature;
      if(ready&&realFinalFrames>=3){stop();window.shelfGate.settled={mode,virtualTime,frame:s.renderedFrames,stable,realFinalFrames,realDraws};}
    };
    const schedule=entry=>{entry.native=nativeRAF(time=>{entry.native=0;if(!enabled)return;queued.delete(entry.id);if(time!==lastNative){lastNative=time;virtualTime+=50;}const frame=window.rhineWorkbench?.stats?.().renderedFrames||0;suppress=frame>0&&frame-startFrame<72;window.visDrawSuppressed=suppress;window.visShadowFrame=emptyShadow();entry.callback(virtualTime);check();});};
    window.requestAnimationFrame=callback=>{const entry={id:++sequence,callback,native:0};queued.set(entry.id,entry);if(enabled)schedule(entry);return entry.id;};
    window.cancelAnimationFrame=id=>{const entry=queued.get(id);if(entry?.native)nativeCancel(entry.native);queued.delete(id);};
    window.shelfGate={settled:null,resume(next){mode=next;startFrame=window.rhineWorkbench.stats().renderedFrames;stable=0;realFinalFrames=0;lastSignature='';this.settled=null;enabled=true;for(const entry of queued.values())if(!entry.native)schedule(entry);},stop};
  });
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
  const capture=async mode=>{
    const deadline=Date.now()+600000;let lastPrint=0;
    for(;;){
      const state=await page.evaluate(()=>({settled:window.shelfGate.settled,stats:window.rhineWorkbench?.stats?.()}));
      if(state.settled?.mode===mode){
        const record={mode,...state,materials:await page.evaluate(()=>window.shelfMaterials()),shadow:await page.evaluate(()=>window.visShadowHistory.slice(-3)),screenshot:`${output}/${mode}.png`};
        report.records.push(record);report.coverHistory=await page.evaluate(()=>window.coverHistory);await persist();
        await page.screenshot({path:record.screenshot,timeout:180000,animations:'disabled'});
        console.log('CAPTURE',mode,JSON.stringify({settled:state.settled,files:record.materials.files.length,stats:{location:state.stats.location,selectedId:state.stats.selectedId,focusedId:state.stats.focusedId},coverClarity:record.materials.files.map(file=>file.meshes.find(m=>m.surface==='Frosted_Polymer')?.clarity),edgeTransmission:record.materials.files.map(file=>file.meshes.find(m=>m.surface==='Ivory_Edges')?.transmission),coverHistory:report.coverHistory,drawCalls:state.stats.drawCalls,triangles:state.stats.triangles,shadow:record.shadow}));
        return;
      }
      if(Date.now()-lastPrint>15000){lastPrint=Date.now();console.log('WAIT',mode,JSON.stringify({frame:state.stats?.renderedFrames,files:state.stats?.physicalFiles,location:state.stats?.cameraLocation,detail:state.stats?.cameraDetail,moving:state.stats?.movingCamera}));}
      if(Date.now()>deadline)throw new Error(mode+' settlement timeout');
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  };
  await capture('array');
  await page.evaluate(()=>{document.querySelector('[data-action="open"]').click();window.shelfGate.resume('detail');});
  await capture('detail');
  report.beforeNavigation=report.records[1].stats.selectedCell;
  await page.evaluate(()=>{document.querySelector('[data-action="back"]').click();for(let i=0;i<3;i++)document.querySelector('[data-action="next"]').click();window.shelfGate.resume('array-return');});
  await capture('array-return');
  await page.evaluate(()=>{document.querySelector('.rhine-nav-rack').click();window.shelfGate.resume('shelf');});
  await capture('shelf');
  report.navigationVerified=report.records.every(record=>record.stats.physicalFiles===12&&record.materials.files.length===12)
    &&report.records[1].stats.readerOpen&&report.records[1].stats.cameraDetail===1&&!report.records[2].stats.readerOpen
    &&report.records[2].stats.selectedCell.row===report.beforeNavigation.row+3&&report.records[3].stats.cameraLocation==='desk';
  report.clearCoversVerified=report.coverHistory.minClarity===1&&Math.abs(report.coverHistory.maxRoughness-0.025)<1e-12;
  report.opaqueShelfEdgesVerified=report.records.every(record=>record.materials.files.every(file=>file.meshes.find(m=>m.surface==='Ivory_Edges')?.transmission===0));
  if(!report.navigationVerified||!report.clearCoversVerified||!report.opaqueShelfEdgesVerified)throw new Error('Navigation/clear-cover/opaque-edge regression');
}catch(error){report.failure=String(error.stack||error);throw error;}
finally{await persist();await browser.close();console.log('REPORT',`${output}/stats.json`);}
