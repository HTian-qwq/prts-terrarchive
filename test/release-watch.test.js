import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { watchCurrentRelease } from '../src/release-watch.js'
import { apply } from '../src/index.js'
import { CorpusStore } from '../src/store.js'
import { readCurrentReleasePointer } from '../src/installer.js'

async function waitFor(check, label) {
  const deadline = Date.now() + 5000
  while (!check()) {
    assert.ok(Date.now() < deadline, label)
    await delay(25)
  }
}

async function replacePointer(dir, releaseId, dataVersion) {
  const temporary = join(dir, 'current.next.json')
  await writeFile(temporary, JSON.stringify({ release_id: releaseId, data_version: dataVersion }))
  await rename(temporary, join(dir, 'current.json'))
}

test('版本监听优先使用原生目录 watch，只转发 current.json，关闭后不再通知', (t) => {
  let callback
  let closed = 0
  let calls = 0
  t.mock.method(fs, 'watch', (_path, options, listener) => {
    assert.equal(options.persistent, false)
    callback = listener
    return { close() { closed += 1 } }
  })
  const polling = t.mock.method(fs, 'watchFile', () => { throw new Error('不应轮询') })
  const watcher = watchCurrentRelease('/unused-release-watch', () => { calls += 1 })
  callback('change', 'other.json')
  callback('rename', Buffer.from('current.json'))
  assert.equal(calls, 1)
  assert.equal(polling.mock.callCount(), 0)
  watcher.close()
  watcher.close()
  callback('change', 'current.json')
  assert.equal(calls, 1)
  assert.equal(closed, 1)
})

for (const code of ['ENOSPC', 'EMFILE', 'ENFILE']) {
  test(`${code} 回退真实 watchFile，原子替换指针可被检测，close 解除轮询`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'prts-release-watch-'))
    const initial = 'a'.repeat(64)
    const next = 'b'.repeat(64)
    await replacePointer(dir, 'release-old', initial)
    t.mock.method(fs, 'watch', () => { throw Object.assign(new Error(code), { code }) })
    const originalWatchFile = fs.watchFile
    const originalUnwatchFile = fs.unwatchFile
    const polling = t.mock.method(fs, 'watchFile', (...args) => originalWatchFile(...args))
    const unpolling = t.mock.method(fs, 'unwatchFile', (...args) => originalUnwatchFile(...args))
    let changes = 0
    let version = initial
    const reads = []
    const watcher = watchCurrentRelease(dir, () => {
      changes += 1
      reads.push(readFile(join(dir, 'current.json'), 'utf8').then(raw => {
        version = JSON.parse(raw).data_version
      }))
    })
    t.after(async () => { watcher.close(); await Promise.all(reads); await rm(dir, { recursive: true, force: true }) })
    assert.equal(polling.mock.callCount(), 1)
    assert.equal(polling.mock.calls[0].arguments[1].persistent, false)
    await replacePointer(dir, 'release-new', next)
    await waitFor(() => version === next, '轮询必须观察真实指针替换')
    watcher.close()
    watcher.close()
    assert.equal(unpolling.mock.callCount(), 1)
    assert.equal(unpolling.mock.calls[0].arguments[0], join(dir, 'current.json'))
    assert.equal(unpolling.mock.calls[0].arguments[1], polling.mock.calls[0].arguments[2])
    const before = changes
    await replacePointer(dir, 'release-after-close', 'c'.repeat(64))
    await delay(1100)
    assert.equal(changes, before)
  })
}

test('与资源耗尽无关的 watch 错误仍原样抛出', (t) => {
  const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  t.mock.method(fs, 'watch', () => { throw failure })
  const polling = t.mock.method(fs, 'watchFile', () => { throw new Error('不应轮询') })
  assert.throws(() => watchCurrentRelease('/unused-release-watch', () => {}), error => error === failure)
  assert.equal(polling.mock.callCount(), 0)
})

test('插件在 ENOSPC 下仍可加载、共享轮询热切版，最后一个实例卸载后停止', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'prts-release-watch-plugin-'))
  const releasesDir = join(home, 'releases')
  await mkdir(releasesDir)
  await replacePointer(releasesDir, 'release-old', 'a'.repeat(64))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const instances = []
  const originalUnwatchFile = fs.unwatchFile
  const unpolling = t.mock.method(fs, 'unwatchFile', (...args) => originalUnwatchFile(...args))
  t.mock.method(fs, 'watch', () => { throw Object.assign(new Error('quota exhausted'), { code: 'ENOSPC' }) })
  let store
  // Keep the actual plugin reset/prewarm path; only replace the unrelated corpus loader with a tiny pointer-backed dataset.
  t.mock.method(CorpusStore.prototype, 'ready', async function () {
    const pointer = await readCurrentReleasePointer(this.releasesDir)
    this.releaseId = pointer.release_id
    this.dataVersion = pointer.data_version
    this._loaded = true
    this._aliasGroups = []
    store = this
  })
  const mount = async () => {
    const effects = []
    const tools = new Map()
    const warnings = []
    const ctx = {
      tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
      effect(operation) { const dispose = operation(); if (typeof dispose === 'function') effects.push(dispose); return dispose },
      inject(dependencies, callback) { if (dependencies.includes('tools')) return callback(ctx) },
      logger: { warn(message) { warnings.push(message) }, info() {} },
    }
    const instance = { tools, warnings, dispose() { for (const dispose of effects.splice(0).reverse()) dispose() } }
    instances.push(instance)
    await apply(ctx, { releasesDir, registerUi: false, enabledGames: ['arknights'] })
    return instance
  }
  t.after(async () => {
    for (const instance of instances) instance.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  })
  const first = await mount()
  const second = await mount()
  assert.equal(first.warnings.filter(message => message.includes('原生资料监听')).length, 1)
  assert.equal(second.warnings.filter(message => message.includes('原生资料监听')).length, 0)
  const releaseUnpollCount = () => unpolling.mock.calls
    .filter(call => call.arguments[0] === join(releasesDir, 'current.json')).length
  await first.tools.get('corpus_search').execute({ query: '不存在的条目' }, {})
  assert.equal(store.dataVersion, 'a'.repeat(64))
  await replacePointer(releasesDir, 'release-new', 'b'.repeat(64))
  await waitFor(() => store.dataVersion === 'b'.repeat(64), '现有热切换回调必须加载新指针')
  assert.equal(store._generation, 1)
  first.dispose()
  assert.equal(releaseUnpollCount(), 0, '仍有会话实例时必须继续监控')
  await replacePointer(releasesDir, 'release-third', 'c'.repeat(64))
  await waitFor(() => store.dataVersion === 'c'.repeat(64), '剩余实例必须继续接收版本切换')
  assert.equal(store._generation, 2)
  second.dispose()
  assert.equal(releaseUnpollCount(), 1)
  await replacePointer(releasesDir, 'release-after-dispose', 'd'.repeat(64))
  await delay(1200)
  assert.equal(store.dataVersion, 'c'.repeat(64))
  assert.equal(store._generation, 2)
})
