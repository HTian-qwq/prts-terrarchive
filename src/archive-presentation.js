/** Bounded, durable UI material records. Never include a raw remote response or host paths. */
import { createHash } from 'node:crypto'
import { documentUid } from './store.js'
import { projectCloudSearch } from './cloud-projection.js'

const MAX_SOURCES = 128
const MAX_EXCERPT = 1600
const text = (value, max = MAX_EXCERPT) => typeof value === 'string' ? value.slice(0, max) : ''
const version = (value) => /^[a-f0-9]{64}$/u.test(value || '') ? value : undefined
const idFor = (origin, dataVersion, identity) => `${origin}:${createHash('sha256')
  .update(JSON.stringify([dataVersion || '', identity])).digest('hex').slice(0, 32)}`
const localId = (dataVersion, documentId) => `document:${dataVersion}:${documentUid(documentId)}`
const range = (start, end = start) => Number.isSafeInteger(Number(start)) && Number(start) > 0
  && Number.isSafeInteger(Number(end)) && Number(end) >= Number(start)
  ? { start: Number(start), end: Number(end) } : null
const rangesFor = (values) => [...new Map(values.filter(Boolean)
  .map((value) => [`${value.start}:${value.end}`, value])).values()].slice(0, 128)
const locations = (ranges) => ranges.length ? {
  lineStart: ranges[0].start, lineEnd: ranges[0].end, ranges,
} : {}

function envelope(sources, dataVersion) {
  return { kind: 'prts-archive-sources-v1', sources: sources.slice(0, MAX_SOURCES),
    ...(version(dataVersion) ? { data_version: dataVersion } : {}),
    ...(sources.length > MAX_SOURCES ? { sources_truncated: true } : {}) }
}

/** Capture at execution time: later release switches cannot relabel old tool results. */
export function rememberArchivePresentation(value, metadata) {
  // DSH snapshots the tool value before rendering; a WeakMap/non-enumerable
  // attachment would disappear. Renderers deliberately ignore this UI field.
  return { ...value, presentation: metadata }
}

export function archivePresentationMeta(_args, value) {
  if (value?.status === 'error' || value?.error) return { ...envelope([]),
    error: text(value?.error?.message || value?.error, 600) || '资料检索未完成' }
  return value?.presentation?.kind === 'prts-archive-sources-v1'
    ? value.presentation : envelope([])
}

const PTC_RECEIPT_TYPE = 'prts-archive-receipt'
const PTC_TOOLS = new Set(['corpus_search', 'corpus_read', 'timeline_search', 'cloud_search', 'cloud_inspect'])
const MAX_RECEIPT_BYTES = 512 * 1024
const MAX_PENDING_BYTES = 2 * 1024 * 1024
const MAX_PENDING_CALLS = 64
const PENDING_LIFETIME_MS = 5 * 60 * 1000
const receiptIdentity = (value, max = 1024) => typeof value === 'string' && value.length <= max ? value : ''

