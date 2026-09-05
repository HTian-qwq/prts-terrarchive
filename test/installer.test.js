/**
 * installer.js 单元测试：双源（ModelScope / 站点）按序回退。
 * 用注入的 fetchImpl 同时伪造两个源，覆盖下载/校验/回退/续传/指针写入，
 * 并用真实 CorpusStore 打开下载结果。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CORPUS_RESOURCE_LIMITS,
  ensureCorpusRelease,
  InstallerFault,
  MODELSCOPE_RELEASE_COMPOSITIONS,
  modelScopeAssetUrl,
  resolveModelScopeCurrentRelease,
  resolveTrustedCurrentRelease,
} from '../src/installer.js'
import { AGENT_VERSION, compareSemver, parseSemver } from '../src/release-compatibility.js'
import { CorpusStore, computeLinesIntegrity } from '../src/store.js'

const RELEASE_ID = 'test-rel-1'
const SITE = 'https://prts.chat'
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const canonicalJson = (value) => Array.isArray(value)
  ? `[${value.map(canonicalJson).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
    : JSON.stringify(value)

/** 构造一个合法的最小文档分片（gzip JSONL，行完整性按 store 规则计算）。 */
function buildShard(documentId, prefix, title, text) {
  const lines = [{ line_number: 1, line_type: 'narration', speaker_raw: '', text }]
  const record = {
    document: { document_id: documentId, source_ref_prefix: prefix, display_title: title,
      document_type: 'reference', document_kind: 'reference', line_count: 1 },
    lines, speakers: [], local_integrity: { algorithm: 'sha256:joined-lines-v1',
      sha256: computeLinesIntegrity(lines) },
  }
  return gzipSync(Buffer.from(`${JSON.stringify(record)}\n`, 'utf8'))
}

/**
 * 组装双源假服务。
 * 场景开关：modelscope404（ModelScope 无此 release）、corruptModelscope /
 * corruptSite（对应源的分片字节损坏）。
 */
