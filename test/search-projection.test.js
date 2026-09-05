import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectSearch } from '../src/search-projection.js'

test('grep renderer 按文档显示命中、上下文、证据和自然 citation', () => {
  const projection = projectSearch({ result_kind: 'text_matches', documents: [{
    title: '孤星 · CW-ST-4 · 行动后', resource_type: 'story', matches_truncated: false,
    matches: [{ line_start: 123, line_end: 123, match_kind: 'literal',
      evidence_kind: 'official_canonical', citation: '《孤星 · CW-ST-4 · 行动后》第 123 行',
      excerpt: [
        { line: 122, role: 'context', speaker: '', text: '前文', truncated: false },
        { line: 123, role: 'match', speaker: '凯尔希', text: '命中', truncated: false },
        { line: 124, role: 'context', speaker: '', text: '后文', truncated: false },
      ] }],
  }], page: { next_after: { data_version: 'a'.repeat(64), resource_type: 'story',
    title: '孤星 · CW-ST-4 · 行动后', position: 123 } } })
  assert.match(projection, /找到 1 篇资料，共展示 1 处命中/u)
  assert.match(projection, />\s+123 凯尔希：命中/u)
  assert.match(projection, /引用：《孤星 · CW-ST-4 · 行动后》第 123 行/u)
  assert.match(projection, /设置 after:.*孤星 · CW-ST-4 · 行动后/u)
  assert.match(projection, /data_version.*[a-f0-9]{64}/u)
  assert.doesNotMatch(projection, /document_id|source_ref/u)
})

test('目录不伪造首行，完整字段明确完整性', () => {
  const catalog = projectSearch({ result_kind: 'documents', documents: [{ title: '凯尔希',
    resource_type: 'character_wiki', matches: [], matches_truncated: false,
    available_sections: ['相关活动'] }], page: {} })
  assert.match(catalog, /资料入口/u)
  assert.doesNotMatch(catalog, /命中：第/u)

  const section = projectSearch({ result_kind: 'complete_sections', documents: [{ title: '凯尔希',
    resource_type: 'character_wiki', matches: [], matches_truncated: false,
    section_content: { section: '相关活动', completeness: 'complete',
      blocks: [{ type: 'text', text: '孤星：……' }], citation: '《凯尔希》Wiki·相关活动' } }], page: {} })
  assert.match(section, /字段：相关活动（完整）/u)
  assert.match(section, /孤星：……/u)
})

test('同名文档明确用 document_uid 替代 title 读取', () => {
  const projection = projectSearch({ result_kind: 'documents', documents: [{
    title: '终末地 · 记忆之灰 · 对话 7', document_uid: 'doc_0t23T_OgquiZQG8_',
    resource_type: 'original_story', matches: [], matches_truncated: false,
  }], page: {} })
  assert.match(projection,
    /读取时仅提交 document_uid=doc_0t23T_OgquiZQG8_.*替代 title.*不要同时提交二者/u)
})

test('零命中只给简短恢复建议', () => {
  const projection = projectSearch({ result_kind: 'text_matches', documents: [],
    page: { exhausted: true, total_documents: 0, next_after: null } })
  assert.match(projection, /没有找到/u)
  assert.match(projection, /缩短连续字面串/u)
})

test('空的扫描进度页不伪装成全库零命中', () => {
  const projection = projectSearch({ result_kind: 'text_matches', documents: [],
    page: { exhausted: false,
      next_after: { data_version: 'b'.repeat(64), resource_type: 'story',
        title: '测试活动 · T-255 · 测试篇章 255', position: 255 } } })
  assert.match(projection, /不是全库零命中/u)
  assert.match(projection, /扫描尚未穷尽/u)
  assert.match(projection, /设置 after:.*测试活动/u)
  assert.doesNotMatch(projection, /已检查完整检索范围，没有找到/u)
})

test('literal 命中只在模型预览的命中行高亮，能显出中文跨词边界', () => {
  const value = { result_kind: 'text_matches', documents: [{
    title: '普瑞赛斯', resource_type: 'character_wiki', matches_truncated: false,
    matches: [{ line_start: 2, line_end: 2, match_kind: 'literal', evidence_kind: 'wiki_curated',
      citation: '《普瑞赛斯》第 2 行', excerpt: [
        { line: 1, role: 'context', speaker: '', text: '前文也写了目的', truncated: false },
        { line: 2, role: 'match', speaker: '', text: '她谈到源石项目的进度', truncated: false },
      ] }],
  }], page: {} }
  const projection = projectSearch(value, { query: '目的', matchMode: 'literal' })
  assert.match(projection, /源石项【目的】进度/u)
  assert.match(projection, /前文也写了目的/u)
  assert.doesNotMatch(projection, /前文也写了【目的】/u)
  assert.equal(value.documents[0].matches[0].excerpt[1].text, '她谈到源石项目的进度')
})

test('Wiki 文档明确标识整理性引文未核验为当前官方原文', () => {
  const wiki = projectSearch({ result_kind: 'documents', documents: [{ title: '普瑞赛斯',
    resource_type: 'character_wiki', matches: [], matches_truncated: false }], page: {} })
  assert.match(wiki, /引文状态：Wiki 为整理性资料/u)
  assert.match(wiki, /逐字引用前请回查原文/u)

  const original = projectSearch({ result_kind: 'documents', documents: [{ title: '某篇原文',
    resource_type: 'story', matches: [], matches_truncated: false }], page: {} })
  assert.doesNotMatch(original, /引文状态/u)
})

test('实体资料优先渲染可读概述与历史，不显示底层 JSON 行', () => {
  const projection = projectSearch({ result_kind: 'text_matches', documents: [{
    title: '乌萨斯 / 实体资料', resource_type: 'entity_profile', matches_truncated: false,
    matches: [], entity_summary: { canonical_name: '乌萨斯', description: '北方的庞大帝国。',
      history_summary: '经历建国、扩张和大叛乱。', truncated: false,
      citation: '《乌萨斯 / 实体资料》' },
  }], page: {} }, { query: '乌萨斯' })
  assert.match(projection, /概述：北方的庞大帝国/u)
  assert.match(projection, /历史：经历建国、扩张和大叛乱/u)
  assert.doesNotMatch(projection, /canonical_name|aliases|attributes/u)
})
