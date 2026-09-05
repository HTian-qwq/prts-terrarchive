/**
 * CorpusStore：对 prts-browser-corpus-release-v1 资料包的只读访问层。
 *
 * 包结构（复用自 prts.chat/agent 的浏览器资料包，格式不变）：
 *   releases/current.json                          → { release_id, data_version }
 *   releases/<release_id>/<pack>/pack-manifest.json → { pack_id, shards: [...] }
 *   releases/<release_id>/<pack>/shards/NNN.jsonl.gz → 每行一个文档记录
 *     { document: DocumentSummary, lines: LineRecord[], local_integrity, search_index_id }
 *
 * 新包初始化时读取轻量文档目录，旧包回退为扫描正文分片；两者都会建立
 * 文档、引用、自然标题与关卡代号索引。正文分片按 LRU 缓存，避免重复解压。
 */
import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { CORPUS_RESOURCE_LIMITS, readCurrentReleasePointer,
  validateLocalRelease } from './installer.js'

const gunzipAsync = promisify(gunzip)

const TRIGRAM_MAGIC = Buffer.from([80, 82, 84, 83, 84, 71, 49, 0])
const NGRAM_MAGIC = Buffer.from([80, 82, 84, 83, 78, 71, 50, 0])
const TRIGRAM_HEADER_BYTES = TRIGRAM_MAGIC.length + 4
const PACK_ORDER = Object.freeze(['official_game', 'endfield_official_game', 'reviewed_wiki', 'terra_journey',
  'endfield_reviewed_knowledge', 'entities', 'references'])
const MAX_SHARD_CACHE_BYTES = 96 * 1024 * 1024
const MAX_SEARCH_CACHE_BYTES = 64 * 1024 * 1024
const MAX_SHORT_LITERAL_CACHE_CANDIDATES = 65_536
const MAX_SHORT_LITERAL_SCAN_QUEUE = 16
const SHORT_LITERAL_SCAN_WORKERS = 4
const END_FIELD_NARRATIVE_CONTENT_TYPES = new Set([
  'dialogue', 'cutscene', 'radio', 'remote_comm', 'black_screen',
  'environment_talk', 'sns_topic', 'sns_chat', 'narration',
])
const END_FIELD_CONTENT_TYPE_ORDER = Object.freeze([
  'dialogue', 'cutscene', 'black_screen', 'radio', 'remote_comm',
  'environment_talk', 'sns_topic', 'sns_chat', 'narration',
])
export const DOCUMENT_ORDERING_VERSION = 2

function shortLiteralScanError(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable })
}

function assertShortLiteralScanActive({ signal, deadline = Infinity, generation, store }) {
  if (signal?.aborted) {
    throw shortLiteralScanError('CANCELLED', '短字面量候选扫描已取消')
  }
  if (Number.isFinite(deadline) && Date.now() >= deadline) {
    throw shortLiteralScanError('TIMEOUT', '短字面量候选扫描超时', true)
  }
  if (generation !== undefined && generation !== store._generation) {
    throw shortLiteralScanError('PACKAGE_VERSION_MISMATCH',
      '资料版本在短字面量候选扫描期间发生变化，请重试', true)
  }
}

/** 等待排队扫描时也及时响应调用方取消与绝对截止时间。 */
function waitForShortLiteralScan(operation, runtime) {
  assertShortLiteralScanActive({ ...runtime, store: runtime.store })
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      runtime.signal?.removeEventListener?.('abort', onAbort)
      callback(value)
    }
    const onAbort = () => finish(reject,
      shortLiteralScanError('CANCELLED', '短字面量候选扫描已取消'))
    runtime.signal?.addEventListener?.('abort', onAbort, { once: true })
    if (Number.isFinite(runtime.deadline)) {
      timer = setTimeout(() => finish(reject,
        shortLiteralScanError('TIMEOUT', '短字面量候选扫描排队超时', true)),
      Math.max(1, runtime.deadline - Date.now()))
      timer.unref?.()
    }
    operation.then((value) => finish(resolve, value), (error) => finish(reject, error))
  })
}

function packOrder(left, right) {
  const leftIndex = PACK_ORDER.indexOf(left.name)
  const rightIndex = PACK_ORDER.indexOf(right.name)
  const leftRank = leftIndex < 0 ? PACK_ORDER.length : leftIndex
  const rightRank = rightIndex < 0 ? PACK_ORDER.length : rightIndex
  return leftRank - rightRank || left.name.localeCompare(right.name, 'en')
}

/**
 * Keep each game's internal source order, but interleave their documents in
 * the global scan order.  Literal search paginates by this ordinal; without
 * interleaving, a frequent term can fill every scan page from the first pack
 * before the second game's candidates are even visited.
 */
function federatedOrder(documents, sourceOrder) {
  const byGame = new Map([['arknights', []], ['endfield', []]])
  const other = []
  for (const documentId of sourceOrder) {
    const item = documents.get(documentId)
    const game = item ? documentGame(item.document) : ''
    const target = byGame.get(game)
    if (target) target.push(documentId)
    else other.push(documentId)
  }
  if (!byGame.get('arknights').length || !byGame.get('endfield').length) return sourceOrder
  const ordered = []
  const maximum = Math.max(byGame.get('arknights').length, byGame.get('endfield').length)
  for (let index = 0; index < maximum; index += 1) {
    for (const game of ['arknights', 'endfield']) {
      const documentId = byGame.get(game)[index]
      if (documentId) ordered.push(documentId)
    }
  }
  return ordered.concat(other)
}

function readVarint(bytes, state, limit) {
  let value = 0
  let shift = 0
  while (state.offset < limit && shift <= 49) {
    const byte = bytes[state.offset++]
    value += (byte & 0x7f) * (2 ** shift)
    if (!(byte & 0x80)) return value
    shift += 7
  }
  throw new Error('CorpusStore: invalid trigram varint')
}

/** 与编译期 SQLite BINARY（UTF-8 字节序）保持一致。 */
function compareNgramKeys(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'))
}

/** 查询浏览器资料包的 PRTSTG1 / PRTSNG2 二进制倒排分片。 */
function lookupNgramIndex(bytes, target) {
  if (bytes.length < TRIGRAM_HEADER_BYTES
      || (!bytes.subarray(0, 8).equals(TRIGRAM_MAGIC)
        && !bytes.subarray(0, 8).equals(NGRAM_MAGIC))) {
    throw new Error('CorpusStore: invalid ngram index magic')
  }
  const count = bytes.readUInt32LE(8)
  const payloadStart = TRIGRAM_HEADER_BYTES + (count + 1) * 4
  if (payloadStart > bytes.length) throw new Error('CorpusStore: invalid trigram offset table')
  const offsetAt = (index) => bytes.readUInt32LE(TRIGRAM_HEADER_BYTES + index * 4)
  const recordAt = (index) => {
    const start = payloadStart + offsetAt(index)
    const end = payloadStart + offsetAt(index + 1)
    const state = { offset: start }
    const textLength = readVarint(bytes, state, end)
    const keyBytes = bytes.subarray(state.offset, state.offset + textLength)
    const trigram = keyBytes.toString('utf8')
    state.offset += textLength
    const postingCount = readVarint(bytes, state, end)
    const indexes = []
    let current = 0
    for (let item = 0; item < postingCount; item += 1) {
      current += readVarint(bytes, state, end)
      indexes.push(current)
    }
    if (state.offset !== end) throw new Error('CorpusStore: malformed trigram record')
    return { trigram, keyBytes, indexes }
  }
  const targetBytes = Buffer.from(target, 'utf8')
  let low = 0
  let high = count - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const record = recordAt(middle)
    if (record.trigram === target) return record.indexes
    if (Buffer.compare(record.keyBytes, targetBytes) < 0) low = middle + 1
    else high = middle - 1
  }
  return []
}

function searchIndexRange(descriptor = {}) {
  return {
    first: String(descriptor.first_ngram ?? descriptor.first_trigram ?? ''),
    last: String(descriptor.last_ngram ?? descriptor.last_trigram ?? ''),
  }
}

function naturalCompare(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''), 'zh-CN', {
    numeric: true, sensitivity: 'base',
  })
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * 面向模型与 UI 的短篇章标识。它由 canonical document_id 确定性派生，
 * 不携带路径信息；96 bit 摘要在装载时做碰撞检测。
 */
export function documentUid(documentId) {
  const value = String(documentId ?? '')
  if (!value) return ''
  return `doc_${createHash('sha256').update(`prts-document\0${value}`, 'utf8')
    .digest('base64url').slice(0, 16)}`
}

