import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApi, applyUi } from '../src/ui.js'
import { createSharedState } from '../src/state.js'
import { documentUid, naturalDocumentTitle } from '../src/store.js'
import { archivePresentationMeta, cloudArchivePresentation, localArchivePresentation,
  rememberArchivePresentation, timelineArchivePresentation } from '../src/archive-presentation.js'

const dataVersion = 'a'.repeat(64)
function fixture(count = 1) {
  const records = Array.from({ length: count }, (_, index) => ({ document: {
    game: index === count - 1 && count > 1 ? 'endfield' : 'arknights',
    document_id: `archive-${index}`, document_type: 'story', document_kind: 'story',
    display_title: `档案 ${index}`, story_name: `档案 ${index}`,
    source_ref_prefix: `client_data:official_game:${String(index).padStart(24, '0')}`,
  }, speakers: [], lines: [
    { line_number: 1, line_type: 'narration', text: '莱茵生命档案' },
    { line_number: 2, line_type: 'narration', text: '用户可以自行翻阅。' },
  ] }))
  const documents = new Map(records.map((record, ordinal) => [record.document.document_id,
    { document: record.document, speakers: [], ordinal }]))
  const ids = [...documents.keys()]
  const store = { dataVersion, loaded: true, _generation: 1, documents, documentOrder: ids,
    hasTrigramIndex: false, naturalTitleIndex: new Map(records.map((record) =>
      [naturalDocumentTitle(record.document), [record.document.document_id]])), titleIndex: new Map(),
    async ready() {}, orderedDocumentIds(selected = null) {
      return selected === null ? [...ids] : ids.filter((id) => new Set(selected).has(id))
    }, documentOrdinal(id) { return documents.get(id)?.ordinal },
    isPreferredNaturalDocument() { return true },
    getDocumentIdByUid(uid) { return ids.find((id) => documentUid(id) === uid) },
    async getDocument(id) {
      await this.onRead?.()
      const record = records[documents.get(id)?.ordinal]
      return record ? { record, packId: 'official_game' } : null
    },
    async *iterateDocuments({ documentIds = null, predicate = null } = {}) {
      for (const id of this.orderedDocumentIds(documentIds)) {
        const record = records[documents.get(id)?.ordinal]
        if (!predicate || predicate(record.document, [])) yield record
      }
    },
    async getOrCreateCursorSecret() { return Buffer.alloc(32, 7) },
  }
  let enabledGames = ['arknights', 'endfield']
  return { store, records, shared: { store, effective: () => ({ enabledGames }) },
    setGames(games) { enabledGames = games } }
}

test('archive search uses canonical pagination, version-bound locators and enabled games', async () => {
  const f = fixture(15)
  const api = buildApi(f.shared)
  f.setGames(['arknights'])
  const first = await api.call('POST', '/api/prts-corpus/archive/search', {})
  assert.equal(first.status, 200)
  assert.equal(first.json.data_version, dataVersion)
  assert.equal(first.json.sources.length, 12)
  assert.equal(first.json.page.exhausted, false)
  for (const source of first.json.sources) {
    assert.equal(source.id, `document:${dataVersion}:${documentUid(source.documentId)}`)
    assert.equal(source.documentUid, documentUid(source.documentId))
    assert.equal(source.state, 'found')
    assert.equal(f.store.documents.get(source.documentId).document.game, 'arknights')
  }
  const second = await api.call('POST', '/api/prts-corpus/archive/search', { after: first.json.page.next_after })
  assert.equal(second.status, 200)
  assert.equal(second.json.sources.length, 2)
  assert.equal(second.json.page.exhausted, true)
  assert.equal(new Set([...first.json.sources, ...second.json.sources].map((source) => source.id)).size, 14)
  const found = await api.call('POST', '/api/prts-corpus/archive/search', { query: '莱茵生命' })
  assert.deepEqual(found.json.sources[0].ranges, [{ start: 1, end: 1 }])
  assert.match(found.json.sources[0].excerpt, /用户可以自行翻阅/)
  assert.equal((await api.call('POST', '/api/prts-corpus/archive/search', { games: ['endfield'] })).status, 400)
  assert.equal((await api.call('POST', '/api/prts-corpus/archive/search', {
    after: { ...first.json.page.next_after, data_version: 'b'.repeat(64) },
  })).status, 409)
  assert.equal((await api.call('POST', '/api/prts-corpus/archive/search', [])).status, 400)
  assert.equal(f.shared.evidenceState, undefined)
})

