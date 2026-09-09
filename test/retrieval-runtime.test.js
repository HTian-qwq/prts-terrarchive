import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../src/index.js'
import { CorpusStore, computeLinesIntegrity, naturalDocumentTitle } from '../src/store.js'
import { CLOUD_CONTRACT_VERSION } from '../src/cloud.js'
import { attachLocalSourceMappings } from '../src/source-map.js'
import { projectCloudInspect, projectCloudSearch } from '../src/cloud-projection.js'

async function pluginFixture(t, { record, cloud } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'prts-retrieval-runtime-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const effects = []
  const registered = new Map()
  t.after(async () => {
    for (const dispose of effects.reverse()) dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  })
  if (record) {
    t.mock.method(CorpusStore.prototype, 'ready', async function () {
      this.dataVersion = 'a'.repeat(64)
      this.documents.set(record.document.document_id, { document: record.document })
      this.naturalTitleIndex.set(naturalDocumentTitle(record.document), [record.document.document_id])
      this.packs.set('references', {})
    })
    t.mock.method(CorpusStore.prototype, 'getDocument', async (id) =>
      id === record.document.document_id ? { record, packId: 'references' } : null)
  }
  const ctx = {
    tools: { register: (definition) => {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    } },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
      return dispose
    },
    inject: (dependencies, callback) => dependencies.includes('tools') ? callback(ctx) : undefined,
    logger: { warn() {}, info() {} },
  }
  await apply(ctx, { releasesDir: join(home, 'releases'), registerUi: false,
    enabledGames: ['arknights'], ...(cloud ? { cloud } : {}) })
  const events = []
  const agent = { session: { eventAt(seq) { return events[seq] }, surface: { nodes: [] } } }
  const read = registered.get('corpus_read')
  const markVisible = (callId, value) => {
    const seq = events.length
    events.push({ type: 'tool/result', data: { message: {
      source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId,
        content: read.output.render({}, value), isError: false }],
    } } })
    agent.session.surface.nodes.push(seq)
  }
  return { registered, read, agent, markVisible }
}

function readingRecord(lineLength = 8) {
  const lines = Array.from({ length: 10 }, (_, index) => ({ line_number: index + 1,
    line_type: 'narration', speaker_raw: '', text: `${index + 1}`.padEnd(lineLength, '甲') }))
  return { document: { document_id: 'client:references:runtime', document_type: 'reference',
    document_kind: 'reference', display_title: '分页资料', line_count: lines.length,
    source_ref_prefix: `client_data:references:${'b'.repeat(24)}` },
    lines, local_integrity: { sha256: computeLinesIntegrity(lines) } }
}

test('重复已可见的文档页保留续读位置，只有末页结束分页', async (t) => {
  const { read, agent, markVisible } = await pluginFixture(t, { record: readingRecord() })
  let request = { title: '分页资料', mode: 'document', max_lines: 3 }
  const seen = []
  for (let page = 0; page < 4; page += 1) {
    const first = await read.execute(request, { agent, callId: `first-${page}` })
    markVisible(`first-${page}`, first)
    const repeated = await read.execute(request, { agent, callId: `repeat-${page}` })
    assert.deepEqual(repeated.page, first.page)
    assert.deepEqual(repeated.primary.selection, first.primary.selection)
    assert.deepEqual(repeated.primary.lines, first.primary.lines)
    seen.push(...repeated.primary.lines.map((line) => line.line))
    if (page === 3) {
      assert.equal(repeated.page.has_more, false)
      assert.equal(repeated.page.continuation, null)
    } else {
      assert.equal(repeated.page.has_more, true)
      assert.match(read.output.render({}, repeated)[0].text, /继续阅读/u)
      request = { ...repeated.page.continuation, max_lines: 3 }
    }
  }
  assert.deepEqual(seen, Array.from({ length: 10 }, (_, index) => index + 1))
})

