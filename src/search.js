/** grep 风格 corpus_search：复用资料包索引，公开结果只使用自然标题与行号。 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { activityMatches, aliasesFor } from './timeline.js'
import { DOCUMENT_ORDERING_VERSION, documentGame, documentUid, naturalDocumentTitle } from './store.js'
import { projectSearch } from './search-projection.js'
import { wikiActivityName, wikiCharacterName, wikiDocumentRole,
  wikiSectionAt, wikiSectionRanges } from './wiki.js'

export const SEARCH_CONTRACT_VERSION = 'prts-corpus-tools-v1'

const SEARCH_ERROR_CODES = new Set(['INVALID_REQUEST', 'PACKAGE_NOT_INSTALLED',
  'PACKAGE_VERSION_MISMATCH', 'INDEX_UNAVAILABLE', 'INDEX_CORRUPT', 'DOCUMENT_NOT_FOUND',
  'SOURCE_REF_INVALID', 'LINE_RANGE_INVALID', 'CURSOR_INVALID', 'CURSOR_VERSION_MISMATCH',
  'CURSOR_POLICY_MISMATCH', 'PAGE_ANCHOR_INVALID', 'PAGE_ANCHOR_MISMATCH',
  'PAGE_ANCHOR_NOT_FOUND', 'PAGE_ANCHOR_VERSION_MISMATCH', 'REGEX_REJECTED', 'TIMEOUT',
  'BUDGET_EXCEEDED', 'CANCELLED'])

function publicSearchError(error) {
  const candidate = String(error?.code || '')
  const code = SEARCH_ERROR_CODES.has(candidate) ? candidate : 'INTERNAL_ERROR'
  return {
    code,
    message: code === 'INTERNAL_ERROR'
      ? '本地语料搜索失败；详情请查看 DSH Host 日志' : (error?.message || String(error)),
    retryable: code === 'INTERNAL_ERROR' ? false : (error?.retryable ?? false),
  }
}

const PAGE_DOCUMENTS = 12
const MAX_PASSAGES_PER_DOCUMENT = 3
const PASSAGE_CLUSTER_GAP = 2
const RANK_POOL_CAP = 500
const SHORT_LITERAL_RANK_POOL_CAP = 128
const SIMPLE_LITERAL_MATCH_CAP_PER_DOCUMENT = 24
const SCAN_DOCUMENTS_PER_PAGE = 256
// 冷缓存下短字面量需要并发解压本地 JSONL 分片；8 秒会把正常检索误判为
// 超时。保留扫描上限和结果池上限，并把协作式时间预算提高到 15 秒。
const SEARCH_TIMEOUT_MS = 15000
const PREVIEW_OPTIONS = Object.freeze({ before_lines: 1, after_lines: 1,
  max_chars_per_line: 2000, max_total_chars: 12000 })
const MATCHING_POLICY_VERSION = 1
const SEARCH_POLICY_FINGERPRINT = createHash('sha256').update(JSON.stringify({
  pageDocuments: PAGE_DOCUMENTS,
  scanDocumentsPerPage: SCAN_DOCUMENTS_PER_PAGE,
  passagesPerDocument: MAX_PASSAGES_PER_DOCUMENT,
  passageClusterGap: PASSAGE_CLUSTER_GAP,
  simpleLiteralMatchCapPerDocument: SIMPLE_LITERAL_MATCH_CAP_PER_DOCUMENT,
  preview: PREVIEW_OPTIONS,
  matchingPolicyVersion: MATCHING_POLICY_VERSION,
})).digest('base64url').slice(0, 16)
const FILTER_LIMIT = 16
const DATA_VERSION_PATTERN = /^[0-9a-f]{64}$/
/** 过滤单项最长 512 码点：与上述项数上限共同保证压缩游标可被重新解码。 */
const FILTER_ITEM_LIMIT = 512
/**
 * 游标的物理上限：decodeCursor 的长度检查与解压输出上限必须容纳
 * FILTER_LIMIT × FILTER_ITEM_LIMIT 的最坏合法请求（CJK 直存约 3 字节/字符，
 * 再计 JSON 键与转义余量），否则自己签发的游标会翻页失败。
 */
const CURSOR_MAX_LENGTH = 65_536
const CURSOR_MAX_INFLATED = 262_144
const ENTITY_QUERY_MAX_DISTANCE = 256
const PROFILE_CATEGORIES = new Set(['干员档案', '招聘合同', '潜能与信物'])
const FILTER_FIELDS = {
  story_names: 'story_name',
}
const CURSOR_FILTER_KEYS = Object.freeze({
  resource_types: 'r', character_names: 'c', story_names: 's', activity_names: 'a',
  entity_names: 'e', speakers: 'p', wiki_sections: 'w', games: 'g',
  content_types: 't', collection_names: 'n',
})

function assertSearchActive(signal, deadline, phase = '本地语料搜索') {
  if (signal?.aborted) throw Object.assign(new Error('搜索已取消'), { code: 'CANCELLED' })
  if (Number.isFinite(deadline) && Date.now() >= deadline) {
    throw Object.assign(new Error(`${phase}超时`), { code: 'TIMEOUT', retryable: true })
  }
}

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

function ngramsFor(value) {
  const chars = [...normalizeText(value).toLowerCase()]
  if (!chars.length) return []
  const size = Math.min(3, chars.length)
  return [...new Set(Array.from({ length: chars.length - size + 1 }, (_, index) =>
    chars.slice(index, index + size).join('')))]
}

function resourceMatches(document, requested) {
  if (!requested.length) return true
  const explicit = String(document.resource_type || '')
  const type = String(document.document_type || '')
  const kind = String(document.document_kind || '')
  const category = String(document.document_category || '')
  const wikiRole = wikiDocumentRole(document)
  return requested.some((resource) => {
    // v2 documents carry a narrow resource_type, but callers may deliberately
    // request a semantic union.  Exact-match short-circuiting here used to make
    // character_bundle/reviewed_wiki/wiki silently exclude every Endfield v2
    // document.
    if (resource === explicit) return true
    if (resource === 'story' && explicit === 'original_story') return true
    if (resource === 'character_bundle'
        && ['character_profile', 'character_module', 'character_voice',
          'operator_record'].includes(explicit)) return true
    if (resource === 'reviewed_wiki'
        && ['character_wiki', 'story_wiki', 'character_activity_wiki',
          'knowledge'].includes(explicit)) return true
    if (resource === 'wiki'
        && ['character_wiki', 'story_wiki', 'character_activity_wiki',
          'knowledge'].includes(explicit)) return true
    // v2 common vocabulary over legacy Arknights v1 metadata.
    if (resource === 'original_story') return type === 'story' && category !== 'memory' && kind !== 'synopsis'
    if (resource === 'character_story') return type === 'story' && category === 'memory'
    if (resource === 'archive') return type === 'knowledge' && kind === 'official_archive'
    if (resource === 'knowledge') return type === 'knowledge' && kind === 'wiki'
    if (resource === 'wiki') return type === 'knowledge' && kind === 'wiki'
    if (resource === 'timeline') return type === 'reference'
    if (resource === 'story') return type === 'story' && category !== 'memory' && kind !== 'synopsis'
    if (resource === 'operator_record') return type === 'story' && category === 'memory'
    if (resource === 'character_profile') return type === 'character' && PROFILE_CATEGORIES.has(category)
    if (resource === 'character_module') return type === 'character' && category === '模组文案'
    if (resource === 'character_voice') return type === 'character' && category === '干员语音'
    if (resource === 'character_skin') return type === 'character' && category === '时装文案'
    if (resource === 'character_bundle') return (type === 'character'
      && (PROFILE_CATEGORIES.has(category) || category === '模组文案' || category === '干员语音'))
      || (type === 'story' && category === 'memory')
    if (resource === 'character_wiki') return type === 'knowledge' && kind === 'wiki'
      && wikiRole === 'character'
    if (resource === 'story_wiki') return type === 'knowledge' && kind === 'wiki'
      && wikiDocumentRole(document) === 'story'
    if (resource === 'character_activity_wiki') return type === 'knowledge' && kind === 'wiki'
      && wikiDocumentRole(document) === 'character_activity'
    if (resource === 'reviewed_wiki') return type === 'knowledge' && kind === 'wiki'
    if (resource === 'terra_journey') return type === 'knowledge' && kind === 'terra_journey'
    if (resource === 'entity_profile') return type === 'entity'
    return resource === 'reference' && type === 'reference'
  })
}

/**
 * 线性正则子集。
 *
 * JavaScript RegExp 没有可抢占的单次匹配超时；仅靠识别少数“嵌套量词”无法
 * 阻止 (a|aa)+$ 一类 ReDoS。因此这里只接受没有分支和可变量词的子集：
 * 字面量、锚点、点号、字符类、转义字符，以及上限很小的固定次数 {n}。
 * 该语法没有输入相关的回溯分支，最坏执行时间随文本和 pattern 线性增长。
 */
