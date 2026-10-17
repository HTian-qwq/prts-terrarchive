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

test('nondefault orphan modifiers and incomplete requests remain available for strict validation', () => {
  for (const extra of [{ story_part: 'after' }, { segment: 2 }, { material: 'voice' }, { game: 'invalid' }]) {
    const raw = { document_uid: uid, ...extra }
    assert.deepEqual(normalizeReadArguments(raw, { sections }).args, raw)
  }
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
