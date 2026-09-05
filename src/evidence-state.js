/** DSH 会话内的轻量证据状态：只驻留内存，按 exec.agent 隔离。 */
import { wikiSectionRanges } from './wiki.js'
import { readableRenderedLine } from './read.js'
import { randomBytes } from 'node:crypto'

const MAX_CANDIDATES = 240
const MAX_MAPPINGS = 240
const MAX_DOCUMENTS = 96
const MAX_LINES = 4000

function newState() {
  const suffix = randomBytes(8).toString('hex')
  return {
    intentId: `dsh-${suffix}`,
    cloudIntentId: `prts-${suffix}`,
    lastCloudRequestId: '',
    searchCandidates: [],
    cloudSourceMappings: [],
    readCoverage: [],
    documents: new Map(),
    completedSearchCalls: new Map(),
    dataVersion: null,
  }
}

function collectVisibleText(value, output = []) {
  if (!value || typeof value !== 'object') return output
  if (value.type === 'text' && typeof value.text === 'string') output.push(value.text)
  if (Array.isArray(value)) for (const item of value) collectVisibleText(item, output)
  else for (const child of Object.values(value)) collectVisibleText(child, output)
  return output
}

/** 当前模型可见 surface 中的工具结果正文；压缩或 spill 后不再含原文的节点不能复用。 */
export function visibleToolResults(agent) {
  const events = agent?.session?.events
  const nodes = agent?.session?.surface?.nodes
  if (!Array.isArray(events) || !nodes || typeof nodes[Symbol.iterator] !== 'function') return new Map()
  const visible = new Map()
  for (const seq of nodes) {
    const event = events[seq]
    if (event?.type !== 'tool/result') continue
    const callId = event.data?.message?.source?.callId
    if (typeof callId === 'string' && callId) {
      visible.set(callId, collectVisibleText(event.data.message?.content).join('\n'))
    }
  }
  return visible
}

export function createEvidenceStateRegistry() {
  const contexts = new WeakMap()
  return {
    forExecution(exec, dataVersion = null) {
      const agent = exec?.agent
      const owner = agent && (typeof agent === 'object' || typeof agent === 'function')
        ? agent
        : exec && (typeof exec === 'object' || typeof exec === 'function') ? exec : null
      // 没有可识别的宿主会话对象时宁可放弃跨调用复用，也不能让不同请求共享证据。
      if (!owner) {
        const state = newState()
        state.dataVersion = dataVersion
        return state
      }
      let state = contexts.get(owner)
      if (!state) {
        state = newState()
        contexts.set(owner, state)
      }
      if (dataVersion && state.dataVersion && state.dataVersion !== dataVersion) {
        state = newState()
        contexts.set(owner, state)
      }
      if (dataVersion) state.dataVersion = dataVersion
      return state
    },
  }
}

export function rememberSearchCandidates(state, response) {
  if (!Array.isArray(response?.documents)) return
  for (const document of response.documents) for (const match of document.matches || []) {
    const candidate = {
      title: String(document.title || ''), line: Number(match.line_start || 0),
    }
    const key = `${candidate.title}:${candidate.line}`
    const index = state.searchCandidates.findIndex((item) => item._key === key)
    if (index >= 0) state.searchCandidates[index] = { ...candidate, _key: key }
    else state.searchCandidates.push({ ...candidate, _key: key })
  }
  if (state.searchCandidates.length > MAX_CANDIDATES) {
    state.searchCandidates.splice(0, state.searchCandidates.length - MAX_CANDIDATES)
  }
}

export function rememberCloudMappings(state, response) {
  const requestId = String(response?.data?.request?.request_id || response?.data?.request_id || '')
  if (requestId) state.lastCloudRequestId = requestId
  for (const mapping of response?.local_source_mappings || []) {
    const key = `${mapping.evidence_id || mapping.candidate_id || ''}:${mapping.document_id}`
    const compact = { ...mapping, _key: key }
    const index = state.cloudSourceMappings.findIndex((item) => item._key === key)
    if (index >= 0) state.cloudSourceMappings[index] = compact
    else state.cloudSourceMappings.push(compact)
  }
  if (state.cloudSourceMappings.length > MAX_MAPPINGS) {
    state.cloudSourceMappings.splice(0, state.cloudSourceMappings.length - MAX_MAPPINGS)
  }
}