function safeRegex(pattern) {
  const rejected = (reason) => Object.assign(new Error(
    `正则表达式超出安全线性子集（${reason}）；仅允许字面量、^/$、点号、字符类、转义和固定次数 {n}`,
  ), { code: 'REGEX_REJECTED' })
  if (pattern.length > 256) throw rejected('长度超过 256')
  let inClass = false
  let canRepeat = false
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '\\') {
      const escaped = pattern[index + 1]
      if (escaped === undefined) break // 交给 RegExp 编译器报告不完整转义
      if (/[1-9]/.test(escaped) || escaped === 'k') throw rejected('不允许反向引用')
      if ((escaped === 'p' || escaped === 'P') && pattern[index + 2] === '{') {
        throw rejected('不允许 Unicode 属性转义')
      }
      if (escaped === 'u' && pattern[index + 2] === '{') {
        throw rejected('不允许带花括号的 Unicode 转义')
      }
      index += 1
      if (!inClass) canRepeat = escaped !== 'b' && escaped !== 'B'
      continue
    }
    if (inClass) {
      if (character === ']') {
        inClass = false
        canRepeat = true
      }
      continue
    }
    if (character === '[') {
      inClass = true
      canRepeat = false
      continue
    }
    if ('()|*+?'.includes(character)) {
      throw rejected(`不允许 ${character}`)
    }
    if (character === '{') {
      if (!canRepeat) throw rejected('固定次数前缺少可重复字符')
      const fixed = /^\{([0-9]{1,2})\}/.exec(pattern.slice(index))
      if (!fixed) throw rejected('只允许 {n}，不允许范围或开放式量词')
      const count = Number(fixed[1])
      if (count > 64) throw rejected('固定次数不能超过 64')
      index += fixed[0].length - 1
      canRepeat = false
      continue
    }
    if (character === '}') throw rejected('未转义的 }')
    canRepeat = character !== '^' && character !== '$'
  }
  try {
    return new RegExp(pattern, 'u')
  } catch (error) {
    throw Object.assign(new Error(`正则表达式无法编译: ${error.message}`), { code: 'REGEX_REJECTED' })
  }
}

function normalizedRequest(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw Object.assign(new Error('搜索参数必须是对象'), { code: 'INVALID_REQUEST' })
  }
  if (raw.cursor != null) {
    if (typeof raw.cursor !== 'string' || raw.cursor.length < 1
        || raw.cursor.length > CURSOR_MAX_LENGTH) {
      throw Object.assign(new Error(`cursor 必须是 1..${CURSOR_MAX_LENGTH} 字符的字符串`),
        { code: 'INVALID_REQUEST' })
    }
    return { cursor: raw.cursor }
  }
  let after = null
  if (raw.after != null) {
    if (!raw.after || typeof raw.after !== 'object' || Array.isArray(raw.after)) {
      throw Object.assign(new Error('after 必须包含 data_version、resource_type、title 和 position'),
        { code: 'INVALID_REQUEST' })
    }
    const dataVersion = raw.after.data_version
    const resourceType = normalizeText(raw.after.resource_type)
    const title = normalizeText(raw.after.title)
    const position = raw.after.position
    if (typeof dataVersion !== 'string' || !DATA_VERSION_PATTERN.test(dataVersion)
        || !resourceType || !title || !Number.isSafeInteger(position) || position < 0
        || position > 10_000_000
        || Object.keys(raw.after).some((key) => ![
          'data_version', 'resource_type', 'title', 'position',
        ].includes(key))) {
      throw Object.assign(new Error(
        'after 必须包含且只能包含 64 位小写 data_version、resource_type、title 和 0..10000000 的安全整数 position'),
        { code: 'INVALID_REQUEST' })
    }
    after = { data_version: dataVersion, resource_type: resourceType, title, position }
  }
  const query = normalizeText(raw.query)
  if ([...query].length > 512) throw Object.assign(new Error('literal query 最多 512 个字符'),
    { code: 'INVALID_REQUEST' })
  const filters = {}
  for (const field of ['resource_types', 'character_names', 'story_names', 'activity_names',
    'entity_names', 'speakers', 'wiki_sections', 'games', 'content_types', 'collection_names']) {
    if (raw[field] !== undefined && (!Array.isArray(raw[field]) || !raw[field].length)) {
      throw Object.assign(new Error(`${field} 必须是非空数组`), { code: 'INVALID_REQUEST' })
    }
    filters[field] = [...new Set((raw[field] || []).map(normalizeText))]
    if (filters[field].some((value) => !value)) {
      throw Object.assign(new Error(`${field} 不能包含空字符串`), { code: 'INVALID_REQUEST' })
    }
    if (filters[field].length > FILTER_LIMIT) {
      throw Object.assign(new Error(`${field} 最多 ${FILTER_LIMIT} 项`), { code: 'INVALID_REQUEST' })
    }
    // 单项长度也设上限：合法请求的压缩游标必须能被 decodeCursor 的
    // 长度/解压上限重新解码，否则首次搜索成功、翻页却 CURSOR_INVALID。
    if (filters[field].some((value) => [...value].length > FILTER_ITEM_LIMIT)) {
      throw Object.assign(new Error(`${field} 单项最长 ${FILTER_ITEM_LIMIT} 个字符`), { code: 'INVALID_REQUEST' })
    }
  }
  if (filters.games.some((value) => !['arknights', 'endfield'].includes(value.toLocaleLowerCase()))) {
    throw Object.assign(new Error('games 仅支持 arknights / endfield'), { code: 'INVALID_REQUEST' })
  }
  filters.games = filters.games.map((value) => value.toLocaleLowerCase())
  if (!query && !Object.values(filters).some((items) => items.length)) {
    throw Object.assign(new Error('请提供 query 或至少一个资料/人物/篇章/说话人过滤条件'), { code: 'INVALID_REQUEST' })
  }
  const matchMode = raw.match_mode ?? 'literal'
  if (!['literal', 'regex'].includes(matchMode)) {
    throw Object.assign(new Error('match_mode 仅支持 literal / regex'), { code: 'INVALID_REQUEST' })
  }
  if (matchMode === 'regex') {
    if (!query) throw Object.assign(new Error('regex 模式必须提供 query'), { code: 'INVALID_REQUEST' })
    safeRegex(query)
  }
  const contextTerms = raw.context_terms === undefined ? [] : raw.context_terms
  if (!Array.isArray(contextTerms) || contextTerms.length > 8 || contextTerms.some((item) => !normalizeText(item))) {
    throw Object.assign(new Error('context_terms 必须是最多 8 项的非空字符串数组'), { code: 'INVALID_REQUEST' })
  }
  if (contextTerms.some((item) => [...normalizeText(item)].length > FILTER_ITEM_LIMIT)) {
    throw Object.assign(new Error(`context_terms 单项最长 ${FILTER_ITEM_LIMIT} 个字符`), { code: 'INVALID_REQUEST' })
  }
  if (contextTerms.length && !query && !filters.speakers.length && !filters.entity_names.length) {
    throw Object.assign(new Error('context_terms 需要 query、speakers 或 entity_names 作为主条件'),
      { code: 'INVALID_REQUEST' })
  }
  if (!query && filters.wiki_sections.length > 1) {
    throw Object.assign(new Error('无 query 的完整字段查询一次只能选择一个 wiki_sections 值'),
      { code: 'INVALID_REQUEST' })
  }
  return {
    query, filters, match_mode: matchMode,
    context_terms: [...new Set(contextTerms.map(normalizeText))],
    after,
  }
}

function withoutAfter(request) {
  const { after: _after, ...searchRequest } = request
  return searchRequest
}

async function checkpointAfterTitle(store, after, request, { signal, deadline } = {}) {
  assertSearchActive(signal, deadline, '分页锚点校验')
  if (after.data_version !== store.dataVersion) {
    throw Object.assign(new Error('分页锚点绑定到另一个资料版本，请重新搜索'),
      { code: 'PAGE_ANCHOR_VERSION_MISMATCH', retryable: false })
  }
  const regex = request.match_mode === 'regex'
    ? new RegExp(safeRegex(request.query).source, 'iu') : null
  const candidates = await candidateDocumentIds(store, request, regex, { signal, deadline })
  assertSearchActive(signal, deadline, '分页锚点校验')
  const documentId = candidates[after.position]
  const location = documentId ? store.documents.get(documentId) : null
  if (!location) throw Object.assign(new Error('找不到分页锚点，请重新搜索'),
    { code: 'PAGE_ANCHOR_NOT_FOUND' })
  if (publicResourceType(location.document) !== after.resource_type
      || normalizeText(naturalDocumentTitle(location.document)) !== normalizeText(after.title)) {
    throw Object.assign(new Error('分页锚点与当前资料版本不匹配，请重新搜索'),
      { code: 'PAGE_ANCHOR_MISMATCH' })
  }
  return { nextCandidateIndex: after.position + 1, matchedDocumentsSoFar: 0,
    matchedCountKnown: false }
}

async function exposeTitleContinuation(store, result, { signal, deadline } = {}) {
  if (result?.error || !result?.page) return result
  assertSearchActive(signal, deadline, '分页锚点生成')
  const { next_cursor: internalCursor, ...page } = result.page
  let nextAfter = null
  if (internalCursor) {
    const decoded = await decodeCursor(store, internalCursor)
    assertSearchActive(signal, deadline, '分页锚点生成')
    const regex = decoded.request.match_mode === 'regex'
      ? new RegExp(safeRegex(decoded.request.query).source, 'iu') : null
    const candidates = await candidateDocumentIds(store, decoded.request, regex, { signal, deadline })
    assertSearchActive(signal, deadline, '分页锚点生成')
    const anchorOrdinal = decoded.nextCandidateIndex - 1
    const documentId = candidates[anchorOrdinal]
    const document = documentId ? store.documents.get(documentId)?.document : null
    if (!document) throw Object.assign(new Error('无法生成下一页的标题锚点'),
      { code: 'PAGE_ANCHOR_INVALID' })
    nextAfter = { data_version: store.dataVersion, resource_type: publicResourceType(document),
      title: naturalDocumentTitle(document), position: anchorOrdinal }
  }
  return { ...result, page: { ...page, next_after: nextAfter } }
}

function cursorVersionTag(dataVersion) {
  return createHash('sha256').update(String(dataVersion)).digest().subarray(0, 12).toString('base64url')
}