/** 模型/界面使用的自然语言资料定位；各资料类型都带上可辨认的标题与类型。 */
export function documentGame(document = {}) {
  const explicit = String(document.game || '').trim().toLocaleLowerCase()
  if (explicit === 'arknights' || explicit === 'endfield') return explicit
  const identity = `${document.document_id || ''} ${document.source_ref_prefix || ''}`.toLocaleLowerCase()
  return identity.includes('endfield:') ? 'endfield' : 'arknights'
}

/** 将玩家可见的明日方舟关卡代号归一化为索引键（如 gt－3 → GT-3）。 */
export function normalizeStoryStageCode(value) {
  return String(value ?? '').normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212]/gu, '-')
    .replace(/\s+/gu, '')
    .toLocaleUpperCase('en-US')
}

/** 可安全放进模型工具参数的公开关卡代号；非法资料值不进入短定位索引。 */
export function publicStoryStageCode(value, { relaxedInput = false } = {}) {
  const raw = String(value ?? '').normalize('NFKC')
  if (!relaxedInput && /[\s\p{Cc}\p{Cf}]/u.test(raw)) return ''
  const normalized = normalizeStoryStageCode(value)
  return normalized.length <= 32 && /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/u.test(normalized)
    ? normalized : ''
}

/** 清除元数据中可改写工具渲染结构的控制/换行/双向字符。 */
export function publicMetadataText(value, maximum = 256) {
  return String(value ?? '').normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/gu, ' ').trim().slice(0, maximum)
}

function storyStageKey(stageCode, storyPart) {
  return `${normalizeStoryStageCode(stageCode)}\0${String(storyPart ?? '').trim().toLocaleLowerCase('en-US')}`
}

/** 将资料内部的 part_type 映射成 Agent 使用的玩家语义。 */
export function publicStoryPart(value) {
  const part = String(value ?? '').trim().toLocaleLowerCase('en-US')
  if (part === 'before' || part === 'after') return part
  if (part === 'story' || part === 'interlude' || part === 'body') return 'story'
  return ''
}

/** GameData 干员密录 source_story_id 末段即页面段号（目前为 1/2）。 */
export function operatorRecordSegment(document = {}) {
  if (documentGame(document) !== 'arknights' || document.document_category !== 'memory') return null
  const match = /_([1-9][0-9]*)$/u.exec(String(document.source_story_id || document.document_id || ''))
  return match ? Number(match[1]) : null
}

const CHARACTER_MATERIALS = Object.freeze({
  '干员档案': 'profile', '角色档案': 'profile',
  '模组文案': 'module',
  '干员语音': 'voice', '角色语音': 'voice',
  '时装文案': 'skin',
  '招聘合同': 'recruitment',
  '潜能与信物': 'potential',
})

export function publicCharacterMaterial(document = {}) {
  if (document.document_type !== 'character') return ''
  return CHARACTER_MATERIALS[String(document.document_category || '')] || ''
}

function normalizedLookupText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

function operatorRecordKey(characterName, recordName, segment = '') {
  return `${normalizedLookupText(characterName)}\0${normalizedLookupText(recordName)}\0${segment}`
}

function characterMaterialKey(game, characterName, material) {
  return `${String(game || '')}\0${normalizedLookupText(characterName)}\0${String(material || '')}`
}

function naturalDocumentTitleBase(document = {}, { includeOperatorRecordSegment = true } = {}) {
  const displayTitle = publicMetadataText(document.display_title)
  if (documentGame(document) === 'endfield' && document.game) return displayTitle
  if (document.document_type === 'entity') {
    return displayTitle ? `${displayTitle} / 实体资料` : ''
  }
  if (document.document_type === 'character') return displayTitle
  if (document.document_type === 'knowledge') {
    if (document.document_kind === 'terra_journey') return `${displayTitle} / 大地巡旅`
    if (document.document_kind === 'wiki') {
      const explicitRole = String(document.wiki_role || '')
      if (explicitRole === 'story') return `${displayTitle} / 活动 Wiki`
      if (explicitRole === 'character_activity') {
        const sequence = Number.isInteger(document.sequence_index) ? ` · 第 ${document.sequence_index} 篇` : ''
        return `${displayTitle} / 角色活动 Wiki${sequence}`
      }
      if (explicitRole === 'other') return `${displayTitle} / 审校资料`
      const path = String(document.path || '')
      if (path.startsWith('stories/')) return `${displayTitle} / 活动 Wiki`
      if (path.startsWith('char_v3/prompt_')) {
        const sequence = Number.isInteger(document.sequence_index) ? ` · 第 ${document.sequence_index} 篇` : ''
        return `${displayTitle} / 角色活动 Wiki${sequence}`
      }
      if (path.startsWith('char_v3/extended_')) return `${displayTitle} / 角色补充 Wiki`
      return `${displayTitle} / 角色 Wiki`
    }
    return displayTitle
  }
  if (document.document_type === 'reference') {
    const labels = { activity_timelines: '活动时间线', char_alias: '角色别名表',
      terra_timeline: '泰拉年表' }
    return labels[displayTitle] || displayTitle
  }
  if (document.document_type !== 'story') return displayTitle
  const variation = /_variation0*(\d+)(?:\.[^./]+)?$/iu.exec(
    String(document.source_story_id || document.document_id || ''),
  )
  const identity = [...new Set([document.activity_name, document.story_code, document.story_name]
    .map((item) => publicMetadataText(item)).filter(Boolean))]
  if (!identity.length) {
    const labels = { rogue: '集成战略文本', system: '游戏系统文本', guide: '游戏教程文本' }
    const label = labels[String(document.document_category || '')] || '游戏内原文'
    const collection = publicMetadataText(
      String(document.collection_id || '').split(':').at(-1)?.split('/').at(-1), 128)
    const sequence = Number.isInteger(document.sequence_index) ? `第 ${document.sequence_index} 篇` : ''
    const fallback = [label, collection && !['other', 'obt'].includes(collection) ? collection : '', sequence,
      publicMetadataText(document.part_label, 128)].filter(Boolean).join(' · ')
    return fallback || displayTitle
  }
  const memoryPrefix = document.document_category === 'memory' && document.character_name
    ? [publicMetadataText(document.character_name), '干员密录'] : []
  const memorySegment = includeOperatorRecordSegment && memoryPrefix.length
    ? operatorRecordSegment(document) : null
  const sequenceSuffix = document.document_category === 'activity' && !document.story_code
      && Number.isInteger(document.sequence_index) ? [`第 ${document.sequence_index} 篇`] : []
  return [...memoryPrefix, ...identity, ...(memorySegment ? [`第 ${memorySegment} 段`] : []),
    publicMetadataText(document.part_label, 128), ...sequenceSuffix,
    ...(variation ? [`分支${Number(variation[1])}`] : [])]
    .map((item) => String(item || '').trim()).filter(Boolean).join(' · ')
    || displayTitle
}

/**
 * v2 联合语料使用带游戏前缀的自然标题消除跨游戏同名歧义。旧 v1
 * 文档没有 game 字段，继续保留原题面；加载器同时为显式 game 文档建立
 * 无前缀兼容索引，因此历史数据与新联合包可以并存。
 */
export function naturalDocumentTitle(document = {}) {
  const title = publicMetadataText(naturalDocumentTitleBase(document), 480)
  if (!title || !document.game) return title
  const label = documentGame(document) === 'endfield' ? '终末地' : '明日方舟'
  return publicMetadataText(title.startsWith(`${label} · `) ? title : `${label} · ${title}`, 512)
}

function legacyOperatorRecordTitle(document = {}) {
  if (!operatorRecordSegment(document)) return ''
  const title = publicMetadataText(naturalDocumentTitleBase(document,
    { includeOperatorRecordSegment: false }), 480)
  if (!title || !document.game) return title
  const label = documentGame(document) === 'endfield' ? '终末地' : '明日方舟'
  return publicMetadataText(title.startsWith(`${label} · `) ? title : `${label} · ${title}`, 512)
}

/** 行完整性规则：sha256(全部行文本以 \n 连接) === local_integrity.sha256。 */
export function computeLinesIntegrity(lines) {
  return sha256(lines.map((line) => line.text).join('\n'))
}

/**
 * 收集会破坏「原始字节即匹配文本」假设的字符：单个字符经 NFKC + 小写后
 * 发生变化（全角标点、罗马数字、上标、兼容表意文字等）。实测本语料中
 * 此类字符只有数十个（几乎全是全角标点），但出现在约七成以上的行里；
 * 短字面量预筛据此构造无损 needle 集合（见 findDocumentsByShortLiteral）。
 * 展开式口径与 search.js matchesText 的匹配侧一致：NFKC 归一化后小写。
 */
