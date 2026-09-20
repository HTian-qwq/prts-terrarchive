import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApi } from '../src/ui.js'
import { CLOUD_CONTRACT_VERSION } from '../src/cloud.js'
import { manualCloudPresentation } from '../src/manual-search.js'
import { CONFIG_DEFAULTS } from '../src/state.js'

function fixture() {
  const config = { ...CONFIG_DEFAULTS, cloudEnabled: true, cloudBaseUrl: 'https://cloud.example', cloudToken: 'fixture-secret' }
  const requests = [], hooks = {}
  const api = buildApi({ effective: () => config }, { fetchImpl: async (url, init) => {
    requests.push({ url, init })
    if (url.endsWith('/capabilities')) return Response.json({ code: 200, data: { contract_version: CLOUD_CONTRACT_VERSION } })
    if (hooks.search) return hooks.search(url, init)
    return Response.json({ code: 200, data: { sources: [{ source_id: 'source-1', title: '云端真实返回标题', content: '**原文**片段', source_type: 'vector_original', url: 'https://example.com/page?token=secret' }] } })
  } })
  return { api, config, requests, hooks }
}
const search = (f, body, options) => f.api.call('POST', '/api/prts-corpus/archive/cloud-search', body, options)

test('manual cloud search forwards supported controls and exposes actual sources without Agent read receipts', async () => {
  const f = fixture()
  const body = { query: '寻找黑蛇的台词', games: ['arknights'], depth: 'deep', evidence_policy: 'original_only', options: {
    search_intent: 'quote_search', validation: 'none', filters: { speakers: ['不死的黑蛇'] }, limits: { final_limit: 30 }, query_variants: ['科西切 台词'] } }
  const result = await search(f, body)
  assert.equal(result.status, 200)
  const source = result.json.sources[0]
  assert.equal(source.title, '云端真实返回标题'); assert.equal(source.excerpt, '**原文**片段')
  assert.equal(source.state, 'found'); assert.equal(source.agentRead, undefined); assert.equal(source.documentId, undefined)
  assert.equal(source.url, 'https://example.com/page')
  assert.equal(result.json.page.has_more, false)
  const payload = JSON.parse(f.requests[1].init.body)
  assert.deepEqual(payload.games, body.games); assert.equal(payload.depth, 'deep')
  assert.equal(payload.options.include_selected_sources, true)
  assert.deepEqual(payload.options.filters, body.options.filters)
  assert.equal(payload.options.limits.final_limit, 30); assert.match(payload.intent_id, /^manual-/)
  assert.equal(f.requests[1].init.headers.Authorization, 'Bearer fixture-secret')
  assert(!JSON.stringify(result).includes('fixture-secret'))
  const options = await f.api.call('GET', '/api/prts-corpus/archive/options')
  assert.deepEqual(options.json, { games: ['arknights', 'endfield'], cloud_enabled: true })
  await search(f, { query: '另一个问题' })
  assert.equal(f.requests.filter(r => r.url.endsWith('/capabilities')).length, 1)
  assert.notEqual(JSON.parse(f.requests.at(-1).init.body).intent_id, payload.intent_id)
})

test('invalid, disabled and disallowed requests never call the cloud', async () => {
  const f = fixture()
  for (const body of [{ query: '' }, { query: 'x', options: { limits: { final_limit: 101 } } },
    { query: 'x', baseUrl: 'https://untrusted.example' }, { query: 'x', options: { validation: 'unknown' } }])
    assert.equal((await search(f, body)).status, 400)
  f.config.cloudEnabled = false
  assert.equal((await search(f, { query: 'x' })).status, 409)
  f.config.cloudEnabled = true; f.config.enabledGames = ['arknights']
  assert.equal((await search(f, { query: 'x', games: ['endfield'] })).status, 400)
  assert.equal(f.requests.length, 0)
})

test('manual cloud cancellation and settings changes discard in-flight results; service errors stay errors', async () => {
  const f = fixture(), controller = new AbortController()
  f.hooks.search = async () => { controller.abort(); return Response.json({ code: 200, data: { sources: [] } }) }
  await assert.rejects(search(f, { query: '取消' }, { signal: controller.signal }))
  f.hooks.search = async () => { f.config.enabledGames = ['endfield']; return Response.json({ code: 200, data: { sources: [] } }) }
  assert.equal((await search(f, { query: '范围变化' })).status, 409)
  f.hooks.search = async () => Response.json({ detail: '服务繁忙，请稍后重试' }, { status: 429 })
  const busy = await search(f, { query: '重试' })
  assert.equal(busy.status, 502); assert.equal(busy.json.code, 'CLOUD_BUSY'); assert.match(busy.json.error, /服务繁忙/)
})


test('manual results pair remote previews with exact local mappings without duplicate titles or false read state', () => {
  const mapped = { data: { items: [
    { candidate_id: 'manual-item-0', title: '云端篇章标题', source_id: 'remote-1', content: '云端实际片段' },
    { candidate_id: 'manual-item-1', title: '同名实体', source_id: 'remote-2', content: '未映射片段' },
    { candidate_id: 'manual-item-2', title: '同名实体', source_id: 'remote-3', content: '不同来源' },
  ] }, local_source_mappings: [{ candidate_id: 'manual-item-0', document_id: 'local-1',
    title: '本地规范篇章标题', source_ref_prefix: 'client_data:official_game:001', start_line: 10, end_line: 13 }] }
  const sources = manualCloudPresentation(mapped, 'a'.repeat(64)).sources
  assert.equal(sources.length, 3)
  assert.equal(sources[0].documentId, 'local-1'); assert.equal(sources[0].excerpt, '云端实际片段')
  assert.deepEqual(sources[0].ranges, [{ start: 10, end: 13 }])
  assert.equal(sources[0].agentRead, undefined);assert.equal(sources[0].state, 'found')
  assert.notEqual(sources[1].id, sources[2].id)
})