/** Keep the log extension as bounded as the native presentationMeta contract. */
function boundedReceiptMeta(value) {
  if (!value || !['prts-archive-sources-v1', 'prts-corpus-read-v1'].includes(value.kind)) return null
  const dataVersion = version(value.data_version)
  if (value.kind === 'prts-corpus-read-v1') {
    const documentId = receiptIdentity(value.locator?.document_id)
    if (!documentId || !dataVersion) return null
    const primaryRange = range(value.line_start, value.line_end)
    return { kind: value.kind, locator: { document_id: documentId }, data_version: dataVersion,
      title: text(value.title, 512),
      ...(primaryRange ? { line_start: primaryRange.start, line_end: primaryRange.end } : {}),
      sources: (Array.isArray(value.sources) ? value.sources : []).slice(0, MAX_SOURCES).flatMap((source) => {
        const id = receiptIdentity(source?.document_id)
        const selected = range(source?.line_start, source?.line_end)
        if (!id || !selected) return []
        return [{ document_id: id, document_uid: documentUid(id), title: text(source.title, 512),
          line_start: selected.start, line_end: selected.end }]
      }), ...(value.sources_truncated ? { sources_truncated: true } : {}) }
  }
  const sources = (Array.isArray(value.sources) ? value.sources : []).slice(0, MAX_SOURCES).flatMap((source) => {
    const id = receiptIdentity(source?.id), title = text(source?.title, 512)
    if (!id || !title) return []
    const selected = rangesFor((Array.isArray(source.ranges) ? source.ranges : []).slice(0, MAX_SOURCES)
      .map((item) => range(item?.start, item?.end)))
    const first = range(source.lineStart, source.lineEnd)
    const sourceVersion = version(source.dataVersion)
    const url = safeUrl(source.url)
    return [{ id, title, kind: text(source.kind, 80),
      origin: ['local', 'cloud', 'web'].includes(source.origin) ? source.origin : 'local',
      state: ['found', 'read', 'cited'].includes(source.state) ? source.state : 'found',
      excerpt: text(source.excerpt), ...(source.agentRead === true ? { agentRead: true } : {}),
      ...(receiptIdentity(source.documentId) ? { documentId: source.documentId } : {}),
      ...(receiptIdentity(source.documentUid, 128) ? { documentUid: source.documentUid } : {}),
      ...(receiptIdentity(source.sourceRef) ? { sourceRef: source.sourceRef } : {}),
      ...(sourceVersion ? { dataVersion: sourceVersion } : {}), ...(url ? { url } : {}),
      ...locations(selected.length ? selected : first ? [first] : []),
      ...(Array.isArray(source.readRanges) ? { readRanges: rangesFor(source.readRanges.slice(0, MAX_SOURCES)
        .map((item) => range(item?.start, item?.end))) } : {}) }]
  })
  return { ...envelope(sources, dataVersion),
    ...(value.sources_truncated ? { sources_truncated: true } : {}),
    ...(typeof value.error === 'string' && value.error ? { error: text(value.error, 600) } : {}) }
}

/**
 * DSH 0.1.5 omits presentationMeta on nested run_code dispatches. Observe the
 * final, frozen value synchronously, then attach a structured ContentBlock only
 * to tools/ptc-dispatch-log. That official seam changes the human log copy;
 * deriveMessages ignores these events, and neither render() nor the value
 * delivered to the running program/model is changed. No identity is inferred
 * from the rendered prose. ContentBlock is a merge-extensible host contract.
 */
export function installArchivePtcReceipts(ctx, readMetadata) {
  if (typeof ctx.on !== 'function') return false
  let pending = new WeakMap()
  let disposed = false
  const drop = (state, key) => {
    const item = state.items.get(key)
    if (!item) return
    state.bytes -= item.bytes
    state.items.delete(key)
  }
  ctx.on('tools/result', (exec, result) => {
    if (disposed || exec?.parent === undefined || !exec.agent || typeof exec.agent !== 'object'
        || !PTC_TOOLS.has(exec.name)) return
    const callId = String(exec.callId || '')
    if (!callId || callId.length > 512) return
    let state = pending.get(exec.agent)
    if (state) drop(state, callId)
    if (result?.isError || !result?.value) return
    let meta, bytes
    try {
      const failed = result.value.error || result.value.status === 'error'
      const metadata = exec.name === 'corpus_read' && !failed
        ? readMetadata(exec.arguments, result.value)
        : archivePresentationMeta(exec.arguments, result.value)
      meta = boundedReceiptMeta(metadata)
      if (!meta) return
      bytes = Buffer.byteLength(JSON.stringify(meta), 'utf8')
      while (bytes > MAX_RECEIPT_BYTES && meta.sources.length) {
        meta.sources = meta.sources.slice(0, Math.floor(meta.sources.length / 2))
        meta.sources_truncated = true
        bytes = Buffer.byteLength(JSON.stringify(meta), 'utf8')
      }
    } catch {
      // Optional UI receipts must never interfere with tool completion when
      // a failed or replaced tool supplies no valid presentation projection.
      return
    }
    if (bytes > MAX_RECEIPT_BYTES) return
    if (!state) { state = { items: new Map(), bytes: 0 }; pending.set(exec.agent, state) }
    const now = Date.now()
    for (const [key, item] of state.items) if (now - item.time > PENDING_LIFETIME_MS) drop(state, key)
    while (state.items.size >= MAX_PENDING_CALLS || state.bytes + bytes > MAX_PENDING_BYTES) {
      const oldest = state.items.keys().next().value
      if (oldest === undefined) break
      drop(state, oldest)
    }
    state.items.set(callId, { parent: exec.parent, tool: exec.name, meta, bytes, time: now })
    state.bytes += bytes
  })
  ctx.on('tools/ptc-dispatch-log', async (dispatch, next) => {
    const content = await next()
    if (disposed || !dispatch.agent || !PTC_TOOLS.has(dispatch.name)) return content
    const state = pending.get(dispatch.agent)
    const callId = String(dispatch.subCallId || '')
    const item = state?.items.get(callId)
    if (!item || item.parent !== dispatch.exec?.token || item.tool !== dispatch.name) return content
    drop(state, callId)
    if (dispatch.isError || Date.now() - item.time > PENDING_LIFETIME_MS) return content
    return [...content, { type: PTC_RECEIPT_TYPE, version: 1, callId,
      parentCallId: String(dispatch.exec.callId), tool: item.tool, meta: item.meta }]
  })
  ctx.effect?.(() => () => { disposed = true; pending = new WeakMap() }, 'prts-corpus: PTC archive receipts')
  return true
}

