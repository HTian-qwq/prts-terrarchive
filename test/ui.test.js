/**
 * 设置界面测试：state.js 配置分层、ui.js API 路由、lib/client.js 浏览器半边冒烟。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib'
import vm from 'node:vm'
import { createSharedState, redactConfig } from '../src/state.js'
import { buildApi, applyUi } from '../src/ui.js'
import { CorpusStore, computeLinesIntegrity } from '../src/store.js'

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const canonicalJson = (value) => Array.isArray(value)
  ? `[${value.map(canonicalJson).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
    : JSON.stringify(value)

test('state：三层配置（默认 ← patch ← 用户文件）与写校验', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-state-'))
  try {
    const configPath = join(dir, 'config.json')
    const shared = createSharedState({
      configPath,
      releasesDir: dir,
      patchConfig: { uiSkin: 'prts-agent', cloud: { baseUrl: 'https://patch.example' }, budget: { hardIntentRecords: 5 } },
    })
    // 默认 + base 层
    let effective = shared.effective()
    assert.equal(effective.cloudEnabled, true, 'patch cloud.baseUrl → cloudEnabled')
    assert.equal(effective.cloudBaseUrl, 'https://patch.example')
    assert.equal(effective.uiSkin, 'prts-agent')
    assert.deepEqual(effective.enabledGames, ['arknights', 'endfield'])
    assert.equal(effective.hardIntentRecords, undefined, '旧 patch 预算配置已忽略')

    // 写用户层：合法补丁持久化并覆盖 base
    effective = await shared.saveConfig({ cloudEnabled: false })
    assert.equal(effective.cloudEnabled, false)
    assert.equal(effective.cloudBaseUrl, 'https://patch.example', '未写的键沿用 base')
    const persisted = JSON.parse(await readFile(configPath, 'utf8'))
    assert.deepEqual(persisted, { cloudEnabled: false })

    effective = await shared.saveConfig({ uiSkin: 'prts-agent' })
    assert.equal(effective.uiSkin, 'prts-agent')
    effective = await shared.saveConfig({ uiSkin: 'endfield-aic' })
    assert.equal(effective.uiSkin, 'endfield-aic')
    effective = await shared.saveConfig({ enabledGames: ['endfield'] })
    assert.deepEqual(effective.enabledGames, ['endfield'])
    await assert.rejects(() => shared.saveConfig({ enabledGames: [] }), (e) => e.code === 'INVALID_CONFIG')
    await assert.rejects(() => shared.saveConfig({ enabledGames: ['endfield', 'endfield'] }),
      (e) => e.code === 'INVALID_CONFIG')

    // 新实例从文件恢复用户层
    const reloaded = createSharedState({ configPath, releasesDir: dir, patchConfig: {} })
    await reloaded.loadConfig()
    assert.equal(reloaded.effective().cloudEnabled, false)
    assert.equal(reloaded.effective().uiSkin, 'endfield-aic')

    // 非法补丁拒绝且不落盘
    const before = await readFile(configPath, 'utf8')
    await assert.rejects(() => shared.saveConfig({ nonsense: 1 }), (e) => e.code === 'INVALID_CONFIG')
    await assert.rejects(() => shared.saveConfig({ cloudBaseUrl: 'ftp://x' }), (e) => e.code === 'INVALID_CONFIG')
    await assert.rejects(() => shared.saveConfig({ cloudBaseUrl: 'https://user:secret@example.com' }),
      (e) => e.code === 'INVALID_CONFIG')
    await assert.rejects(() => shared.saveConfig({ cloudBaseUrl: 'https://example.com?token=secret' }),
      (e) => e.code === 'INVALID_CONFIG')
    await assert.rejects(() => shared.saveConfig({ uiSkin: 'unknown' }), (e) => e.code === 'INVALID_CONFIG')
    // 明文 http 仅允许环回主机（本地开发）；局域网/公网明文地址拒绝。
    await assert.rejects(() => shared.saveConfig({ cloudBaseUrl: 'http://192.168.1.5:5565' }), (e) => e.code === 'INVALID_CONFIG')
    effective = await shared.saveConfig({ cloudBaseUrl: 'http://127.0.0.1:5565' })
    assert.equal(effective.cloudBaseUrl, 'http://127.0.0.1:5565')

    // 静态 token 绑定到服务 origin：同源路径调整保留，跨源切换自动清空。
    effective = await shared.saveConfig({ cloudToken: 'origin-secret' })
    effective = await shared.saveConfig({ cloudBaseUrl: 'http://127.0.0.1:5565/v2' })
    assert.equal(effective.cloudToken, 'origin-secret')
    effective = await shared.saveConfig({ cloudBaseUrl: 'https://other.example' })
    assert.equal(effective.cloudToken, '')
    assert.equal(JSON.parse(await readFile(configPath, 'utf8')).cloudToken, '')
    // 旧版用户文件中的预算键安静废弃，不会让升级后的插件启动失败。
    await writeFile(configPath, JSON.stringify({ cloudEnabled: false, uiSkin: 'prts-agent', hardIntentRecords: 9,
      approvalMode: 'on', autoDownload: true }))
    await shared.loadConfig()
    assert.equal(shared.effective().hardIntentRecords, undefined)
    assert.equal(shared.effective().approvalMode, undefined)
    assert.equal(shared.effective().autoDownload, undefined)
    await shared.saveConfig({})
    assert.equal(await readFile(configPath, 'utf8'), '{\n  "cloudEnabled": false,\n  "uiSkin": "prts-agent"\n}\n')

    // 已排队但随后取消的旧皮肤写入不能在前序写完成后复活并覆盖磁盘。
    const firstWrite = shared.saveConfig({ uiSkin: 'prts-agent' })
    const staleController = new AbortController()
    const staleWrite = shared.saveConfig({ uiSkin: 'endfield-aic' }, {
      signal: staleController.signal,
    })
    staleController.abort()
    await firstWrite
    await assert.rejects(staleWrite, (error) => error?.code === 'CANCELLED')
    assert.equal(shared.effective().uiSkin, 'prts-agent')
    assert.equal(JSON.parse(await readFile(configPath, 'utf8')).uiSkin, 'prts-agent')

    // 脱敏
    const red = redactConfig({ ...effective, cloudToken: '' }, {})
    assert.equal(red.cloudToken, undefined)
    assert.equal(red.hasCloudToken, false)
    assert.equal(redactConfig({ cloudToken: 'x' }).hasCloudToken, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/** 造一个最小本地 release（含合法分片，供 activate/reset 链路验证）。 */