function compactCursorRequest(request) {
  const filters = {}
  for (const [field, key] of Object.entries(CURSOR_FILTER_KEYS)) {
    if (request.filters[field]?.length) filters[key] = request.filters[field]
  }
  return [request.query || '', Object.keys(filters).length ? filters : 0,
    request.match_mode === 'regex' ? 'r' : 0,
    request.context_terms?.length ? request.context_terms : 0]
}

function expandCursorRequest(compact) {
  if (!Array.isArray(compact) || compact.length !== 4) return null
  const [query, encodedFilters, mode, contextTerms] = compact
  if (typeof query !== 'string' || (encodedFilters !== 0
      && (!encodedFilters || typeof encodedFilters !== 'object' || Array.isArray(encodedFilters)))
      || ![0, 'r'].includes(mode) || (contextTerms !== 0 && !Array.isArray(contextTerms))) return null
  const filters = Object.fromEntries(Object.keys(CURSOR_FILTER_KEYS).map((field) => [field, []]))
  if (encodedFilters !== 0) {
    const reverse = Object.fromEntries(Object.entries(CURSOR_FILTER_KEYS).map(([field, key]) => [key, field]))
    for (const [key, values] of Object.entries(encodedFilters)) {
      const field = reverse[key]
      if (!field || !Array.isArray(values)) return null
      filters[field] = values
    }
  }
  return { query, filters, match_mode: mode === 'r' ? 'regex' : 'literal',
    context_terms: contextTerms === 0 ? [] : contextTerms }
}

function validCursorSignature(body, received, secret, bytes = 32) {
  const expected = createHmac('sha256', secret).update(body).digest().subarray(0, bytes)
  const encoded = String(received || '')
  let actual
  try { actual = Buffer.from(encoded, 'base64url') } catch { actual = Buffer.alloc(0) }
  return encoded === actual.toString('base64url')
    && actual.length === expected.length && timingSafeEqual(actual, expected)
}

async function encodeOffsetCursor(store, request, offset) {
  const payload = [3, cursorVersionTag(store.dataVersion), offset, compactCursorRequest(request)]
  const compressed = deflateRawSync(Buffer.from(JSON.stringify(payload)), { level: 9 })
  const encoded = compressed.toString('base64url')
  const body = `s3.${encoded}`
  const secret = await store.getOrCreateCursorSecret()
  const signature = createHmac('sha256', secret).update(body).digest().subarray(0, 16).toString('base64url')
  return `${body}.${signature}`
}

async function encodeScanCursor(store, request, nextCandidateIndex, matchedDocumentsSoFar) {
  const payload = [4, cursorVersionTag(store.dataVersion), DOCUMENT_ORDERING_VERSION,
    SEARCH_POLICY_FINGERPRINT, nextCandidateIndex, matchedDocumentsSoFar,
    compactCursorRequest(request)]
  const compressed = deflateRawSync(Buffer.from(JSON.stringify(payload)), { level: 9 })
  const encoded = compressed.toString('base64url')
  const body = `s4.${encoded}`
  const secret = await store.getOrCreateCursorSecret()
  const signature = createHmac('sha256', secret).update(body).digest()
    .subarray(0, 16).toString('base64url')
  return `${body}.${signature}`
}

