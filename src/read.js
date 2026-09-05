/**
 * corpus_read 契约实现（corpus_tools_v1.schema.json，prts-corpus-tools-v1）。
 *
 * 与浏览器端 agent/browser/src/corpus-executor.js 语义对齐：
 *   - 单篇 locator + around/range/document，或活动/任务合集 + 连续位置分页
 *   - source_ref 内嵌行号在 around 模式下即中心行；document_id + around 必须显式给 center_line；
 *     display_title + around 的 center_line 可选（执行时缺失则报 LINE_RANGE_INVALID）
 *   - 全文行完整性校验（INDEX_CORRUPT）
 *   - expected_data_version 版本绑定（PACKAGE_VERSION_MISMATCH）
 *   - document 模式 HMAC 游标分页（插件生命周期内有效）
 *   - story 文档只返回请求的原文；剧情总结与时间线必须显式检索
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { computeLinesIntegrity, documentGame, documentUid, naturalDocumentTitle,
  operatorRecordSegment, publicCharacterMaterial, publicStoryPart,
  publicStoryStageCode } from './store.js'
import { WIKI_SECTION_VALUES, wikiSectionRanges } from './wiki.js'

export const CONTRACT_VERSION = 'prts-corpus-tools-v1'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const SOURCE_REF_PATTERN =
  /^(?:(?:official_game:(?:story:[^:]+|character:[^:]+:[^:]+)|client_data:(?:reviewed_wiki|terra_journey|entities|references):[0-9a-f]{24})|prts:(?:arknights|endfield):[A-Za-z0-9._:%/-]+):L([1-9][0-9]*)$/

export const END_FIELD_STORY_CONTENT_TYPES = Object.freeze([
  'dialogue', 'cutscene', 'radio', 'remote_comm', 'black_screen',
  'environment_talk', 'sns_topic', 'sns_chat', 'narration',
])

/** 游标签名密钥：插件实例生命周期内有效（重启即失效，符合契约的游标不透明语义）。 */
const CURSOR_SECRET = randomBytes(32)

/** 契约错误：映射为 errorResponse（status=error）。 */
export class ContractError extends Error {
  /**
   * @param {string} code toolError.code 枚举值
   * @param {string} message
   * @param {{ retryable?: boolean }} [options]
   */
  constructor(code, message, options = {}) {
    super(message)
    this.code = code
    this.retryable = options.retryable ?? false
  }
}

const estimateTokens = (value) => Math.ceil(
  (typeof value === 'number' ? value : String(value ?? '').length) / 2.5,
)

/** ---- 游标（document 模式分页） ---- */

function encodeCursor(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sig = createHmac('sha256', CURSOR_SECRET).update(body).digest('base64url')
  return `${body}.${sig}`
}

function decodeCursor(cursor) {
  const dot = cursor.lastIndexOf('.')
  if (dot <= 0) throw new ContractError('CURSOR_INVALID', 'malformed cursor')
  const [body, sig] = [cursor.slice(0, dot), cursor.slice(dot + 1)]
  // 与 search.js 的游标校验同口径：常数时间比较，长度不等先拒。
  const expected = createHmac('sha256', CURSOR_SECRET).update(body).digest()
  const received = Buffer.from(sig, 'base64url')
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new ContractError('CURSOR_INVALID', 'cursor signature mismatch')
  }
  let payload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    throw new ContractError('CURSOR_INVALID', 'cursor payload is not JSON')
  }
  if (typeof payload !== 'object' || payload === null || typeof payload.v !== 'number') {
    throw new ContractError('CURSOR_INVALID', 'cursor payload has unknown shape')
  }
  return payload
}

/** 模型只回传 cursor；在工具边界内部恢复文档 locator 与 document 模式。 */
export function readContractFromCursor(cursor) {
  const payload = decodeCursor(String(cursor || ''))
  if (payload.v !== 1 || typeof payload.document_id !== 'string' || !payload.document_id) {
    throw new ContractError('CURSOR_INVALID', 'cursor 不是单篇文档读取游标')
  }
  if (payload.max_lines !== undefined && !Number.isInteger(payload.max_lines)) {
    throw new ContractError('CURSOR_INVALID', 'cursor max_lines 无效')
  }
  if (payload.max_chars !== undefined && !Number.isInteger(payload.max_chars)) {
    throw new ContractError('CURSOR_INVALID', 'cursor max_chars 无效')
  }
  return { locator: { document_id: payload.document_id },
    selection: { mode: 'document', cursor: String(cursor) },
    limits: { ...(payload.max_lines !== undefined ? { max_lines: payload.max_lines } : {}),
      ...(payload.max_chars !== undefined ? { max_chars: payload.max_chars } : {}) } }
}

/** ---- 参数校验（跨字段规则由代码执行；DSL 只保证基础形态） ---- */

function requireInt(value, { min, max, field }) {
  if (!Number.isInteger(value)) throw new ContractError('INVALID_REQUEST', `${field} must be an integer`)
  if (value < min || value > max) {
    throw new ContractError('INVALID_REQUEST', `${field} must be within [${min}, ${max}]`)
  }
  return value
}

function requireIdString(value, field) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new ContractError('INVALID_REQUEST', `${field} must match ${ID_PATTERN}`)
  }
  return value
}

/**
 * 校验并归一化 corpus_read 请求（填默认值，产出 normalized_request）。
 * @throws {ContractError}
 */
