/** Source-table mainline navigation; never derives chapter order from story fragments. */
import { readFile } from 'node:fs/promises'
import { assertCorpusVersion, corpusVersionSnapshot, documentGame, documentUid,
  naturalDocumentTitle } from './store.js'

export const NAVIGATION_DESCRIPTION = '导航终末地主线目录、当前资料覆盖的最新主线、版本/章节/进程及准确任务名。支持明确标题的上一段/下一段；返回梗概与任务原文的 corpus_search/read 参数。最新仅指当前资料覆盖，不代表实时游戏版本。'
export const NAVIGATION_PARAMETERS = {
  type: 'object', additionalProperties: false,
  properties: {
    query: { type: 'string', description: '留空看主线目录；如最新主线、1.6主线、丹青渡、第二章第八进程、进程VIII、某标题下一段' },
    game: { type: 'string', enum: ['endfield'], description: '当前仅支持终末地主线导航' },
  },
}
const CONTRACT = 'prts-corpus-tools-v1'
const DEFAULT_CATALOG = new URL('../resources/endfield-mainline.json', import.meta.url)
const NARRATIVE = new Set(['dialogue', 'cutscene', 'radio', 'remote_comm', 'black_screen',
  'environment_talk', 'sns_topic', 'sns_chat', 'narration'])
const normalize = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim()
const titleKey = (value) => normalize(value).replace(/^终末地\s*·\s*/u, '')
const fault = (code, message) => Object.assign(new Error(message), { code,
  retryable: code === 'PACKAGE_VERSION_MISMATCH' })
const active = (signal) => { if (signal?.aborted) throw fault('CANCELLED', '主线导航已取消') }
const compareVersion = (a, b) => a.version.localeCompare(b.version, 'en', { numeric: true })

function request(raw, allowedGames) {
  if (raw === undefined) raw = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).some((key) => !Object.hasOwn(NAVIGATION_PARAMETERS.properties, key))) {
    throw fault('INVALID_REQUEST', 'corpus_navigate 仅接受 query 和 game')
  }
  if (raw.game !== undefined && raw.game !== 'endfield') {
    throw fault('UNSUPPORTED_GAME', '主线导航当前仅支持终末地，不支持明日方舟（arknights）')
  }
  if (!Array.isArray(allowedGames) || !allowedGames.includes('endfield')) {
    throw fault('GAME_NOT_ENABLED', '当前未启用终末地资料，无法使用终末地主线导航')
  }
  if (raw.query !== undefined && (typeof raw.query !== 'string' || raw.query.length > 500)) {
    throw fault('INVALID_REQUEST', 'query 必须是最长 500 字符的字符串')
  }
  return normalize(raw.query)
}

function validateCatalog(value) {
  const invalid = () => { throw fault('NAVIGATION_CATALOG_INVALID', '主线目录格式无效：需要明确的版本映射、章节编号与唯一源表 order；不能推断剧情顺序') }
  if (!value || typeof value.source_game_version !== 'string'
      || !Array.isArray(value.versions) || !Array.isArray(value.chapters)) invalid()
  const ids = new Set(), orders = new Set(), versions = new Set()
  for (const row of value.chapters) {
    if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id)
        || typeof row.title !== 'string' || !row.title
        || !Number.isSafeInteger(row.chapter_number) || row.chapter_number < 0
        || (row.process_number !== null && (!Number.isSafeInteger(row.process_number) || row.process_number < 0))
        || !Number.isFinite(row.order) || orders.has(row.order)
        || !Array.isArray(row.collection_names) || row.collection_names.some((s) => typeof s !== 'string' || !s.trim())
        || (row.summary_title != null && typeof row.summary_title !== 'string')) invalid()
    ids.add(row.id); orders.add(row.order)
  }
  for (const row of value.versions) {
    if (!row || typeof row.version !== 'string' || !row.version || versions.has(row.version)
        || typeof row.title !== 'string' || !Array.isArray(row.chapter_ids)
        || row.chapter_ids.some((id) => !ids.has(id))
        || new Set(row.chapter_ids).size !== row.chapter_ids.length) invalid()
    versions.add(row.version)
  }
  return { ...value, chapters: [...value.chapters].sort((a, b) => a.order - b.order),
    versions: [...value.versions].sort(compareVersion) }
}

