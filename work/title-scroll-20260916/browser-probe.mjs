import assert from 'node:assert/strict';
import { chromium } from '/home/cloudstack/ai-data/prts.chat/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
import { writeFile } from 'node:fs/promises';
const output = new URL('./', import.meta.url).pathname;
const url = 'http://127.0.0.1:4177';
const report = { errors: [], checks: [] };
const browser = await chromium.launch({headless:true, executablePath:'/home/cloudstack/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', args:['--no-sandbox','--disable-dev-shm-usage']});
try {
 const page = await browser.newPage({viewport:{width:1743,height:939},reducedMotion:'no-preference'});
 page.setDefaultTimeout(15000);
 page.on('pageerror', error => report.errors.push(error.message));
 const response = await page.request.post(url+'/rpc', {data:{endpoint:'archive.search',payload:{query:'阿米娅'}}});
 assert(response.ok());
 const data = await response.json();
 const source = data.sources.find(item=>item.title==='阿米娅 / 模组文案') || data.sources.find(item=>item.kind==='character_module');
 assert(source, 'Real Amiya module source is available');
 const snapshot = {sessionId:'title-scroll-isolated-preview',running:false,searching:false,query:'',tool:'',sources:[source],answer:'# 调查报告\n\n用于验证标题滚动及报告入口的本地预览。',records:[],question:'你能从原文考据有哪些原文梗吗',outcome:'completed',investigationId:'title-scroll-check'};
 // Exercise the actual UI against one real source, without changing a DSH session.
 await page.route(url+'/',async route=>{
  const response=await route.fetch();
  await route.fulfill({response,body:(await response.text()).replace(/const snapshot=\{[^\n]*?\};/,`const snapshot=${JSON.stringify(snapshot)};window.titleTestSnapshot=snapshot;`)});
 });
 await page.route(url+'/rpc',async route=>{
  if(route.request().postDataJSON().endpoint==='archive.search')return route.fulfill({json:{...data,sources:[source],page:{has_more:false}}});
  await route.continue();
 });
 // Isolate DOM animation from the CPU cost of software-rendering the 3D scene.
 await page.addInitScript(()=>{
  const get=HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext=function(type,...args){return /^webgl/.test(type)?null:get.call(this,type,...args)};
 });
 await page.goto(url+'/');
 await page.waitForFunction(()=>window.rhineWorkbench&&!window.rhineWorkbench.stats().searchBusy);
 await page.evaluate(()=>document.fonts.ready);
 const selectors = ['.rhine-report-open strong','#selected-title'];
 const titles = page.locator(selectors.join(','));
 await page.waitForFunction(()=>[...document.querySelectorAll('.rhine-loop-title.is-scrolling .rhine-loop-title-track')].length===2);
 const sample = () => page.evaluate(selectors=>selectors.map(selector=>{
  const root=document.querySelector(selector),track=root.querySelector('.rhine-loop-title-track'),animation=track.getAnimations()[0];
  return {title:root.title,x:new DOMMatrixReadOnly(getComputedStyle(track).transform).m41,time:animation.currentTime,duration:animation.effect.getComputedTiming().duration,iterations:animation.effect.getComputedTiming().iterations,width:root.getBoundingClientRect().width};
 }),selectors);
 const before=await sample();
 await page.waitForTimeout(650);
 const after=await sample();
 for(let i=0;i<2;i++){
  assert(after[i].time>before[i].time+300);
  assert(after[i].x<before[i].x-3,'Title continues moving left');
  assert.equal(after[i].iterations,Infinity);
 }
 report.motion={before,after}; report.checks.push('Both titles continuously move left without hovering');
 await page.evaluate(()=>{
  window.titleTracks=[...document.querySelectorAll('.rhine-loop-title-track')];
  for(let i=0;i<20;i++)window.rhineWorkbench.update({...window.titleTestSnapshot});
 });
 assert(await page.evaluate(()=>window.titleTracks.every(node=>node.isConnected)));
 report.checks.push('Repeated snapshots preserve the running tracks');
 report.seams=await page.evaluate(selectors=>selectors.map(selector=>{
  const root=document.querySelector(selector),track=root.querySelector('.rhine-loop-title-track'),animation=track.getAnimations()[0];
  const duration=animation.effect.getComputedTiming().duration;
  animation.pause();animation.currentTime=0;
  const start=track.children[0].getBoundingClientRect().x;
  animation.currentTime=duration-0.01;
  const end=track.children[1].getBoundingClientRect().x;
  animation.currentTime=duration+0.01;
  const next=track.children[0].getBoundingClientRect().x;
  animation.play();
  return {selector,start,end,next,error:Math.max(Math.abs(start-end),Math.abs(start-next))};
 }),selectors);
 assert(report.seams.every(item=>item.error<0.05));
 report.checks.push('Equal text positions immediately before and after the loop seam');
 report.accessibleNames={source:(await page.locator('.file-title').ariaSnapshot()).split('\n')[0],report:(await page.locator('.rhine-report-open').ariaSnapshot()).split('\n')[0]};
 assert.equal(report.accessibleNames.source.split(source.title).length-1,1);
 assert.equal(report.accessibleNames.report.split('阅读调查报告').length-1,1);
 report.checks.push('Each button exposes its title once to assistive technology');
 await page.screenshot({path:output+'desktop.png'});
 await page.locator('.rhine-report-open').click();
 await page.waitForFunction(()=>window.rhineWorkbench.stats().reportOpen);
 assert.match(await page.locator('.rhine-report-body').innerText(),/用于验证标题滚动/);
 await page.locator('.rhine-close-report').click();
 await page.waitForFunction(()=>!window.rhineWorkbench.stats().reportOpen);
 await page.locator('.file-title').click();
 await page.waitForFunction(()=>window.rhineWorkbench.stats().readerOpen);
 await page.waitForFunction(()=>document.querySelectorAll('.rhine-reader-line').length>0);
 await page.locator('.rhine-close-reader').click();
 await page.waitForFunction(()=>!window.rhineWorkbench.stats().readerOpen);
 report.checks.push('Report and source title buttons still open readable content');
 await page.evaluate(()=>{
  window.titleTestSnapshot={...window.titleTestSnapshot,running:true,outcome:'running'};
  window.rhineWorkbench.update(window.titleTestSnapshot);
 });
 assert.equal(await page.locator('.rhine-report-open strong').getAttribute('title'),'阅读正在生成的回答');
 await page.evaluate(()=>{
  window.titleTestSnapshot={...window.titleTestSnapshot,running:false,outcome:'completed',sources:window.titleTestSnapshot.sources.map(source=>({...source,title:'阿米娅 / 模组文案 / 这是一份用于验证窄屏连续滚动及完整标题可访问性的超长资料标题 Archive Reference 2026'}))};
  window.rhineWorkbench.update(window.titleTestSnapshot);
 });
 await page.setViewportSize({width:390,height:844});
 await page.waitForTimeout(250);
 report.mobile=await page.evaluate(()=>{
  const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {x:r.x,right:r.right,width:r.width,height:r.height};};
  return {title:rect('#selected-title'),arrow:rect('.file-open'),button:rect('.file-title'),brief:rect('.rhine-investigation-brief'),viewport:innerWidth};
 });
 assert(report.mobile.title.right<=report.mobile.arrow.x+1);
 assert(report.mobile.arrow.right<=report.mobile.brief.right+1);
 assert(report.mobile.arrow.right<=report.mobile.viewport+1);
 assert(report.mobile.title.width>100);
 report.checks.push('Long source titles scroll within a narrow viewport with the arrow fixed outside');
 await page.screenshot({path:output+'mobile.png'});
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.waitForTimeout(100);
 report.reduced=await titles.evaluateAll(roots=>roots.map(root=>({title:root.title,visible:getComputedStyle(root.querySelector('.rhine-loop-title-label')).opacity,track:getComputedStyle(root.querySelector('.rhine-loop-title-track')).display,animations:root.querySelector('.rhine-loop-title-track').getAnimations().length,height:root.clientHeight,contentHeight:root.scrollHeight,whiteSpace:getComputedStyle(root.querySelector('.rhine-loop-title-label')).whiteSpace,overflow:getComputedStyle(root.querySelector('.rhine-loop-title-label')).textOverflow})));
 assert(report.reduced.every(item=>item.visible==='1'&&item.track==='none'&&item.animations===0&&item.height===item.contentHeight&&item.whiteSpace==='nowrap'&&item.overflow==='ellipsis'));
 report.checks.push('Reduced motion shows a static title with long text ellipsized, keeps its full accessible label, and disables the loop');
 await page.screenshot({path:output+'mobile-reduced-motion.png'});
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.waitForFunction(()=>[...document.querySelectorAll('.rhine-loop-title-track')].every(track=>track.getAnimations().length===1));
 report.checks.push('Changing the motion preference back resumes scrolling');
 await page.evaluate(()=>window.rhineWorkbench.dispose());
 assert.equal(await page.locator('.rhine-workbench').count(),0);
 assert.deepEqual(report.errors,[]);
 report.checks.push('Workbench disposes without JavaScript errors');
 report.ok=true;
} finally {
 await writeFile(output+'browser-report.json',JSON.stringify(report,(_key,value)=>value===Infinity?'infinite':value,2));
 await browser.close();
 console.log(JSON.stringify(report,(_key,value)=>value===Infinity?'infinite':value,2));
}