export function normalizeReadRequest(raw) {
  if (typeof raw !== 'object' || raw === null) {
    throw new ContractError('INVALID_REQUEST', 'request must be an object')
  }
  const { intent_id: intentId, request_id: requestIdInput, expected_data_version: expectedVersion } = raw

  const intentIdChecked = requireIdString(intentId, 'intent_id')
  const requestId = requestIdInput === undefined
    ? `req-${randomBytes(8).toString('hex')}`
    : requireIdString(requestIdInput, 'request_id')
  if (expectedVersion !== undefined && !SHA256_PATTERN.test(expectedVersion)) {
    throw new ContractError('INVALID_REQUEST', 'expected_data_version must be a lowercase sha256 hex string')
  }

  // locator：单篇文档、明日方舟活动或终末地集合恰好一个
  const locatorRaw = raw.locator
  if (typeof locatorRaw !== 'object' || locatorRaw === null) {
    throw new ContractError('INVALID_REQUEST', 'locator must be an object')
  }
  const hasSourceRef = locatorRaw.source_ref !== undefined
  const hasDocumentId = locatorRaw.document_id !== undefined
  const hasDocumentUid = locatorRaw.document_uid !== undefined
  const hasDisplayTitle = locatorRaw.display_title !== undefined
  const hasActivityId = locatorRaw.activity_id !== undefined
  const hasActivityName = locatorRaw.activity_name !== undefined
  const hasCollectionName = locatorRaw.collection_name !== undefined
  const hasStreamLocator = hasActivityId || hasActivityName || hasCollectionName
  const locatorCount = Number(hasSourceRef) + Number(hasDocumentId) + Number(hasDocumentUid) + Number(hasDisplayTitle)
    + Number(hasActivityId) + Number(hasActivityName) + Number(hasCollectionName)
  if (locatorCount !== 1) {
    throw new ContractError('INVALID_REQUEST',
      'locator must contain exactly one of source_ref / document_id / document_uid / display_title / activity_id / activity_name / collection_name')
  }
  let locator
  let refLine = null
  if (hasSourceRef) {
    const sourceRef = locatorRaw.source_ref
    if (typeof sourceRef !== 'string' || sourceRef.length > 1024) {
      throw new ContractError('SOURCE_REF_INVALID', 'source_ref must be a string of at most 1024 chars')
    }
    const match = SOURCE_REF_PATTERN.exec(sourceRef)
    if (!match) throw new ContractError('SOURCE_REF_INVALID', `source_ref does not match contract pattern: ${sourceRef}`)
    refLine = Number.parseInt(match[1], 10)
    locator = { source_ref: sourceRef }
  } else if (hasDocumentId) {
    const documentId = locatorRaw.document_id
    if (typeof documentId !== 'string' || documentId.length < 1 || documentId.length > 512 || !/\S/.test(documentId)) {
      throw new ContractError('INVALID_REQUEST', 'document_id must be a non-empty identifier')
    }
    locator = { document_id: documentId }
  } else if (hasDocumentUid) {
    const uid = String(locatorRaw.document_uid || '').trim()
    if (!/^doc_[A-Za-z0-9_-]{16}$/u.test(uid)) {
      throw new ContractError('INVALID_REQUEST', 'document_uid must be a public doc_ locator')
    }
    locator = { document_uid: uid }
  } else if (hasDisplayTitle) {
    const displayTitle = locatorRaw.display_title
    if (typeof displayTitle !== 'string' || displayTitle.length < 1 || displayTitle.length > 512 || !/\S/.test(displayTitle)) {
      throw new ContractError('INVALID_REQUEST', 'display_title must be a non-empty title of at most 512 chars')
    }
    locator = { display_title: displayTitle }
  } else if (hasActivityId) {
    const activityId = String(locatorRaw.activity_id).trim()
    if (!activityId || activityId.length > 512) {
      throw new ContractError('INVALID_REQUEST', 'activity_id must be a non-empty identifier of at most 512 chars')
    }
    locator = { activity_id: activityId }
  } else if (hasActivityName) {
    const activityName = String(locatorRaw.activity_name).trim()
    if (!activityName || activityName.length > 512) {
      throw new ContractError('INVALID_REQUEST', 'activity_name must be a non-empty title of at most 512 chars')
    }
    locator = { activity_name: activityName }
  } else {
    const collectionName = String(locatorRaw.collection_name).trim()
    if (!collectionName || collectionName.length > 512) {
      throw new ContractError('INVALID_REQUEST', 'collection_name must be a non-empty title of at most 512 chars')
    }
    locator = { collection_name: collectionName }
  }

  // selection：around / range / document / section / activity / collection
  const selectionRaw = raw.selection
  if (typeof selectionRaw !== 'object' || selectionRaw === null) {
    throw new ContractError('INVALID_REQUEST', 'selection must be an object')
  }
  const mode = selectionRaw.mode
  let selection
  if (mode === 'around') {
    if (hasStreamLocator) throw new ContractError('INVALID_REQUEST', 'around mode requires a document locator')
    if (hasSourceRef) {
      if (selectionRaw.center_line !== undefined) {
        throw new ContractError('INVALID_REQUEST', 'around with source_ref locator must not set center_line')
      }
      selection = {
        mode: 'around',
        before_lines: selectionRaw.before_lines ?? 3,
        after_lines: selectionRaw.after_lines ?? 3,
      }
    } else {
      // document_id：center_line 必填；display_title：center_line 可选（执行时缺失报错）
      if ((hasDocumentId || hasDocumentUid) && selectionRaw.center_line === undefined) {
        throw new ContractError('INVALID_REQUEST', 'around with document_id/document_uid locator requires center_line')
      }
      if (selectionRaw.center_line !== undefined) {
        requireInt(selectionRaw.center_line, { min: 1, max: 1e9, field: 'center_line' })
      }
      selection = {
        mode: 'around',
        ...(selectionRaw.center_line !== undefined ? { center_line: selectionRaw.center_line } : {}),
        before_lines: selectionRaw.before_lines ?? 3,
        after_lines: selectionRaw.after_lines ?? 3,
      }
    }
    requireInt(selection.before_lines, { min: 0, max: 100, field: 'before_lines' })
    requireInt(selection.after_lines, { min: 0, max: 100, field: 'after_lines' })
  } else if (mode === 'range') {
    if (hasStreamLocator) throw new ContractError('INVALID_REQUEST', 'range mode requires a document locator')
    const startLine = requireInt(selectionRaw.start_line, { min: 1, max: 1e9, field: 'start_line' })
    const endLine = requireInt(selectionRaw.end_line, { min: 1, max: 1e9, field: 'end_line' })
    if (endLine < startLine) throw new ContractError('LINE_RANGE_INVALID', 'end_line must be >= start_line')
    selection = { mode: 'range', start_line: startLine, end_line: endLine }
  } else if (mode === 'document') {
    if (hasStreamLocator) throw new ContractError('INVALID_REQUEST', 'document mode requires a document locator')
    const startLine = selectionRaw.start_line === undefined ? 1
      : requireInt(selectionRaw.start_line, { min: 1, max: 1e9, field: 'start_line' })
    if (selectionRaw.cursor != null && selectionRaw.start_line !== undefined) {
      throw new ContractError('INVALID_REQUEST', 'document mode cannot combine cursor with start_line')
    }
    selection = { mode: 'document', cursor: selectionRaw.cursor ?? null, start_line: startLine }
  } else if (mode === 'section') {
    if (hasStreamLocator) {
      throw new ContractError('INVALID_REQUEST', 'section mode requires a document locator')
    }
    const section = String(selectionRaw.section || '').trim()
    if (!WIKI_SECTION_VALUES.includes(section)) {
      throw new ContractError('INVALID_REQUEST', 'section must be a supported Wiki field')
    }
    selection = { mode: 'section', section }
  } else if (mode === 'activity' || mode === 'collection') {
    const expectedLocator = mode === 'activity'
      ? hasActivityId || hasActivityName || hasDocumentUid
      : hasCollectionName || hasDocumentUid
    if (!expectedLocator) {
      throw new ContractError('INVALID_REQUEST',
        `${mode} mode requires ${mode === 'activity' ? 'activity_id or activity_name' : 'collection_name'} locator`)
    }
    if (selectionRaw.cursor != null && selectionRaw.start_position !== undefined) {
      throw new ContractError('INVALID_REQUEST', `${mode} mode cannot combine cursor with start_position`)
    }
    const startPosition = selectionRaw.start_position === undefined ? 1
      : requireInt(selectionRaw.start_position, { min: 1, max: 1e9, field: 'start_position' })
    let contentTypes = []
    if (selectionRaw.content_types !== undefined) {
      if (mode !== 'collection' || !Array.isArray(selectionRaw.content_types)
          || selectionRaw.content_types.length > END_FIELD_STORY_CONTENT_TYPES.length
          || selectionRaw.content_types.some((item) => !END_FIELD_STORY_CONTENT_TYPES.includes(item))) {
        throw new ContractError('INVALID_REQUEST',
          'content_types is only available in collection mode and must contain supported original-story types')
      }
      contentTypes = [...new Set(selectionRaw.content_types)]
    }
    selection = { mode, cursor: selectionRaw.cursor ?? null, start_position: startPosition,
      ...(contentTypes.length ? { content_types: contentTypes } : {}) }
  } else {
    throw new ContractError('INVALID_REQUEST',
      'selection.mode must be around | range | document | section | activity | collection')
  }

  const format = raw.format === undefined ? 'lines' : raw.format
  if (format !== 'lines' && format !== 'plain_text') {
    throw new ContractError('INVALID_REQUEST', 'format must be lines | plain_text')
  }

  const includeAdjacent = raw.include_adjacent_documents === undefined ? true : raw.include_adjacent_documents
  if (typeof includeAdjacent !== 'boolean') {
    throw new ContractError('INVALID_REQUEST', 'include_adjacent_documents must be a boolean')
  }

  const limitsRaw = raw.limits ?? {}
  if (typeof limitsRaw !== 'object' || limitsRaw === null) {
    throw new ContractError('INVALID_REQUEST', 'limits must be an object')
  }
  const limits = {
    max_lines: limitsRaw.max_lines ?? 100,
    max_chars: limitsRaw.max_chars ?? 12000,
  }
  requireInt(limits.max_lines, { min: 1, max: 500, field: 'limits.max_lines' })
  requireInt(limits.max_chars, { min: 100, max: 100000, field: 'limits.max_chars' })

  const normalized = {
    intent_id: intentIdChecked,
    request_id: requestId,
    locator,
    selection,
    format,
    include_adjacent_documents: includeAdjacent,
    limits,
  }
  if (expectedVersion !== undefined) normalized.expected_data_version = expectedVersion
  return { normalized, refLine }
}

