import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join, extname, relative } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createInvestigationStore } from '../src/investigation-store.js'
import { investigationDefinitions } from '../src/investigation-tools.js'
import { buildApi } from '../src/ui.js'

const root=fileURLToPath(new URL('../',import.meta.url))
const host=resolve(process.env.PRTS_DSH_SOURCE_DIR || join(root,'../prts-terrarchive-portable/.build/dsh-electron'))
const output=resolve(process.env.PRTS_INVESTIGATION_QA_OUTPUT || join(root,'work/evidence-inbox-20260919'))
await mkdir(output,{recursive:true})
const { DomainFacility }=await import(pathToFileURL(join(host,'packages/storage/storage-domain/lib/index.js')))
const { JsonStorageBackend }=await import(pathToFileURL(join(host,'packages/storage/storage-json/lib/index.js')))
const { assertSupportedJsonSchema,validateJsonSchemaValue }=await import(pathToFileURL(join(host,'packages/core/tools/lib/index.js')))
const backend=new JsonStorageBackend(join(output,`storage-${Date.now()}`))
const facility=new DomainFacility({storage:{backend:{get:()=>backend}},emit(){},logger:console},{backend:'json'})
const service=createInvestigationStore(facility)
for(const d of investigationDefinitions)assertSupportedJsonSchema(d.parameters)
const session='qa-investigation-demo'
const binding=await service.open(session,{mode:'new',title:'魏彦吾与炎国真龙 · 排版示例',objective:'仅用于验证 UI，示例不作为剧情结论',reason:'测试'}, {callId:'open',turnId:1})
await service.recordSources(session,[{id:'qa-web',title:'Markdown 原文验证',documentId:'qa-markdown',dataVersion:'qa-v1',ranges:[{start:45,end:46}],url:'https://example.com',origin:'cloud',state:'read',content:'这是一段用于界面测试的示例资料，不是剧情原文。',excerpt:'这是一段用于界面测试的示例资料，不是剧情原文。',agentRead:true}],'source')
const kinds=['excerpt','finding','time','relation','question','contrast','excerpt','finding','relation']
const titles=['魏彦吾提到的“善妒的胞弟”','胞弟与炎国真龙的身份关联','兄弟分歧发生的先后顺序','“炎礼”指向哪一个人物','炉灶失火是否导致了爱德华之死？','两份文本中的“放下了”','可核对的兄弟对话原文','太师案件中各方的不同目标','后续记录是否支持这一判断']
const updated=await service.update(session,{board_id:binding.board_id,run_id:binding.run_id,expected_revision:0,clues:kinds.map((kind,i)=>({client_key:`clue${i}`,kind,title:titles[i],summary:'这是界面验证示例。真实调查将由 Agent 根据返回资料整理。',detail:'这是用于检查卡面、排版、版本保存和来源跳转的测试内容。\n所有线索都保留来源与可展开的解释。',interpretation:kind==='question'?'question':'inference',sources:[{source_id:'R0001'}]})),relations:[{from:'clue0',to:'clue1',type:'supports',label:'支撑'}, {from:'clue3',to:'clue5',type:'contradicts',label:'有待核验'},{from:'clue6',to:'clue1',type:'supports',label:'补充依据'},{from:'clue2',to:'clue7',type:'precedes'},{from:'clue8',to:'clue5',type:'relates'},{from:'clue0',to:'clue3',type:'relates'}]}, {callId:'update',turnId:1})
await service.publish(session,{board_id:binding.board_id,run_id:binding.run_id,expected_revision:updated.revision,title:'胞弟与真龙：身份及后续关系考据',summary:'重要线索已经汇入。报告保留依据、推断和仍未解决的问题。此处为界面示例。',markdown:'# 调查结论\n\n这是一份用于测试的示例报告。中央报告与周围线索共享同一块调查板。\n\n## 依据与解释\n\n原文与推断需要分开说明。[C001] [C002]\n\n## 仍待核验\n\n追问继续同一目标时，应更新此板并发布下一版。',clue_ids:Object.values(updated.created_ids)}, {callId:'publish',turnId:1})
await service.recordSources(session,Array.from({length:8},(_,i)=>({id:`candidate-${i+2}`,title:`重点材料 ${i+2} · 需要核对的原文与后续记录`,url:`https://example.com/source-${i+2}`,origin:'web',state:'found',excerpt:`第 ${i+2} 份材料的返回摘要，仍需核对全文。`,content:`# 示例原文\n\n第 ${i+2} 份材料。`})), 'inbox-candidates')
await service.stage(session,{board_id:binding.board_id,run_id:binding.run_id,expected_inbox_revision:0,changes:(await service.read(session,{section:'sources'})).sources.map(source=>({action:'add',source_id:source.id,note:`需要比较「${source.title}」与当前结论的关系。`}))},{callId:'stage-candidates',turnId:1})
await service.endTurn(session,1,'completed')
const fixtureSources=(await service.read(session,{section:'sources'})).sources.map(source=>({...source,id:source.sourceId}));
const canonical=await service.read(session,{board_id:binding.board_id})
assert.deepEqual(validateJsonSchemaValue({type:'object',additionalProperties:true,properties:{}},canonical),[])
const api=buildApi({investigations:service,effective:()=>({enabledGames:['arknights']})})
const html=`<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="/rhine/rhine.css"><style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden;background:#eeece4}</style><div id="app"></div><script src="/rhine/rhine.js"></script><script>window.rhineWorkbench=__PRTS_RHINE__.mountRhineWorkbench(document.getElementById('app'),{assetBase:'/rhine/',snapshot:{sessionId:'${session}',running:false,searching:false,query:'',tool:'',sources:${JSON.stringify(fixtureSources)},answer:'',records:[]},agentAvailable:true,api:async(endpoint,payload,signal)=>{const r=await fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint,payload}),signal});const b=await r.json();if(!r.ok)throw new Error(b.error||'请求失败');return b;},askAgent:async text=>{window.inboxRequest=text;},close:()=>{}});</script></html>`
const markdownLines=['# Markdown 原文验证','','**身份说明**与 `记录编号` 都应正常排版。','','1. **诅咒的种子**：示例记录。','2. **理念的宣言**：第二条示例。','','> 引文示例：保留来源范围。','','| 项目 | 结果 |','| --- | --- |','| 线索 | 已核对 |','','```ts','const evidence = "source";','```','','[原始来源](https://example.com)','![仅作标题展示](https://example.com/no-request.png)','<script>window.unsafeMarkdown=true</script>','','后续原文段落。'].map((text,i)=>({line_number:i+41,text}));
const server=createServer(async(req,res)=>{
 try{
  if(req.url==='/'||req.url==='/empty'){res.setHeader('content-type','text/html;charset=utf-8');return res.end(req.url==='/empty'?html.replace("sessionId:'"+session+"'","sessionId:'qa-empty-board'"):html)}
  if(req.url.startsWith('/rhine/')){const path=resolve(root,'lib/rhine',decodeURIComponent(req.url.slice(7)));assert(!relative(join(root,'lib/rhine'),path).startsWith('..'));res.setHeader('content-type',({'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.glb':'model/gltf-binary','.webp':'image/webp'})[extname(path)]||'application/octet-stream');return res.end(await readFile(path))}
  if(req.url==='/rpc'){let input='';for await(const chunk of req)input+=chunk;const {endpoint,payload}=JSON.parse(input);const signal=new AbortController();res.on('close',()=>{if(!res.writableEnded)signal.abort()});if(endpoint==='read'&&payload.locator?.document_id==='qa-markdown'){
    const more=!!payload.selection?.cursor;
    return res.end(JSON.stringify({data_version:'qa-v1',content:{lines:more?markdownLines.slice(15):markdownLines.slice(0,15)},page:more?{has_more:false}:{has_more:true,next_cursor:'qa-next'}}));
   }
   const result=await api.call('POST','/api/prts-corpus/'+endpoint.replace('.','/'),payload,{signal:signal.signal});res.statusCode=result.status;res.setHeader('content-type','application/json');return res.end(JSON.stringify(result.json))}
  res.statusCode=404;res.end()
 }catch(e){if(!res.destroyed){res.statusCode=500;res.end(JSON.stringify({error:e.message}))}}
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const url=`http://127.0.0.1:${server.address().port}`
const require=createRequire(join(root,'../.tools/rhine-qa/package.json'))
const {chromium}=require('playwright')
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-unsafe-swiftshader']})
const page=await browser.newPage({viewport:{width:1600,height:1000},reducedMotion:'reduce'})
page.setDefaultTimeout(90000)
const errors=[];page.on('pageerror',e=>errors.push(e.message))
const waitTitle=async expected=>{const deadline=Date.now()+10000;while(Date.now()<deadline){const current=(await service.read(session,{board_id:binding.board_id})).board.clues[0].title;if(current===expected)return;await page.waitForTimeout(100);}await writeFile(join(output,'failure-ui.txt'),await page.locator('body').innerText());await page.screenshot({path:join(output,'failure.png')});assert.equal((await service.read(session,{board_id:binding.board_id})).board.clues[0].title,expected);};
try{
 await page.goto(url);await page.waitForFunction(()=>window.rhineWorkbench?.stats().investigations?.inbox?.count===9);
 await page.locator('[data-zone="board"]').click();await page.waitForTimeout(2300);
 assert.equal(await page.locator('.rhine-inbox-panel').isVisible(),false);
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().evidenceInbox.folderCount),6);
 await page.screenshot({path:join(output,'01-board-box.jpg'),type:'jpeg',quality:85});
 await page.locator('.rhine-inbox-entry').click();await page.locator('.rhine-inbox-panel').waitFor({state:'visible'});await page.waitForTimeout(2000);
 await page.screenshot({path:join(output,'02-box-open.jpg'),type:'jpeg',quality:85});
 assert.equal(await page.locator('.rhine-inbox-select').count(),6);
 const actionBounds=await page.locator('.rhine-inbox-actions').first().boundingBox();assert(actionBounds.y+actionBounds.height<1000,'the reading and pinning actions stay visible');
 await page.locator('.rhine-inbox-ask').click();assert.match(await page.evaluate(()=>window.inboxRequest),new RegExp(binding.board_id));
 assert.match(await page.locator('.rhine-inbox-subtitle').innerText(),/9 份/);
 await page.locator('.rhine-inbox-read').click();await page.getByRole('button',{name:'← 返回证据盒',exact:true}).waitFor({state:'visible'});
 await page.getByRole('button',{name:'← 返回证据盒',exact:true}).click();await page.locator('.rhine-inbox-panel').waitFor({state:'visible'});
 await page.locator('.rhine-inbox-promote').click();await page.getByRole('textbox',{name:'线索标题',exact:true}).fill('经手动整理的一项线索');
 await page.getByRole('textbox',{name:'线索摘记',exact:true}).fill('保留原始资料，待进一步核验这里的上下文。');
 await page.getByRole('button',{name:'保存线索并上板 ↗',exact:true}).click();
 await page.waitForFunction(()=>window.rhineWorkbench.stats().investigations.inbox.count===8);
 const promoted=await service.read(session,{board_id:binding.board_id});assert.equal(promoted.board.clues.length,10);assert.equal(promoted.board.evidenceInbox[0].status,'promoted');
 await page.locator('.rhine-inbox-remove').click();await page.waitForFunction(()=>window.rhineWorkbench.stats().investigations.inbox.count===7);
 assert.equal((await service.read(session,{section:'sources'})).sources.length,9);
 await page.getByRole('searchbox',{name:'筛选重点证据'}).fill('重点材料 7');assert.equal(await page.locator('.rhine-inbox-select').count(),1);
 await page.locator('.rhine-inbox-select').click();await page.locator('.rhine-inbox-promote').click();await page.keyboard.press('Escape');assert.equal(await page.locator('.rhine-inbox-form').isVisible(),false);
 await page.getByRole('searchbox',{name:'筛选重点证据'}).fill('');
 const resumed=await service.open(session,{mode:'resume',board_id:binding.board_id,reason:'检查后台上板'}, {callId:'resume-inbox',turnId:2});
 await service.update(session,{board_id:binding.board_id,run_id:resumed.run_id,expected_revision:promoted.board.knowledgeRevision,clues:[{kind:'question',title:'后台整理候选材料 3',sources:[{source_id:'R0003'}]}]}, {callId:'consume',turnId:2});
 await page.waitForFunction(()=>window.rhineWorkbench.stats().investigations.inbox.count===6);
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().evidenceInbox.count),6);
 await page.keyboard.press('Escape');await page.locator('.rhine-inbox-panel').waitFor({state:'hidden'});
 // Both catalogue surfaces can stage material without jumping away or creating a clue.
 await page.locator('[data-zone="desk"]').click();await page.locator('.rhine-desk-item[data-source-id="candidate-2"]').click();
 await page.locator('.rhine-shelf-stage').click();await page.waitForFunction(()=>window.rhineWorkbench.stats().investigations.inbox.count===7);
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().location),'desk');
 await page.locator('.rhine-shelf-stage').click();await page.waitForTimeout(300);assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().investigations.inbox.count),7);
 await page.locator('[data-zone="archive"]').click();await page.locator('.rhine-array-toggle').click();
 // The array starts in the cloud collection for these network receipts.
 const candidate=page.locator('#file-ticks [data-source-id="candidate-3"]');
 for(let i=0;i<5&&!await candidate.count();i++)await page.locator('[data-action="column-next"]').click();
 await candidate.click();await page.locator('.rhine-array-stage').click();await page.waitForFunction(()=>window.rhineWorkbench.stats().investigations.inbox.count===8);
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().location),'archive');
 await page.locator('[data-zone="board"]').click();
 const second=await service.createUserBoard(session,{mutation_id:'second-board',title:'独立调查 · 空证据盒'});
 await page.waitForFunction(()=>document.querySelectorAll('.rhine-investigation-picker option').length===2);
 await page.locator('.rhine-investigation-picker').selectOption(second.board_id);await page.waitForFunction(()=>window.rhineWorkbench.stats().investigations.inbox.count===0);
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().evidenceInbox.folderCount),0);
 await page.locator('.rhine-inbox-entry').click();assert.match(await page.locator('.rhine-inbox-empty').innerText(),/暂时没有/);
 await page.keyboard.press('Escape');await page.locator('.rhine-investigation-picker').selectOption(binding.board_id);
 await page.waitForFunction(()=>window.rhineWorkbench.stats().investigations.inbox.count===8);
 await page.reload();await page.waitForFunction(()=>window.rhineWorkbench?.stats().investigations?.inbox?.count===8);
 await page.locator('[data-zone="board"]').click();await page.waitForTimeout(1500);await page.locator('.rhine-inbox-entry').click();
 await page.setViewportSize({width:900,height:760});await page.waitForTimeout(1200);await page.screenshot({path:join(output,'03-box-900.jpg'),type:'jpeg',quality:85});
 await page.setViewportSize({width:430,height:900});await page.waitForTimeout(1200);await page.screenshot({path:join(output,'04-box-portrait.jpg'),type:'jpeg',quality:85});
 const bounds=await page.locator('.rhine-inbox-content').boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=431);
 await page.keyboard.press('Escape');await page.locator('.rhine-inbox-panel').waitFor({state:'hidden'});
 assert.deepEqual(errors,[]);await writeFile(join(output,'checks.json'),JSON.stringify({passed:true,errors,stats:await page.evaluate(()=>window.rhineWorkbench.stats().investigations)},null,2));
 console.log(JSON.stringify({output,checks:'passed'}));
}catch(error){await page.screenshot({path:join(output,'failure.jpg'),type:'jpeg',quality:85});await writeFile(join(output,'failure.txt'),await page.locator('body').innerText());throw error;}
finally{await browser.close();await service.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