test('archive search refuses hidden games inside old signed cursors', async () => {
  const f = fixture(2)
  f.setGames(['arknights'])
  const filters = Object.fromEntries(['resource_types', 'character_names', 'story_names', 'activity_names',
    'entity_names', 'speakers', 'wiki_sections', 'games', 'content_types', 'collection_names'].map((key) => [key, []]))
  filters.games = ['arknights', 'endfield']
  const body = Buffer.from(JSON.stringify({ v: 2, tool: 'corpus_search', data_version: dataVersion, offset: 0,
    request: { query: '莱茵生命', filters, match_mode: 'literal', context_terms: [] },
  })).toString('base64url')
  const signature = createHmac('sha256', Buffer.alloc(32, 7)).update(body).digest('base64url')
  const result = await buildApi(f.shared).call('POST', '/api/prts-corpus/archive/search', { cursor: `${body}.${signature}` })
  assert.equal(result.status, 409)
  assert.equal(result.json.code, 'CURSOR_POLICY_MISMATCH')
})

test('archive search cancellation, release switches and live policy changes cannot return stale material', async () => {
  for (const scenario of ['cancel', 'version', 'games']) {
    const f = fixture()
    const controller = new AbortController()
    f.store.onRead = () => {
      if (scenario === 'cancel') controller.abort()
      if (scenario === 'version') f.store._generation += 1
      if (scenario === 'games') f.setGames(['endfield'])
    }
    const operation = buildApi(f.shared).call('POST', '/api/prts-corpus/archive/search', { query: '莱茵生命' },
      { signal: controller.signal })
    if (scenario === 'cancel') await assert.rejects(operation, (error) => error.code === 'CANCELLED')
    else assert.equal((await operation).status, 409)
  }
})

test('archive projections preserve separate occurrences and do not relabel durable results after a release switch', () => {
  const f = fixture()
  const value = { documents: [{ title: '档案 0', resource_type: 'reference', matches: [
    { line_start: 2, line_end: 3, excerpt: [{ text: '第一处' }] },
    { line_start: 20, line_end: 22, excerpt: [{ text: '第二处' }] },
  ] }] }
  const metadata = localArchivePresentation(f.store, value)
  assert.deepEqual(metadata.sources[0].ranges, [{ start: 2, end: 3 }, { start: 20, end: 22 }])
  const stamped = JSON.parse(JSON.stringify(rememberArchivePresentation(value, metadata)))
  f.store.dataVersion = 'b'.repeat(64)
  assert.equal(archivePresentationMeta({}, stamped).data_version, dataVersion)
  assert.equal(archivePresentationMeta({}, { status: 'error' }).sources.length, 0)
  const businessFailure = archivePresentationMeta({}, { status: 'error', error: { message: '失败'.repeat(800) } })
  assert.equal(businessFailure.error.length, 600)
  assert.equal(businessFailure.kind, 'prts-archive-sources-v1')
  assert.equal(localArchivePresentation(f.store, { error: {} }).sources.length, 0)
})

