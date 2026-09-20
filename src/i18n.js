/** Official localizations: exact source identities, independent of reading coverage. */
import { createHash } from 'node:crypto'
import { assertCorpusVersion, corpusVersionSnapshot, documentGame, documentUid,
  naturalDocumentTitle } from './store.js'
import { LOCALIZATION_LANGUAGES } from './localization-format.js'

const PACK = 'endfield_official_game'
const states = new WeakMap()
const fields = ['text', 'name', 'title', 'actor', 'hint']
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const normalize = (value) => String(value)
  .replace(/<image[^>]*>[\s\S]*?<\/image>|<image\s*=\s*[^>]*>/giu, '')
  .replace(/<br\s*\/?>/giu, '\n')
  .replace(/<@[^>]*>|<\/>|<\/?(?:color|b|i|size)(?:=[^>]*)?>/giu, '')
  .normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
const aliases = { 'zh-cn': 'CN', 'zh-hans': 'CN', en: 'EN', ja: 'JP', ko: 'KR',
  'zh-tw': 'TC', 'zh-hant': 'TC', 'es-mx': 'MX', 'pt-br': 'BR', fr: 'FR', de: 'DE',
  ru: 'RU', it: 'IT', id: 'ID', th: 'TH', vi: 'VN' }
for (const [locale, code] of Object.entries({ 'en-us': 'EN', 'ja-jp': 'JP', 'ko-kr': 'KR',
  'fr-fr': 'FR', 'de-de': 'DE', 'ru-ru': 'RU', 'it-it': 'IT', 'id-id': 'ID', 'th-th': 'TH', 'vi-vn': 'VN' })) {
  aliases[locale] = code
}
const fault = (code, message) => Object.assign(new Error(message), { code,
  retryable: code === 'PACKAGE_VERSION_MISMATCH' })

export const I18N_DESCRIPTION = [
  '查询终末地官方本地化文本，返回其他语言原文；不生成翻译。',
  '已有资料时优先使用完整 title 或 document_uid，可加 line；只有原句/名称时用 query 反查，source_language 默认 CN。',
  'languages 指定目标语言（EN 英语、JP 日语、KR 韩语、TC 繁中等）。query 默认 exact，片段用 match_mode=literal。',
  '相同原文可能对应多个不同译文，按来源消歧。角色档案按整条记录、档案库按整篇内容块对齐，中文行号不是目标语言行号。',
  '默认不显示内部文本 ID；仅核验时 include_ids=true，后续可用 text_ids 精确查询。续页原样提交 page.continuation。',
].join(' ')

export const I18N_PARAMETERS = {
  type: 'object', additionalProperties: false, required: ['languages'],
  properties: {
    game: { type: 'string', enum: ['endfield'], description: '当前支持终末地官方资料' },
    query: { type: 'string', description: '名称或原句；仅有片段时使用 match_mode=literal' },
    title: { type: 'string', description: '已有检索结果的完整篇章标题，与 query/document_uid/text_ids 四选一' },
    document_uid: { type: 'string', description: '已有检索结果的文档定位，替代 title' },
    line: { type: 'integer', description: '已有中文结果中的行号，只用于定位对应文本/记录' },
    text_ids: { type: 'array', items: { type: 'string' }, description: '显式请求 ID 后可用于精确复查；普通查询不需要' },
    source_language: { type: 'string', description: '原句的语言，默认 CN；也接受 en/ja/ko/zh-CN 等标准代码' },
    languages: { type: 'array', items: { type: 'string' }, description: '1–4 种目标语言：CN/EN/JP/KR/TC/MX/BR/FR/DE/RU/IT/ID/TH/VN' },
    match_mode: { type: 'string', enum: ['exact', 'literal'], description: '原句精确匹配或字面量片段搜索，默认 exact' },
    include_ids: { type: 'boolean', description: '默认 false；仅调试、核验或精确复查时返回内部文本 ID 与来源字段' },
    max_matches: { type: 'integer', description: '每页候选数，默认 5，最多 20' },
    max_chars: { type: 'integer', description: '每页原文和译文的字符预算，默认 16000，范围 1000–48000' },
    data_version: { type: 'string', description: '绑定已有结果的资料版本，避免混用版本' },
    after: { type: 'object', additionalProperties: false,
      required: ['data_version', 'request_hash', 'position', 'text_offset'],
      properties: { data_version: { type: 'string' }, request_hash: { type: 'string' },
        position: { type: 'integer' }, text_offset: { type: 'integer' } },
      description: '仅原样提交工具返回的续页位置；长记录会明确分块返回' },
  },
}

