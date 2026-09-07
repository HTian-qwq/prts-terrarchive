import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CorpusStore, computeLinesIntegrity, naturalDocumentTitle } from '../src/store.js'
import { executeRead } from '../src/read.js'
import { executeSearch } from '../src/search.js'

const OLD_VERSION = 'a'.repeat(64)
const NEW_VERSION = 'b'.repeat(64)
const PACK = 'official_game'
const SHARD = 'shards/00000.jsonl.gz'
const SEARCH_SHARD = 'search-index/00000.bin.gz'

function story(id, text) {
  const lines = [{ line_number: 1, line_type: 'narration', speaker_raw: '', text }]
  return { document: { document_id: id, document_type: 'story', document_kind: 'story',
    display_title: id, activity_id: 'test-activity', activity_name: '测试活动',
    line_count: 1, source_ref_prefix: `official_game:story:${id}` },
    speakers: [], lines, local_integrity: { sha256: computeLinesIntegrity(lines) } }
}

// 模拟 ready 已原子提交的轻量目录；所有分片 I/O 都由测试提供，不访问真实资料。
function activate(store, version, records) {
  store.releaseId = version === OLD_VERSION ? 'old-release' : 'new-release'
  store.dataVersion = version
  store._loaded = true
  store._ready = Promise.resolve()
  store.documentOrder = records.map((record) => record.document.document_id)
  for (const [index, record] of records.entries()) {
    const id = record.document.document_id
    store.documents.set(id, { packId: PACK, shardPath: SHARD, index, ordinal: index,
      document: record.document, speakers: record.speakers })
    store.naturalTitleIndex.set(naturalDocumentTitle(record.document), [id])
  }
  store.packs.set(PACK, { shards: [{ path: SHARD }] })
}

function makeStore(records) {
  const store = new CorpusStore({ releasesDir: '/unused-prts-generation-test/releases' })
  activate(store, OLD_VERSION, records)
  return store
}

function changedVersion(error) {
  assert.equal(error.code, 'PACKAGE_VERSION_MISMATCH')
  assert.equal(error.retryable, true)
  return true
}

function changedResponse(response) {
  assert.equal(response.status, 'error')
  changedVersion(response.error)
  assert.equal(response.content, undefined)
  assert.equal(response.documents, undefined)
}

function readArgs(id, version = OLD_VERSION) {
  return { intent_id: 'generation-test', expected_data_version: version,
    locator: { document_id: id }, selection: { mode: 'document' } }
}

test('旧正文解压完成后拒绝返回或覆盖新版本缓存，新版本读取保持可信', async (t) => {
  const oldRecord = story('shared-document', '旧版原文')
  const newRecord = story('shared-document', '新版原文')
  const store = makeStore([oldRecord])
  const oldRead = Promise.withResolvers()
  t.mock.method(store, '_readPacked', async (_pack, _path, releaseId) =>
    releaseId === 'old-release' ? oldRead.promise : Buffer.from(JSON.stringify(newRecord)))
  const pending = store.getDocument('shared-document')
  const rejection = assert.rejects(pending, changedVersion)
  store.reset()
  activate(store, NEW_VERSION, [newRecord])
  assert.equal((await store.getDocument('shared-document')).record.lines[0].text, '新版原文')
  oldRead.resolve(Buffer.from(JSON.stringify(oldRecord)))
  await rejection
  const response = await executeRead(store, readArgs('shared-document', NEW_VERSION), {})
  assert.equal(response.status, 'ok')
  assert.equal(response.data_version, NEW_VERSION)
  assert.equal(response.content.lines[0].text, '新版原文')
  assert.equal(response.integrity.verified, true)
})

test('正文缓存命中的 await 期间 reset 也拒绝返回旧记录', async (t) => {
  const oldRecord = story('shared-document', '旧版原文')
  const store = makeStore([oldRecord])
  t.mock.method(store, '_readPacked', async () => Buffer.from(JSON.stringify(oldRecord)))
  await store.getDocument('shared-document')
  const pending = store.getDocument('shared-document')
  const rejection = assert.rejects(pending, changedVersion)
  store.reset()
  activate(store, NEW_VERSION, [story('shared-document', '新版原文')])
  await rejection
  assert.equal(store._shardCache.size, 0)
})