/** ---- 文档摘要投影 ---- */

const SUMMARY_FIELDS = [
  'game', 'resource_type', 'content_type', 'collection_name', 'collection_type',
  'document_id', 'document_type', 'document_category', 'document_kind', 'display_title',
  'collection_id', 'activity_id', 'activity_name', 'source_story_id', 'story_id', 'story_code',
  'story_name', 'part_type', 'part_label', 'char_id', 'character_name', 'path', 'text_sha256',
  'line_count', 'sequence_index', 'sequence_source', 'sequence_confidence',
  'previous_document_id', 'next_document_id', 'source_ref_prefix', 'entity_id',
]

function toDocumentSummary(documentRecord) {
  const summary = { document_uid: documentUid(documentRecord.document_id),
    game: documentGame(documentRecord) }
  // 与浏览器 executor.summary() 一致：固定摘要字段缺失时输出空字符串，
  // 不能把 undefined 带过 Harness 的 lossless-JSON 工具边界。
  for (const field of SUMMARY_FIELDS) summary[field] = documentRecord[field] ?? ''
  return summary
}

/** 由完整 record 构建文档摘要：实体文档的 entity_id 位于 record.entity 而非 document 上。 */
function recordSummary(record) {
  const summary = toDocumentSummary(record.document)
  if (record.document?.document_type === 'entity' && record.entity?.entity_id) {
    summary.entity_id = String(record.entity.entity_id)
  }
  return summary
}

/** ---- 执行 ---- */

/**
 * 执行 corpus_read。
 * @param {import('./store.js').CorpusStore} store
 * @param {object} rawArgs 模型原始参数
 * @param {{ signal?: AbortSignal }} runtime
 * @returns {Promise<object>} 契约响应（ok / error）
 */
