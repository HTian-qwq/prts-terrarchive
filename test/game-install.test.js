import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureCorpusRelease, validateLocalRelease, missingEnabledGamePacks } from '../src/installer.js'
import { CorpusStore } from '../src/store.js'
import { dualGameRelease, GAME_PACKS } from './fixtures/dual-game-release.js'

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'prts-game-install-'))
  try { await run(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}
const installed = (dir, releaseId) => validateLocalRelease(dir, releaseId,
  { details: true, allowPartial: true, verifyHashes: true })
const pointer = async (dir) => JSON.parse(await readFile(join(dir, 'current.json'), 'utf8'))

for (const game of Object.keys(GAME_PACKS)) {
  for (const source of ['site', 'modelscope']) {
    test(`${source}: selecting ${game} downloads only that game's assets, retaining full trust metadata`, async () => fixture(async (dir) => {
      const data = dualGameRelease()
      const result = await ensureCorpusRelease({ releasesDir: dir, enabledGames: [game],
        fetchImpl: data.fetchImpl, order: [source] })
      assert.equal(result.files, GAME_PACKS[game].length)
      assert.equal(result.bytes, GAME_PACKS[game].reduce((sum, id) => sum + data.assets.get(`${id}/shards/00000.jsonl.gz`).length, 0))
      assert.equal(data.assetRequests().length, GAME_PACKS[game].length)
      for (const url of data.assetRequests()) assert.ok(GAME_PACKS[game].some((id) => url.includes(`/${id}/`)), url)
      const local = await installed(dir, data.releaseId)
      assert.deepEqual(local.manifest, data.manifest)
      assert.equal(local.packManifests.size, 7)
      assert.deepEqual(local.installedPackIds.sort(), [...GAME_PACKS[game]].sort())
      assert.deepEqual(missingEnabledGamePacks(local.manifest, [game], local.installedPackIds), [])
      assert.deepEqual(missingEnabledGamePacks(local.manifest, ['arknights', 'endfield'], local.installedPackIds),
        [game === 'endfield' ? 'arknights' : 'endfield'])
      await assert.rejects(() => validateLocalRelease(dir, data.releaseId, { verifyHashes: true }))
      const store = new CorpusStore({ releasesDir: dir })
      await store.ready()
      assert.equal(store.documents.size, GAME_PACKS[game].length)
      assert.equal(store.dataVersion, data.dataVersion)
      for (const packId of GAME_PACKS[game]) {
        const body = await store.getDocument(`${packId}:fixture`)
        assert.ok(body?.record.lines[0].text.includes(packId))
      }
    }))
  }
}

test('same-release augmentation downloads only missing game, preserves old assets and zero-network readiness', async () => fixture(async (dir) => {
  const data = dualGameRelease()
  const opts = { releasesDir: dir, fetchImpl: data.fetchImpl, order: ['site'], releaseId: data.releaseId }
  await ensureCorpusRelease({ ...opts, enabledGames: ['endfield'] })
  const before = await pointer(dir)
  const saved = await readFile(join(dir, data.releaseId, 'endfield_official_game/shards/00000.jsonl.gz'))
  const count = data.requests.length
  assert.equal((await ensureCorpusRelease({ ...opts, enabledGames: ['endfield'] })).status, 'present')
  assert.equal(data.requests.length, count)
  const assets = data.assetRequests().length
  const result = await ensureCorpusRelease({ ...opts, enabledGames: ['arknights', 'endfield'] })
  assert.equal(result.files, 5)
  const added = data.assetRequests().slice(assets)
  assert.equal(added.length, 5)
  assert.ok(added.every((url) => !url.includes('/endfield_')))
  assert.deepEqual(await readFile(join(dir, data.releaseId, 'endfield_official_game/shards/00000.jsonl.gz')), saved)
  const after = await pointer(dir)
  assert.equal(after.data_version, before.data_version)
  assert.notEqual(after.installation_id, before.installation_id)
  assert.equal((await installed(dir, data.releaseId)).installedPackIds.length, 7)
  await validateLocalRelease(dir, data.releaseId, { verifyHashes: true })
  const now = data.requests.length
  assert.equal((await ensureCorpusRelease({ ...opts, enabledGames: ['arknights'] })).status, 'present')
  assert.equal(data.requests.length, now)
}))

test('failed augmentation preserves active pointer, receipt and existing readable game', async () => fixture(async (dir) => {
  const good = dualGameRelease()
  await ensureCorpusRelease({ releasesDir: dir, enabledGames: ['endfield'], fetchImpl: good.fetchImpl, order: ['site'] })
  const before = await readFile(join(dir, 'current.json'))
  const receipt = await readFile(join(dir, good.releaseId, 'installation.json'))
  const bad = dualGameRelease({ failPack: 'official_game' })
  await assert.rejects(() => ensureCorpusRelease({ releasesDir: dir,
    enabledGames: ['arknights'], fetchImpl: bad.fetchImpl, order: ['site'] }))
  assert.deepEqual(await readFile(join(dir, 'current.json')), before)
  assert.deepEqual(await readFile(join(dir, good.releaseId, 'installation.json')), receipt)
  assert.equal((await installed(dir, good.releaseId)).installedPackIds.length, 2)
  const store = new CorpusStore({ releasesDir: dir })
  await store.ready()
  assert.equal(store.documents.size, 2)
}))

test('partial receipt cannot bypass full metadata trust or installed asset integrity', async () => fixture(async (dir) => {
  const data = dualGameRelease()
  await ensureCorpusRelease({ releasesDir: dir, enabledGames: ['endfield'], fetchImpl: data.fetchImpl, order: ['site'] })
  const asset = join(dir, data.releaseId, 'endfield_official_game/shards/00000.jsonl.gz')
  const bytes = await readFile(asset)
  await writeFile(asset, Buffer.alloc(bytes.length))
  await assert.rejects(() => installed(dir, data.releaseId), /SHA-256/)
  await writeFile(asset, bytes)
  const receipt = join(dir, data.releaseId, 'installation.json')
  const original = await readFile(receipt)
  for (const patch of [{ installed_games: [] }, { installed_games: ['unknown'] }, { data_version: '0'.repeat(64) }]) {
    await writeFile(receipt, JSON.stringify({ ...JSON.parse(original), ...patch }))
    await assert.rejects(() => installed(dir, data.releaseId), (error) => error.code === 'INVALID_RELEASE')
  }
  await writeFile(receipt, original)
  const path = join(dir, data.releaseId, 'official_game/pack-manifest.json')
  const metadata = JSON.parse(await readFile(path))
  metadata.shards[0].sha256 = '0'.repeat(64)
  await writeFile(path, JSON.stringify(metadata))
  await assert.rejects(() => installed(dir, data.releaseId), /data_version/)
}))

test('legacy full install without receipt remains readable and satisfies either selection offline', async () => fixture(async (dir) => {
  const data = dualGameRelease()
  await ensureCorpusRelease({ releasesDir: dir, fetchImpl: data.fetchImpl, order: ['site'] })
  await rm(join(dir, data.releaseId, 'installation.json'))
  const count = data.requests.length
  for (const game of ['arknights', 'endfield']) {
    assert.equal((await ensureCorpusRelease({ releasesDir: dir, releaseId: data.releaseId,
      enabledGames: [game], fetchImpl: data.fetchImpl })).status, 'present')
  }
  assert.equal(data.requests.length, count)
  const store = new CorpusStore({ releasesDir: dir })
  await store.ready()
  assert.equal(store.documents.size, 7)
}))

test('invalid game selection fails before any network request', async () => fixture(async (dir) => {
  for (const enabledGames of [[], ['unknown'], ['toString'], [null], ['arknights', 'arknights'], 'endfield']) {
    const data = dualGameRelease()
    await assert.rejects(() => ensureCorpusRelease({ releasesDir: dir, enabledGames,
      fetchImpl: data.fetchImpl }), (error) => error.code === 'INVALID_REQUEST')
    assert.equal(data.requests.length, 0)
  }
}))
