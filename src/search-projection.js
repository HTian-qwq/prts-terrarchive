/** 将 public canonical corpus_search 结果渲染成紧凑的 grep 风格文本。 */

const RESOURCE_LABELS = Object.freeze({
  original_story: '官方剧情原文', archive: '官方档案库', knowledge: '审校资料',
  wiki: '整理性 Wiki', character_story: '角色剧情',
  entity_profile: '实体资料', reference: '引用资料', timeline: '时间线',
  story: '官方剧情原文', operator_record: '干员密录原文',
  character_profile: '官方角色档案', character_module: '官方模组文案',
  character_voice: '官方干员语音', character_skin: '官方时装文案',
  character_wiki: '整理性角色 Wiki', story_wiki: '整理性活动／密录 Wiki',
  character_activity_wiki: '整理性角色×活动 Wiki', terra_journey: '大地巡旅',
  entity_profile: '实体资料', reference: '引用资料',
})

const EVIDENCE_LABELS = Object.freeze({
  official_canonical: '官方原文', official_structured: '官方结构化资料',
  wiki_curated: '整理性 Wiki', derived_summary: '整理性总结',
  derived_timeline: '整理性时间线', entity_projection: '实体关联入口', catalog: '资料目录',
})

// 命中高亮用 ⟦⟧：明日方舟档案正文自身大量使用【代号】【性别】，不能再用【】。
const HIT_OPEN = '⟦'
const HIT_CLOSE = '⟧'

function renderLine(line) {
  const marker = line.role === 'match' ? '>' : line.role === 'constraint' ? '+' : ' '
  const number = line.line == null ? '' : String(line.line).padStart(4, ' ')
  // 与 corpus_read 的行格式一致：「说话人: 台词」。
  const speaker = line.speaker ? `${line.speaker}: ` : ''
  return `${marker} ${number} ${speaker}${line.rendered_text ?? line.text}${line.truncated ? '（本行已截断）' : ''}`.trimEnd()
}

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim()
}

/**
 * 在原文上高亮：匹配时按 NFKC + 小写比较（与检索一致），输出保留原文字符。
 * 逐码点建立「归一化偏移 → 原文偏移」映射，避免全角标点被改写。
 */
function normalizedIndex(text) {
  let normalized = ''
  const starts = []
  const ends = []
  let offset = 0
  let previousSpace = true
  for (const char of text) {
    let piece = char.normalize('NFKC').toLocaleLowerCase()
    if (/^\s+$/u.test(piece)) {
      piece = previousSpace ? '' : ' '
    }
    for (let index = 0; index < piece.length; index += 1) {
      starts.push(offset)
      ends.push(offset + char.length)
    }
    if (piece) previousSpace = piece === ' '
    normalized += piece
    offset += char.length
  }
  return { normalized, starts, ends }
}

function highlightLiteral(text, query) {
  const needle = normalizeText(query).toLocaleLowerCase()
  if (!needle) return text
  const { normalized, starts, ends } = normalizedIndex(text)
  const parts = []
  let cursor = 0
  let offset = normalized.indexOf(needle)
  while (offset >= 0) {
    const from = starts[offset]
    const to = ends[offset + needle.length - 1]
    if (from >= cursor) {
      parts.push(text.slice(cursor, from), `${HIT_OPEN}${text.slice(from, to)}${HIT_CLOSE}`)
      cursor = to
    }
    offset = normalized.indexOf(needle, offset + needle.length)
  }
  return parts.length ? `${parts.join('')}${text.slice(cursor)}` : text
}

function highlightRegex(text, query) {
  try {
    const regex = new RegExp(query, 'giu')
    // 检索按 NFKC 文本匹配；展示仍在原文上尽力高亮，匹配不上时保持原文不加标记。
    return text.replace(regex, (matched) => matched ? `${HIT_OPEN}${matched}${HIT_CLOSE}` : matched)
  } catch {
    return text
  }
}

