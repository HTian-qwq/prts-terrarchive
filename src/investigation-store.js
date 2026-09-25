/** Durable investigation portfolios, shared by Host UI and agent preset instances. */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { inspectPortfolio, noteUserChange, reviewSummary } from './investigation-review.js'

const id = z.string().min(1).max(512)
const short = z.string().max(512)
const point = z.object({ x: z.number().finite().min(-20).max(20), y: z.number().finite().min(-12).max(12) })
const range = z.object({ start: z.number().int().positive(), end: z.number().int().positive() })
export const clueKinds = ['excerpt', 'finding', 'time', 'relation', 'question', 'contrast']
const sourceSchema = z.object({
  id, sourceId: id, title: short, kind: z.string().max(80), origin: z.enum(['local', 'cloud', 'web']),
  state: z.enum(['found', 'read']), agentRead: z.boolean(), excerpt: z.string().max(4000),
  content: z.string().max(64000).optional(), contentTruncated: z.boolean().optional(),
  documentId: z.string().max(2048).optional(), documentUid: z.string().max(512).optional(),
  sourceRef: z.string().max(2048).optional(), dataVersion: z.string().max(128).optional(),
  url: z.string().max(4096).optional(), lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(), ranges: z.array(range).max(256).default([]),
  callId: short, updatedAt: z.string(), contentHash: z.string(),
})
const referenceSchema = z.object({ source_id: id, quote: z.string().max(3000).optional(),
  line_start: z.number().int().positive().optional(), line_end: z.number().int().positive().optional() })
export const clueSchema = z.object({
  id, kind: z.enum(clueKinds), title: z.string().min(1).max(120), summary: z.string().max(480), detail: z.string().max(12000),
  interpretation: z.enum(['observation', 'inference', 'question']), status: z.enum(['active', 'unresolved', 'superseded', 'retracted']),
  importance: z.enum(['key', 'supporting', 'background']), sources: z.array(referenceSchema).max(32),
  contentRevision: z.number().int().nonnegative(), layoutRevision: z.number().int().nonnegative(),
  authoredBy: z.enum(['agent', 'user']), editedBy: z.enum(['agent', 'user']),
  createdAt: z.string(), updatedAt: z.string(), styleSeed: z.number().int(), variant: z.number().int().min(0).max(2),
  position: point.optional(), scale: z.number().min(.5).max(2).optional(), rotation: z.number().min(-30).max(30).optional(),
  userLayoutLocked: z.boolean(), mergedInto: id.optional(),
})
const relationSchema = z.object({ id, from: id, to: id, type: z.enum(['supports', 'contradicts', 'precedes', 'relates']), label: z.string().max(100) })
const reportSchema = z.object({ id, version: z.number().int().positive(), title: z.string().min(1).max(180),
  summary: z.string().max(1000), markdown: z.string().min(1).max(120000), publishedAt: z.string(), runId: id,
  basisKnowledgeRevision: z.number().int(), clues: z.array(clueSchema).max(128), sources: z.array(sourceSchema).max(1024) })
const inboxEntrySchema = z.object({ source_id: id, note: z.string().max(600),
  status: z.enum(['pending', 'promoted', 'removed']), addedBy: z.enum(['agent', 'user']),
  addedAt: z.string(), updatedAt: z.string(), removedBy: z.enum(['agent', 'user']).optional(), clueIds: z.array(id).max(128) })
const boardSchema = z.object({ id, title: z.string().min(1).max(120), objective: z.string().min(1).max(2000),
  createdAt: z.string(), updatedAt: z.string(), knowledgeRevision: z.number().int().nonnegative(), layoutRevision: z.number().int().nonnegative(),
  clues: z.array(clueSchema).max(512), relations: z.array(relationSchema).max(1024), reports: z.array(reportSchema).max(128),
  evidenceInbox: z.array(inboxEntrySchema).max(512).default([]), inboxRevision: z.number().int().nonnegative().default(0),
  openQuestions: z.array(z.string().max(500)).max(32), nextClue: z.number().int().positive(),
})
const runSchema = z.object({ id, boardId: id, turnId: short, reason: z.string().max(500), startedAt: z.string(),
  status: z.enum(['running', 'completed', 'interrupted', 'error']), endedAt: z.string().optional() })
export const portfolioSchema = z.object({ schemaVersion: z.literal(1), sessionId: id, commitSeq: z.number().int().nonnegative(),
  boards: z.array(boardSchema).max(128), runs: z.array(runSchema).max(4096), sources: z.array(sourceSchema).max(4096),
  nextSource: z.number().int().positive(), mutations: z.record(z.string(), z.object({ hash: z.string(), result: z.json() })),
  migrations: z.array(z.string().max(512)).max(128),
  rack: z.array(z.object({ source_id: id, addedAt: z.string() })).max(512).default([]),
  rackRevision: z.number().int().nonnegative().default(0),
  attention: z.array(z.object({ key: z.string().max(2048), area: z.enum(['rack', 'board', 'inbox']),
    board_id: id.optional(), item_id: id.optional(), title: short, action: z.string().max(32),
    revision: z.number().int().nonnegative(), updated_at: z.string() })).max(16384).default([]),
})

