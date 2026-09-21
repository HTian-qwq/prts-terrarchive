import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join,extname,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import { rhineHost, chromium, rhineBrowserOptions } from './helpers/rhine-browser-env.mjs';
import {createInvestigationStore} from '../src/investigation-store.js';
import {buildApi} from '../src/ui.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const out=resolve(process.env.PRTS_INTERACTION_QA_OUTPUT || join(root,'work/interaction-flow-20260920'));await mkdir(out,{recursive:true});
const host=rhineHost;
const {DomainFacility}=await import(pathToFileURL(join(host,'packages/storage/storage-domain/lib/index.js')));
const {JsonStorageBackend}=await import(pathToFileURL(join(host,'packages/storage/storage-json/lib/index.js')));
const backend=new JsonStorageBackend(join(out,`storage-${Date.now()}`));
const facility=new DomainFacility({storage:{backend:{get:()=>backend}},emit(){},logger:console},{backend:'json'});
const service=createInvestigationStore(facility);
const api=buildApi({investigations:service,effective:()=>({enabledGames:['arknights']})});
const titles=['阿米娅 / 干员档案 · 基础信息与信赖记录','怒号光明 · JT8-2 · 睁眼，便是日暮 · 行动前','卡兹戴尔与乌萨斯之间的历史记录和未完成的调查','莱茵生命研究项目 · 关键事件时间线','科西切 / 角色补充 Wiki：人物身份与剧情高光'];
const sources=Array.from({length:167},(_,i)=>({id:`qa-${i+1}`,title:i===130?'远端档案 · 跨架定位测试':`${titles[i%5]} · 资料 ${i+1}`,kind:['character_profile','story','entity_profile','timeline','reviewed_wiki'][i%5],origin:i===6||i%5===4?'cloud':'local',state:i===1?'read':i===2?'cited':'found',saved:i===3,documentId:`qa-doc-${i+1}`,dataVersion:'qa',excerpt:'这是用于界面验证的示例资料：保留完整标题、阅读状态和资料定位。内容不作为剧情结论。'}));
const snapshot={sessionId:'qa-source-selection',running:false,searching:false,query:'',tool:'',sources,answer:'',records:[]};
const session=snapshot.sessionId;
const boardA=await service.createUserBoard(session,{mutation_id:'create-a',title:'手动整理板 A'});
const boardB=await service.open(session,{mode:'new',title:'Agent 工作板 B',objective:'交互回归验证',reason:'测试'},{callId:'open-b',turnId:1});
await service.editInbox(session,{mutation_id:'seed-a',board_id:boardA.board_id,expected_inbox_revision:0,action:'add',source_id:sources[4].id,sources:[sources[4]]});
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
const page=await browser.newPage({viewport:{width:1600,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(20000);
const geometry=[];const errors=[];page.on('pageerror',e=>errors.push(e.message));
const shot=async name=>page.screenshot({path:join(out,`${name}.jpg`),type:'jpeg',quality:82});
const waitSelection=async(id,place)=>page.waitForFunction(({id,place})=>window.rhineWorkbench.stats()[place]==id,{id,place});
try{
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.waitForFunction(()=>window.rhineWorkbench?.stats().heroLoaded&&window.rhineWorkbench.stats().investigations.boards===2);
 await page.waitForTimeout(1600);
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().sourceCount),2,'only read and saved sources enter shelf');
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().candidateCount),167);
 // Browsing A must not redirect automatic staging away from working B.
 await page.locator('[data-zone="board"]').click();await page.waitForTimeout(1600);
 await page.locator('.rhine-investigation-picker').selectOption(boardA.board_id);
 await page.waitForFunction(id=>window.rhineWorkbench.stats().investigations.selectedId===id,boardA.board_id);
 await page.locator('[data-zone="archive"]').click();await page.waitForTimeout(1200);
 const target=page.locator('.rhine-current-source .rhine-evidence-target select');
 assert.match(await target.locator('option:checked').innerText(),/工作板 B/);
 await page.locator('.rhine-array-stage').click();
 await page.waitForFunction(()=>document.querySelector('.rhine-toast').textContent.includes('Agent 工作板 B'));
 assert.equal((await service.read(session,{board_id:boardB.board_id})).board.evidenceInbox.length,1);
 assert.equal((await service.read(session,{board_id:boardA.board_id})).board.evidenceInbox.length,1);
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().sourceCount),2,'inbox is independent from shelf');
 await target.selectOption(boardA.board_id);
 await page.locator('.rhine-array-stage').click();
 await page.waitForFunction(()=>document.querySelector('.rhine-toast').textContent.includes('手动整理板 A'));
 assert.equal((await service.read(session,{board_id:boardA.board_id})).board.evidenceInbox.length,2);
 // A source opened from a scrolled, filtered search returns to that same result and focus.
 await page.locator('.rhine-nav-index').click();await page.locator('.rhine-results').waitFor();
 await page.locator('.category-filters').getByRole('button',{name:'剧情记录',exact:true}).click();
 await page.locator('.rhine-result-pagination').getByRole('button',{name:'下一页',exact:true}).click();
 const result=page.locator('.rhine-result-open').last();
 await result.focus();await result.scrollIntoViewIfNeeded();
 const before=await page.evaluate(()=>({scroll:document.querySelector('.rhine-result-list').scrollTop,title:document.querySelector('.rhine-result-open:last-of-type')?.textContent,page:document.querySelector('.rhine-result-pagination').textContent}));
 const resultId=await result.getAttribute('data-source-id');
 await result.click();await page.locator('.rhine-reader-body h1').waitFor();
 assert.match(await page.locator('.rhine-reader-back-report').innerText(),/返回搜索结果/);
 await page.locator('[data-action="back"]').click();await page.locator('.rhine-results').waitFor();await page.waitForTimeout(100);
 assert.equal(await page.locator('.category-filters .active').innerText(),'剧情记录');
 assert.equal(await page.locator('.rhine-result-pagination').textContent(),before.page);
 assert.equal(await page.evaluate(()=>document.querySelector('.rhine-result-list').scrollTop),before.scroll);
 assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('data-source-id')),resultId);
 await page.locator(`.rhine-result-open[data-source-id="${resultId}"]`).click();await page.locator('.rhine-reader-body h1').waitFor();
 await page.keyboard.press('Escape');await page.locator('.rhine-results').waitFor();
 // Cloud story is in the story category, with cloud retained as provenance.
 await page.locator('.rhine-result-pagination').getByRole('button',{name:'上一页',exact:true}).click();
 assert.equal(await page.locator('.rhine-result-open[data-source-id="qa-7"]').count(),1);
 assert.match(await page.locator('.rhine-result-item').filter({has:page.locator('[data-source-id="qa-7"]')}).innerText(),/云端/);
 await page.keyboard.press('Escape');
 // Manual selection survives new calls, another turn, and the old four-second grace period.
 await page.locator('.rhine-array-toggle').click();
 await page.locator('[data-action="column-prev"]').click();await page.waitForTimeout(450);
 await page.locator('#file-ticks [data-source-id="qa-6"]').click();await waitSelection('qa-6','archiveSourceId');
 await page.evaluate(()=>{
   window.fixture={...window.fixture,running:true,investigationId:'turn-2',question:'测试后台查阅',operations:[{id:'read-1',tool:'corpus_read',kind:'read',state:'complete',sourceIds:['qa-11']}],sources:window.fixture.sources.map(s=>s.id==='qa-11'?{...s,state:'read',agentRead:true}:s)};
   window.rhineWorkbench.update(window.fixture);
 });
 await page.waitForTimeout(4600);
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().followAgent),false);
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().displayedSourceId),'qa-6');
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().archiveSourceId),'qa-6');
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().sourceCount),3);
 assert.equal(await page.locator('#file-ticks [data-source-id="qa-11"] .rhine-choice-number').innerText(),'011','reading must not renumber the candidate');
 await page.evaluate(()=>{
   window.fixture={...window.fixture,investigationId:'turn-3',operations:[{id:'read-2',tool:'corpus_read',kind:'read',state:'active',sourceIds:['qa-16']},{id:'read-3',tool:'corpus_read',kind:'read',state:'active',sourceIds:['qa-21']}]};
   window.rhineWorkbench.update(window.fixture);
 });
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().displayedSourceId),'qa-6');
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().unseenReads),3);
 await shot('manual-with-background-reads');
 await page.locator('.rhine-follow-toggle').click();
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().followAgent),true);
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().displayedSourceId),'qa-21');
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().unseenReads),0);
 // Open A's evidence, then let the Agent create C while reading. Return still belongs to A.
 await page.locator('[data-zone="board"]').click();await page.waitForTimeout(1800);
 await page.locator('.rhine-inbox-entry').click();await page.locator('.rhine-inbox-panel').waitFor();
 await page.locator('.rhine-inbox-read').click();await page.locator('.rhine-reader-body h1').waitFor();
 const boardC=await service.open(session,{mode:'new',title:'Agent 新工作板 C',objective:'下一项调查',reason:'回归验证'},{callId:'open-c',turnId:2});
 await page.waitForFunction(id=>window.rhineWorkbench.stats().investigations.workingId===id,boardC.board_id);
 await page.locator('.rhine-reader-back-report').click();await page.locator('.rhine-inbox-panel').waitFor();
 assert.match(await page.locator('.rhine-inbox-subtitle').innerText(),/手动整理板 A/);
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().investigations.selectedId),boardA.board_id);
 await page.keyboard.press('Escape');await page.locator('[data-zone="archive"]').click();await page.waitForTimeout(1200);
 assert.equal(await target.inputValue(),boardA.board_id,'explicit destination remains independent from new working board');
 await shot('explicit-board-destination');
 // A session switch invalidates the old reading return and clears manual follow state.
 await page.locator('.rhine-nav-index').click();await page.locator('.rhine-result-open').first().click();await page.locator('.rhine-reader').waitFor();
 await page.evaluate(()=>window.rhineWorkbench.update({...window.fixture,sessionId:'new-session',sources:[],operations:[],running:false}));
 await page.waitForFunction(()=>window.rhineWorkbench.stats().investigations.boards===0);
 assert.equal(await page.locator('.rhine-reader').isVisible(),false);
 assert.equal(await page.locator('.rhine-results').isVisible(),false);
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().followAgent),true);
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().unseenReads),0);
 assert.deepEqual(errors,[]);
 await writeFile(join(out,'results.json'),JSON.stringify({ok:true,reads,errors,boardA:boardA.board_id,boardB:boardB.board_id,boardC:boardC.board_id},null,2));
 console.log(JSON.stringify({ok:true,reads,errors,output:out}));
}catch(e){await shot('failure');await writeFile(join(out,'failure.txt'),await page.locator('body').innerText());throw e}
finally{await browser.close();await new Promise(resolve=>server.close(resolve));await service.close();await facility.dispose?.()}
