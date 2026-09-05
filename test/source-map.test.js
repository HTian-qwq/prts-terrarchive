import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { CorpusStore, documentUid, naturalDocumentTitle } from '../src/store.js'
import { executeSearch } from '../src/search.js'
import { collectSourceHints, resolveCloudSources, attachLocalSourceMappings } from '../src/source-map.js'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const corpusTest = existsSync(resolve(packageDir, 'data/releases/current.json')) ? test : test.skip
const stateDir = await mkdtemp(resolve(tmpdir(), 'prts-source-map-state-'))
after(() => rm(stateDir, { recursive: true, force: true }))

function splitActivityRecord(id, activityName, parentLineStart, uniqueText) {
  const texts = ['<所有相关的活动剧情总结>', `<活动名称>${activityName}</活动名称>`,
    '<相关内容>', '<相关剧情总结>', uniqueText, '</相关内容>',
    '</所有相关的活动剧情总结>']
  return { document: {
    document_id: id, document_type: 'knowledge', document_kind: 'wiki',
    resource_type: 'character_activity_wiki', wiki_role: 'character_activity',
    display_title: `测试角色 × ${activityName}`, character_name: '测试角色',
    activity_name: activityName,
    path: `char_v3/prompt_char_test.txt#activity=${encodeURIComponent(activityName)}`,
    parent_source_path: 'char_v3/prompt_char_test.txt',
    parent_line_start: parentLineStart, parent_line_end: parentLineStart + 4,
    parent_span_local_start: 2, parent_span_local_end: 6,
    line_count: texts.length, sequence_index: parentLineStart,
    source_ref_prefix: `client_data:reviewed_wiki:${id.slice(-24)}`,
  }, speakers: [], lines: texts.map((text, index) => ({
    line_number: index + 1, line_type: 'knowledge', speaker_raw: '', text,
  })) }
}

test('拆分后的同源角色活动记录按活动、摘录和父行号映射到正确块', async () => {
  const first = splitActivityRecord('client:reviewed_wiki:111111111111111111111111',
    '首活动', 10, '首活动唯一内容')
  const second = splitActivityRecord('client:reviewed_wiki:222222222222222222222222',
    '次活动', 20, '次活动唯一内容')
  const records = new Map([first, second].map((record) => [record.document.document_id, record]))
  const naturalTitleIndex = new Map()
  const titleIndex = new Map()
  for (const record of records.values()) {
    naturalTitleIndex.set(naturalDocumentTitle(record.document), [record.document.document_id])
    titleIndex.set(record.document.display_title, [record.document.document_id])
  }
  const store = {
    dataVersion: 'a'.repeat(64),
    documents: new Map([...records].map(([id, record]) => [id, { document: record.document }])),
    naturalTitleIndex, titleIndex,
    ready: async () => {},
    getDocument: async (id) => records.has(id) ? { record: records.get(id) } : null,
    getDocumentBySourceStoryId: async () => null,
    getDocumentByPath: async () => null,
  }
  const mappings = await resolveCloudSources(store, [{
    evidence_id: 'wiki-second', source_type: 'vector_wiki',
    source_file: 'prompt_char_test.txt', title: '测试角色在次活动剧情高光',
    character_name: '测试角色', activity_name: '次活动',
    start_line: 23, end_line: 23, excerpt: '次活动唯一内容',
  }])
  assert.equal(mappings.length, 1)
  assert.equal(mappings[0].document_id, second.document.document_id)
  assert.equal(mappings[0].mapping_method, 'source_file_basename')
  assert.equal(mappings[0].activity_name, '次活动')
  assert.equal(mappings[0].character_name, '测试角色')
  assert.equal(mappings[0].parent_source_path, 'char_v3/prompt_char_test.txt')
  assert.equal(mappings[0].line, 5)
  assert.equal(mappings[0].line_end, 5)
  assert.equal(mappings[0].line_method, 'parent_line')
  assert.match(mappings[0].title, /^测试角色 × 次活动 \/ 角色活动 Wiki/u)

  const excerptOnly = await resolveCloudSources(store, [{
    evidence_id: 'wiki-second-excerpt-only', source_type: 'vector_wiki',
    source_file: 'prompt_char_test.txt', excerpt: '相关内容 次活动唯一内容',
  }])
  assert.equal(excerptOnly.length, 1)
  assert.equal(excerptOnly[0].document_id, second.document.document_id)
  assert.equal(excerptOnly[0].line_method, 'excerpt_match')
  assert.equal(excerptOnly[0].line, 5)

  const ambiguous = await resolveCloudSources(store, [{
    evidence_id: 'wiki-ambiguous', source_type: 'vector_wiki',
    source_file: 'prompt_char_test.txt', excerpt: '测试角色',
  }])
  assert.deepEqual(ambiguous, [])

  const mismatched = await resolveCloudSources(store, [{
    evidence_id: 'wiki-mismatched', source_type: 'vector_wiki',
    source_file: 'prompt_char_test.txt', character_name: '测试角色',
    activity_name: '不存在的活动', start_line: 23, excerpt: '次活动唯一内容',
  }])
  assert.deepEqual(mismatched, [], '显式活动名冲突时不能由摘录或父行号强行映射')

  const oneRecordStore = { ...store,
    documents: new Map([[second.document.document_id, { document: second.document }]]),
    getDocument: async (id) => id === second.document.document_id ? { record: second } : null,
  }
  const mismatchedSingle = await resolveCloudSources(oneRecordStore, [{
    evidence_id: 'wiki-mismatched-single', source_type: 'vector_wiki',
    source_file: 'prompt_char_test.txt', character_name: '测试角色',
    activity_name: '不存在的活动', excerpt: '次活动唯一内容',
  }])
  assert.deepEqual(mismatchedSingle, [], '唯一文件候选也必须服从显式活动约束')
})