export const I18N_OUTPUT_SCHEMA = {
  type: 'object', properties: {
    status: { type: 'string', enum: ['ok', 'not_found', 'unmapped_source', 'unavailable'] },
    game: { type: 'string' }, data_version: { type: 'string' }, game_version: { type: 'string' },
    source_language: { type: 'string' }, languages: { type: 'array', items: { type: 'string' } },
    matches: { type: 'array', items: { type: 'object', properties: {
      source: { type: 'object' }, translations: { type: 'object' },
      references: { type: 'array', items: { type: 'object' } }, reference_count: { type: 'integer' },
      text_id: { type: 'string' }, source_fields: { type: 'array', items: { type: 'object' } },
    } } },
    page: { type: 'object' }, message: { type: 'string' }, note: { type: 'string' },
  },
}

function language(value) {
  if (typeof value !== 'string') throw fault('INVALID_REQUEST', '语言代码必须是字符串')
  const result = aliases[value.toLowerCase()] || value.toUpperCase()
  if (!LOCALIZATION_LANGUAGES.includes(result)) throw fault('INVALID_REQUEST', `不支持的语言：${value}`)
  return result
}

function integer(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw fault('INVALID_REQUEST', `${name} 必须在 ${minimum}–${maximum} 之间`)
  }
  return value
}

export function normalizeI18nRequest(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some((key) => !Object.hasOwn(I18N_PARAMETERS.properties, key))) {
    throw fault('INVALID_REQUEST', 'corpus_i18n 包含不支持的参数')
  }
  if (args.game !== undefined && args.game !== 'endfield') throw fault('INVALID_REQUEST', '当前仅支持终末地官方本地化')
  const locators = ['query', 'title', 'document_uid', 'text_ids'].filter((key) => args[key] !== undefined)
  if (locators.length !== 1) throw fault('INVALID_REQUEST', 'query/title/document_uid/text_ids 必须且只能提供一种')
  const locator = locators[0]
  const request = { game: 'endfield' }
  if (locator === 'text_ids') {
    if (!Array.isArray(args.text_ids) || !args.text_ids.length || args.text_ids.length > 20
        || args.text_ids.some((id) => typeof id !== 'string' || !/^-?[0-9]{1,20}$/u.test(id))) {
      throw fault('INVALID_REQUEST', 'text_ids 必须是 1–20 个十进制字符串 ID，不能使用数字')
    }
    request.text_ids = [...new Set(args.text_ids)]
  } else {
    if (typeof args[locator] !== 'string' || !args[locator].trim() || args[locator].length > 12000) {
      throw fault('INVALID_REQUEST', `${locator} 必须是非空字符串，最多 12000 字符`)
    }
    request[locator] = args[locator].trim()
    if (locator === 'query' && !normalize(request.query)) throw fault('INVALID_REQUEST', 'query 必须包含可查询的文本')
    if (locator === 'document_uid' && !/^doc_[A-Za-z0-9_-]{16}$/u.test(request.document_uid)) {
      throw fault('INVALID_REQUEST', 'document_uid 必须来自检索结果')
    }
  }
  if (args.line !== undefined) {
    if (!['title', 'document_uid'].includes(locator)) throw fault('INVALID_REQUEST', 'line 只能与文档定位一起使用')
    request.line = integer(args.line, 1, 100_000_000, 'line')
  }
  if (!Array.isArray(args.languages) || args.languages.length < 1 || args.languages.length > 4) {
    throw fault('INVALID_REQUEST', 'languages 必须包含 1–4 种目标语言')
  }
  request.source_language = language(args.source_language ?? 'CN')
  request.languages = [...new Set(args.languages.map(language))]
  request.match_mode = args.match_mode ?? 'exact'
  if (!['exact', 'literal'].includes(request.match_mode)) throw fault('INVALID_REQUEST', 'match_mode 只支持 exact/literal')
  if (args.include_ids !== undefined && typeof args.include_ids !== 'boolean') throw fault('INVALID_REQUEST', 'include_ids 必须是布尔值')
  request.include_ids = args.include_ids ?? false
  request.max_matches = integer(args.max_matches ?? 5, 1, 20, 'max_matches')
  request.max_chars = integer(args.max_chars ?? 16000, 1000, 48000, 'max_chars')
  if (args.data_version !== undefined) {
    if (typeof args.data_version !== 'string' || !/^[0-9a-f]{64}$/u.test(args.data_version)) throw fault('INVALID_REQUEST', 'data_version 必须是有效的 SHA-256')
    request.data_version = args.data_version
  }
  if (args.after !== undefined) {
    const after = args.after
    if (!after || typeof after !== 'object' || Array.isArray(after)
        || Object.keys(after).sort().join() !== 'data_version,position,request_hash,text_offset'
        || !/^[0-9a-f]{64}$/u.test(after.data_version) || !/^[0-9a-f]{64}$/u.test(after.request_hash)) {
      throw fault('INVALID_REQUEST', 'after 必须原样使用工具返回的续页位置')
    }
    request.after = { ...after,
      position: integer(after.position, 0, 1_000_000, 'after.position'),
      text_offset: integer(after.text_offset, 0, 10_000_000, 'after.text_offset') }
  }
  return request
}