function localDocumentId(store, item) {
  if (item.document_uid) return store.getDocumentIdByUid?.(item.document_uid) || null
  const naturalIds = store.naturalTitleIndex?.get(item.title) || []
  const ids = naturalIds.length ? naturalIds : store.titleIndex?.get(item.title) || []
  // Ambiguous titles must remain unlinked; choosing an arbitrary document is unsafe.
  return ids.length === 1 ? ids[0] : null
}

export function localArchivePresentation(store, value, dataVersion = store.dataVersion) {
  if (value?.error || value?.status === 'error') return envelope([], dataVersion)
  const sources = (value?.documents || []).slice(0, MAX_SOURCES + 1).map((item) => {
    const documentId = localDocumentId(store, item)
    const ranges = rangesFor((item.matches || []).map((match) => range(match.line_start, match.line_end)))
    const excerpt = (item.matches || []).flatMap((match) => match.excerpt || [])
      .map((line) => `${line.speaker ? `${line.speaker}：` : ''}${text(line.text)}`).join('\n')
      || (item.section_content?.blocks || []).map((block) => text(block.text)).join('\n')
      || [item.entity_summary?.description, item.entity_summary?.history_summary].filter(Boolean).join('\n')
    return { id: documentId ? localId(dataVersion, documentId)
      : idFor('local', dataVersion, item.document_uid || [item.game, item.resource_type, item.title]),
      title: text(item.title, 512), kind: text(item.resource_type, 80), origin: 'local', state: 'found',
      excerpt: text(excerpt), ...(documentId ? { documentId, documentUid: documentUid(documentId) } : {}),
      ...(version(dataVersion) ? { dataVersion } : {}), ...locations(ranges) }
  })
  return envelope(sources, dataVersion)
}

const PUBLIC_URL_PARAMETERS = new Set(['title', 'oldid', 'diff', 'id', 'page', 'p',
  'doc', 'document_id', 'lang', 'section'])

function safeUrl(value) {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined
    for (const key of [...url.searchParams.keys()]) {
      if (!PUBLIC_URL_PARAMETERS.has(key)) url.searchParams.delete(key)
    }
    return url.href.length <= 2048 ? url.href : undefined
  } catch { return undefined }
}