test('cloud cards expose delivered anchors and content, never raw hidden candidates or their excerpts', () => {
  const value = { data: { answer_context: '《公开资料》描述了研究过程。',
    sources: [{ title: '公开资料', document_id: '/srv/private/remote.txt', content: '未发送的全文',
      url: 'https://example.test/source?token=do-not-copy' }],
    candidates: [{ title: '隐藏候选', content: '隐藏内部内容' }],
  }, local_source_mappings: [
    { document_id: 'archive-0', title: '档案 0', document_uid: documentUid('archive-0'),
      suggested_source_ref: 'local:L2', start_line: 2, end_line: 3, excerpt: '隐藏映射正文', parent_source_path: '/srv/private' },
    { document_id: 'archive-0', title: '档案 0', suggested_source_ref: 'local:L20', start_line: 20, end_line: 22 },
    { document_id: 'unreturned', title: '未返回锚点', suggested_source_ref: '' },
  ] }
  const metadata = cloudArchivePresentation(value, { dataVersion })
  assert.equal(metadata.kind, 'prts-archive-sources-v1')
  assert.equal(metadata.sources.length, 2)
  assert.equal(metadata.sources[0].id, `document:${dataVersion}:${documentUid('archive-0')}`)
  assert.deepEqual(metadata.sources[0].ranges, [{ start: 2, end: 3 }, { start: 20, end: 22 }])
  assert.equal(metadata.sources[0].state, 'found')
  assert.equal(metadata.sources[1].url, 'https://example.test/source')
  assert.doesNotMatch(JSON.stringify(metadata), /隐藏|未发送|未返回|private|do-not-copy|verified/u)
  const inspect = cloudArchivePresentation({ data: { items: [{ title: '调查记录', content_preview: '实际返回内容',
    source_file: '/srv/internal', candidate_id: 'private-id' }] } }, { inspect: true })
  assert.equal(inspect.sources[0].excerpt, '实际返回内容')
  assert.equal(inspect.sources[0].state, 'read')
  assert.equal(inspect.sources[0].agentRead, true)
  assert.doesNotMatch(JSON.stringify(inspect), /internal|private-id/)
  const summary = cloudArchivePresentation({ data: { answer_context: '这是交付给 Agent 的摘要。' } })
  assert.equal(summary.sources[0].kind, 'cloud_summary')
  assert.equal(summary.sources[0].state, 'read')
  assert.equal(summary.sources[0].agentRead, true)
})

test('timeline material records are bounded and retain no invented document locator', () => {
  const value = { status: 'ok', data_version: dataVersion, events: Array.from({ length: 140 }, (_, i) => ({
    activity_name: '孤星', time: '1099', event: `事件 ${i}`, source_marker: `年表出处:tle_${i}`,
  })) }
  const result = timelineArchivePresentation(value)
  assert.equal(result.sources.length, 128)
  assert.equal(result.sources_truncated, true)
  assert.equal(result.sources[0].documentId, undefined)
  assert.equal(result.sources[0].kind, 'timeline')
})

test('cloud sources deduplicate exact identities and keep distinct same-title documents', () => {
  const items = [
    { title: '同名篇章', document_id: 'doc-a', content_preview: '第一份', start_line: 1, end_line: 2 },
    { title: '同名篇章', document_id: 'doc-b', content_preview: '第二份', start_line: 9, end_line: 10 },
    { title: '同名篇章', document_id: 'doc-a', content_preview: '再次读取第一份', start_line: 20, end_line: 21 },
  ]
  const result = cloudArchivePresentation({ data: { items } }, { inspect: true })
  assert.equal(result.sources.length, 2)
  assert.notEqual(result.sources[0].id, result.sources[1].id)
  assert.deepEqual(result.sources[0].ranges, [{ start: 1, end: 2 }, { start: 20, end: 21 }])
  const withNull = cloudArchivePresentation({ data: { items: [null, ...items] } }, { inspect: true })
  assert.deepEqual(withNull.sources.map((source) => source.id), result.sources.map((source) => source.id))
  const mapped = cloudArchivePresentation({ data: { items }, local_source_mappings: [{
    document_id: 'doc-a', title: '同名篇章', suggested_source_ref: 'local:L1', start_line: 1, end_line: 2,
  }] }, { inspect: true, dataVersion })
  assert.equal(mapped.sources.length, 3)
  assert.equal(mapped.sources[0].id, `document:${dataVersion}:${documentUid('doc-a')}`)
  assert.equal(mapped.sources[0].state, 'found')
  assert.equal(mapped.sources[0].excerpt, '')
  assert.equal(mapped.sources[1].excerpt, '第一份')
  assert.equal(mapped.sources[1].state, 'read')
  assert.equal(mapped.sources[1].documentId, undefined)
  assert.equal(mapped.sources[1].readRanges, undefined)
  assert.equal(mapped.sources[2].excerpt, '第二份')
  const search = cloudArchivePresentation({ data: { answer_context: '《同名篇章》', sources: items } })
  assert.equal(search.sources.length, 2)
})

