import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {chromium} from '/home/cloudstack/ai-data/prts.chat/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs';
const dir=new URL('.',import.meta.url),url='http://127.0.0.1:4177/';
const all=JSON.parse(await readFile(new URL('../rhine-array-body/sources.json',dir),'utf8'));
const fixture={...all,sources:all.sources.slice(0,2)};
const report={errors:[],checks:[],layouts:[]};
const browser=await chromium.launch({headless:true,executablePath:'/home/cloudstack/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',args:['--no-sandbox','--disable-dev-shm-usage','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});page.setDefaultTimeout(180000);
 page.on('pageerror',e=>report.errors.push(e.message));page.on('console',e=>{if(e.type()==='error')report.errors.push(e.text().slice(0,1800));});
 await page.route(url,async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replace(/const snapshot=\{[^\n]*?\};/,`const snapshot=window.__fixture=${JSON.stringify(fixture)};`)});});
 await page.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){if(type==='webgl'||type==='webgl2'||type==='experimental-webgl')return null;return original.call(this,type,...args);};});
 await page.goto(url,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.rhineWorkbench?.stats().resultCount>0,null,{polling:100});
 await page.locator('.rhine-nav-rack').click();await page.locator('.rhine-shelf-open').click();
 await page.waitForFunction(()=>document.querySelectorAll('.rhine-reader-line').length>0,null,{polling:100});
 for(const size of [{width:2560,height:1264},{width:1440,height:900},{width:900,height:600},{width:390,height:844},{width:844,height:390}]){
  await page.setViewportSize(size);
  await page.waitForFunction(()=>{const root=document.querySelector('.rhine-workbench'),stage=document.querySelector('.rhine-original-stage'),r=stage.getBoundingClientRect();return Math.abs(r.width-root.clientWidth)<2&&Math.abs(r.height-root.clientHeight)<2;},null,{polling:100,timeout:10000});
  const layout=await page.evaluate(()=>{
   const stage=document.querySelector('.rhine-original-stage'),panel=document.querySelector('.rhine-reader'),body=document.querySelector('.rhine-reader-body'),text=document.querySelector('.rhine-line-text'),actions=document.querySelector('.rhine-reader-actions');
   const scale=parseFloat(stage.style.getPropertyValue('--stage-scale')),r=panel.getBoundingClientRect(),b=body.getBoundingClientRect();
   return {rootSize:[document.querySelector('.rhine-workbench').clientWidth,document.querySelector('.rhine-workbench').clientHeight],appSize:[document.querySelector('#app').clientWidth,document.querySelector('#app').clientHeight],width:innerWidth,height:innerHeight,kind:stage.dataset.layout,scale,font:parseFloat(getComputedStyle(text).fontSize),visibleFont:parseFloat(getComputedStyle(text).fontSize)*scale,panel:{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom},body:{height:b.height,width:b.width,scrollWidth:body.scrollWidth,clientWidth:body.clientWidth},actions:[...actions.children].map(e=>{const a=e.getBoundingClientRect();return{x:a.x,y:a.y,right:a.right,bottom:a.bottom};})};
  });
  report.layouts.push(layout);console.log(JSON.stringify(layout));assert(layout.visibleFont>=15.9,JSON.stringify(layout));assert(layout.panel.x>=0&&layout.panel.right<=size.width+1&&layout.panel.bottom<=size.height+1,JSON.stringify(layout));assert(layout.body.height>=60,JSON.stringify(layout));assert(layout.body.scrollWidth<=layout.body.clientWidth+1,'reader must wrap long source lines');
 }
 await page.screenshot({path:new URL('layout-small-landscape.png',dir).pathname});
 await page.evaluate(()=>window.rhineWorkbench.dispose());
}catch(e){report.failure=String(e.stack||e);throw e;}finally{await writeFile(new URL('layouts.json',dir),JSON.stringify(report,null,2));await browser.close();}