function speakerlessQuery(line, query) {
  const speaker = normalizeText(line.speaker)
  const needle = normalizeText(query)
  if (!speaker || !needle.toLocaleLowerCase().startsWith(`${speaker.toLocaleLowerCase()}:`)) return query
  return needle.slice(speaker.length + 1).trim() || query
}

function renderedExcerptLine(line, match, options) {
  if (line.role !== 'match' || !options.query) return line
  const renderedText = match.match_kind === 'regex'
    ? highlightRegex(line.text, options.query)
    : highlightLiteral(line.text, speakerlessQuery(line, options.query))
  return renderedText === line.text ? line : { ...line, rendered_text: renderedText }
}

function renderMatch(match, options) {
  const range = match.line_start == null ? ''
    : `命中：第 ${match.line_start === match.line_end ? match.line_start
      : `${match.line_start}-${match.line_end}`} 行`
  return [range, `证据：${EVIDENCE_LABELS[match.evidence_kind] || match.evidence_kind}`,
    ...(match.excerpt || []).map((line) => renderLine(renderedExcerptLine(line, match, options))),
    `引用：${match.citation}`].filter(Boolean).join('\n')
}

function renderSection(section) {
  return [`字段：${section.section}（${section.completeness === 'complete' ? '完整' : '部分'}）`,
    ...(section.blocks || []).map((block) => block.label ? `${block.label}：${block.text}` : block.text),
    `引用：${section.citation}`].join('\n')
}

function renderEntitySummary(summary) {
  return [`实体：${summary.canonical_name}`,
    summary.description ? `概述：${summary.description}` : '',
    summary.history_summary ? `历史：${summary.history_summary}` : '',
    summary.truncated ? '实体摘要已按模型上下文预算截断；需要更多内容时可按该自然标题继续读取。' : '',
    `引用：${summary.citation}`].filter(Boolean).join('\n')
}

const WIKI_TYPES = ['character_wiki', 'story_wiki', 'character_activity_wiki']
const WIKI_NOTICE = '引文状态：Wiki 为整理性资料；其中引号内容未核验为当前资料包官方原文，逐字引用前请回查原文。'

function renderDocument(document, options) {
  const body = document.entity_summary ? renderEntitySummary(document.entity_summary)
    : document.section_content ? renderSection(document.section_content)
    : document.matches?.length ? document.matches.map((match) => renderMatch(match, options)).join('\n\n')
      : [document.available_sections?.length ? `可用字段：${document.available_sections.join('、')}` : '',
        `读取：corpus_read(${JSON.stringify(document.document_uid
          ? { document_uid: document.document_uid, mode: 'document' }
          : { title: document.title })})`].filter(Boolean).join('\n')
  const wikiNotice = !options.sharedWikiNotice && WIKI_TYPES.includes(document.resource_type)
    ? '引文状态：Wiki 为整理性资料；其中引号内容未核验为当前资料包官方原文，逐字引用前请回查原文。'
    : ''
  const game = document.game === 'endfield' ? '终末地'
    : document.game === 'arknights' ? '明日方舟' : ''
  return [`## ${document.title}`, game ? `游戏：${game}` : '',
    document.document_uid
      ? `同名消歧定位：读取时仅提交 document_uid=${document.document_uid}，它替代 title，不要同时提交二者。` : '',
    `资料类型：${RESOURCE_LABELS[document.resource_type] || document.resource_type}`,
    wikiNotice, body, document.matches_truncated ? '本篇仍有其他命中；请增加过滤条件或按已知行号读取。' : '']
    .filter(Boolean).join('\n')
}