async function makeRelease(releasesDir, releaseId, packDataVersion, lineText) {
  const lines = [{ line_number: 1, line_type: 'narration', speaker_raw: '', text: lineText ?? `正文-${releaseId}` }]
  const record = {
    document: { document_id: `client:official_game:${releaseId}`, source_ref_prefix: `client_data:official_game:${'0'.repeat(24)}`,
      display_title: `文档-${releaseId}`, document_type: 'reference', document_kind: 'reference', line_count: 1 },
    lines, speakers: [], local_integrity: { algorithm: 'sha256:joined-lines-v1', sha256: computeLinesIntegrity(lines) },
  }
  const plain = Buffer.from(`${JSON.stringify(record)}\n`)
  const shard = gzipSync(plain)
  const dir = join(releasesDir, releaseId, 'official_game')
  await mkdir(join(dir, 'shards'), { recursive: true })
  const pack = {
    algorithm: 'prts-browser-corpus-pack-v1', schema_version: 1,
    pack_id: 'official_game', game: 'arknights', data_version: packDataVersion,
    document_count: 1, line_count: 1, compressed_size: shard.length,
    uncompressed_size: plain.length,
    shards: [{ path: 'shards/00000.jsonl.gz', sha256: sha256(shard),
      compressed_size: shard.length, uncompressed_size: plain.length }],
    search_index: { shards: [] },
  }
  await writeFile(join(dir, 'pack-manifest.json'), JSON.stringify(pack))
  await writeFile(join(dir, 'shards', '00000.jsonl.gz'), shard)
  const compilerVersion = 'prts-browser-corpus-compiler-test-v1'
  const sourceSnapshot = `ui-${releaseId}`
  const dataVersion = sha256(Buffer.from(canonicalJson({
    compiler_version: compilerVersion,
    source_snapshot: sourceSnapshot,
    packs: [{
      pack_id: pack.pack_id,
      data_version: pack.data_version,
      authority: pack.authority ?? 'official',
      shards: pack.shards.map((asset) => ({ path: asset.path, sha256: asset.sha256 })),
      search_index_shards: [],
    }],
  })))
  await writeFile(join(releasesDir, releaseId, 'release-manifest.json'), JSON.stringify({
    algorithm: 'prts-browser-corpus-release-v1', schema_version: 1,
    release_id: releaseId, data_version: dataVersion, corpus_version: dataVersion,
    content_tree_sha256: dataVersion, compiler_version: compilerVersion,
    minimum_agent_version: '0.1.0',
    source_update_id: `local-snapshot:${sourceSnapshot}`,
    document_count: 1, line_count: 1,
    compressed_size: shard.length, uncompressed_size: plain.length,
    created_at: `2026-01-0${releaseId.length}T00:00:00Z`,
    required_packs: ['official_game'],
    packs: [{ pack_id: 'official_game', manifest_path: 'official_game/pack-manifest.json',
      document_count: 1, line_count: 1, compressed_size: shard.length,
      uncompressed_size: plain.length, shard_count: 1, data_version: packDataVersion }],
  }))
  return dataVersion
}

function trustedCurrentResponse(releaseId, dataVersion, overrides = {}) {
  const { packs: overridePacks, mirrors = [], ...valueOverrides } = overrides
  const values = { document_count: 1, line_count: 1,
    compressed_size: 1000, uncompressed_size: 4000, ...valueOverrides }
  const packs = overridePacks ?? [{ pack_id: 'official_game',
    manifest_path: 'official_game/pack-manifest.json', data_version: dataVersion,
    document_count: values.document_count, line_count: values.line_count,
    compressed_size: values.compressed_size, uncompressed_size: values.uncompressed_size,
    shard_count: 1 }]
  const payload = { data: {
    release_id: releaseId, data_version: dataVersion,
    minimum_agent_version: '0.1.0',
    ...values, packs, mirrors,
  } }
  return { ok: true, status: 200, headers: { get: () => null },
    text: () => Promise.resolve(JSON.stringify(payload)) }
}

