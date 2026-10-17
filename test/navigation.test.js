import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NAVIGATION_DESCRIPTION, NAVIGATION_PARAMETERS, executeNavigation, renderNavigation } from '../src/navigation.js'
import { documentUid } from '../src/store.js'

const VERSION = 'a'.repeat(64)
function catalog() {
  return { source_game_version: '1.7', versions: [
    { version: '1.7', title: '未来映射待核验', chapter_ids: [], mapping_status: 'pending', evidence: ['待核验公告'] },
    { version: '1.6', title: '丹青渡', chapter_ids: ['c2p8'], evidence: ['1.6源表'] },
    { version: '1.0', title: '初始主线', chapter_ids: ['prologue', 'c1p8', 'c2p7'], evidence: ['1.0源表'] },
  ], chapters: [
    { id: 'c2p8', title: 'Crossing', aliases: ['丹青渡'], chapter_number: 2, process_number: 8, order: 40,
      collection_names: ['丹青渡任务', '后续任务'], summary_title: '丹青渡任务', version: '1.6', evidence: ['community table row 4'] },
    { id: 'prologue', title: '觉醒', chapter_number: 0, process_number: null, order: 10,
      collection_names: ['序章任务'], summary_title: null, version: '1.0', evidence: ['community table row 1'] },
    { id: 'c2p7', title: '前一进程', chapter_number: 2, process_number: 7, order: 30,
      collection_names: ['前一任务'], summary_title: '前一任务', version: '1.0', evidence: ['community table row 3'] },
    { id: 'c1p8', title: '第一章末段', chapter_number: 1, process_number: 8, order: 20,
      collection_names: ['旧任务'], summary_title: null, version: '1.0', evidence: ['community table row 2'] },
  ] }
}
function story(id, name, extra = {}) {
  return { document_id: `endfield:story:${id}`, game: 'endfield', document_type: 'story', document_kind: 'story',
    resource_type: 'original_story', content_type: 'dialogue', display_title: id,
    collection_name: name, collection_id: `collection:${name}`, ...extra }
}
function summary(id, title, extra = {}) {
  return { document_id: `endfield:wiki:${id}`, game: 'endfield', document_type: 'knowledge',
    document_kind: 'wiki', resource_type: 'reviewed_wiki', display_title: title, ...extra }
}
async function fixture(t, value = catalog(), docs = [summary('s8', '丹青渡任务'), story('p8', '丹青渡任务'), story('p7', '前一任务')]) {
  const dir = await mkdtemp(join(tmpdir(), 'prts-navigation-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'catalog.json')
  await writeFile(path, JSON.stringify(value))
  return { navigationCatalogPath: path, dataVersion: VERSION, _generation: 0,
    documents: new Map(docs.map((document) => [document.document_id, { document }])),
    packs: new Map([['endfield_official_game', {}], ['endfield_reviewed_knowledge', {}]]),
    async ready() {} }
}
const ids = (result) => result.entries.map((row) => row.id)

test('minimal schema and directory use explicit source order, not catalog array or fragment IDs', async (t) => {
  assert.deepEqual(Object.keys(NAVIGATION_PARAMETERS.properties), ['query', 'game'])
  assert.equal(NAVIGATION_PARAMETERS.additionalProperties, false)
  assert.match(NAVIGATION_DESCRIPTION, /当前资料覆盖/u)
  const store = await fixture(t)
  for (const raw of [undefined, {}, { query: '主线目录' }, { query: '  ' }]) {
    const result = await executeNavigation(store, raw)
    assert.equal(result.status, 'ok')
    assert.deepEqual(ids(result), ['prologue', 'c1p8', 'c2p7', 'c2p8'])
    assert.equal(result.entries[0].process_number, null)
    assert.equal(result.entries[2].next.id, 'c2p8')
    assert.equal(result.entries[3].prev.id, 'c2p7')
    assert.equal(result.entries[3].next, null)
  }
})

test('chapter/process numbers accept Chinese, Arabic, Roman and full-width forms', async (t) => {
  const store = await fixture(t)
  assert.deepEqual(ids(await executeNavigation(store, { query: '第二章' })), ['c2p7', 'c2p8'])
  for (const query of ['第二章第八进程', '第2章第8进程', '第II章第VIII进程']) {
    assert.deepEqual(ids(await executeNavigation(store, { query })), ['c2p8'], query)
  }
  for (const query of ['第八进程', '进程VIII', '进程Ⅷ', '进程viii', '第８进程']) {
    assert.deepEqual(ids(await executeNavigation(store, { query })), ['c1p8', 'c2p8'], query)
  }
  assert.deepEqual(ids(await executeNavigation(store, { query: '进程IIX' })), [])
  assert.equal((await executeNavigation(store, { query: '第九章' })).status, 'not_found')
})

test('version mapping, aliases and exact task names are separate from unknown versions', async (t) => {
  const store = await fixture(t)
  for (const query of ['1.6主线', 'v1.6 版本 主线', '丹青渡', 'Crossing', '丹青渡任务', '终末地 · 丹青渡任务']) {
    const result = await executeNavigation(store, { query })
    assert.deepEqual(ids(result), ['c2p8'], query)
  }
  const unknown = await executeNavigation(store, { query: '1.99主线' })
  assert.equal(unknown.status, 'unmapped')
  assert.equal(unknown.mode, 'version')
  assert.deepEqual(ids(unknown), [])
  assert.match(unknown.message, /没有版本 1.99.*不能猜测/u)
  const pending = await executeNavigation(store, { query: '1.7主线' })
  assert.equal(pending.status, 'unmapped')
  assert.equal(pending.version.mapping_status, 'pending')
  assert.deepEqual(pending.version.evidence, ['待核验公告'])
  assert.match(pending.message, /不能据此判断无主线更新/u)
  assert.equal((await executeNavigation(store, { query: '青渡' })).status, 'not_found')
})

test('latest uses local coverage and exposes catalog/mapping/availability boundaries', async (t) => {
  const store = await fixture(t)
  const result = await executeNavigation(store, { query: '最新主线' })
  assert.deepEqual(ids(result), ['c2p8'])
  assert.equal(result.source_game_version, '1.7')
  assert.equal(result.version_boundary.latest_mapped_version, '1.6')
  assert.equal(result.version_boundary.latest_available_version, '1.6')
  assert.equal(result.version_boundary.latest_catalog_version, '1.7')
  assert.match(result.version_boundary.note, /不代表实时游戏最新/u)
  for (const [key, value] of store.documents) if (value.document.collection_name !== '前一任务') store.documents.delete(key)
  const older = await executeNavigation(store, { query: '最新主线' })
  assert.deepEqual(ids(older), ['c2p7'])
  assert.equal(older.version_boundary.latest_available_version, '1.0')
  assert.equal(older.version_boundary.latest_mapped_version, '1.6')
})

test('latest still navigates source order when release mappings remain unknown', async (t) => {
  const data = catalog()
  data.versions = [{ version: '1.6', title: '待核验', chapter_ids: [], evidence: ['pending'] }]
  const store = await fixture(t, data)
  const result = await executeNavigation(store, { query: '最新主线' })
  assert.deepEqual(ids(result), ['c2p8'])
  assert.equal(result.version_boundary.latest_available_version, null)
  assert.equal(result.version_boundary.latest_mapped_version, null)
  assert.equal(result.version, undefined)
})

test('adjacent navigation requires explicit exact title and respects source boundaries', async (t) => {
  const store = await fixture(t)
  assert.deepEqual(ids(await executeNavigation(store, { query: '《丹青渡》的上一段' })), ['c2p7'])
  assert.deepEqual(ids(await executeNavigation(store, { query: '下一段：前一进程' })), ['c2p8'])
  const taskAnchor = await executeNavigation(store, { query: '前一任务下一段' })
  assert.deepEqual(ids(taskAnchor), ['c2p7'])
  assert.equal(taskAnchor.anchor.navigation_level, 'process')
  assert.match(taskAnchor.message, /任务顺序未核实/u)
  const edge = await executeNavigation(store, { query: '丹青渡下一段' })
  assert.deepEqual(ids(edge), [])
  assert.match(edge.message, /当前资料目录边界/u)
  assert.equal((await executeNavigation(store, { query: '下一段' })).error.code, 'ANCHOR_REQUIRED')
  assert.equal((await executeNavigation(store, { query: '上一段下一段丹青渡' })).error.code, 'INVALID_REQUEST')
  assert.equal((await executeNavigation(store, { query: '下一段：不知道' })).status, 'not_found')
})

test('availability checks actual metadata, isolates games and emits direct read/search arguments', async (t) => {
  const store = await fixture(t)
  const result = await executeNavigation(store, { query: '丹青渡' })
  const row = result.entries[0]
  assert.equal(row.summary_title, '丹青渡任务')
  assert.equal(row.summary.availability.status, 'available')
  assert.deepEqual(row.summary.read, { document_uid: documentUid('endfield:wiki:s8'), mode: 'document' })
  assert.deepEqual(row.collections[0].search, { games: ['endfield'], collection_names: ['丹青渡任务'], resource_types: ['original_story'] })
  assert.deepEqual(row.collections[0].read, { collection_name: '丹青渡任务', mode: 'collection' })
  assert.equal(row.collections[1].availability.status, 'missing')
  assert.equal(row.availability.status, 'partial')
  assert.ok(result.warnings.some((item) => item.code === 'NAVIGATION_CONTENT_UNAVAILABLE'))
  const foreign = story('foreign', '后续任务', { game: 'arknights' })
  store.documents.set(foreign.document_id, { document: foreign })
  const misleading = story('metadata-only', '后续任务', { resource_type: 'knowledge', content_type: 'archive' })
  store.documents.set(misleading.document_id, { document: misleading })
  assert.equal((await executeNavigation(store, { query: '丹青渡' })).entries[0].collections[1].availability.status, 'missing')
  const inferred = story('inferred', '后续任务')
  delete inferred.game
  store.documents.set(inferred.document_id, { document: inferred })
  assert.equal((await executeNavigation(store, { query: '丹青渡' })).entries[0].availability.status, 'available')
})

test('uninstalled and missing corpus never assert that story does not exist', async (t) => {
  const store = await fixture(t, catalog(), [])
  store.packs.clear()
  const result = await executeNavigation(store, { query: '最新主线' })
  assert.equal(result.entries[0].availability.status, 'not_installed')
  assert.ok(result.warnings.some((item) => item.code === 'NO_LOCAL_MAINLINE'))
  assert.match(renderNavigation(result)[0].text, /未安装；不代表没有主线剧情/u)
})

test('ambiguous title anchors and collection identities do not guess', async (t) => {
  const data = catalog()
  data.chapters.find((row) => row.id === 'c2p7').aliases = ['丹青渡']
  const store = await fixture(t, data, [story('one', '丹青渡任务'), story('two', '丹青渡任务', { collection_id: 'other' })])
  assert.equal((await executeNavigation(store, { query: '丹青渡上一段' })).status, 'ambiguous')
  const result = await executeNavigation(store, { query: 'Crossing' })
  assert.equal(result.entries[0].collections[0].availability.status, 'ambiguous')
})

test('validates raw requests, enabled games and cancellation before accessing corpus', async () => {
  const store = { dataVersion: VERSION, async ready() { assert.fail('invalid request accessed corpus') } }
  for (const raw of [null, [], 'text', { query: 4 }, { query: null }, { query: 'x'.repeat(501) }, { page: 1 }]) {
    assert.equal((await executeNavigation(store, raw)).error.code, 'INVALID_REQUEST')
  }
  for (const raw of [{ game: 'arknights' }, { query: '明日方舟主线' }, { query: 'arknights' }]) {
    assert.equal((await executeNavigation(store, raw)).error.code, 'UNSUPPORTED_GAME')
  }
  assert.equal((await executeNavigation(store, {}, { allowedGames: ['arknights'] })).error.code, 'GAME_NOT_ENABLED')
  const controller = new AbortController()
  controller.abort()
  assert.equal((await executeNavigation(store, {}, { signal: controller.signal })).error.code, 'CANCELLED')
})

test('rejects missing catalog, invalid JSON and source order that would need inference', async (t) => {
  const store = await fixture(t)
  await rm(store.navigationCatalogPath)
  assert.equal((await executeNavigation(store, {})).error.code, 'NAVIGATION_CATALOG_UNAVAILABLE')
  await writeFile(store.navigationCatalogPath, '{broken')
  assert.equal((await executeNavigation(store, {})).error.code, 'NAVIGATION_CATALOG_INVALID')
  for (const mutate of [
    (data) => { delete data.chapters[0].order },
    (data) => { data.chapters[0].order = data.chapters[1].order },
    (data) => { data.versions[0].chapter_ids = ['unknown'] },
  ]) {
    const data = catalog(); mutate(data)
    await writeFile(store.navigationCatalogPath, JSON.stringify(data))
    assert.equal((await executeNavigation(store, {})).error.code, 'NAVIGATION_CATALOG_INVALID')
  }
})

test('version switches during catalog I/O return retryable mismatch; no cache survives generations', async (t) => {
  const store = await fixture(t)
  let pathRead = 0
  const path = store.navigationCatalogPath
  Object.defineProperty(store, 'navigationCatalogPath', { configurable: true, get() {
    if (++pathRead === 1) { store._generation++; store.dataVersion = 'b'.repeat(64) }
    return path
  } })
  const changed = await executeNavigation(store, {})
  assert.equal(changed.status, 'error')
  assert.equal(changed.error.code, 'PACKAGE_VERSION_MISMATCH')
  assert.equal(changed.error.retryable, true)
  assert.equal(changed.entries, undefined)
  const next = catalog()
  next.chapters.find((row) => row.id === 'c2p8').title = '新版目录标题'
  await writeFile(path, JSON.stringify(next))
  const result = await executeNavigation(store, { query: '新版目录标题' })
  assert.equal(result.data_version, 'b'.repeat(64))
  assert.equal(result.entries[0].title, '新版目录标题')
})

test('raw mission metadata survives independently from Wiki role and source-table order', async (t) => {
  const data = catalog()
  const row = data.chapters.find((chapter) => chapter.id === 'c2p8')
  row.mission_metadata = [{ mission_id: 'c27-main', missionType: 0, chapterBitmask: 4, charId: 1001,
    evidence: ['MissionRuntimeAsset/c27-main.json'] }]
  row.classification = { source: 'missionType', wiki_role: 'character', mission_type: 0 }
  const result = await executeNavigation(await fixture(t, data), { query: '丹青渡' })
  assert.deepEqual(result.entries[0].mission_metadata, row.mission_metadata)
  assert.deepEqual(result.entries[0].classification, row.classification)
  assert.match(result.entries[0].classification_note, /Wiki 角色分类不等于游戏任务类型/u)
  assert.match(renderNavigation(result)[0].text, /chapterBitmask/u)
  assert.match(renderNavigation(result)[0].text, /顺序证据/u)
})

test('side mission query does not fall back to mainline directory', async (t) => {
  const store = await fixture(t)
  for (const query of ['支线', '终末地支线目录', '角色任务']) {
    const result = await executeNavigation(store, { query })
    assert.equal(result.status, 'error')
    assert.equal(result.error.code, 'UNSUPPORTED_SCOPE')
    assert.match(result.error.message, /仅提供终末地主线导航/u)
    assert.equal(result.entries, undefined)
  }
})

test('common explicit player phrases and official full game name navigate successfully', async (t) => {
  const store = await fixture(t)
  for (const query of ['现在主线到哪了', '最新主线讲了什么', '明日方舟：终末地最新主线']) {
    const result = await executeNavigation(store, { query })
    assert.equal(result.mode, 'latest', query)
    assert.deepEqual(ids(result), ['c2p8'], query)
  }
  for (const query of ['主线剧情顺序', '明日方舟：终末地', '明日方舟：终末地主线目录']) {
    assert.equal((await executeNavigation(store, { query })).mode, 'directory', query)
  }
  for (const query of ['1.6的主线', '丹青渡主线', '丹青渡的主线剧情']) {
    assert.deepEqual(ids(await executeNavigation(store, { query })), ['c2p8'], query)
  }
})

test('directory text is compact, retains one navigate per unit and does not dump task metadata', async (t) => {
  const data = catalog()
  data.chapters[0].mission_metadata = [{ missionType: 0, path: 'raw/very-long-source.json', details: 'x'.repeat(20000) }]
  const store = await fixture(t, data)
  const result = await executeNavigation(store, {})
  const text = renderNavigation(result)[0].text
  assert.ok(text.length < 8000)
  assert.equal((text.match(/corpus_navigate\(/gu) || []).length, 4)
  assert.doesNotMatch(text, /corpus_read\(|corpus_search\(|raw\/very-long-source/u)
  assert.match(text, /collection_order=unknown/u)
  assert.equal(result.entries[3].mission_metadata[0].details.length, 20000)
  assert.match(renderNavigation(await executeNavigation(store, { query: 'Crossing' }))[0].text, /任务顺序尚未核实/u)
})

test('real catalog field shapes project mission metadata and multiple summaries without inferred order', async (t) => {
  const data = catalog()
  const row = data.chapters.find((chapter) => chapter.id === 'c2p8')
  row.title = '丹青渡任务'
  row.title_en = 'Paint with Fresh Ink'
  row.summary_titles = ['丹青渡任务', '后续梗概']
  row.missions = [{ id: 'c27m1', name: '丹青渡任务', order: null, order_source: null }]
  row.mission_order_status = 'unavailable_membership_only'
  data.mission_metadata = [{ id: 'c27m1', mission_type: 0, chapter_bitmask: 2, char_id: 'chr_0027', export_type: 'c' },
    { id: 'unrelated', mission_type: 1 }]
  const store = await fixture(t, data)
  const result = await executeNavigation(store, { query: 'Paint with Fresh Ink' })
  assert.deepEqual(result.entries[0].summary_titles, row.summary_titles)
  assert.equal(result.entries[0].summaries.length, 2)
  assert.deepEqual(result.entries[0].mission_metadata, [data.mission_metadata[0]])
  assert.equal(result.mission_metadata.length, 2)
  assert.equal(result.entries[0].collection_order, 'unknown')
  assert.equal(result.entries[0].missions[0].order, null)
  const adjacent = await executeNavigation(store, { query: '丹青渡任务上一段' })
  assert.deepEqual(ids(adjacent), ['c2p8'])
  assert.match(adjacent.message, /不自动跳到相邻进程/u)
})

test('result supports JSON and standard text content with mapping evidence and actionable locators', async (t) => {
  const result = await executeNavigation(await fixture(t), { query: '丹青渡' })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
  const content = renderNavigation(result)
  assert.equal(content.length, 1)
  assert.equal(content[0].type, 'text')
  assert.match(content[0].text, /corpus_search\(/u)
  assert.match(content[0].text, /corpus_read\(/u)
  assert.match(content[0].text, /mapping_status=pending/u)
  assert.match(content[0].text, /待核验公告/u)
  assert.match(renderNavigation({ error: { code: 'INVALID_REQUEST', message: 'bad args' } })[0].text, /INVALID_REQUEST: bad args/u)
})
