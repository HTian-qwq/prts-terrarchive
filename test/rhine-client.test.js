import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

let plugin
vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load({ factory }) { plugin = factory(() => ({})) } } },
  console, AbortController, setTimeout, clearTimeout,
})
const { buildRhineSnapshot, mergeArchiveSources, rhineSnapshotSignature, submitRhineQuestion } = plugin.__rhineStateForTest
const version = 'a'.repeat(64)
const source = { id: `document:${version}:doc_0123456789abcdef`, title: '孤星', kind: 'story', origin: 'cloud', state: 'found',
  documentId: 'official_game:story:demo', documentUid: 'doc_0123456789abcdef', dataVersion: version, excerpt: '真实召回摘录', ranges: [{ start: 2, end: 5 }] }
const tool = (name, meta, text = '返回原文') => ({ kind: 'tool-call', data: {
  root: { kind: 'tool-result', call: { name, argsRaw: '{"query":"克丽斯腾"}' }, meta,
    content: [{ type: 'text', text }] } } })
const readMeta = (start, end) => ({ kind: 'prts-corpus-read-v1', locator: { document_id: source.documentId },
  title: source.title, data_version: version, line_start: start, line_end: end,
  sources: [{ document_id: source.documentId, document_uid: source.documentUid, title: source.title, line_start: start, line_end: end }] })
const data = () => new Map([
  ['a', tool('cloud_search', { kind: 'prts-archive-sources-v1', sources: [source] })],
  ['b', tool('corpus_read', readMeta(4, 8))],
  ['c', { kind: 'user', data: {} }],
  ['d', tool('corpus_read', readMeta(15, 20))],
])

test('资料台跨轮保留返回资料，同版本云端/本地读取合并并保留不连续范围', () => {
  const nodes = data()
  const result = buildRhineSnapshot([...nodes.keys()], nodes, 'session-a', false)
  assert.equal(result.sessionId, 'session-a')
  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].id, source.id)
  assert.equal(result.sources[0].origin, 'cloud')
  assert.equal(result.sources[0].state, 'read')
  assert.deepEqual(JSON.parse(JSON.stringify(result.sources[0].readRanges)), [{ start: 4, end: 8 }, { start: 15, end: 20 }])
  assert.deepEqual(JSON.parse(JSON.stringify(result.sources[0].ranges)), [{ start: 2, end: 8 }, { start: 15, end: 20 }])
  assert.equal(result.records.length, 3)
  assert.equal(result.searching, false)
})
test('嵌套检索调用与业务失败通过明确状态进入调查记录', () => {
  const cloud = { callId: 'nested-cloud', name: 'cloud_search', argsRaw: '{"query":"莱茵"}', subCalls: [] }
  const nodes = new Map([['parallel', { kind: 'tool-call', data: { root: { name: 'parallel', subCalls: [cloud] } } }]])
  assert.equal(buildRhineSnapshot(['parallel'], nodes).searching, true)
  cloud.kind = 'tool-result'
  cloud.call = { name: 'cloud_search', argsRaw: '{}' }
  cloud.meta = { kind: 'prts-archive-sources-v1', sources: [], error: '远端查询超时' }
  cloud.content = [{ type: 'text', text: '请求失败' }]
  const result = buildRhineSnapshot(['parallel'], nodes)
  assert.equal(result.searching, false)
  assert.equal(result.records[0].id, 'parallel:nested-cloud')
  assert.equal(result.records[0].state, 'error')
  assert.equal(result.error, '远端查询超时')
})
test('只有真实进行中的工具触发检索，错误和推理文本不成为资料', () => {
  const nodes = new Map([
    ['a', { kind: 'tool-call', data: { root: { name: 'cloud_search', argsRaw: '{"query":"远程检索"}' } } }],
    ['b', { kind: 'assistant-step', data: { blocks: [{ kind: 'reasoning', text: '不可展示的内部推理' }] } }],
  ])
  let result = buildRhineSnapshot([...nodes.keys()], nodes, 'session-a')
  assert.equal(result.searching, true)
  assert.equal(result.query, '远程检索')
  assert.equal(result.sources.length, 0)
  assert.equal(result.answer, '')
  nodes.set('a', tool('cloud_search', { kind: 'prts-archive-sources-v1', sources: [source] }, '服务失败'))
  nodes.get('a').data.root.isError = true
  result = buildRhineSnapshot([...nodes.keys()], nodes)
  assert.equal(result.searching, false)
  assert.equal(result.sources.length, 0)
  assert.equal(result.records[0].state, 'error')
})
test('同标题不同版本不合并，原地更新和同长度文本仍触发订阅', () => {
  const nodes = data()
  const order = [...nodes.keys()]
  const before = rhineSnapshotSignature({ order, nodes })
  nodes.get('a').data.root.meta.sources = [{ ...source, dataVersion: 'b'.repeat(64), excerpt: '另一版本摘要' }]
  const after = rhineSnapshotSignature({ order, nodes })
  assert.notEqual(before, after)
  assert.equal(buildRhineSnapshot(order, nodes).sources.length, 2)
  assert.equal(buildRhineSnapshot([], new Map(), 'session-b').sources.length, 0)
})
test('Agent 提问使用指定会话的队列和提交身份；拒绝保留可重试错误', async () => {
  const calls = []
  let abandoned = 0
  let accepted = true
  const session = {
    beginSubmission(input) { calls.push(input); return { requestId: 'request-a', abandon() { abandoned++ } } },
    async prompt(...args) { calls.push(args); return { ok: accepted, error: { message: '会话离线' } } },
  }
  const ctx = { sessions: { binding(id) { assert.equal(id, 'session-a'); return { session } } } }
  await submitRhineQuestion(ctx, 'session-a', '阅读这些摘录')
  assert.equal(calls[0].mode, 'queue')
  assert.equal(calls[1][0][0].text, '阅读这些摘录')
  assert.equal(calls[1][3], 'request-a')
  assert.equal(abandoned, 0)
  accepted = false
  await assert.rejects(submitRhineQuestion(ctx, 'session-a', '再次调查'), /会话离线/)
  assert.equal(abandoned, 1)
})

