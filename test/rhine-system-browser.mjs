import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,join,extname,relative} from 'node:path';
import {chromium,rhineBrowserOptions} from './helpers/rhine-browser-env.mjs';
import {createInvestigationStore} from '../src/investigation-store.js';
import {buildApi} from '../src/ui.js';
const root=fileURLToPath(new URL('../',import.meta.url)),output=join(root,'work/rhine-system-fixes');
await mkdir(output,{recursive:true});
await writeFile(join(output,'result.json'),JSON.stringify({passed:false,status:'running'},null,2));
const values=new Map();
const facility={async open(spec){let queue=Promise.resolve();return {close:async()=>{},table:()=>({get:()=>values.get(spec.name),put:async(_key,v)=>values.set(spec.name,structuredClone(v)),update(_key,fn){const task=queue.then(()=>{const next=spec.tables.portfolios.valueSchema.parse(fn(values.get(spec.name)));values.set(spec.name,structuredClone(next));return structuredClone(next)});queue=task.catch(()=>{});return task}})}}};
const store=createInvestigationStore(facility), session='system-regression';
const b=await store.open(session,{mode:'new',title:'调查版本回归',objective:'完整保存证据板',reason:'测试'},{callId:'open',turnId:1});
await store.recordSources(session,[{id:'doc',title:'测试原文',documentUid:'uid',dataVersion:'v1',agentRead:true,content:'可核对的原文',lineStart:1,lineEnd:1}],'read');
await store.update(session,{board_id:b.board_id,run_id:b.run_id,expected_revision:0,clues:[{client_key:'a',title:'最初的线索',sources:[{source_id:'R0001',quote:'可核对的原文'}]},{client_key:'b',title:'未被报告引用的线索',kind:'question'}],relations:[{from:'a',to:'b',type:'supports'}],open_questions:['待验证问题']},{callId:'clues',turnId:1});
const publish=(version,revision)=>store.publish(session,{board_id:b.board_id,run_id:b.run_id,expected_revision:revision,title:`正式报告 V${version}`,summary:'保存的阶段结论',markdown:`## 正式章节\n\n这是正式报告正文 V${version}，引用已保存的线索。[C001]`,clue_ids:['C001']},{callId:`publish-${version}`,turnId:1});
await publish(1,1);console.log('READY fixture');
const api=buildApi({investigations:store,effective:()=>({enabledGames:['arknights']})});
const html=`<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="/rhine/rhine.css"><style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden}</style><div id="app"></div><script src="/rhine/rhine.js"></script><script>
window.base={sessionId:'${session}',running:false,searching:false,phase:'complete',outcome:'completed',investigationId:'turn:1',question:'测试问题',query:'',tool:'',sources:[],answer:'聊天摘要，与正式报告正文不同',records:[],operations:[]};
window.hostState={sessionId:'${session}',title:'测试会话',workspace:'测试工作区',blank:false,running:true,busy:false,loading:true,canSubmit:true,mode:'prts',model:'',modes:[{id:'prts',name:'PRTS'}],models:[],sessions:[]};window.cancelCount=0;let listener;
window.host={getState:()=>({...hostState}),subscribe:fn=>{listener=fn;return()=>listener=null},refresh:async()=>{},selectMode:async()=>{},selectModel:async()=>{},openSession:async()=>{},cancel:async()=>{cancelCount++;hostState.running=false;hostState.loading=false;listener?.({...hostState})},createSession:async()=>{hostState={...hostState,sessionId:'fresh',blank:true};listener?.({...hostState});workbench.update({...base,sessionId:'fresh',question:'',answer:'',phase:'idle',outcome:'unknown'})}};
window.workbench=__PRTS_RHINE__.mountRhineWorkbench(document.querySelector('#app'),{assetBase:'/rhine/',snapshot:base,host,
api:async(endpoint,payload,signal)=>{const r=await fetch('/rpc',{method:'POST',body:JSON.stringify({endpoint,payload}),signal});const b=await r.json();if(!r.ok)throw new Error(b.error||JSON.stringify(b));return b},askAgent:async()=>{},close:()=>{}});
</script></html>`;
const server=createServer(async(req,res)=>{try{
 if(req.url==='/'){res.setHeader('content-type','text/html;charset=utf-8');res.end(html);return}
 if(req.url.startsWith('/rhine/')){const path=resolve(root,'lib/rhine',decodeURIComponent(req.url.slice(7)));assert(!relative(join(root,'lib/rhine'),path).startsWith('..'));res.setHeader('content-type',({'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2'})[extname(path)]||'application/octet-stream');res.end(await readFile(path));return}
 if(req.url==='/rpc'){let input='';for await(const chunk of req)input+=chunk;const {endpoint,payload}=JSON.parse(input);const cancel=new AbortController();res.on('close',()=>{if(!res.writableEnded)cancel.abort()});const result=await api.call('POST','/api/prts-corpus/'+endpoint.replace('.','/'),payload,{signal:cancel.signal});if(!res.destroyed){res.statusCode=result.status;res.setHeader('content-type','application/json');res.end(JSON.stringify(result.json))}return}
 res.statusCode=404;res.end();
}catch(error){if(!res.destroyed){res.statusCode=500;res.end(JSON.stringify({error:error.message}))}}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));console.log('READY server');
const browserServer=await chromium.launchServer({...rhineBrowserOptions,args:[...rhineBrowserOptions.args,'--use-angle=swiftshader']});
const browser=await chromium.connect(browserServer.wsEndpoint()),page=await browser.newPage({viewport:{width:1100,height:760},deviceScaleFactor:.5,reducedMotion:'reduce'});
console.log('READY browser');page.setDefaultTimeout(60000);const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE ERROR',e.message)});
const checkpoint=name=>console.log('PASS',name);
const deadline=setTimeout(()=>{console.error('Browser test deadline exceeded');void browserServer.kill()},240000);
try{
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 console.log('READY page');await page.waitForFunction(()=>window.workbench.stats().investigations?.clues===2);console.log('READY board data');
 await page.waitForFunction(()=>document.querySelector('.rhine-workbench')?.dataset.sceneState==='ready');
 assert.equal(await page.locator('.rhine-agent-cancel').isEnabled(),true);
 await page.locator('.rhine-agent-cancel').click();assert.equal(await page.evaluate(()=>cancelCount),1);checkpoint('stop remains available during settings loading');
 await page.locator('.rhine-report-open').click();await page.locator('.rhine-investigation-report').waitFor({state:'visible'});
 assert.equal(await page.locator('.rhine-investigation-report h2').first().innerText(),'正式报告 V1');
 assert.match(await page.locator('.rhine-investigation-report article').innerText(),/正式报告正文 V1/);
 assert.equal(await page.locator('.rhine-report').isVisible(),false);
 assert.equal(await page.locator('.rhine-investigation-brief').isVisible(),false);
 await page.locator('.rhine-investigation-report a[href="#investigation-clue-C001"]').click();assert.equal(await page.locator('.rhine-investigation-report-evidence').evaluate(e=>e.open),true);
 await page.screenshot({path:join(output,'saved-report.png'),timeout:60000});checkpoint('report entry opens saved report, citations and opaque reading surface');
 await page.locator('.rhine-investigation-report header button').click();
 await page.locator('.rhine-investigation-version').selectOption('1');
 await page.waitForFunction(()=>workbench.stats().investigations.selectedVersion===1);
 await store.update(session,{board_id:b.board_id,run_id:b.run_id,expected_revision:1,clues:[{id:'C001',title:'更新后的线索'},{title:'新增线索',kind:'question'}],open_questions:['新的疑问']},{callId:'update',turnId:1});await publish(2,2);
 await page.waitForFunction(()=>document.querySelector('.rhine-investigation-version option[value="2"]'));
 assert.equal(await page.evaluate(()=>workbench.stats().investigations.clues),2);assert.equal(await page.evaluate(()=>workbench.stats().investigations.selectedVersion),1);
 await page.keyboard.press('n');assert.equal(await page.locator('.rhine-evidence-tools').isVisible(),false);checkpoint('viewed V1 is unchanged by Agent update and publication of V2; editing is blocked');
 await page.locator('.rhine-investigation-version').selectOption('2');await page.waitForFunction(()=>workbench.stats().investigations.clues===3);
 await page.locator('.rhine-investigation-version').selectOption('0');await page.waitForFunction(()=>workbench.stats().investigations.selectedVersion===0);checkpoint('whole-board versions switch and return to working board');
 await page.locator('[data-zone="archive"]').click();await page.waitForFunction(()=>workbench.stats().location==='archive');
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.waitForFunction(()=>workbench.stats().reducedMotion===false);
 if(await page.evaluate(()=>workbench.stats().followAgent))await page.locator('.rhine-follow-toggle').click();
 const before=await page.evaluate(()=>workbench.stats().scanSteps);
 await page.evaluate(()=>workbench.update({...base,running:true,outcome:'running',phase:'searching',searching:true,operations:[{id:'search-now',kind:'search',tool:'corpus_search',state:'active',sourceIds:[],startedAt:Date.now()}]}));
 await page.waitForFunction(before=>workbench.stats().scanSteps>before,before);assert.equal(await page.evaluate(()=>workbench.stats().followAgent),false);checkpoint('Agent search moves the array with camera follow paused');
 // A completed call delivered between frames still owns one visible cycle.
 const fastBefore=await page.evaluate(()=>{workbench.update({...base,outcome:'interrupted',operations:[]});return workbench.stats().scanSteps});
 await page.evaluate(()=>workbench.update({...base,investigationId:'fast-turn',running:true,outcome:'running',phase:'synthesizing',operations:[{id:'fast-search',kind:'search',tool:'corpus_search',state:'complete',sourceIds:[],startedAt:Date.now()-30,completedAt:Date.now()}]}));
 await page.waitForFunction(before=>workbench.stats().scanSteps>before,fastBefore);checkpoint('fast empty search still completes a visible step');
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.waitForFunction(()=>workbench.stats().reducedMotion===true);
 const reducedBefore=await page.evaluate(()=>({steps:workbench.stats().scanSteps,frames:workbench.stats().renderedFrames}));
 await page.waitForFunction(before=>workbench.stats().renderedFrames>=before.frames+3,reducedBefore);
 assert.equal(await page.evaluate(()=>workbench.stats().scanSteps),reducedBefore.steps);checkpoint('reduced motion suppresses automatic scanning');
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.waitForFunction(()=>workbench.stats().reducedMotion===false);

 await page.evaluate(()=>workbench.update({...base,running:true,outcome:'running',phase:'synthesizing',sources:[{id:'doc',title:'Test source',kind:'original_story',origin:'local',state:'read',agentRead:true,excerpt:'Read text',documentUid:'uid',dataVersion:'v1'}],operations:[{id:'read-now',kind:'read',tool:'corpus_read',state:'complete',sourceIds:['doc'],startedAt:Date.now()-20,completedAt:Date.now()}]}));
 await page.waitForFunction(()=>workbench.stats().activeReadingSourceId==='doc'&&workbench.stats().readingLift>0);checkpoint('20 ms Agent read extracts a cassette with camera follow paused');
 await page.evaluate(()=>workbench.update({...base,outcome:'interrupted',phase:'error',operations:[]}));assert.equal(await page.evaluate(()=>workbench.stats().searching),false);checkpoint('cancellation stops scanning');
 await page.locator('.rhine-session-new').click();await page.waitForFunction(()=>workbench.stats().investigations.boards===0);
 assert.equal(await page.evaluate(()=>workbench.stats().sourceCount),0);assert.equal(await page.locator('.rhine-report-open').isVisible(),false);checkpoint('new conversation clears investigation and report state');
 assert.deepEqual(errors,[]);
}catch(error){console.error('FAILED',error);try{await writeFile(join(output,'failure-state.json'),JSON.stringify(await page.evaluate(()=>({stats:workbench.stats(),root:document.querySelector('.rhine-workbench').className,hudHidden:document.querySelector('.rhine-investigation-hud').hidden,hudVisibility:getComputedStyle(document.querySelector('.rhine-investigation-hud')).visibility,reportHidden:document.querySelector('.rhine-investigation-report').hidden})),null,2))}catch{}throw error}
finally{
 clearTimeout(deadline);console.log('CLEANUP');server.closeAllConnections();server.close();
 await browserServer.kill();await browser.close();await store.close();console.log('CLOSED');
}

await writeFile(join(output,'result.json'),JSON.stringify({passed:true,errors},null,2));