const clone = value => structuredClone(value)
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const now = () => new Date().toISOString()
const bounded = (value, length = 512) => typeof value === 'string' ? value.slice(0, length) : ''
export function investigationError(code, message, details = {}) { return Object.assign(new Error(message), { code, details }) }
function requireValue(condition, message, code = 'INVALID_INVESTIGATION') { if (!condition) throw investigationError(code, message) }
function abort(signal) { if (signal?.aborted) throw investigationError('CANCELLED', '调查操作已取消') }
function safeUrl(value) {
  if (!value) return undefined
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 4096 ? url.href : undefined } catch { return undefined }
}
function validateSession(value) { requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= 512, '需要有效的会话 ID'); return value }
function freshPortfolio(sessionId) { return { schemaVersion: 1, sessionId, commitSeq: 0, boards: [], runs: [], sources: [], nextSource: 1, mutations: {}, migrations: [] } }
function boardOf(portfolio, boardId) { const board = portfolio.boards.find(row => row.id === boardId); requireValue(board, '该调查板不存在于当前会话', 'INVESTIGATION_NOT_FOUND'); return board }
function requireRun(portfolio, boardId, runId, turnId) {
  const run = portfolio.runs.find(row => row.id === runId)
  requireValue(run?.boardId === boardId && run.status === 'running' && run.turnId === String(turnId ?? ''), '本次运行未绑定到这块调查板，或已经结束；请重新选择调查', 'INVESTIGATION_RUN_MISMATCH')
  return run
}
function sourceIdentity(source) { return source.documentUid || source.documentId ? JSON.stringify([source.dataVersion || '', source.documentUid || source.documentId]) : source.url ? `url:${source.url.replace(/#.*$/, '')}` : source.sourceId || source.id }
function uniqueRanges(values) {
  return [...new Map(values.filter(r => Number.isSafeInteger(r?.start) && r.start > 0 && Number.isSafeInteger(r.end) && r.end >= r.start).map(r => [`${r.start}:${r.end}`, { start: r.start, end: r.end }])).values()].slice(-256)
}
function normalizeSource(source, alias, callId, trusted) {
  const read = trusted && (source.agentRead === true || source.state === 'read')
  const body = bounded(source.content, 64000)
  return sourceSchema.parse({ id: alias, sourceId: bounded(source.sourceId || source.id, 512), title: bounded(source.title),
    kind: bounded(source.kind || 'source', 80), origin: ['local', 'cloud', 'web'].includes(source.origin) ? source.origin : 'local',
    state: read ? 'read' : 'found', agentRead: read, excerpt: bounded(source.excerpt, 4000), ...(body ? { content: body } : {}),
    contentTruncated: !!source.contentTruncated || typeof source.content === 'string' && source.content.length > 64000,
    ...Object.fromEntries(['documentId', 'documentUid', 'sourceRef', 'dataVersion'].filter(key => typeof source[key] === 'string' && source[key]).map(key => [key, bounded(source[key], key === 'dataVersion' ? 128 : key === 'documentUid' ? 512 : 2048)])),
    ...(safeUrl(source.url) ? { url: safeUrl(source.url) } : {}),
    ...(Number.isSafeInteger(source.lineStart) && source.lineStart > 0 ? { lineStart: source.lineStart } : {}),
    ...(Number.isSafeInteger(source.lineEnd) && source.lineEnd > 0 ? { lineEnd: source.lineEnd } : {}),
    ranges: read ? uniqueRanges([...(source.readRanges || source.ranges || []), ...(source.lineStart ? [{ start: source.lineStart, end: source.lineEnd || source.lineStart }] : [])]) : [],
    callId: bounded(callId), updatedAt: now(), contentHash: hash(body || bounded(source.excerpt, 4000)),
  })
}
function ingestSources(portfolio, incoming, callId, trusted) {
  const aliases = {}
  for (const raw of incoming.slice(0, 128)) {
    if (!raw?.title || !(raw.id || raw.sourceId)) continue
    const identity = sourceIdentity(raw)
    const previous = portfolio.sources.find(source => sourceIdentity(source) === identity || source.sourceId === (raw.sourceId || raw.id))
    if (!previous) requireValue(portfolio.sources.length < 4096, '当前会话来源记录已满；已保存的资料不会删除', 'INVESTIGATION_CAPACITY')
    const item = normalizeSource(raw, previous?.id || `R${String(portfolio.nextSource++).padStart(4, '0')}`, callId, trusted)
    aliases[raw.sourceId || raw.id] = item.id
    if (previous) {
      // A later search hit must not turn a read source back into a summary.
      const preferOld = previous.agentRead && !item.agentRead
      Object.assign(previous, { ...item, ...preferOld ? { state: previous.state, agentRead: true,
        excerpt: previous.excerpt, content: previous.content, contentTruncated: previous.contentTruncated, contentHash: previous.contentHash,
        callId: previous.callId } : {}, ranges: uniqueRanges([...previous.ranges, ...item.ranges]) })
    } else portfolio.sources.push(item)
  }
  return aliases
}
function resolveReferences(portfolio, incoming) {
  requireValue(Array.isArray(incoming) && incoming.length <= 32, 'sources 必须是最多 32 项的来源引用列表')
  return incoming.map(raw => {
    const ref = referenceSchema.parse(raw)
    const source = portfolio.sources.find(row => row.id === ref.source_id || row.sourceId === ref.source_id || row.documentUid === ref.source_id)
    requireValue(source, `来源 ${ref.source_id} 未在当前会话返回；用 investigation_get 的 sources 部分查看有效 ID`, 'INVESTIGATION_SOURCE_MISSING')
    if (ref.line_start || ref.line_end) {
      requireValue(ref.line_start && ref.line_end && ref.line_end >= ref.line_start, '引用行范围不完整')
      requireValue(source.agentRead && source.ranges.some(r => r.start <= ref.line_start && r.end >= ref.line_end), '引用的行范围不在实际已读范围内', 'INVESTIGATION_SOURCE_UNREAD')
    }
    if (ref.quote) requireValue((source.content || source.excerpt).includes(ref.quote), '摘录不在保存的返回片段内；请先读取对应原文或去掉直接引文', 'INVESTIGATION_QUOTE_MISMATCH')
    return { ...ref, source_id: source.id }
  })
}
function cluePatch(portfolio, board, change, actor, mapping) {
  const previous = change.id ? board.clues.find(row => row.id === change.id) : undefined
  requireValue(!change.id || previous, `线索 ${change.id} 不存在`, 'INVESTIGATION_CLUE_MISSING')
  const action = change.action || 'upsert'
  if (action === 'layout') {
    requireValue(previous, '布局修改需要已有线索')
    if (change.expected_layout_revision !== undefined) requireValue(previous.layoutRevision === change.expected_layout_revision, '线索布局已更新，请刷新后重试', 'INVESTIGATION_CONFLICT')
    requireValue(actor === 'user', 'Agent 不设置纸片坐标')
    for (const key of ['position', 'scale', 'rotation']) if (change[key] !== undefined) previous[key] = change[key]
    previous.userLayoutLocked = true; previous.layoutRevision++; board.layoutRevision++
    clueSchema.parse(previous)
    return previous
  }
  if (previous && actor === 'user') requireValue(change.expected_content_revision === previous.contentRevision, '这条线索已经更新，请先读取新内容再编辑', 'INVESTIGATION_CONFLICT')
  if (action === 'retract') {
    requireValue(previous, '撤回需要已有线索')
    requireValue(actor === 'user' || previous.editedBy !== 'user', '用户编辑过的线索不能由 Agent 直接撤回', 'INVESTIGATION_USER_EDIT')
    previous.status = 'retracted'; previous.contentRevision++; previous.updatedAt = now(); previous.editedBy = actor
    return previous
  }
  requireValue(action === 'upsert', '不支持的线索操作')
  if (!previous) requireValue(board.clues.length < 512, '这块板已达到 512 条线索，已有内容仍保留', 'INVESTIGATION_CAPACITY')
  if (previous?.editedBy === 'user' && actor === 'agent') {
    for (const key of ['title', 'summary', 'detail', 'kind', 'status', 'interpretation']) requireValue(change[key] === undefined || change[key] === previous[key], '这条线索已由用户编辑；可补充来源，不能直接覆盖用户内容', 'INVESTIGATION_USER_EDIT')
  }
  const clueId = previous?.id || `C${String(board.nextClue++).padStart(3, '0')}`
  const seed = parseInt(hash(`${board.id}:${clueId}`).slice(0, 7), 16)
  const next = previous || { id: clueId, kind: 'finding', title: '', summary: '', detail: '', interpretation: 'observation',
    status: 'active', importance: 'supporting', sources: [], contentRevision: 0, layoutRevision: 0,
    authoredBy: actor, editedBy: actor, createdAt: now(), updatedAt: now(), styleSeed: seed,
    variant: board.clues.length % 3, userLayoutLocked: false }
  for (const key of ['kind', 'title', 'summary', 'detail', 'interpretation', 'status', 'importance']) if (change[key] !== undefined) next[key] = change[key]
  if (change.sources !== undefined) {
    const incoming = resolveReferences(portfolio, change.sources)
    next.sources = [...new Map([...next.sources, ...incoming].map(ref => [JSON.stringify(ref), ref])).values()]
  }
  if (next.kind === 'question') next.interpretation = 'question'
  if (next.interpretation === 'observation' && actor === 'agent' && next.kind !== 'question') requireValue(next.sources.length, '观察或原文证据需要来源；无来源的研究方向请标为 question/inference')
  if (!previous && actor === 'user') for (const key of ['position', 'scale', 'rotation']) if (change[key] !== undefined) {
    next[key] = change[key]; next.userLayoutLocked = true
  }
  next.updatedAt = now(); next.contentRevision++
  if (previous?.editedBy !== 'user' || actor === 'user') next.editedBy = actor
  const checked = clueSchema.parse(next)
  if (previous) Object.assign(previous, checked); else board.clues.push(checked)
  if (change.client_key) mapping[change.client_key] = clueId
  return checked
}
function pendingEvidence(board) { return board.evidenceInbox.filter(item => item.status === 'pending') }
function checkInboxRevision(board, revision) {
  requireValue(Number.isSafeInteger(revision) && revision === board.inboxRevision, '证据盒已经更新，请刷新后重试', 'INVESTIGATION_INBOX_CONFLICT')
}
function changeInbox(portfolio, board, changes, actor) {
  requireValue(Array.isArray(changes) && changes.length > 0 && changes.length <= 20, '每次整理证据盒需要 1–20 项变更')
  let changed = false
  for (const change of changes) {
    const source = portfolio.sources.find(s => s.id === change.source_id || s.sourceId === change.source_id)
    requireValue(source, '只能暂存本会话实际返回的资料；先读取有效来源编号', 'INVESTIGATION_SOURCE_MISSING')
    let item = board.evidenceInbox.find(row => row.source_id === source.id)
    requireValue(['add', 'remove'].includes(change.action), '证据盒仅支持 add 或 remove')
    if (change.action === 'remove') {
      requireValue(item?.status === 'pending', '这份资料已经不在待整理盒中', 'INVESTIGATION_INBOX_CONFLICT')
      requireValue(actor === 'user' || item.addedBy !== 'user', '用户放入的重点材料请整理上板或保留，不要自动移出', 'INVESTIGATION_USER_EDIT')
      item.status = 'removed'; item.removedBy = actor; item.updatedAt = now(); changed = true
    } else {
      requireValue(typeof change.note === 'string' && change.note.length <= 600, '请用 600 字以内说明待核对的问题')
      if (item?.status === 'pending') continue // Same document has one slot; do not overwrite the user's note.
      requireValue(actor === 'user' || !(item?.status === 'removed' && item.removedBy === 'user'), '用户已移出这份材料，不要自动放回', 'INVESTIGATION_USER_EDIT')
      if (!item) {
        requireValue(board.evidenceInbox.length < 512, '这块板的证据盒已达容量上限，已有材料仍保留', 'INVESTIGATION_CAPACITY')
        item = { source_id: source.id, note: '', status: 'pending', addedBy: actor, addedAt: now(), updatedAt: now(), clueIds: [] }
        board.evidenceInbox.push(item)
      }
      delete item.removedBy
      Object.assign(item, { note: change.note, status: 'pending', addedBy: actor, addedAt: now(), updatedAt: now(), clueIds: [] }); changed = true
    }
  }
  if (changed) { board.inboxRevision++; board.updatedAt = now() }
}
function consumeEvidence(board, clues) {
  let changed = false
  for (const item of pendingEvidence(board)) {
    const linked = clues.filter(c => !['retracted', 'superseded'].includes(c.status) && c.sources.some(ref => ref.source_id === item.source_id))
    if (linked.length) { item.status = 'promoted'; item.clueIds = linked.map(c => c.id); item.updatedAt = now(); changed = true }
  }
  if (changed) board.inboxRevision++
}
function boardSummary(board, portfolio) {
  const latest = board.reports.at(-1), run = [...portfolio.runs].reverse().find(run => run.boardId === board.id)
  return { id: board.id, title: board.title, objective: board.objective, updatedAt: board.updatedAt,
    knowledgeRevision: board.knowledgeRevision, layoutRevision: board.layoutRevision, inboxRevision: board.inboxRevision, pendingEvidenceCount: pendingEvidence(board).length,
    clueCount: board.clues.filter(c => !['retracted', 'superseded'].includes(c.status)).length,
    reportVersion: latest?.version || 0, reportStale: !!latest && latest.basisKnowledgeRevision !== board.knowledgeRevision,
    run: run ? clone(run) : null }
}