export async function executeRead(store, rawArgs, runtime) {
  const startedAt = Date.now()
  try {
    await store.ready()
    const { normalized, refLine } = normalizeReadRequest(rawArgs)
    if (runtime.signal?.aborted) throw new ContractError('CANCELLED', 'aborted before execution')

    if (normalized.expected_data_version !== undefined && normalized.expected_data_version !== store.dataVersion) {
      throw new ContractError('PACKAGE_VERSION_MISMATCH',
        `expected data_version ${normalized.expected_data_version} but active release is ${store.dataVersion}`)
    }

    // 合集通读：枚举活动/任务的全部官方剧情，按顺序跨文档读取与分页。
    if (normalized.selection.mode === 'activity' || normalized.selection.mode === 'collection') {
      return await executeStoryStreamRead(store, normalized, { runtime, startedAt })
    }

    // 定位文档
    let found
    if (normalized.locator.document_id !== undefined) {
      found = await store.getDocument(normalized.locator.document_id)
      if (found === null) throw new ContractError('DOCUMENT_NOT_FOUND', `document not found: ${normalized.locator.document_id}`)
    } else if (normalized.locator.document_uid !== undefined) {
      found = await store.getDocumentByUid(normalized.locator.document_uid)
      if (found === null) {
        throw new ContractError('DOCUMENT_NOT_FOUND',
          `本地资料包中找不到 document_uid=${normalized.locator.document_uid}`)
      }
    } else if (normalized.locator.display_title !== undefined) {
      try {
        found = await store.getDocumentByTitle(normalized.locator.display_title)
      } catch (error) {
        if (error?.code === 'DOCUMENT_AMBIGUOUS') {
          throw new ContractError('DOCUMENT_AMBIGUOUS', error.message)
        }
        throw error
      }
      if (found === null) {
        throw new ContractError('DOCUMENT_NOT_FOUND', '本地资料包中找不到该完整标题对应的文档')
      }
    } else {
      const sourceRef = normalized.locator.source_ref
      const prefix = sourceRef.slice(0, sourceRef.lastIndexOf(':L'))
      const documentId = store.getDocumentIdByPrefix(prefix)
      if (documentId === null) throw new ContractError('DOCUMENT_NOT_FOUND', `unknown source_ref prefix: ${prefix}`)
      found = await store.getDocument(documentId)
      if (found === null) throw new ContractError('DOCUMENT_NOT_FOUND', `document not found: ${documentId}`)
    }
    // GameData 把 [uc]info/ 一行式简介排在 obt/ 对话正文之前；document 模式
    // 命中简介时优先换成可读全文（与浏览器执行器 readableStoryRecord 一致）。
    let record = found.record
    if (normalized.selection.mode === 'document') {
      const sourceStoryId = String(record.document.source_story_id || '')
      if (record.document.document_kind === 'synopsis' && sourceStoryId.startsWith('[uc]info/')) {
        const fullStory = await store.getDocumentBySourceStoryId(sourceStoryId.slice('[uc]info/'.length))
        if (fullStory?.record?.document?.document_kind === 'story') record = fullStory.record
      }
    }

    const packId = found.packId
    const packManifest = store.packs.get(packId)
    const document = record.document
    const documentId = document.document_id
    const lineCount = document.line_count

    // 行完整性（全文）：行文本 \n 连接后 sha256 与 local_integrity 比对
    const actualIntegrity = computeLinesIntegrity(record.lines)
    const expectedIntegrity = record.local_integrity?.sha256
    const integrityVerified = expectedIntegrity === actualIntegrity
    if (!integrityVerified) {
      throw new ContractError('INDEX_CORRUPT', `integrity mismatch for ${documentId}: expected ${expectedIntegrity}, got ${actualIntegrity}`)
    }

    if (runtime.signal?.aborted) throw new ContractError('CANCELLED', 'aborted after integrity check')

    // 解析选区 → [startLine, endLine]
    const { selection } = normalized
    let startLine
    let endLine
    let cursorNextLine = null
    if (selection.mode === 'around') {
      const center = normalized.locator.source_ref !== undefined ? refLine : selection.center_line
      if (!center || center > lineCount) {
        throw new ContractError('LINE_RANGE_INVALID', `center line ${center ?? '(missing)'} is missing or beyond document length ${lineCount}`)
      }
      startLine = Math.max(1, center - selection.before_lines)
      endLine = Math.min(lineCount, center + selection.after_lines)
    } else if (selection.mode === 'range') {
      if (selection.start_line > lineCount) {
        throw new ContractError('LINE_RANGE_INVALID', `start_line ${selection.start_line} is beyond document length ${lineCount}`)
      }
      startLine = selection.start_line
      endLine = Math.min(lineCount, selection.end_line)
    } else if (selection.mode === 'section') {
      if (document.document_type !== 'knowledge' || document.document_kind !== 'wiki') {
        throw new ContractError('INVALID_REQUEST', 'section mode can only read Wiki documents')
      }
      const ranges = wikiSectionRanges(record, [selection.section])
      if (!ranges.length) {
        throw new ContractError('DOCUMENT_NOT_FOUND', `Wiki 文档“${document.display_title}”没有字段“${selection.section}”`)
      }
      if (ranges.length > 1) {
        throw new ContractError('DOCUMENT_AMBIGUOUS',
          `Wiki 文档“${document.display_title}”包含多个“${selection.section}”字段；请用 corpus_search 获取具体行范围`)
      }
      startLine = ranges[0].start_line
      endLine = ranges[0].end_line
    } else {
      let nextLine = selection.start_line
      if (selection.cursor !== null) {
        if (typeof selection.cursor !== 'string' || selection.cursor.length < 1 || selection.cursor.length > 4096) {
          throw new ContractError('CURSOR_INVALID', 'cursor must be a string of 1..4096 chars')
        }
        const payload = decodeCursor(selection.cursor)
        if (payload.v !== 1 || payload.document_id !== documentId || payload.data_version !== store.dataVersion) {
          throw new ContractError('CURSOR_VERSION_MISMATCH', 'cursor is bound to a different document or data_version')
        }
        nextLine = payload.next_line
        if (nextLine < 1 || nextLine > lineCount) {
          throw new ContractError('CURSOR_INVALID', `cursor next_line ${nextLine} is out of range`)
        }
      }
      startLine = nextLine
      endLine = lineCount
    }

    // 应用 limits 截取
    const { max_lines: maxLines, max_chars: maxChars } = normalized.limits
    const spanLines = endLine - startLine + 1
    let truncated = false
    let truncationReason = null
    let selectedEnd = endLine
    if (spanLines > maxLines) {
      selectedEnd = startLine + maxLines - 1
      truncated = true
      truncationReason = 'max_lines'
    }

    const selectedLines = []
    let charCount = 0
    for (let lineNumber = startLine; lineNumber <= selectedEnd; lineNumber += 1) {
      const line = record.lines[lineNumber - 1]
      if (charCount + line.text.length > maxChars) {
        truncated = true
        truncationReason = truncationReason ?? 'max_chars'
        break
      }
      charCount += line.text.length
      selectedLines.push(line)
    }
    // 首行即超过 max_chars 时不能返回“0 行 + 原地游标”的 ok 响应——document
    // 模式的 next_cursor 不会前进，模型分页会死循环。与 activity 模式一致
    // 上报预算不足，让调用方提高 max_chars 后重试。
    if (!selectedLines.length && truncated) {
      throw new ContractError('BUDGET_EXCEEDED',
        `读取范围内首行长度已超过 max_chars=${maxChars}；请提高 max_chars 后重试`)
    }
    const returned = selectedLines.length
    const hasMore = truncated || selectedEnd < endLine
    let nextCursor = null
    if (selection.mode === 'document' && hasMore) {
      cursorNextLine = startLine + returned
      nextCursor = encodeCursor({
        v: 1,
        document_id: documentId,
        data_version: store.dataVersion,
        next_line: cursorNextLine,
        max_lines: maxLines,
        max_chars: maxChars,
      })
    }

    // 内容投影
    let content
    if (normalized.format === 'plain_text') {
      content = { format: 'plain_text', text: selectedLines.map((line) => line.text).join('\n') }
    } else {
      content = {
        format: 'lines',
        lines: selectedLines.map((line) => ({
          line_number: line.line_number,
          ...(line.source_line_id ? { source_line_id: line.source_line_id } : {}),
          line_type: line.line_type ?? '',
          speaker_raw: line.speaker_raw ?? '',
          ...(line.speaker_id ? { speaker_id: line.speaker_id } : {}),
          text: line.text ?? '',
          ...(line.audio ? { audio: line.audio } : {}),
          ...(line.hint ? { hint: line.hint } : {}),
          source_ref: `${document.source_ref_prefix}:L${line.line_number}`,
        })),
      }
    }

    // 相邻文档摘要
    let adjacentDocuments
    if (normalized.include_adjacent_documents) {
      const previousId = document.previous_document_id || null
      const nextId = document.next_document_id || null
      const previous = previousId ? await store.getDocument(previousId) : null
      const next = nextId ? await store.getDocument(nextId) : null
      adjacentDocuments = {
        previous: previous ? toDocumentSummary(previous.record.document) : null,
        next: next ? toDocumentSummary(next.record.document) : null,
      }
    }

    return {
      contract_version: CONTRACT_VERSION,
      status: 'ok',
      request_id: normalized.request_id,
      data_version: store.dataVersion,
      package_schema_version: packManifest.package_schema_version ?? 1,
      index_schema_version: packManifest.index_schema_version ?? 1,
      normalized_request: normalized,
      document: recordSummary(record),
      selection: {
        mode: selection.mode,
        ...(selection.mode === 'section' ? { wiki_section: selection.section } : {}),
        line_start: returned > 0 ? selectedLines[0].line_number : startLine,
        line_end: returned > 0 ? selectedLines[returned - 1].line_number : startLine - 1,
        line_count: returned,
        character_count: charCount,
        truncated,
        ...(truncationReason ? { truncation_reason: truncationReason } : {}),
      },
      content,
      page: {
        limit: maxLines,
        returned,
        has_more: hasMore,
        next_cursor: nextCursor,
        total: selection.mode === 'document' ? lineCount : spanLines,
        total_relation: 'eq',
      },
      ...(adjacentDocuments ? { adjacent_documents: adjacentDocuments } : {}),
      integrity: {
        verified: integrityVerified,
        expected_text_sha256: expectedIntegrity,
        actual_text_sha256: actualIntegrity,
      },
      stats: {
        elapsed_ms: Date.now() - startedAt,
        scanned_documents: 1,
        scanned_lines: lineCount,
        returned_chars: charCount,
        estimated_input_tokens: estimateTokens(charCount),
        truncated,
      },
      warnings: [],
    }
  } catch (error) {
    if (error instanceof ContractError) {
      return {
        contract_version: CONTRACT_VERSION,
        status: 'error',
        request_id: typeof rawArgs?.request_id === 'string' ? rawArgs.request_id : `req-${randomBytes(8).toString('hex')}`,
        data_version: store.dataVersion ?? null,
        error: { code: error.code, message: error.message, retryable: error.retryable },
      }
    }
    if (error?.code === 'ENOENT' || /current\.json|release-manifest/.test(error?.message ?? '')) {
      return {
        contract_version: CONTRACT_VERSION,
        status: 'error',
        request_id: `req-${randomBytes(8).toString('hex')}`,
        data_version: null,
        error: { code: 'PACKAGE_NOT_INSTALLED',
          message: '本地资料包未安装或不完整，请在 PRTS 语料设置中重新下载或激活版本',
          retryable: true },
      }
    }
    throw error // 基础设施故障交给宿主 isError
  }
}