function buildSources({ modelscope404 = false, corruptModelscope = false, corruptSite = false } = {}) {
  const communityShard = buildShard('client:references:abc', 'client_data:references:' + '0'.repeat(24),
    '测试时间线', '黑暗时代·上 1096年12月23日')
  const officialShard = buildShard('official_game:story:t1', 'official_game:story:t1', '测试剧情', '博士走进了房间')
  const corrupted = (bytes) => Buffer.concat([bytes, Buffer.from('x')])

  const packManifests = {
    official_game: {
      algorithm: 'prts-browser-corpus-pack-v1', schema_version: 1,
      pack_id: 'official_game', data_version: 'b'.repeat(64),
      document_count: 1, line_count: 1, compressed_size: officialShard.length,
      uncompressed_size: gunzipSync(officialShard).length,
      shards: [{ path: 'shards/00000.jsonl.gz', sha256: sha256(officialShard),
        compressed_size: officialShard.length, uncompressed_size: gunzipSync(officialShard).length }],
      search_index: { shards: [] },
    },
    references: {
      algorithm: 'prts-browser-corpus-pack-v1', schema_version: 1,
      pack_id: 'references', authority: 'mixed', data_version: 'c'.repeat(64),
      document_count: 1, line_count: 1, compressed_size: communityShard.length,
      uncompressed_size: gunzipSync(communityShard).length,
      shards: [{ path: 'shards/00000.jsonl.gz', sha256: sha256(communityShard),
        compressed_size: communityShard.length, uncompressed_size: gunzipSync(communityShard).length }],
      search_index: { shards: [] },
    },
  }
  const packShards = {
    official_game: { 'shards/00000.jsonl.gz': officialShard },
    references: { 'shards/00000.jsonl.gz': communityShard },
  }
  const compilerVersion = 'prts-browser-corpus-compiler-test-v1'
  const sourceSnapshot = 'test-snapshot-v1'
  const packOrder = ['official_game', 'references']
  const dataVersion = sha256(Buffer.from(canonicalJson({
    compiler_version: compilerVersion,
    source_snapshot: sourceSnapshot,
    packs: packOrder.map((packId) => {
      const pack = packManifests[packId]
      return { pack_id: packId, data_version: pack.data_version,
        authority: pack.authority ?? 'official',
        shards: pack.shards.map((asset) => ({ path: asset.path, sha256: asset.sha256 })),
        search_index_shards: (pack.search_index?.shards ?? [])
          .map((asset) => ({ path: asset.path, sha256: asset.sha256 })) }
    }),
  })))
  const packSummary = (packId) => {
    const pack = packManifests[packId]
    return { pack_id: packId, manifest_path: `${packId}/pack-manifest.json`,
      authority: pack.authority ?? 'official',
      data_version: pack.data_version, document_count: pack.document_count,
      line_count: pack.line_count, compressed_size: pack.compressed_size,
      uncompressed_size: pack.uncompressed_size, shard_count: pack.shards.length }
  }
  const packs = ['official_game', 'references'].map(packSummary)
  const releaseManifest = {
    algorithm: 'prts-browser-corpus-release-v1',
    release_id: RELEASE_ID, data_version: dataVersion, corpus_version: dataVersion,
    content_tree_sha256: dataVersion, compiler_version: compilerVersion,
    source_update_id: `local-snapshot:${sourceSnapshot}`, schema_version: 1,
    minimum_agent_version: AGENT_VERSION,
    required_packs: packs.map((pack) => pack.pack_id), packs,
    document_count: 2, line_count: 2,
    compressed_size: packs.reduce((sum, pack) => sum + pack.compressed_size, 0),
    uncompressed_size: packs.reduce((sum, pack) => sum + pack.uncompressed_size, 0),
  }

  const counters = { modelscope: 0, site: 0, siteAssets: 0 }

  const fetchImpl = async (url) => {
    const target = String(url)
    // ---- ModelScope 源 ----
    const modelscopeMatch = /modelscope\.cn\/datasets\/([^/]+\/[^/]+)\/resolve\/master\/(.+)$/.exec(target)
    if (modelscopeMatch) {
      counters.modelscope += 1
      if (modelscope404) return new Response('not found', { status: 404 })
      const [, repo, key] = modelscopeMatch
      const asset = /^releases\/[^/]+\/(official_game|references)\/(.+)$/.exec(key)
      if (asset) {
        const [, packId, path] = asset
        const bytes = corruptModelscope ? corrupted(packShards[packId][path]) : packShards[packId][path]
        return new Response(new Uint8Array(bytes), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }
    // ---- 站点源 ----
    if (target.startsWith(`${SITE}/api/agent/data/releases/`)) {
      counters.site += 1
      const rest = target.slice(`${SITE}/api/agent/data/releases/`.length)
      if (rest === 'current') {
        return new Response(JSON.stringify({ code: 200, data: {
          release_id: RELEASE_ID, data_version: dataVersion,
          minimum_agent_version: releaseManifest.minimum_agent_version,
          document_count: releaseManifest.document_count, line_count: releaseManifest.line_count,
          compressed_size: releaseManifest.compressed_size,
          uncompressed_size: releaseManifest.uncompressed_size,
          packs,
          mirrors: [
            { provider: 'modelscope', pack_ids: ['official_game'],
              base_url: `https://modelscope.cn/datasets/${'HTiantian/prts-agent-corpus-arknights-gamedata'}/resolve/master/releases/${RELEASE_ID}/` },
            { provider: 'modelscope', pack_ids: ['references'],
              base_url: `https://modelscope.cn/datasets/${'HTiantian/prts-agent-corpus-selfbuilt'}/resolve/master/releases/${RELEASE_ID}/` },
          ],
        } }), { status: 200 })
      }
      if (rest === `${RELEASE_ID}/release-manifest.json`) {
        return new Response(JSON.stringify(releaseManifest), { status: 200 })
      }
      const asset = new RegExp(`^${RELEASE_ID}/(official_game|references)/(.+)$`).exec(rest)
      if (asset) {
        const [, packId, path] = asset
        if (path === 'pack-manifest.json') {
          return new Response(JSON.stringify(packManifests[packId]), { status: 200 })
        }
        counters.siteAssets += 1
        const bytes = corruptSite ? corrupted(packShards[packId][path]) : packShards[packId][path]
        return new Response(new Uint8Array(bytes), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }
    return new Response('not found', { status: 404 })
  }
  return { fetchImpl, counters, dataVersion,
    expectedBytes: releaseManifest.compressed_size }
}

test('最新版本只由 PRTS.chat current 解析，不查询 ModelScope tree', async () => {
  const { fetchImpl, counters, dataVersion } = buildSources()
  const resolved = await resolveTrustedCurrentRelease({ fetchImpl })
  assert.equal(resolved.releaseId, RELEASE_ID)
  assert.equal(resolved.dataVersion, dataVersion)
  assert.equal(resolved.minimumAgentVersion, AGENT_VERSION)
  assert.equal(counters.modelscope, 0)
  assert.deepEqual(await resolveModelScopeCurrentRelease({ fetchImpl }), {
    releaseId: RELEASE_ID, dataVersion,
  }, '旧导出也必须转发到可信 current')
})

test('可信元数据 origin 固定为 PRTS.chat，siteBaseUrl 只能作为字节源', async () => {
  const sources = buildSources()
  let contacted = false
  await assert.rejects(
    () => resolveTrustedCurrentRelease({
      siteBaseUrl: 'https://metadata.attacker.example',
      fetchImpl: async (...args) => { contacted = true; return sources.fetchImpl(...args) },
    }),
    (error) => error?.code === 'INVALID_REQUEST' && /固定为 https:\/\/prts\.chat/.test(error.message),
  )
  assert.equal(contacted, false, '非法 metadata override 必须在联网前拒绝')

  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-byte-fallback-'))
  try {
    const byteSite = 'https://bytes.example'
    const requested = []
    const fetchImpl = (url, init) => {
      const target = String(url)
      requested.push(target)
      return sources.fetchImpl(target.startsWith(`${byteSite}/`)
        ? `${SITE}/${target.slice(byteSite.length + 1)}` : target, init)
    }
    const result = await ensureCorpusRelease({
      releasesDir: dir, fetchImpl, order: ['site'], siteBaseUrl: byteSite,
    })
    assert.equal(result.status, 'downloaded')
    assert.ok(requested[0].startsWith(`${SITE}/api/agent/data/releases/current`))
    assert.ok(requested.filter((url) => url.endsWith('manifest.json'))
      .every((url) => url.startsWith(`${SITE}/`)), '所有可信清单必须固定来自 PRTS.chat')
    assert.ok(requested.some((url) => url.startsWith(`${byteSite}/`)),
      '配置地址仍可提供受哈希约束的分片字节')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('可信 current 是深冻结句柄，安装器只读取 WeakMap 私有快照', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-snapshot-'))
  try {
    const sources = buildSources()
    const trusted = await resolveTrustedCurrentRelease({ fetchImpl: sources.fetchImpl })
    assert.equal(Object.isFrozen(trusted), true)
    assert.equal(Object.isFrozen(trusted.packs), true)
    assert.equal(Object.isFrozen(trusted.packs[0]), true)
    assert.equal(Object.isFrozen(trusted.mirrors[0].packIds), true)
    assert.equal(Reflect.set(trusted, 'releaseId', 'attacker-release'), false)
    assert.equal(Reflect.set(trusted.packs[0], 'data_version', 'd'.repeat(64)), false)
    assert.equal(trusted.releaseId, RELEASE_ID)

    const result = await ensureCorpusRelease({
      releasesDir: dir, releaseId: RELEASE_ID, trustedCurrent: trusted,
      fetchImpl: sources.fetchImpl,
    })
    assert.equal(result.status, 'downloaded')
    await assert.rejects(
      () => ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID,
        trustedCurrent: { ...trusted }, fetchImpl: sources.fetchImpl }),
      (error) => error?.code === 'INVALID_REQUEST' && /可信 current/.test(error.message),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('分仓错峰发布：历史联合版本仍保留显式镜像组合', () => {
  const releaseId = 'agent-corpus-v2-20260903-xuesong-youmeng-v1'
  const composition = MODELSCOPE_RELEASE_COMPOSITIONS[releaseId]
  assert.equal(composition.releases.official, 'agent-corpus-v1-20260826-timeline-v1')
  assert.equal(composition.releases.endfield, releaseId)
  assert.equal(composition.releases.community, 'agent-corpus-v1-20260826-timeline-v1')
})

test('角色活动拆分版本只更新 community 镜像，其他分仓固定复用已发布版本', () => {
  const releaseId = 'agent-corpus-v2-20260905-character-activity-split-v1'
  const composition = MODELSCOPE_RELEASE_COMPOSITIONS[releaseId]
  assert.equal(composition.dataVersion,
    'ebf6bec17dc40894c8bc1987197f34bd9800be77baa578de4a04f241c542fba9')
  assert.deepEqual(composition.releases, {
    official: 'agent-corpus-v2-20260904-retraveler-alias-fix-v1',
    endfield: 'agent-corpus-v2-20260904-retraveler-alias-fix-v1',
    community: releaseId,
  })
  const asset = (packId) => modelScopeAssetUrl(releaseId, composition.dataVersion,
    `${packId}/shards/00000.jsonl.gz`)
  assert.equal(asset('official_game'),
    'https://modelscope.cn/datasets/HTiantian/prts-agent-corpus-arknights-gamedata/resolve/master/releases/agent-corpus-v2-20260904-retraveler-alias-fix-v1/official_game/shards/00000.jsonl.gz')
  assert.equal(asset('endfield_official_game'),
    'https://modelscope.cn/datasets/HTiantian/prts-agent-corpus-endfield/resolve/master/releases/agent-corpus-v2-20260904-retraveler-alias-fix-v1/endfield_official_game/shards/00000.jsonl.gz')
  assert.equal(asset('reviewed_wiki'),
    `https://modelscope.cn/datasets/HTiantian/prts-agent-corpus-selfbuilt/resolve/master/releases/${releaseId}/reviewed_wiki/shards/00000.jsonl.gz`)
  assert.throws(() => modelScopeAssetUrl(releaseId, '0'.repeat(64),
    'reviewed_wiki/shards/00000.jsonl.gz'),
  (error) => error?.code === 'INVALID_MANIFEST' && /data_version/.test(error.message))
})

test('current 摘要在 versioned manifest 前拒绝更高 minimum_agent_version', async () => {
  const sources = buildSources()
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push(String(url))
    const response = await sources.fetchImpl(url, init)
    const payload = await response.json()
    payload.data.minimum_agent_version = '999.0.0-rc.1+future.7'
    return new Response(JSON.stringify(payload), { status: 200 })
  }
  await assert.rejects(() => resolveTrustedCurrentRelease({ fetchImpl }),
    (error) => error?.code === 'INCOMPATIBLE_RELEASE' && /最新资料至少需要/u.test(error.message))
  assert.deepEqual(requests, [`${SITE}/api/agent/data/releases/current`])
})

test('SemVer 门禁遵循 prerelease 顺序并忽略 build metadata', () => {
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta',
    '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0']
  for (let index = 1; index < ordered.length; index += 1) {
    assert.equal(compareSemver(ordered[index - 1], ordered[index]), -1)
  }
  assert.equal(compareSemver('0.1.0+plugin.9', '0.1.0+release.1'), 0)
  assert.equal(compareSemver('0.1.0', '0.1.0-rc.1+build.7'), 1)
  assert.equal(compareSemver('100000000000000000000.0.0', '99999999999999999999.0.0'), 1)
  for (const invalid of ['', 'v1.0.0', '1.0', '01.0.0', '1.0.0-01',
    '1.0.0+', '1.0.0-alpha..1']) assert.equal(parseSemver(invalid), null)
})

test('minimum_agent_version 在读取 pack manifest 前拒绝不兼容或非法 release', async () => {
  for (const [minimum, code] of [['999.0.0-rc.1+future.7', 'INCOMPATIBLE_RELEASE'],
    ['0.1', 'INVALID_MANIFEST'], [undefined, 'INVALID_MANIFEST']]) {
    const dir = await mkdtemp(join(tmpdir(), 'prts-inst-version-gate-'))
    try {
      const sources = buildSources()
      let packManifestRequests = 0
      const fetchImpl = async (url, init) => {
        const response = await sources.fetchImpl(url, init)
        if (String(url).endsWith(`/${RELEASE_ID}/release-manifest.json`)) {
          const manifest = await response.json()
          if (minimum === undefined) delete manifest.minimum_agent_version
          else manifest.minimum_agent_version = minimum
          return new Response(JSON.stringify(manifest), { status: 200 })
        }
        if (String(url).endsWith('/pack-manifest.json')) packManifestRequests += 1
        return response
      }
      await assert.rejects(
        () => ensureCorpusRelease({ releasesDir: dir, fetchImpl, order: ['site'] }),
        (error) => error?.code === code && /minimum_agent_version|至少需要/u.test(error.message),
      )
      assert.equal(packManifestRequests, 0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

test('未知检索索引算法在下载任何资源前按兼容错误拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-index-gate-'))
  try {
    const sources = buildSources()
    let assetRequests = 0
    const fetchImpl = async (url, init) => {
      const response = await sources.fetchImpl(url, init)
      if (String(url).endsWith('/references/pack-manifest.json')) {
        const manifest = await response.json()
        manifest.search_index = {
          algorithm: 'prts-browser-ngram-postings-v99', schema_version: 99,
          shards: [{ path: 'search-index/00000.bin.gz' }],
        }
        return new Response(JSON.stringify(manifest), { status: 200 })
      }
      if (!String(url).endsWith('manifest.json') && !String(url).endsWith('/releases/current')) {
        assetRequests += 1
      }
      return response
    }
    await assert.rejects(
      () => ensureCorpusRelease({ releasesDir: dir, fetchImpl, order: ['site'] }),
      (error) => error?.code === 'INCOMPATIBLE_RELEASE' && /索引算法/u.test(error.message),
    )
    assert.equal(assetRequests, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ModelScope 命中：先取 PRTS.chat 摘要，再只从镜像下载资源', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-'))
  try {
    const { fetchImpl, counters, expectedBytes } = buildSources()
    const result = await ensureCorpusRelease({
      releasesDir: dir, releaseId: RELEASE_ID, fetchImpl,
      logger: { warn: (m) => console.error('[warn]', m), info: () => {} },
    })
    assert.equal(result.status, 'downloaded')
    assert.equal(result.source, 'modelscope')
    assert.equal(result.bytes, expectedBytes, '并发 worker 必须无损累计全部下载字节')
    assert.ok(counters.site >= 4, 'current、release 与两个 pack manifest 必须来自 PRTS.chat')
    assert.equal(counters.siteAssets, 0)
    assert.equal(counters.modelscope, 2, 'ModelScope 只提供两个固定 release 分片，不读取自报清单')
    const store = new CorpusStore({ releasesDir: dir })
    await store.ready()
    assert.equal(store.documents.size, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ModelScope 无此 release（404）→ 自动回退站点源', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-'))
  try {
    const { fetchImpl, counters, dataVersion } = buildSources({ modelscope404: true })
    const warnings = []
    const result = await ensureCorpusRelease({
      releasesDir: dir, releaseId: RELEASE_ID, fetchImpl,
      logger: { warn: (m) => warnings.push(m), info: () => {} },
    })
    assert.equal(result.status, 'downloaded')
    assert.equal(result.source, 'site')
    assert.ok(counters.site > 0)
    assert.ok(warnings.some((m) => m.includes('modelscope 源失败')), '应记录源回退')

    // 站点源产物同样能被 store 打开；current.json 指针记录来源
    const store = new CorpusStore({ releasesDir: dir })
    await store.ready()
    assert.equal(store.dataVersion, dataVersion)
    const pointer = JSON.parse(await readFile(join(dir, 'current.json'), 'utf8'))
    assert.equal(pointer.channel, 'site')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('order: ["site"] 时直接走站点（不访问 ModelScope）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-'))
  try {
    const { fetchImpl, counters } = buildSources()
    const result = await ensureCorpusRelease({
      releasesDir: dir, releaseId: RELEASE_ID, fetchImpl, order: ['site'],
    })
    assert.equal(result.source, 'site')
    assert.equal(counters.modelscope, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('两个源都损坏 → CHECKSUM_MISMATCH 且不写 current.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-'))
  try {
    const { fetchImpl } = buildSources({ corruptModelscope: true, corruptSite: true })
    await assert.rejects(
      () => ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID, fetchImpl }),
      (error) => error instanceof InstallerFault && error.code === 'CHECKSUM_MISMATCH',
    )
    await assert.rejects(() => readFile(join(dir, 'current.json'), 'utf8'), /ENOENT/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ModelScope 损坏但站点完好 → 回退后成功（跨源续传复用已验分片）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-'))
  try {
    const { fetchImpl } = buildSources({ corruptModelscope: true })
    const result = await ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID, fetchImpl })
    assert.equal(result.source, 'site')
    const store = new CorpusStore({ releasesDir: dir })
    await store.ready()
    assert.equal(store.documents.size, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('断点续传：已就绪分片跳过（只重新拉清单）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-'))
  try {
    const { fetchImpl, counters } = buildSources()
    await ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID, fetchImpl, order: ['site'] })
    await rm(join(dir, 'current.json'))
    await rm(join(dir, RELEASE_ID, 'release-manifest.json'), { force: true })
    const before = counters.site
    const second = await ensureCorpusRelease({
      releasesDir: dir, releaseId: RELEASE_ID, fetchImpl, order: ['site'],
    })
    assert.equal(second.status, 'downloaded')
    assert.equal(second.files, 0, '分片无需重下，可信 pack 清单由 PRTS.chat 元数据阶段刷新')
    assert.ok(counters.site <= before + 5,
      '只重新拉 release/pack 清单及其两个文件，不重新下载分片')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('本地已就绪：二次调用零网络', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-'))
  try {
    const { fetchImpl, counters } = buildSources()
    await ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID, fetchImpl })
    const before = counters.modelscope + counters.site
    const again = await ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID, fetchImpl })
    assert.equal(again.status, 'present')
    assert.equal(counters.modelscope + counters.site, before)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('requireRelease：手动指定版本不被其他当前版本短路', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-required-'))
  try {
    const other = 'other-rel'
    const shard = buildShard('client:references:other', `client_data:references:${'f'.repeat(24)}`,
      '其他版本', '另一个已经完整安装的版本')
    await mkdir(join(dir, other, 'references', 'shards'), { recursive: true })
    await writeFile(join(dir, other, 'references', 'shards', '00000.jsonl.gz'), shard)
    const pack = {
      algorithm: 'prts-browser-corpus-pack-v1', schema_version: 1,
      pack_id: 'references', data_version: 'f'.repeat(64), document_count: 1,
      line_count: 1, compressed_size: shard.length, uncompressed_size: gunzipSync(shard).length,
      shards: [{ path: 'shards/00000.jsonl.gz', sha256: sha256(shard),
        compressed_size: shard.length, uncompressed_size: gunzipSync(shard).length }],
      search_index: { shards: [] },
    }
    await writeFile(join(dir, other, 'references', 'pack-manifest.json'), JSON.stringify(pack))
    const compilerVersion = 'prts-browser-corpus-compiler-test-v1'
    const sourceSnapshot = 'other-snapshot-v1'
    const otherDataVersion = sha256(Buffer.from(canonicalJson({
      compiler_version: compilerVersion,
      source_snapshot: sourceSnapshot,
      packs: [{ pack_id: pack.pack_id, data_version: pack.data_version,
        authority: pack.authority ?? 'official',
        shards: pack.shards.map((asset) => ({ path: asset.path, sha256: asset.sha256 })),
        search_index_shards: [] }],
    })))
    await writeFile(join(dir, other, 'release-manifest.json'), JSON.stringify({
      algorithm: 'prts-browser-corpus-release-v1', schema_version: 1,
      release_id: other, data_version: otherDataVersion, corpus_version: otherDataVersion,
      content_tree_sha256: otherDataVersion, compiler_version: compilerVersion,
      source_update_id: `local-snapshot:${sourceSnapshot}`,
      minimum_agent_version: AGENT_VERSION,
      document_count: 1, line_count: 1, compressed_size: shard.length,
      uncompressed_size: gunzipSync(shard).length, required_packs: ['references'],
      packs: [{ pack_id: 'references', manifest_path: 'references/pack-manifest.json',
        data_version: 'f'.repeat(64), document_count: 1, line_count: 1,
        compressed_size: shard.length, uncompressed_size: gunzipSync(shard).length,
        shard_count: 1 }],
    }))
    await writeFile(join(dir, 'current.json'), JSON.stringify({
      release_id: other, data_version: otherDataVersion,
    }))
    const { fetchImpl, counters } = buildSources()

    const ordinary = await ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID, fetchImpl })
    assert.equal(ordinary.status, 'downloaded')
    assert.equal(JSON.parse(await readFile(join(dir, 'current.json'), 'utf8')).release_id, RELEASE_ID)
    assert.ok(counters.modelscope + counters.site > 0)

    const required = await ensureCorpusRelease({
      releasesDir: dir, releaseId: RELEASE_ID, fetchImpl, requireRelease: true,
    })
    assert.equal(required.status, 'present')
    assert.equal(JSON.parse(await readFile(join(dir, 'current.json'), 'utf8')).release_id, RELEASE_ID)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('并发准备同一 release：跨调用锁避免重复下载', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-lock-'))
  try {
    const { fetchImpl } = buildSources()
    const results = await Promise.all([
      ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID, fetchImpl }),
      ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID, fetchImpl }),
    ])
    assert.deepEqual(results.map((item) => item.status).sort(), ['downloaded', 'present'])
    const store = new CorpusStore({ releasesDir: dir })
    await store.ready()
    assert.equal(store.documents.size, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('崩溃留下的唯一 lease 可安全回收', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-stale-lock-'))
  try {
    const lockDir = join(dir, '.release-mutation-locks')
    await mkdir(lockDir)
    const lock = join(lockDir, `lease-999999999-na-${'d'.repeat(24)}`)
    await writeFile(lock, 'choosing\n')
    const { fetchImpl } = buildSources()
    const result = await ensureCorpusRelease({ releasesDir: dir, fetchImpl, order: ['site'] })
    assert.equal(result.status, 'downloaded')
    await assert.rejects(() => readFile(lock), /ENOENT/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('可信清单防御：非法路径 / 404 / release 不匹配', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-'))
  try {
    const sources = buildSources()
    // PRTS.chat pack 清单带路径穿越时，在接触 ModelScope 资源前拒绝。
    const traversal = async (url) => {
      if (String(url).endsWith('/references/pack-manifest.json')) {
        const original = await sources.fetchImpl(url)
        const manifest = await original.json()
        manifest.shards[0].path = 'shards/../../escape.jsonl.gz'
        return new Response(JSON.stringify(manifest), { status: 200 })
      }
      return sources.fetchImpl(url)
    }
    await assert.rejects(
      () => ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID, fetchImpl: traversal, order: ['modelscope'] }),
      (error) => error.code === 'INVALID_MANIFEST',
    )
    // 全源 404 → RELEASE_NOT_FOUND
    const notFound = async () => new Response('not found', { status: 404 })
    await assert.rejects(
      () => ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID, fetchImpl: notFound }),
      (error) => error.code === 'RELEASE_NOT_FOUND',
    )
    // PRTS.chat release_id 与 current 不匹配。
    const mismatch = async (url) => {
      if (String(url).endsWith(`/${RELEASE_ID}/release-manifest.json`)) {
        const original = await sources.fetchImpl(url)
        const manifest = await original.json()
        manifest.release_id = 'other-rel'
        return new Response(JSON.stringify(manifest), { status: 200 })
      }
      return sources.fetchImpl(url)
    }
    await assert.rejects(
      () => ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID, fetchImpl: mismatch, order: ['modelscope'] }),
      (error) => error.code === 'INVALID_MANIFEST',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('current.data_version 密码学约束后续 pack 逐文件哈希', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-root-'))
  try {
    const sources = buildSources()
    const replacedPackHash = async (url, init) => {
      const response = await sources.fetchImpl(url, init)
      if (!String(url).endsWith('/references/pack-manifest.json')) return response
      const manifest = await response.json()
      manifest.shards[0].sha256 = 'd'.repeat(64)
      return new Response(JSON.stringify(manifest), { status: 200 })
    }
    await assert.rejects(
      () => ensureCorpusRelease({ releasesDir: dir, fetchImpl: replacedPackHash }),
      (error) => error?.code === 'INVALID_MANIFEST' && /data_version/.test(error.message),
    )
    assert.equal(sources.counters.modelscope, 0,
      '内容根不匹配时不得向任何字节源发起下载')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('远程下载不能绕过 PRTS.chat current 去指定其他版本', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-current-pin-'))
  try {
    const sources = buildSources()
    const requested = []
    const changedCurrent = async (url, init) => {
      requested.push(String(url))
      const response = await sources.fetchImpl(url, init)
      if (!String(url).endsWith('/releases/current')) return response
      const payload = await response.json()
      payload.data.release_id = 'other-current-release'
      payload.data.mirrors = []
      return new Response(JSON.stringify(payload), { status: 200 })
    }
    await assert.rejects(
      () => ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID,
        fetchImpl: changedCurrent }),
      (error) => error?.code === 'RELEASE_NOT_CURRENT',
    )
    assert.deepEqual(requested, [`${SITE}/api/agent/data/releases/current`],
      '版本不匹配时不得继续请求自证的 versioned manifest')
    assert.equal(sources.counters.modelscope, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('字节源拒绝跨 origin 重定向，不把 CDN 跳转变成 SSRF 入口', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-redirect-'))
  try {
    const sources = buildSources()
    const contacted = []
    const redirected = async (url, init) => {
      const target = String(url)
      contacted.push(target)
      if (target.includes('modelscope.cn/datasets/')) {
        return new Response(null, { status: 302,
          headers: { location: 'https://cdn.attacker.example/private-probe' } })
      }
      return sources.fetchImpl(url, init)
    }
    await assert.rejects(
      () => ensureCorpusRelease({ releasesDir: dir, fetchImpl: redirected,
        order: ['modelscope'] }),
      (error) => error?.code === 'DOWNLOAD_FAILED' && /不安全地址/.test(error.message),
    )
    assert.equal(contacted.some((url) => url.startsWith('https://cdn.attacker.example/')), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('字节源允许 ModelScope resolve 跳转到官方 LFS 子域', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-modelscope-cdn-'))
  try {
    const sources = buildSources()
    const redirected = async (url, init) => {
      const target = String(url)
      if (target.includes('modelscope.cn/datasets/')) {
        const encoded = Buffer.from(target).toString('base64url')
        return new Response(null, { status: 302,
          headers: { location: `https://cdn-lfs-cn-1.modelscope.cn/${encoded}?Expires=123&Signature=test` } })
      }
      if (target.startsWith('https://cdn-lfs-cn-1.modelscope.cn/')) {
        const encoded = new URL(target).pathname.slice(1)
        return sources.fetchImpl(Buffer.from(encoded, 'base64url').toString('utf8'), init)
      }
      return sources.fetchImpl(url, init)
    }
    const result = await ensureCorpusRelease({ releasesDir: dir, fetchImpl: redirected,
      order: ['modelscope'] })
    assert.equal(result.status, 'downloaded')
    assert.equal(result.source, 'modelscope')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('资源边界：current 总量和 shard 解压尺寸必须可信且有界', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-inst-limits-'))
  try {
    const oversized = buildSources()
    const oversizedCurrent = async (url) => {
      const response = await oversized.fetchImpl(url)
      if (!String(url).endsWith('/releases/current')) return response
      const payload = await response.json()
      payload.data.uncompressed_size = CORPUS_RESOURCE_LIMITS.maxReleaseUncompressedBytes + 1
      return new Response(JSON.stringify(payload), { status: 200 })
    }
    await assert.rejects(
      () => resolveTrustedCurrentRelease({ fetchImpl: oversizedCurrent }),
      (error) => error?.code === 'INVALID_MANIFEST' && /uncompressed_size/.test(error.message),
    )

    const missingSize = buildSources()
    const missingUncompressedSize = async (url) => {
      const response = await missingSize.fetchImpl(url)
      if (!String(url).endsWith('/official_game/pack-manifest.json')) return response
      const manifest = await response.json()
      delete manifest.shards[0].uncompressed_size
      return new Response(JSON.stringify(manifest), { status: 200 })
    }
    await assert.rejects(
      () => ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID,
        fetchImpl: missingUncompressedSize }),
      (error) => error?.code === 'INVALID_MANIFEST' && /uncompressed_size/.test(error.message),
    )
    assert.equal(missingSize.counters.modelscope, 0,
      '可信清单失败后不得开始从 ModelScope 下载')

    const malformedIndexSources = buildSources()
    const malformedIndex = async (url) => {
      const response = await malformedIndexSources.fetchImpl(url)
      if (!String(url).endsWith('/references/pack-manifest.json')) return response
      const manifest = await response.json()
      manifest.search_index = { shards: 'not-an-array' }
      return new Response(JSON.stringify(manifest), { status: 200 })
    }
    await assert.rejects(
      () => ensureCorpusRelease({ releasesDir: dir, releaseId: RELEASE_ID,
        fetchImpl: malformedIndex }),
      (error) => error?.code === 'INVALID_MANIFEST' && /search_index/.test(error.message),
    )
    assert.equal(malformedIndexSources.counters.modelscope, 0,
      '非法 search_index 不得降级为空索引后继续下载')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