/** One instance per storageDomain service, not one per agent plugin instance. */
export function createInvestigationStore(storageDomain) {
  const domains = new Map(), snapshots = new Map(), listeners = new Map(), pendingReceipts = new Map()
  let disposed = false
  async function ensure(sessionId) {
    validateSession(sessionId); requireValue(!disposed, '调查服务已关闭', 'INVESTIGATION_CLOSED')
    if (!domains.has(sessionId)) {
      const loading = (async () => {
        // A genuine Zod schema, with no static dependency on a particular DSH build.
        const domain = await storageDomain.open({ name: `prts_inv_${hash(sessionId).slice(0, 32)}`, version: 1, layout: 'single',
          tables: { portfolios: { valueSchema: portfolioSchema } } })
        const table = domain.table('portfolios')
        if (!table.get('state')) await table.put('state', freshPortfolio(sessionId))
        // No live run survives a process/service restart. Preserve its partial work.
        if (table.get('state').runs.some(run => run.status === 'running')) await table.update('state', current => {
          const next = clone(current)
          for (const run of next.runs) if (run.status === 'running') { run.status = 'interrupted'; run.endedAt = now() }
          next.commitSeq++; return next
        })
        const saved = portfolioSchema.parse(table.get('state'))
        requireValue(saved.sessionId === sessionId, '调查记录的会话身份不匹配')
        snapshots.set(sessionId, clone(saved))
        return { domain, table }
      })()
      domains.set(sessionId, loading)
      loading.catch(() => domains.delete(sessionId))
    }
    return domains.get(sessionId)
  }
  async function mutate(sessionId, key, input, apply, signal) {
    abort(signal)
    const { table } = await ensure(sessionId)
    const requestHash = hash(input), mutationKey = hash(key)
    let result, changed = false
    const next = await table.update('state', saved => {
      abort(signal)
      const cached = saved.mutations[mutationKey]
      if (cached) { requireValue(cached.hash === requestHash, '同一个操作 ID 不能用于不同内容', 'INVESTIGATION_IDEMPOTENCY'); result = clone(cached.result); return saved }
      const portfolio = portfolioSchema.parse(clone(saved))
      result = apply(portfolio)
      portfolio.commitSeq++
      portfolio.mutations[mutationKey] = { hash: requestHash, result: JSON.parse(JSON.stringify(result)) }
      // Every retained mutation remains replayable; exceeding the budget fails before commit.
      requireValue(Object.keys(portfolio.mutations).length <= 40000, '当前会话的调查操作记录已满，请开始新会话；已有调查不会删除', 'INVESTIGATION_CAPACITY')
      portfolioSchema.parse(portfolio)
      requireValue(Buffer.byteLength(JSON.stringify(portfolio)) <= 32 * 1024 * 1024, '当前会话调查数据已达 32 MiB，请开始新会话；本次变更尚未保存', 'INVESTIGATION_CAPACITY')
      changed = true
      return portfolio
    })
    snapshots.set(sessionId, portfolioSchema.parse(clone(next)))
    if (changed) for (const listener of listeners.get(sessionId) || []) { try { listener(next.commitSeq) } catch {} }
    return clone(result)
  }
  const store = {
    async read(sessionId, args = {}) {
      const { board_id, section = 'board', query = '', cursor = 0, limit = 20 } = args
      await store.flushReceipts(sessionId)
      const { table } = await ensure(sessionId), p = portfolioSchema.parse(table.get('state'))
      const working = [...p.runs].reverse().find(run => run.status === 'running')
      if (['rack', 'source', 'changes'].includes(section)) {
        const { _review, ...value } = inspectPortfolio(p, args, boardSummary)
        if (section === 'rack') value.sources = value.sources.map(source => ({ ...source, content: p.sources.find(s => s.id === source.id)?.content }))
        return value
      }
      if (!board_id && section !== 'sources') {
        const rows = [...p.boards].reverse().filter(b => !query || `${b.title} ${b.objective}`.toLowerCase().includes(String(query).toLowerCase()))
        const offset = Math.max(0, Number(cursor) || 0), count = Math.min(128, Math.max(1, Number(limit) || 20))
        return { commitSeq: p.commitSeq, rackRevision: p.rackRevision, workingBoardId: working?.boardId || null, boards: rows.slice(offset, offset + count).map(b => boardSummary(b, p)), nextCursor: rows.length > offset + count ? offset + count : null }
      }
      if (section === 'sources') return { commitSeq: p.commitSeq, sources: p.sources.slice(-Math.min(128, Number(limit) || 40)).map(({ content, ...source }) => clone(source)) }
      const board = boardOf(p, board_id)
      if (section === 'inbox') {
        const items = pendingEvidence(board), offset = Math.max(0, Number(cursor) || 0), count = Math.min(128, Math.max(1, Number(limit) || 20))
        return { board_id: board.id, title: board.title, inbox_revision: board.inboxRevision, pending_count: items.length,
          items: items.slice(offset, offset + count).map(item => { const { content, ...source } = p.sources.find(s => s.id === item.source_id); return { ...clone(item), source: clone(source) } }),
          nextCursor: items.length > offset + count ? offset + count : null }
      }
      return { commitSeq: p.commitSeq, workingBoardId: working?.boardId || null, ...boardSummary(board, p), board: clone(board),
        sources: p.sources.filter(source => board.clues.some(c => c.sources.some(ref => ref.source_id === source.id)) || board.evidenceInbox.some(item => item.source_id === source.id && item.status !== 'removed')).map(source => clone(source)) }
    },
    peek(sessionId) { return snapshots.get(sessionId) },
    async prepare(sessionId) { await store.flushReceipts(sessionId); await ensure(sessionId) },
    async inspect(sessionId, args = {}) {
      await store.prepare(sessionId)
      const { table } = await ensure(sessionId)
      return inspectPortfolio(portfolioSchema.parse(table.get('state')), args, boardSummary)
    },
    reviewSummary(sessionId) { return reviewSummary(snapshots.get(sessionId)) },
    acknowledge(sessionId, receipt, callId) {
      if (!receipt?.length) return Promise.resolve()
      const pending = mutate(sessionId, `review:${callId}`, receipt, p => {
        const seen = new Map(receipt.map(item => [item.key, item.revision]))
        // A user update racing this tool result remains unread.
        p.attention = p.attention.filter(item => seen.get(item.key) !== item.revision)
        return { pending_count: p.attention.length }
      })
      const previous = pendingReceipts.get(sessionId) || Promise.resolve()
      pendingReceipts.set(sessionId, Promise.allSettled([previous, pending]).then(() => {}))
      return pending
    },
    async saveRack(sessionId, args, signal) {
      requireValue(Array.isArray(args.sources) && args.sources.length > 0 && args.sources.length <= 150, '每次收藏需要 1–150 份资料')
      const importing = args.action === 'import'
      requireValue(importing || args.action === 'add', '档案架支持 add 或 import')
      requireValue(importing || typeof args.mutation_id === 'string' && args.mutation_id.length < 512, '收藏需要唯一操作 ID')
      await store.flushReceipts(sessionId)
      const input = { action: args.action, sources: args.sources }
      return mutate(sessionId, importing ? `rack-import:${hash(input)}` : `rack:${args.mutation_id}`, input, p => {
        requireValue(args.sources.every(s => s?.title && (s.id || s.sourceId)), '收藏需要有效的资料标题和来源 ID')
        const before = new Map(p.sources.map(s => [s.id, s.contentHash]))
        // A browser's legacy cache must never overwrite a newer server bookmark.
        const incoming = importing ? args.sources.filter(raw => !p.sources.some(s =>
          (sourceIdentity(s) === sourceIdentity(raw) || s.sourceId === (raw.sourceId || raw.id)) && p.rack.some(r => r.source_id === s.id))) : args.sources
        const aliases = ingestSources(p, incoming.map(s => ({ ...s, content: s.content ?? s.excerpt })), 'user-rack', false), added = [], updated = []
        for (const sourceId of new Set(Object.values(aliases))) if (!p.rack.some(item => item.source_id === sourceId)) {
          requireValue(p.rack.length < 512, '档案架已达到 512 份手动收藏，已有资料仍会保留', 'INVESTIGATION_CAPACITY')
          p.rack.push({ source_id: sourceId, addedAt: now() }); added.push(sourceId)
          noteUserChange(p, { area: 'rack', item_id: sourceId, action: 'added', title: p.sources.find(s => s.id === sourceId).title })
        } else if (before.get(sourceId) !== p.sources.find(s => s.id === sourceId).contentHash) {
          updated.push(sourceId)
          noteUserChange(p, { area: 'rack', item_id: sourceId, action: 'edited', title: p.sources.find(s => s.id === sourceId).title })
        }
        if (added.length || updated.length) p.rackRevision++
        return { added_ids: added, updated_ids: updated, rack_revision: p.rackRevision, pending_count: p.attention.length }
      }, signal)
    },
    async open(sessionId, args, execution) {
      const key = `open:${execution.callId}`
      return mutate(sessionId, key, args, p => {
        let board
        if (args.mode === 'new') {
          requireValue(p.boards.length < 128, '当前会话最多 128 块调查板，已有板仍可继续使用', 'INVESTIGATION_CAPACITY')
          board = boardSchema.parse({ id: `B-${randomUUID()}`, title: args.title, objective: args.objective,
            createdAt: now(), updatedAt: now(), knowledgeRevision: 0, layoutRevision: 0, clues: [], relations: [], reports: [], openQuestions: [], nextClue: 1 })
          p.boards.push(board)
        } else { requireValue(args.mode === 'resume', 'mode 只能为 new 或 resume'); board = boardOf(p, args.board_id) }
        for (const previous of p.runs) if (previous.turnId === String(execution.turnId || '') && previous.boardId !== board.id && previous.status === 'running') { previous.status = 'interrupted'; previous.endedAt = now() }
        const same = p.runs.find(run => run.turnId === String(execution.turnId || '') && run.boardId === board.id && run.status === 'running')
        const run = same || { id: `run-${randomUUID()}`, boardId: board.id, turnId: bounded(String(execution.turnId || '')),
          reason: bounded(args.reason, 500), startedAt: now(), status: 'running' }
        if (!same) p.runs.push(run)
        board.updatedAt = now()
        return { board_id: board.id, run_id: run.id, revision: board.knowledgeRevision, inbox_revision: board.inboxRevision, pending_evidence: pendingEvidence(board).length, title: board.title, objective: board.objective, open_questions: board.openQuestions }
      }, execution.signal)
    },
    async update(sessionId, args, execution) {
      await store.flushReceipts(sessionId)
      return mutate(sessionId, `update:${execution.callId}`, args, p => {
        const board = boardOf(p, args.board_id); requireRun(p, board.id, args.run_id, execution.turnId)
        requireValue(board.knowledgeRevision === args.expected_revision, '调查内容已更新，请用 investigation_get 重读后提交', 'INVESTIGATION_CONFLICT')
        requireValue(Array.isArray(args.clues || []) && (args.clues || []).length <= 20, '每次更新最多 20 条线索')
        const mapping = {}, updated = []
        for (const change of args.clues || []) updated.push(cluePatch(p, board, change, 'agent', mapping).id)
        const resolveId = value => mapping[value] || value
        requireValue(Array.isArray(args.relations || []) && (args.relations || []).length <= 32, '每次更新最多 32 条关系')
        for (const raw of args.relations || []) {
          const from = resolveId(raw.from), to = resolveId(raw.to)
          requireValue(from !== to && board.clues.some(c => c.id === from) && board.clues.some(c => c.id === to), '关系必须连接板上两条不同的线索')
          const existing = board.relations.find(r => r.from === from && r.to === to && r.type === raw.type)
          const relation = relationSchema.parse({ id: existing?.id || `rel-${randomUUID()}`, from, to, type: raw.type, label: raw.label || '' })
          if (existing) Object.assign(existing, relation); else board.relations.push(relation)
        }
        requireValue(Array.isArray(args.merges || []) && (args.merges || []).length <= 20, '每次最多归并 20 条线索')
        for (const merge of args.merges || []) {
          const from = board.clues.find(c => c.id === resolveId(merge.from)), to = board.clues.find(c => c.id === resolveId(merge.into))
          requireValue(from && to && from !== to && !['superseded', 'retracted'].includes(to.status), '归并需要两条有效线索')
          requireValue(from.editedBy !== 'user', '用户修改的线索不能自动归并撤下', 'INVESTIGATION_USER_EDIT')
          to.sources = [...new Map([...to.sources, ...from.sources].map(ref => [JSON.stringify(ref), ref])).values()]
          to.contentRevision++; from.status = 'superseded'; from.mergedInto = to.id; from.contentRevision++
          board.relations = board.relations.map(r => ({ ...r, from: r.from === from.id ? to.id : r.from, to: r.to === from.id ? to.id : r.to })).filter(r => r.from !== r.to)
        }
        consumeEvidence(board, board.clues.filter(c => updated.includes(c.id)))
        if (args.open_questions !== undefined) board.openQuestions = args.open_questions
        board.knowledgeRevision++; board.updatedAt = now()
        return { board_id: board.id, revision: board.knowledgeRevision, inbox_revision: board.inboxRevision, created_ids: mapping, updated_ids: updated,
          warnings: board.clues.filter(c => updated.includes(c.id) && c.sources.some(ref => !p.sources.find(s => s.id === ref.source_id)?.agentRead)).map(c => `${c.id} 包含仅检索摘要的来源，尚未读取全文`) }
      }, execution.signal)
    },
    async stage(sessionId, args, execution) {
      await store.flushReceipts(sessionId)
      return mutate(sessionId, `stage:${execution.callId}`, args, p => {
        const board = boardOf(p, args.board_id); requireRun(p, board.id, args.run_id, execution.turnId)
        checkInboxRevision(board, args.expected_inbox_revision)
        changeInbox(p, board, args.changes, 'agent')
        return { board_id: board.id, inbox_revision: board.inboxRevision, pending_count: pendingEvidence(board).length }
      }, execution.signal)
    },
    async editInbox(sessionId, args, signal) {
      requireValue(typeof args.mutation_id === 'string' && args.mutation_id.length < 512, '证据盒操作需要唯一 ID')
      await store.flushReceipts(sessionId)
      return mutate(sessionId, `inbox:${args.mutation_id}`, args, p => {
        const board = boardOf(p, args.board_id)
        checkInboxRevision(board, args.expected_inbox_revision)
        const aliases = ingestSources(p, args.sources || [], 'user-inbox', false)
        const sourceId = aliases[args.source_id] || args.source_id
        if (args.action !== 'promote') {
          const before = board.inboxRevision
          changeInbox(p, board, [{ action: args.action, source_id: sourceId, note: args.note || '' }], 'user')
          if (board.inboxRevision !== before) noteUserChange(p, { area: 'inbox', board_id: board.id, item_id: sourceId, action: args.action, title: p.sources.find(s => s.id === sourceId).title })
        }
        else {
          const item = board.evidenceInbox.find(row => row.source_id === sourceId && row.status === 'pending')
          requireValue(item, '材料已被处理，请刷新证据盒', 'INVESTIGATION_INBOX_CONFLICT')
          requireValue(typeof args.title === 'string' && args.title.trim() && typeof args.detail === 'string' && args.detail.trim(), '先写下线索标题与摘记，再放上证据板')
          const clue = cluePatch(p, board, { title: args.title.trim(), summary: bounded(args.detail.trim(), 480), detail: args.detail.trim(),
            kind: args.kind || 'excerpt', interpretation: args.interpretation || 'question', status: args.interpretation === 'question' ? 'unresolved' : 'active',
            sources: [{ source_id: sourceId }] }, 'user', {})
          consumeEvidence(board, [clue]); board.knowledgeRevision++; board.updatedAt = now()
          noteUserChange(p, { area: 'inbox', board_id: board.id, item_id: sourceId, action: 'promoted', title: clue.title })
          noteUserChange(p, { area: 'board', board_id: board.id, item_id: clue.id, action: 'added', title: clue.title })
          return { board_id: board.id, inbox_revision: board.inboxRevision, clue_id: clue.id }
        }
        return { board_id: board.id, inbox_revision: board.inboxRevision, pending_count: pendingEvidence(board).length }
      }, signal)
    },
    async publish(sessionId, args, execution) {
      await store.flushReceipts(sessionId)
      return mutate(sessionId, `publish:${execution.callId}`, args, p => {
        const board = boardOf(p, args.board_id); requireRun(p, board.id, args.run_id, execution.turnId)
        requireValue(board.knowledgeRevision === args.expected_revision, '有新线索尚未纳入报告，请重读调查后发布', 'INVESTIGATION_CONFLICT')
        requireValue(Array.isArray(args.clue_ids) && args.clue_ids.length <= 128, 'clue_ids 必须列出报告使用的线索')
        const cited = [...new Set(args.clue_ids)].map(value => { const clue = board.clues.find(c => c.id === value); requireValue(clue && !['retracted', 'superseded'].includes(clue.status), `报告引用的线索 ${value} 已不可用`); return clone(clue) })
        const sources = p.sources.filter(s => cited.some(c => c.sources.some(ref => ref.source_id === s.id))).map(s => { const copy = clone(s); delete copy.content; return copy })
        const report = reportSchema.parse({ id: `report-${randomUUID()}`, version: board.reports.length + 1, title: args.title,
          summary: args.summary, markdown: args.markdown, publishedAt: now(), runId: args.run_id,
          basisKnowledgeRevision: board.knowledgeRevision, clues: cited, sources })
        board.reports.push(report); board.updatedAt = now()
        return { board_id: board.id, report_id: report.id, version: report.version, title: report.title, revision: board.knowledgeRevision,
          message: '调查报告已保存到线索板中央。向用户说明结果即可，不必再次生成一份不同的全文。' }
      }, execution.signal)
    },
    async createUserBoard(sessionId, args, signal) {
      requireValue(typeof args.mutation_id === 'string', '创建需要唯一操作 ID')
      return mutate(sessionId, `create:${args.mutation_id}`, args, p => {
        const board = boardSchema.parse({ id: `B-${randomUUID()}`, title: args.title || '手动研究摘记', objective: args.objective || args.title || '用户手动整理的研究资料',
          createdAt: now(), updatedAt: now(), knowledgeRevision: 0, layoutRevision: 0, clues: [], relations: [], reports: [], openQuestions: [], nextClue: 1 })
        p.boards.push(board)
        noteUserChange(p, { area: 'board', board_id: board.id, action: 'created', title: board.title })
        return { board_id: board.id }
      }, signal)
    },
    async edit(sessionId, args, signal) {
      requireValue(typeof args.mutation_id === 'string' && args.mutation_id.length < 512, '编辑需要唯一的操作 ID')
      return mutate(sessionId, `user:${args.mutation_id}`, args, p => {
        const board = boardOf(p, args.board_id), mapping = {}, edited = []
        const aliases = ingestSources(p, args.sources || [], 'user', false)
        requireValue(Array.isArray(args.changes) && args.changes.length <= 32, '每次编辑最多 32 条变更')
        let contentChanged = false
        for (const raw of args.changes) {
          const change = clone(raw)
          if (change.sources) change.sources = change.sources.map(ref => ({ ...ref, source_id: aliases[ref.source_id] || ref.source_id }))
          const clue = cluePatch(p, board, change, 'user', mapping)
          edited.push(clue.id)
          if (change.action !== 'layout') {
            contentChanged = true
            noteUserChange(p, { area: 'board', board_id: board.id, item_id: clue.id,
              action: change.action === 'retract' ? 'retracted' : change.id ? 'edited' : 'added', title: clue.title })
          }
        }
        if (args.relations?.length) {
          for (const raw of args.relations) {
            const from = mapping[raw.from] || raw.from, to = mapping[raw.to] || raw.to
            requireValue(board.clues.some(c => c.id === from) && board.clues.some(c => c.id === to) && from !== to, '关系的线索不可用')
            if (raw.remove) board.relations = board.relations.filter(r => !(r.from === from && r.to === to))
            else if (!board.relations.some(r => r.from === from && r.to === to)) board.relations.push(relationSchema.parse({ id: `rel-${randomUUID()}`, from, to, type: raw.type || 'relates', label: raw.label || '' }))
          }
          contentChanged = true
          noteUserChange(p, { area: 'board', board_id: board.id, action: 'relations', title: board.title })
        }
        if (contentChanged) board.knowledgeRevision++
        board.updatedAt = now()
        return { board_id: board.id, revision: board.knowledgeRevision, created_ids: mapping, updated_ids: edited,
          clue_revisions: Object.fromEntries(board.clues.filter(c => edited.includes(c.id)).map(c => [c.id,
            { content_revision: c.contentRevision, layout_revision: c.layoutRevision }])) }
      }, signal)
    },
    async importLegacy(sessionId, args, signal) {
      requireValue(Array.isArray(args.cards) && args.cards.length <= 128 && typeof args.migration_id === 'string', '旧板迁移数据无效')
      return mutate(sessionId, `migration:${args.migration_id}`, args, p => {
        if (p.migrations.includes(args.migration_id)) return { imported: false }
        const board = boardSchema.parse({ id: `B-${randomUUID()}`, title: '手动研究摘记', objective: '从原有线索板迁移的手动研究内容', createdAt: now(), updatedAt: now(), knowledgeRevision: 1, layoutRevision: 0,
          clues: [], relations: [], reports: [], openQuestions: [], nextClue: 1 })
        const mapping = {}
        for (const card of args.cards) {
          let references = []
          if (card.sourceId) {
            const local = /^document:([^:]+):(.+)$/.exec(card.sourceId)
            const url = safeUrl(card.sourceId)
            const aliases = ingestSources(p, [{ id: card.sourceId, title: card.sourceTitle || card.title, excerpt: bounded(card.body, 4000),
              origin: url ? 'web' : 'local', ...(url ? { url } : {}), ...(local ? { dataVersion: local[1], documentUid: local[2] } : {}) }], 'legacy-user', false)
            references = [{ source_id: aliases[card.sourceId] }]
          }
          const clue = cluePatch(p, board, { client_key: card.id, title: card.title, summary: bounded(card.body, 480), detail: bounded(card.body, 12000), sources: references,
            kind: card.kind === 'question' ? 'question' : card.kind === 'source' ? 'excerpt' : 'finding', interpretation: 'question' }, 'user', mapping)
          if (card.position) { clue.position = card.position; clue.userLayoutLocked = true }
          if (Number.isFinite(card.rotation)) clue.rotation = Math.max(-30, Math.min(30, card.rotation))
          if (Number.isFinite(card.scale)) clue.scale = Math.max(.5, Math.min(2, card.scale))
        }
        for (const card of args.cards) for (const to of card.links || []) if (mapping[to] && mapping[to] !== mapping[card.id]) board.relations.push({ id: `rel-${randomUUID()}`, from: mapping[card.id], to: mapping[to], type: 'relates', label: '' })
        p.migrations.push(args.migration_id)
        if (board.clues.length) {
          p.boards.push(board)
          noteUserChange(p, { area: 'board', board_id: board.id, action: 'imported', title: board.title })
          for (const clue of board.clues) noteUserChange(p, { area: 'board', board_id: board.id, item_id: clue.id, action: 'imported', title: clue.title })
        }
        return { imported: true, board_id: board.clues.length ? board.id : null }
      }, signal)
    },
    recordSources(sessionId, sources, callId) {
      if (!sources.length) return Promise.resolve()
      const pending = mutate(sessionId, `sources:${callId}`, sources, p => ({ sources: ingestSources(p, sources, callId, true) }))
      const previous = pendingReceipts.get(sessionId) || Promise.resolve()
      const settled = Promise.allSettled([previous, pending]).then(() => {})
      pendingReceipts.set(sessionId, settled)
      return pending
    },
    async flushReceipts(sessionId) { await pendingReceipts.get(sessionId) },
    async endTurn(sessionId, turnId, outcome) {
      // An open may still be committing when cancellation closes the turn.
      // Queue behind it instead of deciding from the older in-memory snapshot.
      if (!domains.has(sessionId)) return
      return mutate(sessionId, `end:${turnId}`, outcome, p => {
        for (const run of p.runs) if (run.turnId === String(turnId) && run.status === 'running') { run.status = outcome; run.endedAt = now() }
        return { status: outcome }
      })
    },
    async watch(sessionId, after, signal) {
      const { table } = await ensure(sessionId); abort(signal)
      if (table.get('state').commitSeq > after) return { commitSeq: table.get('state').commitSeq }
      return new Promise((resolve, reject) => {
        const rows = listeners.get(sessionId) || new Set(); listeners.set(sessionId, rows)
        let timer
        const cleanup = () => { clearTimeout(timer); rows.delete(changed); signal?.removeEventListener('abort', cancelled) }
        const changed = commitSeq => { cleanup(); resolve({ commitSeq }) }
        const cancelled = () => { cleanup(); reject(investigationError('CANCELLED', '订阅已关闭')) }
        rows.add(changed); signal?.addEventListener('abort', cancelled, { once: true })
        timer = setTimeout(() => changed(table.get('state').commitSeq), 25000)
        if (signal?.aborted) cancelled()
        else if (table.get('state').commitSeq > after) changed(table.get('state').commitSeq)
      })
    },
    async close() { disposed = true; for (const rows of listeners.values()) for (const listener of [...rows]) listener(-1); listeners.clear(); await Promise.allSettled([...domains.values()].map(async loading => (await loading).domain.close())); domains.clear(); snapshots.clear() },
  }
  return store
}

const stores = new WeakMap()
export function acquireInvestigationStore(facility) {
  let entry = stores.get(facility)
  if (!entry) { entry = { service: createInvestigationStore(facility), refs: 0 }; stores.set(facility, entry) }
  entry.refs++
  let released = false
  return { service: entry.service, release: async () => { if (released) return; released = true; if (--entry.refs === 0) { stores.delete(facility); await entry.service.close() } } }
}
