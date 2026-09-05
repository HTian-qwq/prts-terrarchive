import { test } from 'node:test'
import assert from 'node:assert/strict'
import { executeRead, projectReadPublic, renderRead } from '../src/read.js'
import { computeLinesIntegrity } from '../src/store.js'

test('corpus_read：activity 游标在文档边界从下一篇首行继续', async () => {
  const makeRecord = (id, texts) => {
    const lines = texts.map((text, index) => ({ line_number: index + 1,
      line_type: 'dialogue', speaker_raw: '', text }))
    const document = {
      game: 'arknights', document_id: id, document_type: 'story',
      display_title: id, activity_id: 'event:test', activity_name: '测试活动',
      line_count: lines.length, source_ref_prefix: `official_game:story:${id}`,
    }
    return { document, lines, local_integrity: { sha256: computeLinesIntegrity(lines) } }
  }
  const records = new Map([
    ['doc-a', makeRecord('doc-a', ['a1', 'a2'])],
    ['doc-b', makeRecord('doc-b', ['b1', 'b2'])],
  ])
  const store = {
    dataVersion: 'a'.repeat(64), packs: new Map([['official_game', {}]]),
    async ready() {},
    activityStoryDocuments() {
      return [...records.values()].map((record) => ({ document: record.document }))
    },
    async getDocument(id) {
      const record = records.get(id)
      return record ? { record, packId: 'official_game' } : null
    },
  }
  const page1 = await executeRead(store, {
    intent_id: 'boundary', locator: { activity_id: 'event:test' },
    selection: { mode: 'activity' }, limits: { max_lines: 2, max_chars: 100 },
  }, {})
  assert.equal(page1.status, 'ok')
  assert.deepEqual(page1.content.lines.map((line) => line.text), ['a1', 'a2'])
  assert.equal(page1.page.has_more, true)

  const page2 = await executeRead(store, {
    intent_id: 'boundary', locator: { activity_id: 'event:test' },
    selection: { mode: 'activity', cursor: page1.page.next_cursor },
    limits: { max_lines: 2, max_chars: 100 },
  }, {})
  assert.equal(page2.status, 'ok')
  assert.deepEqual(page2.content.lines.map((line) => line.text), ['b1', 'b2'])
  assert.equal(page2.page.has_more, false)
})

test('corpus_read：字符预算恰好落在文档边界时也不会跳过下一篇', async () => {
  const makeRecord = (id, text) => {
    const lines = [{ line_number: 1, line_type: 'dialogue', speaker_raw: '', text }]
    const document = {
      game: 'arknights', document_id: id, document_type: 'story',
      display_title: id, activity_id: 'event:chars', activity_name: '字符边界',
      line_count: 1, source_ref_prefix: `official_game:story:${id}`,
    }
    return { document, lines, local_integrity: { sha256: computeLinesIntegrity(lines) } }
  }
  const records = new Map([
    ['doc-a', makeRecord('doc-a', '甲'.repeat(100))],
    ['doc-b', makeRecord('doc-b', '乙'.repeat(100))],
  ])
  const store = {
    dataVersion: 'b'.repeat(64), packs: new Map([['official_game', {}]]),
    async ready() {},
    activityStoryDocuments() {
      return [...records.values()].map((record) => ({ document: record.document }))
    },
    async getDocument(id) {
      const record = records.get(id)
      return record ? { record, packId: 'official_game' } : null
    },
  }
  const page1 = await executeRead(store, {
    intent_id: 'char-boundary', locator: { activity_id: 'event:chars' },
    selection: { mode: 'activity' }, limits: { max_lines: 100, max_chars: 100 },
  }, {})
  assert.deepEqual(page1.content.lines.map((line) => line.text), ['甲'.repeat(100)])
  assert.equal(page1.page.has_more, true)

  const page2 = await executeRead(store, {
    intent_id: 'char-boundary', locator: { activity_id: 'event:chars' },
    selection: { mode: 'activity', cursor: page1.page.next_cursor },
    limits: { max_lines: 100, max_chars: 100 },
  }, {})
  assert.deepEqual(page2.content.lines.map((line) => line.text), ['乙'.repeat(100)])
  assert.equal(page2.page.has_more, false)
})

test('corpus_read：终末地集合使用自然 position 跨碎片续读并保留逐篇引用', async () => {
  const makeRecord = (id, title, texts, contentType) => {
    const lines = texts.map((text, index) => ({ line_number: index + 1,
      line_type: 'dialogue', speaker_raw: '', text }))
    const document = {
      game: 'endfield', document_id: id, document_type: 'story', document_kind: 'story',
      resource_type: 'original_story', document_category: 'endfield_original',
      display_title: title, collection_id: 'mission:test', collection_name: '测试任务',
      content_type: contentType, line_count: lines.length,
      source_ref_prefix: `prts:endfield:${id}`,
    }
    return { document, lines, local_integrity: { sha256: computeLinesIntegrity(lines) } }
  }
  const records = new Map([
    ['doc-a', makeRecord('doc-a', '测试任务 · 对话', ['a1', 'a2'], 'dialogue')],
    ['doc-b', makeRecord('doc-b', '测试任务 · 广播', ['b1', 'b2'], 'radio')],
  ])
  const store = {
    dataVersion: 'c'.repeat(64), packs: new Map([['endfield_official_game', {}]]),
    async ready() {},
    endfieldCollectionDocuments({ contentTypes = [] }) {
      return [...records.values()].filter((record) => !contentTypes.length
        || contentTypes.includes(record.document.content_type))
        .map((record) => ({ document: record.document }))
    },
    async getDocument(id) {
      const record = records.get(id)
      return record ? { record, packId: 'endfield_official_game' } : null
    },
  }
  const page = await executeRead(store, {
    intent_id: 'collection-position', locator: { collection_name: '测试任务' },
    selection: { mode: 'collection', start_position: 2 },
    limits: { max_lines: 2, max_chars: 100 },
  }, {})
  assert.equal(page.status, 'ok')
  assert.deepEqual(page.content.lines.map((line) => [line.stream_position, line.text]),
    [[2, 'a2'], [3, 'b1']])
  assert.equal(page.content.lines[1].document_title, '终末地 · 测试任务 · 广播')
  const projected = projectReadPublic(page)
  assert.deepEqual(projected.page.continuation, {
    collection_name: '测试任务', mode: 'collection', position: 4,
    data_version: store.dataVersion,
  })
  const rendered = renderRead({}, projected)[0].text
  assert.match(rendered, /测试任务 · 对话/u)
  assert.match(rendered, /测试任务 · 广播/u)
  assert.doesNotMatch(rendered, /cursor/u)

  const radioOnly = await executeRead(store, {
    intent_id: 'collection-filter', locator: { collection_name: '测试任务' },
    selection: { mode: 'collection', content_types: ['radio'] },
    limits: { max_lines: 1, max_chars: 100 },
  }, {})
  assert.deepEqual(radioOnly.content.lines.map((line) => line.text), ['b1'])
  assert.deepEqual(projectReadPublic(radioOnly).page.continuation.content_types, ['radio'])
})
