import { readFile } from 'node:fs/promises'

const bundledRelationsUrl = new URL('../resources/entity-routing.json', import.meta.url)
let bundledRelationsPromise = null

async function bundledRelations() {
  bundledRelationsPromise ||= readFile(bundledRelationsUrl, 'utf8')
    .then((text) => JSON.parse(text)).catch(() => ({}))
  return bundledRelationsPromise
}

function mergeRelationCatalog(fallback, installed) {
  const mergeRows = (field, identity) => {
    const rows = new Map()
    for (const row of [...(fallback?.[field] || []), ...(installed?.[field] || [])]) {
      const key = identity(row)
      if (key) rows.set(key, row)
    }
    return [...rows.values()]
  }
  return {
    retravelers: mergeRows('retravelers', (row) => String(row?.endfield_name || '')),
    visual_parallels_without_lore_relation: mergeRows(
      'visual_parallels_without_lore_relation',
      (row) => `${row?.endfield_name || ''}\0${row?.arknights_name || ''}`,
    ),
  }
}

/** 资料包内关系表优先，插件内置表只为旧包提供最小兼容路由。 */
export async function loadEntityRelationCatalog(store) {
  const dataVersion = store?.dataVersion ?? 'no-store'
  const scopeFingerprint = store?.scopeFingerprint ?? null
  const installationId = store?.installationId ?? null
  const cached = store?._endfieldRelationCatalog
  if (cached?.dataVersion === dataVersion && cached.scopeFingerprint === scopeFingerprint
      && cached.installationId === installationId) return cached.value
  let installed = {}
  try {
    const loaded = await store?.getDocumentByPath?.('config/retravelers.json')
    const record = loaded?.record || loaded
    installed = JSON.parse((record?.lines || []).map((line) => line.text).join('\n') || '{}')
  } catch { installed = {} }
  const value = mergeRelationCatalog(await bundledRelations(), installed)
  if (store) store._endfieldRelationCatalog = { dataVersion, scopeFingerprint, installationId, value }
  return value
}

export function relationEndfieldNames(catalog) {
  return new Set((catalog?.retravelers || [])
    .map((row) => String(row?.endfield_name || '').trim()).filter(Boolean))
}

function normalized(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
}

/** 找出本次请求或可见命中涉及的再旅者；它们是关系，不进入普通 aliases。 */
export function relevantRetravelerRelations(catalog, ...values) {
  const text = normalized(values.map((value) => {
    try { return typeof value === 'string' ? value : JSON.stringify(value) }
    catch { return '' }
  }).join('\n'))
  if (!text) return []
  return (catalog?.retravelers || []).filter((row) => {
    const names = [row?.endfield_name, row?.terra_memory_prototype].map(normalized).filter(Boolean)
    return names.some((name) => text.includes(name))
  }).map((row) => ({
    relation_kind: 'endfield_retraveler_memory_prototype',
    endfield_name: String(row.endfield_name),
    ...(row.terra_memory_prototype
      ? { terra_memory_prototype: String(row.terra_memory_prototype) } : {}),
    relation_status: String(row.relation_status || 'reviewed'),
    not_alias: true,
  }))
}

/**
 * 仅双模块启用、且本次请求本身覆盖两款游戏时，把人工审校关系作为独立附属字段挂到
 * 检索结果。只按请求参数与命中文档标题判断相关性：命中正文里顺带出现某个名字
 * （如语音里提到“艾雅法拉”）不代表用户在问跨游戏关系，挂上只会制造噪声。
 */
export async function attachRetravelerRelations(store, response, request, enabledGames) {
  if (!enabledGames?.includes('arknights') || !enabledGames?.includes('endfield')
      || response?.status === 'error' || response?.error) return response
  const requestedGames = Array.isArray(request?.games) && request.games.length ? request.games : null
  if (requestedGames && !(requestedGames.includes('arknights') && requestedGames.includes('endfield'))) {
    return response
  }
  const catalog = await loadEntityRelationCatalog(store)
  const { after: _after, cursor: _cursor, ...requestFields } = request || {}
  const titles = (Array.isArray(response?.documents) ? response.documents : [])
    .map((document) => document?.title).filter(Boolean)
  const relations = relevantRetravelerRelations(catalog, requestFields, titles)
  return relations.length ? { ...response, retraveler_relations: relations } : response
}