/** 零命中时按实际使用的过滤条件给出具体放宽方向。 */
export function zeroHitHints(args = {}) {
  const has = (field) => Array.isArray(args?.[field])
    && args[field].some((item) => typeof item === 'string' && item.trim())
  const hints = []
  if (has('context_terms')) {
    hints.push('context_terms 是强约束：每个词都必须出现在命中行前后 3 行内，不是整篇共现；请先去掉 context_terms 重试。')
  }
  if (has('story_names')) {
    hints.push('story_names 只匹配单关/单篇剧情名（如“鳞的记忆”）；活动或章节名（如“昨日海”）请改用 activity_names。')
  }
  if (has('activity_names') || has('collection_names')) {
    hints.push('activity_names / collection_names 需与展示名完全一致；不确定时先省略 query 只按名称列目录核对。')
  }
  if (has('speakers')) {
    hints.push('speakers 只匹配本人亲口台词（已自动展开已登记别名，如 银灰→恩希欧迪斯）；提及该角色的旁白或他人台词请改用 entity_names 或 query。')
    const query = normalizeText(args?.query)
    if (query && args.speakers.some((name) => query.includes(normalizeText(name)))) {
      hints.push('query 只匹配台词正文，不含说话人名；按说话人找台词时请省略 query，或只写台词片段。')
    }
  }
  if (has('resource_types') || has('content_types') || has('wiki_sections')) {
    hints.push('resource_types / content_types / wiki_sections 会缩小资料类型；可先移除再看命中分布。')
  }
  if (args?.match_mode === 'regex') hints.push('regex 模式按受限正则匹配；可改回默认 literal 并缩短为关键短语。')
  return hints
}

export function projectSearch(value, options = {}) {
  const documents = value?.documents || []
  const matches = documents.reduce((total, document) => total
    + (document.entity_summary ? 1 : document.matches?.length || 0), 0)
  const heading = value?.result_kind === 'documents'
    ? `# 找到 ${documents.length} 篇资料入口`
    : value?.result_kind === 'complete_sections'
      ? `# 返回 ${documents.length} 篇资料的完整字段`
      : `# 找到 ${documents.length} 篇资料，共展示 ${matches} 处命中`
  const exhausted = value?.page?.exhausted === true
  const next = value?.page?.next_after
    ? `扫描尚未穷尽。继续时保留本次搜索词和过滤条件，并设置 after: ${JSON.stringify(value.page.next_after)}。`
    : value?.page?.next_cursor
      ? `旧版分页尚未结束。继续时仅提交 cursor: ${JSON.stringify(value.page.next_cursor)}。` : ''
  const hints = zeroHitHints(options.args)
  const zero = documents.length ? '' : exhausted
    ? ['已检查完整检索范围，没有找到。请检查展示名、缩短连续字面串或移除冲突过滤条件。',
      ...hints.map((hint) => `- ${hint}`)].join('\n')
    : value?.page?.next_after
      ? '本页没有发现命中文档，但扫描位置已经推进；这不是全库零命中。'
      : '该旧版分页链已经结束，但不能证明资料范围已经穷尽；需要完整性时请重新搜索。'
  const complete = exhausted && documents.length
    ? Number.isInteger(value.page.total_documents)
      ? `已检查完整检索范围，共匹配 ${value.page.total_documents} 篇资料。`
      : '已扫描至当前检索范围末尾。'
    : ''
  const warnings = (value?.warnings || []).length
    ? `## 资料提示\n${value.warnings.map((item) => `- ${item.message || item}`).join('\n')}` : ''
  const relations = (value?.retraveler_relations || []).length
    ? `## 再旅者对应关系（人工审校附属字段）\n${value.retraveler_relations.map((item) =>
      `- 终末地角色：${item.endfield_name}；泰拉记忆原型：${item.terra_memory_prototype || '未登记'}；` +
      `状态：${item.relation_status}。这是跨游戏关系，不是人物别名。`).join('\n')}` : ''
  // 多篇 Wiki 同屏时引文提示只说一次，避免每篇重复同一句话。
  const wikiCount = documents.filter((document) => WIKI_TYPES.includes(document.resource_type)).length
  const sharedWikiNotice = wikiCount > 1
  const documentOptions = sharedWikiNotice ? { ...options, sharedWikiNotice } : options
  return [heading, sharedWikiNotice ? `${WIKI_NOTICE}（适用于下列所有 Wiki 条目）` : '', warnings, relations,
    ...documents.map((document) => renderDocument(document, documentOptions)), zero, complete, next]
    .filter(Boolean).join('\n\n')
}
