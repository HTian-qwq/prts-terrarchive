import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeReadArguments, readTargets, readTargetError, withReadGuidance } from '../src/read-args.js'
import { renderRead } from '../src/read.js'

const uid = 'doc_0123456789abcdef'
const sections = ['剧情总结', '详细介绍']
const polluted = { activity_name: '', after: 3, before: 3, character_name: '', collection_name: '',
  content_types: [], cursor: '', data_version: '', document_uid: uid, game: 'endfield', line: 1,
  material: 'profile', max_chars: 8000, max_lines: 100, mode: 'document', position: 0,
  record_name: '', section: '剧情总结', segment: 1, stage_code: '', story_part: 'story', title: '' }

test('exact full-field UID request keeps the target and limits; explains every compatibility decision', () => {
  const original = structuredClone(polluted)
  const { args, guidance } = normalizeReadArguments(polluted, { sections })
  assert.deepEqual(args, { after: 3, before: 3, document_uid: uid, line: 1,
    max_chars: 8000, max_lines: 100, mode: 'document' })
  assert.deepEqual(polluted, original)
  assert.deepEqual(normalizeReadArguments(args, { sections }).args, args)
  for (const key of ['story_part', 'segment', 'material', 'game', 'section=剧情总结']) assert.ok(guidance.includes(key))
  assert.match(guidance, /未改变目标文档/u)
  assert.match(guidance, /未应用 section/u)
})

test('real target conflicts are never resolved by UID precedence and have independent actionable retries', () => {
  for (const extra of [{ title: '另一标题' }, { stage_code: '15-17' },
    { character_name: '阿米娅', material: 'profile' }, { character_name: '阿米娅', record_name: '旧事' },
    { activity_name: '孤星' }, { collection_name: '着新墨' }]) {
    const raw = { document_uid: uid, mode: 'document', ...extra }
    const { args, guidance } = normalizeReadArguments(raw, { sections })
    assert.deepEqual(args, raw)
    assert.equal(guidance, '')
    assert.equal(readTargets(args).length, 2)
    const message = readTargetError(args)
    assert.ok(message.includes(Object.keys(extra).at(-1)))
    assert.match(message, /实际冲突/u)
    assert.ok(message.includes(JSON.stringify({ document_uid: uid, mode: 'document' })))
  }
})

test('没有对应主定位的附属参数一律忽略并说明，非法值仍交给严格校验', () => {
  // 表单式调用会把可选字段全填上：story_part/segment/material/start_line 只要没有
  // 对应的主定位就不表达意图，忽略即可，不该让调用方在同一处反复失败。
  for (const extra of [{ story_part: 'after' }, { segment: 2 }, { material: 'voice' }]) {
    const raw = { document_uid: uid, ...extra }
    const normalized = normalizeReadArguments(raw, { sections })
    assert.deepEqual(normalized.args, { document_uid: uid })
    assert.match(normalized.guidance, /参数适配/u)
  }
  // 有 line 时是 around 模式，start_line 无意义，同样忽略
  const aroundWithStart = normalizeReadArguments({ title: '全文', line: 5, start_line: 7 }, { sections })
  assert.deepEqual(aroundWithStart.args, { title: '全文', line: 5 })
  assert.match(aroundWithStart.guidance, /start_line/u)
  // 单独给 start_line 是合法的全文起点，必须保留
  assert.deepEqual(
    normalizeReadArguments({ document_uid: uid, start_line: 7 }, { sections }).args,
    { document_uid: uid, start_line: 7 })
  // 非法值不是占位，仍然暴露给执行层
  const invalidGame = { document_uid: uid, game: 'invalid' }
  assert.deepEqual(normalizeReadArguments(invalidGame, { sections }).args, invalidGame)
  // 没有主定位时不做任何猜测，仍按缺少定位信息报错
  for (const raw of [{ material: 'profile' }, { story_part: 'story' }, { segment: 1 }, { character_name: '祀' }]) {
    assert.deepEqual(normalizeReadArguments(raw, { sections }).args, raw)
    assert.match(readTargetError(raw), /缺少主定位信息/u)
  }
})

test('section intent survives unless a known field conflicts with explicit full-document mode', () => {
  for (const target of [{ document_uid: uid }, { title: '准确标题' }]) {
    for (const mode of [undefined, 'section']) {
      const raw = { ...target, section: '剧情总结', ...(mode ? { mode } : {}) }
      assert.deepEqual(normalizeReadArguments(raw, { sections }).args, raw)
    }
    const invalid = { ...target, mode: 'document', section: '不存在的字段' }
    assert.deepEqual(normalizeReadArguments(invalid, { sections }).args, invalid)
    const selected = normalizeReadArguments({ ...target, mode: 'document', section: '剧情总结' }, { sections })
    assert.equal(selected.args.section, undefined)
    assert.match(selected.guidance, /未应用 section=剧情总结/u)
  }
})

test('page positions, nonzero start lines, filters, versions and legacy cursor remain intact', () => {
  for (const raw of [
    { title: '全文', mode: 'document', line: 101, data_version: 'a'.repeat(64) },
    { title: '全文', line: 5, before: 0, after: 0 },
    { collection_name: '着新墨', mode: 'collection', position: 9, content_types: ['dialogue'], data_version: 'a'.repeat(64) },
    { activity_name: '孤星', mode: 'activity', position: 9 },
    { document_uid: uid, mode: 'collection', position: 9, content_types: ['radio'] },
    { document_uid: uid, mode: 'document', position: 9, data_version: 'bad' },
    { cursor: 'signed-cursor', title: '全文', mode: 'document', section: '剧情总结', story_part: 'story' },
  ]) assert.deepEqual(normalizeReadArguments(raw, { sections }).args, raw)
})

test('normalization guidance is visible in host text and composes with coverage guidance', () => {
  const value = { primary: { title: '测试', kind: 'wiki_curated', lines: [],
    selection: { line_start: 1, line_end: 1 }, citation: '测试引文' },
    page: { has_more: false }, guidance: '范围已复用' }
  const projected = withReadGuidance(value, '未应用 section=剧情总结')
  assert.equal(value.guidance, '范围已复用')
  assert.match(renderRead({}, projected)[0].text, /范围已复用\n未应用 section=剧情总结/u)
  assert.equal(withReadGuidance(value, ''), value)
})

test('句柄 citation 解析与互斥校验', async () => {
  const { parseCitation, formatCitation } = await import('../src/read-args.js')
  assert.deepEqual(parseCitation(`doc_${'a'.repeat(16)}#L12`),
    { documentUid: `doc_${'a'.repeat(16)}`, startLine: 12, endLine: 12 })
  assert.deepEqual(parseCitation(`doc_${'a'.repeat(16)}#L12-L30`),
    { documentUid: `doc_${'a'.repeat(16)}`, startLine: 12, endLine: 30 })
  assert.equal(parseCitation('甲篇#L12'), null)
  assert.equal(parseCitation(`doc_${'a'.repeat(16)}#L30-12`), null)
  assert.equal(parseCitation(`doc_${'a'.repeat(16)}#L0`), null)
  assert.equal(formatCitation(`doc_${'a'.repeat(16)}`, 15), `doc_${'a'.repeat(16)}#L15`)
  assert.equal(formatCitation(`doc_${'a'.repeat(16)}`, 15, 18), `doc_${'a'.repeat(16)}#L15-18`)
})