async function decodeCursor(store, cursor) {
  if (String(cursor).length > CURSOR_MAX_LENGTH) {
    throw Object.assign(new Error('cursor 超过长度上限'), { code: 'CURSOR_INVALID' })
  }
  const secret = await store.getOrCreateCursorSecret()
  const parts = String(cursor).split('.')
  if (parts.length === 3 && parts[0] === 's4') {
    const body = `${parts[0]}.${parts[1]}`
    if (!validCursorSignature(body, parts[2], secret, 16)) {
      throw Object.assign(new Error('cursor 签名无效'), { code: 'CURSOR_INVALID' })
    }
    let value
    try {
      value = JSON.parse(inflateRawSync(Buffer.from(parts[1], 'base64url'),
        { maxOutputLength: CURSOR_MAX_INFLATED }).toString('utf8'))
    } catch {
      throw Object.assign(new Error('cursor 无法解析'), { code: 'CURSOR_INVALID' })
    }
    const request = Array.isArray(value) ? expandCursorRequest(value[6]) : null
    if (value?.[0] !== 4 || !request || !Number.isInteger(value[4]) || value[4] < 0
        || !Number.isInteger(value[5]) || value[5] < 0) {
      throw Object.assign(new Error('cursor 内容无效'), { code: 'CURSOR_INVALID' })
    }
    if (value[1] !== cursorVersionTag(store.dataVersion)) {
      throw Object.assign(new Error('cursor 绑定到另一个资料版本'),
        { code: 'CURSOR_VERSION_MISMATCH' })
    }
    if (value[2] !== DOCUMENT_ORDERING_VERSION || value[3] !== SEARCH_POLICY_FINGERPRINT) {
      throw Object.assign(new Error('cursor 绑定的排序或搜索策略已经变化，请重新搜索'),
        { code: 'CURSOR_POLICY_MISMATCH' })
    }
    return { kind: 'scan', request, nextCandidateIndex: value[4],
      matchedDocumentsSoFar: value[5] }
  }
  if (parts.length === 3 && parts[0] === 's3') {
    const body = `${parts[0]}.${parts[1]}`
    if (!validCursorSignature(body, parts[2], secret, 16)) {
      throw Object.assign(new Error('cursor 签名无效'), { code: 'CURSOR_INVALID' })
    }
    let value
    try {
      value = JSON.parse(inflateRawSync(Buffer.from(parts[1], 'base64url'),
        { maxOutputLength: CURSOR_MAX_INFLATED }).toString('utf8'))
    } catch {
      throw Object.assign(new Error('cursor 无法解析'), { code: 'CURSOR_INVALID' })
    }
    const request = Array.isArray(value) ? expandCursorRequest(value[3]) : null
    if (value?.[0] !== 3 || value[1] !== cursorVersionTag(store.dataVersion)
        || !Number.isInteger(value[2]) || value[2] < 0 || !request) {
      throw Object.assign(new Error(value?.[1] !== cursorVersionTag(store.dataVersion)
        ? 'cursor 绑定到另一个资料版本' : 'cursor 内容无效'),
      { code: value?.[1] !== cursorVersionTag(store.dataVersion)
        ? 'CURSOR_VERSION_MISMATCH' : 'CURSOR_INVALID' })
    }
    return { kind: 'legacy', request, offset: value[2] }
  }

  // v2 长游标兼容：已发给模型或持久化在旧会话中的 cursor 仍可继续分页。
  const [body, received] = parts
  if (parts.length !== 2 || !validCursorSignature(body || '', received, secret)) {
    throw Object.assign(new Error('cursor 签名无效'), { code: 'CURSOR_INVALID' })
  }
  let value
  try { value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch {
    throw Object.assign(new Error('cursor 无法解析'), { code: 'CURSOR_INVALID' })
  }
  if (value.data_version !== store.dataVersion) {
    throw Object.assign(new Error('cursor 绑定到另一个资料版本'), { code: 'CURSOR_VERSION_MISMATCH' })
  }
  if (value.v !== 2 || value.tool !== 'corpus_search' || !value.request
      || !Number.isInteger(value.offset) || value.offset < 0) {
    throw Object.assign(new Error('cursor 内容无效'), { code: 'CURSOR_INVALID' })
  }
  return { kind: 'legacy', request: value.request, offset: value.offset }
}

function documentMatches(document, speakers, filters) {
  if (filters.games?.length && !filters.games.includes(documentGame(document))) return false
  if (!resourceMatches(document, filters.resource_types)) return false
  if (filters.content_types?.length
      && !filters.content_types.includes(publicContentType(document))) return false
  if (filters.collection_names?.length
      && !filters.collection_names.includes(publicCollectionName(document))) return false
  for (const [filter, field] of Object.entries(FILTER_FIELDS)) {
    if (filters[filter].length && !filters[filter].includes(normalizeText(document[field]))) return false
  }
  const wikiRole = wikiDocumentRole(document)
  if (filters.character_names.length
      && (wikiRole !== 'character_activity' || normalizeText(document.character_name))
      && !filters.character_names.includes(normalizeText(document.character_name))) return false
  if (filters.activity_names.length) {
    const activity = { ...document, activity_name: wikiActivityName(document)
      || normalizeText(document.activity_name) }
    const exact = wikiRole === 'story' || wikiRole === 'character_activity'
    if (!filters.activity_names.some((name) => activityMatches(activity, name, { exact }))) return false
  }
  if (filters.wiki_sections.length && !wikiRole) return false
  return !filters.speakers.length || filters.speakers.some((speaker) => speakers.includes(speaker))
}

/**
 * 将已由轻量元数据过滤过的文档范围投影为 pack 范围。旧测试替身或第三方
 * Store 若没有暴露 packId，则返回 null，保留全库查询语义，避免假阴性。
 */
function packIdsForDocumentIds(store, documentIds) {
  if (!documentIds.length) return []
  const packIds = new Set()
  for (const documentId of documentIds) {
    const packId = store.documents.get(documentId)?.packId
    if (!packId) return null
    packIds.add(packId)
  }
  return [...packIds]
}

function documentScopeForFilters(store, filters) {
  const documentIds = []
  for (const [documentId, item] of store.documents) {
    if (documentMatches(item.document, item.speakers ?? [], filters)) documentIds.push(documentId)
  }
  return { documentIds, packIds: packIdsForDocumentIds(store, documentIds) }
}

function hydratedRecordMatches(record, filters) {
  if (filters.character_names.length && wikiDocumentRole(record.document) === 'character_activity'
      && !normalizeText(record.document.character_name)
      && !filters.character_names.includes(normalizeText(wikiCharacterName(record)))) return false
  return true
}

function lineContent(line) {
  const text = normalizeText(line.text)
  const prefix = `${normalizeText(line.speaker_raw)}:`
  return line.line_type === 'dialogue' && prefix !== ':' && text.startsWith(prefix)
    ? text.slice(prefix.length).trimStart() : text
}

function matchesText(text, query, mode, regex) {
  if (!query) return true
  if (mode === 'regex') return regex.test(normalizeText(text))
  const haystack = normalizeText(text).toLowerCase()
  const needle = query.toLowerCase()
  return haystack.includes(needle)
}

function aliasNearQuery(text, alias, queryRange) {
  const haystack = normalizeText(text)
  if (!queryRange) return haystack.includes(alias)
  let offset = haystack.indexOf(alias)
  while (offset >= 0) {
    const end = offset + alias.length
    const distance = end < queryRange.start ? queryRange.start - end
      : offset > queryRange.end ? offset - queryRange.end : 0
    if (distance <= ENTITY_QUERY_MAX_DISTANCE) return true
    offset = haystack.indexOf(alias, offset + 1)
  }
  return false
}

function textAliases(entity) {
  const aliases = [...new Set(entity.aliases.map(normalizeText).filter(Boolean))]
  const longer = aliases.filter((alias) => [...alias].length > 1)
  return longer.length ? longer : aliases
}

function entityOccurrence(record, line, entityGroups, queryPresent, queryRange = null) {
  if (!entityGroups.length) return null
  for (const stored of line.entity_occurrences ?? []) {
    const entity = entityGroups.find((item) => item.canonical === stored.canonical_name
      || item.aliases.includes(stored.raw_name))
    if (!entity) continue
    const rawName = String(stored.raw_name || '')
    if (queryPresent && stored.evidence_kind !== 'speaker'
        && !aliasNearQuery(line.text, rawName, queryRange)) continue
    return {
      entity_id: String(stored.entity_id || ''), canonical_entity: entity.canonical,
      matched_alias: rawName, presence_status: String(stored.presence_status || ''),
      evidence_kind: String(stored.evidence_kind || ''), occurrence_id: String(stored.occurrence_id || ''),
      confidence: Number(stored.confidence || 0),
      ...(stored.ambiguity_candidates?.length
        ? { ambiguity_candidates: stored.ambiguity_candidates.map((item) => String(item)) } : {}),
    }
  }
  for (const entity of entityGroups) {
    const speakerAlias = entity.aliases.find((alias) => line.speaker_raw === alias)
    if (speakerAlias) return { canonical_entity: entity.canonical, matched_alias: speakerAlias,
      presence_status: 'explicit', evidence_kind: 'speaker' }
    const textAlias = textAliases(entity).find((alias) =>
      aliasNearQuery(line.text, alias, queryPresent ? queryRange : null))
    if (textAlias) return { canonical_entity: entity.canonical, matched_alias: textAlias,
      presence_status: 'mentioned', evidence_kind: 'text_mention' }
    if (!queryPresent && entity.aliases.includes(String(record.document.character_name || ''))
        && line.line_number === 1) {
      return { canonical_entity: entity.canonical,
        matched_alias: String(record.document.character_name || entity.canonical),
        presence_status: 'explicit', evidence_kind: 'metadata_link' }
    }
  }
  return null
}

function lineMatch(record, index, request, regex, entityGroups) {
  const line = record.lines[index]
  if (request.filters.speakers.length && !request.filters.speakers.includes(line.speaker_raw)) return null
  const content = lineContent(line)
  if (!matchesText(content, request.query, request.match_mode, regex)) return null
  let start = null
  let end = null
  if (request.query) {
    if (regex) {
      const match = new RegExp(regex.source, regex.flags).exec(normalizeText(content))
      if (match) { start = match.index; end = match.index + match[0].length }
    } else {
      const haystack = normalizeText(content).toLowerCase()
      const needle = request.query.toLowerCase()
      start = haystack.indexOf(needle)
      // 区间终点必须用归一化后 needle 的长度：toLocaleLowerCase 可能改变长度
      // （如土耳其语 İ → i̇），用原 query 长度会让实体邻近度判定错位。
      end = start + needle.length
    }
  }
  const occurrence = entityOccurrence(record, line, entityGroups, Boolean(request.query),
    start === null ? null : { start, end })
  if (entityGroups.length && !occurrence) return null
  if (!request.context_terms.length) return { occurrence, start, end }
  const nearby = record.lines.slice(Math.max(0, index - 3), index + 4)
  const constraintLines = []
  for (const term of request.context_terms) {
    const found = nearby.find((item) => normalizeText(item.text).toLowerCase()
      .includes(term.toLowerCase()))
    if (!found) return null
    constraintLines.push(found.line_number)
  }
  return { occurrence, start, end, constraint_lines: [...new Set(constraintLines)] }
}

function relevanceScore(match, request, field) {
  if (field === 'title') return match.exact ? 1 : 0.96
  let score = !request.query ? 0.5 : request.match_mode === 'regex' ? 0.7 : 1
  if (Number(match.start) > 0) score -= Math.min(0.2, Number(match.start) / 200)
  if (match.occurrence?.evidence_kind === 'speaker') score += 0.3
  else if (match.occurrence?.presence_status === 'explicit') score += 0.2
  else if (match.occurrence?.presence_status === 'mentioned') score += 0.05
  return Math.max(0, Math.min(1, Math.round(score * 1000) / 1000))
}

function queryableEntities(record, maximum = 24) {
  const entities = new Map()
  const remember = (value) => {
    const name = String(value.canonical_name || value.canonical_entity || '').trim()
    const entityId = String(value.entity_id || '').trim()
    if (!name && !entityId) return
    const key = entityId || `name:${name}`
    const existing = entities.get(key) || { entity_id: entityId, name,
      entity_type: String(value.entity_type || ''), presence_statuses: [] }
    const status = String(value.presence_status || '')
    if (status && !existing.presence_statuses.includes(status)) existing.presence_statuses.push(status)
    entities.set(key, existing)
  }
  for (const line of record.lines ?? []) for (const occurrence of line.entity_occurrences ?? []) remember(occurrence)
  if (record.document.character_name) remember({ canonical_name: record.document.character_name,
    entity_id: record.document.char_id || '', entity_type: 'character', presence_status: 'explicit' })
  const all = [...entities.values()]
  return { total: all.length, shown: all.slice(0, maximum), truncated: all.length > maximum }
}

function clusterPassages(candidates, forcedTruncated = false) {
  const clusters = []
  for (const candidate of candidates) {
    const constraintLines = candidate.match?.constraint_lines || []
    const candidateStart = Math.min(candidate.line.line_number, ...constraintLines)
    const candidateEnd = Math.max(candidate.line.line_number, ...constraintLines)
    const previous = clusters.at(-1)
    if (previous && candidateStart - previous.end <= PASSAGE_CLUSTER_GAP) {
      previous.end = Math.max(previous.end, candidateEnd)
      previous.candidates.push(candidate)
      if (candidate.score > previous.best.score) previous.best = candidate
    } else clusters.push({ start: candidateStart, end: candidateEnd, candidates: [candidate], best: candidate })
  }
  const ranked = clusters.sort((left, right) => right.best.score - left.best.score
    || left.start - right.start)
  return ranked.slice(0, MAX_PASSAGES_PER_DOCUMENT).map((cluster) => ({ ...cluster.best,
    passage_start: cluster.start, passage_end: cluster.end,
    passage_match_count: cluster.candidates.length,
    match_lines: [...new Set(cluster.candidates.map((item) => item.line.line_number))],
    constraint_lines: [...new Set(cluster.candidates.flatMap((item) => item.match?.constraint_lines || []))],
    document_passages_truncated: forcedTruncated || ranked.length > MAX_PASSAGES_PER_DOCUMENT }))
}

function searchableTitleText(document) {
  return [document.display_title, document.story_name, document.activity_name,
    document.character_name, document.story_code, document.part_label,
    document.collection_name, document.mission_title, document.story_key]
    .map((item) => normalizeText(item)).filter(Boolean).join('\n')
}

function isExactOfficialArchiveTitle(document, request) {
  if (!request.query || publicResourceType(document) !== 'archive') return false
  const query = normalizeText(request.query).toLowerCase()
  return [document.display_title, document.story_name]
    .some((value) => normalizeText(value).toLowerCase() === query)
}

function lineAllowed(line, filters) {
  return !filters.speakers.length || filters.speakers.includes(line.speaker_raw)
}

function readableAnchor(record, filters) {
  const eligible = (line) => normalizeText(line.text) && lineAllowed(line, filters)
  return record.lines.find((line) => line.line_type === 'dialogue' && eligible(line))
    || record.lines.find(eligible) || null
}

function documentTitle(document) {
  return naturalDocumentTitle(document)
}

function publicResourceType(document) {
  if (document.resource_type) return String(document.resource_type)
  const type = String(document.document_type || '')
  const kind = String(document.document_kind || '')
  const category = String(document.document_category || '')
  if (type === 'story') return category === 'memory' ? 'operator_record' : 'story'
  if (type === 'character') {
    if (category === '模组文案') return 'character_module'
    if (category === '干员语音') return 'character_voice'
    if (category === '时装文案') return 'character_skin'
    return 'character_profile'
  }
  if (type === 'knowledge' && kind === 'wiki') {
    const role = wikiDocumentRole(document)
    return role === 'story' ? 'story_wiki'
      : role === 'character_activity' ? 'character_activity_wiki' : 'character_wiki'
  }
  if (type === 'knowledge' && kind === 'terra_journey') return 'terra_journey'
  if (type === 'entity') return 'entity_profile'
  return 'reference'
}

function publicContentType(document) {
  if (document.content_type) return normalizeText(document.content_type)
  const kind = normalizeText(document.kind || document.document_kind).toLocaleLowerCase()
  const mapping = {
    dlg: 'dialogue', story: 'dialogue', cutscene: 'cutscene', radio: 'radio',
    remotecomm: 'remote_comm', black: 'black_screen', env: 'environment_talk',
    sns: 'sns_chat', topic: 'sns_topic', wiki: 'knowledge', reference: 'knowledge',
  }
  return mapping[kind] || (document.document_type === 'story' ? 'dialogue' : 'knowledge')
}

function publicCollectionName(document) {
  return normalizeText(document.collection_name || document.mission_title
    || document.activity_name || document.story_name)
}

function boundedSummaryText(value, maximum) {
  const text = normalizeText(value)
  if (!text || maximum <= 0) return { text: '', truncated: Boolean(text) }
  const characters = [...text]
  return characters.length <= maximum
    ? { text, truncated: false }
    : { text: `${characters.slice(0, Math.max(0, maximum - 1)).join('')}…`, truncated: true }
}

function publicEntitySummary(record, maximum = 2400) {
  const entity = record.entity || {}
  const attributes = entity.attributes || {}
  const canonicalName = normalizeText(entity.canonical_name || record.document.display_title)
  const description = boundedSummaryText(attributes.description || entity.description, Math.min(800, maximum))
  const remaining = Math.max(0, maximum - [...description.text].length)
  const history = boundedSummaryText(attributes.history_summary || entity.history_summary,
    Math.min(1600, remaining))
  return {
    canonical_name: canonicalName,
    ...(description.text ? { description: description.text } : {}),
    ...(history.text && history.text !== description.text ? { history_summary: history.text } : {}),
    truncated: description.truncated || history.truncated,
    citation: `《${naturalDocumentTitle(record.document)}》`,
  }
}

function evidenceKind(document, field, occurrence) {
  const resource = publicResourceType(document)
  if (field === 'catalog' || field === 'title') return 'catalog'
  if (occurrence?.evidence_kind === 'metadata_link') return 'entity_projection'
  if (resource.endsWith('_wiki')) return 'wiki_curated'
  if (resource === 'story' || resource === 'original_story' || resource === 'operator_record') {
    return 'official_canonical'
  }
  if (resource === 'archive' || resource.startsWith('character_')) return 'official_structured'
  return 'wiki_curated'
}

function matchKind(item, request) {
  if (item.field === 'title') return 'title'
  if (item.field === 'catalog') return 'catalog'
  if (item.wiki_section) return 'section'
  if (item.match?.occurrence?.evidence_kind === 'speaker') return 'entity_speaker'
  if (item.match?.occurrence?.evidence_kind === 'text_mention') return 'entity_mention'
  if (item.match?.occurrence) return 'entity_projection'
  if (!request.query && request.filters.speakers.length) return 'speaker'
  return request.match_mode === 'regex' ? 'regex' : 'literal'
}

function excerpt(record, item, bounds = null) {
  const start = Math.max(bounds?.start_line || 1, item.passage_start - PREVIEW_OPTIONS.before_lines)
  const end = Math.min(bounds?.end_line || record.lines.length,
    item.passage_end + PREVIEW_OPTIONS.after_lines)
  let truncated = false
  const lines = record.lines.slice(start - 1, end).map((line) => {
    const raw = String(lineContent(line) || '')
    const text = [...raw].length > PREVIEW_OPTIONS.max_chars_per_line
      ? `${[...raw].slice(0, PREVIEW_OPTIONS.max_chars_per_line).join('')}…` : raw
    if (text !== raw) truncated = true
    return { line: line.line_number,
      role: item.match_lines?.includes(line.line_number) ? 'match'
        : item.constraint_lines?.includes(line.line_number) ? 'constraint' : 'context',
      line_type: line.line_type ?? '', speaker: line.speaker_raw ?? '', text,
      truncated: text !== raw }
  })
  return { lines, characters: lines.reduce((total, line) => total + line.text.length, 0), truncated }
}

async function executeLegacySearch(store, request, offset,
  { signal, requestId = null, deadline = Date.now() + SEARCH_TIMEOUT_MS } = {}) {
  const started = Date.now()
  const resolvedRequestId = String(requestId || `req-${createHash('sha256')
    .update(`${started}:${Math.random()}`).digest('hex').slice(0, 16)}`)
  try {
    assertSearchActive(signal, deadline)
    await store.ready()
    assertSearchActive(signal, deadline)
    const entityAliasGroups = await aliasesFor(store, request.filters.entity_names)
    assertSearchActive(signal, deadline)
    const catalogMode = !request.query && !request.filters.speakers.length && !entityAliasGroups.length
    // regex 模式的 query 是模式文本而非字面量，跳过 trigram 预过滤（与浏览器一致）。
    // 资料包缺失 search-index 时同样跳过倒排：此时倒排空结果不代表正文零命中，
    // 不能据此把搜索降级成"仅标题兜底"。
    const regex = request.match_mode === 'regex'
      ? new RegExp(safeRegex(request.query).source, 'iu') : null
    const queryNgrams = ngramsFor(request.query)
    const rankPoolCap = request.query && !regex && queryNgrams.length
      && [...queryNgrams[0]].length < 3
      ? SHORT_LITERAL_RANK_POOL_CAP : RANK_POOL_CAP
    const legacyScope = documentScopeForFilters(store, request.filters)
    const indexedLookup = store.findDocumentsByNgrams || store.findDocumentsByTrigrams
    let indexed = request.query && !regex && queryNgrams.length && indexedLookup
      ? await indexedLookup.call(store, queryNgrams,
        { signal, deadline, packIds: legacyScope.packIds }) : null
    if (indexed === null && request.query && !regex && queryNgrams.length
        && [...queryNgrams[0]].length < 3) {
      indexed = await store.findDocumentsByShortLiteral?.(request.query,
        { signal, deadline, packIds: legacyScope.packIds }) ?? null
    }
    assertSearchActive(signal, deadline, '本地语料搜索初始化')
    const hasLineScope = request.filters.speakers.length || request.filters.entity_names.length
      || request.filters.wiki_sections.length || request.context_terms.length
    const titleIds = []
    if (request.query && !hasLineScope) {
      let checked = 0
      for (const [id, item] of store.documents) {
        if ((checked++ & 255) === 0) assertSearchActive(signal, deadline, '候选标题发现')
        if (documentMatches(item.document, [], request.filters)
            && matchesText(searchableTitleText(item.document), request.query,
              request.match_mode, regex)) titleIds.push(id)
      }
    }
    // 正文倒排与标题候选取并集；索引不可用时回退全量扫描。
    const documentIds = indexed !== null ? [...new Set([...indexed, ...titleIds])] : null
    const pool = []
    let scannedDocuments = 0
    let scannedLines = 0
    for await (const record of store.iterateDocuments({
      documentIds,
      predicate: (document, speakers) => documentMatches(document, speakers, request.filters),
    })) {
      assertSearchActive(signal, deadline)
      scannedDocuments += 1
      if (!hydratedRecordMatches(record, request.filters)) continue
      if (store.isPreferredNaturalDocument?.(record.document.document_id) === false) continue
      const sectionRanges = request.filters.wiki_sections.length
        ? wikiSectionRanges(record, request.filters.wiki_sections) : []
      if (request.filters.wiki_sections.length && !sectionRanges.length) continue
      const title = documentTitle(record.document)
      const titleText = searchableTitleText(record.document)
      if (request.query && !hasLineScope
          && matchesText(titleText, request.query, request.match_mode, regex)) {
        const firstSection = sectionRanges[0] || null
        const anchor = firstSection
          ? record.lines.slice(firstSection.start_line - 1, firstSection.end_line)
            .find((line) => normalizeText(line.text))
          : readableAnchor(record, request.filters)
        if (anchor) {
          const exact = normalizeText(record.document.story_name) === request.query
            || normalizeText(record.document.display_title) === request.query
          pool.push({ record, line: anchor, score: relevanceScore({ exact }, request, 'title'),
            field: 'title', passage_start: anchor.line_number, passage_end: anchor.line_number,
            passage_match_count: 1, match: { occurrence: null, start: null, end: null },
            ...(firstSection ? { wiki_section: firstSection } : {}) })
        }
      }
      // 此处曾有一段"倒排可用且零命中即跳过正文扫描"的分支，但其条件
      // （documentIds === null 且倒排可用）在控制流上不可达：倒排可用时
      // documentIds 恒为非空并集。作为死代码删除，不影响行为。
      if (catalogMode) {
        if (sectionRanges.length) {
          for (const section of sectionRanges) {
            const anchor = record.lines.slice(section.start_line - 1, section.end_line)
              .find((line) => normalizeText(line.text))
            if (anchor) pool.push({ record, line: anchor, score: 1, field: 'wiki_section',
              passage_start: section.start_line, passage_end: section.end_line,
              passage_match_count: 1, match: { occurrence: null, start: null, end: null },
              wiki_section: section })
          }
          if (pool.length >= rankPoolCap) break
          continue
        }
        const anchor = readableAnchor(record, request.filters)
        if (anchor) pool.push({ record, line: anchor, score: 1, field: 'catalog',
          passage_start: anchor.line_number, passage_end: anchor.line_number,
          passage_match_count: 1, match: { occurrence: null, start: null, end: null } })
        if (pool.length >= rankPoolCap) break
        continue
      }
      const documentMatches = []
      let documentMatchesTruncated = false
      for (let index = 0; index < record.lines.length; index += 1) {
        if ((index & 255) === 0) {
          assertSearchActive(signal, deadline)
        }
        scannedLines += 1
        const wikiSection = sectionRanges.length
          ? wikiSectionAt(sectionRanges, record.lines[index].line_number) : null
        if (sectionRanges.length && !wikiSection) continue
        const match = lineMatch(record, index, request, regex, entityAliasGroups)
        if (!match) continue
        documentMatches.push({ record, line: record.lines[index],
          score: relevanceScore(match, request, 'content'), field: request.query ? 'content'
            : match.occurrence ? 'entity' : 'speaker_raw', match,
          ...(wikiSection ? { wiki_section: wikiSection } : {}) })
        // 裸字面量采用 grep 的首批命中语义：单篇最多保留足够形成 3 个 passage
        // 的原始命中，避免“陈”一类高频字在一部长篇里耗尽整次工具预算。
        if (!hasLineScope && !regex
            && documentMatches.length >= SIMPLE_LITERAL_MATCH_CAP_PER_DOCUMENT) {
          documentMatchesTruncated = true
          break
        }
      }
      pool.push(...clusterPassages(documentMatches, documentMatchesTruncated))
      if (pool.length >= rankPoolCap) break
    }
    pool.sort((left, right) => right.score - left.score
      || String(left.record.document.collection_id || '').localeCompare(
        String(right.record.document.collection_id || ''), 'zh-CN', { numeric: true }))
    const resultKind = request.query ? 'text_matches'
      : request.filters.speakers.length || request.filters.entity_names.length
        ? 'structured_matches' : request.filters.wiki_sections.length
          ? 'complete_sections' : 'documents'
    const grouped = new Map()
    for (const item of pool) {
      const key = item.record.document.document_id
      const group = grouped.get(key) || { record: item.record, score: item.score, items: [] }
      group.score = Math.max(group.score, item.score)
      group.items.push(item)
      grouped.set(key, group)
    }
    const allDocuments = [...grouped.values()].sort((left, right) => right.score - left.score
      || String(left.record.document.collection_id || '').localeCompare(
        String(right.record.document.collection_id || ''), 'zh-CN', { numeric: true }))
    const pageGroups = allDocuments.slice(offset, offset + PAGE_DOCUMENTS)
    const documents = []
    const reasons = new Set()
    let returnedChars = 0
    for (const group of pageGroups) {
      assertSearchActive(signal, deadline)
      if (documents.length && returnedChars >= PREVIEW_OPTIONS.max_total_chars) {
        reasons.add('output_chars')
        break
      }
      const metadata = group.record.document
      const title = naturalDocumentTitle(metadata)
      const result = {
        game: documentGame(metadata), title, resource_type: publicResourceType(metadata),
        content_type: publicContentType(metadata),
        ...(store.requiresDocumentUid?.(metadata.document_id)
          ? { document_uid: documentUid(metadata.document_id) } : {}),
        ...(publicCollectionName(metadata) ? { collection_name: publicCollectionName(metadata) } : {}),
        ...(metadata.activity_name ? { activity_name: metadata.activity_name } : {}),
        ...(metadata.character_name ? { character_name: metadata.character_name } : {}),
        matches: [], matches_truncated: group.items.some((item) => item.document_passages_truncated),
      }
      if (result.matches_truncated) reasons.add('document_passages')
      if (resultKind !== 'documents' && result.resource_type === 'entity_profile') {
        const remaining = Math.max(0, PREVIEW_OPTIONS.max_total_chars - returnedChars)
        result.entity_summary = publicEntitySummary(group.record, Math.min(2400, remaining))
        result.matches_truncated = false
        returnedChars += [...(result.entity_summary.description || '')].length
          + [...(result.entity_summary.history_summary || '')].length
        if (result.entity_summary.truncated) reasons.add('entity_summary')
      } else if (resultKind === 'complete_sections') {
        const section = group.items[0]?.wiki_section
        const lines = section ? group.record.lines.slice(section.start_line - 1, section.end_line)
          .filter((line) => normalizeText(line.text)) : []
        const blocks = []
        for (const line of lines) {
          const text = String(line.text || '')
          // 与 v4 路径一致按码点计数，避免含增补平面字符的行在两条路径下预算不一致
          const width = [...text].length
          if (returnedChars + width > PREVIEW_OPTIONS.max_total_chars) {
            reasons.add('section_content')
            break
          }
          blocks.push({ type: 'text', text })
          returnedChars += width
        }
        result.section_content = { section: section?.name || request.filters.wiki_sections[0],
          completeness: blocks.length === lines.length ? 'complete' : 'partial', blocks,
          citation: `《${title}》Wiki·${section?.name || request.filters.wiki_sections[0]}` }
      } else if (resultKind !== 'documents') {
        for (const item of group.items.slice(0, MAX_PASSAGES_PER_DOCUMENT)) {
          const titleOnly = item.field === 'title'
          const shown = titleOnly ? { lines: [], characters: 0, truncated: false }
            : excerpt(group.record, item, item.wiki_section)
          if (result.matches.length && returnedChars + shown.characters > PREVIEW_OPTIONS.max_total_chars) {
            result.matches_truncated = true
            reasons.add('output_chars')
            reasons.add('document_passages')
            break
          }
          if (shown.truncated) reasons.add('line_chars')
          const lineStart = item.passage_start
          const lineEnd = item.passage_end
          const sectionName = item.wiki_section?.name
          result.matches.push({
            ...(sectionName || titleOnly ? {} : { line_start: lineStart, line_end: lineEnd }),
            match_kind: matchKind(item, request),
            evidence_kind: evidenceKind(metadata, item.field, item.match?.occurrence),
            excerpt: shown.lines,
            citation: titleOnly ? `《${title}》`
              : sectionName ? `《${title}》Wiki·${sectionName}`
              : `《${title}》第 ${lineStart === lineEnd ? lineStart : `${lineStart}-${lineEnd}`} 行`,
          })
          returnedChars += shown.characters
        }
      }
      documents.push(result)
    }
    const hasMore = offset + documents.length < allDocuments.length
    if (hasMore) reasons.add('more_documents')
    if (pool.length >= rankPoolCap) reasons.add('document_passages')
    assertSearchActive(signal, deadline)
    const nextCursor = hasMore ? await encodeOffsetCursor(store, request, offset + documents.length) : null
    assertSearchActive(signal, deadline, '分页游标生成')
    return {
      result_kind: resultKind, documents,
      page: { returned_documents: documents.length,
        total_relation: 'unknown', has_more: hasMore, exhausted: false,
        next_cursor: nextCursor },
      truncated: true,
      truncation_reasons: [...new Set([...reasons, 'legacy_pool_incomplete'])],
    }
  } catch (error) {
    return { contract_version: SEARCH_CONTRACT_VERSION, status: 'error', request_id: resolvedRequestId,
      data_version: store.dataVersion ?? null,
      error: publicSearchError(error) }
  }
}

function resultKindFor(request) {
  if (request.query) return 'text_matches'
  if (request.filters.speakers.length || request.filters.entity_names.length) {
    return 'structured_matches'
  }
  return request.filters.wiki_sections.length ? 'complete_sections' : 'documents'
}

function lineScopeFor(request) {
  return Boolean(request.filters.speakers.length || request.filters.entity_names.length
    || request.filters.wiki_sections.length || request.context_terms.length)
}

async function candidateDocumentIds(store, request, regex, { signal, deadline } = {}) {
  assertSearchActive(signal, deadline, '候选文档发现')
  const hasLineScope = lineScopeFor(request)
  // 结构化过滤只依赖初始化时保留的轻量 metadata，可以先安全缩小范围；
  // hydratedRecordMatches 仍在读取正文后复核 character_activity Wiki 等特殊项。
  const scopedIds = []
  const orderedIds = store.orderedDocumentIds()
  for (let index = 0; index < orderedIds.length; index += 1) {
    if ((index & 255) === 0) assertSearchActive(signal, deadline, '候选文档发现')
    const documentId = orderedIds[index]
    const item = store.documents.get(documentId)
    if (item && documentMatches(item.document, item.speakers, request.filters)
        && store.isPreferredNaturalDocument?.(documentId) !== false) scopedIds.push(documentId)
  }
  const scoped = new Set(scopedIds)
  const scopedPackIds = packIdsForDocumentIds(store, scopedIds)
  const titleIds = []
  if (request.query && !hasLineScope) {
    for (let index = 0; index < scopedIds.length; index += 1) {
      if ((index & 255) === 0) assertSearchActive(signal, deadline, '候选标题发现')
      const id = scopedIds[index]
      if (matchesText(searchableTitleText(store.documents.get(id).document),
        request.query, request.match_mode, regex)) titleIds.push(id)
    }
  }
  const prioritizeOfficialTitle = (ids) => {
    const exact = []
    for (let index = 0; index < ids.length; index += 1) {
      if ((index & 255) === 0) assertSearchActive(signal, deadline, '候选文档排序')
      const id = ids[index]
      if (isExactOfficialArchiveTitle(store.documents.get(id)?.document || {}, request)) exact.push(id)
    }
    if (!exact.length) return interleaveGameCandidates(store, ids, request, { signal, deadline })
    const selected = new Set(exact)
    const remaining = []
    for (let index = 0; index < ids.length; index += 1) {
      if ((index & 255) === 0) assertSearchActive(signal, deadline, '候选文档排序')
      if (!selected.has(ids[index])) remaining.push(ids[index])
    }
    return [...exact, ...interleaveGameCandidates(store, remaining, request, { signal, deadline })]
  }
  if (!request.query || regex) return prioritizeOfficialTitle(scopedIds)
  const queryNgrams = ngramsFor(request.query)
  // v2 包的 unigram/bigram 直接服务 1—2 字查询；旧包仍复用无损分片预筛。
  const indexedLookup = store.findDocumentsByNgrams || store.findDocumentsByTrigrams
  let indexed = queryNgrams.length && indexedLookup
    ? await indexedLookup.call(store, queryNgrams,
      { signal, deadline, packIds: scopedPackIds }) : null
  if (indexed === null && queryNgrams.length && [...queryNgrams[0]].length < 3) {
    indexed = await store.findDocumentsByShortLiteral?.(request.query,
      { signal, deadline, packIds: scopedPackIds }) ?? null
  }
  assertSearchActive(signal, deadline, '候选文档发现')
  if (indexed === null) return prioritizeOfficialTitle(scopedIds)
  return prioritizeOfficialTitle(
    store.orderedDocumentIds([...new Set([...indexed.filter((id) => scoped.has(id)), ...titleIds])]))
}

function interleaveGameCandidates(store, documentIds, request, { signal, deadline } = {}) {
  const requested = request.filters.games?.length
    ? request.filters.games : ['arknights', 'endfield']
  if (requested.length < 2) return documentIds
  const queues = new Map(requested.map((game) => [game, []]))
  const other = []
  for (let index = 0; index < documentIds.length; index += 1) {
    if ((index & 255) === 0) assertSearchActive(signal, deadline, '候选文档排序')
    const documentId = documentIds[index]
    const game = documentGame(store.documents.get(documentId)?.document || {})
    const queue = queues.get(game)
    if (queue) queue.push(documentId)
    else other.push(documentId)
  }
  const nonempty = [...queues.values()].filter((queue) => queue.length)
  if (nonempty.length < 2) return documentIds
  const result = []
  const maximum = Math.max(...nonempty.map((queue) => queue.length))
  for (let index = 0; index < maximum; index += 1) {
    if ((index & 255) === 0) assertSearchActive(signal, deadline, '候选文档排序')
    for (const game of requested) {
      const documentId = queues.get(game)?.[index]
      if (documentId) result.push(documentId)
    }
  }
  return result.concat(other)
}

function collectDocumentGroup(record, request, regex, entityAliasGroups, deadline, signal = null) {
  if (!hydratedRecordMatches(record, request.filters)) return null
  const metadata = record.document
  const sectionRanges = request.filters.wiki_sections.length
    ? wikiSectionRanges(record, request.filters.wiki_sections) : []
  if (request.filters.wiki_sections.length && !sectionRanges.length) return null
  const hasLineScope = lineScopeFor(request)
  const catalogMode = !request.query && !request.filters.speakers.length && !entityAliasGroups.length
  const items = []
  const titleText = searchableTitleText(metadata)
  if (request.query && !hasLineScope
      && matchesText(titleText, request.query, request.match_mode, regex)) {
    const firstSection = sectionRanges[0] || null
    const anchor = firstSection
      ? record.lines.slice(firstSection.start_line - 1, firstSection.end_line)
        .find((line) => normalizeText(line.text))
      : readableAnchor(record, request.filters)
    if (anchor) {
      const exact = normalizeText(metadata.story_name) === request.query
        || normalizeText(metadata.display_title) === request.query
      items.push({ record, line: anchor, score: relevanceScore({ exact }, request, 'title'),
        field: 'title', passage_start: anchor.line_number, passage_end: anchor.line_number,
        passage_match_count: 1, match: { occurrence: null, start: null, end: null },
        ...(firstSection ? { wiki_section: firstSection } : {}) })
    }
  }
  if (catalogMode) {
    if (sectionRanges.length) {
      for (const section of sectionRanges) {
        const anchor = record.lines.slice(section.start_line - 1, section.end_line)
          .find((line) => normalizeText(line.text))
        if (anchor) items.push({ record, line: anchor, score: 1, field: 'wiki_section',
          passage_start: section.start_line, passage_end: section.end_line,
          passage_match_count: 1, match: { occurrence: null, start: null, end: null },
          wiki_section: section })
      }
    } else {
      const anchor = readableAnchor(record, request.filters)
      if (anchor) items.push({ record, line: anchor, score: 1, field: 'catalog',
        passage_start: anchor.line_number, passage_end: anchor.line_number,
        passage_match_count: 1, match: { occurrence: null, start: null, end: null } })
    }
  } else {
    const documentMatches = []
    let documentMatchesTruncated = false
    for (let index = 0; index < record.lines.length; index += 1) {
      if ((index & 255) === 0) {
        // 与 legacy 路径对齐：逐行扫描既响应外部取消，也受时间预算约束。
        if (signal?.aborted) throw Object.assign(new Error('搜索已取消'), { code: 'CANCELLED' })
        if (Date.now() > deadline) {
          throw Object.assign(new Error('本地语料搜索超时'), { code: 'TIMEOUT', retryable: true })
        }
      }
      const wikiSection = sectionRanges.length
        ? wikiSectionAt(sectionRanges, record.lines[index].line_number) : null
      if (sectionRanges.length && !wikiSection) continue
      const match = lineMatch(record, index, request, regex, entityAliasGroups)
      if (!match) continue
      documentMatches.push({ record, line: record.lines[index],
        score: relevanceScore(match, request, 'content'), field: request.query ? 'content'
          : match.occurrence ? 'entity' : 'speaker_raw', match,
        ...(wikiSection ? { wiki_section: wikiSection } : {}) })
      if (!hasLineScope && !regex
          && documentMatches.length >= SIMPLE_LITERAL_MATCH_CAP_PER_DOCUMENT) {
        documentMatchesTruncated = true
        break
      }
    }
    items.push(...clusterPassages(documentMatches, documentMatchesTruncated))
  }
  if (!items.length) return null
  items.sort((left, right) => (left.field === 'title') - (right.field === 'title')
    || right.score - left.score || left.passage_start - right.passage_start)
  return { record, score: Math.max(...items.map((item) => item.score)), items }
}

function previewLinesCost(lines) {
  return lines.reduce((total, line) => total + [...String(line.text || '')].length, 0)
}

/**
 * measureDocument 与 buildPublicDocument 共用同一份命中预览：此前两条路径
 * 各自构建 excerpt（切片 + NFKC 归一化 + 逐行截断），对同一候选文档做双倍
 * 字符串处理；首次计算后缓存在 item/group 上，构建阶段直接复用。
 */
function previewExcerpt(group, item) {
  if (!item.preview) item.preview = excerpt(group.record, item, item.wiki_section)
  return item.preview
}

/** complete_sections 的字段行列表；measure 与 build 共用，避免重复 slice+filter。 */
function sectionPreviewLines(group) {
  if (!group.sectionLines) {
    const section = group.items[0]?.wiki_section
    group.sectionLines = section ? group.record.lines.slice(section.start_line - 1, section.end_line)
      .filter((line) => normalizeText(line.text)) : []
  }
  return group.sectionLines
}

function fitLinesToBudget(lines, budget) {
  const fitted = lines.map((line) => ({ ...line }))
  while (previewLinesCost(fitted) > budget && fitted.some((line) => line.role === 'context')) {
    const lastContext = fitted.findLastIndex((line) => line.role === 'context')
    fitted.splice(lastContext, 1)
  }
  if (previewLinesCost(fitted) <= budget) return fitted
  const target = fitted.find((line) => line.role === 'match') || fitted[0]
  if (!target) return []
  const otherCost = previewLinesCost(fitted) - [...String(target.text || '')].length
  const allowed = Math.max(80, budget - otherCost)
  if ([...String(target.text || '')].length > allowed) {
    target.text = `${[...String(target.text || '')].slice(0, Math.max(1, allowed - 1)).join('')}…`
    target.truncated = true
  }
  return fitted
}

function measureDocument(group, resultKind, request) {
  if (resultKind !== 'documents' && publicResourceType(group.record.document) === 'entity_profile') {
    group.entitySummary ??= publicEntitySummary(group.record, 2400)
    return [...String(group.entitySummary.description || '')].length
      + [...String(group.entitySummary.history_summary || '')].length
  }
  if (resultKind === 'complete_sections') {
    return sectionPreviewLines(group)
      .reduce((total, line) => total + [...String(line.text || '')].length, 0)
  }
  if (resultKind === 'documents') return 0
  return group.items.slice(0, MAX_PASSAGES_PER_DOCUMENT).reduce((total, item) => {
    if (item.field === 'title') return total
    // 与 buildPublicDocument 的 previewLinesCost 同口径（码点计数），
    // 避免 UTF-16 估宽导致预算判定与实际构建不一致。
    return total + previewLinesCost(previewExcerpt(group, item).lines)
  }, 0)
}

function buildPublicDocument(store, group, resultKind, request, budget = Infinity) {
  const metadata = group.record.document
  const title = naturalDocumentTitle(metadata)
  const result = {
    game: documentGame(metadata), title, resource_type: publicResourceType(metadata),
    content_type: publicContentType(metadata),
    ...(store.requiresDocumentUid?.(metadata.document_id)
      ? { document_uid: documentUid(metadata.document_id) } : {}),
    ...(publicCollectionName(metadata) ? { collection_name: publicCollectionName(metadata) } : {}),
    ...(metadata.activity_name ? { activity_name: metadata.activity_name } : {}),
    ...(metadata.character_name ? { character_name: metadata.character_name } : {}),
    matches: [], matches_truncated: group.items.some((item) => item.document_passages_truncated),
  }
  const reasons = new Set()
  let characters = 0
  if (result.matches_truncated) reasons.add('document_passages')
  if (resultKind !== 'documents' && result.resource_type === 'entity_profile') {
    const cap = Math.min(2400, budget)
    result.entity_summary = cap === 2400 && group.entitySummary
      ? group.entitySummary : publicEntitySummary(group.record, cap)
    result.matches_truncated = false
    characters = [...String(result.entity_summary.description || '')].length
      + [...String(result.entity_summary.history_summary || '')].length
    if (result.entity_summary.truncated) reasons.add('entity_summary')
  } else if (resultKind === 'complete_sections') {
    const lines = sectionPreviewLines(group)
    const blocks = []
    for (const line of lines) {
      const text = String(line.text || '')
      if (characters + [...text].length > budget) {
        if (!blocks.length && budget > 0) {
          blocks.push({ type: 'text', text: `${[...text].slice(0, Math.max(1, budget - 1)).join('')}…` })
          characters = Math.min([...text].length, budget)
        }
        reasons.add('section_content')
        break
      }
      blocks.push({ type: 'text', text })
      characters += [...text].length
    }
    const sectionName = group.items[0]?.wiki_section?.name || request.filters.wiki_sections[0]
    result.section_content = { section: sectionName,
      completeness: blocks.length === lines.length ? 'complete' : 'partial', blocks,
      citation: `《${title}》Wiki·${sectionName}` }
  } else if (resultKind !== 'documents') {
    for (const item of group.items.slice(0, MAX_PASSAGES_PER_DOCUMENT)) {
      const titleOnly = item.field === 'title'
      const shown = titleOnly ? { lines: [], characters: 0, truncated: false }
        : previewExcerpt(group, item)
      if (result.matches.length && characters + shown.characters > budget) {
        result.matches_truncated = true
        reasons.add('output_chars')
        reasons.add('document_passages')
        break
      }
      const available = Math.max(0, budget - characters)
      const shownLines = shown.characters > available
        ? fitLinesToBudget(shown.lines, available) : shown.lines
      const shownCharacters = previewLinesCost(shownLines)
      if (shown.truncated || shownCharacters < shown.characters) reasons.add('line_chars')
      const lineStart = item.passage_start
      const lineEnd = item.passage_end
      const sectionName = item.wiki_section?.name
      result.matches.push({
        ...(sectionName || titleOnly ? {} : { line_start: lineStart, line_end: lineEnd }),
        match_kind: matchKind(item, request),
        evidence_kind: evidenceKind(metadata, item.field, item.match?.occurrence),
        excerpt: shownLines,
        citation: titleOnly ? `《${title}》`
          : sectionName ? `《${title}》Wiki·${sectionName}`
          : `《${title}》第 ${lineStart === lineEnd ? lineStart : `${lineStart}-${lineEnd}`} 行`,
      })
      characters += shownCharacters
    }
  }
  return { document: result, characters, reasons }
}

async function executeScanSearch(store, request, checkpoint,
  { signal, requestId = null, deadline = Date.now() + SEARCH_TIMEOUT_MS } = {}) {
  const started = Date.now()
  const resolvedRequestId = String(requestId || `req-${createHash('sha256')
    .update(`${started}:${Math.random()}`).digest('hex').slice(0, 16)}`)
  try {
    assertSearchActive(signal, deadline)
    const regex = request.match_mode === 'regex'
      ? new RegExp(safeRegex(request.query).source, 'iu') : null
    const entityAliasGroups = await aliasesFor(store, request.filters.entity_names)
    assertSearchActive(signal, deadline)
    const candidateIds = await candidateDocumentIds(store, request, regex, { signal, deadline })
    assertSearchActive(signal, deadline, '本地语料搜索初始化')
    const resultKind = resultKindFor(request)
    const documents = []
    const reasons = new Set()
    let characters = 0
    let scanned = 0
    let matchedDocuments = checkpoint.matchedDocumentsSoFar
    let nextCandidateIndex = checkpoint.nextCandidateIndex
    let stopped = false
    for (let candidateIndex = 0; candidateIndex < candidateIds.length; candidateIndex += 1) {
      if ((candidateIndex & 255) === 0) assertSearchActive(signal, deadline)
      const documentId = candidateIds[candidateIndex]
      if (candidateIndex < checkpoint.nextCandidateIndex) continue
      if (documents.length >= PAGE_DOCUMENTS || scanned >= SCAN_DOCUMENTS_PER_PAGE) {
        nextCandidateIndex = candidateIndex
        stopped = true
        break
      }
      assertSearchActive(signal, deadline)
      const location = store.documents.get(documentId)
      scanned += 1
      if (!location || !documentMatches(location.document, location.speakers, request.filters)
          || store.isPreferredNaturalDocument?.(documentId) === false) {
        nextCandidateIndex = candidateIndex + 1
        continue
      }
      const found = await store.getDocument(documentId)
      assertSearchActive(signal, deadline)
      if (!found) {
        nextCandidateIndex = candidateIndex + 1
        continue
      }
      const group = collectDocumentGroup(found.record, request, regex, entityAliasGroups, deadline, signal)
      if (!group) {
        nextCandidateIndex = candidateIndex + 1
        continue
      }
      const remaining = Math.max(0, PREVIEW_OPTIONS.max_total_chars - characters)
      const measured = measureDocument(group, resultKind, request)
      if (documents.length && measured > remaining) {
        nextCandidateIndex = candidateIndex
        reasons.add('output_chars')
        stopped = true
        break
      }
      const built = buildPublicDocument(store, group, resultKind, request,
        documents.length ? remaining : PREVIEW_OPTIONS.max_total_chars)
      documents.push(built.document)
      characters += built.characters
      for (const reason of built.reasons) reasons.add(reason)
      matchedDocuments += 1
      nextCandidateIndex = candidateIndex + 1
    }
    const exhausted = !stopped
    const countKnown = checkpoint.matchedCountKnown !== false
    if (!exhausted) reasons.add('scan_incomplete')
    const nextCursor = exhausted ? null
      : await encodeScanCursor(store, request, nextCandidateIndex, matchedDocuments)
    assertSearchActive(signal, deadline, '分页游标生成')
    return {
      result_kind: resultKind,
      documents,
      page: {
        returned_documents: documents.length,
        ...(exhausted && countKnown ? { total_documents: matchedDocuments } : {}),
        total_relation: exhausted && countKnown ? 'eq' : 'unknown',
        has_more: !exhausted,
        exhausted,
        next_cursor: nextCursor,
      },
      truncated: reasons.size > 0,
      truncation_reasons: [...reasons],
    }
  } catch (error) {
    return { contract_version: SEARCH_CONTRACT_VERSION, status: 'error', request_id: resolvedRequestId,
      data_version: store.dataVersion ?? null,
      error: publicSearchError(error) }
  }
}

export async function executeSearch(store, raw,
  { signal, requestId = null, allowedGames = ['arknights', 'endfield'] } = {}) {
  let deadline = Infinity
  try {
    assertSearchActive(signal, deadline)
    // 首次打开真实资料包需要建立全局轻量索引，这是 Store 就绪阶段，
    // 不应吃掉本次检索的 15s 预算。就绪后只创建一个绝对 deadline，
    // 短词预筛、主扫描和分页锚点全部共用它。
    await store.ready()
    deadline = Date.now() + SEARCH_TIMEOUT_MS
    assertSearchActive(signal, deadline)
    const normalized = normalizedRequest(raw)
    const attachCorpusWarnings = (value, request) => {
      if (value?.status === 'error' || !(store.packs instanceof Map)) return value
      const games = request.filters.games?.length
        ? request.filters.games : ['arknights', 'endfield']
      const packByGame = { arknights: 'official_game', endfield: 'endfield_official_game' }
      const warnings = games.filter((game) => !store.packs.has(packByGame[game])).map((game) => ({
        code: 'CORPUS_GAME_NOT_INSTALLED', game,
        message: `${game === 'endfield' ? '终末地' : '明日方舟'}本地语料未安装，本次只检索其余已安装资料。`,
      }))
      return warnings.length ? { ...value, warnings } : value
    }
    if (normalized.cursor) {
      assertSearchActive(signal, deadline, '分页游标校验')
      const decoded = await decodeCursor(store, normalized.cursor)
      assertSearchActive(signal, deadline, '分页游标校验')
      const requestedGames = decoded.request.filters?.games?.length
        ? decoded.request.filters.games : ['arknights', 'endfield']
      if (requestedGames.some((game) => !allowedGames.includes(game))) {
        throw Object.assign(new Error('该游标包含当前未启用的游戏资料，请重新搜索'),
          { code: 'CURSOR_POLICY_MISMATCH', retryable: false })
      }
      if (decoded.kind === 'legacy') {
        return attachCorpusWarnings(await exposeTitleContinuation(store,
          await executeLegacySearch(store, decoded.request, decoded.offset,
            { signal, requestId, deadline }), { signal, deadline }),
        decoded.request)
      }
      return attachCorpusWarnings(await exposeTitleContinuation(store, await executeScanSearch(store, decoded.request, {
        nextCandidateIndex: decoded.nextCandidateIndex,
        matchedDocumentsSoFar: decoded.matchedDocumentsSoFar,
        matchedCountKnown: true,
      }, { signal, requestId, deadline }), { signal, deadline }), decoded.request)
    }
    const request = withoutAfter(normalized)
    const checkpoint = normalized.after
      ? await checkpointAfterTitle(store, normalized.after, request, { signal, deadline })
      : { nextCandidateIndex: 0, matchedDocumentsSoFar: 0, matchedCountKnown: true }
    return attachCorpusWarnings(await exposeTitleContinuation(store,
      await executeScanSearch(store, request, checkpoint,
        { signal, requestId, deadline }), { signal, deadline }), request)
  } catch (error) {
    return { contract_version: SEARCH_CONTRACT_VERSION, status: 'error',
      request_id: String(requestId || ''), data_version: store.dataVersion ?? null,
      error: publicSearchError(error) }
  }
}

export function renderSearch(args, value) {
  if (value?.error) return [{ type: 'text', text: `[corpus_search:error] ${value.error.code}: ${value.error.message}` }]
  return [{ type: 'text', text: projectSearch(value, {
    query: normalizeText(args?.query),
  }) }]
}