/** Only returned anchors and model-visible content belong on the user's desk. */
export function cloudArchivePresentation(value, { inspect = false, dataVersion } = {}) {
  if (value?.error || value?.status === 'error') return envelope([])
  const delivered = inspect ? '' : projectCloudSearch(value)
  const remoteVersion = version(value?.data?.data_version || value?.data_version)
  const sources = []
  const byId = new Map()
  const mappedDocuments = new Set()
  const add = (source) => {
    const previous = byId.get(source.id)
    if (previous) {
      previous.ranges = rangesFor([...(previous.ranges || []), ...(source.ranges || [])])
      if (!previous.excerpt) previous.excerpt = source.excerpt
      if (source.state === 'read') { previous.state = 'read'; previous.agentRead = true }
      return
    }
    if (sources.length >= MAX_SOURCES + 1) return
    byId.set(source.id, source); sources.push(source)
  }
  // Both cloud renderers explicitly deliver every suggested local anchor. Do not
  // forward mapping excerpts: they may come from candidates hidden by Cleaner.
  for (const mapping of (value?.local_source_mappings || []).slice(0, 200)) {
    if (!mapping?.suggested_source_ref || !mapping.document_id || !version(dataVersion)) continue
    mappedDocuments.add(mapping.document_id)
    const ranges = rangesFor([range(mapping.start_line, mapping.end_line || mapping.start_line)])
    add({ id: localId(dataVersion, mapping.document_id),
      title: text(mapping.title || mapping.display_title, 512), kind: text(mapping.document_kind || 'source', 80),
      origin: 'cloud', state: 'found', excerpt: '', documentId: text(mapping.document_id, 1024),
      documentUid: text(mapping.document_uid, 128) || documentUid(mapping.document_id),
      dataVersion, ...locations(ranges) })
  }
  // The inspect renderer preserves the allowlisted textual fields below. Use
  // each original item for its opaque identity as well, so filtered null rows
  // cannot shift that identity onto a different projected document.
  const items = inspect ? value?.data?.items || []
    : value?.data?.sources || value?.data?.selected_sources || []
  for (const item of items.slice(0, 200)) {
    if (!item || typeof item !== 'object') continue
    const title = text(item.title || item.story_title || item.display_title, 512)
    if (!title || (!inspect && !delivered.includes(title))) continue
    // Titles are display text, not identities; only an exact canonical document
    // match can establish that the mapped anchor already represents this item.
    const excerpt = inspect
      ? [item.content_preview, item.content, item.text, item.summary].filter((entry) => typeof entry === 'string' && entry.trim()).join('\n\n')
      : [item.content_preview, item.content, item.text, item.summary]
        .find((entry) => typeof entry === 'string' && entry && delivered.includes(entry)) || ''
    // A local anchor is a pointer to a future corpus_read, not evidence that the
    // local document was read. Keep an explicitly delivered remote body separate
    // even when an anchor maps it to that same document: line spaces may differ.
    if (item.document_id && mappedDocuments.has(item.document_id) && (!inspect || !excerpt.trim())) continue
    const url = safeUrl(item.url || item.source_url)
    const ranges = rangesFor([range(item.start_line, item.end_line || item.start_line)])
    const identity = item.document_id || item.source_id || item.doc_id || item.story_id
      || item.source_file || url || [item.game, item.source_type, title]
    add({ id: idFor('cloud', remoteVersion, identity),
      title, kind: text(item.source_type || 'cloud_source', 80), origin: 'cloud',
      state: inspect && excerpt.trim() ? 'read' : 'found',
      ...(inspect && excerpt.trim() ? { agentRead: true } : {}),
      excerpt: text(excerpt), ...(url ? { url } : {}), ...locations(ranges) })
  }
  // Cleaner can deliver a synthesis with no resolvable individual source. Keep
  // exactly that delivered text accessible without inventing document locators.
  const context = value?.data?.answer_context
  if (!sources.length && typeof context === 'string' && context.trim()) {
    const excerpt = inspect ? context : delivered
    add({ id: idFor('cloud', remoteVersion, excerpt), title: '云端检索摘要', kind: 'cloud_summary',
      origin: 'cloud', state: 'read', agentRead: true, excerpt: text(excerpt) })
  }
  return envelope(sources, dataVersion)
}

export function timelineArchivePresentation(value) {
  if (value?.status !== 'ok') return envelope([])
  const events = value.mode === 'source' ? [value.event] : value.events || []
  return envelope(events.slice(0, MAX_SOURCES + 1).filter(Boolean).map((event) => ({
    id: idFor('local', value.data_version, event.source_marker || [event.activity_name, event.time, event.event]),
    title: text(`${event.activity_name || event.activity_names?.join('、') || '泰拉年表'} · ${event.time || '事件'}`, 512),
    kind: 'timeline', origin: 'local', state: 'found', excerpt: text(event.event),
    ...(version(value.data_version) ? { dataVersion: value.data_version } : {}),
  })), value.data_version)
}
