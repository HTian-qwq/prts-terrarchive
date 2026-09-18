import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { latestReadFocus } from '../ui/rhine/tool-activity.ts'

let plugin
vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load({ factory }) { plugin = factory(() => ({})) } } },
  console, URL, AbortController, setTimeout, clearTimeout,
})
const { buildRhineSnapshot } = plugin.__rhineStateForTest
const pageUrl = 'https://example.test/arknights'
const pending = (name, args) => ({ kind: 'tool-call', data: { root: { name, argsRaw: JSON.stringify(args) } } })
const returned = (name, args, meta, text, isError = false) => ({ kind: 'tool-call', data: { root: {
  kind: 'tool-result', call: { name, argsRaw: JSON.stringify(args) }, meta, content: [{type:'text',text}], isError,
} } })
const search = () => returned('web_search', { queries:['莱茵生命','孤星剧情'] }, { truncated:false, sources:[
  { url:pageUrl+'#intro', title:'莱茵生命资料', snippet:'检索摘要' },
  { url:'https://example.test/lone-trail', title:'孤星剧情', snippet:'另一条摘要' },
] }, '检索返回文本')
const snapshot = nodes => buildRhineSnapshot([...nodes.keys()], nodes, 'web-session', true)

test('web search registers discovered pages; fetching upgrades that same page and retains the entire returned body', () => {
  const nodes = new Map([['search',search()]])
  let view = snapshot(nodes)
  assert.equal(view.sources.length, 2)
  assert.equal(view.sources[0].state, 'found')
  assert.equal(view.sources[0].url, pageUrl)
  assert.equal(view.operations[0].kind, 'search')
  assert.equal(view.operations[0].sourceIds.length, 2)
  assert.equal(view.toolCalls[0].query, '莱茵生命 · 孤星剧情')
  nodes.set('fetch',pending('web_fetch',{url:pageUrl}))
  view = snapshot(nodes)
  assert.equal(view.phase,'reading')
  assert.equal(view.operations.at(-1).url,pageUrl)
  assert.equal(latestReadFocus(view,view.sources).source.title,'莱茵生命资料')
  assert.equal(view.sources[0].state,'found','starting a fetch is not evidence it has returned')
  const content = '# 网页正文\n'+ '正文段落。'.repeat(800) + '\nEND-OF-RETURNED-PAGE'
  nodes.set('fetch',returned('web_fetch',{url:pageUrl},{url:pageUrl,statusCode:200,truncated:true},content))
  view = snapshot(nodes)
  assert.equal(view.sources.length,2)
  const page = view.sources[0]
  assert.equal(page.id,`web:${pageUrl}`)
  assert.equal(page.title,'莱茵生命资料')
  assert.equal(page.state,'read')
  assert.equal(page.content,content)
  assert.equal(page.contentTruncated,true)
  assert.equal(view.operations.at(-1).sourceIds[0],page.id)
  nodes.set('repeat-search',search())
  view=snapshot(nodes)
  assert.equal(view.sources.length,2)
  assert.equal(view.sources[0].content,content,'a later search summary must not replace a fetched page body')
  assert.equal(view.sources[0].state,'read')
})

test('a direct or nested web_fetch has a live reading card before any search result exists', () => {
  const one={callId:'one', name:'web_fetch',argsRaw:JSON.stringify({url:pageUrl})}
  const two={callId:'two', name:'web_fetch',argsRaw:JSON.stringify({url:'https://example.test/other'})}
  const nodes=new Map([['parallel',{kind:'tool-call',data:{root:{name:'parallel',subCalls:[one,two]}}}]])
  const view=snapshot(nodes)
  assert.equal(view.operations.length,2)
  assert.equal(view.sources.length,0,'pending cards do not fabricate material-rack receipts')
  const focus=latestReadFocus(view,view.sources)
  assert.equal(focus.operation.id,'parallel:two')
  assert.equal(focus.source.url,'https://example.test/other')
  assert.equal(focus.source.origin,'web')
  const repeat=snapshot(nodes)
  assert.equal(latestReadFocus(repeat,repeat.sources).key,focus.key)
})

test('failed fetches do not become read sources; unsafe URLs and unrelated text do not become pages', () => {
  const nodes=new Map([['search',search()],['fetch',returned('web_fetch',{url:pageUrl},{url:pageUrl,statusCode:404,truncated:false},'Not found')]])
  let view=snapshot(nodes)
  assert.equal(view.operations.at(-1).state,'error')
  assert.equal(view.toolCalls.at(-1).state,'error')
  assert.equal(view.operations.at(-1).sourceIds.length,0)
  assert.equal(view.sources[0].state,'found')
  nodes.set('bad',returned('web_search',{queries:['q']},{sources:[{url:'javascript:alert(1)',title:'bad'},{url:'https://user:secret@example.test/private',title:'bad'}]},'https://unattributed.test'))
  nodes.set('other',returned('bash',{},null,'https://not-a-search-result.test'))
  view=snapshot(nodes)
  assert.equal(view.sources.length,2)
})

test('redirected fetch keeps the discovered page identity while linking to its returned URL', () => {
  const nodes=new Map([['search',search()],['fetch',returned('web_fetch',{url:pageUrl},{url:pageUrl+'/canonical',statusCode:200,truncated:false},'# 内容\n返回内容')]])
  const view=snapshot(nodes)
  assert.equal(view.sources.length,2)
  assert.equal(view.sources[0].id,`web:${pageUrl}`)
  assert.equal(view.sources[0].url,pageUrl+'/canonical')
  assert.equal(latestReadFocus(view,view.sources).source.id,view.sources[0].id)
})