corpusTest('每篇资料有稳定 document_uid，云端来源可映射到本地标题和官方行号', async () => {
  const store = new CorpusStore({ releasesDir: resolve(packageDir, 'data/releases'),
    cursorSecretPath: resolve(stateDir, 'cursor-secret.bin') })
  const search = await executeSearch(store, { query: '重生', resource_types: ['story'] })
  assert.ok(search.documents.length > 0)
  assert.ok(search.page.next_after?.title)
  assert.equal(search.page.next_cursor, undefined, '模型可见结果不应再暴露内部 cursor')
  const hit = search.documents[0]
  const found = await store.getDocumentByTitle(hit.title)
  const documentId = found.record.document.document_id
  const target = found.record.lines.find((line) => String(line.text || '').trim().length >= 8)
  assert.ok(target)
  assert.match(hit.title, / · /u, '剧情命中应使用活动、章节、篇名、行动前后的自然语言完整标题')

  // 可读标题锚点可以和原搜索条件一起提交，且不会重复首条。
  store._cursorSecret = null
  const nextPage = await executeSearch(store, { query: '重生', resource_types: ['story'],
    after: search.page.next_after })
  assert.notEqual(nextPage.documents[0].title, hit.title)

  // 资料包只有 trigram 倒排；两字查询必须走 JSONL 分片预筛，不能退回全库
  // 逐文档解析并在硬时间预算内报 TIMEOUT。
  const shortLiteral = await executeSearch(store, { query: '九岁' })
  assert.notEqual(shortLiteral.status, 'error')
  assert.ok(shortLiteral.documents.length > 0)
  assert.ok(shortLiteral.documents.some((document) => document.matches.some((match) =>
    match.excerpt.some((line) => line.text.includes('九岁')))))

  // 已经出现在旧会话中的 v2 长 cursor 继续有效，升级不会截断进行中的分页。
  const legacyRequest = { query: '重生', filters: {
    resource_types: ['story'], character_names: [], story_names: [], activity_names: [],
    entity_names: [], speakers: [], wiki_sections: [],
  }, match_mode: 'literal', context_terms: [] }
  const legacyBody = Buffer.from(JSON.stringify({ v: 2, tool: 'corpus_search',
    data_version: store.dataVersion, request: legacyRequest, offset: 12 })).toString('base64url')
  const legacySecret = await store.getOrCreateCursorSecret()
  const legacyCursor = `${legacyBody}.${createHmac('sha256', legacySecret)
    .update(legacyBody).digest('base64url')}`
  const legacyPage = await executeSearch(store, { cursor: legacyCursor })
  assert.ok(legacyPage.documents.length > 0)

  const cloud = { code: 200, data: { selected_sources: [{ evidence_id: 'evi_test',
    document_id: documentId, title: hit.title, content_preview: target.text,
    source_type: 'vector_original' }] } }
  const hints = collectSourceHints(cloud.data)
  assert.equal(hints.length, 1)
  const mappings = await resolveCloudSources(store, hints)
  assert.equal(mappings.length, 1)
  assert.equal(mappings[0].document_uid, documentUid(documentId))
  assert.equal(mappings[0].title, hit.title)
  assert.equal(mappings[0].line, target.line_number)
  assert.equal(mappings[0].line_method, 'excerpt_match')
  assert.deepEqual(mappings[0].recommended_read, {
    title: hit.title, line: target.line_number, before: 4, after: 8,
  })

  const attached = await attachLocalSourceMappings(store, cloud)
  assert.equal(attached.local_source_mappings[0].line, target.line_number)
  const visit = (value, path = '$') => {
    assert.notEqual(value, undefined, `${path} 不得为 undefined`)
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}[${index}]`))
    else Object.entries(value).forEach(([key, item]) => visit(item, `${path}.${key}`))
  }
  visit(attached)
})

corpusTest('主项目短文件名与同关卡多篇剧情可确定性映射', async (t) => {
  const store = new CorpusStore({ releasesDir: resolve(packageDir, 'data/releases'),
    cursorSecretPath: resolve(stateDir, 'cursor-secret.bin') })
  await store.ready()

  const wiki = await resolveCloudSources(store, [{
    evidence_id: 'wiki-kaltsit', source_type: 'vector_wiki',
    source_file: 'prompt_char_003_kalts.txt', title: '凯尔希在离解复合剧情高光',
    excerpt: '凯尔希',
  }])
  assert.equal(wiki.length, 1)
  assert.equal(wiki[0].mapping_method, 'source_file_basename')
  if (wiki[0].activity_name) {
    assert.equal(wiki[0].activity_name, '离解复合')
    assert.equal(wiki[0].character_name, '凯尔希')
    assert.match(wiki[0].title, /^凯尔希 × 离解复合 \/ 角色活动 Wiki · 第 \d+ 篇$/u)
  } else {
    t.diagnostic('当前测试资料仍是旧版未拆分角色活动包；精确块映射由上方独立用例覆盖')
  }

  const beforeId = 'story:obt/main/level_main_15-15_beg'
  const before = await store.getDocument(beforeId)
  const excerptLine = before.record.lines.find((line) => String(line.text || '').trim().length >= 12)
  assert.ok(excerptLine)
  const story = await resolveCloudSources(store, [{
    evidence_id: 'scene-15-17-before', source_type: 'vector_scene', story_code: '15-17',
    source_file: '15-17 “她” 行动前', title: '离解复合 - 15-17 “她” 行动前',
    start_line: excerptLine.line_number, excerpt: excerptLine.text,
  }])
  assert.equal(story.length, 1)
  assert.equal(story[0].document_id, beforeId)
  assert.equal(story[0].mapping_method, 'story_code')
  assert.equal(story[0].line, excerptLine.line_number)
})
