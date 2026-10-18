/**
 * dsh 版 timeline_search：活动时间线检索（PRTS Wiki《泰拉年表》的本地投影）。
 *
 * 数据来自资料包 references/activity_timelines.jsonl（每行一个活动：
 * {activity_id, activity_name, events:[{event_id, time, event, sources}], source}）。
 * entity_names 先经别名图鉴（entities 包 + references/char_alias.txt）裂变再匹配；
 * source_marker（年表出处:tle_xxx）可反查单条事件的完整来源。
 */
import { randomBytes } from 'node:crypto'
import { loadEntityRelationCatalog, relationEndfieldNames } from './entity-routing.js'

export const TIMELINE_CONTRACT_VERSION = 'prts-corpus-tools-v1'
const MARKER_PATTERN = /^年表出处:(tle_[0-9a-f]{24})$/

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

function chineseInteger(value) {
  const digits = '零一二三四五六七八九'
  if (!Number.isInteger(value) || value < 0 || value > 99) return String(value)
  if (value < 10) return digits[value]
  const tens = Math.floor(value / 10)
  const ones = value % 10
  return `${tens === 1 ? '' : digits[tens]}十${ones ? digits[ones] : ''}`
}

/** 活动展示名之外，再接受主线章节号的常见自然写法。 */
export function activityAliases(value = {}) {
  const aliases = new Set([normalizeText(value.activity_name)].filter(Boolean))
  const source = [value.activity_id, value.collection_id].map((item) => String(item || '')).join('\n')
  const match = /(?:^|event:|\b)main[_:](\d+)(?:\b|$)/u.exec(source)
  if (match) {
    const chapter = Number(match[1])
    aliases.add(`第${chapter}章`)
    aliases.add(`第${chineseInteger(chapter)}章`)
    aliases.add(`${chapter}章`)
    aliases.add(`主线${chapter}章`)
    aliases.add(`主线第${chapter}章`)
  }
  return [...aliases]
}

export function activityMatches(value, requested, { exact = false } = {}) {
  const needle = normalizeText(requested)
  if (!needle) return false
  return activityAliases(value).some((alias) => exact
    ? alias === needle : alias.includes(needle) || needle.includes(alias))
}

function usefulEntityAliases(group) {
  const aliases = [...new Set((group.aliases || []).map(normalizeText).filter(Boolean))]
  const longer = aliases.filter((alias) => [...alias].length > 1)
  return longer.length ? longer : aliases
}

function displayEventTime(time = {}) {
  const label = String(time.text || time.section || '时间不详').trim()
  if (/年|世纪|纪元/u.test(label)) return label
  const start = Number.isInteger(time.year_start) ? time.year_start : null
  const end = Number.isInteger(time.year_end) ? time.year_end : start
  if (start === null || start < 0) return label
  const year = end !== null && end !== start ? `${start}-${end} 年` : `${start} 年`
  return label === '时间不详' ? year : `${year} ${label}`
}

function normalizedTimeBounds(time = {}) {
  const label = normalizeText(time.text || time.section)
  const century = /(\d+)\s*世纪(?:\s*(\d+)\s*年代)?/u.exec(label)
  if (century) {
    const base = (Number(century[1]) - 1) * 100
    const start = base + (century[2] ? Number(century[2]) : 1)
    return { start, end: century[2] ? start + 9 : base + 100 }
  }
  let start = Number.isInteger(time.year_start) ? time.year_start : null
  if (start === null) {
    const explicit = /(?:^|\D)(\d{1,4})\s*年/u.exec(label)
    if (explicit) start = Number(explicit[1])
  }
  return { start, end: Number.isInteger(time.year_end) ? time.year_end : start }
}

function numericTimeOrder(time = {}, sequence = 0) {
  const label = normalizeText(time.text || time.section)
  const bounds = normalizedTimeBounds(time)
  if (bounds.start === null) return [Number.POSITIVE_INFINITY, 13, 32, 24 * 60, sequence]
  const monthMatch = /(\d{1,2})\s*月/u.exec(label)
  const seasonMonth = /春/u.test(label) ? 3 : /夏/u.test(label) ? 6
    : /秋/u.test(label) ? 9 : /冬/u.test(label) ? 12 : 0
  const month = monthMatch ? Number(monthMatch[1]) : seasonMonth
  const dayMatch = /(\d{1,2})\s*日/u.exec(label)
  const day = dayMatch ? Number(dayMatch[1]) : 0
  const clock = /(\d{1,2})\s*[：:]\s*(\d{1,2})/u.exec(label)
  let minutes = clock ? Number(clock[1]) * 60 + Number(clock[2]) : 0
  if (!clock) {
    if (/深夜/u.test(label)) minutes = 23 * 60
    else if (/晚上/u.test(label)) minutes = 19 * 60
    else if (/下午/u.test(label)) minutes = 14 * 60
    else if (/中午/u.test(label)) minutes = 12 * 60
    else if (/上午/u.test(label)) minutes = 9 * 60
    else if (/早上/u.test(label)) minutes = 7 * 60
    else if (/清晨/u.test(label)) minutes = 5 * 60
    else if (/凌晨/u.test(label)) minutes = 1 * 60
  }
  return [bounds.start, month, day, minutes, sequence]
}

