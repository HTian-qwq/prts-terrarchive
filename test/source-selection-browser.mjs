import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join,extname,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createInvestigationStore} from '../src/investigation-store.js';
import {buildApi} from '../src/ui.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const out=resolve(process.env.PRTS_SELECTION_QA_OUTPUT || join(root,'work/source-selection-20260919'));await mkdir(out,{recursive:true});
const host=resolve(root,'../prts-terrarchive-portable/.build/dsh-electron');
const {DomainFacility}=await import(pathToFileURL(join(host,'packages/storage/storage-domain/lib/index.js')));
const {JsonStorageBackend}=await import(pathToFileURL(join(host,'packages/storage/storage-json/lib/index.js')));
const backend=new JsonStorageBackend(join(out,`storage-${Date.now()}`));
const facility=new DomainFacility({storage:{backend:{get:()=>backend}},emit(){},logger:console},{backend:'json'});
const api=buildApi({investigations:createInvestigationStore(facility),effective:()=>({enabledGames:['arknights']})});
const titles=['阿米娅 / 干员档案 · 基础信息与信赖记录','怒号光明 · JT8-2 · 睁眼，便是日暮 · 行动前','卡兹戴尔与乌萨斯之间的历史记录和未完成的调查','莱茵生命研究项目 · 关键事件时间线','科西切 / 角色补充 Wiki：人物身份与剧情高光'];
const sources=Array.from({length:167},(_,i)=>({id:`qa-${i+1}`,title:i===130?'远端档案 · 跨架定位测试':`${titles[i%5]} · 资料 ${i+1}`,kind:['character_profile','story','entity_profile','timeline','reviewed_wiki'][i%5],origin:i%5===4?'cloud':'local',state:['found','read','cited'][i%3],documentId:`qa-doc-${i+1}`,dataVersion:'qa',excerpt:'这是用于界面验证的示例资料：保留完整标题、阅读状态和资料定位。内容不作为剧情结论。'}));
const snapshot={sessionId:'qa-source-selection',running:false,searching:false,query:'',tool:'',sources,answer:'',records:[]};
const html=`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/rhine/rhine.css"><style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden;background:#eeece4}</style><div id="app"></div><script src="/rhine/rhine.js"></script><script>window.fixture=${JSON.stringify(snapshot)};window.rhineWorkbench=__PRTS_RHINE__.mountRhineWorkbench(document.querySelector('#app'),{assetBase:'/rhine/',snapshot:window.fixture,agentAvailable:false,api:async(endpoint,payload,signal)=>{const r=await fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint,payload}),signal});return r.json()},askAgent:async()=>{},close:()=>{}})</script>`;
let reads=0;
const server=createServer(async(req,res)=>{try{
 if(req.url==='/'){res.setHeader('content-type','text/html;charset=utf-8');return res.end(html)}
 if(req.url.startsWith('/rhine/')){const path=resolve(root,'lib/rhine',decodeURIComponent(req.url.slice(7)));assert(!relative(join(root,'lib/rhine'),path).startsWith('..'));res.setHeader('content-type',({'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.glb':'model/gltf-binary','.webp':'image/webp'})[extname(path)]||'application/octet-stream');return res.end(await readFile(path))}
 if(req.url==='/rpc'){let input='';for await(const chunk of req)input+=chunk;const {endpoint,payload}=JSON.parse(input);res.setHeader('content-type','application/json');if(endpoint==='archive.search')return res.end(JSON.stringify({sources,data_version:'qa'}));if(endpoint==='read'){reads++;return res.end(JSON.stringify({data_version:'qa',content:{lines:[{line_number:1,text:'# 资料阅读验证'},{line_number:2,text:'点击标题仅定位；抽取阅读才打开原文。'}]},page:{has_more:false}}))}const r=await api.call('POST','/api/prts-corpus/'+endpoint.replace('.','/'),payload);res.statusCode=r.status;return res.end(JSON.stringify(r.json))}
 res.statusCode=404;res.end();
}catch(e){res.statusCode=500;res.end(JSON.stringify({error:e.message}))}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const require=createRequire(join(root,'../.tools/rhine-qa/package.json'));const{chromium}=require('playwright');
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1600,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(20000);
const geometry=[];const errors=[];page.on('pageerror',e=>errors.push(e.message));
const shot=async name=>page.screenshot({path:join(out,`${name}.jpg`),type:'jpeg',quality:82});
const waitSelection=async(id,place)=>page.waitForFunction(({id,place})=>window.rhineWorkbench.stats()[place]==id,{id,place});
try{
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.waitForFunction(()=>window.rhineWorkbench?.stats().heroLoaded&&window.rhineWorkbench?.stats().sourceCount===167);
 await page.waitForTimeout(1800);
 const array=page.locator('.archive-navigation'),toggle=page.locator('.rhine-array-toggle');
 assert.equal(await array.isVisible(),false);assert.equal(await array.evaluate(n=>n.inert),true);assert.equal(await toggle.getAttribute('aria-expanded'),'false');
 await shot('array-closed-desktop');
 await toggle.click();await array.waitFor({state:'visible'});assert.equal(await array.evaluate(n=>n.inert),false);
 const style=await array.evaluate(n=>({background:getComputedStyle(n).backgroundImage,color:getComputedStyle(n).backgroundColor}));
 assert.deepEqual(style,{background:'none',color:'rgba(0, 0, 0, 0)'});
 assert.equal(await page.locator('#file-ticks strong').count(),8);
 await page.locator('#file-ticks [data-source-id="qa-6"]').click();await waitSelection('qa-6','archiveSourceId');assert.equal(reads,0);
 await page.waitForTimeout(450); // Respect the existing 350 ms physical navigation budget.
 await page.getByRole('button',{name:'下一页档案',exact:true}).click();await waitSelection('qa-41','archiveSourceId');
 assert.equal(await page.locator('#file-ticks [data-source-id="qa-41"]').count(),1);assert.equal(reads,0);
 await page.waitForTimeout(450);
 await page.getByRole('button',{name:'上一页档案',exact:true}).click();await waitSelection('qa-1','archiveSourceId');
 await page.waitForTimeout(450);
 await page.locator('#file-ticks [data-source-id="qa-6"]').focus();await page.keyboard.press('Enter');await waitSelection('qa-6','archiveSourceId');assert.equal(reads,0);
 await page.waitForTimeout(450);
 await page.keyboard.press('ArrowDown');await waitSelection('qa-11','archiveSourceId');assert.equal(await page.locator('#file-ticks :focus').getAttribute('data-source-id'),'qa-11');
 await shot('array-desktop');
 assert.equal(await page.locator('#file-ticks .selected').evaluate(n=>getComputedStyle(n).backgroundImage),'none');
 await page.locator('.rhine-array-directory').click();await page.locator('.rhine-results').waitFor({state:'visible'});
 await page.keyboard.press('Escape');await page.locator('.rhine-results').waitFor({state:'hidden'});assert.equal(await array.isVisible(),true);
 await page.keyboard.press('Escape');await array.waitFor({state:'hidden'});assert.equal(await toggle.evaluate(n=>n===document.activeElement),true);
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().archiveSourceId),'qa-11');
 await toggle.click();assert.equal(await page.locator('#file-ticks .selected').getAttribute('data-source-id'),'qa-11');
 await page.locator('.rhine-array-collapse').click();await array.waitFor({state:'hidden'});await toggle.click();
 await page.locator('[data-zone="desk"]').click();await page.waitForTimeout(1600);
 assert.equal(await page.locator('.rhine-desk-list strong').count(),24);
 await page.locator('.rhine-desk-item[data-source-id="qa-4"]').click();await waitSelection('qa-4','shelfSelected');assert.equal(reads,0);
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().focusedId),'qa-4');
 await shot('shelf-desktop');
 const filter=page.locator('.rhine-shelf-filter');await filter.fill('远端档案');
 assert.equal(await page.locator('.rhine-desk-item').count(),1);
 await page.locator('.rhine-desk-item').click();await waitSelection('qa-131','focusedId');
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().deskPage),5);assert.equal(reads,0);
 await shot('shelf-filter');
 await page.locator('.rhine-shelf-open').click();await page.locator('.rhine-reader-body h1').waitFor();assert.equal(reads,1);
 await page.keyboard.press('Escape');await page.locator('.rhine-reader').waitFor({state:'hidden'});
 assert.equal(await filter.inputValue(),'远端档案');
 await filter.fill('没有这份档案');assert.match(await page.locator('.rhine-desk-list').innerText(),/没有匹配/);
 await page.locator('.rhine-shelf-clear').click();assert.equal(await page.locator('.rhine-desk-item').count(),24);
 // Keyboard focus on a different item selects it; a second Enter reads it.
 await page.locator('.rhine-desk-item[data-source-id="qa-122"]').focus();await page.keyboard.press('Enter');await waitSelection('qa-122','focusedId');assert.equal(reads,1);
 await page.keyboard.press('ArrowDown');await waitSelection('qa-123','focusedId');assert.equal(await page.locator('.rhine-desk-list :focus').getAttribute('data-source-id'),'qa-123');
 await page.keyboard.press('Enter');await page.locator('.rhine-reader-body h1').waitFor();assert.equal(reads,2);
 await page.keyboard.press('Escape');await page.locator('.rhine-reader').waitFor({state:'hidden'});
 await page.getByRole('button',{name:'下一架资料',exact:true}).click();assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().deskPage),6);
 assert.equal(await page.locator('.rhine-desk-item').count(),23);
 await filter.fill('资料 16');await page.evaluate(()=>{document.body.tabIndex=-1;document.body.focus()});await page.keyboard.press('ArrowUp');await waitSelection('qa-167','focusedId');assert.equal(reads,2);
 await page.locator('.rhine-shelf-clear').click();
 await page.locator('.rhine-rack-directory').click();await page.locator('.rhine-rack-filter').fill('远端档案');assert.equal(await page.locator('.rhine-rack-index-item').count(),1);await shot('rack-index');
 await page.keyboard.press('Escape');await page.locator('.rhine-rack-index').waitFor({state:'hidden'});
 await page.locator('.rhine-nav-index').click();await page.locator('.rhine-results').waitFor();await shot('index-desktop');
 await page.keyboard.press('Escape');
 for(const [name,width,height]of[['compact',1000,760],['portrait',430,900]]){
  await page.setViewportSize({width,height});await page.waitForTimeout(500);await shot(`shelf-${name}`);
  const bounds=await page.evaluate(()=>{const r=s=>{const b=document.querySelector(s).getBoundingClientRect();return{top:b.top,bottom:b.bottom,height:b.height}};return{list:r('.rhine-desk-list'),panel:r('.rhine-desk-panel'),nav:r('.rhine-zone-nav')}});
  geometry.push({name,...bounds});assert(bounds.list.height>150,`${name}: list too short ${bounds.list.height}`);assert(bounds.panel.bottom<=bounds.nav.top,`${name}: shelf overlaps navigation`);
  await page.locator('[data-zone="archive"]').click();await page.waitForTimeout(900);assert.equal(await array.isVisible(),false);await shot(`array-closed-${name}`);
  await toggle.click();await shot(`array-${name}`);
  if(name==='portrait'){const b=await page.evaluate(()=>({brief:document.querySelector('.rhine-investigation-brief').getBoundingClientRect().bottom,list:document.querySelector('.archive-navigation').getBoundingClientRect().top}));assert(b.brief<=b.list,'portrait array overlaps investigation');}
  await page.locator('.rhine-array-directory').click();await shot(`index-${name}`);await page.keyboard.press('Escape');
  await page.locator('[data-zone="desk"]').click();await page.waitForTimeout(900);
 }
 // An interrupted close cannot later hide a reopened list; reduced motion finishes immediately.
 await page.setViewportSize({width:1600,height:1000});await page.locator('[data-zone="archive"]').click();await page.waitForTimeout(900);
 await page.emulateMedia({reducedMotion:'no-preference'});await toggle.click();
 await page.locator('.rhine-array-collapse').click();assert.equal(await array.evaluate(n=>n.inert),true);
 await toggle.click();await page.waitForTimeout(300);assert.equal(await array.isVisible(),true);assert.equal(await array.evaluate(n=>n.inert),false);
 await page.keyboard.press('Escape');await page.emulateMedia({reducedMotion:'reduce'});await array.waitFor({state:'hidden'});
 assert.equal(await toggle.getAttribute('aria-expanded'),'false');
 await writeFile(join(out,'results.json'),JSON.stringify({ok:true,reads,errors,geometry,stats:await page.evaluate(()=>window.rhineWorkbench.stats())},null,2));assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,reads,errors,output:out}));
}catch(e){await shot('failure');await writeFile(join(out,'failure.txt'),await page.locator('body').innerText());throw e}
finally{await browser.close();await new Promise(resolve=>server.close(resolve));await facility.dispose?.()}