test('ui API：不允许激活哈希损坏的 release', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-ui-invalid-'))
  try {
    const releasesDir = join(dir, 'releases')
    await mkdir(releasesDir, { recursive: true })
    const goodVersion = await makeRelease(releasesDir, 'rel-good', 'a'.repeat(64))
    await makeRelease(releasesDir, 'rel-bad', 'b'.repeat(64))
    await writeFile(join(releasesDir, 'current.json'), JSON.stringify({
      release_id: 'rel-good', data_version: goodVersion,
    }))
    const shardPath = join(releasesDir, 'rel-bad', 'official_game', 'shards', '00000.jsonl.gz')
    const corrupted = Buffer.from(await readFile(shardPath))
    corrupted[0] ^= 0xff
    await writeFile(shardPath, corrupted)
    const shared = createSharedState({ configPath: join(dir, 'config.json'), releasesDir,
      patchConfig: { enabledGames: ['arknights'] } })
    await shared.loadConfig()
    const api = buildApi(shared, { logger: { info: () => {}, warn: () => {} } })
    const result = await api.call('POST', '/api/prts-corpus/activate', { releaseId: 'rel-bad' })
    assert.equal(result.status, 400)
    assert.match(result.json.error, /SHA-256/)
    const current = JSON.parse(await readFile(join(releasesDir, 'current.json'), 'utf8'))
    assert.equal(current.release_id, 'rel-good')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ui API：激活与删除同一 release 串行，不能留下悬空 current 指针', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-ui-mutation-race-'))
  try {
    const releasesDir = join(dir, 'releases')
    await mkdir(releasesDir, { recursive: true })
    const versionA = await makeRelease(releasesDir, 'rel-a', 'a'.repeat(64))
    await makeRelease(releasesDir, 'rel-b', 'b'.repeat(64))
    await writeFile(join(releasesDir, 'current.json'), JSON.stringify({
      release_id: 'rel-a', data_version: versionA,
    }))
    const shared = createSharedState({ configPath: join(dir, 'config.json'), releasesDir,
      patchConfig: { enabledGames: ['arknights'] } })
    const api = buildApi(shared, { logger: { info: () => {}, warn: () => {} } })
    shared.download.active = true
    shared.download.releaseId = 'rel-b'
    const duringDownload = await api.call('POST', '/api/prts-corpus/activate', { releaseId: 'rel-b' })
    assert.equal(duringDownload.status, 409)
    assert.equal(JSON.parse(await readFile(join(releasesDir, 'current.json'), 'utf8')).release_id, 'rel-a')
    shared.download.active = false
    shared.download.releaseId = null
    const [activated, removed] = await Promise.all([
      api.call('POST', '/api/prts-corpus/activate', { releaseId: 'rel-b' }),
      api.call('POST', '/api/prts-corpus/delete', { releaseId: 'rel-b' }),
    ])
    assert.equal(activated.status, 200)
    assert.equal(removed.status, 409)
    assert.equal(JSON.parse(await readFile(join(releasesDir, 'current.json'), 'utf8')).release_id, 'rel-b')
    assert.equal((await stat(join(releasesDir, 'rel-b'))).isDirectory(), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ui API：releases / activate / delete / config / status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-ui-'))
  try {
    const releasesDir = join(dir, 'releases')
    await mkdir(releasesDir, { recursive: true })
    const versionA = await makeRelease(releasesDir, 'rel-a', 'a'.repeat(64))
    const versionB = await makeRelease(releasesDir, 'rel-b', 'b'.repeat(64))
    await writeFile(join(releasesDir, 'current.json'), JSON.stringify({ release_id: 'rel-a', data_version: versionA }))
    const shared = createSharedState({ configPath: join(dir, 'config.json'), releasesDir,
      patchConfig: { enabledGames: ['arknights'] } })
    await shared.loadConfig()
    const api = buildApi(shared, { logger: { info: () => {}, warn: () => {} } })

    // releases 清单
    const list = await api.call('GET', '/api/prts-corpus/releases')
    assert.equal(list.status, 200)
    assert.equal(list.json.releases.length, 2)
    const active = list.json.releases.find((item) => item.releaseId === 'rel-a')
    assert.equal(active.active, true)
    assert.ok(active.sizeBytes > 0)
    assert.equal(active.documentCount, 1)
    assert.equal(active.datasets.arknights.present, true)
    assert.equal(active.datasets.arknights.documentCount, 1)
    assert.equal(active.datasets.endfield.present, false)

    // 挂上真 store 验证 status 与激活热切换
    const store = new CorpusStore({ releasesDir })
    shared.store = store
    await store.ready()
    const status = await api.call('GET', '/api/prts-corpus/status')
    assert.equal(status.status, 200)
    assert.equal(status.json.store.releaseId, 'rel-a')
    assert.equal(status.json.store.documentCount, 1)
    assert.equal(status.json.store.installed, true)
    assert.equal(status.json.store.installationIssue, null)
    assert.equal(status.json.config.hasCloudToken, false)

    // 激活 rel-b → store 热重载到新版本
    const activated = await api.call('POST', '/api/prts-corpus/activate', { releaseId: 'rel-b' })
    assert.equal(activated.status, 200)
    await store.ready()
    assert.equal(store.releaseId, 'rel-b')
    assert.equal(store.dataVersion, versionB)

    // 删除保护：当前版本拒绝；非当前可删
    const deny = await api.call('POST', '/api/prts-corpus/delete', { releaseId: 'rel-b' })
    assert.equal(deny.status, 409)
    const removed = await api.call('POST', '/api/prts-corpus/delete', { releaseId: 'rel-a' })
    assert.equal(removed.status, 200)
    await assert.rejects(() => stat(join(releasesDir, 'rel-a')), /ENOENT/)

    // 配置写
    const saved = await api.call('PUT', '/api/prts-corpus/config', { patch: { cloudEnabled: true, cloudBaseUrl: 'https://x.example' } })
    assert.equal(saved.status, 200)
    assert.equal(shared.effective().cloudEnabled, true)
    const badConfig = await api.call('PUT', '/api/prts-corpus/config', { patch: { cloudBaseUrl: 123 } })
    assert.equal(badConfig.status, 400)

    // releaseId 形式合法也不能成为任意递归删除原语；非资料目录原样保留。
    const foreignDir = join(releasesDir, 'foreign-directory')
    await mkdir(foreignDir)
    await writeFile(join(foreignDir, 'keep.txt'), 'user data')
    const foreignDelete = await api.call('POST', '/api/prts-corpus/delete', { releaseId: 'foreign-directory' })
    assert.equal(foreignDelete.status, 400)
    assert.equal(await readFile(join(foreignDir, 'keep.txt'), 'utf8'), 'user data')

    // 未知路由
    assert.equal((await api.call('GET', '/api/prts-corpus/none')).status, 404)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('CorpusStore：reset 期间旧初始化不会覆盖新版本', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-store-race-'))
  try {
    const releasesDir = join(dir, 'releases')
    await mkdir(releasesDir, { recursive: true })
    await makeRelease(releasesDir, 'rel-a', 'a'.repeat(64))
    const versionB = await makeRelease(releasesDir, 'rel-b', 'b'.repeat(64))
    await writeFile(join(releasesDir, 'current.json'), JSON.stringify({ release_id: 'rel-a' }))

    const store = new CorpusStore({ releasesDir })
    const originalRead = store._readPacked.bind(store)
    let enteredResolve
    let continueResolve
    const entered = new Promise((resolve) => { enteredResolve = resolve })
    const continueOld = new Promise((resolve) => { continueResolve = resolve })
    store._readPacked = async (packId, shardPath, releaseId, descriptor) => {
      if (releaseId === 'rel-a') {
        enteredResolve()
        await continueOld
      }
      return originalRead(packId, shardPath, releaseId, descriptor)
    }

    const oldReady = store.ready()
    await entered
    await writeFile(join(releasesDir, 'current.json'), JSON.stringify({ release_id: 'rel-b' }))
    store.reset()
    const newReady = store.ready()
    continueResolve()
    await Promise.all([oldReady, newReady])
    assert.equal(store.loaded, true)
    assert.equal(store.releaseId, 'rel-b')
    assert.equal(store.dataVersion, versionB)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ui API：check-update 以 PRTS.chat current 摘要选择最新版本', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-chk-'))
  try {
    const releasesDir = join(dir, 'releases')
    await mkdir(releasesDir, { recursive: true })
    const versionA = await makeRelease(releasesDir, 'rel-a', 'a'.repeat(64))
    await writeFile(join(releasesDir, 'current.json'), JSON.stringify({ release_id: 'rel-a', data_version: versionA }))
    const shared = createSharedState({ configPath: join(dir, 'config.json'), releasesDir, patchConfig: {} })
    await shared.loadConfig()
    const quiet = { logger: { info: () => {}, warn: () => {} } }

    // PRTS.chat 发布的可信摘要指向 rel-new → 有更新。
    const requested = []
    const mockFetch = (url) => {
      requested.push(String(url))
      return Promise.resolve(trustedCurrentResponse('rel-new', 'b'.repeat(64), {
        document_count: 2, line_count: 20,
      }))
    }
    const api = buildApi(shared, { ...quiet, fetchImpl: mockFetch })
    const result = await api.call('GET', '/api/prts-corpus/check-update')
    assert.equal(result.status, 200)
    assert.equal(result.json.updateAvailable, true)
    assert.equal(result.json.remote.releaseId, 'rel-new')
    assert.equal(result.json.remote.minimumAgentVersion, '0.1.0')
    assert.equal(result.json.remote.documentCount, 2)
    assert.equal(result.json.source, 'site')
    assert.deepEqual(requested, ['https://prts.chat/api/agent/data/releases/current'])

    // 检查页面可能长时间打开；点下载时后端必须重取 current，不能把
    // 过期的 UI releaseId 当成可绕过信任锚的 pin。
    const staleDownload = await api.call('POST', '/api/prts-corpus/download', {
      releaseId: 'rel-stale-from-ui',
    })
    assert.equal(staleDownload.status, 409)
    assert.equal(shared.download.active, false)
    assert.deepEqual(requested, [
      'https://prts.chat/api/agent/data/releases/current',
      'https://prts.chat/api/agent/data/releases/current',
    ])

    // release id 与 data_version 均一致 → 已最新。
    const sameFetch = () => Promise.resolve(trustedCurrentResponse('rel-a', versionA))
    const same = await buildApi(shared, { ...quiet, fetchImpl: sameFetch }).call('GET', '/api/prts-corpus/check-update')
    assert.equal(same.status, 200)
    assert.equal(same.json.updateAvailable, false)

    // 信任锚不可达 → 不向镜像猜“最新”，返回 remote=null + 可读提示。
    const failed = await buildApi(shared, { ...quiet, fetchImpl: () => Promise.reject(new Error('ENETUNREACH')) })
      .call('GET', '/api/prts-corpus/check-update')
    assert.equal(failed.status, 200)
    assert.equal(failed.json.remote, null)
    assert.equal(failed.json.updateAvailable, false)
    assert.ok(failed.json.error)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('applyUi：挂载 Connection 认证 RPC 通道 + 结果/错误映射', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-http-'))
  try {
    const releasesDir = join(dir, 'releases')
    await mkdir(releasesDir, { recursive: true })
    const shared = createSharedState({ configPath: join(dir, 'config.json'), releasesDir, patchConfig: {} })
    let channel = null
    let handler = null
    let options = null
    const ctx = {
      connection: { rpc: { handle: (nextChannel, nextHandler, nextOptions) => {
        channel = nextChannel
        handler = nextHandler
        options = nextOptions
        return () => {}
      } } },
      logger: { info: () => {} },
    }
    assert.equal(applyUi(ctx, shared), true)
    assert.equal(channel, '/prts-corpus')
    // 第三参 { authority } 在 rc.2 宿主上必填（缺失会 TypeError）；新宿主忽略。
    assert.deepEqual(options, { authority: 'loopback' })
    assert.equal(typeof handler, 'function')

    const ok = await handler('status', {}, new AbortController().signal)
    assert.equal(ok.ok, true)
    assert.equal(ok.value.store.loaded, false)
    assert.equal(ok.value.store.installed, false)
    assert.match(ok.value.store.installationIssue, /未找到本地语料/u)

    const saved = await handler('config.update', { patch: { cloudEnabled: true } },
      new AbortController().signal)
    assert.equal(saved.ok, true)
    assert.equal(saved.value.config.cloudEnabled, true)

    const cancelledController = new AbortController()
    cancelledController.abort()
    const cancelled = await handler('config.update', { patch: { cloudEnabled: false } },
      cancelledController.signal)
    assert.equal(cancelled.ok, false)
    assert.equal(cancelled.error.code, 'cancelled')
    assert.equal(shared.effective().cloudEnabled, true,
      'transport 取消后的旧 RPC 不得改变 Host 配置')

    const bad = await handler('config.update', { patch: { cloudEnabled: 'yes' } })
    assert.equal(bad.ok, false)
    assert.equal(bad.error.code, 'bad-request')
    const unknown = await handler('unknown', {})
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'not-found')

    // headless（无 connection）静默跳过
    assert.equal(applyUi({}, shared), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('地图资源：Accept-Encoding 尊重 q=0，并为 identity 解压回退', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-map-http-'))
  try {
    const registrations = []
    const shared = createSharedState({ configPath: join(dir, 'config.json'), releasesDir: dir,
      patchConfig: {} })
    const ctx = {
      connection: { rpc: { handle: () => () => {} } },
      webServer: { register: (entry) => { registrations.push(entry); return () => {} } },
      effect: (operation) => operation(),
      logger: { info: () => {}, warn: () => {} },
    }
    assert.equal(applyUi(ctx, shared), true)
    const route = registrations.find((entry) => entry.path === '/prts-corpus/endfield-map')
    assert.ok(route)
    const request = async (acceptEncoding,
      url = '/prts-corpus/endfield-map/resources/map-00b0d0744a1b4404.json') => {
      const response = { status: null, headers: {}, body: undefined,
        writeHead(status, headers = {}) { this.status = status; this.headers = headers },
        end(body) { this.body = body } }
      await route.handler({ method: 'GET',
        url,
        headers: { 'accept-encoding': acceptEncoding } }, response)
      return response
    }
    const startEventRequest = (acceptEncoding = 'gzip',
      url = '/prts-corpus/endfield-map/resources/map-00b0d0744a1b4404.json') => {
      const req = new EventEmitter()
      Object.assign(req, { method: 'GET', url, aborted: false,
        headers: { 'accept-encoding': acceptEncoding } })
      const response = new EventEmitter()
      Object.assign(response, {
        status: null, headers: {}, body: undefined, destroyed: false,
        writeHead(status, headers = {}) { this.status = status; this.headers = headers },
        end(body) { this.body = body },
      })
      return { req, response, done: route.handler(req, response) }
    }

    const gzip = await request('br;q=0, gzip;q=1, identity;q=0')
    assert.equal(gzip.status, 200)
    assert.equal(gzip.headers['content-encoding'], 'gzip')
    assert.doesNotThrow(() => JSON.parse(gunzipSync(gzip.body).toString('utf8')))

    const identity = await request('br;q=0, gzip;q=0')
    assert.equal(identity.status, 200)
    assert.equal(identity.headers['content-encoding'], undefined)
    assert.doesNotThrow(() => JSON.parse(identity.body.toString('utf8')))

    const unacceptable = await request('br;q=0, gzip;q=0, identity;q=0')
    assert.equal(unacceptable.status, 406)

    // 随机 .json 名不得进入 identity 解压队列；只服务打包时建立的
    // 逻辑资源白名单，避免公开静态路由被 miss 洪泛耗尽。
    const randomMisses = await Promise.all(Array.from({ length: 100 }, (_, index) =>
      request('identity', `/prts-corpus/endfield-map/resources/random-${index}.json`)))
    assert.ok(randomMisses.every((response) => response.status === 404))

    const saturated = await Promise.all(Array.from({ length: 40 }, () => request('identity')))
    assert.ok(saturated.some((response) => response.status === 503),
      '地图路由的总并发请求必须有硬上限')
    assert.ok(saturated.every((response) => response.status === 200 || response.status === 503))
    assert.equal((await request('identity')).status, 200, '防护计数在请求完成后应释放')

    // close 只能取消工作，不能在尚未 settle 的 lstat/readFile 期间提前归还槽。
    // 同一同步轮次再发 32 个请求时，只应有 31 个可取得剩余槽位。
    const disconnected = startEventRequest('gzip')
    disconnected.response.emit('close')
    const whileDisconnectSettles = Array.from({ length: 32 }, () => startEventRequest('gzip'))
    await Promise.all(whileDisconnectSettles.map((entry) => entry.done))
    assert.equal(whileDisconnectSettles.filter((entry) => entry.response.status === 503).length, 1)
    await disconnected.done
    assert.equal(disconnected.req.listenerCount('aborted'), 0)
    assert.equal(disconnected.response.listenerCount('finish'), 0)
    assert.equal(disconnected.response.listenerCount('close'), 0)
    for (const entry of whileDisconnectSettles) {
      if (entry.response.status === 200) entry.response.emit('finish')
    }

    // handler 返回不代表大 Buffer 已被 socket 消费。模拟不触发 finish 的
    // 慢客户端，槽位必须保持占用；finish 后才允许新请求。
    const slowResponses = Array.from({ length: 32 }, () => startEventRequest('gzip'))
    await Promise.all(slowResponses.map((entry) => entry.done))
    assert.ok(slowResponses.every((entry) => entry.response.status === 200))
    assert.equal((await request('gzip')).status, 503,
      '未完成发送的慢响应必须继续占用总请求槽')
    for (const entry of slowResponses) {
      assert.equal(entry.req.listenerCount('aborted'), 1)
      assert.equal(entry.response.listenerCount('finish'), 1)
      assert.equal(entry.response.listenerCount('close'), 1)
      entry.response.emit('finish')
      entry.response.emit('close')
      assert.equal(entry.req.listenerCount('aborted'), 0)
      assert.equal(entry.response.listenerCount('finish'), 0)
      assert.equal(entry.response.listenerCount('close'), 0)
    }
    assert.equal((await request('gzip')).status, 200, '响应 finish 后应释放总请求槽')

    // 共享 identity 解压不能绑定首个请求的取消信号。先用两个大资源占满
    // 解压槽，再让两个客户端共享第三个排队任务；owner 断连不能连坐 follower。
    const mapUrl = (name) => `/prts-corpus/endfield-map/resources/${name}`
    const blockers = [
      startEventRequest('identity', mapUrl('map-758c13be6085ec07.json')),
      startEventRequest('identity', mapUrl('map-8385e11f39e1a51c.json')),
    ]
    await new Promise((resolveWait) => setImmediate(resolveWait))
    const owner = startEventRequest('identity', mapUrl('map-ddd43dbb8ab8a4e3.json'))
    await new Promise((resolveWait) => setImmediate(resolveWait))
    const follower = startEventRequest('identity', mapUrl('map-ddd43dbb8ab8a4e3.json'))
    owner.response.emit('close')
    await Promise.all([...blockers.map((entry) => entry.done), owner.done, follower.done])
    assert.equal(follower.response.status, 200,
      '共享解压创建者断连不应取消其他仍存活的等待者')
    for (const entry of [...blockers, follower]) entry.response.emit('finish')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ui API：read 拉全文（超限值被夹到契约范围，证据卡点开可读）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-read-'))
  try {
    const releasesDir = join(dir, 'releases')
    await mkdir(releasesDir, { recursive: true })
    const versionA = await makeRelease(releasesDir, 'rel-a', 'a'.repeat(64))
    await writeFile(join(releasesDir, 'current.json'), JSON.stringify({ release_id: 'rel-a', data_version: versionA }))
    const shared = createSharedState({ configPath: join(dir, 'config.json'), releasesDir, patchConfig: {} })
    await shared.loadConfig()
    const store = new CorpusStore({ releasesDir })
    shared.store = store
    await store.ready()
    const api = buildApi(shared, { logger: { info: () => {}, warn: () => {} } })

    // 客户端传入超限的 max_lines/max_chars → 路由应夹到契约允许的最值，而不是让 executeRead 报错。
    const clamped = await api.call('POST', '/api/prts-corpus/read', {
      locator: { document_id: 'client:official_game:rel-a' },
      selection: { mode: 'document' },
      max_lines: 2000, max_chars: 200000,
    })
    assert.equal(clamped.status, 200)
    assert.equal(clamped.json.ok, true)
    assert.equal(clamped.json.response.status, 'ok')
    assert.equal(clamped.json.response.normalized_request.limits.max_lines, 500)
    assert.equal(clamped.json.response.normalized_request.limits.max_chars, 100000)
    assert.equal(clamped.json.response.status, 'ok')
    assert.equal(clamped.json.response.content.lines.length, 1)
    assert.equal(clamped.json.response.content.lines[0].text, '正文-rel-a')

    // 契约次小值：max_lines 最少 1、max_chars 最少 100 也被正确保留。
    const minOk = await api.call('POST', '/api/prts-corpus/read', {
      locator: { document_id: 'client:official_game:rel-a' },
      selection: { mode: 'document' },
      max_lines: 1, max_chars: 100,
    })
    assert.equal(minOk.json.ok, true)
    assert.equal(minOk.json.response.normalized_request.limits.max_lines, 1)

    // 缺定位器 → 400
    const missing = await api.call('POST', '/api/prts-corpus/read', { selection: { mode: 'document' } })
    assert.equal(missing.status, 400)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ui API read：首行超过 max_chars 报 BUDGET_EXCEEDED；activity 定位直达契约层', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-read-edge-'))
  try {
    const releasesDir = join(dir, 'releases')
    await mkdir(releasesDir, { recursive: true })
    const longVersion = await makeRelease(releasesDir, 'rel-long', 'c'.repeat(64), '超长正文行'.repeat(24)) // 120 字符
    await writeFile(join(releasesDir, 'current.json'), JSON.stringify({ release_id: 'rel-long', data_version: longVersion }))
    const shared = createSharedState({ configPath: join(dir, 'config.json'), releasesDir, patchConfig: {} })
    await shared.loadConfig()
    const store = new CorpusStore({ releasesDir })
    shared.store = store
    await store.ready()
    const api = buildApi(shared, { logger: { info: () => {}, warn: () => {} } })

    // 首行即超过 max_chars：显式报 BUDGET_EXCEEDED，而不是返回
    // “0 行 ok + 原地 next_cursor”导致分页死循环。
    const budget = await api.call('POST', '/api/prts-corpus/read', {
      locator: { document_id: 'client:official_game:rel-long' },
      selection: { mode: 'document' },
      max_lines: 10, max_chars: 100,
    })
    assert.equal(budget.status, 200)
    assert.equal(budget.json.ok, false)
    assert.equal(budget.json.error.code, 'BUDGET_EXCEEDED')

    // 放宽预算后同一文档正常读取。
    const okRead = await api.call('POST', '/api/prts-corpus/read', {
      locator: { document_id: 'client:official_game:rel-long' },
      selection: { mode: 'document' },
      max_lines: 10, max_chars: 1000,
    })
    assert.equal(okRead.json.ok, true)
    assert.equal(okRead.json.response.content.lines.length, 1)

    // activity 定位不再被“必须有 source_ref/document_id”的前置校验挡掉；
    // 路由放行后由契约层报告活动不存在。
    const activityRead = await api.call('POST', '/api/prts-corpus/read', {
      locator: { activity_name: '不存在的活动' },
      selection: { mode: 'activity' },
    })
    assert.equal(activityRead.status, 200)
    assert.equal(activityRead.json.ok, false)
    assert.equal(activityRead.json.error.code, 'DOCUMENT_NOT_FOUND')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('client bundle：ModuleLoader 工厂产出插件并注册皮肤设置与 PRTS 界面席位', async () => {
  const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const agentCss = readFileSync(new URL('../lib/skins/prts-agent.css', import.meta.url), 'utf8')
  const source = `${clientSource}\n${agentCss}`
  assert.doesNotMatch(clientSource, /安装指定版本|placeholder: 'releaseId'|showManual|submitCustom/,
    '远程安装只能跟随可信 current，不能重新暴露无效的任意版本入口')
  assert.match(clientSource,
    /jsonFetch\('\/download', \{ method: 'POST', body: JSON\.stringify\(\{\}\) \}\)/,
    '下载按钮必须请求可信 current，不能携带 UI 输入的 releaseId')
  assert.match(source, /\[data-phase\]:not\(#prts-agent-scene\)/,
    '运行态必须读取 Conversation，不能读回场景自身')
  assert.match(source, /--agent-content-center/,
    'PRTS 主视觉必须跟随 Conversation 的真实中心，而不是猜测侧栏宽度')
  assert.match(source, /composerSeatRect\.top - currentY/,
    '垂直间距必须测量包含工作区和模式工具栏的完整 composer seat')
  assert.match(source, /heroRect\.bottom \+ 44 - baseComposerTop/,
    '欢迎文案与完整 composer 必须根据真实矩形保留宽松间距')
  assert.match(source, /--prts-agent-composer-y/,
    '输入卡必须支持独立的响应式垂直位移')
  assert.match(source, /\[data-conversation-scroll\]>:not\(\[data-composer-seat\]\)\{background:transparent!important\}/,
    '进入会话时必须清除内容层完整背景，避免白色背景随淡入造成亮度跳变')
  assert.doesNotMatch(source, /grid-template-columns:260px/,
    '皮肤不能覆盖 Harness 自己的可调侧栏列宽')
  assert.match(source, /cpuDebugBuffer !== 'priestess'/,
    '必须保留原版 priestess CPU 彩蛋')
  assert.match(source, /\.prts-cpu-assembly\.is-purple/,
    'priestess 彩蛋必须有紫色 CPU 视觉')
  assert.match(source, /scene\.dataset\.phase = 'leaving'/,
    '空白态进入对话只过渡 PRTS 场景自身')
  assert.doesNotMatch(source, /data-prts-hero-exit/,
    '不能延迟切换整个会话内容透明度，否则约一秒后会发生亮度跳变')
  assert.match(source, /\[data-phase="active"\]:not\(#prts-agent-scene\)>:first-child/,
    '会话顶部栏样式必须排除 PRTS 场景，否则会把 560px 系统地图层染白')
  assert.match(source, /\[data-chat-flow\]>\[data-chat-flow-key\]\{animation:prts-chat-history-enter/,
    '历史记录加载完成后，新挂载的消息行必须立即柔和淡入')
  assert.doesNotMatch(source, /> :not\(#prts-agent-scene\) \{ position: relative/,
    '不能覆盖 body Portal 弹窗的 fixed 定位，否则添加工作区目录选择器会失效')
  assert.doesNotMatch(source, /prts-corpus-status/,
    '侧栏不再挂载重复且容易误报的资料状态卡')
  assert.doesNotMatch(source, /grid-template-rows:20px 17px/,
    '会话行不能强制改成两行 grid，否则运行状态会与标题重叠')
  assert.match(source, /document\.addEventListener\('visibilitychange', syncMapActivity\)/,
    '终末地地图必须在页面不可见时停止渲染')
  assert.match(source, /globalThis\.addEventListener\('prts-shell-visibility', syncMapActivity\)/,
    '便携桌面进入托盘时必须显式通知终末地地图')
  assert.match(source, /if \(pageIsActive\(\)\) map\.resume\?\.\(\)[^]*else map\.pause\?\.\(\)/,
    '地图后台状态必须映射到运行时 pause/resume')
  assert.match(source, />span:nth-child\(1\)>span:not\(\[data-state\]\).*clip-path:inset\(50%\)/s,
    '会话状态的 screen-reader 文本必须保持视觉隐藏')
  let entry = null
  const window = { __ModuleLoader__: { load: (value) => { entry = value } } }
  vm.runInNewContext(clientSource, { window, console, AbortController, setTimeout, clearTimeout })

  assert.equal(entry.id, 'prts-terrarchive')
  const reactStub = {
    createElement: (...args) => ({ args }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }),
    Fragment: 'Fragment',
  }
  const plugin = entry.factory((id) => {
    if (id === 'react') return reactStub
    throw new Error(`意外依赖 ${id}`)
  })
  assert.deepEqual([...plugin.inject], ['slots', 'connection', 'theme', 'sessions'])
  assert.match(clientSource, /installDialogFocusTrap\(sourceDialogRef\.current/,
    '原文查看器必须启用统一 modal 焦点管理')
  assert.match(clientSource, /installDialogFocusTrap\(evidenceDrawerRef\.current/,
    '证据抽屉必须启用统一 modal 焦点管理')

  const modalListeners = new Map()
  const modalDocument = {
    activeElement: null,
    addEventListener: (type, listener) => { modalListeners.set(type, listener) },
    removeEventListener: (type, listener) => {
      if (modalListeners.get(type) === listener) modalListeners.delete(type)
    },
  }
  const focusTarget = (name) => ({ name, isConnected: true,
    getAttribute: () => null,
    focus() { modalDocument.activeElement = this } })
  const firstModalButton = focusTarget('first')
  const lastModalButton = focusTarget('last')
  const outsideModal = focusTarget('outside')
  const returnTarget = focusTarget('return')
  const modalDialog = focusTarget('dialog')
  modalDialog.ownerDocument = modalDocument
  modalDialog.querySelectorAll = () => [firstModalButton, lastModalButton]
  modalDialog.contains = (node) => node === modalDialog
    || node === firstModalButton || node === lastModalButton
  let escapeCount = 0
  const disposeModalTrap = plugin.__sceneStateForTest.installDialogFocusTrap(modalDialog, {
    onEscape: () => { escapeCount += 1 },
    returnFocus: () => returnTarget,
  })
  assert.equal(modalDocument.activeElement, firstModalButton, '打开 modal 后聚焦第一个控件')
  const dispatchModalKey = (key, shiftKey = false) => {
    let prevented = false
    modalListeners.get('keydown')({ key, shiftKey, preventDefault: () => { prevented = true } })
    return prevented
  }
  modalDocument.activeElement = lastModalButton
  assert.equal(dispatchModalKey('Tab'), true)
  assert.equal(modalDocument.activeElement, firstModalButton, 'Tab 在末项回到首项')
  modalDocument.activeElement = firstModalButton
  assert.equal(dispatchModalKey('Tab', true), true)
  assert.equal(modalDocument.activeElement, lastModalButton, 'Shift+Tab 在首项回到末项')
  modalDocument.activeElement = modalDialog
  assert.equal(dispatchModalKey('Tab', true), true)
  assert.equal(modalDocument.activeElement, lastModalButton, 'dialog 自身聚焦时 Shift+Tab 不能逃逸')
  modalDocument.activeElement = outsideModal
  assert.equal(dispatchModalKey('Tab'), true)
  assert.equal(modalDocument.activeElement, firstModalButton, '焦点跑出 modal 后恢复到首项')
  modalDocument.activeElement = outsideModal
  assert.equal(dispatchModalKey('Tab', true), true)
  assert.equal(modalDocument.activeElement, lastModalButton, '焦点跑出 modal 后 Shift+Tab 恢复到末项')
  assert.equal(dispatchModalKey('Escape'), true)
  assert.equal(escapeCount, 1)
  disposeModalTrap()
  assert.equal(modalListeners.has('keydown'), false)
  assert.equal(modalDocument.activeElement, returnTarget, '关闭或卸载 modal 后恢复触发点')
  disposeModalTrap()
  const sceneNodes = new Map([
    ['cloud', { kind: 'tool-call', data: { root: {
      kind: 'tool-result', call: { name: 'cloud_search',
        argsRaw: JSON.stringify({ query: '普瑞赛斯的目的', depth: 'standard' }) },
      content: [], isError: false, time: 2,
    } } }],
    ['search', { kind: 'tool-call', data: { root: {
      kind: 'tool-result', call: { name: 'corpus_search',
        argsRaw: JSON.stringify({ query: { text: '普瑞赛斯' }, resource_types: ['story'] }) },
      content: [], isError: false, time: 3,
    } } }],
    ['read', { kind: 'tool-call', data: { root: {
      name: 'corpus_read', argsRaw: JSON.stringify({ title: '孤星 · CW-ST-3 · 行动后',
        selection: { mode: 'range', start_line: 120, end_line: 146 } }), time: 4,
    } } }],
  ])
  const runningScene = plugin.__sceneStateForTest.buildSceneSnapshotModel(
    ['cloud', 'search', 'read'], { get: (key) => sceneNodes.get(key) })
  assert.equal(runningScene.plan.state, 'complete')
  assert.equal(runningScene.recall.state, 'complete')
  assert.equal(runningScene.read.state, 'active')
  assert.equal(runningScene.verify.state, 'active')
  assert.equal(runningScene.query.text, '普瑞赛斯')
  assert.equal(runningScene.query.scope, 'story')
  assert.equal(runningScene.source.title, '孤星 · CW-ST-3 · 行动后')
  assert.equal(runningScene.source.range, 'L120—L146')
  assert.equal(Array.from(runningScene.stack).join('\n'), [
    '01  cloud.search  ×1', '02  corpus.search ×1', '03  source.read   ×1',
  ].join('\n'))

  sceneNodes.set('read', { kind: 'tool-call', data: { root: {
    kind: 'tool-result', call: { name: 'corpus_read',
      argsRaw: JSON.stringify({ title: '孤星 · CW-ST-3 · 行动后',
        selection: { mode: 'range', start_line: 120, end_line: 146 } }) },
    content: [], isError: false, time: 5,
  } } })
  sceneNodes.set('answer', { kind: 'assistant-step', data: {
    status: 'settled', blocks: [{ kind: 'text', text: '根据原文……' }],
  } })
  const completeScene = plugin.__sceneStateForTest.buildSceneSnapshotModel(
    ['cloud', 'search', 'read', 'answer'], { get: (key) => sceneNodes.get(key) })
  assert.equal(completeScene.read.state, 'complete')
  assert.equal(completeScene.verify.state, 'complete')
  assert.equal(completeScene.tickerState, 'DONE')

  const evidenceVersion = 'a'.repeat(64)
  const evidenceNodes = new Map([['read', { kind: 'tool-call', data: { root: {
    kind: 'tool-result', call: { name: 'corpus_read', argsRaw: '{}' }, isError: false, time: 6,
    content: [{ type: 'text', text: '# 测试篇章\n范围：第 12-13 行\n引用：《测试篇章》第 12-13 行' }],
    meta: { kind: 'prts-corpus-read-v1', locator: { document_id: 'story:test' },
      data_version: evidenceVersion, title: '测试篇章', line_start: 12, line_end: 13 },
  } } }]])
  const evidenceModel = plugin.__sceneStateForTest.collectSnapshotEvidence(
    ['read'], { get: (key) => evidenceNodes.get(key) })
  const evidence = plugin.__sceneStateForTest.buildEvidence(evidenceModel)
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].documentId, 'story:test')
  assert.equal(evidence[0].sourceRef, '')
  assert.equal(evidence[0].dataVersion, evidenceVersion)

  // 证据只投影最后一轮，且同名文档的后一次读取覆盖旧版。
  const oldVersion = 'b'.repeat(64)
  const latestVersion = 'c'.repeat(64)
  const readNode = (title, version, documentId, lineStart) => ({ kind: 'tool-call', data: { root: {
    kind: 'tool-result', call: { name: 'corpus_read', argsRaw: '{}' }, isError: false,
    content: [{ type: 'text', text: `# ${title}\n范围：第 ${lineStart} 行\n引用：《${title}》第 ${lineStart} 行` }],
    meta: { kind: 'prts-corpus-read-v1', locator: { document_id: documentId },
      data_version: version, title, line_start: lineStart, line_end: lineStart },
  } } })
  const scopedNodes = new Map([
    ['old-user', { kind: 'user', data: {} }],
    ['old-read', readNode('旧轮资料', oldVersion, 'story:old', 1)],
    ['old-answer', { kind: 'assistant-step', data: { blocks: [{ kind: 'text', text: '旧答案《旧轮资料》' }] } }],
    ['new-user', { kind: 'user', data: {} }],
    ['new-read-a', readNode('当前资料', oldVersion, 'story:current-old', 2)],
    ['new-read-b', readNode('当前资料', latestVersion, 'story:current', 7)],
    ['new-answer', { kind: 'assistant-step', data: { blocks: [{ kind: 'text', text: '当前答案《当前资料》第 7 行' }] } }],
  ])
  const scopedModel = plugin.__sceneStateForTest.collectSnapshotEvidence(
    [...scopedNodes.keys()], { get: (key) => scopedNodes.get(key) })
  assert.deepEqual([...scopedModel.byTitle.keys()], ['当前资料'])
  assert.equal(scopedModel.byTitle.get('当前资料').dataVersion, latestVersion)
  assert.equal(scopedModel.byTitle.get('当前资料').documentId, 'story:current')
  const scopedEvidence = plugin.__sceneStateForTest.buildEvidence(scopedModel)
  assert.equal(scopedEvidence.length, 1)
  assert.equal(scopedEvidence[0].lineStart, 7)

  // 旧会话中的版本名/截断 hash 不是可校验的资料版本。
  const legacyNodes = new Map([['legacy-read', readNode('旧资料', 'v1', 'story:legacy', 3)]])
  const legacyEvidence = plugin.__sceneStateForTest.buildEvidence(
    plugin.__sceneStateForTest.collectSnapshotEvidence(
      ['legacy-read'], { get: (key) => legacyNodes.get(key) }))
  assert.equal(legacyEvidence[0].dataVersion, '')

  const registrations = []
  const themeLayers = []
  const rpcCalls = []
  const ctx = {
    effect: (fn) => { const dispose = fn(); return dispose ?? (() => {}) },
    slots: {
      inject: (key, callback) => { registrations.push({ key, value: callback() }); return () => {} },
      register: (options, component) => ({ options, component }),
    },
    connection: { rpc: { call: async (path, endpoint, payload) => {
      rpcCalls.push({ path, endpoint, payload })
      return { ok: true, value: endpoint === 'status' ? { config: { uiSkin: 'prts-agent' } }
        : endpoint === 'read' ? { ok: true, response: { status: 'ok',
            data_version: payload.selection?.cursor === 'wrong-version'
              ? 'd'.repeat(64) : payload.data_version } } : {} }
    } } },
    theme: { overrideTokens: (source, tokens) => {
      themeLayers.push({ source, tokens })
      return () => {}
    } },
    sessions: { open: () => {}, create: async () => 'session' },
  }
  plugin.apply(ctx)
  await new Promise((resolve) => { setImmediate(resolve) })
  assert.equal(registrations.length, 2)
  const byKey = Object.fromEntries(registrations.map((item) => [item.key, item.value]))
  assert.equal(byKey['settings.plugins.tab'].options.id, 'prts-corpus')
  assert.equal(byKey['conversation.session.header.utilities'].options.id, 'prts-evidence')
  assert.equal(typeof byKey['settings.plugins.tab'].component, 'function')
  assert.equal(typeof byKey['conversation.session.header.utilities'].component, 'function')
  assert.equal(themeLayers.length, 1)
  assert.equal(themeLayers[0].source, 'prts-terrarchive:prts-agent-skin')
  assert.deepEqual(Object.keys(themeLayers[0].tokens['--dsw-alias-bg-base']).sort(), ['dark', 'light'])
  await plugin.__sceneStateForTest.readEvidenceSource(evidence[0])
  const readCall = rpcCalls.find((call) => call.endpoint === 'read')
  assert.equal(readCall.payload.locator.document_id, 'story:test')
  assert.equal(Object.hasOwn(readCall.payload.locator, 'display_title'), false)
  assert.equal(readCall.payload.data_version, evidenceVersion)
  await plugin.__sceneStateForTest.readEvidenceSource(evidence[0], 'next-page.cursor')
  const continuationCall = rpcCalls.filter((call) => call.endpoint === 'read').at(-1)
  assert.equal(continuationCall.payload.selection.mode, 'document')
  assert.equal(continuationCall.payload.selection.cursor, 'next-page.cursor')
  await assert.rejects(() => plugin.__sceneStateForTest.readEvidenceSource(evidence[0], 'wrong-version'),
    /原文版本与证据不匹配/)
  const readCount = rpcCalls.filter((call) => call.endpoint === 'read').length
  await assert.rejects(() => plugin.__sceneStateForTest.readEvidenceSource(legacyEvidence[0]),
    /64 位资料版本/)
  assert.equal(rpcCalls.filter((call) => call.endpoint === 'read').length, readCount,
    '无完整版本时必须在 RPC 前拒绝')
  assert.match(clientSource, /response\?\.page\?\.has_more === true/)
  assert.match(clientSource, /response\?\.page\?\.next_cursor/)
  assert.match(clientSource, /继续加载原文/)
})

test('AIC shell：使用 declaration-aware inject，owner 重挂后能够重新注册', async () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let entry = null
  const window = { __ModuleLoader__: { load: (value) => { entry = value } } }
  vm.runInNewContext(source, { window, console, AbortController, setTimeout, clearTimeout })
  const reactStub = {
    createElement: (...args) => ({ args }), useState: (initial) => [initial, () => {}],
    useEffect: () => {}, useCallback: (fn) => fn, useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }), Fragment: 'Fragment',
  }
  const plugin = entry.factory((id) => {
    if (id === 'react') return reactStub
    throw new Error(`意外依赖 ${id}`)
  })
  const effects = []
  const shellEntries = []
  let shellCallback = null
  let shellControllerDisposed = 0
  const ctx = {
    effect: (fn, label) => {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push({ dispose, label })
      return dispose ?? (() => {})
    },
    slots: {
      inject: (key, callback) => {
        if (key === 'shell.overlay') {
          shellCallback = callback
          return () => { shellControllerDisposed += 1 }
        }
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register: (options) => {
        if (options.name === 'shell.overlay') shellEntries.push(options)
        return () => {}
      },
    },
    connection: { rpc: { call: async () => ({ ok: true,
      value: { config: { uiSkin: 'endfield-aic' } } }) } },
    theme: { overrideTokens: () => () => {} },
    sessions: { open: () => {}, create: async () => 'session' },
  }
  plugin.apply(ctx)
  await new Promise((resolve) => { setImmediate(resolve) })
  assert.equal(typeof shellCallback, 'function')
  const first = shellCallback()
  assert.equal(shellEntries.length, 1)
  first()
  const second = shellCallback()
  assert.equal(shellEntries.length, 2, 'ui-layout owner 重挂后必须重新贡献 AIC shell')
  second()
  for (const { dispose } of effects.reverse()) dispose()
  assert.equal(shellControllerDisposed, 1)
})

test('client lifecycle：卸载会取消迟到的配置响应，不能重新激活皮肤', async () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let entry = null
  const window = { __ModuleLoader__: { load: (value) => { entry = value } } }
  vm.runInNewContext(source, { window, console, AbortController, setTimeout, clearTimeout })
  const reactStub = {
    createElement: (...args) => ({ args }), useState: (initial) => [initial, () => {}],
    useEffect: () => {}, useCallback: (fn) => fn, useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }), Fragment: 'Fragment',
  }
  const plugin = entry.factory((id) => {
    if (id === 'react') return reactStub
    throw new Error(`意外依赖 ${id}`)
  })
  let resolveStatus
  const status = new Promise((resolve) => { resolveStatus = resolve })
  const effects = []
  let shellInjected = 0
  let tokenOverrides = 0
  const ctx = {
    effect: (fn, label) => {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push({ dispose, label })
      return dispose ?? (() => {})
    },
    slots: {
      inject: (key, callback) => {
        if (key === 'shell.overlay') shellInjected += 1
        else callback()
        return () => {}
      },
      register: () => () => {},
    },
    connection: { rpc: { call: () => status } },
    theme: { overrideTokens: () => { tokenOverrides += 1; return () => {} } },
    sessions: { open: () => {}, create: async () => 'session' },
  }
  plugin.apply(ctx)
  const lifecycle = effects.find((effect) => effect.label === 'prts-corpus: skin cleanup')
  assert.ok(lifecycle, '总清理器必须有稳定的 effect label，不能依赖注册顺序')
  lifecycle.dispose()
  resolveStatus({ ok: true, value: { config: { uiSkin: 'endfield-aic' } } })
  await new Promise((resolve) => { setImmediate(resolve) })
  assert.equal(shellInjected, 0)
  assert.equal(tokenOverrides, 0)
})

test('client lifecycle：初始配置迟到时不能覆盖用户刚选择的皮肤', async () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let entry = null
  const window = { __ModuleLoader__: { load: (value) => { entry = value } } }
  vm.runInNewContext(source, { window, console, AbortController, setTimeout, clearTimeout })
  const reactStub = {
    createElement: (...args) => ({ args }), useState: (initial) => [initial, () => {}],
    useEffect: () => {}, useCallback: (fn) => fn, useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }), Fragment: 'Fragment',
  }
  const plugin = entry.factory((id) => {
    if (id === 'react') return reactStub
    throw new Error(`意外依赖 ${id}`)
  })
  let resolveInitialStatus
  const initialStatus = new Promise((resolve) => { resolveInitialStatus = resolve })
  const effects = []
  const tokenOverrides = []
  let settingsComponent = null
  const ctx = {
    effect: (fn, label) => {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push({ dispose, label })
      return dispose ?? (() => {})
    },
    slots: {
      inject: (key, callback) => {
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register: (options, component) => {
        if (options.id === 'prts-corpus') settingsComponent = component
        return () => {}
      },
    },
    connection: { rpc: { call: (_path, endpoint) => endpoint === 'status'
      ? initialStatus : Promise.resolve({ ok: true, value: {} }) } },
    theme: { overrideTokens: (_source, tokens) => {
      tokenOverrides.push(tokens)
      return () => {}
    } },
    sessions: { open: () => {}, create: async () => 'session' },
  }
  plugin.apply(ctx)
  assert.equal(typeof settingsComponent, 'function')

  const findNode = (node, predicate) => {
    if (!node || typeof node !== 'object') return null
    if (predicate(node)) return node
    for (const child of node.args?.slice(2) ?? []) {
      const found = findNode(child, predicate)
      if (found) return found
    }
    return null
  }
  const settingsTree = settingsComponent()
  const skinCardNode = findNode(settingsTree,
    (node) => typeof node.args?.[0] === 'function' && node.args[0].name === 'SkinCard')
  assert.ok(skinCardNode)
  const skinTree = skinCardNode.args[0](skinCardNode.args[1])
  const endfieldButton = findNode(skinTree, (node) => node.args?.[0] === 'button'
    && node.args?.slice(2).some((child) => child?.args?.[0] === 'strong'
      && child.args[2] === 'AIC 终末地'))
  assert.ok(endfieldButton)
  endfieldButton.args[1].onClick()
  await new Promise((resolve) => { setImmediate(resolve) })
  assert.equal(tokenOverrides.length, 1)
  assert.equal(tokenOverrides[0]['--dsw-alias-bg-base'].light, '#0b0d10')

  resolveInitialStatus({ ok: true, value: { config: { uiSkin: 'prts-agent' } } })
  await new Promise((resolve) => { setImmediate(resolve) })
  assert.equal(tokenOverrides.length, 1,
    '迟到的初始 prts-agent 配置不得覆盖用户已选择的 endfield-aic')

  const lifecycle = effects.find((effect) => effect.label === 'prts-corpus: skin cleanup')
  lifecycle?.dispose()
})

test('AIC skin：同步雪松林地图并规避 macOS 设置弹窗的 WebGL 合成卡顿', async () => {
  const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const aicCss = await readFile(new URL('../lib/skins/endfield-aic.css', import.meta.url), 'utf8')
  const client = `${clientSource}\n${aicCss}`
  assert.match(client, /new MutationObserver\(syncModalState\)/)
  assert.match(client, /!document\.querySelector\('\[aria-modal="true"\]\[role="dialog"\]'\)/)
  assert.match(client, /aic-modal-open.*z-index:100!important/)
  assert.match(client, /sidebar\.settings.*aria-modal="true"/s)
  assert.match(client, /sidebar\.settings.*button\[aria-haspopup=\\?"dialog\\?"\]/s)
  assert.match(client, /\[role="presentation"\]>\[aria-hidden="true"\].*backdrop-filter:none!important/s)
  assert.match(client, /overflow:visible!important;pointer-events:none/)
  assert.match(client, /aic-chat-resize/)
  assert.match(clientSource, /if \(percent < 0\) \{[^]*aicBootPaint\(-1, message, token\)/,
    'negative map progress must paint a visible LOAD FAILED state')
  assert.match(clientSource, /className: 'aic-drawer-scrim'/,
    'aria-modal history drawer must block pointer interaction with the background')
  assert.match(clientSource, /!drawer\?\.contains\(document\.activeElement\)/,
    'history focus trap must recover focus that starts outside the drawer')
  assert.match(clientSource, /type: 'button',[^]*className: `aic-region-label/,
    'map region labels must be keyboard-operable controls')
  assert.match(clientSource, /map\.setFocusPoint\?\.\(focusPointRef\.current\)/,
    'map must apply a focus point that changed while its bundle was loading')
  const sharedLoader = clientSource.slice(clientSource.indexOf('const ensureMapBundle'),
    clientSource.indexOf('function AicMap'))
  assert.match(sharedLoader, /loadTimer = setTimeout/,
    'the shared script task needs its own watchdog')
  assert.doesNotMatch(sharedLoader, /signal\?\.addEventListener\('abort'/,
    'one AicMap abort signal must not cancel the shared script task')
  assert.match(clientSource, /waitWithDeadline\(ensureMapBundle\(\),/,
    'each AicMap must cancel only its own wait on the shared script task')

  const mapBundle = brotliDecompressSync(await readFile(
    new URL('../lib/endfield-map/map.js.br', import.meta.url),
  )).toString('utf8')
  assert.match(mapBundle, /Snowy Forest/)
  assert.match(mapBundle, /lv009/)
  assert.match(mapBundle, /map-00b0d0744a1b4404/)
  assert.match(mapBundle, /\/prts-corpus\/endfield-map\/resources\//)
  assert.match(mapBundle, /aria-label/)
  assert.match(mapBundle, /application/)
})