function sourceRefParts(sourceRef) {
  const match = String(sourceRef || '').match(/^(.*):L([1-9][0-9]*)$/u)
  return match ? { prefix: match[1], line: Number(match[2]) } : null
}

/** 将已转换的 corpus_read contract 解析为稳定篇章与请求行区间。 */
export async function resolveReadWindow(store, contract) {
  await store.ready()
  const locator = contract?.locator || {}
  const parsed = sourceRefParts(locator.source_ref)
  let documentId = String(locator.document_id || '')
  if (!documentId && locator.document_uid) {
    documentId = String(store.getDocumentIdByUid(locator.document_uid) || '')
  }
  if (!documentId && parsed) documentId = String(store.getDocumentIdByPrefix(parsed.prefix) || '')
  if (!documentId && locator.display_title) {
    // 工具面（corpus_search / corpus_read）的 title 是自然语言完整标题
    // （naturalTitleIndex）；原始 display_title 仅作回退。此前只查 titleIndex，
    // 自然标题一律解析失败，读取覆盖去重对最常见的标题路径完全失效。
    // 同名歧义时不跟踪（读取本身会给出消歧错误或稳定选择）。
    const title = String(locator.display_title)
    const ids = store.naturalTitleIndex.get(title) || store.titleIndex.get(title) || []
    if (ids.length === 1) documentId = ids[0]
  }
  if (!documentId) return null
  const lineCount = Number(store.documents.get(documentId)?.document?.line_count || Infinity)
  const boundedEnd = (line) => Math.min(Number(line), lineCount)
  const selection = contract.selection || {}
  if (selection.mode === 'around') {
    const center = parsed?.line || Number(selection.center_line || 0)
    if (!center) return null
    // 未显式给 before/after 时按契约默认 ±3 计窗口（normalizeReadRequest 的
    // 默认值）；此前按 0 计，重复请求的回放只剩中心 1 行，丢失上下文。
    const before = Number(selection.before_lines ?? 3)
    const after = Number(selection.after_lines ?? 3)
    return { documentId, lineStart: Math.max(1, center - before),
      lineEnd: boundedEnd(center + after) }
  }
  if (selection.mode === 'range') return { documentId,
    lineStart: Number(selection.start_line), lineEnd: boundedEnd(selection.end_line) }
  if (selection.mode === 'section') {
    const found = await store.getDocument(documentId)
    const ranges = found ? wikiSectionRanges(found.record, [selection.section]) : []
    if (ranges.length !== 1) return null
    return { documentId, lineStart: ranges[0].start_line,
      lineEnd: boundedEnd(ranges[0].end_line) }
  }
  if (selection.mode === 'document' && !selection.cursor) {
    const start = Number(selection.start_line || 1)
    return { documentId, lineStart: start,
      lineEnd: boundedEnd(start + Number(contract.limits?.max_lines || 100) - 1) }
  }
  return null
}

/** 覆盖判定用的行标记必须与 renderRead 的模型可见格式逐字一致（含剥离说话人前缀与行尾空白）。 */
function renderedLineMarker(line) {
  return readableRenderedLine(line)
}

function lineVisible(cached, lineNumber, visibleToolResults) {
  if (!cached?.lines.has(lineNumber) || !visibleToolResults?.size) return false
  const sources = cached.lineSources?.get(lineNumber)
  const marker = renderedLineMarker(cached.lines.get(lineNumber))
  return Boolean(sources && [...sources].some((callId) =>
    String(visibleToolResults.get(callId) || '').includes(marker)))
}

export function coveredRead(state, requested, visibleToolResults) {
  if (!requested) return null
  const cached = state.documents.get(requested.documentId)
  for (let line = requested.lineStart; line <= requested.lineEnd; line += 1) {
    if (!lineVisible(cached, line, visibleToolResults)) return null
  }
  return requested
}

