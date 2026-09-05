import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectCloudInspect, projectCloudSearch } from '../src/cloud-projection.js'

// 与前端实现的一致性对照依赖 monorepo 内的 agent/browser 兄弟仓库；独立
// checkout / 独立归档环境没有该仓库时，对照用例降级为跳过（而不是让
// 整个 npm test 因模块解析失败而报错）。
let browserSearch = null
let browserInspect = null
try {
  const browser = await import('../../agent/browser/src/context-manager.js')
  browserSearch = browser.cloudSearchProjection
  browserInspect = browser.cloudInspectProjection
} catch { /* 兄弟仓库不可用 → 下方用例跳过 */ }

const mapping = {
  game: 'arknights',
  evidence_id: 'evi_alpha', candidate_id: 'cand_alpha',
  suggested_source_ref: 'official_game:story:test:L12',
  title: '完整自然标题', display_title: '测试篇章',
  start_line: 12, end_line: 15, line_range: '12-15',
}

test('DSH cloud_search 模型投影与前端一致，完整交付 Cleaner answer_context', (t) => {
  if (!browserSearch) return t.skip('agent/browser 兄弟仓库不可用，跳过一致性对照')
  const tail = '结尾关键证据'.repeat(300)
  const raw = { code: 200, data: {
    answer_context: `# 回答上下文\nevi_alpha 表明测试事实。[E1]\n${tail}`,
    selected_sources: [{ evidence_id: 'evi_alpha', candidate_id: 'cand_alpha', title: '测试篇章' }],
    errors: [{ message: '一条检索警告' }],
  }, local_source_mappings: [mapping] }
  const expected = browserSearch({ tool_name: 'cloud_search', status: 'ok', payload: raw })
  const actual = projectCloudSearch(raw)
  assert.equal(actual, expected)
  assert.ok(actual.includes(tail), '不得再按 800 字截断 answer_context')
  assert.ok(!actual.includes('evi_alpha'))
  assert.ok(!actual.includes('[E1]'))
  assert.match(actual, /《完整自然标题》第 12-15 行/)
})

test('DSH cloud_inspect 模型投影与前端一致并隐藏内部 ID', (t) => {
  if (!browserInspect) return t.skip('agent/browser 兄弟仓库不可用，跳过一致性对照')
  const raw = { code: 200, data: { section: 'candidates', items: [{
    evidence_id: 'evi_alpha', candidate_id: 'cand_alpha', request_id: 'req_secret', run_id: 'run_secret',
    title: '测试篇章', content: '候选正文', empty: '', score: 0.9,
    content_score: 0, summary_score: 0, entity_boost_score: 0, ranking_score: 0,
    llm_validated: false, exact_match_privileged: false, llm_validation: 'not_checked',
  }] }, local_source_mappings: [mapping] }
  const expected = browserInspect({ tool_name: 'cloud_inspect', status: 'ok', payload: raw })
  const actual = projectCloudInspect(raw)
  assert.deepEqual(actual, expected)
  const serialized = JSON.stringify(actual)
  assert.ok(!serialized.includes('req_secret'))
  assert.ok(!serialized.includes('evi_alpha'))
  assert.ok(!serialized.includes('cand_alpha'))
  assert.ok(!serialized.includes('run_secret'))
  assert.ok(!serialized.includes('official_game:story'))
  assert.ok(!serialized.includes('content_score'))
  assert.ok(!serialized.includes('summary_score'))
  assert.ok(!serialized.includes('entity_boost_score'))
  assert.ok(!serialized.includes('ranking_score'))
  assert.ok(!serialized.includes('llm_validated'))
  assert.ok(!serialized.includes('exact_match_privileged'))
  assert.ok(!serialized.includes('not_checked'))
  assert.equal(actual.payload.data.items[0].score, 0.9, '有信号的非零相关性分数必须保留')
})

test('DSH cloud_search 同名锚点明确 UID 替代 title', () => {
  const actual = projectCloudSearch({ code: 200, data: { answer_context: '回答上下文' },
    local_source_mappings: [{ ...mapping, title_ambiguous: true,
      document_uid: 'doc_0t23T_OgquiZQG8_' }] })
  assert.match(actual, /读取时以 doc_0t23T_OgquiZQG8_ 替代 title，不要同时提交二者/u)
})