function number(value) {
  if (/^\d+$/u.test(value)) return Number(value)
  const roman = value.toUpperCase()
  if (/^[IVXLCDM]+$/u.test(roman)) {
    const digits = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }
    let result = 0
    for (let i = 0; i < roman.length; i++) result += digits[roman[i]] * (digits[roman[i]] < (digits[roman[i + 1]] || 0) ? -1 : 1)
    if (!/^(?=.)M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/u.test(roman)) return null
    return result
  }
  const digits = '零一二三四五六七八九'
  if (/^[零一二三四五六七八九两十百]+$/u.test(value)) {
    let result = 0, digit = 0
    for (const char of value.replaceAll('两', '二')) {
      if (char === '十' || char === '百') { result += (digit || 1) * (char === '十' ? 10 : 100); digit = 0 }
      else digit = digits.indexOf(char)
    }
    return result + digit
  }
  return null
}

function select(catalog, query) {
  if (!query || /^(?:终末地)?(?:主线(?:目录|导航|剧情顺序|顺序)?|主线剧情目录)?$/u.test(query)) return { mode: 'directory', rows: catalog.chapters }
  if (/^(?:终末地)?(?:最新主线(?:剧情|目录|讲了什么|讲什么)?|(?:现在|目前)主线到哪(?:了|里了|里)?)$/u.test(query)) {
    const version = [...catalog.versions].reverse().find((row) => row.chapter_ids.length)
    return { mode: 'latest', rows: version ? catalog.chapters.filter((row) => version.chapter_ids.includes(row.id)) : [], version,
      message: version ? '最新指当前目录已有明确映射的最新主线；不代表实时游戏最新。' : '当前目录尚无已映射的最新主线，不能推断实时游戏更新。' }
  }
  const directions = query.match(/上一段|下一段/gu) || []
  if (directions.length) {
    if (directions.length !== 1) throw fault('INVALID_REQUEST', '一次只能导航上一段或下一段')
    const anchor = query.replace(/上一段|下一段/gu, '').replace(/[《》“”"「」『』]/gu, '')
      .replace(/^[\s:：的]+|[\s:：的]+$/gu, '')
    if (!anchor) throw fault('ANCHOR_REQUIRED', '上一段/下一段必须带明确章节或任务标题；不会读取会话中的隐含位置')
    const matches = exactChapters(catalog, anchor)
    if (matches.length !== 1) return { mode: 'adjacent', rows: matches, status: matches.length ? 'ambiguous' : 'not_found',
      message: matches.length ? '标题对应多个主线单元，请使用完整章节标题。' : '未找到准确的锚点标题，请提供目录中的章节或任务名。' }
    const anchorInfo = { id: matches[0].id, title: matches[0].title, navigation_level: 'process' }
    const processAnchor = [matches[0].id, matches[0].title, ...(matches[0].aliases || [])]
      .some((name) => titleKey(name) === titleKey(anchor))
      && !matches[0].collection_names.some((name) => titleKey(name) === titleKey(anchor))
    if (!processAnchor) return { mode: 'adjacent', rows: matches, anchor: { ...anchorInfo, task_name: anchor },
      navigation_level: 'process', message: '上一段/下一段在此工具指主线进程，不是单个任务。该锚点只匹配任务名，现返回所属进程；任务顺序未核实，不自动跳到相邻进程。请明确进程标题后导航。' }
    const index = catalog.chapters.indexOf(matches[0]) + (directions[0] === '上一段' ? -1 : 1)
    return { mode: 'adjacent', rows: catalog.chapters[index] ? [catalog.chapters[index]] : [],
      anchor: anchorInfo, navigation_level: 'process',
      message: catalog.chapters[index] ? '上一段/下一段指按源表顺序相邻的主线进程，不是单个任务。'
        : '已到当前资料目录边界；不能据此断言游戏中没有后续或前序剧情。上一段/下一段指主线进程，不是单个任务。' }
  }
  const target = query.replace(/(?:的)?主线(?:剧情)?$/u, '').trim()
  const exact = exactChapters(catalog, query)
  const suffixed = !exact.length && target !== query ? exactChapters(catalog, target) : []
  if (exact.length || suffixed.length) return { mode: 'title', rows: exact.length ? exact : suffixed }
  if (/支线|角色任务/u.test(query)) throw fault('UNSUPPORTED_SCOPE', 'corpus_navigate 当前入口仅提供终末地主线导航；支线及角色任务请使用 corpus_search 检索，不会返回主线目录兜底')
  const versionMatch = /^(?:终末地\s*)?[vV]?(\d+\.\d+(?:\.\d+)?)(?:\s*版本)?\s*的?\s*(?:主线|剧情|主线剧情)?$/u.exec(query)
  const version = versionMatch ? catalog.versions.find((row) => row.version === versionMatch[1])
    : catalog.versions.find((row) => [row.title, ...(row.aliases || [])].some((title) => [query, target].includes(normalize(title))))
  if (versionMatch || version) return { mode: 'version', version, rows: version
    ? catalog.chapters.filter((row) => version.chapter_ids.includes(row.id)) : [],
    status: version?.chapter_ids.length ? 'ok' : 'unmapped',
    message: !version ? `当前目录没有版本 ${versionMatch[1]} 的主线映射，不能猜测该版本新增剧情。`
      : version.chapter_ids.length ? undefined : '该版本 chapter_ids 为空；仅表示当前目录没有映射条目，不能据此判断无主线更新，请参考 evidence 和 mapping_status。' }
  const compact = query.replace(/\s+/gu, '').replace(/^终末地/u, '').replace(/^主线/u, '')
  const unit = '[0-9零一二三四五六七八九两十百IVXLCDMivxlcdm]+'
  const chapter = new RegExp(`^第?(${unit})章(?:第?(${unit})进程)?$`, 'u').exec(compact)
  const process = new RegExp(`^(?:第?(${unit})进程|进程(${unit}))$`, 'u').exec(compact)
  if (chapter || process) {
    const chapterNumber = chapter ? number(chapter[1]) : null
    const processNumber = chapter?.[2] ? number(chapter[2]) : process ? number(process[1] || process[2]) : null
    const valid = (!chapter || chapterNumber !== null) && (!(chapter?.[2] || process) || processNumber !== null)
    return { mode: 'chapter', rows: valid ? catalog.chapters.filter((row) => (!chapter || row.chapter_number === chapterNumber)
      && (processNumber === null || row.process_number === processNumber)) : [] }
  }
  return { mode: 'title', rows: [], status: 'not_found', message: '当前目录未找到准确标题或可识别的版本/章节/进程；请先查看主线目录，不推断未映射内容。' }
}

function exactChapters(catalog, query) {
  return catalog.chapters.filter((row) => [row.id, row.title, row.title_en, row.summary_title,
    ...(row.summary_titles || []), ...row.collection_names, ...(row.aliases || [])]
    .some((name) => name && titleKey(name) === titleKey(query)))
}

function availability(documents, store, kind) {
  const installed = documents.length > 0 || !(store.packs instanceof Map)
    || store.packs.has(kind === 'summary' ? 'endfield_reviewed_knowledge' : 'endfield_official_game')
  return { status: documents.length ? 'available' : installed ? 'missing' : 'not_installed', document_count: documents.length,
    message: documents.length ? '当前本地目录可定位资料。' : installed
      ? '当前本地目录未找到对应资料；不代表没有该段剧情。' : '对应本地资料包未安装；不代表没有该段剧情。' }
}

function entry(row, catalog, documents, store) {
  const summaries = [...new Set([row.summary_title, ...(row.summary_titles || [])].filter(Boolean))].map((title) => {
    const matches = documents.filter((doc) => doc.resource_type !== 'original_story'
      && [naturalDocumentTitle(doc), doc.display_title].some((name) => titleKey(name) === titleKey(title)))
    const state = availability(matches, store, 'summary')
    if (matches.length > 1) { state.status = 'ambiguous'; state.message = '同名梗概对应多篇资料，请先检索以选择具体 document_uid。' }
    return { title, search: { query: title, games: ['endfield'] },
      read: matches.length === 1 ? { document_uid: documentUid(matches[0].document_id), mode: 'document' }
        : { title, mode: 'document' }, availability: state }
  })
  const summary = summaries[0] ?? null
  const collections = row.collection_names.map((name) => {
    const matches = documents.filter((doc) => doc.document_type === 'story' && doc.document_kind === 'story'
      && doc.resource_type === 'original_story' && NARRATIVE.has(doc.content_type)
      && normalize(doc.collection_name) === normalize(name))
    const ids = new Set(matches.map((doc) => doc.collection_id || ''))
    const state = availability(matches, store, 'collection')
    if (ids.size > 1) { state.status = 'ambiguous'; state.message = '同名任务对应多个集合，请先检索具体篇章后使用 document_uid。' }
    return { name, search: { games: ['endfield'], collection_names: [name], resource_types: ['original_story'] },
      read: { collection_name: name, mode: 'collection' }, availability: state }
  })
  const index = catalog.chapters.indexOf(row)
  const neighbor = (value) => value ? { id: value.id, title: value.title,
    navigate: { query: value.id, game: 'endfield' } } : null
  const states = [...summaries, ...collections].map((value) => value.availability.status)
  const missionIds = new Set((row.missions || []).map((mission) => mission.id))
  const missionMetadata = row.mission_metadata ?? (catalog.mission_metadata || [])
    .filter((mission) => missionIds.has(mission.id) || missionIds.has(mission.name_alias_of))
  return { id: row.id, title: row.title, aliases: row.aliases ?? [], title_en: row.title_en ?? null,
    chapter_title: row.chapter_title ?? null, chapter_number: row.chapter_number, process_number: row.process_number,
    order: row.order, version: row.version ?? null, evidence: row.evidence ?? null,
    summary_title: row.summary_title ?? null, summary_titles: summaries.map((item) => item.title),
    summary_coverage_note: row.summary_coverage_note ?? null, collection_names: [...row.collection_names],
    collection_order: row.collection_order ?? (row.mission_order_status === 'community_explicit_order' ? 'community_explicit_order' : 'unknown'),
    collection_order_evidence: row.collection_order_evidence ?? (row.missions || []).filter((mission) => mission.order_source)
      .map((mission) => ({ id: mission.id, order: mission.order, source: mission.order_source })),
    missions: row.missions ?? [], unresolved_missions: row.unresolved_missions ?? [],
    mission_order_status: row.mission_order_status ?? 'unknown', classification_source: row.classification_source ?? null,
    mission_metadata: missionMetadata, classification: row.classification ?? null,
    classification_note: '任务分类以原始 missionType/mission_type 等任务元数据及其证据为准；章/进程顺序以独立源表 order 和 evidence 为准。Wiki 角色分类不等于游戏任务类型；chapter_bitmask 不等于章编号。',
    summary, summaries, collections, availability: { status: !states.length ? 'unmapped'
      : states.every((state) => state === 'available') ? 'available'
        : states.some((state) => state === 'available') ? 'partial'
          : states.includes('ambiguous') ? 'ambiguous' : states.every((state) => state === 'not_installed') ? 'not_installed' : 'missing',
    message: 'availability 仅描述当前本地资料覆盖，不判断剧情是否存在。' },
    prev: neighbor(catalog.chapters[index - 1]), next: neighbor(catalog.chapters[index + 1]) }
}

/** store.navigationCatalogPath optionally injects a catalog file (e.g. a temporary test fixture).
 * No catalog or availability cache: each invocation is bound to its corpus snapshot. */
export async function executeNavigation(store, raw, { allowedGames = ['arknights', 'endfield'], signal } = {}) {
  let snapshot
  try {
    active(signal)
    const query = request(raw, allowedGames).replace(/明日方舟\s*[:：]?\s*终末地/gu, '终末地')
    if (/arknights/iu.test(query) || (/明日方舟/u.test(query) && !/终末地/u.test(query))) throw fault('UNSUPPORTED_GAME', '当前仅支持终末地主线导航，不支持明日方舟（arknights）。明日方舟请改用 timeline_search（活动时间位置）、corpus_search({activity_names:[活动名]}) 列篇目，或 corpus_read({stage_code:"1-7"}) 直接读关卡。')
    await store.ready()
    snapshot = corpusVersionSnapshot(store)
    active(signal)
    let bytes
    try { bytes = await readFile(store.navigationCatalogPath ?? DEFAULT_CATALOG, { encoding: 'utf8', signal }) }
    catch (error) {
      if (error.code === 'ENOENT') throw fault('NAVIGATION_CATALOG_UNAVAILABLE', '当前未安装终末地主线导航目录；不能据此判断主线剧情是否存在')
      throw error
    }
    assertCorpusVersion(store, snapshot)
    active(signal)
    let parsed
    try { parsed = JSON.parse(bytes) } catch { throw fault('NAVIGATION_CATALOG_INVALID', '主线目录不是有效 JSON') }
    const catalog = validateCatalog(parsed)
    const selection = select(catalog, query)
    const documents = [...store.documents.values()].map((record) => record.document)
      .filter((doc) => doc && documentGame(doc) === 'endfield')
    const allEntries = catalog.chapters.map((row) => entry(row, catalog, documents, store))
    const available = (row) => row.availability.status === 'available' || row.availability.status === 'partial'
    const latestAvailable = allEntries.findLast(available)
    if (selection.mode === 'latest' && latestAvailable) {
      const coveredVersion = [...catalog.versions].reverse().find((row) => row.chapter_ids.includes(latestAvailable.id))
      selection.version = coveredVersion
      selection.rows = catalog.chapters.filter((row) => coveredVersion
        ? coveredVersion.chapter_ids.includes(row.id) && available(allEntries.find((item) => item.id === row.id))
        : row.id === latestAvailable.id)
      selection.message = '最新指按源表顺序当前本地可定位的最新主线；版本归属仅使用 versions.chapter_ids 明确映射，不代表实时游戏最新。'
    }
    const entries = allEntries.filter((row) => selection.rows.some((selected) => selected.id === row.id))
    const warnings = []
    if (store.packs instanceof Map && !store.packs.has('endfield_official_game')) warnings.push({
      code: 'CORPUS_GAME_NOT_INSTALLED', message: '终末地官方原文本地资料包未安装；不代表没有主线剧情。' })
    if (entries.some((row) => row.availability.status !== 'available')) warnings.push({
      code: 'NAVIGATION_CONTENT_UNAVAILABLE', message: '部分导航资料尚未在当前本地目录完整定位；请查看逐项 availability，不代表没有剧情。' })
    if (selection.mode === 'latest' && !latestAvailable) warnings.push({
      code: 'NO_LOCAL_MAINLINE', message: '当前目录没有可用的本地主线资料；所列仅为目录映射边界，不宣称已安装覆盖。' })
    const mapped = [...catalog.versions].reverse().find((version) => version.chapter_ids.length)
    const versions = catalog.versions.map((row) => ({ ...row,
      mapping_status: row.mapping_status ?? (row.chapter_ids.length ? 'mapped' : 'unmapped') }))
    assertCorpusVersion(store, snapshot)
    active(signal)
    return { contract_version: CONTRACT, status: selection.status || (entries.length ? 'ok' : 'not_found'),
      game: 'endfield', data_version: snapshot.dataVersion ?? null, query, mode: selection.mode,
      navigation_level: 'process',
      ordering_note: catalog.ordering_note ?? null, classification_note: catalog.classification_note ?? null,
      mission_metadata: catalog.mission_metadata ?? [],
      source_game_version: catalog.source_game_version,
      version_boundary: { source_game_version: catalog.source_game_version, latest_mapped_version: mapped?.version ?? null,
        latest_catalog_version: catalog.versions.at(-1)?.version ?? null,
        latest_available_chapter_id: latestAvailable?.id ?? null,
        latest_available_version: [...catalog.versions].reverse().find((row) => row.chapter_ids.includes(latestAvailable?.id))?.version ?? null,
        note: '仅为当前资料目录覆盖边界；不代表实时游戏最新。' },
      warnings, versions, ...(selection.version ? { version: versions.find((row) => row.version === selection.version.version) } : {}),
      ...(selection.anchor ? { anchor: selection.anchor } : {}), entries,
      ...(selection.message ? { message: selection.message } : {}) }
  } catch (error) {
    try { if (snapshot) assertCorpusVersion(store, snapshot) } catch (changed) { error = changed }
    return { contract_version: CONTRACT, status: 'error', game: 'endfield', data_version: store?.dataVersion ?? null,
      error: { code: error.name === 'AbortError' ? 'CANCELLED' : error.code || 'INTERNAL_ERROR',
        message: error.name === 'AbortError' ? '主线导航已取消' : error.message,
        retryable: Boolean(error.retryable) } }
  }
}

/** Host render(args, value); the single-argument form also supports standalone projections. */
export function renderNavigation(args, value) {
  const result = value === undefined ? args : value
  if (result.error) return [{ type: 'text', text: `[corpus_navigate:error] ${result.error.code}: ${result.error.message}` }]
  const lines = [`[corpus_navigate:${result.mode}] status=${result.status}`,
    `资料版本边界：${result.source_game_version}；最新明确映射：${result.version_boundary.latest_mapped_version ?? '未映射'}。${result.version_boundary.note}`]
  if (result.message) lines.push(result.message)
  for (const warning of result.warnings || []) lines.push(`提示 ${warning.code}：${warning.message}`)
  if (result.mode === 'directory') {
    lines.push('目录按源表明确的章/进程 order 排列；任务数仅表示集合成员数量，不表示严格任务顺序。来源与任务分类证据见条目详情。')
    lines.push(`版本映射：${result.versions.map((row) => `${row.version}:${row.mapping_status}`).join('；').slice(0, 1200)}`)
    for (const row of result.entries) {
      const label = `第${row.chapter_number}章${row.process_number === null ? '' : `·第${row.process_number}进程`}`
      const alias = row.aliases.length ? `（别名：${row.aliases.slice(0, 2).join('、').slice(0, 80)}）` : ''
      const line = `${label} ${row.title.slice(0, 160)}${alias} · ${row.collections.length}任务 [${row.availability.status}] collection_order=${row.collection_order}；corpus_navigate(${JSON.stringify({ query: row.id })})`
      if (lines.join('\n').length + line.length > 7800) { lines.push('更多条目请按明确章节/进程查询；完整目录保留在 JSON 结果中。'); break }
      lines.push(line)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }
  const versions = result.version ? [result.version] : result.versions
  for (const version of versions) {
    const evidence = compactEvidence(version.evidence)
    lines.push(`版本 ${version.version} ${version.title}：mapping_status=${version.mapping_status}${evidence ? `；依据：${evidence}` : ''}`)
  }
  for (const row of result.entries) {
    lines.push(`${row.order}. ${row.title}（第${row.chapter_number}章${row.process_number === null ? '' : ` · 第${row.process_number}进程`}；${row.version ?? '版本未映射'}）[${row.availability.status}]`)
    const metadata = compactMissionMetadata(row.mission_metadata)
    const orderEvidence = compactEvidence(row.evidence)
    lines.push(`任务元数据：${metadata || '无'}${row.classification?.basis ? `；分类依据 ${row.classification.basis}` : ''}。${row.classification_note}`)
    if (orderEvidence) lines.push(`顺序证据：${orderEvidence}`)
    for (const summary of row.summaries) lines.push(`梗概 ${summary.title} [${summary.availability.status}]：corpus_read(${JSON.stringify(summary.read)})；也可 corpus_search(${JSON.stringify(summary.search)})`)
    lines.push(`任务集合（collection_order=${row.collection_order}${row.collection_order === 'unknown' ? '；任务顺序尚未核实，下列排列不代表严格剧情顺序' : ''}）：`)
    for (const collection of row.collections) lines.push(`- ${collection.name} [${collection.availability.status}]：corpus_read(${JSON.stringify(collection.read)})`)
    lines.push(row.availability.message, `上一段：${row.prev ? `${row.prev.title} corpus_navigate(${JSON.stringify(row.prev.navigate)})` : '当前目录边界'}；下一段：${row.next ? `${row.next.title} corpus_navigate(${JSON.stringify(row.next.navigate)})` : '当前目录边界'}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/** 证据只展示种类与结论；URL、源文件路径等留在结构化结果里，不进入模型可见文本。 */
function compactEvidence(evidence) {
  if (!Array.isArray(evidence) || !evidence.length) return ''
  return evidence.map((item) => {
    if (typeof item === 'string') return /^(?:\/|[A-Za-z]:\\|https?:)/u.test(item) ? '' : item
    if (!item || typeof item !== 'object') return ''
    return [item.kind, item.claim].filter(Boolean).join('：')
  }).filter(Boolean).join('；').slice(0, 400)
}

const MISSION_SCALAR_KEYS = /(?:^id$|mission_?id|^name$|type|bitmask|char_?id)/iu

/** 每个任务只保留 id/名称/类型/位掩码等判别字段，去掉源文件路径与导出细节。 */
function compactMissionMetadata(metadata) {
  if (!Array.isArray(metadata) || !metadata.length) return ''
  return metadata.slice(0, 12).map((mission) => {
    if (!mission || typeof mission !== 'object') return ''
    const fields = Object.entries(mission)
      .filter(([key, value]) => MISSION_SCALAR_KEYS.test(key) && !/export/iu.test(key)
        && (typeof value === 'number' || (typeof value === 'string' && value && value.length <= 40)))
      .map(([key, value]) => `${key}=${value}`)
    return fields.join(',')
  }).filter(Boolean).join('；') + (metadata.length > 12 ? `；另 ${metadata.length - 12} 项` : '')
}
