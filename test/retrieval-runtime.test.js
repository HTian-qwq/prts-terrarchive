import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../src/index.js'
import { CorpusStore, computeLinesIntegrity, documentUid, naturalDocumentTitle } from '../src/store.js'
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
    t.mock.method(CorpusStore.prototype, 'getDocumentIdByUid', (uid) =>
      uid === documentUid(record.document.document_id) ? record.document.document_id : null)
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
  assert.equal(partial.page.continuation.start_line, 5)
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
  assert.equal(page.page.continuation.start_line, 3)
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
  assert.equal(smaller.page.continuation.start_line, 3)
  await assert.rejects(read.execute({ title: '分页资料', mode: 'document', max_lines: -1 },
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

test('mode=document 拒绝 line，并给出可执行的 start_line 写法', async (t) => {
  const { read } = await pluginFixture(t, { record: readingRecord() })
  await assert.rejects(read.execute({ title: '分页资料', mode: 'document', line: 5 }, {}),
    (error) => error.code === 'INVALID_REQUEST' && /start_line/u.test(error.message))
  // around 模式仍然按中心行工作：line 的语义没有被削弱。
  const around = await read.execute({ title: '分页资料', line: 5 }, {})
  assert.deepEqual(around.primary.lines.map((line) => line.line), [2, 3, 4, 5, 6, 7, 8])
})

test('start_line 从指定行连续读取到文末，续读参数可原样回传', async (t) => {
  const { read, agent } = await pluginFixture(t, { record: readingRecord() })
  let request = { title: '分页资料', mode: 'document', start_line: 6, max_lines: 2 }
  const seen = []
  for (let page = 0; page < 3; page += 1) {
    const result = await read.execute(request, { agent, callId: `cont-${page}` })
    seen.push(...result.primary.lines.map((line) => line.line))
    if (!result.page.has_more) break
    assert.equal(result.page.continuation.start_line, result.primary.selection.line_end + 1)
    assert.equal(result.page.continuation.line, undefined, '续读参数不再复用 line 字段')
    assert.match(read.output.render({}, result)[0].text, /start_line/u)
    request = { ...result.page.continuation, max_lines: 2 }
  }
  assert.deepEqual(seen, [6, 7, 8, 9, 10])
})

test('原文行渲染带出溯源行号，引用可以回查到具体那一句', async (t) => {
  const record = readingRecord()
  record.lines = record.lines.map((line, index) => (index === 0
    ? { ...line, source_line_id: 'dlg_e12m5_6' } : line))
  record.local_integrity = { sha256: computeLinesIntegrity(record.lines) }
  const { read, agent } = await pluginFixture(t, { record })
  const page = await read.execute({ title: '分页资料', mode: 'document', max_lines: 3 },
    { agent, callId: 'sourced' })
  const text = read.output.render({}, page)[0].text
  assert.match(text, /〔dlg_e12m5_6〕/u)
  assert.equal(page.primary.lines[0].source_line_id, 'dlg_e12m5_6')
})

test('citation 句柄能直接回到原文某几行，与 title/line 互斥', async (t) => {
  const record = readingRecord()
  const { read, agent } = await pluginFixture(t, { record })
  const uid = documentUid(record.document.document_id)
  const page = await read.execute({ citation: `${uid}#L3-L5` }, { agent, callId: 'by-handle' })
  assert.deepEqual(page.primary.lines.map((line) => line.line), [3, 4, 5])
  await assert.rejects(read.execute({ citation: `${uid}#L3-L5`, title: '分页资料' }, { agent, callId: 'conflict' }),
    (error) => error.code === 'INVALID_REQUEST' && /同时提交/u.test(error.message))
  await assert.rejects(read.execute({ citation: '分页资料#L3' }, { agent, callId: 'bad' }),
    (error) => error.code === 'INVALID_REQUEST' && /citation 格式/u.test(error.message))
})

test('续页参数只包含工具输出 schema 声明的字段（防止 line/start_line 漂移）', async (t) => {
  const { read, agent } = await pluginFixture(t, { record: readingRecord() })
  const page = await read.execute({ title: '分页资料', mode: 'document', max_lines: 3 }, { agent })
  const branch = read.output.schema.properties.page.properties.continuation.oneOf[0]
  const declared = new Set(Object.keys(branch.properties))
  assert.ok(page.page.continuation, '应有续页参数')
  for (const key of Object.keys(page.page.continuation)) {
    assert.ok(declared.has(key), `续页字段 ${key} 未在 corpus_read 输出 schema 中声明`)
  }
  assert.ok(declared.has('start_line'))
  assert.ok(!declared.has('line'), 'schema 不应再声明 line')
})

test('reuse:false 时完全不采信上文可见性，重发整页', async (t) => {
  const { read, agent, markVisible } = await pluginFixture(t, { record: readingRecord() })
  const first = await read.execute({ title: '分页资料', mode: 'document', max_lines: 4 },
    { agent, callId: 'first' })
  markVisible('first', first)
  // 默认行为：判定整页已可见，走缓存回放并提示不要再读同一范围
  const repeated = await read.execute({ title: '分页资料', mode: 'document', max_lines: 4 },
    { agent, callId: 'again' })
  assert.match(read.output.render({}, repeated)[0].text, /该范围已在当前模型可见/u)
  // 强制重发：不再声称"上文可见"，正常交付本页
  const forced = await read.execute({ title: '分页资料', mode: 'document', max_lines: 4, reuse: false },
    { agent, callId: 'forced' })
  const forcedText = read.output.render({}, forced)[0].text
  assert.doesNotMatch(forcedText, /该范围已在当前模型可见/u)
  assert.deepEqual(forced.primary.lines.map((line) => line.line), [1, 2, 3, 4])
  assert.equal(forced.coverage, undefined)
})

test('reuse:false 时部分重叠的页也不剔除已可见行', async (t) => {
  const { read, agent, markVisible } = await pluginFixture(t, { record: readingRecord() })
  const seed = await read.execute({ title: '分页资料', line: 2, before: 0, after: 0 },
    { agent, callId: 'seed' })
  markVisible('seed', seed)
  const partial = await read.execute({ title: '分页资料', mode: 'document', max_lines: 4 },
    { agent, callId: 'partial' })
  assert.deepEqual(partial.primary.lines.map((line) => line.line), [1, 3, 4])
  const forced = await read.execute({ title: '分页资料', mode: 'document', max_lines: 4, reuse: false },
    { agent, callId: 'forced' })
  assert.deepEqual(forced.primary.lines.map((line) => line.line), [1, 2, 3, 4])
  assert.equal(forced.coverage, undefined)
  assert.doesNotMatch(read.output.render({}, forced)[0].text, /复用上文/u)
})
