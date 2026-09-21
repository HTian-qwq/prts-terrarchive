import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join,extname,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import { rhineHost, chromium, rhineBrowserOptions } from './helpers/rhine-browser-env.mjs';
import {createInvestigationStore} from '../src/investigation-store.js';
import {buildApi} from '../src/ui.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const out=resolve(process.env.PRTS_SCENE_NAV_QA_OUTPUT || join(root,'work/scene-navigation-20260921'));await mkdir(out,{recursive:true});
const host=rhineHost;
const {DomainFacility}=await import(pathToFileURL(join(host,'packages/storage/storage-domain/lib/index.js')));
const {JsonStorageBackend}=await import(pathToFileURL(join(host,'packages/storage/storage-json/lib/index.js')));
const backend=new JsonStorageBackend(join(out,`storage-${Date.now()}`));
const facility=new DomainFacility({storage:{backend:{get:()=>backend}},emit(){},logger:console},{backend:'json'});
const api=buildApi({investigations:createInvestigationStore(facility),effective:()=>({enabledGames:['arknights']})});
const titles=['阿米娅 / 干员档案 · 基础信息与信赖记录','怒号光明 · JT8-2 · 睁眼，便是日暮 · 行动前','卡兹戴尔与乌萨斯之间的历史记录和未完成的调查','莱茵生命研究项目 · 关键事件时间线','科西切 / 角色补充 Wiki：人物身份与剧情高光'];
const sources=Array.from({length:13},(_,i)=>({id:`qa-${i+1}`,title:`${titles[i%5]} · 资料 ${i+1}`,kind:['character_profile','story','entity_profile','timeline','reviewed_wiki'][i%5],origin:i%5===4?'cloud':'local',state:['found','read','cited'][i%3],saved:i%3!==1,documentId:`qa-doc-${i+1}`,dataVersion:'qa',excerpt:'这是用于界面验证的示例资料：保留完整标题、阅读状态和资料定位。内容不作为剧情结论。'}));
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
const browser=await chromium.launch(rhineBrowserOptions);
const page=await browser.newPage({viewport:{width:1600,height:1000},reducedMotion:'no-preference'});page.setDefaultTimeout(20000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const shot=async name=>page.screenshot({path:join(out,`${name}.jpg`),type:'jpeg',quality:82});

const settle=()=>page.waitForFunction(()=>!window.rhineWorkbench.stats().movingCamera);
const findTarget=async(target,region)=>{
  for(let y=region.top;y<=region.bottom;y+=region.step||50)for(let x=region.left;x<=region.right;x+=region.step||50){
    if(!await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.tagName==='CANVAS',{x,y}))continue;
    await page.mouse.move(x,y);await page.waitForTimeout(65);
    const actual=await page.evaluate(()=>document.querySelector('canvas[data-workspace-target]')?.dataset.workspaceTarget||null);
    if(actual===target)return{x,y};
  }
  throw new Error(`No ${target} model in region ${JSON.stringify(region)}`);
};
const clickTarget=async(target,region)=>{
  const point=await findTarget(target,region);
  await page.mouse.click(point.x,point.y);
  await page.waitForFunction(target=>window.rhineWorkbench.stats().location===target,target);
  const moving=await page.evaluate(()=>window.rhineWorkbench.stats().movingCamera);
  assert.equal(moving,true,'physical station uses camera travel');
  assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().readerOpen),false,'station click does not open a source');
  await settle();return point;
};
try{
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.waitForFunction(()=>window.rhineWorkbench?.stats().heroLoaded&&window.rhineWorkbench.stats().sourceCount===13);
 await page.waitForTimeout(1600);
 await page.locator('[data-zone="board"]').click();await settle();await page.waitForTimeout(300);
 await shot('board-before');
 // The upper shelf is mostly empty, just like the reported case. Its tray is clickable.
 const tray=await findTarget('desk',{left:1300,right:1550,top:585,bottom:805,step:45});
 assert.match(await page.locator('canvas[data-workspace-target]').getAttribute('title'),/档案架/);
 await page.mouse.move(tray.x,tray.y);await page.mouse.down();await page.mouse.move(tray.x+30,tray.y+8,{steps:5});await page.mouse.up();
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().location),'board','dragging a neighbour must not navigate');
 await page.mouse.move(60,250);await page.waitForTimeout(80);await page.mouse.click(60,250);
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().location),'board','empty background is not a navigation target');
 await clickTarget('desk',{left:1300,right:1550,top:585,bottom:805,step:45});
 await shot('shelf-after-model-click');
 // Returning by clicking the board follows the same physical navigation rule.
 await clickTarget('board',{left:600,right:1050,top:230,bottom:600,step:70});
 await shot('board-return');
 const array=await findTarget('archive',{left:350,right:1050,top:860,bottom:985,step:35});
 await page.mouse.click(array.x,array.y);await page.waitForFunction(()=>window.rhineWorkbench.stats().location==='archive');
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().movingCamera),true);
 await settle();assert.equal(reads,0,'switching station never reads a document');
 await shot('array-after-model-click');
 // Normal selection and reading within the chosen array retain their existing behaviour.
 await page.locator('.rhine-array-toggle').click();await page.locator('#file-ticks [data-source-id]').first().click();
 await page.locator('.read-file').click();await page.locator('.rhine-reader-body h1').waitFor();
 assert.equal(reads,1);await page.keyboard.press('Escape');await page.locator('.rhine-reader').waitFor({state:'hidden'});
 assert.deepEqual(errors,[]);
 await writeFile(join(out,'results.json'),JSON.stringify({ok:true,tray,array,reads,errors},null,2));
 console.log(JSON.stringify({ok:true,output:out,tray,array,errors}));
}catch(e){await shot('failure');await writeFile(join(out,'failure.txt'),await page.locator('body').innerText());throw e}
finally{await browser.close();await new Promise(resolve=>server.close(resolve));await facility.dispose?.()}