function collectUnstableChars(text, stableChars, unstableChars) {
  if (typeof text !== 'string' || !text) return
  for (let offset = 0; offset < text.length;) {
    const code = text.codePointAt(offset)
    const size = code > 0xffff ? 2 : 1
    const character = text.slice(offset, offset + size)
    offset += size
    if (stableChars.has(character)) continue
    const expansion = character.normalize('NFKC').toLowerCase()
    if (expansion === character) stableChars.add(character)
    else unstableChars.set(character, expansion)
  }
}

/**
 * 枚举查询的规范等价形式：NFD 全分解，以及把相邻字符逐步规范复合回去的
 * 中间形态（例如谚文音节 ↔ 字母序列）。短字面量预筛把这些形式一并作为
 * 字节 needle，保证语料以分解形态存储时不会漏检。
 */
function canonicalVariants(query, limit = 32) {
  const variants = new Set([query])
  const decomposed = query.normalize('NFD')
  if (decomposed !== query) variants.add(decomposed)
  const agenda = [decomposed]
  while (agenda.length && variants.size < limit) {
    const current = agenda.pop()
    const chars = [...current]
    for (let index = 0; index + 1 < chars.length && variants.size < limit; index += 1) {
      const pair = chars[index] + chars[index + 1]
      const composed = pair.normalize('NFC')
      if (composed.length !== 1 || composed === pair) continue
      const next = chars.slice(0, index).concat([composed], chars.slice(index + 2)).join('')
      if (variants.has(next)) continue
      variants.add(next)
      agenda.push(next)
    }
  }
  return variants
}

export class CorpusStore {
  /**
   * @param {{ releasesDir: string, cacheShards?: number, ensure?: () => Promise<void>, cursorSecretPath?: string }} options
   * `ensure` 是调用方可选的初始化前置步骤；本插件的 Host 和工具挂载不使用它下载资料。
   */
  constructor({ releasesDir, cacheShards = 24, searchCacheShards = 32, ensure, cursorSecretPath } = {}) {
    if (!releasesDir) throw new Error('CorpusStore: releasesDir is required')
    this.releasesDir = releasesDir
    this.cacheShards = cacheShards
    // 倒排分片缓存独立于正文分片缓存：trigram 查询会在一个请求内轮询
    // 全部 search-index 分片，容量太小会导致同批分片被反复重解压。
    this.searchCacheShards = searchCacheShards
    this.ensure = ensure
    this.cursorSecretPath = cursorSecretPath || join(dirname(releasesDir), 'cursor-secret.bin')
    /** @type {Promise<void> | null} */
    this._ready = null
    this._generation = 0
    this._loaded = false
    this.releaseId = null
    this.dataVersion = null
    /** @type {Map<string, { packId: string, shardPath: string, index: number }>} */
    this.documents = new Map()
    /** @type {string[]} 全局稳定 document_ordinal → document_id。 */
    this.documentOrder = []
    /** @type {Map<string, string>} source_ref_prefix → document_id */
    this.prefixIndex = new Map()
    /** @type {Map<string, string>} 短 document_uid → canonical document_id */
    this.uidIndex = new Map()
    /** @type {Map<string, string[]>} display_title → document_id[]（保留同名歧义） */
    this.titleIndex = new Map()
    /** @type {Map<string, string[]>} 自然语言完整篇章标题 → document_id[] */
    this.naturalTitleIndex = new Map()
    /** @type {Map<string, string[]>} 明日方舟关卡代号\0行动前后/纯剧情 → document_id[] */
    this.storyStageIndex = new Map()
    /** @type {Map<string, string[]>} 明日方舟关卡代号 → 全部剧情 document_id[] */
    this.storyStageCodeIndex = new Map()
    /** @type {Map<string, string[]>} 角色\0密录名\0段号 → 正文 document_id[] */
    this.operatorRecordIndex = new Map()
    /** @type {Map<string, string[]>} 游戏\0角色\0资料类型 → document_id[] */
    this.characterMaterialIndex = new Map()
    /** @type {Map<string, string>} path → document_id（首个命中优先） */
    this.pathIndex = new Map()
    /** @type {Map<string, string>} source_story_id → document_id（首个命中优先） */
    this.sourceStoryIndex = new Map()
    /** @type {Map<string, object>} packId → pack-manifest */
    this.packs = new Map()
    /** @type {Map<string, string>} packId\0search_index_id -> document_id */
    this.searchIndexDocuments = new Map()
    /** @type {Map<string, object[]>} shardKey → 已解析文档记录数组（LRU） */
    this._shardCache = new Map()
    this._shardCacheSizes = new Map()
    this._shardCacheBytes = 0
    /** @type {Map<string, Buffer>} search-index 分片 LRU */
    this._searchCache = new Map()
    this._searchCacheSizes = new Map()
    this._searchCacheBytes = 0
    /** @type {Map<string, string[]>} 1—2 字无损分片预筛结果（LRU） */
    this._shortLiteralCache = new Map()
    this._shortLiteralCacheCandidateCount = 0
    // 不同短词都需要遍历全部正文分片。跨请求串行，单次扫描内部再使用固定
    // worker 上限，避免并发请求把 libuv 线程池和明文 Buffer 成倍放大。
    this._shortLiteralScanTail = Promise.resolve()
    this._shortLiteralScanPending = 0
    /** @type {Promise<Buffer> | null} 持久游标签名密钥。 */
    this._cursorSecret = null
  }

  /** 初始化（幂等）：ensure → 验证 release → 读轻量目录（旧包扫描正文）建索引。 */
  ready() {
    if (!this._ready) {
      const generation = this._generation
      const operation = (this.ensure ? Promise.resolve(this.ensure()) : Promise.resolve())
        .then(() => this._init(generation))
        .catch((error) => {
          if (generation !== this._generation) return false
          throw error
        })
        .then(async (committed) => {
          if (!committed) await this.ready()
        })
      let tracked
      tracked = operation.catch((error) => {
        if (this._ready === tracked) this._ready = null
        throw error
      })
      this._ready = tracked
    }
    return this._ready
  }

  /** 初始化是否已提交到当前 generation。 */
  get loaded() {
    return this._loaded
  }

  /**
   * 丢弃全部已解析状态（版本切换/重下载后调用）；下次 ready() 按新的
   * current.json 重建索引。进行中的旧 ready() 只构建局部快照，generation
   * 不匹配时不会提交，并会等待当前 generation 的初始化。
   */
  reset() {
    this._generation += 1
    this._ready = null
    this._loaded = false
    this.releaseId = null
    this.dataVersion = null
    this.documents.clear()
    this.documentOrder = []
    this.prefixIndex.clear()
    this.uidIndex.clear()
    this.titleIndex.clear()
    this.naturalTitleIndex.clear()
    this.storyStageIndex.clear()
    this.storyStageCodeIndex.clear()
    this.operatorRecordIndex.clear()
    this.characterMaterialIndex.clear()
    this.pathIndex.clear()
    this.sourceStoryIndex.clear()
    this.packs.clear()
    this.searchIndexDocuments.clear()
    this._shardCache.clear()
    this._shardCacheSizes.clear()
    this._shardCacheBytes = 0
    this._searchCache.clear()
    this._searchCacheSizes.clear()
    this._searchCacheBytes = 0
    this._shortLiteralCache.clear()
    this._shortLiteralCacheCandidateCount = 0
    this.unstableChars = null
    this._timelineRows = null
    this._aliasGroups = null
  }