test('部分覆盖只返回本页新行，同时保留全文续页与可见覆盖说明', async (t) => {
  const { read, agent, markVisible } = await pluginFixture(t, { record: readingRecord() })
  const seed = await read.execute({ title: '分页资料', line: 2, before: 0, after: 0 },
    { agent, callId: 'seed' })
  markVisible('seed', seed)
  const request = { title: '分页资料', mode: 'document', max_lines: 4 }
  const partial = await read.execute(request, { agent, callId: 'partial' })
  assert.deepEqual(partial.primary.lines.map((line) => line.line), [1, 3, 4])
  assert.equal(partial.page.has_more, true)
  assert.equal(partial.page.continuation.line, 5)
  assert.deepEqual(partial.coverage, { requested_range: { line_start: 1, line_end: 4 },
    reused_ranges: [{ line_start: 2, line_end: 2 }],
    fetched_ranges: [{ line_start: 1, line_end: 1 }, { line_start: 3, line_end: 4 }], complete: true })
  assert.match(read.output.render({}, partial)[0].text, /复用上文：第 2 行/u)
  markVisible('partial', partial)
  const repeated = await read.execute(request, { agent, callId: 'repeated' })
  assert.deepEqual(repeated.primary.lines.map((line) => line.line), [1, 2, 3, 4])
  assert.deepEqual(repeated.page.continuation, partial.page.continuation)
  const next = await read.execute(partial.page.continuation, { agent, callId: 'next' })
  assert.equal(next.primary.lines[0].line, 5)
  assert.equal(next.page.has_more, false)
})

test('部分覆盖仍按整页字符预算截断，续页不会跨过尚未交付的行', async (t) => {
  const { read, agent, markVisible } = await pluginFixture(t, { record: readingRecord(40) })
  const seed = await read.execute({ title: '分页资料', line: 2, before: 0, after: 0 },
    { agent, callId: 'seed' })
  markVisible('seed', seed)
  const page = await read.execute({ title: '分页资料', mode: 'document', max_lines: 10, max_chars: 100 },
    { agent, callId: 'limited' })
  assert.deepEqual(page.primary.lines.map((line) => line.line), [1])
  assert.deepEqual(page.coverage.requested_range, { line_start: 1, line_end: 2 })
  assert.equal(page.page.continuation.line, 3)
  const next = await read.execute({ ...page.page.continuation, max_chars: 100 },
    { agent, callId: 'next' })
  assert.deepEqual(next.primary.lines.map((line) => line.line), [3, 4])
})

test('完整缓存命中仍验证本次预算并允许更小的字符上限', async (t) => {
  const { read, agent, markVisible } = await pluginFixture(t, { record: readingRecord(40) })
  const original = await read.execute({ title: '分页资料', mode: 'document' },
    { agent, callId: 'original' })
  markVisible('original', original)
  const smaller = await read.execute({ title: '分页资料', mode: 'document', max_chars: 100 },
    { agent, callId: 'smaller' })
  assert.deepEqual(smaller.primary.lines.map((line) => line.line), [1, 2])
  assert.equal(smaller.page.continuation.line, 3)
  await assert.rejects(read.execute({ title: '分页资料', mode: 'document', max_lines: 0 },
    { agent, callId: 'invalid-budget' }), (error) => error.code === 'INVALID_REQUEST')
  await assert.rejects(read.execute({ title: '分页资料', line: 11 },
    { agent, callId: 'beyond-document' }), (error) => error.code === 'LINE_RANGE_INVALID')
})

test('读取回放在范围定位期间切版后拒绝返回旧版可见缓存', async (t) => {
  const { read, agent, markVisible } = await pluginFixture(t, { record: readingRecord() })
  const request = { title: '分页资料', mode: 'document', max_lines: 3,
    data_version: 'a'.repeat(64) }
  const first = await read.execute(request, { agent, callId: 'first' })
  markVisible('first', first)
  let readyCalls = 0
  CorpusStore.prototype.ready.mock.mockImplementation(async function () {
    if (++readyCalls === 2) {
      // 第一次 requireLocalCorpus 仍是旧版；resolveReadWindow 恢复时新版已提交。
      this._generation += 1
      this.dataVersion = 'b'.repeat(64)
    }
  })
  await assert.rejects(read.execute(request, { agent, callId: 'replay' }), (error) => {
    assert.equal(error.code, 'PACKAGE_VERSION_MISMATCH')
    assert.equal(error.retryable, true)
    return true
  })
  assert.equal(readyCalls, 2)
})

test('定位文档期间切版由工具执行层保留可重试版本错误', async (t) => {
  const record = readingRecord()
  const { read, agent } = await pluginFixture(t, { record })
  t.mock.method(CorpusStore.prototype, 'getDocumentByTitle', async function () {
    this._generation += 1
    this.dataVersion = 'b'.repeat(64)
    throw Object.assign(new Error('资料版本在读取期间发生变化，请重试'), {
      code: 'PACKAGE_VERSION_MISMATCH', retryable: true,
    })
  })
  await assert.rejects(read.execute({ title: '分页资料', mode: 'document' },
    { agent, callId: 'changed-locator' }), (error) => {
    assert.equal(error.code, 'PACKAGE_VERSION_MISMATCH')
    assert.equal(error.retryable, true)
    return true
  })
})