function compareTimeOrder(left, right) {
  for (let index = 0; index < left.order.length; index += 1) {
    if (left.order[index] !== right.order[index]) return left.order[index] - right.order[index]
  }
  return 0
}

function mergeTimelineMatches(candidates) {
  const merged = []
  const byKey = new Map()
  for (const candidate of [...candidates].sort(compareTimeOrder)) {
    const projected = timelineEvent(candidate.row, candidate.event)
    const fallbackKey = `${normalizeText(projected.time)}\0${normalizeText(projected.event)}`
    const key = String(candidate.event.event_id || '') || fallbackKey
    const existing = byKey.get(key)
    if (existing) {
      if (projected.activity_name && !existing.activity_names.includes(projected.activity_name)) {
        existing.activity_names.push(projected.activity_name)
      }
      continue
    }
    projected.activity_names = projected.activity_name ? [projected.activity_name] : []
    byKey.set(key, projected)
    merged.push(projected)
  }
  return merged
}

class TimelineFault extends Error {
  constructor(code, message, retryable = false) {
    super(message)
    this.code = code
    this.retryable = retryable
  }
}

/** ---- 实体别名图鉴（entities 包投影 + char_alias.txt 人工补充） ---- */

/**
 * 构建全量别名组。组来源：
 *  1. entities 包每条实体记录的 canonical_name + aliases（权威源）；
 *  2. references/char_alias.txt 的分号分隔行（挂到同名 canonical 组，找不到则自建）。
 * @returns {Promise<Array<{canonical: string, aliases: string[], games: string[]}>>}
 */
/** 别名字面归一：与识别器同源（NFKC + 小写 + 压缩空白），避免大小写或全角差异放过冲突。 */
function aliasKey(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
}

/**
 * 一个别名字面只能指向一个实体。资料里出现过把正文提及词当成别名的记录
 * （如「玛利图斯」的 aliases 里塞进「预言家」「海嗣」），AC 自动机便会对同一字面
 * 同时吐出两个 canonical，让无关实体混进本轮检索上下文。
 * 裁决：字面等于某实体自身规范名时保留该实体（如「海嗣」保留给海嗣），
 * 其余情况一律丢弃并登记冲突，交给数据侧修正别名表——不在代码里猜谁才是对的。
 */
function resolveAliasConflicts(groups, pinned = new Set()) {
  const owners = new Map()
  for (const group of groups.values()) for (const alias of group.aliases) {
    const key = aliasKey(alias)
    if (!key) continue
    const list = owners.get(key) || []
    list.push({ group, alias })
    owners.set(key, list)
  }
  const conflicts = []
  for (const [key, list] of owners) {
    const canonicals = [...new Set(list.map((item) => item.group.canonical))]
    if (canonicals.length < 2) continue
    const keeper = list.find((item) => item.group.canonical === item.alias)
    for (const item of list) {
      if (item === keeper) continue
      item.group.aliases.delete(item.alias)
    }
    if (!keeper && !pinned.has(key)) conflicts.push({ alias: list[0].alias, canonicals: canonicals.sort() })
  }
  return conflicts
}

/**
 * 去掉"太泛"的短别名：两个字的词很容易是通用词（如某组织把「联合」当别名，
 * 于是"联合解析"这种句子会把它整个拉进检索上下文）。
 * 判据是它在多少条**其他**实体的规范名里当子串——只有人工别名表里裁决过的短别名豁免。
 */
function dropGenericShortAliases(groups, curated) {
  const canonicals = [...groups.keys()]
  const dropped = []
  for (const group of groups.values()) {
    for (const alias of [...group.aliases]) {
      const key = aliasKey(alias)
      if (key.length > 2 || key === aliasKey(group.canonical) || curated.has(key)) continue
      const others = canonicals.filter((name) => name !== group.canonical
        && aliasKey(name).includes(key)).length
      if (others < 3) continue
      group.aliases.delete(alias)
      dropped.push({ alias, canonical: group.canonical, others })
    }
  }
  return dropped
}

