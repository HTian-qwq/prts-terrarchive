import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { computeLinesIntegrity } from '../../src/store.js'

const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
    : JSON.stringify(v)
const hash = (v) => createHash('sha256').update(v).digest('hex')
export const FIRST_ID = '3040337695571803105'
export const SECOND_ID = '3040337695571803106'
export const PROFILE_ID = '-8653431798136402677'
export const DOC = 'endfield:story:dlg_test'

export function localizationFixture({ releaseId = 'test-i18n', english = 'First translation.', legacy = false } = {}) {
  const packId = 'endfield_official_game'
  const buffers = new Map()
  const asset = (path, rows) => {
    const plain = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
    const bytes = gzipSync(plain)
    buffers.set(`${packId}/${path}`, bytes)
    return { path, sha256: hash(bytes), compressed_size: bytes.length, uncompressed_size: plain.length }
  }
  const lines = [
    { line_number: 1, line_type: 'dialogue', text: '相同原文', speaker_raw: '佩丽卡' },
    { line_number: 2, line_type: 'dialogue', text: '相同原文', speaker_raw: '管理员' },
    { line_number: 3, line_type: 'narration', text: '无映射', speaker_raw: '' },
  ]
  const profileLines = ['第一段', '第二段', '第三段'].map((text, index) => ({
    line_number: index + 1, line_type: 'archive', text, speaker_raw: '' }))
  const document = { document_id: DOC, game: 'endfield', display_title: '测试任务 · 对话',
    document_type: 'story', document_kind: 'story', resource_type: 'original_story',
    story_key: 'dlg_test', source_ref_prefix: 'prts:endfield:story:dlg_test', line_count: lines.length }
  const profile = { document_id: 'endfield:character:pelica:profiles', game: 'endfield',
    display_title: '佩丽卡 / 角色档案', document_type: 'character', document_kind: 'profiles',
    resource_type: 'character_profile', character_name: '佩丽卡', char_id: 'pelica',
    source_ref_prefix: 'prts:endfield:character:pelica:profiles', line_count: 3 }
  const records = [[document, lines], [profile, profileLines]].map(([d, body], index) => ({
    document: d, lines: body, speakers: [], search_index_id: index + 1,
    local_integrity: { algorithm: 'sha256:joined-lines-v1', sha256: computeLinesIntegrity(body) } }))
  const shard = { ...asset('shards/00000.jsonl.gz', records), document_count: 2 }
  const catalogRows = [FIRST_ID, SECOND_ID, PROFILE_ID].map((id, index) => ({
    text_id: id, sources: [{ table: 'TestTable', row_id: `row${index}`, field: 'text' }],
    references: [{ document_id: index < 2 ? DOC : profile.document_id,
      line_start: index < 2 ? index + 1 : 1, line_end: index < 2 ? index + 1 : 3,
      field: 'text', alignment: index < 2 ? 'text' : 'record' }] }))
  const localization = legacy ? null : {
    algorithm: 'prts-official-localization-v1', schema_version: 1, game: 'endfield',
    source_language: 'CN', game_version: '1.5.3', text_count: 3,
    catalog: asset('localization/catalog.jsonl.gz', catalogRows), languages: {
      CN: asset('localization/CN.jsonl.gz', [[FIRST_ID, '相同原文'], [SECOND_ID, '相同原文'], [PROFILE_ID, '第一段\n第二段\n第三段']]),
      EN: asset('localization/EN.jsonl.gz', [[FIRST_ID, english], [SECOND_ID, 'Different translation.'], [PROFILE_ID, 'First paragraph.\nSecond paragraph.']]),
      JP: asset('localization/JP.jsonl.gz', [[FIRST_ID, ''], [SECOND_ID, '異なる訳文'], [PROFILE_ID, '資料']]),
    },
  }
  const assets = [shard, ...(localization ? [localization.catalog, ...Object.values(localization.languages)] : [])]
  const totals = { compressed_size: assets.reduce((n, a) => n + a.compressed_size, 0),
    uncompressed_size: assets.reduce((n, a) => n + a.uncompressed_size, 0), document_count: 2, line_count: 6 }
  const pack = { algorithm: 'prts-browser-corpus-pack-v2', schema_version: 2,
    pack_id: packId, authority: 'official_game_export', data_version: hash(JSON.stringify(assets)),
    game_version: '1.5.3', ...totals, shards: [shard], search_index: { shards: [] },
    ...(localization ? { localization } : {}) }
  const projection = { pack_id: packId, data_version: pack.data_version, authority: pack.authority,
    shards: [{ path: shard.path, sha256: shard.sha256 }], search_index_shards: [],
    ...(localization ? { localization } : {}) }
  const compiler = 'prts-browser-corpus-compiler-test-v1', snapshot = 'test-i18n'
  const version = hash(canonical({ compiler_version: compiler, source_snapshot: snapshot, packs: [projection] }))
  const summary = { pack_id: packId, manifest_path: `${packId}/pack-manifest.json`, authority: pack.authority,
    data_version: pack.data_version, ...totals, shard_count: assets.length }
  const release = { algorithm: 'prts-browser-corpus-release-v1', schema_version: 1, release_id: releaseId,
    data_version: version, corpus_version: version, content_tree_sha256: version,
    source_update_id: `local-snapshot:${snapshot}`, compiler_version: compiler, minimum_agent_version: '0.2.0',
    required_packs: [packId], packs: [summary], ...totals }
  buffers.set(`${packId}/pack-manifest.json`, Buffer.from(JSON.stringify(pack)))
  buffers.set('release-manifest.json', Buffer.from(JSON.stringify(release)))
  const write = async (releasesDir) => {
    for (const [path, bytes] of buffers) {
      const target = join(releasesDir, releaseId, path)
      await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, bytes)
    }
    await writeFile(join(releasesDir, 'current.json'), JSON.stringify({ release_id: releaseId, data_version: version }))
  }
  const fetchImpl = async (url) => {
    const base = 'https://prts.chat/api/agent/data/releases/'
    const path = String(url).slice(base.length)
    if (path === 'current') return Response.json({ code: 200, data: { ...release, mirrors: [] } })
    const bytes = buffers.get(path.slice(releaseId.length + 1))
    return new Response(bytes ? new Uint8Array(bytes) : 'not found', { status: bytes ? 200 : 404 })
  }
  return { write, buffers, release, pack, fetchImpl, version, document, profile }
}
