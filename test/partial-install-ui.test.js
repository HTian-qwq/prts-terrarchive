import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApi } from '../src/ui.js'
import { createSharedState } from '../src/state.js'
import { CorpusStore } from '../src/store.js'
import { ensureCorpusRelease } from '../src/installer.js'
import { dualGameRelease, GAME_PACKS } from './fixtures/dual-game-release.js'

async function setup(t, games = ['endfield']) {
  const dir = await mkdtemp(join(tmpdir(), 'prts-partial-ui-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const releasesDir = join(dir, 'releases')
  await mkdir(releasesDir)
  const shared = createSharedState({ configPath: join(dir, 'config.json'), releasesDir,
    patchConfig: { enabledGames: games, download: { order: ['site'] } } })
  await shared.loadConfig()
  shared.store = new CorpusStore({ releasesDir })
  return { shared, releasesDir }
}

function downloadFinished(shared) {
  let stop
  let timer
  const result = new Promise((resolve, reject) => {
    stop = shared.subscribeRuntime(() => {
      if (shared.download.active || !shared.download.finishedAt) return
      clearTimeout(timer)
      stop()
      resolve()
    })
    timer = setTimeout(() => { stop(); reject(new Error('download did not finish')) }, 10_000)
  })
  return result
}

async function download(api, shared) {
  const done = downloadFinished(shared)
  const response = await api.call('POST', '/api/prts-corpus/download', {})
  assert.equal(response.status, 202, JSON.stringify(response.json))
  await done
  assert.equal(shared.download.error, null)
}

test('partial UI: reports installed assets, detects newly enabled game and augments same release', async (t) => {
  const { shared, releasesDir } = await setup(t)
  const fixture = dualGameRelease()
  const api = buildApi(shared, { fetchImpl: fixture.fetchImpl })
  await download(api, shared)
  await shared.store.ready()
  assert.equal(shared.store.documents.size, 2)
  assert.equal(shared.store.dataVersion, fixture.dataVersion)
  const oldScope = shared.store.scopeFingerprint
  const oldInstallation = shared.store.installationId
  const oldGeneration = shared.store._generation
  shared.store.looseTitleIndex()
  const status = await api.call('GET', '/api/prts-corpus/status')
  assert.equal(status.json.store.installed, true)
  assert.deepEqual(status.json.store.installedGames, ['endfield'])
  const releases = await api.call('GET', '/api/prts-corpus/releases')
  const release = releases.json.releases[0]
  assert.equal(release.complete, true)
  assert.equal(release.documentCount, 2)
  assert.equal(release.releaseDocumentCount, 7)
  assert.equal(release.datasets.endfield.documentCount, 2)
  assert.equal(release.datasets.arknights.present, false)
  assert.equal(release.compressedSize, GAME_PACKS.endfield.reduce((sum, id) =>
    sum + fixture.manifests.get(id).compressed_size, 0))
  const currentUpdate = await api.call('GET', '/api/prts-corpus/check-update')
  assert.equal(currentUpdate.json.updateAvailable, false)
  await shared.saveConfig({ enabledGames: ['arknights', 'endfield'] })
  const missing = await api.call('GET', '/api/prts-corpus/status')
  assert.equal(missing.json.store.installed, false)
  assert.deepEqual(missing.json.store.missingGames, ['arknights'])
  const update = await api.call('GET', '/api/prts-corpus/check-update')
  assert.equal(update.json.updateAvailable, true)
  const rejected = await api.call('POST', '/api/prts-corpus/activate', { releaseId: fixture.releaseId })
  assert.equal(rejected.status, 400)
  const before = fixture.assetRequests().length
  await download(api, shared)
  assert.equal(fixture.assetRequests().length - before, 5)
  assert.ok(shared.store._generation > oldGeneration)
  assert.equal(shared.store._looseTitleIndex, null)
  await shared.store.ready()
  assert.equal(shared.store.documents.size, 7)
  assert.equal(shared.store.dataVersion, fixture.dataVersion)
  assert.notEqual(shared.store.scopeFingerprint, oldScope)
  assert.notEqual(shared.store.installationId, oldInstallation)
  assert.equal(shared.store.looseTitleMatches('official_game共同测试').length, 1)
  const complete = await api.call('GET', '/api/prts-corpus/releases')
  assert.equal(complete.json.releases[0].documentCount, 7)
  const pointer = JSON.parse(await readFile(join(releasesDir, 'current.json'), 'utf8'))
  assert.equal(pointer.data_version, fixture.dataVersion)
})

test('partial UI: activation and deletion accept managed partial releases', async (t) => {
  const { shared, releasesDir } = await setup(t)
  const first = dualGameRelease({ releaseId: 'partial-ui-first' })
  const second = dualGameRelease({ releaseId: 'partial-ui-second' })
  for (const fixture of [first, second]) {
    await ensureCorpusRelease({ releasesDir, enabledGames: ['endfield'], order: ['site'],
      fetchImpl: fixture.fetchImpl })
  }
  const api = buildApi(shared)
  const activated = await api.call('POST', '/api/prts-corpus/activate', { releaseId: first.releaseId })
  assert.equal(activated.status, 200, JSON.stringify(activated.json))
  const pointer = JSON.parse(await readFile(join(releasesDir, 'current.json'), 'utf8'))
  assert.equal(pointer.data_version, first.dataVersion)
  assert.ok(pointer.installation_id)
  const deleted = await api.call('POST', '/api/prts-corpus/delete', { releaseId: second.releaseId })
  assert.equal(deleted.status, 200, JSON.stringify(deleted.json))
  const forbidden = await api.call('POST', '/api/prts-corpus/delete', { releaseId: first.releaseId })
  assert.equal(forbidden.status, 409)
})

test('partial UI: download uses games selected before trusted-current network wait', async (t) => {
  const { shared } = await setup(t)
  const fixture = dualGameRelease()
  let releaseCurrent
  let currentRequested
  const requested = new Promise((resolve) => { currentRequested = resolve })
  const gate = new Promise((resolve) => { releaseCurrent = resolve })
  const api = buildApi(shared, { fetchImpl: async (url, init) => {
    if (String(url).endsWith('/releases/current')) { currentRequested(); await gate }
    return fixture.fetchImpl(url, init)
  } })
  const done = downloadFinished(shared)
  const downloading = api.call('POST', '/api/prts-corpus/download', {})
  await requested
  await shared.saveConfig({ enabledGames: ['arknights'] })
  releaseCurrent()
  assert.equal((await downloading).status, 202)
  await done
  assert.equal(shared.download.error, null)
  await shared.store.ready()
  assert.deepEqual([...shared.store.packs.keys()].sort(), [...GAME_PACKS.endfield].sort())
  const status = await api.call('GET', '/api/prts-corpus/status')
  assert.equal(status.json.store.installed, false)
  assert.deepEqual(status.json.store.missingGames, ['arknights'])
})