export async function buildAliasGroups(store) {
  const groups = new Map()
  const crossGameNames = relationEndfieldNames(await loadEntityRelationCatalog(store))
  const remember = (canonicalValue, aliasValues = [], gameValue = '') => {
    const canonical = String(canonicalValue ?? '').trim()
    if (!canonical) return
    const group = groups.get(canonical) || { canonical, aliases: new Set([canonical]), games: new Set() }
    // 实体 JSON 点里 aliases 是分号分隔的字符串（个别用全角分号），资料包里是数组；
    // 字符串直接迭代会被按字拆开，这里统一先切分。
    const aliasList = typeof aliasValues === 'string' ? aliasValues.split(/[;；]/u)
      : Array.isArray(aliasValues) ? aliasValues : []
    for (const value of aliasList) {
      const alias = String(value ?? '').trim()
      // 旧 PRTS 数据曾把终末地再旅者名塞进泰拉人物 aliases 方便联搜。
      // 关系现在由独立附属字段承载；跨游戏名不再改变实体身份。
      if (alias && (alias === canonical || !crossGameNames.has(alias))) group.aliases.add(alias)
    }
    const game = String(gameValue || '').trim().toLocaleLowerCase()
    if (game === 'arknights' || game === 'endfield') group.games.add(game)
    groups.set(canonical, group)
  }

  for await (const record of store.iterateDocuments({
    predicate: (document) => document.document_type === 'entity',
  })) {
    const entity = record.entity || {}
    const identity = `${record.document.document_id || ''} ${record.document.source_ref_prefix || ''}`
      .toLocaleLowerCase()
    const game = record.document.game || (identity.includes('endfield:') ? 'endfield' : 'arknights')
    remember(entity.canonical_name || record.document.display_title,
      entity.aliases || record.aliases, game)
  }

  // 人工别名表（char_alias.txt）是裁决，不是补充：实体 JSON 里的 aliases 由当时的
  // LLM 生成 json 点时顺手写出，会把正文提及词当成别名（「玛利图斯」曾带「预言家」
  // 「海嗣」）。表里每一行声明的别名只归该行实体，其余组必须让出。
  const aliasReference = await store.getDocumentByPath('char_alias.txt')
  const pinned = new Set()
  for (const line of aliasReference?.record?.lines || []) {
    const aliases = [...new Set(String(line.text || '').split(';').map((item) => item.trim()).filter(Boolean))]
    if (!aliases.length) continue
    const existing = [...groups.values()].find((group) =>
      group.canonical === aliases[0] || group.aliases.has(aliases[0]))
    const canonical = existing?.canonical || aliases[0]
    for (const alias of aliases) {
      const key = aliasKey(alias)
      if (!key) continue
      for (const group of [...groups.values()]) {
        if (group.canonical === canonical) continue
        for (const owned of [...group.aliases]) {
          if (aliasKey(owned) === key) group.aliases.delete(owned)
        }
      }
      pinned.add(key)
    }
    remember(canonical, aliases)
  }

  const conflicts = resolveAliasConflicts(groups, pinned)
  const generic = dropGenericShortAliases(groups, pinned)
  if (store && typeof store === 'object') {
    store._aliasConflicts = conflicts
    store._genericAliases = generic
    store._curatedAliases = pinned
  }
  return [...groups.values()].map((group) => ({ canonical: group.canonical,
    aliases: [...group.aliases], games: [...group.games] }))
}

/**
 * 把请求中的实体名展开为别名组；未知名字原样返回单别名组。
 * @param {import('./store.js').CorpusStore} store
 * @param {string[]} entityNames
 */
export async function aliasesFor(store, entityNames) {
  if (!entityNames?.length) return []
  if (!store._aliasGroups) store._aliasGroups = await buildAliasGroups(store)
  return entityNames.map((name) => {
    const group = store._aliasGroups.find((item) => item.aliases.includes(name))
    return group ? { canonical: group.canonical, aliases: [...group.aliases], games: [...group.games] }
      : { canonical: name, aliases: [name], games: [] }
  })
}

/** ---- 时间线数据 ---- */

