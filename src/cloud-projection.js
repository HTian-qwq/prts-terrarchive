/**
 * 云端工具的模型可见投影。语义与 agent/browser/src/context-manager.js 保持一致：
 * cloud_search 只交付 Cleaner 的 bounded answer_context、可读本地锚点和警告；
 * cloud_inspect 保留所请求的结构化区段，但移除内部不透明标识和空元数据。
 */

export function withoutEmptyMetadata(value) {
  if (Array.isArray(value)) return value.map(withoutEmptyMetadata).filter((item) => item !== undefined)
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).flatMap(([key, child]) => {
      const projected = withoutEmptyMetadata(child)
      if (projected === undefined) return []
      if (Array.isArray(projected) && !projected.length) return []
      if (projected && typeof projected === 'object' && !Object.keys(projected).length) return []
      return [[key, projected]]
    })
    return Object.fromEntries(entries)
  }
  return value === '' || value == null ? undefined : value
}

const MODEL_HIDDEN_IDENTIFIER_FIELDS = new Set([
  'call_id', 'request_id', 'intent_id', 'round_id', 'trace_ref',
  'evidence_id', 'candidate_id', 'document_id', 'source_ref',
  'source_ref_prefix', 'suggested_source_ref', 'read_ref', 'run_id',
])

const ZERO_VALUE_SCORE_FIELDS = new Set([
  'content_score', 'summary_score', 'entity_boost_score', 'ranking_score',
])
const DEFAULT_FALSE_FIELDS = new Set(['llm_validated', 'exact_match_privileged'])

/** 删除“未执行/没有信号”的默认审计字段；非零评分和真实诊断状态继续保留。 */
export function withoutNoSignalMetadata(value) {
  if (Array.isArray(value)) return value.map(withoutNoSignalMetadata)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (ZERO_VALUE_SCORE_FIELDS.has(key) && Number(child) === 0) return []
    if (DEFAULT_FALSE_FIELDS.has(key) && child === false) return []
    if (key === 'llm_validation' && child === 'not_checked') return []
    return [[key, withoutNoSignalMetadata(child)]]
  }))
}

export function withoutOpaqueIdentifiers(value) {
  if (Array.isArray(value)) return value.map(withoutOpaqueIdentifiers)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !MODEL_HIDDEN_IDENTIFIER_FIELDS.has(key))
    .map(([key, child]) => [key, withoutOpaqueIdentifiers(child)]))
}

function anchorIndex(mappings) {
  const found = new Map()
  for (const mapping of mappings) {
    if (!mapping.suggested_source_ref) continue
    if (mapping.evidence_id) found.set(`evidence:${mapping.evidence_id}`, mapping.suggested_source_ref)
    if (mapping.candidate_id) found.set(`candidate:${mapping.candidate_id}`, mapping.suggested_source_ref)
  }
  return found
}

function addSourceAnchors(items, anchors) {
  return (items || []).map((item) => {
    if (!item || typeof item !== 'object') return item
    const copy = structuredClone(item)
    const sourceRef = anchors.get(`evidence:${copy.evidence_id}`)
      || anchors.get(`candidate:${copy.candidate_id}`)
    if (sourceRef) copy.suggested_source_ref = sourceRef
    return copy
  })
}

export function projectedAnchorPoints(mappings) {
  return mappings.filter((mapping) => mapping.suggested_source_ref).map((mapping) => withoutEmptyMetadata({
    game: mapping.game,
    title: mapping.title || mapping.display_title,
    lines: mapping.line_range || (mapping.start_line && mapping.end_line
      ? (Number(mapping.start_line) === Number(mapping.end_line)
        ? `${mapping.start_line}` : `${mapping.start_line}-${mapping.end_line}`) : undefined),
    // DSH 的短篇章 ID 是人类可读标题发生冲突时才需要的消歧信息；前端
    // 没有该字段，保留在锚点不会暴露内部路径或 source_ref。
    document_uid: mapping.title_ambiguous ? mapping.document_uid || undefined : undefined,
  }))
}

export function projectCloudSearch(value) {
  const data = value?.data || {}
  const mappings = value?.local_source_mappings || []
  const sources = addSourceAnchors(data.sources || data.selected_sources || [], anchorIndex(mappings))
  let answerContext = String(data.answer_context || '')
  for (const source of sources) {
    if (source.evidence_id && source.title) {
      answerContext = answerContext.replaceAll(source.evidence_id, `《${source.title}》`)
    }
  }
  answerContext = answerContext
    .replace(/\b(?:evi|ev)_[A-Za-z0-9_-]+\b/gu, '相关资料')
    .replace(/\[(?:E|A|C|H)[1-9][0-9]*\]/gu, '')
  const anchorLines = projectedAnchorPoints(mappings).map((anchor) =>
    `- [${anchor.game === 'endfield' ? '终末地' : '明日方舟'}] 《${anchor.title || '原文'}》${anchor.lines ? `第 ${anchor.lines} 行` : ''}`
      + `${anchor.document_uid ? `（同名消歧：${anchor.document_uid}）` : ''}`)
  const relationLines = (value?.retraveler_relations || []).map((item) =>
    `- 终末地角色：${item.endfield_name}；泰拉记忆原型：${item.terra_memory_prototype || '未登记'}；` +
      `状态：${item.relation_status}。这是跨游戏关系，不是人物别名。`)
  return [answerContext.trim(), relationLines.length
    ? `## 再旅者对应关系（人工审校附属字段）\n${relationLines.join('\n')}` : '',
  anchorLines.length ? `## 可读取原文\n${anchorLines.join('\n')}` : '',
    data.errors?.length ? `## 警告\n${data.errors.map((item) => item.message || item).join('\n')}` : '']
    .filter(Boolean).join('\n\n')
}

export function projectCloudInspect(value) {
  const data = value?.data || {}
  const mappings = value?.local_source_mappings || []
  const items = addSourceAnchors(data.items || [], anchorIndex(mappings))
  return withoutEmptyMetadata(withoutNoSignalMetadata(withoutOpaqueIdentifiers({ tool_name: 'cloud_inspect',
    status: 'ok', payload: {
      code: value?.code, anchor_points: projectedAnchorPoints(mappings), data: { ...data, items },
    } })))
}
