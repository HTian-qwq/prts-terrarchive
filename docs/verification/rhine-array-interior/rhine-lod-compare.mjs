import { chromium } from '/home/cloudstack/ai-data/prts.chat/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const label = process.argv[2] || 'baseline';
const output = `/tmp/rhine-lod-${label}`;
const url = process.env.RHINE_PREVIEW_URL || 'http://127.0.0.1:4177/';
const viewport = {width:960,height:540};
await mkdir(output,{recursive:true});
const report = {label,url,viewport,deviceScaleFactor:1,reducedMotion:'reduce',
  note:'Software SwiftShader correctness/submission comparison; no FPS inference. Existing product quality unchanged. Harness gates RAF and supplies fixed 50 ms steps. Intermediate settling frames suppress only GL draw calls; the first frame and final three complete composer+label frames draw normally. Screenshots/statistics use only final real frames.',
  errors:[],consoleErrors:[],warnings:[],requestsFailed:[],httpErrors:[],assets:[],records:[]};
const browser=await chromium.launch({headless:true,
  executablePath:'/home/cloudstack/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const persist=()=>writeFile(`${output}/stats.json`,JSON.stringify(report,null,2));
try{
  const page=await browser.newPage({viewport,deviceScaleFactor:1,reducedMotion:'reduce'});
  page.setDefaultTimeout(240000);
  page.on('pageerror',error=>report.errors.push(error.message));
  page.on('console',msg=>{if(msg.type()==='error'){report.errors.push(msg.text());report.consoleErrors.push({text:msg.text(),location:msg.location()});}else if(msg.type()==='warning' && report.warnings.length<20)report.warnings.push(msg.text());});
  page.on('requestfailed',req=>report.requestsFailed.push({url:req.url(),error:req.failure()}));
  page.on('response',async response=>{
    if(response.status()>=400)report.httpErrors.push({url:response.url(),status:response.status()});
    if(/\.(js|glb|png)(\?|$)/.test(response.url())) {
      try{const body=await response.body();report.assets.push({url:response.url(),status:response.status(),bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')});}catch{}
    }
  });
  await page.addInitScript(()=>{
    const schedule=requestAnimationFrame.bind(window),cancel=cancelAnimationFrame.bind(window);
    const callbacks=new Map();let serial=0,enabled=true,lastNative=-1,virtualTime=1000;
    let mode='archive',lastSignature='',stableFrames=0,lastRendered=-1,startFrame=0,realFinalFrames=0;
    let suppressDraws=false,realDraws=0,suppressedDraws=0;
    for(const proto of [window.WebGLRenderingContext?.prototype,window.WebGL2RenderingContext?.prototype]){
      if(!proto)continue;
      for(const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced','drawRangeElements']){
        const original=proto[name];if(typeof original!=='function')continue;
        proto[name]=function(...args){if(suppressDraws){suppressedDraws++;return;}realDraws++;return original.apply(this,args);};
      }
    }
    const stop=()=>{enabled=false;for(const entry of callbacks.values()){if(entry.native)cancel(entry.native);entry.native=0;}};
    const check=()=>{
      const s=window.rhineWorkbench?.stats?.();
      if(!s?.loaded||s.renderedFrames===lastRendered)return;
      lastRendered=s.renderedFrames;
      window.lodHarness.lastStats=s;
      if(!suppressDraws&&s.renderedFrames-startFrame>=72)realFinalFrames++;
      const ready=mode.startsWith('archive')?s.extraction===0.4&&s.cameraDetail===0&&s.returningFiles===0:s.cameraDetail===1&&s.decryption?.phase==='clear'&&s.readerOpen;
      const signature=JSON.stringify([s.modelPosition,s.cameraPosition,s.rotation,s.extraction,s.cameraDetail,s.selectedCell,s.drawCalls,s.triangles]);
      stableFrames=ready&&signature===lastSignature?stableFrames+1:0;lastSignature=signature;
      if(ready&&stableFrames>=3&&realFinalFrames>=3){stop();window.lodHarness.settled={mode,stableFrames,renderedFrames:s.renderedFrames,virtualTime,realFinalFrames,realDraws,suppressedDraws};}
    };
    const enqueue=entry=>{entry.native=schedule(time=>{entry.native=0;if(!enabled)return;callbacks.delete(entry.id);if(time!==lastNative){lastNative=time;virtualTime+=50;}const frame=window.rhineWorkbench?.stats?.().renderedFrames||0;suppressDraws=frame>0&&frame-startFrame<72;entry.callback(virtualTime);check();});};
    window.requestAnimationFrame=callback=>{const entry={id:++serial,callback,native:0};callbacks.set(entry.id,entry);if(enabled)enqueue(entry);return entry.id;};
    window.cancelAnimationFrame=id=>{const entry=callbacks.get(id);if(entry?.native)cancel(entry.native);callbacks.delete(id);};
    window.lodHarness={lastStats:null,settled:null,resume(next){mode=next;stableFrames=0;lastSignature='';realFinalFrames=0;startFrame=window.rhineWorkbench?.stats?.().renderedFrames||0;this.settled=null;enabled=true;for(const entry of callbacks.values())if(!entry.native)enqueue(entry);},stop};
  });
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});
  report.adapter=await page.evaluate(()=>{const gl=document.createElement('canvas').getContext('webgl2');const debug=gl?.getExtension('WEBGL_debug_renderer_info');return {renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl?.getParameter(gl.RENDERER),devicePixelRatio};});
  const waitSettled=async mode=>{
    const deadline=Date.now()+600000;let lastPrint=0;
    for(;;){
      const state=await page.evaluate(()=>({settled:window.lodHarness.settled,stats:window.rhineWorkbench?.stats?.()}));
      if(state.settled?.mode===mode){console.log('SETTLED',mode,JSON.stringify(state));return state;}
      if(Date.now()-lastPrint>15000){lastPrint=Date.now();const s=state.stats;console.log('WAIT',mode,JSON.stringify({settled:state.settled,frame:s?.renderedFrames,loaded:s?.loaded,extraction:s?.extraction,detail:s?.cameraDetail,camera:s?.cameraPosition,model:s?.modelPosition,calls:s?.drawCalls,tris:s?.triangles,decryption:s?.decryption?.phase}));}
      if(Date.now()>deadline)throw new Error(`${mode} settlement timeout`);
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  };
  const capture=async mode=>{
    const state=await waitSettled(mode);
    await page.waitForFunction(()=>!window.rhineWorkbench.stats().searchBusy,undefined,{polling:250});
    const surface=await page.evaluate(()=>{const host=document.querySelector('#three-scene'),canvas=host?.querySelector('canvas');return {metrics:host?JSON.parse(host.dataset.renderQuality||'{}'):{},canvas:canvas?[canvas.width,canvas.height]:null,css:canvas?[canvas.clientWidth,canvas.clientHeight]:null,title:document.querySelector('#selected-title')?.textContent,readerTitle:document.querySelector('.rhine-reader-title')?.textContent,readerLines:document.querySelectorAll('.rhine-reader-line').length};});
    const record={mode,...state,surface,screenshot:`${output}/${mode}.png`};report.records.push(record);await persist();
    await page.screenshot({path:record.screenshot,timeout:180000,animations:'disabled'});
    record.statsAfterScreenshot=await page.evaluate(()=>window.rhineWorkbench.stats());await persist();
    console.log('CAPTURE',mode,JSON.stringify({frame:state.stats.renderedFrames,calls:state.stats.drawCalls,triangles:state.stats.triangles,surface,screenshot:record.screenshot}));
  };
  await capture('archive');
  await page.evaluate(()=>{document.querySelector('[data-action="open"]').click();window.lodHarness.resume('detail');});
  await capture('detail');
  if(label!=='baseline'){
    report.navigationBefore=await page.evaluate(()=>window.rhineWorkbench.stats());
    await page.evaluate(()=>{document.querySelector('[data-action="back"]').click();for(let i=0;i<3;i++)document.querySelector('[data-action="next"]').click();window.lodHarness.resume('archive-return');});
    await capture('archive-return');
    const end=report.records.at(-1).stats;
    report.navigationVerified=end.selectedCell.row===report.navigationBefore.selectedCell.row+3&&end.cameraDetail===0&&end.extraction===0.4&&end.returningFiles===0;
    if(!report.navigationVerified)throw new Error('Archive return/quick selection state mismatch');
  }
}catch(error){report.failure=String(error.stack||error);throw error;}
finally{await persist();await browser.close();console.log('REPORT',`${output}/stats.json`);}
