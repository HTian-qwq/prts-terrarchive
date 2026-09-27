/** Match search projection's NFKC text while retaining the exact original quotation. */
export function originalQuotation(body, quote) {
  if (body.includes(quote)) return quote
  const needle = quote.normalize('NFKC')
  if (!needle || !body.normalize('NFKC').includes(needle)) return null
  let folded = '', offset = 0
  const boundaries = new Map([[0, 0]])
  for (const character of body) {
    folded += character.normalize('NFKC')
    offset += character.length
    boundaries.set(folded.length, offset)
  }
  for (let start = folded.indexOf(needle); start >= 0; start = folded.indexOf(needle, start + 1)) {
    const end = start + needle.length
    // A match cannot select half of a compatibility character (e.g. one I of Ⅲ).
    if (boundaries.has(start) && boundaries.has(end)) return body.slice(boundaries.get(start), boundaries.get(end))
  }
  return null
}

export function sourceRecovery(source, ref) {
  const locate = { tool: 'investigation_get', arguments: { section: 'sources', query: source.title } }
  const read = source.origin === 'web' && source.url
    ? { tool: 'web_fetch', arguments: { url: source.url } }
    : source.documentUid
      ? { tool: 'corpus_read', arguments: { document_uid: source.documentUid,
        ...(ref.line_start ? { line: ref.line_start } : {}) } }
      : null
  return { source_id: source.id, source_title: source.title, agent_read: source.agentRead,
    requested_range: ref.line_start ? { start: ref.line_start, end: ref.line_end } : null,
    read_ranges: source.ranges, lookup: locate, ...(read ? { read } : {}),
    guidance: '先核对 source_title 是否为目标文档；编号错了须查 sources，不能靠改行号修复。标题正确时按 read 补读，再复制原文与实际范围。' }
}
