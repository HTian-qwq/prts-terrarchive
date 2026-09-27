import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join, relative, extname } from 'node:path';
import { chromium, rhineBrowserOptions } from './helpers/rhine-browser-env.mjs';
import { createInvestigationStore } from '../src/investigation-store.js';
import { buildApi } from '../src/ui.js';
const root=fileURLToPath(new URL('../',import.meta.url)),out=join(root,'work/context-rack-qa');
await mkdir(out,{recursive:true});
const values=new Map();
const facility={async open(spec){let tail=Promise.resolve();return{close:async()=>{},table:()=>({
  get:()=>values.get(spec.name),put:async(_key,v)=>values.set(spec.name,structuredClone(v)),
  update(_key,fn){const task=tail.then(()=>{const v=spec.tables.portfolios.valueSchema.parse(fn(values.get(spec.name)));values.set(spec.name,structuredClone(v));return structuredClone(v)});tail=task.catch(()=>{});return task;}
})}}};
const store=createInvestigationStore(facility),version='a'.repeat(64),session='context-rack';
const sources=Array.from({length:234},(_,i)=>({id:`context-${i}`,documentId:`doc-${i}`,documentUid:`uid-${i}`,dataVersion:version,
 title:`上下文资料 ${i+1}`,kind:i%3?'story':'entity_profile',origin:'local',state:'found',excerpt:`Agent 已接收的检索摘要 ${i+1}`}));