function checkpoint(store, snapshot, signal) {
  assertCorpusVersion(store, snapshot)
  if (signal?.aborted) throw fault('CANCELLED', '本地化查询已取消')
}

function stateFor(store) {
  let state = states.get(store)
  if (!state || state.generation !== store._generation || state.version !== store.dataVersion) {
    state = { generation: store._generation, version: store.dataVersion,
      catalog: null, languages: new Map(), pending: new Map() }
    states.set(store, state)
  }
  return state
}

async function loadRows(store, snapshot, asset) {
  try {
    const bytes = await store._readPacked(PACK, asset.path, store.releaseId, asset)
    assertCorpusVersion(store, snapshot)
    return bytes.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch (error) {
    assertCorpusVersion(store, snapshot)
    throw fault('INDEX_CORRUPT', `本地化附件读取失败：${error.message}`)
  }
}

async function catalogFor(store, state, meta, snapshot) {
  if (!state.catalog) {
    state.catalog = (async () => {
      const rows = await loadRows(store, snapshot, meta.catalog)
      const byId = new Map(), byDocument = new Map()
      for (const entry of rows) {
        if (typeof entry.text_id !== 'string' || !/^-?[0-9]{1,20}$/u.test(entry.text_id)
            || byId.has(entry.text_id) || !Array.isArray(entry.references) || !entry.references.length
            || !Array.isArray(entry.sources)) throw fault('INDEX_CORRUPT', '本地化目录记录无效')
        byId.set(entry.text_id, entry)
        for (const ref of entry.references) {
          const doc = store.documents.get(ref.document_id)?.document
          if (!doc || documentGame(doc) !== 'endfield'
              || store.documents.get(ref.document_id)?.packId !== PACK
              || !Number.isSafeInteger(ref.line_start) || !Number.isSafeInteger(ref.line_end)
              || ref.line_start < 1 || ref.line_end < ref.line_start || ref.line_end > doc.line_count
              || (ref.source_order !== undefined && (!Number.isSafeInteger(ref.source_order) || ref.source_order < 1))
              || !fields.includes(ref.field) || !['text', 'record', 'document'].includes(ref.alignment)) {
            throw fault('INDEX_CORRUPT', '本地化目录指向无效的官方来源')
          }
          const ids = byDocument.get(ref.document_id) || new Set()
          ids.add(entry.text_id)
          byDocument.set(ref.document_id, ids)
        }
      }
      if (rows.length !== meta.text_count) throw fault('INDEX_CORRUPT', '本地化目录数量不一致')
      return { rows, byId, byDocument }
    })().catch((error) => { state.catalog = null; throw error })
  }
  return state.catalog
}

async function dictionaryFor(store, state, meta, catalog, lang, snapshot) {
  if (!meta.languages[lang]) return null
  if (state.languages.has(lang)) {
    const cached = state.languages.get(lang)
    state.languages.delete(lang); state.languages.set(lang, cached)
    return cached
  }
  if (!state.pending.has(lang)) {
    const promise = (async () => {
      const rows = await loadRows(store, snapshot, meta.languages[lang])
      const byId = new Map(), exact = new Map(), search = []
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string'
            || typeof row[1] !== 'string' || !catalog.byId.has(row[0]) || byId.has(row[0])) {
          throw fault('INDEX_CORRUPT', '本地化字典记录无效')
        }
        const [id, text] = row
        byId.set(id, text)
        const key = normalize(text)
        if (key) {
          const ids = exact.get(key) || []; ids.push(id); exact.set(key, ids)
          search.push([id, key])
        }
      }
      if (byId.size !== meta.text_count) throw fault('INDEX_CORRUPT', '本地化字典数量不一致')
      assertCorpusVersion(store, snapshot)
      const value = { byId, exact, search }
      state.languages.set(lang, value)
      while (state.languages.size > 4) state.languages.delete(state.languages.keys().next().value)
      return value
    })().finally(() => state.pending.delete(lang))
    state.pending.set(lang, promise)
  }
  return state.pending.get(lang)
}

