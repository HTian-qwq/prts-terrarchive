/** Exercise PRTS against the selected checkout's actual scoped tools and domain storage. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Storage from '@deepseek-ai/dsh-storage'
import Skills from '@deepseek-ai/dsh-skill'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
const [pluginRoot, dshRoot] = process.argv.slice(2)
const fromHost = (path: string) => import(pathToFileURL(join(dshRoot,path)).href)
const { MemoryStorageBackend } = await fromHost('packages/storage/storage-domain/tests/helpers/memory-backend.ts')
const { applyWebFetchTool } = await fromHost('packages/web/tool-web/src/fetch.ts')
const { applyWebSearchTool } = await fromHost('packages/web/tool-web/src/search.ts')
const { acquireInvestigationStore, createInvestigationStore } = await import(pathToFileURL(join(pluginRoot,'src/investigation-store.js')).href)
const { mountInvestigationTools } = await import(pathToFileURL(join(pluginRoot,'src/investigation-tools.js')).href)
const { mountWebGuidance } = await import(pathToFileURL(join(pluginRoot,'src/web-guidance.js')).href)
const { createSharedState } = await import(pathToFileURL(join(pluginRoot,'src/state.js')).href)
const { apply: applySkills } = await import(pathToFileURL(join(pluginRoot,'src/skill.js')).href)
const home = await mkdtemp(join(tmpdir(),'prts-investigation-skin-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const shared = createSharedState({configPath:join(home,'prts-corpus.json'),releasesDir:join(home,'releases')})
const hostConfig = createSharedState({configPath:join(home,'prts-corpus.json'),releasesDir:join(home,'releases')})
const stopConfig = await shared.watchConfig()
const selectSkin = async (uiSkin:string) => {
  await hostConfig.saveConfig({uiSkin})
  const enabled = uiSkin === 'rhine-lab'
  for(let n=0;n<100;n++) {
    const skill = await root.skills.get('prts-investigation',{scope:agent})
    const tools = root.tools.schemas(agent).filter(tool=>tool.name.startsWith('investigation_'))
    if(Boolean(skill)===enabled && tools.length===(enabled?5:0)) return
    await delay(20)
  }
  assert.fail(`skill catalog did not follow ${uiSkin}`)
}
const root = new Context()
const agent = {session:{id:'dsh-runtime-test'},id:'dsh-runtime-test'}
const url='https://fixture.invalid/page'
let searchFails = false
let serial = 0
let hostHandle, agentHandle, scope
try {
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  await root.plugin(Storage)
  await root.plugin(Skills)
  root.storage.backend.register('memory',new MemoryStorageBackend())
  const facility = new DomainFacility(root,{backend:'memory',routes:{}})
  root.storage.mount('domain',facility)
  root.provide('storageDomain',facility)
  const previous=createInvestigationStore(facility)
  await previous.createUserBoard('dsh-runtime-test',{mutation_id:'cold-board',title:'重启前保存的调查板'})
  await previous.close()
  root.provide('web',{
    async search(){
      if(searchFails)throw Object.assign(new Error('DeepSeek search has no API key'),{code:'WEB_PROVIDER_CREDENTIAL_MISSING'})
      return {sources:[{url,title:'测试网页',snippet:'检索摘要'}],truncated:false}
    },
    async fetch(){return {url,statusCode:200,truncated:false,body:{kind:'html',content:
      '<h1>可见标题</h1><p>已交付的开头</p><div hidden>隐藏内容不可引用</div>'+'<p>正常文字</p>'.repeat(300)+'<p>未交付的尾部</p>'}}},
  })
  await root.plugin({inject:['storageDomain'],apply(ctx){hostHandle=acquireInvestigationStore(ctx.storageDomain);ctx.effect(()=>hostHandle.release)}})
  await root.plugin({inject:['tools','systemPrompt','storageDomain','web'],apply(ctx){scope=createScope(ctx,agent)}})
  await scope.ctx.plugin({inject:['tools','systemPrompt','storageDomain','web'],apply(ctx){
    agentHandle=acquireInvestigationStore(ctx.storageDomain)
    ctx.effect(()=>agentHandle.release)
    mountInvestigationTools(ctx,agentHandle.service,shared)
    mountWebGuidance(ctx)
    applyWebFetchTool(ctx,1000,600)
    applyWebSearchTool(ctx,10,4,1000,true)
  }})
  await scope.ctx.plugin({inject:['skills'],apply:applySkills})
  assert.equal(hostHandle.service,agentHandle.service,'Host and Agent share a single open-domain owner')
  const store=hostHandle.service
  const execute=(name:string,args:object)=>root.tools.execute({name,arguments:args,callId:`call-${++serial}`,agent,signal:new AbortController().signal})
  const success=async(name:string,args:object)=>{const result=await execute(name,args);assert.equal(result.isError,false,JSON.stringify(result));return result}
  for(const skin of ['harness','prts-agent','endfield-aic']) {
    await selectSkin(skin)
    assert(!root.tools.schemas(agent).some(tool=>tool.name.startsWith('investigation_')))
    assert(!(await root.systemPrompt.assemble({scope:agent})).contexts.some(entry=>entry.name==='prts-terrarchive:investigations'))
    const unavailable=await execute('investigation_open',{mode:'new',title:'不该创建',objective:'普通对话',reason:'测试'})
    assert.equal(unavailable.isError,true)
    assert(await root.skills.get('prts-retrieval',{scope:agent}))
  }
  await selectSkin('rhine-lab')
  assert.equal(root.tools.schemas(agent).filter(tool=>tool.name.startsWith('investigation_')).length,5)
  root.emit(scopeTarget(root,agent),'agent/inbox/claimed',{agent,turn:1,message:{}})
  // DSH assembles contexts before agent/pre-step, including on the first cold turn.
  const firstAssembly=await root.systemPrompt.assemble({scope:agent})
  const firstContext=firstAssembly.contexts.find(entry=>entry.name==='prts-terrarchive:investigations')?.text
  assert.match(firstContext||'',/重启前保存的调查板/)
  assert.match(firstContext||'',/"pending_count":1/)
  await root.waterfall(scopeTarget(root,agent),'agent/pre-step',{agent,turn:1,step:1,messages:[],signal:new AbortController().signal},async()=>({kind:'enter',messages:[]}))
  const opened=await success('investigation_open',{mode:'new',title:'DSH 原生回归',objective:'核对接口',reason:'测试'})
  const binding=opened.value
  await success('web_search',{queries:['fixture']})
  assert.equal((await store.read(agent.session.id,{section:'rack'})).total,1)
  const fetched=await success('web_fetch',{url})
  assert(Object.isFrozen(fetched));assert(Object.isFrozen(fetched.value))
  const text=fetched.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')
  assert(text.includes('已交付的开头'));assert(!text.includes('隐藏内容不可引用'));assert(!text.includes('未交付的尾部'))
  assert.equal(fetched.meta.truncated,true)
  const receipt=(await store.read(agent.session.id,{section:'source',source_id:'R0001'})).source
  assert.equal(receipt.content,text);assert.equal(receipt.contentTruncated,true)
  assert.equal(receipt.agentReceived,true);assert.equal(receipt.agentRead,true)
  const saved=await success('investigation_update',{...binding,expected_revision:0,clues:[{client_key:'one',title:'已核验',sources:[{source_id:'R0001',quote:'已交付的开头'}]}]})
  const denied=await execute('investigation_update',{...binding,expected_revision:saved.value.revision,clues:[{title:'不可见',sources:[{source_id:'R0001',quote:'未交付的尾部'}]}]})
  assert.equal(denied.isError,true)
  assert.match(denied.content[0].text,/摘录不在/)
  const recalled=await success('investigation_get',{section:'source',source_id:'R0001'})
  assert(!JSON.stringify(recalled.content).includes('"_review"'))
  searchFails=true
  const failed=await execute('web_search',{queries:['fixture']});assert.equal(failed.isError,true)
  const context=JSON.stringify((await root.systemPrompt.assemble({scope:agent})).contexts)
  assert(context.includes('WEB_PROVIDER_CREDENTIAL_MISSING'))
  assert(!JSON.stringify((await root.systemPrompt.assemble({scope:{session:{id:'other'}}})).contexts).includes('WEB_PROVIDER_CREDENTIAL_MISSING'))
  searchFails=false;await success('web_search',{queries:['fixture']})
  assert(!JSON.stringify((await root.systemPrompt.assemble({scope:agent})).contexts).includes('WEB_PROVIDER_CREDENTIAL_MISSING'))
  assert.equal((await store.read('other',{section:'rack'})).total,0)
  // Switch the same live Agent away and back: remove tools/prompt/skill while
  // preserving the original board, receipts, references and run identity.
  await selectSkin('prts-agent')
  assert(!root.tools.schemas(agent).some(tool=>tool.name.startsWith('investigation_')))
  assert(!(await root.systemPrompt.assemble({scope:agent})).contexts.some(entry=>entry.name==='prts-terrarchive:investigations'))
  assert.equal((await execute('investigation_publish',{...binding,title:'不该发布'})).isError,true)
  await selectSkin('rhine-lab')
  assert.equal(root.tools.schemas(agent).filter(tool=>tool.name.startsWith('investigation_')).length,5)
  const resumed=await success('investigation_get',{board_id:binding.board_id,section:'clues'})
  assert.equal(resumed.value.clues.length,1)
  assert.equal(resumed.value.board_id,binding.board_id)
  assert.match(JSON.stringify((await root.systemPrompt.assemble({scope:agent})).contexts),/DSH 原生回归/)
  await scope.dispose();scope=undefined
  assert(!root.tools.schemas(agent).some(tool=>tool.name==='investigation_get'))
  assert.equal((await store.read(agent.session.id,{section:'rack'})).total,1,'Host keeps the archive after the Agent unloads')
  console.log('DSH native investigation compatibility passed: scoped tools, frozen results, exact web delivery, quotes, context, storage, disposal')
}finally{
  await scope?.dispose()
  await root.fiber.dispose()
  stopConfig()
  if(previousHome===undefined)delete process.env.DSH_HOME
  else process.env.DSH_HOME=previousHome
  await rm(home,{recursive:true,force:true})
}