test('旧倒排解压完成后拒绝返回或覆盖已预热的新版本倒排缓存', async (t) => {
  const store = makeStore([])
  const oldRead = Promise.withResolvers()
  const newBytes = Buffer.from('new-index')
  t.mock.method(store, '_gunzipBounded', async (path) =>
    path.includes('/old-release/') ? oldRead.promise : newBytes)
  const pending = store._loadSearchShard(PACK, SEARCH_SHARD)
  const rejection = assert.rejects(pending, changedVersion)
  store.reset()
  activate(store, NEW_VERSION, [])
  assert.equal(await store._loadSearchShard(PACK, SEARCH_SHARD), newBytes)
  oldRead.resolve(Buffer.from('old-index'))
  await rejection
  assert.equal(await store._loadSearchShard(PACK, SEARCH_SHARD), newBytes)
})

test('已缓存的倒排查询不会用新版本文档映射解释旧 postings', async (t) => {
  const store = makeStore([])
  store.packs.get(PACK).search_index = { shards: [{ path: SEARCH_SHARD,
    first_trigram: '旧原文', last_trigram: '旧原文' }] }
  // 缓存命中返回的 Promise 仍会让出执行权；代次检查须先于 postings 解码。
  t.mock.method(store, '_loadSearchShard', async () => Buffer.from('old-index'))
  const pending = store.findDocumentsByNgrams(['旧原文'])
  const rejection = assert.rejects(pending, changedVersion)
  store.reset()
  activate(store, NEW_VERSION, [])
  await rejection
})

test('旧读取失败且期间已切版时，错误仍明确标为可重试的版本失配', async (t) => {
  const record = story('shared-document', '旧版原文')
  const store = makeStore([record])
  const started = Promise.withResolvers()
  const oldRead = Promise.withResolvers()
  t.mock.method(store, '_readPacked', async () => {
    started.resolve()
    return oldRead.promise
  })
  const pending = executeRead(store, readArgs('shared-document'), {})
  await started.promise
  store.reset()
  activate(store, NEW_VERSION, [story('shared-document', '新版原文')])
  oldRead.reject(Object.assign(new Error('old release removed'), { code: 'ENOENT' }))
  changedResponse(await pending)
})

test('相邻文档读取期间切版，整次读取不返回旧正文加新摘要', async (t) => {
  const main = story('main', '旧版原文')
  const adjacent = story('adjacent', '相邻原文')
  main.document.next_document_id = 'adjacent'
  const store = makeStore([main, adjacent])
  t.mock.method(store, 'getDocument', async (id) => {
    if (id === 'main') return { record: main, packId: PACK }
    store.reset()
    activate(store, NEW_VERSION, [main, adjacent])
    return { record: adjacent, packId: PACK }
  })
  changedResponse(await executeRead(store, readArgs('main'), {}))
})

test('活动跨文档通读在切版后拒绝交付混合版本的正文', async (t) => {
  const records = [story('part-1', '旧版第一篇'), story('part-2', '新版第二篇')]
  const store = makeStore(records)
  t.mock.method(store, 'activityStoryDocuments', () => records.map((record) => ({ document: record.document })))
  t.mock.method(store, 'getDocument', async (id) => {
    if (id === 'part-2') {
      store.reset()
      activate(store, NEW_VERSION, records)
    }
    return { record: records.find((record) => record.document.document_id === id), packId: PACK }
  })
  changedResponse(await executeRead(store, { intent_id: 'generation-stream',
    locator: { activity_name: '测试活动' }, selection: { mode: 'activity' } }, {}))
})

test('搜索跨文档和最终续页生成期间的切版都使整页失效', async (t) => {
  for (const phase of ['document', 'continuation']) {
    await t.test(phase, async (t) => {
      const records = Array.from({ length: phase === 'document' ? 2 : 21 }, (_, index) =>
        story(`part-${index}`, '共同查询原文'))
      const store = makeStore(records)
      const switchVersion = () => {
        store.reset()
        activate(store, NEW_VERSION, records)
      }
      t.mock.method(store, 'getDocument', async (id) => {
        if (phase === 'document' && id === 'part-1') switchVersion()
        return { record: records.find((record) => record.document.document_id === id), packId: PACK }
      })
      t.mock.method(store, 'getOrCreateCursorSecret', async () => {
        if (phase === 'continuation') switchVersion()
        return Buffer.alloc(32, 7)
      })
      changedResponse(await executeSearch(store, { query: '共同查询原文', games: ['arknights'] }))
    })
  }
})