test('cloud inspect read status requires delivered text and does not promote pointer-only anchors', () => {
  const value = { data: { items: [
    { title: '只有定位', document_id: 'pointer', content_preview: '', content: '' },
    { title: '有返回正文', document_id: 'body', content_preview: '', content: '实际交付的正文' },
  ] }, local_source_mappings: [{ document_id: 'local-body', title: '本地可读取资料',
    suggested_source_ref: 'local:L1', start_line: 1, end_line: 8, excerpt: '未交付的映射正文' }] }
  const result = cloudArchivePresentation(value, { inspect: true, dataVersion })
  assert.deepEqual(result.sources.map((source) => source.state), ['found', 'found', 'read'])
  assert.deepEqual(result.sources.map((source) => source.agentRead === true), [false, false, true])
  assert.equal(result.sources[2].excerpt, '实际交付的正文')
  assert.doesNotMatch(JSON.stringify(result), /未交付的映射正文/)
  const durable = JSON.parse(JSON.stringify(rememberArchivePresentation(value, result)))
  assert.deepEqual(archivePresentationMeta({}, durable), result)
})

test('cloud links retain public page/revision/fragment locators and discard private URL parameters', () => {
  const original = 'https://prts.wiki/index.php?title=孤星&oldid=123&token=secret&lang=zh&api_key=private#剧情'
  const result = cloudArchivePresentation({ data: { items: [{ title: '孤星', url: original }] } }, { inspect: true })
  const url = new URL(result.sources[0].url)
  assert.equal(url.searchParams.get('title'), '孤星')
  assert.equal(url.searchParams.get('oldid'), '123')
  assert.equal(url.searchParams.get('lang'), 'zh')
  assert.equal(decodeURIComponent(url.hash), '#剧情')
  assert.equal(url.searchParams.has('token'), false)
  assert.equal(url.searchParams.has('api_key'), false)
  const credentials = cloudArchivePresentation({ data: { items: [{ title: '资料',
    url: 'https://user:secret@example.test/source?title=page' }] } }, { inspect: true })
  assert.equal(credentials.sources[0].url, undefined)
  assert.doesNotMatch(JSON.stringify(result), /secret|private/)
})