/** 合集行保留可检索自然标题；同名碎片由稳定 document_uid 消歧。 */
function streamDocumentLabels(docs) {
  return docs.map((item) => naturalDocumentTitle(item.document))
}

/** activity/collection 共用的跨文档连续读取。 */
async function executeStoryStreamRead(store, normalized, { runtime, startedAt }) {
  const { selection } = normalized
  const isActivity = selection.mode === 'activity'
  let docs
  const anchorDocumentId = normalized.locator.document_uid
    ? store.getDocumentIdByUid(normalized.locator.document_uid) || '' : ''
  if (normalized.locator.document_uid && !anchorDocumentId) {
    throw new ContractError('DOCUMENT_NOT_FOUND',
      `本地资料包中找不到 document_uid=${normalized.locator.document_uid}`)
  }
  try {
    docs = isActivity
      ? store.activityStoryDocuments({ activityId: normalized.locator.activity_id,
          activityName: normalized.locator.activity_name, anchorDocumentId })
      : store.endfieldCollectionDocuments({ collectionName: normalized.locator.collection_name,
          contentTypes: selection.content_types ?? [], anchorDocumentId })
  } catch (error) {
    if (error?.code === 'DOCUMENT_AMBIGUOUS') {
      throw new ContractError('DOCUMENT_AMBIGUOUS', error.message)
    }
    throw error
  }
  const targetName = String(isActivity
    ? normalized.locator.activity_name || normalized.locator.activity_id || ''
    : normalized.locator.collection_name || '')
  if (!docs.length) {
    throw new ContractError('DOCUMENT_NOT_FOUND',
      `本地资料包中找不到${isActivity ? '活动' : '终末地集合'}“${targetName}”的剧情原文`)
  }

  const totalLines = docs.reduce((total, item) => total + Number(item.document.line_count || 0), 0)
  const collectionId = String(docs[0].document.collection_id || docs[0].document.activity_id || '')
  const streamKey = JSON.stringify([selection.mode, collectionId, selection.content_types ?? []])
  let docIndex = 0
  let startLine = 1
  let startPosition = selection.start_position
  if (selection.cursor !== null) {
    if (typeof selection.cursor !== 'string' || selection.cursor.length < 1 || selection.cursor.length > 4096) {
      throw new ContractError('CURSOR_INVALID', 'cursor must be a string of 1..4096 chars')
    }
    const payload = decodeCursor(selection.cursor)
    const legacyActivity = payload.v === 2 && isActivity
    if ((!legacyActivity && (payload.v !== 3 || payload.stream_key !== streamKey))
        || payload.data_version !== store.dataVersion) {
      throw new ContractError('CURSOR_VERSION_MISMATCH',
        'cursor is bound to a different collection, filter, or data_version')
    }
    if (!Number.isInteger(payload.doc_index) || payload.doc_index < 0 || payload.doc_index >= docs.length
        || !Number.isInteger(payload.next_line) || payload.next_line < 1
        || payload.next_line > Number(docs[payload.doc_index].document.line_count || 0)) {
      throw new ContractError('CURSOR_INVALID', 'story-stream cursor payload is invalid')
    }
    docIndex = payload.doc_index
    startLine = payload.next_line
    startPosition = docs.slice(0, docIndex).reduce(
      (total, item) => total + Number(item.document.line_count || 0), 0) + startLine
  } else {
    if (startPosition > totalLines) {
      throw new ContractError('LINE_RANGE_INVALID',
        `position ${startPosition} is beyond collection length ${totalLines}`)
    }
    let remaining = startPosition
    for (let index = 0; index < docs.length; index += 1) {
      const lineCount = Number(docs[index].document.line_count || 0)
      if (remaining <= lineCount) {
        docIndex = index
        startLine = remaining
        break
      }
      remaining -= lineCount
    }
  }

  const labels = streamDocumentLabels(docs)
  const { max_lines: maxLines, max_chars: maxChars } = normalized.limits
  const selected = []
  let charCount = 0
  let currentPosition = startPosition
  let nextLocation = null
  let truncationReason = null
  streamDocuments:
  for (let index = docIndex; index < docs.length; index += 1) {
    if (runtime.signal?.aborted) throw new ContractError('CANCELLED', 'aborted during story-stream read')
    const found = await store.getDocument(docs[index].document.document_id)
    if (!found) continue
    const record = found.record
    const document = record.document
    const actualIntegrity = computeLinesIntegrity(record.lines)
    if (record.local_integrity?.sha256 !== actualIntegrity) {
      throw new ContractError('INDEX_CORRUPT',
        `integrity mismatch for ${document.document_id}: expected ${record.local_integrity?.sha256}, got ${actualIntegrity}`)
    }
    const start = index === docIndex ? startLine : 1
    for (let number = start; number <= record.lines.length; number += 1) {
      const line = record.lines[number - 1]
      if (selected.length >= maxLines) {
        truncationReason = 'max_lines'
        nextLocation = { doc_index: index, next_line: number }
        break streamDocuments
      }
      if (charCount + line.text.length > maxChars) {
        truncationReason = 'max_chars'
        nextLocation = { doc_index: index, next_line: number }
        break streamDocuments
      }
      charCount += line.text.length
      selected.push({ line, document, packId: found.packId,
        documentTitle: labels[index], streamPosition: currentPosition })
      currentPosition += 1
      nextLocation = number < record.lines.length
        ? { doc_index: index, next_line: number + 1 }
        : index + 1 < docs.length ? { doc_index: index + 1, next_line: 1 } : null
    }
  }
  if (!selected.length) {
    throw new ContractError('BUDGET_EXCEEDED',
      `读取范围内首行长度已超过 max_chars=${maxChars}；请提高 max_chars 后重试`)
  }

  const nextStreamPosition = nextLocation ? currentPosition : null
  const nextCursor = nextLocation ? encodeCursor({ v: 3, data_version: store.dataVersion,
    stream_key: streamKey, ...nextLocation }) : null
  const first = selected[0]
  const firstDocSummary = toDocumentSummary(first.document)
  const streamSources = new Map()
  for (const item of selected) {
    const id = String(item.document.document_id || '')
    const current = streamSources.get(id) || {
      document_id: id, document_uid: documentUid(id), title: item.documentTitle,
      line_start: item.line.line_number, line_end: item.line.line_number,
    }
    current.line_start = Math.min(current.line_start, item.line.line_number)
    current.line_end = Math.max(current.line_end, item.line.line_number)
    streamSources.set(id, current)
  }
  const streamName = String(isActivity
    ? first.document.activity_name || targetName : first.document.collection_name || targetName)
  const stream = {
    mode: selection.mode,
    game: isActivity ? 'arknights' : 'endfield',
    name: streamName,
    document_count: docs.length,
    total_lines: totalLines,
    position_start: startPosition,
    position_end: currentPosition - 1,
    next_position: nextStreamPosition,
    order_kind: isActivity ? 'source_sequence' : 'derived_content_grouping',
    order_confidence: isActivity ? 'source_backed' : 'derived',
    order_note: isActivity
      ? '按明日方舟活动资料的来源序列连续读取。'
      : '终末地碎片缺少可证明的全局时间线；当前仅按内容类型分组，并在组内按自然编号排序，不代表游戏内先后。',
    anchor_document_uid: documentUid(first.document.document_id),
    sources: [...streamSources.values()],
    ...(selection.content_types?.length ? { content_types: selection.content_types } : {}),
  }
  const activity = isActivity ? {
    activity_id: String(firstDocSummary.activity_id || firstDocSummary.collection_id || ''),
    activity_name: streamName,
    story_count: docs.length,
    total_lines: totalLines,
  } : null

  const content = normalized.format === 'plain_text'
    ? { format: 'plain_text', text: selected.map((item) => item.line.text).join('\n') }
    : { format: 'lines', lines: selected.map((item) => ({
      line_number: item.line.line_number,
      ...(item.line.source_line_id ? { source_line_id: item.line.source_line_id } : {}),
      line_type: item.line.line_type ?? '',
      speaker_raw: item.line.speaker_raw ?? '',
      ...(item.line.speaker_id ? { speaker_id: item.line.speaker_id } : {}),
      text: item.line.text ?? '',
      ...(item.line.audio ? { audio: item.line.audio } : {}),
      ...(item.line.hint ? { hint: item.line.hint } : {}),
      source_ref: `${item.document.source_ref_prefix}:L${item.line.line_number}`,
      document_id: item.document.document_id,
      document_uid: documentUid(item.document.document_id),
      document_title: item.documentTitle,
      stream_position: item.streamPosition,
    })) }

  const firstPackManifest = store.packs.get(first.packId)
  const returnedIntegrity = computeLinesIntegrity(selected.map((item) => item.line))
  return {
    contract_version: CONTRACT_VERSION,
    status: 'ok',
    request_id: normalized.request_id,
    data_version: store.dataVersion,
    package_schema_version: firstPackManifest?.package_schema_version ?? 1,
    index_schema_version: firstPackManifest?.index_schema_version ?? 1,
    normalized_request: normalized,
    document: firstDocSummary,
    selection: {
      mode: selection.mode,
      line_start: startPosition,
      line_end: currentPosition - 1,
      line_count: selected.length,
      character_count: charCount,
      truncated: Boolean(nextLocation),
      ...(truncationReason ? { truncation_reason: truncationReason } : {}),
    },
    content,
    page: { limit: maxLines, returned: selected.length, has_more: Boolean(nextLocation),
      next_cursor: nextCursor, total: totalLines, total_relation: 'eq' },
    stream,
    ...(activity ? { activity } : {}),
    integrity: { verified: true, expected_text_sha256: returnedIntegrity,
      actual_text_sha256: returnedIntegrity },
    stats: {
      elapsed_ms: Date.now() - startedAt,
      scanned_documents: docs.length,
      scanned_lines: selected.length,
      returned_chars: charCount,
      estimated_input_tokens: estimateTokens(selected.map((item) => item.line.text).join('\n')),
      truncated: Boolean(nextLocation),
    },
    warnings: [],
  }
}

