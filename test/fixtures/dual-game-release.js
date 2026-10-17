import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { computeLinesIntegrity } from '../../src/store.js'
import { AGENT_VERSION } from '../../src/release-compatibility.js'

export const GAME_PACKS = {
  arknights: ['official_game', 'reviewed_wiki', 'terra_journey', 'entities', 'references'],
  endfield: ['endfield_official_game', 'endfield_reviewed_knowledge'],
}
const hash = (value) => createHash('sha256').update(value).digest('hex')
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)

/** Real gzip records and trusted full metadata, with observable asset requests. */
export function dualGameRelease({ releaseId = 'dual-game-test', failPack = null } = {}) {
  const requests = []
  const assets = new Map()
  const manifests = new Map()
  for (const [game, packIds] of Object.entries(GAME_PACKS)) {
    for (const packId of packIds) {
      const lines = [{ line_number: 1, line_type: 'narration', speaker_raw: '',
        text: `${game === 'endfield' ? '终末地' : '明日方舟'}共同测试 ${packId}` }]
      const record = { document: { document_id: `${packId}:fixture`,
        source_ref_prefix: `${packId}:fixture`, display_title: `${packId}共同测试`, game,
        document_type: 'reference', document_kind: 'reference', line_count: 1 },
      lines, speakers: [], local_integrity: { algorithm: 'sha256:joined-lines-v1',
        sha256: computeLinesIntegrity(lines) } }
      const raw = Buffer.from(`${JSON.stringify(record)}\n`)
      const bytes = gzipSync(raw)
      const asset = { path: 'shards/00000.jsonl.gz', sha256: hash(bytes),
        compressed_size: bytes.length, uncompressed_size: raw.length }
      assets.set(`${packId}/${asset.path}`, bytes)
      manifests.set(packId, { algorithm: 'prts-browser-corpus-pack-v1', schema_version: 1,
        pack_id: packId, data_version: hash(packId), authority: 'official', document_count: 1,
        line_count: 1, compressed_size: bytes.length, uncompressed_size: raw.length,
        shards: [asset], search_index: { shards: [] } })
    }
  }
  const packs = [...manifests].map(([pack_id, pack]) => ({ pack_id,
    manifest_path: `${pack_id}/pack-manifest.json`, authority: pack.authority,
    data_version: pack.data_version, document_count: 1, line_count: 1,
    compressed_size: pack.compressed_size, uncompressed_size: pack.uncompressed_size,
    shard_count: 1 }))
  const dataVersion = hash(canonical({ compiler_version: 'test-dual-v1', source_snapshot: releaseId,
    packs: [...manifests].map(([pack_id, pack]) => ({ pack_id, data_version: pack.data_version,
      authority: pack.authority, shards: pack.shards.map(({ path, sha256 }) => ({ path, sha256 })),
      search_index_shards: [] })) }))
  const manifest = { algorithm: 'prts-browser-corpus-release-v1', schema_version: 1,
    release_id: releaseId, data_version: dataVersion, corpus_version: dataVersion,
    content_tree_sha256: dataVersion, compiler_version: 'test-dual-v1',
    source_update_id: `local-snapshot:${releaseId}`, minimum_agent_version: AGENT_VERSION,
    required_packs: packs.map((pack) => pack.pack_id), packs, document_count: 7, line_count: 7,
    compressed_size: packs.reduce((sum, pack) => sum + pack.compressed_size, 0),
    uncompressed_size: packs.reduce((sum, pack) => sum + pack.uncompressed_size, 0) }
  const current = { ...manifest, mirrors: Object.entries(GAME_PACKS).map(([game, pack_ids]) => ({
    provider: 'modelscope', pack_ids,
    base_url: `https://modelscope.cn/datasets/HTiantian/prts-agent-corpus-${game}/resolve/master/releases/${releaseId}/`,
  })) }
  const fetchImpl = async (url) => {
    const target = String(url)
    requests.push(target)
    if (target === 'https://prts.chat/api/agent/data/releases/current') {
      return Response.json({ code: 200, data: current })
    }
    const match = /\/releases\/([^/]+)\/(.+)$/.exec(target)
    if (!match || match[1] !== releaseId) return new Response('not found', { status: 404 })
    const path = match[2]
    if (path === 'release-manifest.json') return Response.json(manifest)
    if (path.endsWith('/pack-manifest.json')) {
      const pack = manifests.get(path.split('/')[0])
      return pack ? Response.json(pack) : new Response('not found', { status: 404 })
    }
    const bytes = assets.get(path)
    if (!bytes) return new Response('not found', { status: 404 })
    if (path.startsWith(`${failPack}/`)) return new Response('failed', { status: 503 })
    return new Response(new Uint8Array(bytes))
  }
  return { releaseId, dataVersion, manifest, manifests, assets, requests, fetchImpl,
    assetRequests: () => requests.filter((url) => /\/(?:shards|search-index|catalog|localization)\//.test(url)) }
}
