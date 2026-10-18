import { dropEmptyPlaceholders } from './tool-args.js'

const ZERO_FIELDS = ['line', 'start_line', 'segment', 'position', 'max_lines', 'max_chars']

/**
 * 句柄 citation：检索结果发出去的"重新取用"凭据，形如 doc_xxxxxxxxxxxxxxxx#L123
 * 或 doc_xxxxxxxxxxxxxxxx#L120-L135。它把"标题可能同名、抓不到 document_uid"的两跳
 * 缩成一步，Agent 复制粘贴即可回到原文。
 * @returns {{documentUid: string, startLine: number, endLine: number} | null}
 */
export function parseCitation(value) {
  const match = String(value ?? '').trim()
    .match(/^(doc_[A-Za-z0-9_-]{16})#L([1-9][0-9]*)(?:-L?([1-9][0-9]*))?$/u)
  if (!match) return null
  const startLine = Number(match[2])
  const endLine = match[3] === undefined ? startLine : Number(match[3])
  if (endLine < startLine) return null
  return { documentUid: match[1], startLine, endLine }
}

/** 把篇章定位与行号区间拼成句柄，供检索结果回显。 */
export function formatCitation(documentUid, startLine, endLine = startLine) {
  if (!documentUid || !Number.isInteger(startLine)) return ''
  return `${documentUid}#L${startLine === endLine ? startLine : `${startLine}-${endLine}`}`
}

/** Independent anchors, never inferred from an optional modifier alone. */
export function readTargets(args) {
  return [
    ['title', ['title']], ['document_uid', ['document_uid']], ['stage_code', ['stage_code']],
    ['record_name', ['character_name', 'record_name']],
    ['material', ['character_name', 'material']],
    ['activity_name', ['activity_name']], ['collection_name', ['collection_name']],
  ].filter(([key]) => args[key] !== undefined && (key !== 'material' || args.character_name !== undefined))
    .map(([key, keys]) => ({ key, args: Object.fromEntries(keys.filter((name) => args[name] !== undefined)
      .map((name) => [name, args[name]])) }))
}

/** Keep every real target and pagination credential. Only known orphan defaults are compatible fillers. */
export function normalizeReadArguments(raw, { sections = [] } = {}) {
  const args = dropEmptyPlaceholders(raw, { zeroFields: ZERO_FIELDS })
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { args, guidance: '' }
  const notes = []
  if (args.line === undefined) {
    if (args.before === 0) delete args.before
    if (args.after === 0) delete args.after
  }
  if (readTargets(args).length === 1 && args.cursor === undefined) {
    const ignored = []
    const removeDefault = (key, matches) => {
      if (!matches || args[key] === undefined) return
      ignored.push(key)
      delete args[key]
    }
    // 表单式调用会把所有可选字段一并填上（""、0、默认值）。附属参数只要没有对应主定位，
    // 就不表达任何意图：一律忽略并说明，不报错——报错只会让调用方在同一处反复试。
    removeDefault('story_part', args.stage_code === undefined)
    removeDefault('segment', args.record_name === undefined)
    removeDefault('material', args.character_name === undefined)
    removeDefault('start_line', args.mode !== 'document' && !(args.mode === undefined
      && args.line === undefined && args.section === undefined))
    removeDefault('game', !(args.character_name !== undefined && args.material !== undefined)
      && ['arknights', 'endfield'].includes(args.game))
    if (ignored.length) notes.push(`参数适配：已忽略没有对应定位信息的默认附属参数 ${ignored.join('、')}；未改变目标文档。`)
    if (args.mode === 'document' && sections.includes(args.section)) {
      notes.push(`读取方式：mode=document 已明确选择全文，未应用 section=${args.section}。如只读取该字段，请省略 mode，保留 title 或 document_uid 与 section。`)
      delete args.section
    }
  }
  return { args, guidance: notes.join('\n') }
}

/** Concrete conflicting targets and independently executable retries; never choose a target for the caller. */
export function readTargetError(args) {
  const targets = readTargets(args)
  if (!targets.length) return '缺少主定位信息：请提供 title、document_uid、stage_code、character_name+record_name、character_name+material、activity_name 或 collection_name 中的一种。story_part、segment、material 单独出现不能定位资料。'
  const examples = targets.map(({ key, args: target }) => ({ ...target,
    mode: key === 'activity_name' ? 'activity' : key === 'collection_name' ? 'collection' : 'document' }))
  const titleUidHint = args.title !== undefined && args.document_uid !== undefined
    ? 'document_uid 会替代 title，不要同时提交二者。' : ''
  return `必须且只能提供一种定位方式；实际冲突：${targets.map(({ args: target }) => Object.keys(target).join('+')).join(' 与 ')}。请选择目标后仅提交其中一组：${examples.map((example) => JSON.stringify(example)).join(' 或 ')}。${titleUidHint}附属参数不能代替主定位信息。`
}

export function withReadGuidance(value, guidance) {
  return guidance ? { ...value, guidance: [value.guidance, guidance].filter(Boolean).join('\n') } : value
}