/** ---- 模型可见文本渲染 ---- */

/**
 * 模型可见的单行渲染格式（renderRead 使用）。evidence-state.js 的读取去重
 * 依赖在模型 surface 中检索同一格式的行标记，两处必须共用本函数，否则
 * 去重判定会与模型实际可见文本脱节。
 */
export function readableRenderedLine(line, marker = 'L') {
  const speaker = String(line.speaker_raw || '').trim()
  let text = String(line.text || '')
  if (speaker) {
    const escaped = speaker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    text = text.replace(new RegExp(`^${escaped}\\s*[：:]\\s*`, 'u'), '')
  }
  return `${marker}${line.line_number} ${line.line_type || ''} ${speaker ? `${speaker}: ` : ''}${text}`
    .replace(/\s+$/u, '')
}

function publicLine(line) {
  const speaker = String(line.speaker_raw || '').trim()
  let text = String(line.text || '')
  if (speaker) {
    const escaped = speaker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    text = text.replace(new RegExp(`^${escaped}\\s*[：:]\\s*`, 'u'), '')
  }
  return { line: line.line_number,
    ...(line.source_line_id ? { source_line_id: line.source_line_id } : {}),
    line_type: line.line_type || '', speaker,
    ...(line.speaker_id ? { speaker_id: line.speaker_id } : {}),
    text,
    ...(line.document_title ? { document_title: line.document_title } : {}),
    ...(line.document_uid ? { document_uid: line.document_uid } : {}),
    ...(Number.isInteger(line.stream_position) ? { stream_position: line.stream_position } : {}),
    ...(line.document_title ? { citation: `《${line.document_title}》${line.document_uid
      ? `（document_uid=${line.document_uid}）` : ''}第 ${line.line_number} 行` } : {}),
    ...(line.audio ? { audio: line.audio } : {}),
    ...(line.hint ? { hint: line.hint } : {}) }
}