/** 读取并解析 activity_timelines.jsonl（每行一个活动，含 events 数组）。 */
export async function timelineRows(store) {
  if (store._timelineRows) return store._timelineRows
  const found = await store.getDocumentByPath('activity_timelines.jsonl')
  store._timelineRows = (found?.record?.lines || []).flatMap((line) => {
    try {
      const row = JSON.parse(String(line.text || ''))
      return row && Array.isArray(row.events) ? [row] : []
    } catch {
      return []
    }
  })
  return store._timelineRows
}

function timelineEvent(row, event) {
  return {
    activity_name: row.activity_name ?? '',
    time: displayEventTime(event.time),
    ...(Number.isInteger(event.time?.year_start) ? { year_start: event.time.year_start } : {}),
    ...(Number.isInteger(event.time?.year_end) ? { year_end: event.time.year_end } : {}),
    event: event.event ?? '',
    source_marker: `年表出处:${event.event_id}`,
  }
}

/** ---- 工具执行 ---- */

function normalizedTimelineRequest(raw = {}) {
  const query = normalizeText(raw.query)
  if (query.length > 200) throw new TimelineFault('INVALID_REQUEST', 'query 最长 200 字符')
  // schema 之外的第三方调用可能传字符串等：按 INVALID_REQUEST 拒绝，
  // 而不是让 .map 抛 TypeError 被归入 INTERNAL_ERROR。
  const nameFilter = (value, field) => {
    if (value === undefined || value === null) return []
    if (!Array.isArray(value)) {
      throw new TimelineFault('INVALID_REQUEST', `${field} 必须是字符串数组`)
    }
    return value.map(normalizeText).filter(Boolean)
  }
  const activities = nameFilter(raw.activity_names, 'activity_names')
  if (activities.length > 20) throw new TimelineFault('INVALID_REQUEST', 'activity_names 最多 20 项')
  const entities = nameFilter(raw.entity_names, 'entity_names')
  if (entities.length > 20) throw new TimelineFault('INVALID_REQUEST', 'entity_names 最多 20 项')
  const marker = String(raw.source_marker || '').trim()
  if (marker && !MARKER_PATTERN.test(marker)) {
    throw new TimelineFault('INVALID_REQUEST', '时间线出处标记格式无效（应为 年表出处:tle_<24位十六进制>）')
  }
  const yearStart = raw.year_start == null ? null : Number(raw.year_start)
  const yearEnd = raw.year_end == null ? null : Number(raw.year_end)
  if (yearStart !== null && !Number.isInteger(yearStart)) throw new TimelineFault('INVALID_REQUEST', 'year_start 必须是整数')
  if (yearEnd !== null && !Number.isInteger(yearEnd)) throw new TimelineFault('INVALID_REQUEST', 'year_end 必须是整数')
  if (!query && !activities.length && !entities.length && yearStart === null && yearEnd === null && !marker) {
    throw new TimelineFault('INVALID_REQUEST', '请提供 query / activity_names / entity_names / 年份范围 / source_marker 之一')
  }
  const limit = raw.max_results === undefined ? 20 : Number(raw.max_results)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new TimelineFault('INVALID_REQUEST', 'max_results 必须在 1..100')
  }
  return { query, activities, entities, marker, yearStart, yearEnd, limit }
}

/**
 * 执行 timeline_search。
 * @param {import('./store.js').CorpusStore} store
 * @param {object} raw 模型原始参数
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<object>} 契约响应（ok / error）
 */