/** 计算请求区间中已经核验与仍需从资料包读取的连续片段。 */
export function planReadCoverage(state, requested, visibleToolResults) {
  if (!requested || requested.lineEnd < requested.lineStart) return null
  const reusedRanges = []
  const cached = state.documents.get(requested.documentId)
  for (let line = requested.lineStart; line <= requested.lineEnd; line += 1) {
    if (!lineVisible(cached, line, visibleToolResults)) continue
    const previous = reusedRanges.at(-1)
    if (previous?.lineEnd === line - 1) previous.lineEnd = line
    else reusedRanges.push({ lineStart: line, lineEnd: line })
  }
  const unreadRanges = []
  let cursor = requested.lineStart
  for (const range of reusedRanges) {
    if (cursor < range.lineStart) unreadRanges.push({ lineStart: cursor, lineEnd: range.lineStart - 1 })
    cursor = Math.max(cursor, range.lineEnd + 1)
  }
  if (cursor <= requested.lineEnd) unreadRanges.push({ lineStart: cursor, lineEnd: requested.lineEnd })
  return { reusedRanges, unreadRanges }
}

function mergeCoverage(state, entry) {
  const overlaps = state.readCoverage.filter((item) => item.documentId === entry.documentId
    && item.lineEnd + 1 >= entry.lineStart && entry.lineEnd + 1 >= item.lineStart)
  if (overlaps.length) {
    entry.lineStart = Math.min(entry.lineStart, ...overlaps.map((item) => item.lineStart))
    entry.lineEnd = Math.max(entry.lineEnd, ...overlaps.map((item) => item.lineEnd))
    state.readCoverage = state.readCoverage.filter((item) => !overlaps.includes(item))
  }
  state.readCoverage.push(entry)
}

export function rememberRead(state, response, { callId = '', store = null } = {}) {
  if (response?.status !== 'ok' || response.duplicate_read || response.content?.format !== 'lines') return
  const groups = new Map()
  for (const line of response.content.lines || []) {
    const documentId = String(line.document_id || response.document?.document_id || '')
    const lineNumber = Number(line.line_number)
    if (!documentId || !Number.isInteger(lineNumber) || lineNumber < 1) continue
    const group = groups.get(documentId) || { lines: [], lineStart: lineNumber, lineEnd: lineNumber }
    group.lines.push(line)
    group.lineStart = Math.min(group.lineStart, lineNumber)
    group.lineEnd = Math.max(group.lineEnd, lineNumber)
    groups.set(documentId, group)
  }
  for (const [documentId, group] of groups) {
    let cached = state.documents.get(documentId)
    if (!cached) {
      const document = documentId === response.document?.document_id
        ? response.document : store?.documents?.get(documentId)?.document || { document_id: documentId }
      cached = { document: structuredClone(document), lines: new Map(), lineSources: new Map(),
        dataVersion: response.data_version || null, integrity: structuredClone(response.integrity || {}) }
      state.documents.set(documentId, cached)
    }
    for (const line of group.lines) {
      const lineNumber = Number(line.line_number)
      cached.lines.set(lineNumber, structuredClone(line))
      if (callId) {
        let sources = cached.lineSources.get(lineNumber)
        if (!sources) {
          sources = new Set()
          cached.lineSources.set(lineNumber, sources)
        }
        sources.add(callId)
      }
    }
    mergeCoverage(state, { documentId, lineStart: group.lineStart, lineEnd: group.lineEnd })
  }
  while (state.documents.size > MAX_DOCUMENTS
      || [...state.documents.values()].reduce((sum, item) => sum + item.lines.size, 0) > MAX_LINES) {
    const oldest = state.documents.keys().next().value
    state.documents.delete(oldest)
    state.readCoverage = state.readCoverage.filter((item) => item.documentId !== oldest)
  }
}

