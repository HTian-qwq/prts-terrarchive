import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import {readFile,writeFile,mkdtemp} from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url));
const hostDir=resolve(process.env.PRTS_DSH_SOURCE_DIR || join(root,'../deepseek-harness'));
const preview=process.env.PRTS_RHINE_PREVIEW_URL || 'http://127.0.0.1:4177';
const output=process.env.PRTS_RHINE_TEST_OUTPUT || await mkdtemp(join(tmpdir(),'prts-rhine-browser-'));
const noWebGL=process.env.PRTS_RHINE_TEST_NO_WEBGL==='1';
const performanceQuality={scale:100,pixelRatio:1,antialias:'smaa',shadows:1024,aoSamples:0,aoResolution:0.5,depthOfField:0,transmission:0.5,anisotropy:4};
const hostRequire=createRequire(join(hostDir,'packages/client/ui-conversation/package.json'));
const packageRequire=createRequire(new URL('../package.json',import.meta.url));
const viteRequire=createRequire(packageRequire.resolve('vite/package.json'));
const {build}=await import(pathToFileURL(viteRequire.resolve('esbuild')).href);
const playwrightPath=process.env.PRTS_PLAYWRIGHT_MODULE || createRequire(join(hostDir,'package.json')).resolve('playwright');
const {chromium}=await import(pathToFileURL(resolve(playwrightPath)).href);
const entry=await readFile(new URL('./fixtures/rhine-host.js',import.meta.url),'utf8');
await build({stdin:{contents:entry.replace('"@host-react"',JSON.stringify(hostRequire.resolve('react'))).replace('"@host-react-dom"',JSON.stringify(hostRequire.resolve('react-dom/client'))),resolveDir:root,loader:'js'},bundle:true,outfile:join(output,'react-host.js'),format:'iife'});
const browser=await chromium.launch({headless:true,...(process.env.PRTS_BROWSER_EXECUTABLE?{executablePath:process.env.PRTS_BROWSER_EXECUTABLE}:{}),args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
let page;
try {
// Software-rendered CI uses the original reduced-motion preference to settle
// geometry. Materials, camera and the product's fixed performance quality remain.
page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
page.setDefaultTimeout(noWebGL?30000:180000);
const waitForState=(predicate,options={})=>page.waitForFunction(predicate,undefined,{polling:100,...options});
if(noWebGL)await page.addInitScript(()=>{
  const original=HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext=function(type,...args){return /^webgl/.test(type)?null:original.call(this,type,...args)};
});
await page.addInitScript(()=>{
  localStorage.setItem('prts-rhine-quality:v1',JSON.stringify({scale:150,pixelRatio:2,antialias:'smaa',shadows:4096,aoSamples:64,aoResolution:1,depthOfField:100,transmission:1,anisotropy:16}));
});
await page.addInitScript(()=>{
  // Gate frame scheduling only in this test harness. This allows DOM checks on
  // a software renderer without changing the product's fixed performance quality.
  const schedule=window.requestAnimationFrame.bind(window);
  const cancel=window.cancelAnimationFrame.bind(window);
  const callbacks=new Map();let sequence=0;let enabled=true;
  const enqueue=entry=>{entry.native=schedule(time=>{entry.native=0;if(!enabled)return;callbacks.delete(entry.id);entry.callback(time);});};
  window.requestAnimationFrame=callback=>{const entry={id:++sequence,callback,native:0};callbacks.set(entry.id,entry);if(enabled)enqueue(entry);return entry.id;};
  window.cancelAnimationFrame=id=>{const entry=callbacks.get(id);if(entry?.native)cancel(entry.native);callbacks.delete(id);};
  window.testSetFramesActive=value=>{enabled=value;for(const entry of callbacks.values()){if(!enabled&&entry.native){cancel(entry.native);entry.native=0;}else if(enabled&&!entry.native)enqueue(entry);}};
});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/host-test',async route=>route.fulfill({contentType:'text/html',body:`<html><meta charset="utf-8"><style>body{margin:0}#host{height:100vh}</style><body><div id="host"></div></body></html>`}));
await page.route('**/api/prts-corpus/skins/*',async route=>route.fulfill({contentType:'text/css',body:await readFile(root+'/lib/skins/'+route.request().url().split('/').at(-1))}));
await page.route('**/api/prts-corpus/rhine/**',async route=>{
 const path=route.request().url().split('/rhine/')[1];
 let body=await readFile(root+'/lib/rhine/'+path);
 if(path==='rhine.js')body=Buffer.concat([body,Buffer.from(';const realMount=__PRTS_RHINE__.mountRhineWorkbench;__PRTS_RHINE__.mountRhineWorkbench=(...args)=>{window.hostWorkbenchMounts=(window.hostWorkbenchMounts||0)+1;return window.hostWorkbench=realMount(...args)};')]);
 await route.fulfill({body,contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.woff2')?'font/woff2':'model/gltf-binary'});
});
await page.route('**/api/prts-corpus/rpc',async route=>{
 const body=route.request().postDataJSON();
 if(body.endpoint==='status')return route.fulfill({json:{ok:true,value:{config:{uiSkin:'rhine-lab'}}}});
 const response=await route.fetch({url:preview+'/rpc'});const data=await response.json();
 await route.fulfill({json:response.ok()?{ok:true,value:data}:{ok:false,error:{message:data.error}}});
});
await page.goto(preview+'/host-test');
await page.addScriptTag({path:join(output,'react-host.js')});
await page.evaluate(()=>{window.__ModuleLoader__={load({factory}){window.hostPlugin=factory(()=>window.hostReact)}}});
await page.addScriptTag({path:root+'/lib/client.js'});
await page.evaluate(()=>{
 const cleanups=[];const slots=[];window.hostPrompts=[];
 window.hostContext={theme:{overrideTokens:()=>()=>{}},sessions:{binding:()=>({session:{beginSubmission:()=>({requestId:'test-request',abandon(){}}),prompt:async(...args)=>{window.hostPrompts.push(args);return{ok:true,value:{accepted:true}}},loadOlder:async()=>{window.hostSession.hasMore=false;window.hostEmit()}}})},
 slots:{inject:(name,fn)=>fn(),register:(entry,Component)=>{slots.push({entry,Component});return()=>{}}},effect:(fn)=>{const dispose=fn();cleanups.push(dispose);return dispose}};
 window.hostPlugin.apply(window.hostContext);
 window.renderRhineHost(slots);
 window.hostCleanup=()=>{window.hostRoot.unmount();cleanups.reverse().forEach(fn=>fn?.())};
});
await waitForState(()=>window.hostWorkbench?.stats().resultCount===12&&!window.hostWorkbench.stats().searchBusy);
if(!noWebGL){
 await waitForState(()=>window.hostWorkbench?.stats().loaded,{timeout:180000});
 await waitForState(()=>window.hostWorkbench.stats().extraction===0.4,{timeout:180000});
}
await page.evaluate(()=>window.testSetFramesActive(false));
assert.equal(await page.locator('.prts-rhine-overlay').count(),1);
assert.equal(await page.evaluate(()=>window.hostSession.blank),true);
assert.equal(await page.locator('[data-slot="conversation.session.header.utilities"]').count(),0,'DSH has no header utilities in a blank session');
assert.equal(await page.locator('[data-slot="conversation.input.left"] .prts-rhine-trigger').count(),1,'the resident composer opens the archive before the first prompt');
assert.equal(await page.evaluate(()=>window.hostWorkbenchMounts),1,'blank-session activation mounts one workbench');
await page.evaluate(()=>{
 window.testInitialOverlay=document.querySelector('.prts-rhine-overlay');
 window.testInitialWorkbench=window.hostWorkbench;
});
const original=await page.evaluate(()=>window.hostWorkbench.stats());
assert.deepEqual(original.quality,performanceQuality,'previously saved ultra settings must not override the fixed performance quality');
assert.equal(await page.locator('.quality-settings, #quality-preset, [data-quality]').count(),0,'the workbench no longer offers quality controls');
assert.equal(original.sourceCount,0,'real catalogue browsing is independent of the evidence rack');
assert.equal(await page.locator('.rhine-original-result').count(),0,'no upstream demonstration documents');
assert.equal(await page.locator('.rhine-agent-form').isVisible(),true);
await page.screenshot({path:join(output,'main.png')});
await page.locator('#rhine-agent-question').fill('克丽斯腾与孤星有哪些关联？');
await page.locator('.rhine-agent-submit').click();
await waitForState(()=>window.hostPrompts.length===1);
assert.match(await page.evaluate(()=>window.hostPrompts[0][0][0].text),/克丽斯腾与孤星/);
if(!noWebGL){
assert.equal(original.archiveCount,288);
assert.deepEqual(original.renderQuality,performanceQuality,'the array actually renders at the fixed performance quality');
// Native navigation retains physical direction across both logical wraps.
await page.evaluate(()=>{for(let i=0;i<8;i++)document.querySelector('[data-action="next"]').click();});
let navigation=await page.evaluate(()=>window.hostWorkbench.stats());
assert.equal(navigation.selectedCell.row,original.selectedCell.row+8);
await page.evaluate(()=>{for(let i=0;i<5;i++)document.querySelector('[data-action="column-next"]').click();});
navigation=await page.evaluate(()=>window.hostWorkbench.stats());
assert.equal(navigation.archiveColumn,original.archiveColumn);
assert.equal(navigation.selectedCell.lane,original.selectedCell.lane+5);
}
await page.evaluate(()=>{
 window.hostChat.order.push('question');window.hostChat.nodes.set('question',{kind:'user',data:{content:[{type:'text',text:'克丽斯腾与孤星有哪些关联？'}]}});
 window.hostChat.order.push('cloud');window.hostChat.nodes.set('cloud',{kind:'tool-call',data:{root:{name:'cloud_search',argsRaw:'{"query":"克丽斯腾"}'}}});window.hostSession.blank=false;window.hostSession.running=true;window.hostEmit();
});
await waitForState(()=>document.querySelector('.rhine-case-phase')?.textContent.includes('检索'));
assert.equal(await page.locator('[data-slot="conversation.session.header.utilities"]').count(),1,'the first prompt makes DSH header utilities available');
assert.equal(await page.locator('.prts-rhine-trigger').count(),1,'adding the header must not duplicate the archive control');
assert.equal(await page.locator('.prts-rhine-overlay').count(),1,'adding the header must not create a second overlay');
assert.equal(await page.evaluate(()=>document.querySelector('.prts-rhine-overlay')===window.testInitialOverlay),true,'the first prompt retains the existing archive overlay');
assert.equal(await page.evaluate(()=>window.hostWorkbench===window.testInitialWorkbench),true,'the first prompt retains the workbench and its browsing state');
assert.equal(await page.evaluate(()=>window.hostWorkbenchMounts),1,'the blank-to-active transition must not remount the workbench');
assert.equal(await page.locator('.rhine-case-question').innerText(),'克丽斯腾与孤星有哪些关联？');
const localSources=await page.evaluate(async()=>{const r=await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint:'archive.search',payload:{query:'克丽斯腾'}})});return(await r.json()).sources;});
await page.evaluate(sources=>{
 window.hostChat.nodes.set('cloud',{kind:'tool-call',data:{root:{kind:'tool-result',call:{name:'cloud_search',argsRaw:'{"query":"克丽斯腾"}'},content:[{type:'text',text:'工具返回回执（浏览器集成测试）'}],meta:{kind:'prts-archive-sources-v1',sources:sources.slice(0,8).map(s=>({...s,origin:'cloud'}))}}}});window.hostEmit();
},localSources);
await waitForState(()=>window.hostWorkbench.stats().sourceCount===8);
if(!noWebGL)assert.equal(await page.evaluate(()=>window.hostWorkbench.stats().transferredSourceCount),0,'search hits do not claim reads or fly out as read documents');
await page.evaluate(()=>window.testSetFramesActive(true));
await page.locator('.rhine-nav-rack').click();
if(!noWebGL)await waitForState(()=>!window.hostWorkbench.stats().movingCamera,{timeout:180000});
if(!noWebGL)assert.deepEqual(await page.evaluate(()=>window.hostWorkbench.stats().renderQuality),{...performanceQuality,transmission:1},'the rack retains full-resolution transmission with the fixed performance quality');
await page.evaluate(()=>window.testSetFramesActive(false));
await page.screenshot({path:join(output,'rack.png')});
await page.locator('.rhine-desk-item').first().click();
assert.equal(await page.locator('.rhine-reader').isVisible(),false,'slot click focuses a file without opening the reader');
await page.locator('.rhine-shelf-open').click();
await page.waitForSelector('.rhine-reader-line',{timeout:30000});
if(!noWebGL){
 await page.evaluate(()=>window.testSetFramesActive(true));
 await waitForState(()=>window.hostWorkbench.stats().cameraDetail>=0.999,{timeout:180000});
 await page.evaluate(()=>window.testSetFramesActive(false));
}
console.log('READER',await page.locator('.rhine-reader-status').innerText());
const prior=await page.evaluate(()=>{const b=document.querySelector('.rhine-reader-body');b.scrollTop=140;window.testReaderNode=b.firstChild;return {title:document.querySelector('.rhine-reader-title').textContent,scroll:b.scrollTop,camera:window.hostWorkbench.stats().cameraX};});
await page.evaluate(sources=>{
 window.hostChat.order.push('more');window.hostChat.nodes.set('more',{kind:'tool-call',data:{root:{kind:'tool-result',call:{name:'corpus_search',argsRaw:'{}'},content:[{type:'text',text:'第二批结果（浏览器集成测试）'}],meta:{kind:'prts-archive-sources-v1',sources:sources.slice(8,10)}}}});window.hostEmit();
},localSources);
await waitForState(()=>window.hostWorkbench.stats().sourceCount===10);
assert.equal(await page.evaluate(()=>document.querySelector('.rhine-reader-body').firstChild===window.testReaderNode),true);
assert.equal(await page.locator('.rhine-reader-title').innerText(),prior.title);
assert.equal(await page.evaluate(()=>document.querySelector('.rhine-reader-body').scrollTop),prior.scroll);
assert.equal(await page.evaluate(()=>window.hostWorkbench.stats().cameraX),prior.camera);
await page.evaluate(source=>{
 const rows=[...document.querySelectorAll('.rhine-reader-line')];
 const start=Number(rows[0]?.dataset.line||source.lineStart||1);
 const end=Number(rows.at(-1)?.dataset.line||source.lineEnd||start);
 window.hostChat.order.push('read');window.hostChat.nodes.set('read',{kind:'tool-call',data:{root:{kind:'tool-result',
 call:{name:'corpus_read',argsRaw:JSON.stringify({document_id:source.documentId,data_version:source.dataVersion})},
 content:[{type:'text',text:rows.map(row=>row.innerText).join('\n')}],
 meta:{kind:'prts-archive-sources-v1',sources:[{...source,state:'read',kind:'corpus_read',readRanges:[{start,end}]}]}}}});
 window.hostEmit();
},localSources[0]);
await waitForState(()=>document.querySelector('.rhine-read-count')?.textContent==='01');
assert.equal(await page.evaluate(()=>document.querySelector('.rhine-reader-body').firstChild===window.testReaderNode),true,'read status updates retain the current text nodes');
assert.equal(await page.evaluate(()=>window.hostWorkbench.stats().sourceCount),10,'read upgrades do not create another physical source');
await page.evaluate(()=>{const text=document.querySelector('.rhine-reader-line .rhine-line-text');const r=document.createRange();r.selectNodeContents(text);const selection=getSelection();selection.removeAllRanges();selection.addRange(r);});
await page.locator('.rhine-extract-selection').click();
assert.equal(await page.evaluate(()=>window.hostWorkbench.stats().extractCount),1);
await page.screenshot({path:join(output,'reader.png')});
await page.locator('.rhine-nav-index').click();
await page.locator('#rhine-query').fill('解释这段资料');
await page.locator('.rhine-ask-agent').click();
await waitForState(()=>window.hostPrompts.length===2);
const prompt=await page.evaluate(()=>window.hostPrompts[1]);
assert.equal(prompt[1],'queue');assert.equal(prompt[3],'test-request');assert.match(prompt[0][0].text,/版本：/);assert.match(prompt[0][0].text,/行号：/);
await page.locator('.rhine-nav-log').click();
await page.locator('.rhine-log-record summary').first().click();
assert.match(await page.locator('.rhine-record-text').first().innerText(),/浏览器集成测试/);
await page.evaluate(()=>{window.hostSession.hasMore=true;window.hostEmit();});
await page.locator('.rhine-load-history').click();
await waitForState(()=>!window.hostSession.hasMore&&!document.querySelector('.rhine-load-history'));
await page.screenshot({path:join(output,'records.png')});
await page.locator('.rhine-close-log').click();
await page.evaluate(()=>{
 window.hostSession.running=false;window.hostChat.order.push('answer');
 window.hostChat.nodes.set('answer',{kind:'assistant-step',data:{status:'settled',blocks:[{kind:'text',text:'这是一份来自 Host 可见回答的调查报告。'}]}});window.hostEmit();
});
await page.locator('.rhine-shelf-report').click();
assert.equal(await page.locator('.rhine-report-body').innerText(),'这是一份来自 Host 可见回答的调查报告。');
await page.locator('.rhine-close-report').click();
assert.equal(await page.locator('.rhine-desk-item').count(),8);
await page.locator('.rhine-desk-item').nth(4).click();
assert.equal(await page.locator('.rhine-desk-item.is-selected').innerText(),'05','slot selection accepts an exact multi-file delta');
await page.locator('.rhine-desk-item').nth(4).click();
assert.equal(await page.locator('.rhine-desk-item.is-selected').innerText(),'05','clicking the focused slot does not advance');
await page.locator('.rhine-desk-pagination .rhine-page-button').last().click();
assert.equal(await page.locator('.rhine-desk-item').count(),2);
assert.equal(await page.locator('.rhine-desk-item.is-selected').innerText(),'09');
if(!noWebGL)assert.equal(await page.evaluate(()=>window.hostWorkbench.stats().physicalFiles),2);
await page.evaluate(()=>window.hostWorkbench.setActive(false));
assert.equal(await page.locator('.rhine-workbench').isVisible(),false);
if(!noWebGL)assert.equal(await page.evaluate(()=>window.hostWorkbench.stats().pendingRAF),false);
const f=await page.evaluate(()=>window.hostWorkbench.stats().renderedFrames);await page.waitForTimeout(1000);assert.equal(await page.evaluate(()=>window.hostWorkbench.stats().renderedFrames),f);
await page.evaluate(()=>window.hostWorkbench.setActive(true));
console.log('DESK',await page.evaluate(()=>window.hostWorkbench.stats()));
await page.locator('.rhine-nav-close').click();
await waitForState(()=>!document.querySelector('.prts-rhine-overlay'));
if(!noWebGL)assert.equal(await page.evaluate(()=>window.hostWorkbench.stats().disposed),true);
await page.locator('.prts-rhine-trigger').click();await page.waitForSelector('.rhine-workbench');
// Queryless directory browsing and opaque search pagination use the real API.
await page.locator('.rhine-nav-index').click();
assert.equal(await page.locator('.rhine-original-result').count(),0);
await page.locator('#rhine-query').fill('');
await page.locator('.rhine-search-submit').click();
console.log('CATALOGUE SUBMITTED',await page.locator('.rhine-result-summary').textContent());
await waitForState(()=>document.querySelector('.rhine-result-summary')?.textContent.includes('已载入 12'));
await page.locator('.rhine-load-more').click();
await waitForState(()=>document.querySelector('.rhine-result-summary')?.textContent.includes('已载入 24'));
const priorManualCount=await page.evaluate(()=>window.hostWorkbench.stats().manualSourceCount);
await page.locator('.rhine-result-open').first().click();
await page.waitForSelector('.rhine-reader-line');
console.log('REAL DIRECTORY READER');
assert.equal(await page.evaluate(()=>window.hostWorkbench.stats().manualSourceCount),priorManualCount,'manual browsing must not silently collect sources or mark Agent reads');
// Hidden landscape panels must not let keyboard focus escape behind the reader.
await page.setViewportSize({width:844,height:390});
console.log('LANDSCAPE');
await page.evaluate(()=>{
 const controls=[...document.querySelector('.prts-rhine-overlay').querySelectorAll('button:not([disabled]),[href],input:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(e=>e.getClientRects().length&&!e.closest('[hidden],[inert],[aria-hidden="true"]'));
 window.testFirstControl=controls[0];window.testLastControl=controls.at(-1);window.testLastControl.focus();
});
await page.keyboard.press('Tab');
assert.equal(await page.evaluate(()=>document.activeElement===window.testFirstControl),true);
await page.keyboard.press('Shift+Tab');
assert.equal(await page.evaluate(()=>document.activeElement===window.testLastControl),true);
await page.locator('.rhine-close-reader').click();
await page.locator('.rhine-nav-index').click();
await page.evaluate(()=>window.hostWorkbench.update({sessionId:'new-session',running:false,searching:false,query:'',tool:'',sources:[],answer:'',records:[]}));
assert.equal(await page.evaluate(()=>window.hostWorkbench.stats().sourceCount),0,'changing sessions empties the prior evidence rack');
assert.equal(await page.locator('.rhine-results').isVisible(),false);
assert.equal(await page.locator('.rhine-nav-index').evaluate(element=>Boolean(element.closest('[inert]'))),false,'session change releases the previous modal input lock');
await page.evaluate(()=>window.hostCleanup());
assert.equal(await page.locator('.prts-rhine-overlay').count(),0);
assert.equal(await page.locator('[data-rhine-resource]').count(),0);
assert.deepEqual(errors,[]);
await writeFile(join(output,'results.json'),JSON.stringify({passed:true,rendering:noWebGL?'Explicit no-WebGL reader fallback':'Fixed performance quality; system reduced-motion preference; renderer paused during DOM-only checks',checks:['saved ultra settings ignored and quality controls removed','blank-session automatic archive activation','blank-to-active host slot transition retains one workbench','no demonstration documents','direct Agent submission','eight-slot rack and exact selection/pagination','actual visible answer report','separate found/read states','real React host lifecycle','live cloud tool states','version-bound actual corpus reader','no reader/camera disruption','excerpt prompt source/version/line citations','full tool receipts','load earlier host history','queryless directory and opaque pagination','session isolation','inactive renderer pause','close/reopen/dispose'],errors},null,2));
console.log('HOST INTEGRATION PASS',output);
} catch(error) {
  console.error('BROWSER FAILURE',output,await page?.evaluate(()=>({summary:document.querySelector('.rhine-result-summary')?.textContent,stats:window.hostWorkbench?.stats(),text:document.body.innerText.slice(-1200)})).catch(()=>null));
  await page?.screenshot({path:join(output,'failure.png'),timeout:30000}).catch(()=>{});
  throw error;
} finally { await page?.unrouteAll({behavior:'wait'}); await browser.close(); }