await store.recordSources(session,sources.slice(0,128),'search-1');await store.recordSources(session,sources.slice(128),'search-2');
const board=await store.open(session,{mode:'new',title:'十八条线索的调查',objective:'验证跨页总数',reason:'测试'},{callId:'open',turnId:1});
await store.update(session,{...board,expected_revision:0,clues:Array.from({length:18},(_,i)=>({client_key:`c${i}`,title:`线索 ${i+1}`,sources:[{source_id:`R${String(i+1).padStart(4,'0')}`}]}))},{callId:'clues',turnId:1});
const browse=Array.from({length:12},(_,i)=>({...sources[i],id:`browse-${i}`,documentId:`browse-doc-${i}`,documentUid:`browse-uid-${i}`,title:`纯浏览资料 ${i+1}`}));
const api=buildApi({investigations:store,effective:()=>({enabledGames:['arknights']})});
function html(id){return `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/rhine/rhine.css"><style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden}</style><div id="app"></div><script src="/rhine/rhine.js"></script><script>
window.snapshot={sessionId:${JSON.stringify(id)},running:false,searching:false,query:'',tool:'',sources:[],answer:'',operations:[]};
window.workbench=__PRTS_RHINE__.mountRhineWorkbench(document.querySelector('#app'),{assetBase:'/rhine/',snapshot,agentAvailable:false,api:async(endpoint,payload,signal)=>{const r=await fetch('/rpc',{method:'POST',body:JSON.stringify({endpoint,payload}),signal});const value=await r.json();if(!r.ok)throw new Error(value.error||JSON.stringify(value));return value},askAgent:async()=>{},close:()=>{}});
</script>`}
const server=createServer(async(req,res)=>{try{
 if(req.url==='/'||req.url==='/?empty'){res.setHeader('content-type','text/html;charset=utf-8');res.end(html(req.url.includes('empty')?'empty-session':session));return;}
 if(req.url.startsWith('/rhine/')){const path=resolve(root,'lib/rhine',decodeURIComponent(req.url.slice(7)));assert(!relative(join(root,'lib/rhine'),path).startsWith('..'));res.setHeader('content-type',({'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2'})[extname(path)]||'application/octet-stream');res.end(await readFile(path));return;}
 if(req.url==='/rpc'){let input='';for await(const chunk of req)input+=chunk;const {endpoint,payload}=JSON.parse(input);res.setHeader('content-type','application/json');
  if(endpoint==='archive.search'){res.end(JSON.stringify({sources:browse,data_version:version}));return;}
  const cancel=new AbortController();res.on('close',()=>{if(!res.writableEnded)cancel.abort()});
  const r=await api.call('POST','/api/prts-corpus/'+endpoint.replace('.','/'),payload,{signal:cancel.signal});if(!res.destroyed){res.statusCode=r.status;res.end(JSON.stringify(r.json));}return;
 }
 res.statusCode=404;res.end();
}catch(error){if(!res.destroyed){res.statusCode=500;res.end(JSON.stringify({error:error.message}));}}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}`;
const browserServer=await chromium.launchServer({...rhineBrowserOptions,args:[...rhineBrowserOptions.args,'--use-angle=swiftshader']});
const browser=await chromium.connect(browserServer.wsEndpoint()),page=await browser.newPage({viewport:{width:800,height:600},deviceScaleFactor:.5,reducedMotion:'reduce'});
page.setDefaultTimeout(60000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
const deadline=setTimeout(()=>{console.error('Context rack browser deadline exceeded');void browserServer.kill()},240000);
try{
 await page.goto(url);
 await page.waitForFunction(()=>workbench.stats().heroLoaded&&workbench.stats().sourceCount===234&&workbench.stats().candidateCount===246&&workbench.stats().investigations?.clues===18);
 await page.waitForFunction(()=>document.querySelector('.rhine-workbench')?.dataset.sceneState==='ready',null,{timeout:120000});
 assert.equal(await page.locator('.rhine-rack-count').textContent(),'234');
 assert.equal(await page.locator('.rhine-board-count').textContent(),'18');
 assert.equal(await page.evaluate(()=>workbench.stats().manualSourceCount),0);
 console.log('PASS durable recovery: 234 deliveries, 12 browsing-only candidates, 18 clues');
 await page.locator('[data-zone="desk"]').click();
 await page.waitForFunction(()=>workbench.stats().location==='desk');
 assert.equal(await page.locator('.rhine-desk-list button').count(),24);
 assert.match(await page.locator('.rhine-rack-range').textContent(),/共 234/);
 await page.getByRole('button',{name:'下一架资料',exact:true}).click();
 await page.waitForFunction(()=>workbench.stats().deskPage===1);
 assert.match(await page.locator('.rhine-rack-range').textContent(),/25–48/);
 await page.waitForFunction(()=>workbench.stats().physicalFiles<=24);
 console.log('PASS rack pagination keeps only one page of physical files');
 await page.locator('[data-zone="board"]').click();
 await page.getByRole('button',{name:'下一组线索',exact:true}).click();
 assert.match(await page.locator('.rhine-investigation-footer').textContent(),/2 \/ 2/);
 assert.equal(await page.locator('.rhine-board-count').textContent(),'18');
 console.log('PASS board count remains the total on page two');
 await store.recordSources(session,[{...sources[0],state:'read',agentRead:true,lineStart:3,lineEnd:9,content:'原文片段'}],'read-1');
 await store.recordSources(session,[{...sources[0],id:'new-delivery',documentId:'new-doc',documentUid:'new-uid',title:'新交付的资料'}],'search-3');
 await page.waitForFunction(()=>workbench.stats().sourceCount===235);
 assert.equal(store.reviewSummary(session).user_saved_count,0);
 await page.reload();
 await page.waitForFunction(()=>workbench.stats().heroLoaded&&workbench.stats().sourceCount===235);
 assert.equal(await page.evaluate(()=>workbench.stats().manualSourceCount),0);
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('prts-rhine-desk:v1:context-rack')).sources.length),0);
 console.log('PASS live delivery, read upgrade and reload do not create bookmarks');
 await store.saveRack(session,{action:'add',mutation_id:'bookmark',sources:[sources[0]]});
 await page.waitForFunction(()=>workbench.stats().manualSourceCount===1);
 assert.equal(await page.evaluate(()=>workbench.stats().sourceCount),235);
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('prts-rhine-desk:v1:context-rack')).sources.length),1);
 // Legacy hosts can deliver a snapshot without explicit provenance flags.
 await page.evaluate(()=>workbench.update({...snapshot,sources:[{id:'legacy-returned',title:'旧宿主工具返回',kind:'story',origin:'local',state:'found',excerpt:'返回的摘要'}]}));
 await page.waitForFunction(()=>workbench.stats().sourceCount===236);
 console.log('PASS bookmark persistence stays separate and legacy snapshots admit summaries');
 await page.screenshot({path:join(out,'restored.png')});
 await page.goto(url+'/?empty');
 await page.waitForFunction(()=>workbench.stats().heroLoaded&&workbench.stats().candidateCount===12);
 assert.equal(await page.evaluate(()=>workbench.stats().sourceCount),0);
 assert.equal(await page.evaluate(()=>workbench.stats().manualSourceCount),0);
 assert.deepEqual(errors,[]);
 await writeFile(join(out,'result.json'),JSON.stringify({passed:true,restored:234,clues:18,maxPageModels:24,browsingOnly:12,errors},null,2));
 console.log('PASS new session excludes all old deliveries and unsubmitted browsing');
}catch(error){await writeFile(join(out,'failure-state.json'),JSON.stringify(await page.evaluate(()=>({stats:workbench.stats(),root:document.querySelector('.rhine-workbench').outerHTML.slice(0,500),nav:[...document.querySelectorAll('[data-zone]')].map(e=>({zone:e.dataset.zone,visible:e.checkVisibility(),rect:e.getBoundingClientRect().toJSON()}))})),null,2)).catch(()=>{});await page.screenshot({path:join(out,'failure.png'),timeout:10000}).catch(()=>{});throw error;}finally{clearTimeout(deadline);server.closeAllConnections();server.close();await browserServer.kill();await browser.close();await store.close();}