test('Rhine skin persists and its assets are exact routes on Fetch and Web; searches work over shared Fetch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-rhine-api-'))
  const effects = []
  try {
    const shared = createSharedState({ configPath: join(dir, 'config.json'), releasesDir: dir })
    await shared.saveConfig({ uiSkin: 'rhine-lab' })
    const reloaded = createSharedState({ configPath: join(dir, 'config.json'), releasesDir: dir })
    await reloaded.loadConfig()
    assert.equal(reloaded.effective().uiSkin, 'rhine-lab')
    shared.store = fixture().store
    const fetchRoutes = [], webRoutes = []
    const ctx = { connection: { fetch: { register(route) { fetchRoutes.push(route) } }, rpc: { handle() {} } },
      webServer: { register(route) { webRoutes.push(route); return () => {} } },
      inject(_keys, operation) { operation(ctx) }, effect(operation) { effects.push(operation()) },
      logger: { info() {}, warn() {} } }
    applyUi(ctx, shared)
    const expected = ['rhine.js', 'rhine.css', 'assets/archive-cassette.glb', 'assets/archive-assembly.glb',
      'fonts/MiSans-Light.woff2', 'fonts/MiSans-Regular.woff2', 'fonts/MiSans-Demibold.woff2',
      'fonts/MiSans-Bold.woff2', 'fonts/MiSans-license.pdf', 'fonts/NOTICE.txt']
    assert.deepEqual(fetchRoutes.filter((route) => route.path.startsWith('/api/prts-corpus/rhine/'))
      .map((route) => route.path.split('/rhine/')[1]), expected)
    assert.deepEqual(webRoutes.filter((route) => route.path.startsWith('/prts-corpus/rhine/'))
      .map((route) => [route.kind, route.path.split('/rhine/')[1]]), expected.map((name) => ['exact', name]))
    const fontRoute = fetchRoutes.find((route) => route.path.endsWith('/MiSans-Light.woff2'))
    const fontResponse = await fontRoute.fetch(new Request(`http://fixture${fontRoute.path}`))
    assert.equal(fontResponse.headers.get('content-type'), 'font/woff2')
    assert.equal(Buffer.from(await fontResponse.arrayBuffer()).subarray(0, 4).toString(), 'wOF2')
    const licenseRoute = fetchRoutes.find((route) => route.path.endsWith('/MiSans-license.pdf'))
    const licenseResponse = await licenseRoute.fetch(new Request(`http://fixture${licenseRoute.path}`, { method: 'HEAD' }))
    assert.equal(licenseResponse.status, 200)
    assert.equal(licenseResponse.headers.get('content-type'), 'application/pdf')
    assert.equal(webRoutes.some((route) => route.path === '/prts-corpus/rhine' && route.kind === 'prefix'), false)
    const assemblyRoute = fetchRoutes.find((route) => route.path.endsWith('/archive-assembly.glb'))
    const assemblyResponse = await assemblyRoute.fetch(new Request(`http://fixture${assemblyRoute.path}`))
    assert.equal(assemblyResponse.status, 200)
    assert.equal(assemblyResponse.headers.get('content-type'), 'model/gltf-binary')
    assert.equal(Buffer.from(await assemblyResponse.arrayBuffer()).subarray(0, 4).toString(), 'glTF')
    const modelRoute = fetchRoutes.find((route) => route.path.endsWith('/archive-cassette.glb'))
    const modelUrl = `http://fixture${modelRoute.path}`
    const head = await modelRoute.fetch(new Request(modelUrl, { method: 'HEAD' }))
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-type'), 'model/gltf-binary')
    assert.equal((await head.arrayBuffer()).byteLength, 0)
    const model = await modelRoute.fetch(new Request(modelUrl))
    const bytes = Buffer.from(await model.arrayBuffer())
    assert.equal(bytes.subarray(0, 4).toString(), 'glTF')
    assert.equal(bytes.length, Number(head.headers.get('content-length')))
    const cancelled = new AbortController()
    cancelled.abort()
    assert.equal((await modelRoute.fetch(new Request(modelUrl, { signal: cancelled.signal }))).status, 499)
    const inFlight = new AbortController()
    const held = await modelRoute.fetch(new Request(modelUrl, { signal: inFlight.signal }))
    inFlight.abort()
    await assert.rejects(held.arrayBuffer(), (error) => error.code === 'CANCELLED')
    const webModelRoute = webRoutes.find((route) => route.path.endsWith('/archive-cassette.glb'))
    const webResponse = { status: null, body: null, headers: {},
      writeHead(status, headers = {}) { this.status = status; this.headers = headers },
      end(body) { this.body = body } }
    await webModelRoute.handler({ method: 'GET' }, webResponse)
    assert.equal(webResponse.status, 200)
    assert.equal(webResponse.headers['content-type'], 'model/gltf-binary')
    assert.ok(bytes.equals(webResponse.body))
    const route = fetchRoutes.find((route) => route.path === '/api/prts-corpus/rpc')
    const response = await route.fetch(new Request('http://fixture/api/prts-corpus/rpc', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'archive.search', payload: { query: '莱茵生命' } }),
    }))
    const result = await response.json()
    assert.equal(result.ok, true)
    assert.equal(result.value.sources.length, 1)
    const direct = fetchRoutes.find((route) => route.path.endsWith('/archive/search'))
    assert.equal((await direct.fetch(new Request('http://fixture/api/prts-corpus/archive/search', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }))).status, 200)
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')), { uiSkin: 'rhine-lab' })
  } finally {
    for (const effect of effects.reverse()) effect?.()
    await rm(dir, { recursive: true, force: true })
  }
})