  async _init(generation) {
    const current = await readCurrentReleasePointer(this.releasesDir)
    const releaseId = current.release_id
    // Store 是 Host 权限下的持久文件入口。每次装载都先验证 release id、声明的
    // 全部 pack、资源路径/尺寸/哈希与符号链接，再读取任何压缩内容。
    const validated = await validateLocalRelease(this.releasesDir, releaseId,
      { verifyHashes: true, details: true })
    const { manifest: releaseManifest, packManifests, releaseDir } = validated
    if (current.data_version != null && current.data_version !== releaseManifest.data_version) {
      throw new Error('CorpusStore: current.json data_version does not match release-manifest')
    }
    const next = {
      releaseId,
      dataVersion: releaseManifest.data_version,
      documents: new Map(),
      documentOrder: [],
      prefixIndex: new Map(),
      uidIndex: new Map(),
      titleIndex: new Map(),
      naturalTitleIndex: new Map(),
      storyStageIndex: new Map(),
      storyStageCodeIndex: new Map(),
      operatorRecordIndex: new Map(),
      characterMaterialIndex: new Map(),
      pathIndex: new Map(),
      sourceStoryIndex: new Map(),
      packs: new Map(),
      searchIndexDocuments: new Map(),
      unstableChars: new Map(),
    }
    const stableChars = new Set()

    const entries = releaseManifest.packs.map((descriptor) => ({
      name: descriptor.pack_id,
      manifestPath: descriptor.manifest_path,
    })).sort(packOrder)
    for (const entry of entries) {
      const trustedManifest = packManifests.get(entry.name)
      if (!trustedManifest) throw new Error(`CorpusStore: missing validated pack ${entry.name}`)
      // v3 起 pack-manifest 不再携带顶层 pack_id，以 release 清单目录名为准。
      const packId = entry.name
      const manifest = { ...trustedManifest, pack_id: packId }
      next.packs.set(packId, manifest)
      const catalog = manifest.document_catalog
      const sources = catalog ? [catalog] : manifest.shards
      const bodyShards = new Map(manifest.shards.map((shard) => [shard.path, shard]))
      const seenLocations = new Set()
      for (const shard of sources) {
        const records = this._decodeShard(await this._readPacked(
          packId, shard.path, releaseId, shard,
        ))
        if (catalog && records.length !== manifest.document_count) {
          throw new Error(`CorpusStore: document catalog count mismatch: ${packId}`)
        }
        // 分片间让出事件循环：初始化虽在后台，也不应长时间阻塞宿主进程。
        await new Promise((resolve) => { setImmediate(resolve) })
        records.forEach((record, index) => {
          const shardPath = catalog ? String(record.shard_path || '') : shard.path
          const recordIndex = catalog ? record.record_index : index
          const bodyShard = bodyShards.get(shardPath)
          if (!bodyShard || !Number.isInteger(recordIndex) || recordIndex < 0
              || recordIndex >= bodyShard.document_count
              || !record.document || typeof record.document !== 'object'
              || !Array.isArray(record.speakers)) {
            throw new Error(`CorpusStore: invalid document catalog row: ${packId}#${index}`)
          }
          const locationKey = `${shardPath}\0${recordIndex}`
          if (seenLocations.has(locationKey)) {
            throw new Error(`CorpusStore: duplicate document catalog location: ${packId}#${index}`)
          }
          seenLocations.add(locationKey)
          const { document_id: documentId, source_ref_prefix: prefix } = record.document
          const ordinal = next.documentOrder.length
          next.documentOrder.push(documentId)
          next.documents.set(documentId, {
            packId: manifest.pack_id, shardPath, index: recordIndex,
            document: record.document, speakers: record.speakers ?? [],
            searchIndexId: record.search_index_id ?? null, ordinal,
          })
          if (prefix) next.prefixIndex.set(prefix, documentId)
          const uid = documentUid(documentId)
          const existingUid = next.uidIndex.get(uid)
          if (existingUid && existingUid !== documentId) {
            throw new Error(`CorpusStore: document_uid collision: ${uid}`)
          }
          next.uidIndex.set(uid, documentId)
          const title = record.document.display_title
          if (title) {
            const ids = next.titleIndex.get(title) ?? []
            ids.push(documentId)
            next.titleIndex.set(title, ids)
          }
          const naturalTitle = naturalDocumentTitle(record.document)
          if (naturalTitle) {
            const ids = next.naturalTitleIndex.get(naturalTitle) ?? []
            ids.push(documentId)
            next.naturalTitleIndex.set(naturalTitle, ids)
            if (record.document.game) {
              const legacyTitle = naturalDocumentTitleBase(record.document)
              if (legacyTitle && legacyTitle !== naturalTitle) {
                const legacyIds = next.naturalTitleIndex.get(legacyTitle) ?? []
                legacyIds.push(documentId)
                next.naturalTitleIndex.set(legacyTitle, legacyIds)
              }
            }
          }
          const legacyMemoryTitle = legacyOperatorRecordTitle(record.document)
          if (legacyMemoryTitle && legacyMemoryTitle !== naturalTitle) {
            const aliases = [legacyMemoryTitle]
            if (record.document.game) aliases.push(naturalDocumentTitleBase(record.document,
              { includeOperatorRecordSegment: false }))
            for (const alias of aliases) {
              if (!alias) continue
              const ids = next.naturalTitleIndex.get(alias) ?? []
              ids.push(documentId)
              next.naturalTitleIndex.set(alias, ids)
            }
          }
          const stageCode = publicStoryStageCode(record.document.story_code)
          const storyPart = publicStoryPart(record.document.part_type)
          if (documentGame(record.document) === 'arknights' && record.document.document_type === 'story'
              && record.document.document_kind === 'story' && stageCode && storyPart) {
            const key = storyStageKey(stageCode, storyPart)
            const ids = next.storyStageIndex.get(key) ?? []
            ids.push(documentId)
            next.storyStageIndex.set(key, ids)
            const codeIds = next.storyStageCodeIndex.get(stageCode) ?? []
            codeIds.push(documentId)
            next.storyStageCodeIndex.set(stageCode, codeIds)
          }
          const recordSegment = operatorRecordSegment(record.document)
          if (recordSegment && record.document.document_kind === 'story'
              && record.document.part_type === 'body') {
            const key = operatorRecordKey(record.document.character_name,
              record.document.story_name, recordSegment)
            const ids = next.operatorRecordIndex.get(key) ?? []
            ids.push(documentId)
            next.operatorRecordIndex.set(key, ids)
            const allKey = operatorRecordKey(record.document.character_name,
              record.document.story_name)
            const allIds = next.operatorRecordIndex.get(allKey) ?? []
            allIds.push(documentId)
            next.operatorRecordIndex.set(allKey, allIds)
          }
          const material = publicCharacterMaterial(record.document)
          if (material) {
            const key = characterMaterialKey(documentGame(record.document),
              record.document.character_name, material)
            const ids = next.characterMaterialIndex.get(key) ?? []
            ids.push(documentId)
            next.characterMaterialIndex.set(key, ids)
          }
          const path = record.document.path
          if (path && !next.pathIndex.has(path)) next.pathIndex.set(path, documentId)
          const sourceStoryId = record.document.source_story_id
          if (sourceStoryId && !next.sourceStoryIndex.has(sourceStoryId)) {
            next.sourceStoryIndex.set(sourceStoryId, documentId)
          }
          if (record.search_index_id) {
            next.searchIndexDocuments.set(`${manifest.pack_id}\0${record.search_index_id}`, documentId)
          }
          for (const line of record.lines ?? []) {
            collectUnstableChars(line?.text, stableChars, next.unstableChars)
          }
        })
      }
      if (seenLocations.size !== manifest.document_count) {
        throw new Error(`CorpusStore: document directory count mismatch: ${packId}`)
      }
    }
    if (next.documents.size === 0) {
      throw new Error(`CorpusStore: no documents found under ${releaseDir}`)
    }
    next.documentOrder = federatedOrder(next.documents, next.documentOrder)
    next.documentOrder.forEach((documentId, ordinal) => {
      next.documents.get(documentId).ordinal = ordinal
    })
    if (generation !== this._generation) return false
    this.releaseId = next.releaseId
    this.dataVersion = next.dataVersion
    this.documents = next.documents
    this.documentOrder = next.documentOrder
    this.prefixIndex = next.prefixIndex
    this.uidIndex = next.uidIndex
    this.titleIndex = next.titleIndex
    this.naturalTitleIndex = next.naturalTitleIndex
    this.storyStageIndex = next.storyStageIndex
    this.storyStageCodeIndex = next.storyStageCodeIndex
    this.operatorRecordIndex = next.operatorRecordIndex
    this.characterMaterialIndex = next.characterMaterialIndex
    this.pathIndex = next.pathIndex
    this.sourceStoryIndex = next.sourceStoryIndex
    this.packs = next.packs
    this.searchIndexDocuments = next.searchIndexDocuments
    this.unstableChars = next.unstableChars
    this._shardCache.clear()
    this._shardCacheSizes.clear()
    this._shardCacheBytes = 0
    this._searchCache.clear()
    this._searchCacheSizes.clear()
    this._searchCacheBytes = 0
    this._shortLiteralCache.clear()
    this._shortLiteralCacheCandidateCount = 0
    this._loaded = true
    return true
  }

