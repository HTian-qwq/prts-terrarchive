import { dropEmptyPlaceholders } from './tool-args.js'

const ZERO_FIELDS = ['line', 'segment', 'position', 'max_lines', 'max_chars']

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
    removeDefault('story_part', args.stage_code === undefined && args.story_part === 'story')
    removeDefault('segment', args.record_name === undefined && args.segment === 1)
    removeDefault('material', args.character_name === undefined && args.material === 'profile')
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
