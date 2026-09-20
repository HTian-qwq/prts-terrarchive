import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join,extname,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createInvestigationStore} from '../src/investigation-store.js';
import {buildApi} from '../src/ui.js';
import {CONFIG_DEFAULTS} from '../src/state.js';
import {CLOUD_CONTRACT_VERSION} from '../src/cloud.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const out=resolve(process.env.PRTS_MANUAL_SEARCH_QA_OUTPUT || join(root,'work/manual-search-20260920'));await mkdir(out,{recursive:true});
const host=resolve(root,'../prts-terrarchive-portable/.build/dsh-electron');
const {DomainFacility}=await import(pathToFileURL(join(host,'packages/storage/storage-domain/lib/index.js')));
const {JsonStorageBackend}=await import(pathToFileURL(join(host,'packages/storage/storage-json/lib/index.js')));
const backend=new JsonStorageBackend(join(out,`storage-${Date.now()}`));
const facility=new DomainFacility({storage:{backend:{get:()=>backend}},emit(){},logger:console},{backend:'json'});
const cloudCalls=[],localCalls=[];
const config={...CONFIG_DEFAULTS,cloudEnabled:true,cloudBaseUrl:'https://fixture.example',cloudToken:'qa-secret'};
const api=buildApi({investigations:createInvestigationStore(facility),effective:()=>config},{fetchImpl:async(url,init)=>{
 if(url.endsWith('/capabilities'))return Response.json({code:200,data:{contract_version:CLOUD_CONTRACT_VERSION}});
 const request=JSON.parse(init.body);cloudCalls.push(request);
 if(request.query==='慢请求')await new Promise(resolve=>setTimeout(resolve,800));
 if(request.query==='失败请求')return Response.json({detail:'检索服务暂时繁忙'},{status:429});
 return Response.json({code:200,data:{sources:request.query==='空结果'?[]:[{source_id:request.query,title:'云端 · '+request.query,source_type:'vector_original',content:'**返回片段**：这是来自云端检索接口的测试材料。'}]}});
}});
const titles=['阿米娅 / 干员档案 · 基础信息与信赖记录','怒号光明 · JT8-2 · 睁眼，便是日暮 · 行动前','卡兹戴尔与乌萨斯之间的历史记录和未完成的调查','莱茵生命研究项目 · 关键事件时间线','科西切 / 角色补充 Wiki：人物身份与剧情高光'];
const sources=Array.from({length:167},(_,i)=>({id:`qa-${i+1}`,title:i===130?'远端档案 · 跨架定位测试':`${titles[i%5]} · 资料 ${i+1}`,kind:['character_profile','story','entity_profile','timeline','reviewed_wiki'][i%5],origin:i%5===4?'cloud':'local',state:['found','read','cited'][i%3],documentId:`qa-doc-${i+1}`,dataVersion:'qa',excerpt:'这是用于界面验证的示例资料：保留完整标题、阅读状态和资料定位。内容不作为剧情结论。'}));
const snapshot={sessionId:'qa-source-selection',running:false,searching:false,query:'',tool:'',sources,answer:'',records:[]};
const html=`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/rhine/rhine.css"><style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden;background:#eeece4}</style><div id="app"></div><script src="/rhine/rhine.js"></script><script>window.fixture=${JSON.stringify(snapshot)};window.rhineWorkbench=__PRTS_RHINE__.mountRhineWorkbench(document.querySelector('#app'),{assetBase:'/rhine/',snapshot:window.fixture,agentAvailable:false,api:async(endpoint,payload,signal)=>{const r=await fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint,payload}),signal});return r.json()},askAgent:async()=>{},close:()=>{}})</script>`;
let reads=0;
const server=createServer(async(req,res)=>{try{
 if(req.url==='/'){res.setHeader('content-type','text/html;charset=utf-8');return res.end(html)}
 if(req.url.startsWith('/rhine/')){const path=resolve(root,'lib/rhine',decodeURIComponent(req.url.slice(7)));assert(!relative(join(root,'lib/rhine'),path).startsWith('..'));res.setHeader('content-type',({'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.glb':'model/gltf-binary','.webp':'image/webp'})[extname(path)]||'application/octet-stream');return res.end(await readFile(path))}
 if(req.url==='/rpc'){let input='';for await(const chunk of req)input+=chunk;const {endpoint,payload}=JSON.parse(input);res.setHeader('content-type','application/json');if(endpoint==='archive.search'){localCalls.push(payload);return res.end(JSON.stringify({sources:payload.after?sources.slice(12,15):sources.slice(0,12),data_version:'qa',page:payload.after?{has_more:false}:{has_more:true,next_after:{position:12}}}));}if(endpoint==='read'){reads++;return res.end(JSON.stringify({data_version:'qa',content:{lines:[{line_number:114,speaker_raw:'“不死的黑蛇”',text:'“不死的黑蛇”: 阿米娅，阿米娅。**完整台词**。'},{line_number:115,speaker_raw:'阿米娅',text:'阿米娅：博士。'},{line_number:116,speaker_raw:'A[1].*',text:'A[1].*: **测试**台词'},{line_number:117,speaker_raw:'阿米娅',text:'阿米娅，你还记得吗？'},{line_number:118,text:'旁白：阿米娅：博士。'}]},page:{has_more:false}}))}const r=await api.call(endpoint==='archive.options'?'GET':'POST','/api/prts-corpus/'+endpoint.replace('.','/'),payload);res.statusCode=r.status;return res.end(JSON.stringify(r.json))}
 res.statusCode=404;res.end();
}catch(e){res.statusCode=500;res.end(JSON.stringify({error:e.message}))}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const require=createRequire(join(root,'../.tools/rhine-qa/package.json'));const{chromium}=require('playwright');
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1600,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(20000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const shot=async name=>page.screenshot({path:join(out,`${name}.jpg`),type:'jpeg',quality:82});
try{
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.waitForFunction(()=>window.rhineWorkbench?.stats().heroLoaded);
 await page.locator('.rhine-nav-index').click();await page.locator('.rhine-results').waitFor();
 const query=page.locator('#rhine-query'),advanced=page.locator('.rhine-search-advanced'),submit=page.locator('.rhine-search-submit');
 await shot('local-default');
 await advanced.locator('summary').click();
 await page.locator('[name=games]').selectOption('arknights');
 await page.locator('[name=resource_types]').selectOption('original_story');
 await page.locator('[name=speakers]').fill('阿米娅');await query.fill('莱茵生命');
 await submit.click();await page.locator('.rhine-result-summary').filter({hasText:'已载入 12'}).waitFor();
 assert.deepEqual(localCalls.at(-1).speakers,['阿米娅']);assert.deepEqual(localCalls.at(-1).resource_types,['original_story']);
 await advanced.locator('summary').click();await query.fill('尚未提交的新输入');await page.locator('[name=speakers]').fill('凯尔希');
 await page.locator('.rhine-load-more').click();await page.locator('.rhine-result-summary').filter({hasText:'已载入 15'}).waitFor();
 assert.equal(localCalls.at(-1).query,'莱茵生命');assert.deepEqual(localCalls.at(-1).speakers,['阿米娅']);
 await shot('local-advanced');
 await page.locator('.rhine-result-open').first().click();await page.locator('#rhine-line-114').waitFor();
 assert.equal((await page.locator('#rhine-line-114').innerText()).split('“不死的黑蛇”').length-1,1);
 assert.equal((await page.locator('#rhine-line-115').innerText()).split('阿米娅').length-1,1);
 assert.equal((await page.locator('#rhine-line-116').innerText()).split('A[1].*').length-1,1);
 assert.match(await page.locator('#rhine-line-117 p').innerText(),/^阿米娅，你/);
 assert.match(await page.locator('#rhine-line-118').innerText(),/旁白：阿米娅：博士/);
 assert.equal(await page.locator('#rhine-line-114 strong').innerText(),'完整台词');await shot('speaker-single');
 await page.keyboard.press('Escape');await page.locator('.rhine-reader').waitFor({state:'hidden'});
 await page.locator('.rhine-nav-index').click();
 await page.locator('[data-search-mode=cloud]').click();assert.equal(cloudCalls.length,0);
 if(!await advanced.evaluate(n=>n.open))await advanced.locator('summary').click();
 await page.locator('.rhine-search-reset').click();await query.fill('黑蛇的台词');
 await page.locator('[name=depth]').selectOption('deep');await page.locator('[name=evidence_policy]').selectOption('original_only');
 await page.locator('[name=search_intent]').selectOption('quote_search');await page.locator('[name=validation]').selectOption('none');
 await page.locator('[name=final_limit]').fill('20');await page.locator('[name=speakers]').fill('不死的黑蛇');
 await page.locator('[name=query_variants]').fill('科西切 台词；塔露拉 黑蛇');
 await shot('cloud-advanced');await submit.click();
 await page.locator('.rhine-result-open strong').filter({hasText:'云端 · 黑蛇的台词'}).waitFor();
 assert.equal(cloudCalls.at(-1).depth,'deep');assert.equal(cloudCalls.at(-1).options.limits.final_limit,20);
 assert.deepEqual(cloudCalls.at(-1).options.query_variants,['科西切 台词','塔露拉 黑蛇']);
 assert.equal(await page.locator('.rhine-load-more').count(),0);
 await page.locator('.rhine-result-open').first().click();await page.locator('.rhine-excerpt-text strong').waitFor();
 assert.equal(await page.locator('.rhine-excerpt-text strong').innerText(),'返回片段');await page.keyboard.press('Escape');
 await page.locator('.rhine-nav-index').click();await query.fill('慢请求');await submit.click();
 await page.locator('.rhine-search-cancel').click();await page.locator('[data-search-mode=local]').click();
 await query.fill('本地新请求');await submit.click();await page.waitForTimeout(1000);
 assert.match(await page.locator('.rhine-result-summary').innerText(),/本地新请求/);assert.doesNotMatch(await page.locator('.rhine-result-list').innerText(),/云端 · 慢请求/);
 await page.locator('[data-search-mode=cloud]').click();await query.fill('失败请求');await submit.click();
 await page.locator('.rhine-result-summary').filter({hasText:'检索服务暂时繁忙'}).waitFor();
 await query.fill('空结果');await submit.click();await page.locator('.rhine-empty').filter({hasText:'没有找到匹配资料'}).waitFor();
 for(const [name,width,height]of[['desktop',1600,1000],['compact',1000,760],['portrait',430,900]]){
  await page.setViewportSize({width,height});await page.waitForTimeout(300);
  if(!await advanced.evaluate(n=>n.open))await advanced.locator('summary').click();
  await shot('cloud-'+name);
  const bounds=await page.locator('.rhine-result-list').boundingBox();console.log(JSON.stringify({viewport:name,resultsHeight:bounds.height}));assert(bounds.height>90,`${name} results unusable: ${bounds.height}`);
  assert.equal(await submit.isVisible(),true);assert(await submit.boundingBox());
 }
 assert.deepEqual(errors,[]);await writeFile(join(out,'results.json'),JSON.stringify({ok:true,errors,cloudCalls:cloudCalls.length,localCalls:localCalls.length,speakerDedup:true},null,2));
 console.log(JSON.stringify({ok:true,output:out,cloudCalls:cloudCalls.length,speakerDedup:true}));
}catch(e){await shot('failure');await writeFile(join(out,'failure.txt'),await page.locator('body').innerText());throw e}
finally{await browser.close();await new Promise(resolve=>server.close(resolve));await facility.dispose?.()}
