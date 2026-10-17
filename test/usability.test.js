import { test } from 'node:test'
import assert from 'node:assert/strict'
import { looseTitleKey, dataVersionMatches, shortDataVersion } from '../src/store.js'
import { readableRenderedLine } from '../src/read.js'
import { renderI18n } from '../src/i18n.js'
import { projectSearch } from '../src/search-projection.js'

test('宽松标题键忽略分隔符、空白与全半角差异', () => {
  assert.equal(looseTitleKey('风雪过境 · BI-1 · 不欢而聚 · 行动后'), looseTitleKey('风雪过境BI1不欢而聚行动后'))
  assert.equal(looseTitleKey('银灰 × 风雪过境'), looseTitleKey('银灰×风雪过境'))
})

test('资料版本接受续页给出的短前缀，拒绝过短或不匹配的值', () => {
  const full = 'a'.repeat(32) + 'b'.repeat(32)
  assert.equal(shortDataVersion(full), 'aaaaaaaaaaaa')
  assert.ok(dataVersionMatches('aaaaaaaa', full))
  assert.ok(dataVersionMatches(full, full))
  assert.ok(!dataVersionMatches('aaaa', full))
  assert.ok(!dataVersionMatches('bbbbbbbb', full))
})

test('Wiki 字段标签渲染为可读标记', () => {
  assert.equal(readableRenderedLine({ line_number: 2, line_type: 'knowledge', text: '<活动名称>风雪过境</活动名称>' }),
    'L2 knowledge 活动名称：风雪过境')
  assert.equal(readableRenderedLine({ line_number: 1, line_type: 'knowledge', text: '<相关内容>' }),
    'L1 knowledge ［相关内容］')
  assert.equal(readableRenderedLine({ line_number: 3, line_type: 'dialogue', speaker_raw: '甲', text: '<相关内容>' }),
    'L3 dialogue 甲: <相关内容>')
})

test('多语言结果以文本展示，合并同文条目并给出短续页', () => {
  const text = renderI18n({}, { status: 'ok', game_version: '1.0', source_language: 'CN', languages: ['EN'],
    total_matches: 1, matches: [{ source: { language: 'CN', status: 'available', text: '佩丽卡' },
      translations: { EN: { status: 'available', text: 'Perlica' } }, merged_text_count: 30,
      references: [{ citation: '《终末地 · 某任务 · 对话 1》中文定位第 2 行' }], reference_count: 30 }],
    page: { has_more: true, continuation: { query: '佩丽卡', languages: ['EN'],
      after: { data_version: 'abcdefabcdef', request_hash: '123456789abc', position: 1, text_offset: 0 } } } })[0].text
  assert.doesNotMatch(text, /^\{/u)
  assert.match(text, /CN：佩丽卡/u)
  assert.match(text, /EN：Perlica/u)
  assert.match(text, /合并自 30 条/u)
  assert.match(text, /共 30 处，示例/u)
  assert.match(text, /续页：corpus_i18n\(/u)
})

test('目录型搜索结果为每篇给出可直接执行的读取调用，Wiki 提示只出现一次', () => {
  const text = projectSearch({ result_kind: 'documents', page: {}, documents: [
    { title: '甲 × 活动一 / 角色活动 Wiki · 第 1 篇', resource_type: 'character_activity_wiki', matches: [] },
    { title: '甲 × 活动二 / 角色活动 Wiki · 第 2 篇', resource_type: 'character_activity_wiki', matches: [] },
  ] })
  assert.equal((text.match(/引文状态/gu) || []).length, 1)
  assert.match(text, /读取：corpus_read\(\{"title":"甲 × 活动一 \/ 角色活动 Wiki · 第 1 篇"\}\)/u)
})

test('搜索命中保留原文全角标点，说话人格式与读取一致，高亮不与【】混淆', () => {
  const text = projectSearch({ result_kind: 'text_matches', page: {}, documents: [{
    title: '某篇', resource_type: 'story', matches_truncated: false,
    matches: [{ line_start: 1, line_end: 1, match_kind: 'literal', evidence_kind: 'official_canonical',
      citation: '《某篇》第 1 行', excerpt: [{ line: 1, role: 'match', speaker: '甲', text: '【代号】你好，世界？', truncated: false }] }],
  }] }, { query: '你好,世界', matchMode: 'literal' })
  assert.match(text, /甲: 【代号】⟦你好，世界⟧？/u)
})