/** 执行层富响应 → 模型/程序共用的自然定位 public result。 */
export function projectReadPublic(value) {
  if (value?.status === 'error') return value
  if (value?.primary?.kind === 'official_story_collection') return value
  if (value?.primary) {
    const hasMore = Boolean(value.page?.has_more)
    const nextLine = Number(value.primary.selection?.line_end) + 1
    const existing = value.page?.continuation
    const shortLocator = existing && typeof existing === 'object'
      ? existing
      : value.primary.stage_code && value.primary.story_part
        ? { stage_code: value.primary.stage_code, story_part: value.primary.story_part }
        : { title: value.primary.title }
    const dataVersion = String(existing?.data_version ?? value.presentation?.data_version
      ?? value.data_version ?? '')
    return { ...value, page: {
      returned_lines: Number(value.page?.returned_lines || value.primary.lines?.length || 0),
      has_more: hasMore,
      continuation: hasMore && Number.isInteger(nextLine) && nextLine > 0
        ? { ...shortLocator, mode: 'document', line: nextLine,
            ...(dataVersion ? { data_version: dataVersion } : {}) }
        : null,
    } }
  }
  if (value.stream) {
    const lines = value.content?.format === 'lines' ? (value.content.lines || []).map(publicLine) : []
    const stream = value.stream
    const isActivity = stream.mode === 'activity'
    const requestedLocator = value.normalized_request?.locator || {}
    const continuationLocator = requestedLocator.document_uid
      ? { document_uid: requestedLocator.document_uid }
      : { [isActivity ? 'activity_name' : 'collection_name']: stream.name }
    const continuation = value.page?.has_more && Number.isInteger(stream.next_position)
      ? { ...continuationLocator,
          mode: stream.mode, position: stream.next_position,
          ...(stream.content_types?.length ? { content_types: stream.content_types } : {}),
          data_version: String(value.data_version || '') }
      : null
    const title = isActivity
      ? `${stream.name} / 活动剧情连续阅读` : `${stream.name} / 终末地任务连续阅读`
    return {
      primary: { game: stream.game, title, kind: 'official_story_collection',
        selection: { mode: stream.mode, line_start: stream.position_start,
          line_end: stream.position_end, truncated: Boolean(value.selection?.truncated) },
        lines,
        ordering: stream.order_kind,
        ordering_note: stream.order_note,
        ...(value.content?.format === 'plain_text' ? { text: value.content.text || '' } : {}),
        citation: '连续阅读结果按每行的 document_title 与 line 引用' },
      page: { returned_lines: Number(value.page?.returned || lines.length),
        has_more: Boolean(value.page?.has_more), continuation },
    }
  }
  const title = naturalDocumentTitle(value.document || {})
  const stageCode = publicStoryStageCode(value.document?.story_code)
  const storyPart = publicStoryPart(value.document?.part_type)
  const hasStoryStage = documentGame(value.document || {}) === 'arknights' && stageCode
    && Boolean(storyPart)
  const recordSegment = operatorRecordSegment(value.document || {})
  const hasOperatorRecord = Boolean(recordSegment) && value.document?.document_kind === 'story'
    && value.document?.part_type === 'body'
  const material = publicCharacterMaterial(value.document || {})
  const continuationLocator = hasStoryStage
    ? { stage_code: stageCode, story_part: storyPart }
    : hasOperatorRecord
      ? { character_name: value.document.character_name,
          record_name: value.document.story_name, segment: recordSegment }
      : material
        ? { character_name: value.document.character_name, material,
            game: documentGame(value.document || {}) }
        : { title }
  const lines = value.content?.format === 'lines' ? (value.content.lines || []).map(publicLine) : []
  const kind = value.document?.document_type === 'story' ? 'official_story'
    : value.document?.document_type === 'knowledge' && value.document?.document_kind === 'wiki'
      ? 'wiki_curated' : 'local_document'
  return {
    primary: { game: documentGame(value.document || {}), title,
      ...(hasStoryStage ? { stage_code: stageCode, story_part: storyPart } : {}),
      ...(hasOperatorRecord ? { character_name: value.document.character_name,
        record_name: value.document.story_name, segment: recordSegment } : {}),
      ...(material ? { character_name: value.document.character_name, material } : {}),
      kind,
      selection: { mode: value.selection?.mode, line_start: value.selection?.line_start,
        line_end: value.selection?.line_end,
        ...(value.selection?.wiki_section ? { section: value.selection.wiki_section } : {}),
        truncated: Boolean(value.selection?.truncated) },
      lines,
      ...(value.content?.format === 'plain_text' ? { text: value.content.text || '' } : {}),
      citation: value.selection?.wiki_section ? `《${title}》Wiki·${value.selection.wiki_section}`
        : `《${title}》第 ${value.selection?.line_start === value.selection?.line_end
          ? value.selection?.line_start : `${value.selection?.line_start}-${value.selection?.line_end}`} 行` },
    page: { returned_lines: Number(value.page?.returned || lines.length),
      has_more: Boolean(value.page?.has_more),
      continuation: value.page?.has_more
        ? { ...continuationLocator, mode: 'document', line: Number(value.selection?.line_end) + 1,
            data_version: String(value.data_version || '') }
        : null },
  }
}

