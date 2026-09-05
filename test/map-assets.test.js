import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import vm from 'node:vm'

test('pack-map-assets：压缩与还原均可重复执行且内容无损', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'prts-map-pack-'))
  const binDir = join(fixture, 'bin')
  const mapDir = join(fixture, 'lib', 'endfield-map')
  const resourcesDir = join(mapDir, 'resources')
  await mkdir(binDir, { recursive: true })
  await mkdir(resourcesDir, { recursive: true })
  await copyFile(new URL('../bin/pack-map-assets.mjs', import.meta.url), join(binDir, 'pack-map-assets.mjs'))
  const fixtures = new Map([
    [join(mapDir, 'map.js'), Buffer.from('export const map = "塔卫二"\n')],
    [join(resourcesDir, 'a.json'), Buffer.from('{"name":"源石"}\n')],
    [join(resourcesDir, 'b.json'), Buffer.from('{"name":"侵蚀"}\n')],
  ])
  try {
    for (const [path, bytes] of fixtures) await writeFile(path, bytes)

    const pack = spawnSync(process.execPath, [join(binDir, 'pack-map-assets.mjs')], { encoding: 'utf8' })
    assert.equal(pack.status, 0, pack.stderr)
    for (const [path, expected] of fixtures) {
      assert.equal(existsSync(path), false)
      assert.deepEqual(brotliDecompressSync(await readFile(`${path}.br`)), expected)
      assert.deepEqual(gunzipSync(await readFile(`${path}.gz`)), expected)
    }

    const packAgain = spawnSync(process.execPath, [join(binDir, 'pack-map-assets.mjs')], { encoding: 'utf8' })
    assert.equal(packAgain.status, 0, packAgain.stderr)
    for (const [path, expected] of fixtures) {
      assert.deepEqual(brotliDecompressSync(await readFile(`${path}.br`)), expected)
      assert.deepEqual(gunzipSync(await readFile(`${path}.gz`)), expected)
    }

    const restore = spawnSync(process.execPath,
      [join(binDir, 'pack-map-assets.mjs'), '--restore'], { encoding: 'utf8' })
    assert.equal(restore.status, 0, restore.stderr)
    for (const [path, expected] of fixtures) {
      assert.deepEqual(await readFile(path), expected)
      assert.equal(existsSync(`${path}.br`), false)
      assert.equal(existsSync(`${path}.gz`), false)
    }

    const restoreAgain = spawnSync(process.execPath,
      [join(binDir, 'pack-map-assets.mjs'), '--restore'], { encoding: 'utf8' })
    assert.equal(restoreAgain.status, 0, restoreAgain.stderr)
    for (const [path, expected] of fixtures) assert.deepEqual(await readFile(path), expected)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('实际发布地图资源：没有明文 JSON，br/gzip 成对且解压内容一致', async () => {
  const mapRoot = fileURLToPath(new URL('../lib/endfield-map/', import.meta.url))
  const resourceRoot = join(mapRoot, 'resources')
  const names = await readdir(resourceRoot)
  assert.equal(names.some((name) => name.endsWith('.json')), false,
    '发布包不得误带 pack:map:restore 产生的明文 JSON')
  const brotliNames = names.filter((name) => name.endsWith('.json.br')).sort()
  const gzipNames = names.filter((name) => name.endsWith('.json.gz')).sort()
  assert.ok(brotliNames.length > 0)
  assert.deepEqual(brotliNames.map((name) => name.slice(0, -3)),
    gzipNames.map((name) => name.slice(0, -3)))
  for (const name of brotliNames) {
    const base = join(resourceRoot, name.slice(0, -3))
    const brotli = brotliDecompressSync(await readFile(`${base}.br`))
    const gzip = gunzipSync(await readFile(`${base}.gz`))
    assert.deepEqual(brotli, gzip, name)
    assert.ok(brotli.length <= 16 * 1024 * 1024, `${name} 超过 Host identity 解压上限`)
    assert.doesNotThrow(() => JSON.parse(brotli.toString('utf8')), name)
  }
  const mapBrotli = brotliDecompressSync(await readFile(join(mapRoot, 'map.js.br')))
  const mapGzip = gunzipSync(await readFile(join(mapRoot, 'map.js.gz')))
  assert.deepEqual(mapBrotli, mapGzip)
  assert.ok(mapBrotli.length <= 16 * 1024 * 1024)
  const mapSource = mapBrotli.toString('utf8')
  assert.doesNotMatch(mapSource, /visibilitychange/,
    '地图运行时不能自行恢复渲染并覆盖外层 modal/皮肤的 pause 状态')
  const sandbox = { console, setTimeout, clearTimeout, performance, DOMException, AbortController }
  sandbox.globalThis = sandbox
  vm.runInNewContext(mapSource, sandbox)
  assert.equal(sandbox.__PRTS_ENDFIELD_MAP__.RUNTIME_ABI, 2)
  assert.match(sandbox.__PRTS_ENDFIELD_MAP__.RUNTIME_VERSION, /^[a-f0-9]{16}$/)
})