export async function executeTimelineSearch(store, raw, { signal } = {}) {
  const started = Date.now()
  const requestId = `req-${randomBytes(8).toString('hex')}`
  try {
    await store.ready()
    const request = normalizedTimelineRequest(raw)
    const rows = await timelineRows(store)
    if (!rows.length) {
      throw new TimelineFault('TIMELINE_NOT_INSTALLED', '活动时间线资料尚未安装（资料包缺少 activity_timelines.jsonl）', true)
    }
    if (signal?.aborted) throw new TimelineFault('CANCELLED', '时间线检索已取消')

    // 反查模式：source_marker → 单条事件完整来源
    if (request.marker) {
      const eventId = MARKER_PATTERN.exec(request.marker)[1]
      for (const row of rows) {
        const event = row.events.find((item) => item.event_id === eventId)
        if (!event) continue
        return {
          contract_version: TIMELINE_CONTRACT_VERSION, status: 'ok', request_id: requestId,
          data_version: store.dataVersion, mode: 'source',
          event: timelineEvent(row, event), provenance: {
            source_title: 'PRTS Wiki《泰拉年表》', source: row.source ?? null,
            ...(event.source_location == null ? {} : { source_location: event.source_location }),
            sources: event.sources || [],
          },
        }
      }
      throw new TimelineFault('TIMELINE_SOURCE_NOT_FOUND', '没有找到该时间线出处标记')
    }

    // 检索模式：活动 / 实体别名 / 年份 / 正文短语 四维交集
    const aliasGroups = await aliasesFor(store, request.entities)
    const entityAliases = [...new Set(aliasGroups.flatMap(usefulEntityAliases)
      .map((item) => normalizeText(item).toLocaleLowerCase()))]
    const inferredActivity = !request.activities.length && request.query
      ? rows.find((row) => activityMatches(row, request.query, { exact: true })) : null
    const requestedActivities = inferredActivity ? [inferredActivity.activity_name] : request.activities
    const query = inferredActivity ? '' : request.query.toLocaleLowerCase()
    const candidates = []
    let sequence = 0
    for (const row of rows) {
      if (requestedActivities.length
          && !requestedActivities.some((name) => activityMatches(row, name))) continue
      for (const event of row.events) {
        const { start: yearStart, end: yearEnd } = normalizedTimeBounds(event.time)
        if (request.yearStart !== null && (yearEnd == null || yearEnd < request.yearStart)) continue
        if (request.yearEnd !== null && (yearStart == null || yearStart > request.yearEnd)) continue
        const haystack = normalizeText([event.event, event.time?.text,
          ...(event.sources || []).map((item) => item.text)].join('\n')).toLocaleLowerCase()
        if (query && !haystack.includes(query)) continue
        if (entityAliases.length && !entityAliases.some((alias) => haystack.includes(alias))) continue
        candidates.push({ row, event, order: numericTimeOrder(event.time, sequence) })
        sequence += 1
      }
    }
    const matches = mergeTimelineMatches(candidates)
    return {
      contract_version: TIMELINE_CONTRACT_VERSION, status: 'ok', request_id: requestId,
      data_version: store.dataVersion, mode: 'search',
      normalized_filters: { query: inferredActivity ? '' : request.query,
        activity_names: requestedActivities,
        ...(inferredActivity ? { inferred_activity_from_query: request.query } : {}),
        entity_alias_groups: aliasGroups, year_start: request.yearStart, year_end: request.yearEnd },
      events: matches.slice(0, request.limit),
      page: { returned: Math.min(matches.length, request.limit), total: matches.length,
        has_more: matches.length > request.limit },
      stats: { elapsed_ms: Date.now() - started, scanned_activities: rows.length,
        matched_events: matches.length, matched_occurrences: candidates.length },
      guidance: matches.length
        ? '时间线是可采纳的整理性证据；若与原文冲突则以原文为准。方括号内的出处标记可原样传给 source_marker 反查完整来源。'
        : '没有命中；可放宽年份、换用实体展示名，或省略实体只按活动浏览。',
    }
  } catch (error) {
    return {
      contract_version: TIMELINE_CONTRACT_VERSION, status: 'error', request_id: requestId,
      data_version: store.dataVersion ?? null,
      error: { code: error.code || 'INTERNAL_ERROR', message: error.message || String(error), retryable: error.retryable ?? false },
    }
  }
}

/** 模型可见文本渲染（output.render 用）。 */
export function renderTimeline(_args, value) {
  if (value.status !== 'ok') {
    return [{ type: 'text', text: `[timeline_search:error] ${value.error.code}: ${value.error.message}` }]
  }
  const lines = [`[timeline_search:${value.mode}] data_version=${String(value.data_version ?? '').slice(0, 12)}…`]
  if (value.mode === 'source') {
    const event = value.event
    lines.push(`${event.time}：${event.event}`)
    lines.push(`activity: ${event.activity_name}`)
    const provenance = value.provenance
    lines.push(`source: ${provenance.source_title}${provenance.source ? ` (${provenance.source})` : ''}`)
    for (const source of provenance.sources || []) {
      lines.push(`  - ${[source.text, source.story_name, source.activity_name].filter(Boolean).join(' | ')}`)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }
  for (const [index, event] of value.events.entries()) {
    const activities = event.activity_names?.length ? event.activity_names : [event.activity_name]
    lines.push(`${index + 1}. [${activities.filter(Boolean).join('、')}] ${event.time}：${event.event} [${event.source_marker}]`)
  }
  lines.push(`page: returned=${value.page.returned} total=${value.page.total} has_more=${value.page.has_more}`)
  if (value.guidance) lines.push(value.guidance)
  return [{ type: 'text', text: lines.join('\n') }]
}
