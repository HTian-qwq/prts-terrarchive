/** Wiki 文档角色与标签字段的确定性解析。资料仍保留原始标签文本；这里仅提供检索语义层。 */

export const WIKI_SECTION_VALUES = Object.freeze([
  '简要介绍', '相关角色', '详细介绍', '剧情高光', '战斗表现', '相关活动', 'trivia', '角色点评',
  '剧情总结', '关键人物', '角色剧情概括',
  '所有相关的活动剧情总结', '相关剧情总结', '相关剧情高光', '相关trivia', '相关角色总结',
])

const WIKI_SECTION_SET = new Set(WIKI_SECTION_VALUES)
const WIKI_CONTAINER_SECTIONS = new Set(['所有相关的活动剧情总结'])
const OPEN_TAG = /^<([^>/]+)>$/u
const CLOSE_TAG = /^<\/([^>]+)>$/u

export function wikiDocumentRole(document = {}) {
  if (document.document_type !== 'knowledge' || document.document_kind !== 'wiki') return ''
  const explicit = String(document.wiki_role || '').trim()
  if (['story', 'character', 'character_activity', 'other'].includes(explicit)) return explicit
  const path = String(document.path || '')
  if (path.startsWith('stories/')) return 'story'
  if (path.startsWith('char_v3/prompt_')) return 'character_activity'
  if (path.startsWith('char_v3/') && document.character_name) return 'character'
  return 'other'
}

export function wikiCharacterName(record = {}) {
  const metadata = String(record.document?.character_name || '').trim()
  if (metadata) return metadata
  // 新版 character_activity 记录直接携带 character_name；旧版未拆分资料包
  // 仍需从 prompt 首行的“名称:角色名”恢复，以保证升级前后都可检索。
  for (const line of record.lines || []) {
    const match = /^名称[：:]\s*(.+)$/u.exec(String(line.text || '').trim())
    if (match?.[1]) return match[1].trim()
  }
  return ''
}

export function wikiActivityName(document = {}) {
  const metadata = String(document.activity_name || '').trim()
  if (metadata) return metadata
  const role = wikiDocumentRole(document)
  return role === 'story' || role === 'character_activity'
    ? String(document.display_title || '').trim() : ''
}

/** 返回标签内部的 1-based 闭区间；标签行本身不包含在范围内。 */
export function wikiSectionRanges(record = {}, requested = []) {
  const wanted = new Set((requested || []).map((item) => String(item || '').trim()).filter(Boolean))
  const ranges = []
  const lines = record.lines || []
  for (let markerIndex = 0; markerIndex < lines.length; markerIndex += 1) {
    const opened = OPEN_TAG.exec(String(lines[markerIndex]?.text || '').trim())
    const name = opened?.[1]
    if (!name || !WIKI_SECTION_SET.has(name)
        || (wanted.size && !wanted.has(name))) continue

    // 角色×活动辅助 Wiki 的子字段是半结构化的：它们没有各自的闭合标签，
    // 而由下一个字段标签或外层 </相关内容> 隐式结束。容器字段仍优先寻找同名闭合。
    let boundaryIndex = lines.length
    for (let index = markerIndex + 1; index < lines.length; index += 1) {
      const text = String(lines[index]?.text || '').trim()
      const closed = CLOSE_TAG.exec(text)
      if (closed?.[1] === name) {
        boundaryIndex = index
        break
      }
      if (WIKI_CONTAINER_SECTIONS.has(name)) continue
      const nextOpen = OPEN_TAG.exec(text)
      if ((nextOpen && WIKI_SECTION_SET.has(nextOpen[1])) || closed) {
        boundaryIndex = index
        break
      }
    }
    const startLine = markerIndex + 2
    const endLine = boundaryIndex
    if (endLine < startLine) continue
    ranges.push({ name, start_line: startLine, end_line: endLine,
      marker_start_line: markerIndex + 1, marker_end_line: boundaryIndex + 1 })
  }
  return ranges.sort((left, right) => left.start_line - right.start_line
    || left.end_line - right.end_line)
}

export function wikiSectionAt(ranges, lineNumber) {
  const containing = (ranges || []).filter((range) =>
    range.start_line <= lineNumber && lineNumber <= range.end_line)
  return containing.sort((left, right) =>
    (left.end_line - left.start_line) - (right.end_line - right.start_line))[0] || null
}
