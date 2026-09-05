/** 云端候选来源 → 本地资料包篇章/官方行号映射。 */
import { documentGame, documentUid, naturalDocumentTitle } from './store.js'

function normalizedStoryIdentifier(value) {
  let identifier = String(value || '').trim().replaceAll('\\', '/')
  if (!identifier) return ''
  identifier = identifier.replace(/^story:\/\//, '').replace(/^story:/, '')
  identifier = identifier.replace(/^.*?gamedata\/story\//, '').replace(/^stories\//, '')
  identifier = identifier.replace(/\.txt(?:(?:#|:|\/)(?:L|line[-_:]?)?\d+)?$/i, '')
  identifier = identifier.replace(/(?:(?:#|:|\/)(?:L|line[-_:]?)\d+)$/i, '')
  return identifier.replace(/^\/+|\/+$/g, '')
}

function sourcePathVariants(value) {
  const variants = new Set()
  for (const part of String(value || '').split(';')) {
    const raw = part.trim().replaceAll('\\', '/').replace(/^\.\//, '')
    if (!raw) continue
    const relative = raw.replace(/^.*?documents\/official_game\//, '')
      .replace(/^.*?official_game\//, '').replace(/^.*?gamedata\/story\//, '')
    variants.add(raw); variants.add(relative)
    if (!relative.startsWith('stories/')) variants.add(`stories/${relative}`)
    if (!/\.txt$/i.test(relative)) {
      variants.add(`${relative}.txt`)
      if (!relative.startsWith('stories/')) variants.add(`stories/${relative}.txt`)
    }
  }
  return [...variants]
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

/** 从 cloud_search/cloud_inspect 的任意嵌套响应收集来源提示。 */
export function collectSourceHints(value, found = new Map()) {
  if (!value || typeof value !== 'object' || found.size >= 200) return [...found.values()]
  if (Array.isArray(value)) {
    for (const item of value) collectSourceHints(item, found)
    return [...found.values()]
  }
  if (value.source_file || value.source_id || value.doc_id || value.document_id
      || value.story_id || value.source_story_id || (value.title && (value.start_line || value.line_range))) {
    const excerpt = [value.content_preview, value.content, value.summary, value.text]
      .find((item) => typeof item === 'string' && item.trim())
    const hint = {
      evidence_id: String(value.evidence_id || ''), candidate_id: String(value.candidate_id || ''),
      game: String(value.game || ''),
      source_file: String(value.source_file || ''), source_id: String(value.source_id || ''),
      doc_id: String(value.doc_id || ''), document_id: String(value.document_id || ''),
      story_id: String(value.story_id || ''), source_story_id: String(value.source_story_id || ''),
      story_code: String(value.story_code || ''), start_line: Number(value.start_line || 0),
      end_line: Number(value.end_line || 0), line_range: String(value.line_range || ''),
      activity_name: String(value.activity_name || ''),
      character_name: String(value.character_name || ''),
      selected_rank: Number(value.selected_rank || 0) || null,
      title: String(value.title || value.story_title || ''), source_type: String(value.source_type || ''),
      score: Number(value.ranking_score || value.score || 0),
      query_variant: String(value.query_variant || ''), excerpt: String(excerpt || '').slice(0, 1600),
    }
    found.set(canonical(hint), hint)
  }
  for (const child of Object.values(value)) collectSourceHints(child, found)
  return [...found.values()]
}

function readableStoryRecord(store, found) {
  const sourceStoryId = String(found?.record?.document?.source_story_id || '')
  if (found?.record?.document?.document_kind !== 'synopsis' || !sourceStoryId.startsWith('[uc]info/')) {
    return Promise.resolve(found)
  }
  return store.getDocumentBySourceStoryId(sourceStoryId.slice('[uc]info/'.length))
    .then((full) => full?.record?.document?.document_kind === 'story' ? full : found)
}

function metadataMatches(store, predicate) {
  const matches = []
  for (const [documentId, location] of store.documents) {
    if (predicate(location.document)) matches.push(documentId)
  }
  return matches
}

function normalizedBasename(value) {
  const path = String(value || '').trim().replaceAll('\\', '/').replace(/[?#].*$/u, '')
  return path.slice(path.lastIndexOf('/') + 1).toLocaleLowerCase()
}

function normalizedSourcePath(value) {
  return String(value || '').trim().replaceAll('\\', '/').replace(/^\.\//u, '')
    .replace(/[?#].*$/u, '').replace(/^\/+|\/+$/gu, '')
}

function documentSourcePaths(document = {}) {
  return [...new Set([document.parent_source_path, document.path]
    .map(normalizedSourcePath).filter(Boolean))]
}

function sourcePathCandidateIds(store, sourceFile, { basenameOnly = false } = {}) {
  const variants = sourcePathVariants(sourceFile).map(normalizedSourcePath).filter(Boolean)
  const basenames = new Set(variants.map(normalizedBasename).filter(Boolean))
  const matches = []
  for (const [documentId, location] of store.documents) {
    const sources = documentSourcePaths(location.document)
    const matched = basenameOnly
      ? sources.some((source) => basenames.has(normalizedBasename(source)))
      : sources.some((source) => variants.includes(source))
    if (matched) matches.push(documentId)
  }
  return matches
}

function metadataHintScore(document, hint) {
  const descriptor = compactText(`${hint.title} ${hint.source_id} ${hint.doc_id}`)
  const activity = compactText(document.activity_name)
  const character = compactText(document.character_name)
  const explicitActivity = compactText(hint.activity_name)
  const explicitCharacter = compactText(hint.character_name)
  let score = 0
  if (explicitActivity) score += explicitActivity === activity ? 400 : -400
  else if (activity && descriptor.includes(activity)) score += 120
  if (explicitCharacter) score += explicitCharacter === character ? 300 : -300
  else if (character && descriptor.includes(character)) score += 80
  const parentStart = Number(document.parent_line_start || 0)
  const parentEnd = Number(document.parent_line_end || 0)
  if (hint.start_line > 0 && parentStart > 0 && parentEnd >= parentStart
      && parentStart <= hint.start_line && hint.start_line <= parentEnd) score += 240
  return score
}

function metadataHintCompatible(document, hint) {
  const activity = compactText(document.activity_name)
  const character = compactText(document.character_name)
  const explicitActivity = compactText(hint.activity_name)
  const explicitCharacter = compactText(hint.character_name)
  if (explicitActivity && activity && explicitActivity !== activity) return false
  if (explicitCharacter && character && explicitCharacter !== character) return false
  return true
}

async function disambiguateSourceCandidates(store, candidateIds, hint) {
  if (!candidateIds.length) return null
  const scored = []
  for (const documentId of candidateIds) {
    const found = await store.getDocument(documentId)
    if (!found || !metadataHintCompatible(found.record.document, hint)) continue
    const excerptMatch = locateExcerpt(found.record, hint.excerpt)
    const excerptScore = excerptMatch.line ? 300 + excerptMatch.score : 0
    scored.push({ found, score: metadataHintScore(found.record.document, hint) + excerptScore })
  }
  if (scored.length === 1) return scored[0].found
  scored.sort((left, right) => right.score - left.score
    || String(left.found.record.document.document_id)
      .localeCompare(String(right.found.record.document.document_id), 'en'))
  if (!scored[0] || scored[0].score <= 0 || scored[0].score === scored[1]?.score) return null
  return scored[0].found
}

/**
 * 同一 story_code 可能同时有行动前、行动后和幕间。优先使用云端文件名中的
 * part_label 消歧；仍有多个候选时，再用云端摘录在各篇本地正文中定位。
 */
async function disambiguateStoryCode(store, hint) {
  const candidates = metadataMatches(store,
    (document) => String(document.story_code || '') === hint.story_code
      && document.document_type === 'story' && document.document_kind === 'story')
  if (candidates.length === 1) return store.getDocument(candidates[0])
  if (!candidates.length) return null
  const descriptor = `${hint.source_file} ${hint.story_id} ${hint.title}`
  const scored = []
  for (const documentId of candidates) {
    const found = await store.getDocument(documentId)
    if (!found) continue
    const document = found.record.document
    const partMatched = document.part_label && descriptor.includes(document.part_label)
    const titleMatched = document.display_title && descriptor.includes(document.display_title)
    const excerptLine = locateExcerptLine(found.record, hint.excerpt)
    const lineFits = Number(hint.end_line || hint.start_line || 0) <= found.record.lines.length
    scored.push({ found, score: (excerptLine ? 100 : 0) + (partMatched ? 20 : 0)
      + (titleMatched ? 10 : 0) + (lineFits ? 1 : 0) })
  }
  scored.sort((a, b) => b.score - a.score)
  if (!scored[0]?.score || scored[0].score === scored[1]?.score) return null
  return scored[0].found
}

async function locateDocument(store, hint) {
  for (const identifier of [hint.document_id, hint.doc_id, hint.source_id].filter(Boolean)) {
    const direct = await store.getDocument(identifier)
    if (direct) return { found: direct, method: 'document_id' }
  }
  const storyIdentifiers = [hint.source_story_id, hint.story_id, hint.source_file,
    hint.source_id, hint.doc_id].map(normalizedStoryIdentifier).filter(Boolean)
  for (const identifier of storyIdentifiers) {
    const bySourceStory = await store.getDocumentBySourceStoryId(identifier)
    if (bySourceStory) return { found: bySourceStory, method: 'source_story_id' }
  }
  for (const path of sourcePathVariants(hint.source_file)) {
    const byPath = await store.getDocumentByPath(path)
    if (byPath) return { found: byPath, method: 'source_file' }
  }
  const exactSourceIds = sourcePathCandidateIds(store, hint.source_file)
  const exactSource = await disambiguateSourceCandidates(store, exactSourceIds, hint)
  if (exactSource) return { found: exactSource, method: 'parent_source_file' }
  const basenameIds = sourcePathCandidateIds(store, hint.source_file, { basenameOnly: true })
  const basename = await disambiguateSourceCandidates(store, basenameIds, hint)
  if (basename) return { found: basename, method: 'source_file_basename' }
  if (hint.story_code) {
    const found = await disambiguateStoryCode(store, hint)
    if (found) return { found, method: 'story_code' }
  }
  if (hint.title) {
    const ids = store.naturalTitleIndex.get(hint.title) || store.titleIndex.get(hint.title) || []
    if (ids.length === 1) return { found: await store.getDocument(ids[0]), method: 'title' }
  }
  return null
}

const compactText = (value) => String(value || '').normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '')

/** 云端缺可靠行号时，用摘录在已确定篇章内找最可信的官方行。 */
function locateExcerpt(record, excerpt) {
  const compactExcerpt = compactText(excerpt)
  if (compactExcerpt.length < 4) return { line: 0, score: 0 }
  let best = { line: 0, score: 0 }
  for (const line of record.lines || []) {
    const text = compactText(line.text)
    if (text.length < 4) continue
    if (compactExcerpt.includes(text)) {
      const score = Math.min(text.length, 200)
      if (score > best.score) best = { line: line.line_number, score }
    } else if (text.includes(compactExcerpt)) {
      const score = Math.min(compactExcerpt.length, 200)
      if (score > best.score) best = { line: line.line_number, score }
    }
  }
  return best
}

function locateExcerptLine(record, excerpt) {
  return locateExcerpt(record, excerpt).line
}

function localLineFromSource(document, sourceLine) {
  if (!Number.isInteger(sourceLine) || sourceLine < 1) return 0
  const parentStart = Number(document.parent_line_start || 0)
  const parentEnd = Number(document.parent_line_end || 0)
  if (!parentStart || parentEnd < parentStart) return sourceLine
  if (sourceLine < parentStart || sourceLine > parentEnd) return 0
  const localStart = Number(document.parent_span_local_start || 1)
  return localStart + sourceLine - parentStart
}

/**
 * 将云端来源提示映射为本地稳定文档。模型主要看到 title/document_uid/line，
 * 完整 source_ref 仅留在结构化响应和审计数据中。
 */
export async function resolveCloudSources(store, hints, { signal } = {}) {
  await store.ready()
  const mappings = []
  const seen = new Set()
  for (const hint of hints.slice(0, 200)) {
    if (signal?.aborted) throw Object.assign(new Error('云端来源映射已取消'), { code: 'CANCELLED' })
    const located = await locateDocument(store, hint)
    if (!located?.found) continue
    const found = await readableStoryRecord(store, located.found)
    const record = found.record
    const document = record.document
    const key = `${hint.evidence_id || hint.candidate_id || canonical(hint)}:${document.document_id}`
    if (seen.has(key)) continue
    seen.add(key)
    const requestedStart = Number(hint.start_line || 0)
    let line = localLineFromSource(document, requestedStart)
    let lineMethod = document.parent_line_start ? 'parent_line' : 'cloud_line'
    if (line < 1 || line > record.lines.length) {
      line = locateExcerptLine(record, hint.excerpt)
      lineMethod = line ? 'excerpt_match' : 'document_only'
    }
    const endLine = localLineFromSource(document, Number(hint.end_line || 0))
    const uid = documentUid(document.document_id)
    const title = naturalDocumentTitle(document)
    const titleAmbiguous = (store.naturalTitleIndex.get(title) || []).length > 1
    mappings.push({
      game: documentGame(document),
      document_id: String(document.document_id || ''),
      source_ref_prefix: String(document.source_ref_prefix || ''),
      document_uid: uid, title,
      display_title: String(document.display_title || ''),
      title_ambiguous: titleAmbiguous,
      document_type: String(document.document_type || ''), document_kind: String(document.document_kind || ''),
      activity_name: String(document.activity_name || ''), story_name: String(document.story_name || ''),
      character_name: String(document.character_name || ''), line_count: Number(document.line_count || record.lines.length),
      parent_source_path: String(document.parent_source_path || ''),
      line: line || null, line_end: endLine > 0 && endLine <= record.lines.length ? endLine : null,
      source_ref: line ? `${document.source_ref_prefix}:L${line}` : null,
      suggested_source_ref: line ? `${document.source_ref_prefix}:L${line}` : '',
      start_line: line || 0,
      end_line: endLine > 0 && endLine <= record.lines.length ? endLine : line || 0,
      line_range: line ? (endLine > line && endLine <= record.lines.length ? `${line}-${endLine}` : `${line}`) : '',
      mapping_method: located.method, line_method: lineMethod,
      evidence_id: hint.evidence_id, candidate_id: hint.candidate_id,
      selected_rank: hint.selected_rank, source_type: hint.source_type,
      excerpt: hint.excerpt,
      recommended_read: line
        ? { title, ...(titleAmbiguous ? { document_uid: uid } : {}), line, before: 4, after: 8 }
        : { title, mode: 'document' },
    })
  }
  return mappings
}

/** 给成功的云端响应附加本地映射；无来源或无命中时保持成功响应。 */
export async function attachLocalSourceMappings(store, response, { signal } = {}) {
  if (!response || response.status === 'error') return response
  const hints = collectSourceHints(response.data ?? response)
  if (!hints.length) return response
  const mappings = await resolveCloudSources(store, hints, { signal })
  if (mappings.length) response.local_source_mappings = mappings
  return response
}
