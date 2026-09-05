/**
 * corpus_read 冒烟测试（node --test，使用真实资料包 complete-v3）。
 * 运行：npm test（或 node --test test/）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { CorpusStore, normalizeStoryStageCode, publicStoryStageCode } from '../src/store.js'
import { executeRead, renderRead, normalizeReadRequest } from '../src/read.js'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const releasesDir = resolve(packageDir, 'data', 'releases')
const corpusTest = existsSync(resolve(releasesDir, 'current.json')) ? test : test.skip

const AMIYA_DOC = 'character:char_002_amiya:archives' // 119 行，official_game 包首文档
const AMIYA_REF = 'official_game:character:char_002_amiya:archives:L1'

function makeRuntime(overrides = {}) {
  return { ...overrides }
}

function assertLosslessJson(value) {
  const serialized = JSON.stringify(value)
  assert.notEqual(serialized, undefined)
  assert.deepEqual(JSON.parse(serialized), value)
}

test('明日方舟关卡代号归一化兼容大小写、全角横线与空格', () => {
  assert.equal(normalizeStoryStageCode(' gt－3 '), 'GT-3')
  assert.equal(normalizeStoryStageCode('15 – 17'), '15-17')
  assert.equal(publicStoryStageCode('GT-3'), 'GT-3')
  assert.equal(publicStoryStageCode('GT-\n3'), '', '资料元数据中的控制字符不得合并到合法关卡键')
  assert.equal(publicStoryStageCode(' gt－3 ', { relaxedInput: true }), 'GT-3')
})

test('normalizeReadRequest：默认值与跨字段规则', () => {
  const { normalized, refLine } = normalizeReadRequest({
    intent_id: 'test-intent',
    locator: { source_ref: AMIYA_REF },
    selection: { mode: 'around' },
  })
  assert.equal(normalized.selection.before_lines, 3)
  assert.equal(normalized.selection.after_lines, 3)
  assert.equal(normalized.format, 'lines')
  assert.equal(normalized.include_adjacent_documents, true)
  assert.equal(normalized.limits.max_lines, 100)
  assert.equal(refLine, 1)
  assert.ok(normalized.request_id.startsWith('req-'))

  // document_id + around 必须 center_line
  assert.throws(
    () => normalizeReadRequest({
      intent_id: 't', locator: { document_id: AMIYA_DOC }, selection: { mode: 'around' },
    }),
    /center_line/,
  )
  // locator 必须恰好一个
  assert.throws(
    () => normalizeReadRequest({
      intent_id: 't', locator: {}, selection: { mode: 'document' },
    }),
    /exactly one/,
  )
  // source_ref 格式非法
  assert.throws(
    () => normalizeReadRequest({
      intent_id: 't', locator: { source_ref: 'official_game:bogus:L1' }, selection: { mode: 'around' },
    }),
    (error) => error.code === 'SOURCE_REF_INVALID',
  )
})

test('normalizeReadRequest 接受联合协议的终末地稳定 source_ref', () => {
  const { normalized, refLine } = normalizeReadRequest({
    intent_id: 'endfield-ref',
    locator: { source_ref: 'prts:endfield:story:dlg_c34m1_01:L18' },
    selection: { mode: 'around' },
  })
  assert.equal(refLine, 18)
  assert.equal(normalized.locator.source_ref, 'prts:endfield:story:dlg_c34m1_01:L18')

  const archive = normalizeReadRequest({
    intent_id: 'endfield-archive-ref',
    locator: { source_ref: 'prts:endfield:archive:nar_document_v0d8_14_1:L5' },
    selection: { mode: 'around' },
  })
  assert.equal(archive.refLine, 5)

  const profile = normalizeReadRequest({
    intent_id: 'endfield-profile-ref',
    locator: { source_ref: 'prts:endfield:character:chr_0034_typhoea:profiles:L5' },
    selection: { mode: 'around' },
  })
  assert.equal(profile.refLine, 5)
})

corpusTest('store：初始化并建立文档索引', async () => {
  const store = new CorpusStore({ releasesDir })
  await store.ready()
  assert.equal(store.releaseId, 'agent-corpus-v1-20260826-timeline-v1')
  assert.match(store.dataVersion, /^[0-9a-f]{64}$/)
  assert.ok(store.documents.size >= 14000, `documents=${store.documents.size}`)
  assert.ok(store.packs.size === 5, `packs=${store.packs.size}`)
  assert.equal(store.getDocumentIdByPrefix('official_game:character:char_002_amiya:archives'), AMIYA_DOC)
})

corpusTest('corpus_read：display_title 定位（title+line 表面）', async () => {
  const store = new CorpusStore({ releasesDir })
  const response = await executeRead(store, {
    intent_id: 'title-1',
    locator: { display_title: '骑兵与猎人 / 日正当中 / 行动前' },
    selection: { mode: 'around', center_line: 10, before_lines: 1, after_lines: 1 },
  }, makeRuntime())
  assert.equal(response.status, 'ok')
  assert.equal(response.document.activity_name, '骑兵与猎人')
  assert.equal(response.selection.line_start, 9)
  assert.equal(response.selection.line_end, 11)

  // 标题未命中
  const notFound = await executeRead(store, {
    intent_id: 'title-2', locator: { display_title: '不存在的篇章标题' },
    selection: { mode: 'document' },
  }, makeRuntime())
  assert.equal(notFound.status, 'error')
  assert.equal(notFound.error.code, 'DOCUMENT_NOT_FOUND')

  // around + display_title 缺 center_line → 执行期 LINE_RANGE_INVALID
  const noCenter = await executeRead(store, {
    intent_id: 'title-3', locator: { display_title: '骑兵与猎人 / 日正当中 / 行动前' },
    selection: { mode: 'around' },
  }, makeRuntime())
  assert.equal(noCenter.error.code, 'LINE_RANGE_INVALID')
})

corpusTest('corpus_read：实体资料与角色 Wiki 都使用类型化自然标题', async () => {
  const store = new CorpusStore({ releasesDir })
  const wikiByTitle = await executeRead(store, {
    intent_id: 'wiki-natural-title', locator: { display_title: '凯尔希 / 角色 Wiki' },
    selection: { mode: 'section', section: '相关活动' },
  }, makeRuntime())
  assert.equal(wikiByTitle.status, 'ok')
  assert.equal(wikiByTitle.document.document_kind, 'wiki')

  const entityByTitle = await executeRead(store, {
    intent_id: 'entity-natural-title', locator: { display_title: '凯尔希 / 实体资料' },
    selection: { mode: 'document' }, limits: { max_lines: 5 },
  }, makeRuntime())
  assert.equal(entityByTitle.status, 'ok')
  assert.equal(entityByTitle.document.document_type, 'entity')

  await store.ready()
  let wiki = null
  for await (const record of store.iterateDocuments({
    predicate: (document) => document.document_type === 'knowledge'
      && document.document_kind === 'wiki' && document.character_name === '凯尔希',
  })) {
    wiki = record
    break
  }
  assert.ok(wiki)
  const response = await executeRead(store, {
    intent_id: 'wiki-ref',
    locator: { source_ref: `${wiki.document.source_ref_prefix}:L1` },
    selection: { mode: 'document' }, limits: { max_lines: 5 },
  }, makeRuntime())
  assert.equal(response.status, 'ok')
  assert.equal(response.document.document_type, 'knowledge')
  assert.equal(response.document.document_kind, 'wiki')
  assert.equal(response.document.character_name, '凯尔希')
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(response)))
})

corpusTest('corpus_read：section 模式只读取 Wiki 标签内部正文', async () => {
  const store = new CorpusStore({ releasesDir })
  await store.ready()
  let wiki = null
  for await (const record of store.iterateDocuments({ predicate: (document) =>
    document.document_type === 'knowledge' && document.document_kind === 'wiki'
      && document.character_name === '凯尔希' })) {
    wiki = record
    break
  }
  assert.ok(wiki)
  const response = await executeRead(store, { intent_id: 'wiki-section',
    locator: { source_ref: `${wiki.document.source_ref_prefix}:L1` },
    selection: { mode: 'section', section: '相关活动' } }, makeRuntime())
  assert.equal(response.status, 'ok')
  assert.equal(response.selection.mode, 'section')
  assert.equal(response.selection.wiki_section, '相关活动')
  assert.equal(response.selection.line_start, 107)
  assert.equal(response.selection.line_end, 125)
  assert.equal(response.content.lines.length, 19)
  assert.ok(response.content.lines.every((line) => !/<\/?相关活动>/u.test(line.text)))
  assert.match(renderRead({}, response)[0].text, /字段：相关活动/u)
  assert.match(renderRead({}, response)[0].text, /引文状态：Wiki 为整理性资料/u)
  assert.match(renderRead({}, response)[0].text, /引用：《凯尔希 \/ 角色 Wiki》Wiki·相关活动/u)

  const invalid = await executeRead(store, { intent_id: 'wiki-section-invalid',
    locator: { document_id: AMIYA_DOC }, selection: { mode: 'section', section: '相关活动' } },
  makeRuntime())
  assert.equal(invalid.status, 'error')
  assert.equal(invalid.error.code, 'INVALID_REQUEST')
})

corpusTest('corpus_read：故事原文不自动夹带剧情总结与活动时间线', async () => {
  const store = new CorpusStore({ releasesDir })
  const response = await executeRead(store, {
    intent_id: 'attach-1',
    locator: { display_title: '骑兵与猎人 / 日正当中 / 行动前' },
    selection: { mode: 'around', center_line: 5 },
  }, makeRuntime())
  assert.equal(response.status, 'ok')

  assert.equal(response.story_context, undefined)
  assert.equal(response.activity_timeline, undefined)
  assert.equal(response.stats.companion_context_chars, undefined)
  assertLosslessJson(response)

  const text = renderRead({}, response)[0].text
  assert.ok(!text.includes('自建剧情总结'))
  assert.ok(!text.includes('所属活动时间线'))

  // 密录（memory）→ exact_story 作用域
  const memory = await executeRead(store, {
    intent_id: 'attach-2',
    locator: { display_title: '12F / 干员密录 / 一些选择 / 正文' },
    selection: { mode: 'around', center_line: 5 },
  }, makeRuntime())
  assert.equal(memory.status, 'ok')
  assert.equal(memory.story_context, undefined)
})

corpusTest('corpus_read：source_ref + around（以引用行为中心）', async () => {
  const store = new CorpusStore({ releasesDir })
  const response = await executeRead(store, {
    intent_id: 'intent-1',
    locator: { source_ref: 'official_game:character:char_002_amiya:archives:L10' },
    selection: { mode: 'around', before_lines: 2, after_lines: 2 },
  }, makeRuntime())

  assert.equal(response.status, 'ok')
  assert.equal(response.contract_version, 'prts-corpus-tools-v1')
  assert.equal(response.selection.mode, 'around')
  assert.equal(response.selection.line_start, 8)
  assert.equal(response.selection.line_end, 12)
  assert.equal(response.content.format, 'lines')
  assert.equal(response.content.lines.length, 5)
  for (const line of response.content.lines) {
    assert.match(line.source_ref, /:L\d+$/)
  }
  assert.equal(response.integrity.verified, true)
  assert.ok(response.adjacent_documents)
  assert.equal(response.document.document_id, AMIYA_DOC)
})

corpusTest('corpus_read：document_id + range + plain_text + 截断', async () => {
  const store = new CorpusStore({ releasesDir })
  const response = await executeRead(store, {
    intent_id: 'intent-2',
    locator: { document_id: AMIYA_DOC },
    selection: { mode: 'range', start_line: 1, end_line: 119 },
    format: 'plain_text',
    limits: { max_lines: 500, max_chars: 200 },
  }, makeRuntime())

  assert.equal(response.status, 'ok')
  assert.equal(response.content.format, 'plain_text')
  assert.equal(response.selection.truncated, true)
  assert.equal(response.selection.truncation_reason, 'max_chars')
  // max_chars 按行文本字符数计（selection.character_count ≤ max_chars），拼接换行不计入
  assert.ok(response.selection.character_count <= 200)
  assert.ok(response.content.text.length <= 200 + response.selection.line_count)
})

corpusTest('corpus_read：document 模式游标分页', async () => {
  const store = new CorpusStore({ releasesDir })
  const runtime = makeRuntime()
  const page1 = await executeRead(store, {
    intent_id: 'intent-3',
    locator: { document_id: AMIYA_DOC },
    selection: { mode: 'document' },
    limits: { max_lines: 10 },
  }, runtime)
  assert.equal(page1.status, 'ok')
  assert.equal(page1.selection.line_count, 10)
  assert.equal(page1.page.has_more, true)
  assert.ok(page1.page.next_cursor)

  const page2 = await executeRead(store, {
    intent_id: 'intent-3',
    locator: { document_id: AMIYA_DOC },
    selection: { mode: 'document', cursor: page1.page.next_cursor },
    limits: { max_lines: 10 },
  }, runtime)
  assert.equal(page2.status, 'ok')
  assert.equal(page2.selection.line_start, 11)
  assert.equal(page2.selection.line_end, 20)

  const naturalPage2 = await executeRead(store, {
    intent_id: 'intent-3',
    locator: { document_id: AMIYA_DOC },
    selection: { mode: 'document', start_line: 11 },
    limits: { max_lines: 10 },
  }, runtime)
  assert.equal(naturalPage2.status, 'ok')
  assert.equal(naturalPage2.selection.mode, 'document')
  assert.equal(naturalPage2.selection.line_start, 11)
  assert.equal(naturalPage2.selection.line_end, 20)
})

corpusTest('corpus_read：错误码（文档/行号/游标/版本）', async () => {
  const store = new CorpusStore({ releasesDir })
  const runtime = makeRuntime()

  const notFound = await executeRead(store, {
    intent_id: 'e1', locator: { document_id: 'nope' }, selection: { mode: 'document' },
  }, runtime)
  assert.equal(notFound.status, 'error')
  assert.equal(notFound.error.code, 'DOCUMENT_NOT_FOUND')

  const badRange = await executeRead(store, {
    intent_id: 'e2', locator: { document_id: AMIYA_DOC },
    selection: { mode: 'range', start_line: 999, end_line: 1000 },
  }, runtime)
  assert.equal(badRange.error.code, 'LINE_RANGE_INVALID')

  const badCursor = await executeRead(store, {
    intent_id: 'e3', locator: { document_id: AMIYA_DOC },
    selection: { mode: 'document', cursor: 'garbage.cursor' },
  }, runtime)
  assert.equal(badCursor.error.code, 'CURSOR_INVALID')

  const versionMismatch = await executeRead(store, {
    intent_id: 'e4', locator: { document_id: AMIYA_DOC },
    selection: { mode: 'document' },
    expected_data_version: '0'.repeat(64),
  }, runtime)
  assert.equal(versionMismatch.error.code, 'PACKAGE_VERSION_MISMATCH')

})

corpusTest('renderRead：模型可见文本', async () => {
  const store = new CorpusStore({ releasesDir })
  const response = await executeRead(store, {
    intent_id: 'render-1',
    locator: { source_ref: 'official_game:character:char_002_amiya:archives:L1' },
    selection: { mode: 'around', before_lines: 0, after_lines: 1 },
  }, makeRuntime())
  const blocks = renderRead({}, response)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  const text = blocks[0].text
  assert.match(text, /^# /u)
  assert.ok(text.includes('L1 '))
  assert.match(text, /引用：《.+》第 1-2 行/u)
  assert.doesNotMatch(text, /source_ref|document_id|data_version/u)

  const dialogue = structuredClone(response)
  dialogue.content.lines = [{ line_number: 9, line_type: 'dialogue', speaker_raw: '阿米娅',
    text: '阿米娅: 博士，请听我说。' }]
  dialogue.selection = { ...dialogue.selection, line_start: 9, line_end: 9, line_count: 1,
    character_count: dialogue.content.lines[0].text.length }
  const dialogueText = renderRead({}, dialogue)[0].text
  assert.match(dialogueText, /L9 dialogue 阿米娅: 博士，请听我说。/u)
  assert.doesNotMatch(dialogueText, /阿米娅: 阿米娅:/u)

  const errorBlocks = renderRead({}, {
    status: 'error',
    error: { code: 'DOCUMENT_NOT_FOUND', message: 'x', retryable: false },
  })
  assert.ok(errorBlocks[0].text.includes('code=DOCUMENT_NOT_FOUND'))
})

corpusTest('corpus_read：activity 模式按活动通读全部剧情原文', async () => {
  const store = new CorpusStore({ releasesDir })
  const page1 = await executeRead(store, {
    intent_id: 'activity-1',
    locator: { activity_name: '骑兵与猎人' },
    selection: { mode: 'activity' },
    limits: { max_lines: 4, max_chars: 2000 },
  }, makeRuntime())
  assert.equal(page1.status, 'ok')
  assert.equal(page1.selection.mode, 'activity')
  assert.equal(page1.activity.activity_name, '骑兵与猎人')
  assert.equal(page1.activity.story_count, 16)
  assert.equal(page1.activity.total_lines, 913)
  assert.equal(page1.selection.line_count, 4)
  assert.ok(page1.activity.activity_id) // 期望 event:1stact
  // 每行都带可引用 source_ref
  for (const line of page1.content.lines) {
    assert.match(line.source_ref, /^official_game:story:/)
  }
  assert.ok(page1.page.has_more)
  assert.ok(page1.page.next_cursor)

  // 跨文档续读：第二页应继续同一活动，且行数正确
  const page2 = await executeRead(store, {
    intent_id: 'activity-1',
    locator: { activity_name: '骑兵与猎人' },
    selection: { mode: 'activity', cursor: page1.page.next_cursor },
    limits: { max_lines: 4, max_chars: 2000 },
  }, makeRuntime())
  assert.equal(page2.status, 'ok')
  assert.equal(page2.selection.line_count, 4)

  // activity_id 定位等价
  const pageById = await executeRead(store, {
    intent_id: 'activity-2',
    locator: { activity_id: page1.activity.activity_id },
    selection: { mode: 'activity' },
    limits: { max_lines: 2, max_chars: 2000 },
  }, makeRuntime())
  assert.equal(pageById.status, 'ok')
  assert.equal(pageById.activity.activity_name, '骑兵与猎人')

  // 未知活动
  const missing = await executeRead(store, {
    intent_id: 'activity-3',
    locator: { activity_name: '不存在之活动' },
    selection: { mode: 'activity' },
  }, makeRuntime())
  assert.equal(missing.status, 'error')
  assert.equal(missing.error.code, 'DOCUMENT_NOT_FOUND')

  // normalize：activity locator 必须恰好一个；activity selection 需 activity locator
  assert.throws(
    () => normalizeReadRequest({
      intent_id: 't', locator: {}, selection: { mode: 'activity' },
    }),
    /exactly one/,
  )
  assert.throws(
    () => normalizeReadRequest({
      intent_id: 't', locator: { document_id: AMIYA_DOC }, selection: { mode: 'activity' },
    }),
    /activity mode requires/,
  )
})
