/** Human-triggered cloud retrieval; no Agent run or evidence-read receipt is fabricated. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AnonymousSessionProvider, StaticTokenProvider, CloudRetrievalClient, cloudErrorResponse } from './cloud.js'
import { attachLocalSourceMappings } from './source-map.js'
import { cloudArchivePresentation } from './archive-presentation.js'

const list = z.array(z.string().trim().min(1).max(512)).min(1).max(16)
const requestSchema = z.object({
  query: z.string().trim().min(1).max(20000),
  games: z.array(z.enum(['arknights', 'endfield'])).min(1).max(2).optional(),
  depth: z.enum(['fast', 'standard', 'deep']).optional(),
  evidence_policy: z.enum(['mixed', 'original_only']).optional(),
  options: z.object({
    search_intent: z.enum(['quote_search', 'scene_search', 'single_sentence_search']).optional(),
    validation: z.enum(['default', 'none', 'record_only', 'llm']).optional(),
    filters: z.object({ speakers: list.optional(), activities: list.optional(), entity_names: list.optional() }).strict().optional(),
    limits: z.object({ final_limit: z.number().int().min(1).max(100) }).strict().optional(),
    query_variants: z.array(z.string().trim().min(1).max(2000)).min(1).max(8).optional(),
  }).strict().optional(),
}).strict()

/** Pair each delivered hit with its resolved original, rather than showing it twice. */
export function manualCloudPresentation(mapped, dataVersion) {
  const sources = new Map()
  for (const item of mapped.data?.items || []) {
    const remote = cloudArchivePresentation({ data: { items: [item] } }, { inspect: true }).sources[0]
    if (!remote) continue
    const mapping = (mapped.local_source_mappings || []).find(value => value.candidate_id === item.candidate_id)
    const anchor = mapping && cloudArchivePresentation({ local_source_mappings: [{ ...mapping,
      suggested_source_ref: mapping.suggested_source_ref || mapping.source_ref_prefix }] }, { dataVersion }).sources[0]
    const { agentRead, ...source } = remote
    const result = { ...source, ...(anchor || {}), excerpt: source.excerpt,
      ...(source.url ? { url: source.url } : {}), state: 'found' }
    const previous = sources.get(result.id)
    if (previous) {
      previous.ranges = [...new Map([...(previous.ranges || []), ...(result.ranges || [])]
        .map(value => [`${value.start}:${value.end}`, value])).values()]
      if (!previous.excerpt) previous.excerpt = result.excerpt
    } else sources.set(result.id, result)
  }
  return { kind: 'prts-archive-sources-v1', sources: [...sources.values()] }
}

export function createManualCloudSearch(shared, { fetchImpl } = {}) {
  let cachedKey, cachedClient
  return async (body, { signal } = {}) => {
    const parsed = requestSchema.safeParse(body)
    if (!parsed.success) return { status: 400, json: { error: '云端检索参数无效，请检查问题、筛选条件与结果数量。', code: 'INVALID_REQUEST' } }
    const config = shared.effective()
    if (!config.cloudEnabled || !config.cloudBaseUrl) return { status: 409, json: { error: '云端检索尚未启用，请在 PRTS 资料设置中启用云端服务。' } }
    const games = [...new Set(parsed.data.games || config.enabledGames)]
    if (games.some(game => !config.enabledGames.includes(game))) return { status: 400, json: { error: '所选游戏资料库未启用，请调整检索范围。' } }
    const key = JSON.stringify([config.cloudBaseUrl, config.cloudToken, config.cloudUserId,
      shared.cloudClientId, config.cloudTimeoutMs, config.cloudMaxResponseBytes, config.enabledGames])
    try {
      signal?.throwIfAborted()
      if (key !== cachedKey) {
        const tokenProvider = config.cloudToken ? new StaticTokenProvider(config.cloudToken)
          : new AnonymousSessionProvider({ baseUrl: config.cloudBaseUrl,
            userId: config.cloudUserId || shared.cloudClientId || undefined,
            timeoutMs: config.cloudTimeoutMs, fetchImpl })
        cachedClient = new CloudRetrievalClient({ baseUrl: config.cloudBaseUrl, tokenProvider,
          games: config.enabledGames, timeoutMs: config.cloudTimeoutMs,
          maxResponseBytes: config.cloudMaxResponseBytes, fetchImpl })
        cachedKey = key
      }
      const client = cachedClient
      await client.capabilities({ signal })
      const response = await client.search({ ...parsed.data, games,
        intent_id: `manual-${randomUUID()}`, options: { ...parsed.data.options,
          include_selected_sources: true, include_answer_context: true } }, { signal })
      signal?.throwIfAborted()
      // Only selected sources belong in this manual result list, never raw candidates.
      const delivered = response.data?.sources || response.data?.selected_sources || []
      const limit = parsed.data.options?.limits?.final_limit || 128
      const items = delivered.slice(0, limit).map((item, index) => ({ ...item, candidate_id: `manual-item-${index}` }))
      // Local mapping preserves our per-item key even when titles differ between services.
      const mapped = await attachLocalSourceMappings(shared.store, { data: { items } }, { signal })
      signal?.throwIfAborted()
      if (key !== JSON.stringify([shared.effective().cloudBaseUrl, shared.effective().cloudToken,
        shared.effective().cloudUserId, shared.cloudClientId, shared.effective().cloudTimeoutMs,
        shared.effective().cloudMaxResponseBytes, shared.effective().enabledGames]) || !shared.effective().cloudEnabled)
        return { status: 409, json: { error: '检索设置已变更，请重新检索。' } }
      const metadata = manualCloudPresentation(mapped, shared.store?.dataVersion)
      // A context-only response stays readable as a fragment, without a made-up locator.
      if (!items.length && typeof response.data?.answer_context === 'string' && response.data.answer_context.trim()) {
        const fallback = cloudArchivePresentation({ data: { answer_context: response.data.answer_context } }, { inspect: true })
        metadata.sources = fallback.sources.map(({ agentRead, ...source }) => ({ ...source, state: 'found' }))
      }
      const warnings = [...(response.data?.errors || []), ...(mapped.local_source_mapping_warning ? [mapped.local_source_mapping_warning] : []),
        ...(delivered.length > limit ? [{ message: `按本轮上限显示前 ${limit} 条命中，可提高数量或缩小范围重新检索。` }] : [])]
      return { status: 200, json: { ...metadata,
        // Manual retrieval is not proof that the Agent read these documents.
        sources: metadata.sources.map(({ agentRead, ...source }) => ({ ...source, state: 'found' })),
        warnings, page: { has_more: false }, mode: 'cloud' } }
    } catch (error) {
      if (signal?.aborted) throw error
      const failure = cloudErrorResponse(error)
      return { status: 502, json: { error: failure.error.message, code: failure.error.code } }
    }
  }
}