export function replayCoveredRead(state, requested, contract) {
  const cached = state.documents.get(requested.documentId)
  if (!cached) return null
  const lines = [...cached.lines.values()].filter((line) => line.line_number >= requested.lineStart
    && line.line_number <= requested.lineEnd).sort((a, b) => a.line_number - b.line_number)
  if (!lines.length || lines[0].line_number > requested.lineStart
      || lines.at(-1).line_number < requested.lineEnd) return null
  const characterCount = lines.reduce((sum, line) => sum + String(line.text || '').length, 0)
  return {
    contract_version: 'prts-corpus-tools-v1', status: 'ok', duplicate_read: true,
    data_version: cached.dataVersion, normalized_request: contract,
    document: structuredClone(cached.document),
    selection: { mode: contract.selection.mode, line_start: requested.lineStart,
      line_end: requested.lineEnd, line_count: lines.length, character_count: characterCount,
      truncated: false },
    content: { format: 'lines', lines },
    page: { limit: lines.length, returned: lines.length, has_more: false, next_cursor: null,
      total: lines.length, total_relation: 'eq' },
    integrity: structuredClone(cached.integrity),
    stats: { elapsed_ms: 0, scanned_documents: 0, scanned_lines: 0, returned_chars: 0,
      estimated_input_tokens: 0, truncated: false, reused_local_evidence: true },
    warnings: [],
    guidance: '该范围已在当前模型可见的上文工具结果中完整出现；这里复用已核验的本地原文，不要再次读取相同范围。',
  }
}

/**
 * 合并部分补读结果。只把本次新读取行送回模型；重叠的旧行仍在会话历史中，
 * 通过 coverage.reused_ranges 明示复用，避免重复占用上下文。
 */
export function combinePartialReadResponses(requested, contract, plan, responses, complete) {
  const successful = responses.filter((response) => response?.status === 'ok')
  if (!successful.length) return responses.at(-1) || null
  const first = successful[0]
  const lines = successful.flatMap((response) => response.content?.lines || [])
    .sort((a, b) => a.line_number - b.line_number)
  const characterCount = lines.reduce((sum, line) => sum + String(line.text || '').length, 0)
  const fetchedRanges = successful.map((response) => ({
    line_start: Number(response.selection.line_start), line_end: Number(response.selection.line_end),
  }))
  const warnings = successful.flatMap((response) => response.warnings || [])
  warnings.push({ code: 'PARTIAL_READ_REUSED',
    message: `请求范围中已有 ${plan.reusedRanges.length} 段经过核验，本次只返回新读取行。` })
  const combined = {
    contract_version: first.contract_version, status: 'ok', partial_read_reused: true,
    data_version: first.data_version, package_schema_version: first.package_schema_version,
    index_schema_version: first.index_schema_version, normalized_request: contract,
    document: structuredClone(first.document),
    selection: { mode: contract.selection.mode, line_start: requested.lineStart,
      line_end: requested.lineEnd, line_count: lines.length, character_count: characterCount,
      truncated: !complete },
    content: { format: 'lines', lines },
    coverage: {
      requested_range: { line_start: requested.lineStart, line_end: requested.lineEnd },
      reused_ranges: plan.reusedRanges.map((range) => ({ line_start: range.lineStart, line_end: range.lineEnd })),
      fetched_ranges: fetchedRanges,
      complete,
    },
    page: { limit: lines.length, returned: lines.length, has_more: false, next_cursor: null,
      total: requested.lineEnd - requested.lineStart + 1, total_relation: 'eq' },
    integrity: structuredClone(first.integrity || {}),
    stats: {
      elapsed_ms: successful.reduce((sum, response) => sum + Number(response.stats?.elapsed_ms || 0), 0),
      scanned_documents: successful.length,
      scanned_lines: successful.reduce((sum, response) => sum + Number(response.stats?.scanned_lines || 0), 0),
      returned_chars: characterCount,
      estimated_input_tokens: successful.reduce((sum, response) =>
        sum + Number(response.stats?.estimated_input_tokens || 0), 0),
      truncated: !complete,
      reused_local_evidence: true,
    },
    warnings,
    guidance: complete
      ? '请求与当前模型可见的上文原文部分重叠；这里只返回新读取行，coverage.reused_ranges 对应旧行就在上方可见工具结果中。'
      : '本次补读受 max_lines/max_chars 限制，coverage.complete=false；需要时从未覆盖行继续读取。',
  }
  for (const key of ['adjacent_documents']) {
    const source = successful.find((response) => response[key])
    if (source) combined[key] = structuredClone(source[key])
  }
  return combined
}