/**
 * 将契约响应渲染为模型可见文本（output.render 用）。
 * @param {object} _args
 * @param {object} value executeRead 的返回值
 */
export function renderRead(_args, value) {
  if (value?.status === 'error') {
    return [{
      type: 'text',
      text: `[corpus_read:error] code=${value.error.code} retryable=${value.error.retryable}\n${value.error.message}`,
    }]
  }
  const projected = projectReadPublic(value)
  const parts = []
  if (projected.primary) {
    const primary = projected.primary
    parts.push(`# ${primary.title}`)
    if (primary.kind === 'official_story_collection') {
      parts.push(`连续位置：第 ${primary.selection.line_start}-${primary.selection.line_end} 行`)
      if (primary.ordering_note) parts.push(`顺序说明：${primary.ordering_note}`)
      let activeTitle = ''
      let activeUid = ''
      let groupStart = null
      let groupEnd = null
      const finishGroup = () => {
        if (activeTitle && groupStart != null) {
          parts.push(`引用：《${activeTitle}》${activeUid ? `（document_uid=${activeUid}）` : ''}第 ${groupStart === groupEnd ? groupStart : `${groupStart}-${groupEnd}`} 行`)
        }
      }
      for (const line of primary.lines || []) {
        if (line.document_title !== activeTitle || line.document_uid !== activeUid) {
          finishGroup()
          activeTitle = line.document_title || primary.title
          activeUid = line.document_uid || ''
          groupStart = line.line
          groupEnd = line.line
          parts.push(`## ${activeTitle}${activeUid ? `（document_uid=${activeUid}）` : ''}`)
        } else {
          groupEnd = line.line
        }
        parts.push(readableRenderedLine({ line_number: line.line, line_type: line.line_type,
          speaker_raw: line.speaker, text: line.text }))
      }
      finishGroup()
      if (primary.text) parts.push(primary.text)
      if (projected.page.has_more && projected.page.continuation) {
        parts.push(`继续阅读：corpus_read(${JSON.stringify(projected.page.continuation)})`)
      }
      return [{ type: 'text', text: parts.join('\n') }]
    }
    if (primary.kind === 'wiki_curated') {
      parts.push('引文状态：Wiki 为整理性资料；其中引号内容未核验为当前资料包官方原文，逐字引用前请回查原文。')
    }
    if (primary.selection?.section) parts.push(`字段：${primary.selection.section}`)
    else parts.push(`范围：第 ${primary.selection.line_start}-${primary.selection.line_end} 行`)
    for (const line of primary.lines || []) {
      parts.push(readableRenderedLine({ line_number: line.line, line_type: line.line_type,
        speaker_raw: line.speaker, text: line.text }))
    }
    if (primary.text) parts.push(primary.text)
    parts.push(`引用：${primary.citation}`)
    if (projected.page.has_more && projected.page.continuation) {
      const next = projected.page.continuation
      parts.push(`继续阅读《${primary.title}》，从第 ${next.line} 行开始。`)
      if (next.stage_code && next.story_part) {
        parts.push(`调用：corpus_read(${JSON.stringify({ stage_code: next.stage_code,
          story_part: next.story_part, mode: 'document', line: next.line,
          data_version: next.data_version })})`)
      } else if (next.record_name || next.material) {
        parts.push(`调用：corpus_read(${JSON.stringify(next)})`)
      } else {
        parts.push(`调用：corpus_read(${JSON.stringify({ title: String(next.title || ''),
          mode: 'document', line: next.line, data_version: next.data_version })})`)
      }
    }
    return [{ type: 'text', text: parts.join('\n') }]
  }
  return [{ type: 'text', text: '[corpus_read:error] 无法投影读取结果' }]
}