test('搜索执行层不会缓存或交付读取期间切版的搜索结果', async (t) => {
  const record = readingRecord()
  const { registered, agent } = await pluginFixture(t, { record })
  t.mock.method(CorpusStore.prototype, 'orderedDocumentIds', () => [record.document.document_id])
  CorpusStore.prototype.getDocument.mock.mockImplementation(async function () {
    this._generation += 1
    this.dataVersion = 'b'.repeat(64)
    return { record, packId: 'references' }
  })
  await assert.rejects(registered.get('corpus_search').execute({ query: '分页资料' },
    { agent, callId: 'changed-search' }), (error) => {
    assert.equal(error.code, 'PACKAGE_VERSION_MISMATCH')
    assert.equal(error.retryable, true)
    return true
  })
})

test('未安装本地包时云端答案和最近请求仍可读取，附带本地核验提示', async (t) => {
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = new URL(url).pathname
    if (path.endsWith('/capabilities')) return Response.json({ code: 200,
      data: { contract_version: CLOUD_CONTRACT_VERSION } })
    bodies.push(JSON.parse(init.body))
    const data = path.endsWith('/search')
      ? { request: { request_id: 'req-cloud' }, answer_context: '云端提供的答案。',
          sources: [{ source_file: 'stories/test.txt', start_line: 1, title: '云端原文' }] }
      : { request_id: 'req-cloud', items: [{ source_file: 'stories/test.txt', content: '云端详细材料。' }] }
    return Response.json({ code: 200, data })
  })
  const { registered, agent } = await pluginFixture(t,
    { cloud: { baseUrl: 'https://prts.chat', token: 'fixture-token' } })
  const search = registered.get('cloud_search')
  const answer = await search.execute({ query: '测试' }, { agent })
  assert.equal(answer.code, 200)
  assert.match(search.output.render({}, answer)[0].text, /云端提供的答案/u)
  assert.match(search.output.render({}, answer)[0].text, /本地原文映射暂不可用/u)
  const inspect = registered.get('cloud_inspect')
  const details = await inspect.execute({ section: 'selected_sources' }, { agent })
  assert.equal(bodies[1].request_id, 'req-cloud')
  assert.equal(details.code, 200)
  assert.match(inspect.output.render({}, details)[0].text, /云端详细材料/u)
  assert.match(inspect.output.render({}, details)[0].text, /本地原文映射暂不可用/u)
})

test('已缓存的非 Wiki 文档也不能使用 Wiki section 读取', async (t) => {
  const record = readingRecord()
  record.lines[0].text = '<详细介绍>'
  record.lines[2].text = '</详细介绍>'
  record.local_integrity.sha256 = computeLinesIntegrity(record.lines)
  const { read, agent, markVisible } = await pluginFixture(t, { record })
  const original = await read.execute({ title: '分页资料', mode: 'document' },
    { agent, callId: 'original' })
  markVisible('original', original)
  await assert.rejects(read.execute({ title: '分页资料', section: '详细介绍' },
    { agent, callId: 'invalid-section' }), (error) => error.code === 'INVALID_REQUEST')
})

test('本地映射损坏保留云端材料，但取消信号仍向上传播', async () => {
  const response = () => ({ code: 200, data: { answer_context: '可用云端正文',
    sources: [{ source_file: 'example.txt' }] } })
  const brokenStore = { ready: async () => { throw Object.assign(new Error('private local path'),
    { code: 'INDEX_CORRUPT' }) } }
  const result = await attachLocalSourceMappings(brokenStore, response())
  assert.equal(result.code, 200)
  assert.match(projectCloudSearch(result), /可用云端正文/u)
  assert.doesNotMatch(JSON.stringify(result), /private local path/u)
  assert.equal(projectCloudInspect(result).payload.warnings[0].code, 'LOCAL_SOURCE_MAPPING_UNAVAILABLE')
  const cancelled = Object.assign(new Error('cancelled'), { code: 'CANCELLED' })
  await assert.rejects(attachLocalSourceMappings({ ready: async () => { throw cancelled } }, response()),
    (error) => error === cancelled)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(attachLocalSourceMappings(brokenStore, response(), { signal: controller.signal }))
})

test('最后一次本地映射读取期间取消也不会返回成功结果', async () => {
  const controller = new AbortController()
  const store = { ready: async () => {}, getDocument: async () => {
    controller.abort()
    return { record: readingRecord() }
  } }
  await assert.rejects(attachLocalSourceMappings(store, { code: 200,
    data: { sources: [{ document_id: 'client:references:runtime' }] } },
  { signal: controller.signal }), (error) => error.code === 'CANCELLED')
})