  /** 解析一个已验证解压尺寸的 JSONL 分片；昂贵扫描可传入协作式检查点。 */
  _decodeShard(buffer, checkpoint = null) {
    const text = buffer.toString('utf8')
    const records = []
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      if ((index & 63) === 0) checkpoint?.()
      const line = lines[index]
      if (line) records.push(JSON.parse(line))
    }
    return records
  }

  /**
   * 读取一个正文分片并在 zlib 分配期间强制限制输出长度。明文旁路缓存不在
   * release 清单中，不能绕过已校验的 gzip 资源。
   */
  async _readPacked(packId, shardPath, releaseId = this.releaseId, descriptor = null) {
    const baseDir = join(this.releasesDir, releaseId, packId)
    descriptor ??= this.packs.get(packId)?.shards?.find((item) => item.path === shardPath) ?? null
    return this._gunzipBounded(join(baseDir, shardPath), descriptor)
  }

  async _gunzipBounded(path, descriptor) {
    const expectedSize = descriptor?.uncompressed_size
    const expectedCompressedSize = descriptor?.compressed_size
    const expectedHash = descriptor?.sha256
    if (!Number.isInteger(expectedSize) || expectedSize < 1
        || expectedSize > CORPUS_RESOURCE_LIMITS.maxAssetUncompressedBytes
        || !Number.isInteger(expectedCompressedSize) || expectedCompressedSize < 1
        || expectedCompressedSize > CORPUS_RESOURCE_LIMITS.maxAssetCompressedBytes
        || !/^[0-9a-f]{64}$/u.test(String(expectedHash ?? ''))) {
      throw new Error('CorpusStore: invalid declared packed-asset metadata')
    }
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== expectedCompressedSize) {
      throw new Error('CorpusStore: packed asset changed after release validation')
    }
    const compressed = await readFile(path)
    if (compressed.length !== expectedCompressedSize
        || createHash('sha256').update(compressed).digest('hex') !== expectedHash) {
      throw new Error('CorpusStore: packed asset checksum changed after release validation')
    }
    const bytes = await gunzipAsync(compressed, { maxOutputLength: expectedSize })
    if (bytes.length !== expectedSize) {
      throw new Error('CorpusStore: packed asset decompressed-size mismatch')
    }
    return bytes
  }

  _rememberShard(key, records, byteLength) {
    const previous = this._shardCacheSizes.get(key) ?? 0
    this._shardCache.delete(key)
    this._shardCacheSizes.delete(key)
    this._shardCacheBytes -= previous
    this._shardCache.set(key, records)
    this._shardCacheSizes.set(key, byteLength)
    this._shardCacheBytes += byteLength
    while (this._shardCache.size > this.cacheShards
        || this._shardCacheBytes > MAX_SHARD_CACHE_BYTES) {
      const oldest = this._shardCache.keys().next().value
      this._shardCache.delete(oldest)
      this._shardCacheBytes -= this._shardCacheSizes.get(oldest) ?? 0
      this._shardCacheSizes.delete(oldest)
    }
  }

  _rememberSearchShard(key, bytes) {
    const previous = this._searchCacheSizes.get(key) ?? 0
    this._searchCache.delete(key)
    this._searchCacheSizes.delete(key)
    this._searchCacheBytes -= previous
    this._searchCache.set(key, bytes)
    this._searchCacheSizes.set(key, bytes.length)
    this._searchCacheBytes += bytes.length
    while (this._searchCache.size > this.searchCacheShards
        || this._searchCacheBytes > MAX_SEARCH_CACHE_BYTES) {
      const oldest = this._searchCache.keys().next().value
      this._searchCache.delete(oldest)
      this._searchCacheBytes -= this._searchCacheSizes.get(oldest) ?? 0
      this._searchCacheSizes.delete(oldest)
    }
  }

  /** 读取（并缓存）某包的一个分片，返回文档记录数组。 */
  async _loadShard(packId, shardPath) {
    const key = `${packId}\0${shardPath}`
    const cached = this._shardCache.get(key)
    if (cached) {
      this._shardCache.delete(key)
      this._shardCache.set(key, cached) // 触碰 LRU
      return cached
    }
    const descriptor = this.packs.get(packId)?.shards?.find((item) => item.path === shardPath)
    const plain = await this._readPacked(packId, shardPath, this.releaseId, descriptor)
    const records = this._decodeShard(plain)
    this._rememberShard(key, records, plain.length)
    return records
  }

  async _loadSearchShard(packId, shardPath) {
    const key = `${packId}\0${shardPath}`
    const cached = this._searchCache.get(key)
    if (cached) {
      this._searchCache.delete(key)
      this._searchCache.set(key, cached)
      return cached
    }
    const descriptor = this.packs.get(packId)?.search_index?.shards
      ?.find((item) => item.path === shardPath)
    const bytes = await this._gunzipBounded(join(
      this.releasesDir, this.releaseId, packId, shardPath,
    ), descriptor)
    this._rememberSearchShard(key, bytes)
    return bytes
  }

  /**
   * 按 document_id 取完整文档记录。
   * @returns {Promise<{ record: object, packId: string } | null>}
   */
  async getDocument(documentId) {
    const location = this.documents.get(documentId)
    if (!location) return null
    const records = await this._loadShard(location.packId, location.shardPath)
    const record = records[location.index]
    if (!record || record.document.document_id !== documentId) return null
    return { record, packId: location.packId }
  }

  /** source_ref_prefix → document_id。 */
  getDocumentIdByPrefix(prefix) {
    return this.prefixIndex.get(prefix) ?? null
  }

  /** 当前不可变资料版本中的稳定全局文档序号（0-based）。 */
  documentOrdinal(documentId) {
    return this.documents.get(String(documentId ?? ''))?.ordinal ?? null
  }

  /** 将候选文档恢复成全局稳定顺序；未知 ID 被忽略。 */
  orderedDocumentIds(documentIds = null) {
    if (documentIds == null) return [...this.documentOrder]
    const requested = new Set(documentIds)
    return this.documentOrder.filter((documentId) => requested.has(documentId))
  }

  /** 短 document_uid → canonical document_id。 */
  getDocumentIdByUid(uid) {
    return this.uidIndex.get(String(uid ?? '').trim()) ?? null
  }

  /** 按短 document_uid 取完整文档记录。 */
  async getDocumentByUid(uid) {
    const documentId = this.getDocumentIdByUid(uid)
    return documentId ? this.getDocument(documentId) : null
  }

  /**
   * 获取跨重启持久的游标签名密钥。密钥位于 releases 的父级配置目录，
   * 不写入不可变发布包；并发首次创建通过 wx 保证只有一个胜者。
   */
  getOrCreateCursorSecret() {
    if (this._cursorSecret) return this._cursorSecret
    const path = this.cursorSecretPath
    this._cursorSecret = (async () => {
      try {
        const existing = await readFile(path)
        if (existing.length === 32) return existing
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const created = randomBytes(32)
      try {
        await writeFile(path, created, { flag: 'wx', mode: 0o600 })
        return created
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        const existing = await readFile(path)
        if (existing.length !== 32) throw new Error('CorpusStore: invalid cursor secret')
        return existing
      }
    })().catch((error) => {
      this._cursorSecret = null
      throw error
    })
    return this._cursorSecret
  }

  /** 按自然语言完整篇章标题或 display_title 取文档；短标题同名时要求改用完整标题。 */
  async getDocumentByTitle(title) {
    const normalized = String(title ?? '').trim()
    const naturalIds = this.naturalTitleIndex.get(normalized) ?? []
    const documentIds = naturalIds.length ? naturalIds : this.titleIndex.get(normalized) ?? []
    if (documentIds.length > 1) {
      // 实体来源中可能同时存在通用概念记录与后续补充的同名专页，两者的
      // model title 也完全相同，要求模型“换完整标题”无法消歧。此时稳定选择
      // 行数最多的完整投影；并列时按 document_id 排序保证跨进程一致。
      const locations = documentIds.map((documentId) => this.documents.get(documentId)).filter(Boolean)
      if (locations.length === documentIds.length
          && locations.every((item) => item.document.document_type === 'entity')) {
        const preferred = [...locations].sort((left, right) =>
          Number(right.document.line_count || 0) - Number(left.document.line_count || 0)
          || String(left.document.document_id).localeCompare(String(right.document.document_id)))[0]
        return this.getDocument(preferred.document.document_id)
      }
      throw Object.assign(new Error(
        `标题“${normalized}”对应 ${documentIds.length} 篇资料；请使用 corpus_search 返回的带资料类型完整标题`,
      ), { code: 'DOCUMENT_AMBIGUOUS' })
    }
    return documentIds.length ? this.getDocument(documentIds[0]) : null
  }

  /** 搜索结果若无法仅靠自然标题/合集名稳定回读，就公开短 document_uid。 */
  requiresDocumentUid(documentId) {
    const location = this.documents.get(String(documentId ?? ''))
    const document = location?.document
    if (!document) return false
    const title = naturalDocumentTitle(document)
    if ((this.naturalTitleIndex.get(title) ?? []).length > 1) return true
    const game = documentGame(document)
    const streamName = normalizedLookupText(game === 'endfield'
      ? document.collection_name : document.activity_name)
    if (!streamName || document.document_type !== 'story') return false
    const collections = new Set()
    for (const item of this.documents.values()) {
      const candidate = item.document
      if (documentGame(candidate) !== game || candidate.document_type !== 'story') continue
      const candidateName = normalizedLookupText(game === 'endfield'
        ? candidate.collection_name : candidate.activity_name)
      if (candidateName !== streamName) continue
      collections.add(String(candidate.collection_id || candidate.activity_id || ''))
      if (collections.size > 1) return true
    }
    return false
  }

  /** 按玩家可见关卡代号定位；省略部分时仅在全局唯一的情况下成功。 */
  async getDocumentByStoryStage(stageCode, storyPart = '') {
    const normalizedCode = publicStoryStageCode(stageCode)
    const partSupplied = storyPart !== '' && storyPart != null
    const normalizedPart = partSupplied ? publicStoryPart(storyPart) : ''
    if (!normalizedCode || (partSupplied && !normalizedPart)) return null
    const documentIds = normalizedPart
      ? this.storyStageIndex.get(storyStageKey(normalizedCode, normalizedPart)) ?? []
      : this.storyStageCodeIndex.get(normalizedCode) ?? []
    if (documentIds.length > 1) {
      const choices = documentIds.map((documentId) => {
        const document = this.documents.get(documentId)?.document || {}
        const part = publicStoryPart(document.part_type)
        const label = { before: '行动前', after: '行动后', story: '剧情' }[part] || part
        return `${label}《${naturalDocumentTitle(document)}》`
      }).filter(Boolean)
      const requestedLabel = normalizedPart
        ? ` 的${{ before: '行动前', after: '行动后', story: '剧情' }[normalizedPart]}` : ''
      throw Object.assign(new Error(
        `关卡 ${normalizedCode}${requestedLabel}对应 ${documentIds.length} 篇资料：${choices.join('、')}；请明确 story_part`,
      ), { code: 'DOCUMENT_AMBIGUOUS' })
    }
    return documentIds.length ? this.getDocument(documentIds[0]) : null
  }

  /** 该文档能否用公开 stage_code + story_part 无歧义地再次定位。 */
  hasUniqueStoryStage(documentId) {
    const document = this.documents.get(String(documentId ?? ''))?.document
    if (!document || documentGame(document) !== 'arknights') return false
    const stageCode = publicStoryStageCode(document.story_code)
    const storyPart = publicStoryPart(document.part_type)
    if (!stageCode || !storyPart) return false
    const ids = this.storyStageIndex.get(storyStageKey(stageCode, storyPart)) ?? []
    return ids.length === 1 && ids[0] === document.document_id
  }

  /** 按角色、密录名和可选段号读取密录正文。 */
  async getOperatorRecord(characterName, recordName, segment = null) {
    const normalizedSegment = segment == null ? '' : Number(segment)
    if (!normalizedLookupText(characterName) || !normalizedLookupText(recordName)
        || (normalizedSegment !== '' && (!Number.isInteger(normalizedSegment) || normalizedSegment < 1))) return null
    const ids = this.operatorRecordIndex.get(operatorRecordKey(
      characterName, recordName, normalizedSegment,
    )) ?? []
    if (ids.length > 1) {
      const segments = [...new Set(ids.map((id) => operatorRecordSegment(
        this.documents.get(id)?.document || {},
      )).filter(Boolean))].sort((a, b) => a - b)
      throw Object.assign(new Error(
        `干员“${normalizedLookupText(characterName)}”的密录“${normalizedLookupText(recordName)}”`
          + `包含 ${ids.length} 段正文${segments.length ? `（${segments.join('、')}）` : ''}；请提供 segment`,
      ), { code: 'DOCUMENT_AMBIGUOUS' })
    }
    return ids.length ? this.getDocument(ids[0]) : null
  }

  hasUniqueOperatorRecord(documentId) {
    const document = this.documents.get(String(documentId ?? ''))?.document
    const segment = operatorRecordSegment(document || {})
    if (!segment || document?.document_kind !== 'story' || document?.part_type !== 'body') return false
    const ids = this.operatorRecordIndex.get(operatorRecordKey(
      document.character_name, document.story_name, segment,
    )) ?? []
    return ids.length === 1 && ids[0] === document.document_id
  }

  /** 按玩家可见角色名与资料类别定位两款游戏的官方角色资料。 */
  async getCharacterMaterial(characterName, material, games = ['arknights', 'endfield']) {
    const ids = games.flatMap((game) => this.characterMaterialIndex.get(characterMaterialKey(
      game, characterName, material,
    )) ?? [])
    if (ids.length > 1) {
      const documents = ids.map((id) => this.documents.get(id)?.document).filter(Boolean)
      const hashes = new Set(documents.map((document) => document.text_sha256).filter(Boolean))
      if (hashes.size === 1 && documents.length === ids.length) {
        return this.getDocument([...ids].sort((a, b) => a.localeCompare(b, 'en'))[0])
      }
      const titles = documents.map((document) => naturalDocumentTitle(document))
      throw Object.assign(new Error(
        `角色“${normalizedLookupText(characterName)}”的 ${material} 资料对应 ${ids.length} 篇不同内容：${titles.join('、')}`,
      ), { code: 'DOCUMENT_AMBIGUOUS' })
    }
    return ids.length ? this.getDocument(ids[0]) : null
  }

  hasUniqueCharacterMaterial(documentId) {
    const document = this.documents.get(String(documentId ?? ''))?.document
    const material = publicCharacterMaterial(document || {})
    if (!material) return false
    const ids = this.characterMaterialIndex.get(characterMaterialKey(
      documentGame(document), document.character_name, material,
    )) ?? []
    if (ids.length === 1) return ids[0] === document.document_id
    // 终末地的男女管理员会投影成同一个展示角色；资料正文完全相同时，
    // getCharacterMaterial 会稳定选 document_id 最小者，续页也应继续使用
    // 同一个自然定位器，而不是降级成同样会歧义的重复展示标题。
    const documents = ids.map((id) => this.documents.get(id)?.document).filter(Boolean)
    const hashes = new Set(documents.map((item) => item.text_sha256).filter(Boolean))
    const preferred = [...ids].sort((left, right) => left.localeCompare(right, 'en'))[0]
    return documents.length === ids.length && hashes.size === 1 && preferred === document.document_id
  }

  /** 同名实体投影只让内容最完整的一份进入模型搜索结果。 */
  isPreferredNaturalDocument(documentId) {
    const location = this.documents.get(String(documentId || ''))
    if (!location || location.document.document_type !== 'entity') return true
    const title = naturalDocumentTitle(location.document)
    const ids = this.naturalTitleIndex.get(title) ?? []
    if (ids.length <= 1) return true
    const entityLocations = ids.map((id) => this.documents.get(id)).filter(Boolean)
    if (entityLocations.length !== ids.length
        || entityLocations.some((item) => item.document.document_type !== 'entity')) return true
    entityLocations.sort((left, right) =>
      Number(right.document.line_count || 0) - Number(left.document.line_count || 0)
      || String(left.document.document_id).localeCompare(String(right.document.document_id)))
    return entityLocations[0].document.document_id === location.document.document_id
  }

  /** 按资料内路径（如 activity_timelines.jsonl、char_alias.txt、stories/x.txt）取文档记录。 */
  async getDocumentByPath(path) {
    const documentId = this.pathIndex.get(String(path ?? ''))
    return documentId ? this.getDocument(documentId) : null
  }

  /** 按 GameData 原始 source_story_id 取文档记录（synopsis → 可读全文的桥）。 */
  async getDocumentBySourceStoryId(sourceStoryId) {
    const documentId = this.sourceStoryIndex.get(String(sourceStoryId ?? ''))
    return documentId ? this.getDocument(documentId) : null
  }

  /** 全部 pack 都声明三元倒排时，才可把其结果当作全库无损候选。 */
  get hasTrigramIndex() {
    return this.supportsNgramSize(3)
  }

  /**
   * 指定范围内的 pack 都支持该 gram 宽度时，倒排候选才是该范围的无损超集。
   * packIds 省略时保持历史语义：检查全部已安装 pack。
   */
  supportsNgramSize(size, packIds = null) {
    if (!Number.isInteger(size) || size < 1 || size > 3 || !this.packs.size) return false
    const entries = this._searchPackEntries(packIds)
    if (!entries?.length) return false
    for (const [, manifest] of entries) {
      const index = manifest.search_index
      if (!index?.shards?.length) return false
      const sizes = index.algorithm === 'prts-browser-ngram-postings-v2'
        ? index.gram_sizes : [3]
      if (!Array.isArray(sizes) || !sizes.includes(size)) return false
    }
    return true
  }

  /** 把内部搜索范围解析成稳定、去重且真实存在的 pack 列表。 */
  _searchPackEntries(packIds = null) {
    if (packIds == null) return [...this.packs.entries()]
    if (!Array.isArray(packIds)) return null
    const entries = []
    const seen = new Set()
    for (const rawPackId of packIds) {
      const packId = String(rawPackId ?? '')
      if (!packId || seen.has(packId)) continue
      const manifest = this.packs.get(packId)
      if (!manifest) return null
      seen.add(packId)
      entries.push([packId, manifest])
    }
    return entries
  }

  /**
   * 使用各 pack 的 trigram 倒排分片求文档交集；查询短于 3 字符时返回 null。
   * 外层按分片迭代：每个分片只解压一次，再对其覆盖范围内的全部 trigram
   * 查询，避免多 trigram 查询反复重解压同一批分片。
   */
  async findDocumentsByNgrams(trigrams, { signal, deadline = Infinity, packIds = null } = {}) {
    if (!trigrams.length) return null
    const entries = this._searchPackEntries(packIds)
    if (!entries) return null
    if (!entries.length) return []
    const gramSize = [...String(trigrams[0])].length
    if (!this.supportsNgramSize(gramSize, entries.map(([packId]) => packId))) return null
    const checkpoint = () => assertShortLiteralScanActive({ signal, deadline, store: this })
    checkpoint()
    const perTrigram = new Map(trigrams.map((trigram) => [trigram, new Set()]))
    for (const [packId, manifest] of entries) {
      for (const descriptor of manifest.search_index?.shards ?? []) {
        checkpoint()
        const range = searchIndexRange(descriptor)
        const relevant = trigrams.filter((trigram) => compareNgramKeys(range.first, trigram) <= 0
          && compareNgramKeys(trigram, range.last) <= 0)
        if (!relevant.length) continue
        const bytes = await this._loadSearchShard(packId, descriptor.path)
        checkpoint()
        for (const trigram of relevant) {
          const candidates = perTrigram.get(trigram)
          const indexes = lookupNgramIndex(bytes, trigram)
          for (let offset = 0; offset < indexes.length; offset += 1) {
            if ((offset & 1023) === 0) checkpoint()
            const index = indexes[offset]
            const documentId = this.searchIndexDocuments.get(`${packId}\0${index}`)
            if (documentId) candidates.add(documentId)
          }
        }
      }
    }
    let intersection = null
    for (const trigram of trigrams) {
      checkpoint()
      const candidates = perTrigram.get(trigram)
      if (intersection === null) intersection = candidates
      else {
        const next = new Set()
        let checked = 0
        for (const documentId of intersection) {
          if ((checked++ & 1023) === 0) checkpoint()
          if (candidates.has(documentId)) next.add(documentId)
        }
        intersection = next
      }
      if (!intersection.size) break
    }
    checkpoint()
    return [...(intersection ?? [])]
  }

  /** v1 API alias；旧调用者仍可查询三元倒排。 */
  async findDocumentsByTrigrams(trigrams, runtime = {}) {
    return this.findDocumentsByNgrams(trigrams, runtime)
  }

  _shortLiteralCacheHit(query) {
    const cached = this._shortLiteralCache.get(query)
    if (!cached) return null
    this._shortLiteralCache.delete(query)
    this._shortLiteralCache.set(query, cached)
    return [...cached]
  }

  _rememberShortLiteralCandidates(query, candidates) {
    const previous = this._shortLiteralCache.get(query)
    if (previous) {
      this._shortLiteralCache.delete(query)
      this._shortLiteralCacheCandidateCount -= previous.length
    }
    // 单个极高频字若已超过整个缓存预算，仍可服务当前请求，但不应驱逐所有
    // 小结果后独占常驻内存。
    if (candidates.length > MAX_SHORT_LITERAL_CACHE_CANDIDATES) return
    this._shortLiteralCache.set(query, candidates)
    this._shortLiteralCacheCandidateCount += candidates.length
    while (this._shortLiteralCache.size > 32
        || this._shortLiteralCacheCandidateCount > MAX_SHORT_LITERAL_CACHE_CANDIDATES) {
      const oldest = this._shortLiteralCache.keys().next().value
      const evicted = this._shortLiteralCache.get(oldest)
      this._shortLiteralCache.delete(oldest)
      this._shortLiteralCacheCandidateCount -= evicted?.length ?? 0
    }
  }

  _enqueueShortLiteralScan(runtime, scan) {
    assertShortLiteralScanActive({ ...runtime, store: this })
    if (this._shortLiteralScanPending >= MAX_SHORT_LITERAL_SCAN_QUEUE) {
      throw shortLiteralScanError('BUDGET_EXCEEDED',
        '短字面量候选扫描队列已满，请稍后重试', true)
    }
    this._shortLiteralScanPending += 1
    const operation = this._shortLiteralScanTail.then(async () => {
      assertShortLiteralScanActive({ ...runtime, store: this })
      return scan()
    })
    const tracked = operation.then((value) => {
      this._shortLiteralScanPending -= 1
      return value
    }, (error) => {
      this._shortLiteralScanPending -= 1
      throw error
    })
    // tail 总是兑现，单个请求失败不会毒化后续队列；tracked 的拒绝同时由
    // 这里和调用方等待器观察，不会形成未处理拒绝。
    this._shortLiteralScanTail = tracked.catch(() => {})
    return waitForShortLiteralScan(tracked, { ...runtime, store: this })
  }

  /**
   * 为 1—2 个无大小写字符的字面量提供 grep 式候选预筛。
   *
   * 现有资料包只带 trigram 倒排，短查询不能使用它。直接逐文档扫描会再次
   * JSON.parse 全库并轻易越过工具时限；这里先在解压后的 JSONL Buffer 上做
   * 原始字节查找，只解析确实可能含命中的少量分片，再返回文档候选。
   *
   * 字节预筛必须是正式匹配（search.js 的 matchesText：NFKC + 空白折叠 +
   * 小写后子串匹配）的“超集”，否则会产生假阴性。本地语料并非 NFKC 纯文本
   * （实测七成以上行含全角标点等兼容字符），因此 needle 集合在查询原文
   * 之外还纳入：
   *   1. 查询的规范等价形式（NFD 分解及其部分重组合，如谚文音节）；
   *   2. 初始化收集的“不稳定字符”中，展开式包含查询、或与查询首/尾字符
   *      相邻接者（两字查询可能横跨两个字符展开的边界）。
   * 不适合无损预筛的查询返回 null，由调用方走通用路径。跨字符边界的
   * 规范复合产物（如 "e"+U+0301 复合为 "é"）属于带大小写的预组合字符，
   * 已被“无大小写”入参门槛排除。预筛候选仍由 search.js 逐行按正式谓词
   * 复核，多余候选只损失少量性能，不会污染结果。
   */
  async findDocumentsByShortLiteral(value,
    { signal, deadline = Infinity, packIds = null } = {}) {
    const query = String(value ?? '')
    const characters = [...query]
    if (!characters.length || characters.length > 2
        || query !== query.normalize('NFC') || query !== query.normalize('NFKC')
        || query.toLocaleLowerCase() !== query.toLocaleUpperCase()
        || /[\s"\\\u0000-\u001f]/u.test(query)) return null
    if (!this.unstableChars) return null
    const entries = this._searchPackEntries(packIds)
    if (!entries) return null
    if (!entries.length) return []
    const cacheKey = `${entries.map(([packId]) => packId).sort((left, right) =>
      left.localeCompare(right, 'en')).join('\0')}\u0001${query}`
    const runtime = { signal, deadline }
    assertShortLiteralScanActive({ ...runtime, store: this })
    const cached = this._shortLiteralCacheHit(cacheKey)
    if (cached) return cached
    const generation = this._generation
    const releaseId = this.releaseId
    return this._enqueueShortLiteralScan({ ...runtime, generation }, async () => {
      const queuedCached = this._shortLiteralCacheHit(cacheKey)
      if (queuedCached) return queuedCached
      const checkpoint = () => assertShortLiteralScanActive({ ...runtime, generation, store: this })
      const needles = canonicalVariants(query)
      const first = characters[0]
      const last = characters[characters.length - 1]
      let unstableIndex = 0
      for (const [character, expansion] of this.unstableChars) {
        if ((unstableIndex++ & 255) === 0) checkpoint()
        if (expansion.includes(query) || expansion.endsWith(first) || expansion.startsWith(last)) {
          needles.add(character)
        }
      }
      const needleStrings = [...needles]
      const needleBuffers = needleStrings.map((needle) => Buffer.from(needle, 'utf8'))
      const jobs = []
      for (const [packId, manifest] of entries) {
        checkpoint()
        for (const descriptor of manifest.shards ?? []) {
          jobs.push({ packId, descriptor, order: jobs.length })
        }
      }
      // gzip 解压走 libuv 线程池。每个 worker 一次只持有一个分片的明文，
      // 命中分片当场解析并只保留候选文档 id 与有界的 _shardCache；跨查询
      // 的串行队列保证同时最多只有这一组 worker 在遍历全库。
      const found = []
      let nextJob = 0
      let scanFailure = null
      const worker = async () => {
        try {
          while (nextJob < jobs.length) {
            checkpoint()
            if (scanFailure) throw scanFailure
            const job = jobs[nextJob++]
            const bytes = await this._readPacked(job.packId, job.descriptor.path,
              releaseId, job.descriptor)
            checkpoint()
            let possibleMatch = false
            for (let index = 0; index < needleBuffers.length; index += 1) {
              if ((index & 7) === 0) checkpoint()
              if (bytes.includes(needleBuffers[index])) {
                possibleMatch = true
                break
              }
            }
            if (!possibleMatch) continue
            // 分片间让出事件循环：JSON.parse 与逐行筛选是同步 CPU 工作。
            await new Promise((resolve) => { setImmediate(resolve) })
            checkpoint()
            const records = this._decodeShard(bytes, checkpoint)
            const key = `${job.packId}\0${job.descriptor.path}`
            checkpoint()
            this._rememberShard(key, records, bytes.length)
            for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
              if ((recordIndex & 31) === 0) checkpoint()
              const record = records[recordIndex]
              let title = false
              for (const item of [record.document?.display_title, record.document?.story_name,
                record.document?.activity_name, record.document?.character_name]) {
                if (item == null) continue
                const text = String(item)
                if (needleStrings.some((needle) => text.includes(needle))) {
                  title = true
                  break
                }
              }
              let content = false
              if (!title) {
                const lines = record.lines ?? []
                for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
                  if ((lineIndex & 255) === 0) checkpoint()
                  const text = typeof lines[lineIndex]?.text === 'string' ? lines[lineIndex].text : ''
                  if (text !== '' && needleStrings.some((needle) => text.includes(needle))) {
                    content = true
                    break
                  }
                }
              }
              if (title || content) found.push(record.document.document_id)
            }
          }
        } catch (error) {
          scanFailure ||= error
          throw error
        }
      }
      const settled = await Promise.allSettled(
        Array.from({ length: Math.min(SHORT_LITERAL_SCAN_WORKERS, jobs.length) }, worker),
      )
      const rejected = settled.find((item) => item.status === 'rejected')
      if (rejected) throw scanFailure || rejected.reason
      checkpoint()
      // worker 完成顺序不定；按全局稳定 ordinal 恢复与全量扫描一致的顺序。
      found.sort((left, right) =>
        (this.documents.get(left)?.ordinal ?? 0) - (this.documents.get(right)?.ordinal ?? 0))
      checkpoint()
      this._rememberShortLiteralCandidates(cacheKey, found)
      return [...found]
    })
  }

  /** 先按初始化时保留的轻量元数据过滤，再按需解压正文分片。 */
  async *iterateDocuments({ documentIds = null, predicate = null } = {}) {
    const ids = this.orderedDocumentIds(documentIds)
    for (const documentId of ids) {
      const location = this.documents.get(documentId)
      if (!location || (predicate && !predicate(location.document, location.speakers))) continue
      const found = await this.getDocument(documentId)
      if (found) yield found.record
    }
  }

  /**
   * 枚举某个活动下的全部剧情 story 文档（不解压正文分片，仅用初始化保留的
   * 轻量元数据），按 collection_id + sequence_index 排序。
   * @param {{ activityId?: string, activityName?: string }} target
   * @returns {{ document: object, speakers: string[] }[]}
   */
  activityStoryDocuments({ activityId = '', activityName = '', anchorDocumentId = '' }) {
    const anchor = anchorDocumentId ? this.documents.get(String(anchorDocumentId))?.document : null
    if (anchorDocumentId && (!anchor || documentGame(anchor) !== 'arknights'
        || anchor.document_type !== 'story' || anchor.document_category !== 'activity')) return []
    const id = String(anchor?.collection_id || anchor?.activity_id || activityId || '').trim()
    const name = anchor ? '' : normalizedLookupText(activityName)
    if (!id && !name) return []
    const matches = []
    for (const location of this.documents.values()) {
      const document = location.document
      if (!document || documentGame(document) !== 'arknights'
          || document.document_type !== 'story' || document.document_kind !== 'story'
          || document.document_category !== 'activity') continue
      const source = String(document.source_story_id || document.document_id || '')
      // 教程与战斗教学不是活动剧情正文；它们有时沿用同一个 activity_name，
      // 若不剔除会把“骑兵与猎人”等活动错误合并成两个 collection。
      if (/(?:^|\/)(?:tutorial(?:_|\/)|training\/)/iu.test(source)) continue
      const byId = id && (String(document.collection_id || '') === id
        || String(document.activity_id || '') === id)
      const byName = name && normalizedLookupText(document.activity_name) === name
      if (!byId && !byName) continue
      matches.push({ document, speakers: location.speakers })
    }
    if (!id) {
      const collections = new Map()
      for (const item of matches) {
        const key = String(item.document.collection_id || item.document.activity_id || '')
        const docs = collections.get(key) ?? []
        docs.push(item)
        collections.set(key, docs)
      }
      if (collections.size > 1) {
        const choices = [...collections.values()].map((docs) => {
          const first = [...docs].sort((left, right) =>
            Number(left.document.sequence_index || 0) - Number(right.document.sequence_index || 0))[0]
          return `document_uid=${documentUid(first.document.document_id)}（《${naturalDocumentTitle(first.document)}》等 ${docs.length} 篇）`
        })
        throw Object.assign(new Error(
          `活动名“${name}”对应 ${collections.size} 个不同剧情合集：${choices.join('、')}；请先检索具体篇章，再用其 document_uid + mode="activity" 通读，不能自动合并`,
        ), { code: 'DOCUMENT_AMBIGUOUS' })
      }
    }
    matches.sort((left, right) =>
      String(left.document.collection_id || '').localeCompare(
        String(right.document.collection_id || ''), 'zh-CN', { numeric: true })
      || (Number(left.document.sequence_index || 0) - Number(right.document.sequence_index || 0))
      || String(left.document.document_id || '').localeCompare(String(right.document.document_id || '')))
    return matches
  }

  /** 按终末地任务/集合展示名枚举官方剧情碎片；同名多集合时拒绝猜测。 */
  endfieldCollectionDocuments({ collectionName = '', contentTypes = [], anchorDocumentId = '' }) {
    const anchor = anchorDocumentId ? this.documents.get(String(anchorDocumentId))?.document : null
    if (anchorDocumentId && (!anchor || documentGame(anchor) !== 'endfield'
        || anchor.document_type !== 'story' || anchor.resource_type !== 'original_story')) return []
    const name = anchor ? normalizedLookupText(anchor.collection_name) : normalizedLookupText(collectionName)
    const collectionId = String(anchor?.collection_id || '')
    if (!name && !collectionId) return []
    const allowedTypes = contentTypes.length
      ? new Set(contentTypes) : END_FIELD_NARRATIVE_CONTENT_TYPES
    const matches = []
    for (const location of this.documents.values()) {
      const document = location.document
      if (!document || documentGame(document) !== 'endfield'
          || document.document_type !== 'story' || document.document_kind !== 'story'
          || document.resource_type !== 'original_story'
          || (collectionId ? String(document.collection_id || '') !== collectionId
            : normalizedLookupText(document.collection_name) !== name)) continue
      if (!allowedTypes.has(String(document.content_type || ''))) continue
      matches.push({ document, speakers: location.speakers })
    }
    const collections = new Map()
    for (const item of matches) {
      const key = String(item.document.collection_id || '')
      const docs = collections.get(key) ?? []
      docs.push(item)
      collections.set(key, docs)
    }
    if (collections.size > 1) {
      const choices = [...collections.values()].map((docs) => {
        const types = [...new Set(docs.map((item) => item.document.content_type).filter(Boolean))]
        const first = [...docs].sort((left, right) =>
          naturalCompare(left.document.source_story_id, right.document.source_story_id))[0]
        return `document_uid=${documentUid(first.document.document_id)}（${types.join('/')} ${docs.length} 篇）`
      })
      throw Object.assign(new Error(
        `终末地集合名“${name}”对应 ${collections.size} 个不同内容集合：${choices.join('、')}；content_types 不能保证消歧，请先检索具体篇章，再用其 document_uid + mode="collection" 通读`,
      ), { code: 'DOCUMENT_AMBIGUOUS' })
    }
    matches.sort((left, right) =>
      END_FIELD_CONTENT_TYPE_ORDER.indexOf(String(left.document.content_type || ''))
        - END_FIELD_CONTENT_TYPE_ORDER.indexOf(String(right.document.content_type || ''))
      || naturalCompare(left.document.source_story_id || left.document.display_title,
        right.document.source_story_id || right.document.display_title)
      || naturalCompare(left.document.document_id, right.document.document_id))
    return matches
  }
}
