import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join, extname, relative } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { rhineHost, chromium, rhineBrowserOptions } from './helpers/rhine-browser-env.mjs'
import { createInvestigationStore } from '../src/investigation-store.js'
import { investigationDefinitions } from '../src/investigation-tools.js'
import { buildApi } from '../src/ui.js'

const root=fileURLToPath(new URL('../',import.meta.url))
const host=rhineHost
const output=resolve(process.env.PRTS_EDITOR_QA_OUTPUT || join(root,'work/evidence-editor-20260921'))
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
await service.endTurn(session,1,'completed')
const canonical=await service.read(session,{board_id:binding.board_id})
assert.deepEqual(validateJsonSchemaValue({type:'object',additionalProperties:true,properties:{}},canonical),[])
const api=buildApi({investigations:service,effective:()=>({enabledGames:['arknights']})})
const html=`<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="/rhine/rhine.css"><style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden;background:#eeece4}</style><div id="app"></div><script src="/rhine/rhine.js"></script><script>window.rhineWorkbench=__PRTS_RHINE__.mountRhineWorkbench(document.getElementById('app'),{assetBase:'/rhine/',snapshot:{sessionId:'${session}',running:false,searching:false,query:'',tool:'',sources:[],answer:'',records:[]},agentAvailable:false,api:async(endpoint,payload,signal)=>{const r=await fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint,payload}),signal});const b=await r.json();if(!r.ok)throw new Error(b.error||'请求失败');return b;},askAgent:async()=>{},close:()=>{}});</script></html>`
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
const browser=await chromium.launch(rhineBrowserOptions)
const page=await browser.newPage({viewport:{width:1600,height:1000},reducedMotion:'reduce'})
page.setDefaultTimeout(90000)
const errors=[];page.on('pageerror',e=>errors.push(e.message))
const waitTitle=async expected=>{const deadline=Date.now()+10000;while(Date.now()<deadline){const current=(await service.read(session,{board_id:binding.board_id})).board.clues[0].title;if(current===expected)return;await page.waitForTimeout(100);}await writeFile(join(output,'failure-ui.txt'),await page.locator('body').innerText());await page.screenshot({path:join(output,'failure.png')});assert.equal((await service.read(session,{board_id:binding.board_id})).board.clues[0].title,expected);};

const editor=page.locator('.rhine-evidence-tools');
const screenshot=async name=>page.screenshot({path:join(output,`${name}.jpg`),type:'jpeg',quality:85});
const openClue=async(index)=>{
 if(await editor.isVisible())await page.locator('.rhine-evidence-close-tools').click();
 await page.locator('.rhine-investigation-directory').click();
 await page.locator('.rhine-investigation-drawer-body button').nth(index).click();
 await page.getByRole('button',{name:'编辑这条线索 ↗'}).click();
 await page.locator('.rhine-evidence-edit-paper').waitFor();
 await page.waitForTimeout(350);
};
const inBounds=async()=>{
 const r=await editor.boundingBox(),v=page.viewportSize();
 assert(r.x>=-1&&r.y>=-1&&r.x+r.width<=v.width+1&&r.y+r.height<=v.height+1,JSON.stringify({r,v}));
};
try{
 await page.goto(url);await page.waitForFunction(()=>window.rhineWorkbench?.stats().investigations?.clues===9&&window.rhineWorkbench.stats().heroLoaded);
 await page.locator('[data-zone="board"]').click();await page.waitForTimeout(2200);
 const links=await page.evaluate(()=>window.rhineWorkbench.stats().evidenceBoard.linkRoutes);
 await openClue(0);await inBounds();
 assert.equal(await page.locator('.rhine-evidence-adjustments').evaluate(n=>n.open),false);
 assert.equal(await page.locator('.rhine-evidence-edit-paper').getAttribute('data-kind'),'excerpt');
 await screenshot('excerpt-edit');
 const longTitle='核对魏彦吾所说的“善妒的胞弟”：原始记录、人物关系以及后续情节之间的证据是否一致？';
 await page.getByRole('textbox',{name:'线索标题',exact:true}).fill(longTitle);
 await waitTitle(longTitle);
 assert(await page.locator('.rhine-evidence-title-input').evaluate(n=>n.scrollHeight<=n.clientHeight+1),'wrapped title should be readable');
 await page.getByRole('textbox',{name:'线索内容',exact:true}).fill('原文与推断应分开记录。\n\n**待核对**：这段内容用于保存、返回和撤销验证。');
 await page.locator('.rhine-evidence-save').click();
 await page.waitForTimeout(700);
 assert.match((await service.read(session,{board_id:binding.board_id})).board.clues[0].detail,/原文与推断/);
 await screenshot('long-title-edit');
 await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().location),'board');
 await openClue(0);assert.equal(await page.locator('.rhine-evidence-title-input').inputValue(),longTitle);
 await page.locator('.rhine-evidence-adjustments > summary').click();
 const scaleBefore=await page.evaluate(()=>window.rhineWorkbench.stats().evidenceBoard.layout.find(c=>c.id==='C001').scale);
 await page.locator('.rhine-evidence-size-up').click();await page.waitForTimeout(700);
 assert((await page.evaluate(()=>window.rhineWorkbench.stats().evidenceBoard.layout.find(c=>c.id==='C001').scale))>scaleBefore);
 await page.locator('.rhine-evidence-undo').click();await page.waitForTimeout(700);
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().evidenceBoard.layout.find(c=>c.id==='C001').scale),scaleBefore);
 await page.locator('.rhine-evidence-adjustments > summary').click();
 for(const [i,kind] of [[1,'finding'],[3,'relation'],[4,'question']]){
  await openClue(i);assert.equal(await page.locator('.rhine-evidence-edit-paper').getAttribute('data-kind'),kind);
  await inBounds();await screenshot(`${kind}-edit`);
 }
 await page.setViewportSize({width:900,height:760});await page.waitForTimeout(800);await inBounds();await screenshot('editor-900');
 await page.setViewportSize({width:430,height:900});await page.waitForTimeout(800);await inBounds();await screenshot('editor-430');
 assert(await page.locator('.rhine-evidence-edit-paper').evaluate(n=>{const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.x+30,r.y+r.height*.7);return n.contains(hit)}),'paper must sit above room labels');
 assert.equal(await editor.evaluate(n=>n.classList.contains('is-drawer')),true);
 await page.getByRole('textbox',{name:'线索标题',exact:true}).fill('窄屏编辑仍可保存与返回');
 await page.keyboard.press('Escape');await page.waitForTimeout(600);
 assert.equal(await editor.isVisible(),false);
 assert.equal((await service.read(session,{board_id:binding.board_id})).board.clues[4].title,'窄屏编辑仍可保存与返回');
 await page.setViewportSize({width:1600,height:1000});await page.waitForTimeout(800);
 await page.getByRole('button',{name:'全屏线索板',exact:true}).click();await page.waitForTimeout(800);
 await openClue(3);await inBounds();await screenshot('editor-fullscreen');
 assert.equal((await page.evaluate(()=>window.rhineWorkbench.stats().evidenceBoard.linkRoutes)).length,links.length);
 assert.deepEqual(errors,[]);await writeFile(join(output,'checks.json'),JSON.stringify({ok:true,types:['excerpt','finding','relation','question'],autosave:true,reopen:true,resizeUndo:true,narrow:true,fullscreen:true,errors},null,2));
 console.log(JSON.stringify({ok:true,output}));
}catch(error){await screenshot('failure');await writeFile(join(output,'failure-ui.txt'),await page.locator('body').innerText());throw error;}
finally{await browser.close();await service.close();await backend.close?.();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
