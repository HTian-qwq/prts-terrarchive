/** Shared read model for Agent recall; browser reads never acknowledge these notices. */
const copy = value => structuredClone(value)
const keyOf = ({ area, board_id = '', item_id = '' }) => JSON.stringify([area, board_id, item_id])
const metadata = ({ content, ...source }) => copy(source)
const fail = message => { throw Object.assign(new Error(message), { code: 'INVESTIGATION_NOT_FOUND' }) }

export function noteUserChange(portfolio, change) {
  const key = keyOf(change), index = portfolio.attention.findIndex(item => item.key === key)
  const item = { ...change, key, revision: portfolio.commitSeq + 1, updated_at: new Date().toISOString() }
  if (index < 0) portfolio.attention.push(item)
  else portfolio.attention[index] = item
}

export function reviewSummary(p) {
  const pending = p?.attention || []
  return { pending_count: pending.length, rack_count: p?.sources.filter(s => s.agentRead || p.rack.some(r => r.source_id === s.id)).length || 0,
    user_saved_count: p?.rack.length || 0, changes: pending.slice(-20).map(copy),
    ...(pending.length > 20 ? { more: 'investigation_get(section="changes") 可分页读取其余提醒' } : {}) }
}

/** Returns the exact notice revisions covered by this response, for post-tool acknowledgment. */
export function inspectPortfolio(p, args, boardSummary) {
  const { section = 'board', board_id, source_id, clue_id, report_version, query = '', saved_only = false } = args
  const cursor = Math.max(0, Math.floor(Number(args.cursor) || 0)), limit = Math.min(128, Math.max(1, Math.floor(Number(args.limit) || 20)))
  const matches = value => !query || JSON.stringify(value).toLowerCase().includes(String(query).toLowerCase())
  const page = rows => ({ items: rows.slice(cursor, cursor + limit), total: rows.length, nextCursor: rows.length > cursor + limit ? cursor + limit : null })
  const receipt = test => p.attention.filter(test).map(({ key, revision }) => ({ key, revision }))
  const respond = (value, viewed = () => false) => ({ ...value, _review: receipt(viewed) })
  if (section === 'changes') {
    const result = page(p.attention.filter(item => (!board_id || item.board_id === board_id) && matches(item)))
    return respond({ ...result, pending_count: p.attention.length,
      guidance: '提醒目录不等于已查看。按 area 读取 rack、inbox 或 clues 的内容；board 无 item_id 时读取该板概览。' })
  }
  if (section === 'rack' || section === 'sources') {
    const saved = new Map(p.rack.map(item => [item.source_id, item]))
    const rows = [...p.sources].reverse().filter(source => section === 'sources' || (saved_only ? saved.has(source.id) : source.agentRead || saved.has(source.id)))
      .map(source => ({ ...metadata(source), saved: saved.has(source.id), ...(saved.has(source.id) ? { saved_at: saved.get(source.id).addedAt } : {}) }))
      .filter(matches)
    const result = page(rows), ids = new Set(result.items.map(item => item.id))
    return respond({ total: result.total, nextCursor: result.nextCursor, sources: result.items, rack_revision: p.rackRevision, ...reviewSummary(p),
      guidance: '来源目录包含摘要和定位信息；用 section="source", source_id 读取已保存正文。agentRead=false 的用户资料仍需读取原文核验。' },
    item => section === 'rack' && item.area === 'rack' && ids.has(item.item_id))
  }
  if (section === 'source') {
    const source = p.sources.find(s => s.id === source_id || s.sourceId === source_id)
    if (!source) fail('来源不存在；先读取 rack 或 sources 取得 source_id')
    return respond({ source: copy(source), saved: p.rack.some(item => item.source_id === source.id),
      guidance: source.agentRead ? '这是已保存的工具返回正文；contentTruncated=true 时需要继续读取原文。' : '这是用户选入的材料，不代表 Agent 已核验原文；按 documentId/sourceRef/url 调用读取工具核验。' },
    item => item.area === 'rack' && item.item_id === source.id)
  }
  if (!['board', 'clues', 'report', 'inbox'].includes(section)) fail('未知调查资料 section')
  if (!board_id) {
    if (section !== 'board') fail('此 section 需要 board_id；先读取调查目录')
    const result = page([...p.boards].reverse().filter(b => matches([b.title, b.objective])))
    return respond({ boards: result.items.map(b => boardSummary(b, p)), nextCursor: result.nextCursor,
      ...reviewSummary(p), guidance: '回看线索用 section="clues"，报告用 section="report"，重点材料用 section="inbox"，档案架用 section="rack"。' })
  }
  const board = p.boards.find(b => b.id === board_id)
  if (!board) fail('该调查板不存在于当前会话')
  const identity = { board_id: board.id, title: board.title, revision: board.knowledgeRevision }
  if (section === 'board') return respond({ ...identity, objective: board.objective, ...boardSummary(board, p),
    open_questions: copy(board.openQuestions), relations: copy(board.relations),
    reports: board.reports.map(({ version, title, summary, publishedAt }) => ({ version, title, summary, publishedAt })),
    guidance: '此处是调查概览。用 section="clues" 分页回看用户和 Agent 的线索正文，用 section="report" 阅读报告。' },
  item => item.area === 'board' && item.board_id === board.id && !item.item_id)
  if (section === 'report') {
    const report = report_version === undefined ? board.reports.at(-1) : board.reports.find(r => r.version === report_version)
    if (!report) fail('指定的调查报告尚不存在')
    return respond({ ...identity, report: { ...copy(report), sources: report.sources.map(metadata) } })
  }
  if (section === 'clues') {
    const result = page(board.clues.filter(c => (!clue_id || c.id === clue_id) && matches(c)))
    if (clue_id && !result.total) fail('该线索不存在于当前调查板')
    const ids = new Set(result.items.map(c => c.id)), sourceIds = new Set(result.items.flatMap(c => c.sources.map(ref => ref.source_id)))
    return respond({ ...identity, total: result.total, nextCursor: result.nextCursor, clues: copy(result.items),
      relations: copy(board.relations.filter(r => ids.has(r.from) || ids.has(r.to))),
      sources: p.sources.filter(s => sourceIds.has(s.id)).map(metadata) },
    item => item.area === 'board' && item.board_id === board.id && ids.has(item.item_id))
  }
  const notices = new Set(p.attention.filter(item => item.area === 'inbox' && item.board_id === board.id).map(item => item.item_id))
  const result = page(board.evidenceInbox.filter(item => item.status === 'pending' || notices.has(item.source_id))
    .map(item => ({ ...copy(item), source: metadata(p.sources.find(s => s.id === item.source_id)) })).filter(matches))
  const ids = new Set(result.items.map(item => item.source_id))
  return respond({ ...identity, ...result, inbox_revision: board.inboxRevision,
    pending_count: board.evidenceInbox.filter(item => item.status === 'pending').length },
  item => item.area === 'inbox' && item.board_id === board.id && ids.has(item.item_id))
}