const user = (text, kind = 'user') => ({ kind, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const assistant = (text, status = 'settled') => ({ kind: 'assistant-step', data: { status,
  blocks: [{ kind: 'reasoning', text: '不可展示的内部推理' }, { kind: 'text', text }] } })
const pending = (name, args) => ({ kind: 'tool-call', data: { root: { name, argsRaw: JSON.stringify(args) } } })
const snapshotOf = (nodes, running = false) => buildRhineSnapshot([...nodes.keys()], nodes, 'session-a', running)

test('中央调查问题来自用户原话，工具变体及注入上下文不会替换；新一轮不展示上一轮答案', () => {
  const nodes = new Map([
    ['user', user('克丽斯腾为何启动星荚计划？')],
    ['context', { kind: 'context', data: { content: [{ type: 'text', text: '系统注入内容' }] } }],
    ['search', pending('cloud_search', { query: '星荚计划 源石 能量' })],
  ])
  let result = snapshotOf(nodes)
  assert.equal(result.question, '克丽斯腾为何启动星荚计划？')
  assert.equal(result.query, '星荚计划 源石 能量')
  assert.equal(result.phase, 'searching')
  nodes.set('search', tool('cloud_search', { kind: 'prts-archive-sources-v1', sources: [source] }))
  nodes.set('answer', assistant('调查结果'))
  assert.equal(snapshotOf(nodes).phase, 'complete')
  nodes.set('next-user', user('接着查赛雷娅的立场', 'steering'))
  result = snapshotOf(nodes, true)
  assert.equal(result.question, '接着查赛雷娅的立场')
  assert.equal(result.answer, '')
  assert.equal(result.phase, 'synthesizing')
  assert.equal(result.sources.length, 1)
})

test('读取阶段使用真实定位；同名歧义与 cloud_inspect 不虚构当前文档', () => {
  const nodes = new Map([
    ['search', tool('corpus_search', { kind: 'prts-archive-sources-v1', sources: [source] })],
    ['read', pending('corpus_read', { document_uid: source.documentUid })],
  ])
  let result = snapshotOf(nodes)
  assert.equal(result.phase, 'reading')
  assert.equal(result.activeDocumentId, source.documentId)
  assert.equal(result.sources[0].state, 'found')
  nodes.set('read', pending('corpus_read', { locator: { source_ref: 'client_data:official_game:123:L9' } }))
  result = snapshotOf(nodes)
  assert.equal(result.activeSourceRef, 'client_data:official_game:123:L9')
  assert.equal(result.activeDocumentId, undefined)
  nodes.set('read', pending('corpus_read', { title: source.title }))
  assert.equal(snapshotOf(nodes).activeDocumentId, source.documentId)
  nodes.get('search').data.root.meta.sources.push({ ...source, id: 'other', documentId: 'other', documentUid: 'doc_1111111111111111' })
  assert.equal(snapshotOf(nodes).activeDocumentId, undefined)
  nodes.set('read', pending('cloud_inspect', { section: 'selected_sources', evidence_ids: ['opaque'] }))
  result = snapshotOf(nodes)
  assert.equal(result.phase, 'reading')
  assert.equal(result.activeDocumentId, undefined)
  assert.equal(result.query, 'selected_sources')
})

test('流式输出、工具失败、重试恢复与用户停止区分状态，不把失败报告标记完成', () => {
  const nodes = new Map([['user', user('调查问题')], ['answer', assistant('正在组织回答', 'running')]])
  assert.equal(snapshotOf(nodes).phase, 'synthesizing')
  nodes.set('answer', assistant('部分回答', 'interrupted'))
  assert.equal(snapshotOf(nodes).phase, 'error')
  nodes.set('answer', assistant('故障说明'))
  nodes.set('error', tool('cloud_search', { kind: 'prts-archive-sources-v1', sources: [], error: '远端超时' }))
  nodes.set('other', tool('corpus_read', readMeta(4, 8)))
  assert.equal(snapshotOf(nodes).phase, 'error')
  nodes.set('retry', tool('cloud_search', { kind: 'prts-archive-sources-v1', sources: [source] }))
  assert.equal(snapshotOf(nodes).phase, 'complete')
  nodes.set('fatal', { kind: 'turn-error', data: { message: '模型请求失败' } })
  assert.equal(snapshotOf(nodes).phase, 'error')
  assert.equal(snapshotOf(new Map()).phase, 'idle')
})

test('仅完整可验证引用标记 cited；裸标题、缩写、越界及未交付内容不算引用', () => {
  const nodes = new Map([['read', tool('corpus_read', readMeta(4, 8))]])
  for (const text of ['我提到了《孤星》。', '《孤》第 4 行', '《孤星》第 1 行', '《孤星》第 4–20 行']) {
    nodes.set('answer', assistant(text))
    assert.equal(snapshotOf(nodes).sources[0].state, 'read', text)
  }
  nodes.set('answer', assistant('依据《孤星》第 4–8 行。'))
  assert.equal(snapshotOf(nodes).sources[0].state, 'cited')
  nodes.set('answer', assistant(`依据《孤星》（document_uid=${source.documentUid}）第 5 行。`))
  assert.equal(snapshotOf(nodes).sources[0].state, 'cited')
  nodes.set('another', tool('corpus_read', { ...readMeta(4, 8), data_version: 'b'.repeat(64) }))
  // The new version arrives after this answer, so its citation only applies to
  // material already delivered at the moment of that visible answer.
  assert.equal(snapshotOf(nodes).sources[0].state, 'cited')
  assert.equal(snapshotOf(nodes).sources[1].state, 'read')
  nodes.delete('answer')
  nodes.set('answer', assistant(`《孤星》（document_uid=${source.documentUid}）第 5 行`))
  assert.deepEqual(Array.from(snapshotOf(nodes).sources, (item) => item.state), ['read', 'read'])
})

test('精确 source_ref 引用可识别，历史引用和资料顺序保留且读取不改分类', () => {
  const ref = 'client_data:official_game:012345678901234567890123:L4'
  const first = { ...source, sourceRef: ref }
  const second = { ...source, id: 'second', documentId: 'second', documentUid: 'doc_1111111111111111', title: '第二份' }
  const nodes = new Map([
    ['search', tool('corpus_search', { kind: 'prts-archive-sources-v1', sources: [first, second] })],
    ['answer', assistant(`原文 source_ref=${ref}`)],
    ['next', user('下一步')],
    ['read', tool('corpus_read', readMeta(4, 8))],
  ])
  let result = snapshotOf(nodes)
  assert.equal(result.sources[0].state, 'cited')
  assert.equal(result.sources[0].kind, 'story')
  assert.equal(result.sources[0].sourceRef, ref)
  assert.deepEqual(Array.from(result.sources, (item) => item.title), ['孤星', '第二份'])
  nodes.get('answer').data.blocks[1].text = `source_ref=${ref}99`
  result = snapshotOf(nodes)
  assert.equal(result.sources[0].state, 'read')
  const merged = mergeArchiveSources([second, ...result.sources])
  assert.deepEqual(Array.from(merged, (item) => item.title), ['第二份', '孤星'])
})

test('Wiki 引用限定到实际返回的字段，不因读过同一文档就标记其他字段被引用', () => {
  const nodes = new Map([
    ['read', tool('corpus_read', readMeta(4, 8), '实际返回内容\n引用：《孤星》Wiki·简介')],
    ['answer', assistant('依据《孤星》Wiki·简介。')],
  ])
  assert.equal(snapshotOf(nodes).sources[0].state, 'cited')
  nodes.set('answer', assistant('依据《孤星》Wiki·背景设定。'))
  assert.equal(snapshotOf(nodes).sources[0].state, 'read')
})

test('当前阅读版本只能取自实际调用，明确版本可区分同文档的两个版本', () => {
  const otherVersion = 'b'.repeat(64)
  const nodes = new Map([
    ['search', tool('corpus_search', { kind: 'prts-archive-sources-v1', sources: [source,
      { ...source, id: `document:${otherVersion}:${source.documentUid}`, dataVersion: otherVersion }] })],
    ['read', pending('corpus_read', { document_uid: source.documentUid, data_version: otherVersion })],
  ])
  let result = snapshotOf(nodes)
  assert.equal(result.activeDocumentId, source.documentId)
  assert.equal(result.activeDataVersion, otherVersion)
  nodes.set('read', pending('corpus_read', { document_uid: source.documentUid }))
  result = snapshotOf(nodes)
  assert.equal(result.activeDocumentId, undefined)
  assert.equal(result.activeDataVersion, undefined)
  nodes.set('read', pending('corpus_read', { locator: { document_id: source.documentId }, data_version: 'release-short-name' }))
  assert.equal(snapshotOf(nodes).activeDataVersion, undefined)
  nodes.set('read', pending('corpus_read', { locator: { document_id: source.documentId }, dataVersion: version }))
  assert.equal(snapshotOf(nodes).activeDataVersion, version)
})

test('远端正文引用后保留已读，直接引用检索摘录不会制造已读事实', () => {
  const remote = { id: 'remote-body', title: '远端原文', kind: 'cloud_source', origin: 'cloud',
    state: 'read', excerpt: '实际返回正文', ranges: [{ start: 1, end: 3 }] }
  const nodes = new Map([
    ['inspect', tool('cloud_inspect', { kind: 'prts-archive-sources-v1', sources: [remote] })],
    ['search', tool('corpus_search', { kind: 'prts-archive-sources-v1', sources: [source] })],
    ['answer', assistant('依据《远端原文》第 1–3 行和《孤星》第 2–5 行。')],
  ])
  const result = snapshotOf(nodes)
  assert.deepEqual(Array.from(result.sources, item => item.state), ['cited', 'cited'])
  assert.equal(result.sources[0].agentRead, true)
  assert.equal(result.sources[0].readRanges.length, 0)
  assert.equal(result.sources[1].agentRead, false)
  const merged = mergeArchiveSources([result.sources[0], { ...remote, state: 'found', agentRead: false }])
  assert.equal(merged[0].agentRead, true)
  assert.equal(merged[0].state, 'cited')
  const invalid = mergeArchiveSources([{ ...source, state: 'cited', readRanges: [{ start: 0, end: 2 }] }])
  assert.equal(invalid[0].agentRead, false)
  const valid = mergeArchiveSources([{ ...source, state: 'cited', readRanges: [{ start: 2, end: 3 }] }])
  assert.equal(valid[0].agentRead, true)
})