function publicReference(store, ref) {
  const doc = store.documents.get(ref.document_id).document
  const title = naturalDocumentTitle(doc)
  return { title, document_uid: documentUid(doc.document_id), line_start: ref.line_start,
    line_end: ref.line_end, field: ref.field, alignment: ref.alignment,
    citation: `《${title}》中文定位第 ${ref.line_start}${ref.line_end === ref.line_start ? '' : `–${ref.line_end}`} 行` }
}

function chunk(text, offset, width, available) {
  if (!available) return { status: 'unavailable' }
  if (!text?.trim()) return { status: 'missing_localization' }
  const chars = [...text]
  const start = Math.min(offset, chars.length), end = Math.min(offset + width, chars.length)
  return { status: 'available', text: chars.slice(start, end).join(''),
    ...(offset || end < chars.length ? { character_start: start, character_end: end,
      total_characters: chars.length, truncated: end < chars.length } : {}) }
}

export async function executeI18n(store, raw, { signal, enabledGames = ['endfield'] } = {}) {
  const request = normalizeI18nRequest(raw)
  if (!enabledGames.includes('endfield')) throw fault('INVALID_REQUEST', '当前未启用终末地资料')
  await store.ready()
  const snapshot = corpusVersionSnapshot(store)
  checkpoint(store, snapshot, signal)
  if ((request.data_version && request.data_version !== snapshot.dataVersion)
      || (request.after && request.after.data_version !== snapshot.dataVersion)) {
    throw fault('PACKAGE_VERSION_MISMATCH', '本地化查询所属资料版本已变化，请重新查询')
  }
  const { after, data_version: _version, ...identity } = request
  const requestHash = sha256(JSON.stringify(identity))
  if (after && after.request_hash !== requestHash) throw fault('INVALID_REQUEST', '续页参数与原查询不一致')
  const base = { game: 'endfield', data_version: snapshot.dataVersion,
    source_language: request.source_language, languages: request.languages }
  const pack = store.packs.get(PACK), meta = pack?.localization
  if (!meta) return { ...base, status: 'unavailable', matches: [],
    message: '当前终末地官方资料包未包含多语言附件，请安装带本地化数据的版本。',
    page: { has_more: false, continuation: null } }
  base.game_version = meta.game_version
  const state = stateFor(store)
  const catalog = await catalogFor(store, state, meta, snapshot)
  checkpoint(store, snapshot, signal)
  const requestedLanguages = [...new Set([request.source_language, ...request.languages])]
  const dictionaries = new Map(await Promise.all(requestedLanguages.map(async (lang) =>
    [lang, await dictionaryFor(store, state, meta, catalog, lang, snapshot)])))
  checkpoint(store, snapshot, signal)
  const source = dictionaries.get(request.source_language)
  if (!source) return { ...base, status: 'unavailable', matches: [],
    message: '当前附件没有查询所用的来源语言。', page: { has_more: false, continuation: null } }
  let ids = [], documentId = null
  if (request.query) {
    const query = normalize(request.query)
    if (request.match_mode === 'exact') ids = source.exact.get(query) || []
    else {
      for (let i = 0; i < source.search.length; i += 1) {
        if ((i & 2047) === 0) { await new Promise((resolve) => setImmediate(resolve)); checkpoint(store, snapshot, signal) }
        const [id, text] = source.search[i]
        if (text.includes(query)) ids.push(id)
      }
    }
  } else if (request.text_ids) ids = request.text_ids.filter((id) => catalog.byId.has(id))
  else {
    const found = request.document_uid ? await store.getDocumentByUid(request.document_uid)
      : await store.getDocumentByTitle(request.title)
    checkpoint(store, snapshot, signal)
    if (!found) throw fault('DOCUMENT_NOT_FOUND', '找不到指定资料，请使用检索结果中的完整定位')
    if (found.packId !== PACK) throw fault('INVALID_REQUEST', '该资料不是终末地官方原文')
    documentId = found.record.document.document_id
    if (request.line && request.line > found.record.lines.length) throw fault('LINE_RANGE_INVALID', '中文定位行号超出文档范围')
    ids = [...(catalog.byDocument.get(documentId) || [])].filter((id) => {
      const text = source.byId.get(id) || ''
      // An absent source translation still has a valid identity. Omit only
      // image/markup-only blocks, retaining explicit missing_localization.
      return (!text.trim() || normalize(text)) && catalog.byId.get(id).references.some((ref) => ref.document_id === documentId
        && (!request.line || (ref.line_start <= request.line && ref.line_end >= request.line)))
    })
    const sourceOrder = (entry) => {
      const ref = entry.references.find((item) => item.document_id === documentId
        && (!request.line || (item.line_start <= request.line && item.line_end >= request.line)))
      const fieldOrder = ['text', 'title', 'name', 'actor', 'hint'].indexOf(ref.field)
      if (ref.alignment !== 'document') return [ref.line_start, fieldOrder, '']
      // Archive Markdown does not have exact line alignment. Preserve the order
      // of the original rich-content/radio blocks rather than sorting int64 IDs.
      return [ref.source_order ?? 0, 0, '']
    }
    ids.sort((left, right) => {
      const a = sourceOrder(catalog.byId.get(left)), b = sourceOrder(catalog.byId.get(right))
      return a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2], 'en', { numeric: true })
    })
  }
  // Preserve source/catalog order for document reads and deterministic query pages.
  let position = after?.position ?? 0, offset = after?.text_offset ?? 0
  if (position > ids.length || (position === ids.length && offset)) throw fault('INVALID_REQUEST', '续页位置超出查询结果')
  const matches = []
  let budget = request.max_chars
  while (position < ids.length && matches.length < request.max_matches && budget >= 100) {
    checkpoint(store, snapshot, signal)
    const id = ids[position], entry = catalog.byId.get(id)
    const width = Math.floor(budget / (request.languages.length + 1))
    const sourceValue = chunk(source.byId.get(id), offset, width, true)
    const translations = Object.fromEntries(request.languages.map((lang) => [lang,
      chunk(dictionaries.get(lang)?.byId.get(id), offset, width, Boolean(dictionaries.get(lang)))]))
    const values = [sourceValue, ...Object.values(translations)]
    const maximumLength = Math.max(...requestedLanguages.map((lang) => [...(dictionaries.get(lang)?.byId.get(id) || '')].length))
    if (offset && offset >= maximumLength) throw fault('INVALID_REQUEST', '记录续页偏移超出正文')
    const refs = entry.references.filter((ref) => !documentId || ref.document_id === documentId)
    matches.push({ source: { language: request.source_language, ...sourceValue }, translations,
      references: refs.slice(0, 8).map((ref) => publicReference(store, ref)), reference_count: refs.length,
      ...(request.include_ids ? { text_id: id, source_fields: entry.sources.slice(0, 8),
        source_field_count: entry.sources.length } : {}) })
    budget -= values.reduce((sum, value) => sum + [...(value.text || '')].length, 0)
    if (values.some((value) => value.truncated)) { offset += width; break }
    position += 1; offset = 0
  }
  checkpoint(store, snapshot, signal)
  const hasMore = position < ids.length
  return { ...base, status: ids.length ? 'ok' : documentId ? 'unmapped_source' : 'not_found',
    matches, total_matches: ids.length,
    ...(request.text_ids ? { missing_text_ids: request.text_ids.filter((id) => !catalog.byId.has(id)) } : {}),
    note: '返回官方本地化原文；引用请注明语言。中文行号仅用于定位，record/document 对齐不表示跨语言逐行对应。',
    page: { has_more: hasMore, continuation: hasMore ? { ...identity,
      data_version: snapshot.dataVersion, after: { data_version: snapshot.dataVersion,
        request_hash: requestHash, position, text_offset: offset } } : null } }
}

export function renderI18n(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}
