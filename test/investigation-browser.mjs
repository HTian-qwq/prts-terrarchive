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
const output=resolve(process.env.PRTS_INVESTIGATION_QA_OUTPUT || join(root,'work/investigation-implementation-20260918'))
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
const require=createRequire(join(root,'../.tools/rhine-qa/package.json'))
const {chromium}=require('playwright')
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-unsafe-swiftshader']})
const page=await browser.newPage({viewport:{width:1600,height:1000},reducedMotion:'reduce'})
page.setDefaultTimeout(90000)
const errors=[];page.on('pageerror',e=>errors.push(e.message))
const waitTitle=async expected=>{const deadline=Date.now()+10000;while(Date.now()<deadline){const current=(await service.read(session,{board_id:binding.board_id})).board.clues[0].title;if(current===expected)return;await page.waitForTimeout(100);}await writeFile(join(output,'failure-ui.txt'),await page.locator('body').innerText());await page.screenshot({path:join(output,'failure.png')});assert.equal((await service.read(session,{board_id:binding.board_id})).board.clues[0].title,expected);};
try{
 await page.goto(url)
 await page.waitForFunction(()=>window.rhineWorkbench?.stats().investigations?.clues===9)
 await page.locator('[data-zone="board"]').click()
 await page.waitForFunction(()=>window.rhineWorkbench?.stats().location==='board')
 await page.waitForTimeout(3500)
 const redStrings=await page.evaluate(()=>window.rhineWorkbench.stats().evidenceBoard.linkRoutes)
 assert.equal(redStrings.length,6)
 assert(redStrings.every(r=>r.color==='#97594f'&&r.opacity===1&&r.radius===.022&&r.visible))
 await page.screenshot({path:join(output,'board.png')})
 await page.mouse.click(850,490)
 await page.locator('.rhine-investigation-report').waitFor({state:'visible'})
 assert.match(await page.locator('.rhine-investigation-report').innerText(),/依据与解释/)
 await page.locator('.rhine-investigation-report a[href="#investigation-clue-C001"]').click()
 assert.equal(await page.locator('.rhine-investigation-report-evidence').evaluate(n=>n.open),true)
 await page.screenshot({path:join(output,'report.png')})
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().readingObject.visible),true)
 assert.equal(await page.locator('.rhine-investigation-hud').isVisible(),false)
 await page.locator('.rhine-investigation-report-evidence .rhine-investigation-source').first().click()
 await page.locator('.rhine-reader-body strong').first().waitFor({state:'visible'})
 assert.equal(await page.locator('.rhine-reader-body strong').first().innerText(),'身份说明')
 assert.equal(await page.locator('.rhine-reader-body ol li').count(),2)
 assert.equal(await page.locator('.rhine-reader-body blockquote').count(),1)
 assert.equal(await page.locator('.rhine-reader-body table td').first().innerText(),'线索')
 assert.equal(await page.locator('.rhine-reader-line[data-line="45"]').getAttribute('data-line-end'),'46')
 assert.equal(await page.locator('.rhine-reader-line[data-line="45"]').evaluate(n=>n.classList.contains('is-hit')),true)
 await page.evaluate(()=>{const row=document.querySelector('.rhine-reader-line[data-line="43"]');window.retainedSourceRow=row;const range=document.createRange();range.selectNodeContents(row.querySelector('.rhine-line-text'));getSelection().removeAllRanges();getSelection().addRange(range);})
 await page.locator('.rhine-extract-selection').click()
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().extractCount),1)
 await page.locator('.rhine-reader-more').click()
 await page.waitForFunction(()=>document.querySelector('.rhine-reader-status').textContent.includes('已至文末'))
 assert.equal(await page.evaluate(()=>document.querySelector('.rhine-reader-line[data-line="43"]')===window.retainedSourceRow),true)
 assert.match(await page.locator('.rhine-reader-body pre code').innerText(),/const evidence/)
 assert.equal(await page.locator('.rhine-reader-body pre').count(),1)
 assert.equal(await page.locator('.rhine-reader-body img,.rhine-reader-body script').count(),0)
 assert.equal(await page.evaluate(()=>window.unsafeMarkdown),undefined)
 await page.locator('.rhine-reader-ranges button').last().click()
 await page.screenshot({path:join(output,'source-markdown.jpg'),type:'jpeg',quality:82})
 await page.locator('.rhine-reader-back-report').click()
 await page.locator('.rhine-investigation-report').waitFor({state:'visible'})
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().location),'board')
 // Escape still belongs to the open report after focus leaves the report itself.
 await page.evaluate(()=>{document.body.tabIndex=-1;document.body.focus()})
 await page.keyboard.press('Escape')
 await page.locator('.rhine-investigation-report').waitFor({state:'hidden'})
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().location),'board')
 await page.waitForTimeout(1600)
 await page.mouse.click(850,490)
 await page.getByRole('button',{name:'返回调查板 ↗',exact:true}).click()
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().location),'board')
 await page.locator('.rhine-investigation-directory').click()
 await page.locator('.rhine-investigation-drawer-body button').first().click()
 assert.match(await page.locator('.rhine-investigation-drawer').innerText(),/来源与核验/)
 assert.match(await page.locator('.rhine-investigation-drawer').innerText(),/关联线索/)
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().board.toolsOpen),false)
 assert.deepEqual(await page.evaluate(()=>window.rhineWorkbench.stats().evidenceBoard.linkRoutes),redStrings)
 await page.screenshot({path:join(output,'clue.png')})
 await page.getByRole('button',{name:'编辑这条线索 ↗'}).click()
 await page.locator('.rhine-evidence-title-input').fill('用户整理后的线索标题')
 await page.locator('.rhine-evidence-save').click()
 await waitTitle('用户整理后的线索标题')
 await page.locator('.rhine-evidence-undo').click()
 await waitTitle(titles[0])
 await page.keyboard.press('Escape')
 // A background followup stays on the old board when the user explicitly views it.
 await page.locator('.rhine-investigation-picker').selectOption(binding.board_id)
 const second=await service.open(session,{mode:'new',title:'另一项独立调查',objective:'检查工作板与查看板分离',reason:'独立目标'}, {callId:'second',turnId:2})
 await page.waitForFunction(()=>window.rhineWorkbench.stats().investigations.boards===2)
 assert.equal(await page.locator('.rhine-investigation-picker').inputValue(),binding.board_id)
 await page.locator('.rhine-investigation-follow').click()
 await page.waitForFunction(id=>window.rhineWorkbench.stats().investigations.selectedId===id,second.board_id)
 await page.locator('.rhine-investigation-picker').selectOption(binding.board_id)
 await page.waitForFunction(id=>window.rhineWorkbench.stats().investigations.selectedId===id,binding.board_id)
 await page.reload();await page.waitForFunction(()=>window.rhineWorkbench?.stats().investigations?.clues===9)
 await page.locator('[data-zone="board"]').click()
 await page.waitForTimeout(1800)
 assert.equal(await page.locator('.rhine-investigation-picker').inputValue(),binding.board_id)
 await page.setViewportSize({width:900,height:760});await page.waitForTimeout(1200);await page.screenshot({path:join(output,'board-900.png')})
 await page.setViewportSize({width:1600,height:1000});await page.waitForTimeout(1000)
 const priorLayout=await page.evaluate(()=>window.rhineWorkbench.stats().evidenceBoard.layout)
 const resumed=await service.open(session,{mode:'resume',board_id:binding.board_id,reason:'检查新增线索后版面稳定'}, {callId:'resume-layout',turnId:3})
 await service.update(session,{board_id:binding.board_id,run_id:resumed.run_id,expected_revision:resumed.revision,clues:['question','time','finding'].map((kind,i)=>({client_key:`extra${i}`,kind,title:['仍待核对的原始记录','后续事件的时间窗口','新增材料带来的补充判断'][i],summary:'仅供验证版面与交互的示例，真实结论须以原文为准。',interpretation:'question',sources:[{source_id:'R0001'}]}))}, {callId:'fill-board',turnId:3})
 await page.waitForFunction(()=>window.rhineWorkbench.stats().investigations.clues===12)
 const fullLayout=await page.evaluate(()=>window.rhineWorkbench.stats().evidenceBoard.layout)
 for(const old of priorLayout){const next=fullLayout.find(c=>c.id===old.id);assert.equal(next.x,old.x);assert.equal(next.y,old.y)}
 await page.waitForTimeout(1000);await page.screenshot({path:join(output,'board-12.png')})
 await page.getByRole('button',{name:'全屏线索板',exact:true}).click();await page.waitForTimeout(1200)
 await page.screenshot({path:join(output,'board-12-fullscreen.png')})
 await page.getByRole('button',{name:'放大线索板',exact:true}).click();await page.waitForTimeout(1000)
 const zoomBefore=await page.locator('.rhine-board-reset').innerText()
 await page.mouse.click(800,500)
 await page.locator('.rhine-investigation-report').waitFor({state:'visible'})
 await page.screenshot({path:join(output,'report-fullscreen.png')})
 await page.setViewportSize({width:900,height:760});await page.waitForTimeout(1000)
 await page.screenshot({path:join(output,'report-900.png')})
 assert.equal(await page.getByRole('button',{name:'返回调查板 ↗',exact:true}).isVisible(),true)
 const bounds=await page.locator('.rhine-investigation-report-scroll').boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=901)
 await page.setViewportSize({width:1600,height:1000});await page.waitForTimeout(1000)
 await page.emulateMedia({reducedMotion:'no-preference'})
 await page.waitForFunction(()=>Number(getComputedStyle(document.querySelector('.rhine-investigation-report')).opacity)>.999)
 await page.evaluate(()=>{
  window.returnFrames=[];
  const report=document.querySelector('.rhine-investigation-report');
  const sample=()=>{const stats=window.rhineWorkbench.stats();window.returnFrames.push({time:performance.now(),progress:stats.readingObject.returnProgress,modelOpacity:stats.readingObject.opacity,screenBounds:stats.readingObject.screenBounds,scale:stats.readingObject.scale,position:stats.readingObject.position,rotation:stats.readingObject.rotation,reveal:stats.evidenceBoard.reveal,opacity:Number(getComputedStyle(report).opacity),hidden:report.hidden});if(!report.hidden)requestAnimationFrame(sample)};
  report.querySelector('header button').click();sample();
 })
 // Repeated Escape must not escape the board while the same close is running.
 await page.keyboard.press('Escape');await page.keyboard.press('Escape')
 await page.waitForFunction(()=>window.rhineWorkbench.stats().readingObject.returnProgress>.4)
 await page.screenshot({path:join(output,'report-return.jpg'),type:'jpeg',quality:82})
 await page.locator('.rhine-investigation-report').waitFor({state:'hidden'})
 await page.waitForFunction(()=>window.rhineWorkbench.stats().evidenceBoard.reveal===1)
 const returnFrames=await page.evaluate(()=>window.returnFrames)
 await writeFile(join(output,'return-frames.json'),JSON.stringify(returnFrames,null,2))
 assert(returnFrames.some(f=>f.progress>.05&&f.progress<.95),'the report fades over multiple frames')
 assert(returnFrames.some(f=>f.reveal>0&&f.reveal<1),'the board gradually reappears')
 assert(returnFrames.some(f=>f.opacity>0&&f.opacity<1),'the report content fades instead of disappearing')
 assert(returnFrames.some(f=>f.modelOpacity>0&&f.modelOpacity<1),'the physical folio also fades');
 const visibleReturn=returnFrames.filter(f=>!f.hidden);
 assert(visibleReturn.every(f=>Math.abs(f.modelOpacity-f.opacity)<.08),'the content and folio share the fade clock');
 // Camera FOV can still settle after a resize; measure the rendered face in screen space.
 assert(visibleReturn.every(f=>f.screenBounds.every((v,i)=>Math.abs(v-visibleReturn[0].screenBounds[i])<.001)),'the projected folio stays in place and keeps its size throughout closing');
 assert(visibleReturn.every(f=>f.rotation.every((v,i)=>v===visibleReturn[0].rotation[i])),'closing never turns the folio into the card');
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().readingObject.materialsRestored),true);

 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().boardFullscreen),true)
 assert.equal(await page.locator('.rhine-board-reset').innerText(),zoomBefore)
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().readingObject.visible),false)
 // Capture the actual opening, including the first rendered folio frame.
 await page.evaluate(()=>{
  window.openFrames=[];window.openFramesDone=false;const start=performance.now(),report=document.querySelector('.rhine-investigation-report');
  const sample=()=>{const stats=window.rhineWorkbench.stats(),folio=stats.readingObject;
   window.openFrames.push({time:performance.now(),visible:folio.visible,progress:folio.enterProgress,modelOpacity:folio.opacity,screenBounds:folio.screenBounds,scale:folio.scale,position:folio.position,rotation:folio.rotation,reveal:stats.evidenceBoard.reveal,opacity:Number(getComputedStyle(report).opacity)});
   if((!report.hidden&&folio.enterProgress>=1)||performance.now()-start>4000){window.openFramesDone=true;return;}requestAnimationFrame(sample);
  };requestAnimationFrame(sample);
 })
 await page.mouse.click(800,500)
 await page.locator('.rhine-investigation-report').waitFor({state:'visible'})
 await page.waitForFunction(()=>window.openFramesDone)
 const openFrames=await page.evaluate(()=>window.openFrames);await writeFile(join(output,'open-frames.json'),JSON.stringify(openFrames,null,2));
 const visibleOpen=openFrames.filter(f=>f.visible);
 assert(visibleOpen.some(f=>f.modelOpacity>0&&f.modelOpacity<1),'opening the folio must not pop into view');
 assert(visibleOpen.every(f=>Math.abs(f.modelOpacity-f.opacity)<.08),'opening content and folio stay synchronized');
 assert(visibleOpen.some(f=>f.opacity>0&&f.opacity<1),'opening the content uses the same fade');
 assert(visibleOpen.some(f=>f.reveal>0&&f.reveal<1),'opening gradually recedes the board');
 assert(visibleOpen.every(f=>f.screenBounds.every((v,i)=>Math.abs(v-visibleOpen.at(-1).screenBounds[i])<.001)),'the projected folio never scales from the report card');
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().readingObject.materialsRestored),true);
 await page.screenshot({path:join(output,'report-open.jpg'),type:'jpeg',quality:82});
 // Changing the motion preference mid-return finishes both surfaces together.
 await page.keyboard.press('Escape')
 await page.emulateMedia({reducedMotion:'reduce'})
 await page.locator('.rhine-investigation-report').waitFor({state:'hidden'})
 await page.waitForFunction(()=>window.rhineWorkbench.stats().evidenceBoard.reveal===1)
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().investigations.returning),false)
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().boardFullscreen),true)
 assert((await page.evaluate(()=>window.rhineWorkbench.stats().evidenceBoard.linkRoutes)).every(r=>r.opacity===1))
 // Leave the board during entrance: no delayed callback may resurrect the report.
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.mouse.click(800,500);
 await page.locator('.rhine-investigation-report').waitFor({state:'visible'});
 await page.evaluate(()=>document.querySelector('[data-zone="archive"]').click());
 await page.waitForTimeout(650);
 assert.equal(await page.locator('.rhine-investigation-report').isVisible(),false);
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().readingObject.visible),false);
 assert.equal(await page.evaluate(()=>window.rhineWorkbench.stats().location),'archive');
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.locator('[data-zone="board"]').click();await page.waitForTimeout(1000);

 const populatedStats=await page.evaluate(()=>window.rhineWorkbench.stats().investigations)
 // The invitation and board controls must share the actual scene's plane, even with the rim offscreen.
 await page.setViewportSize({width:1600,height:1000});await page.goto(url+'/empty')
 await page.waitForFunction(()=>window.rhineWorkbench?.stats().investigations?.boards===0)
 await page.locator('[data-zone="board"]').click()
 await page.locator('.rhine-investigation-hud').waitFor({state:'visible'})
 const attached=async(expectSlant=false)=>{
  const result=await page.evaluate(()=>{
   const hud=document.querySelector('.rhine-investigation-hud'),style=getComputedStyle(hud),matrix=hud.computedStyleMap().get('transform').toMatrix()
   const points=[[0,0],[hud.offsetWidth,0],[hud.offsetWidth,hud.offsetHeight],[0,hud.offsetHeight]]
   // Chromium quantizes small perspective coefficients; require subpixel alignment in stage space.
   const anchors=window.rhineWorkbench.stats().evidenceBoard.anchors.surface
   return {hidden:hud.hidden,width:hud.offsetWidth,height:hud.offsetHeight,inline:hud.style.transform,anchors,transform:style.transform,maxError:Math.max(...points.map(([x,y],i)=>{
    const p=matrix.transformPoint(new DOMPoint(x,y));return Math.hypot(p.x/p.w-anchors[i].x,p.y/p.w-anchors[i].y)
   })),tilt:matrix.m12}
  })
  assert.equal(result.hidden,false);assert(result.maxError<1,`board projection error: ${JSON.stringify(result)}`)
  if(expectSlant)assert(Math.abs(result.tilt)>.001,'the invitation inherits the slanted board plane')
  return result.transform
 }
 await attached(true)
 assert.equal(await page.locator('.rhine-investigation-picker').isVisible(),false)
 assert.equal(await page.locator('.rhine-investigation-footer').isVisible(),false)
 await page.waitForTimeout(5000);await attached()
 await page.screenshot({path:join(output,'empty-board.png')})
 const originalPlane=await attached()
 await page.getByRole('button',{name:'放大线索板',exact:true}).click();await page.waitForTimeout(1200)
 assert.notEqual(await attached(),originalPlane)
 await page.screenshot({path:join(output,'empty-board-zoom.png')})
 const beforePan=await attached()
 await page.mouse.move(700,550);await page.mouse.down({button:'middle'});await page.mouse.move(910,620,{steps:12});await page.mouse.up({button:'middle'});await page.waitForTimeout(1200)
 assert.notEqual(await attached(),beforePan)
 await page.getByRole('button',{name:'复位线索板视图',exact:true}).click();await page.waitForTimeout(1200)
 await page.getByRole('button',{name:'全屏线索板',exact:true}).click();await page.waitForTimeout(1200)
 await attached();await page.screenshot({path:join(output,'empty-board-fullscreen.png')})
 await page.getByRole('button',{name:'退出全屏线索板',exact:true}).click();await page.waitForTimeout(1200)
 await page.setViewportSize({width:900,height:760});await page.waitForTimeout(1200)
 await attached();await page.screenshot({path:join(output,'empty-board-900.png')})
 await page.locator('.rhine-investigation-add').click()
 await page.getByRole('textbox',{name:'新调查标题'}).fill('贴板操作验证')
 await page.getByRole('button',{name:'创建调查板',exact:true}).click()
 await page.waitForFunction(()=>window.rhineWorkbench.stats().investigations.boards===1&&document.querySelector('.rhine-investigation-empty').hidden)
 assert.equal(await page.locator('.rhine-investigation-empty').isVisible(),false)
 await page.locator('[data-zone="archive"]').click()
 await page.locator('.rhine-investigation-hud').waitFor({state:'hidden'})
 // The waiting meter also remains alive between real tool calls, then stops with the turn.
 await page.emulateMedia({reducedMotion:'no-preference'})
 const updateMeter=async patch=>page.evaluate(patch=>{
  window.rhineWorkbench.update({sessionId:'qa-empty-board',investigationId:'meter-qa',question:'状态动效验证',running:true,searching:false,tool:'',query:'',sources:[],answer:'',records:[],toolCalls:[],...patch})
 },patch)
 await updateMeter({})
 const bars=page.locator('.rhine-operation-meter i')
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('.rhine-operation-meter i')).animationName==='rhine-operation-wait')
 const firstBars=await bars.evaluateAll(nodes=>nodes.map(n=>getComputedStyle(n).transform))
 await page.waitForTimeout(350)
 assert.notDeepEqual(await bars.evaluateAll(nodes=>nodes.map(n=>getComputedStyle(n).transform)),firstBars)
 await updateMeter({toolCalls:[{id:'m1',tool:'corpus_search',state:'active',query:'示例'}]})
 assert.equal(await bars.first().evaluate(n=>getComputedStyle(n).animationName),'rhine-operation-bars')
 await updateMeter({toolCalls:[{id:'m1',tool:'corpus_search',state:'complete',query:'示例'}]})
 assert.equal(await bars.first().evaluate(n=>getComputedStyle(n).animationName),'rhine-operation-wait')
 await updateMeter({running:false,outcome:'completed',answer:'验证完成'})
 assert.equal(await bars.first().evaluate(n=>getComputedStyle(n).animationName),'none')
 await updateMeter({running:false,outcome:'interrupted'})
 assert.equal(await bars.first().evaluate(n=>getComputedStyle(n).animationName),'none')
 await updateMeter({});await page.emulateMedia({reducedMotion:'reduce'})
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('.rhine-operation-meter i')).animationName==='none')
 assert.deepEqual(errors,[])
 await writeFile(join(output,'checks.json'),JSON.stringify({nativeStorage:true,nativeToolSchemas:true,centralReport:true,reportCitation:true,relationMeaning:true,originalRedStrings:true,reportEscape:true,reportReturn:true,animatedOpen:true,stationaryFade:true,cancelledEntrance:true,animatedReturn:true,repeatedEscape:true,returnReducedMotion:true,readingObject:true,sourceMarkdown:true,sourcePagination:true,sourceExtraction:true,singleCluePanel:true,waitingMotion:true,reducedMotion:true,stableArrivals:true,fullBoard:true,manualEdit:true,undo:true,clueDetails:true,viewWorkingSeparation:true,viewRestored:true,boardAttached:true,emptyState:true,attachedZoom:true,attachedPan:true,attachedFullscreen:true,attachedResize:true,attachedCreate:true,hideOutsideBoard:true,errors,stats:populatedStats},null,2))
 console.log(JSON.stringify({output,checks:'passed'}))
}catch(error){await page.screenshot({path:join(output,'failure.jpg'),type:'jpeg',quality:80});await writeFile(join(output,'failure-ui.txt'),await page.locator('body').innerText());await writeFile(join(output,'failure-stats.json'),JSON.stringify(await page.evaluate(()=>window.rhineWorkbench.stats()),null,2));throw error;}finally{await browser.close();await service.close();await backend.close?.();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
