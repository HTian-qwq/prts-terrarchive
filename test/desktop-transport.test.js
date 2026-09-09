import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { setImmediate as tick } from 'node:timers/promises'
import { applyUi } from '../src/ui.js'
import { createSharedState } from '../src/state.js'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const dshSource = resolve(process.env.PRTS_DSH_SOURCE || join(packageDir, '../deepseek-harness'))
const connectionSource = join(dshSource, 'packages/client/connection/src/rpc-host.ts')
const hasDshSource = existsSync(connectionSource)
const nativeTest = (name, fn) => test(name, {
  skip: hasDshSource ? false : '设置 PRTS_DSH_SOURCE 指向 DSH 源码以运行真实 Host 集成测试',
}, fn)
let Context
let HostConnectionService
if (hasDshSource) {
  const requireDsh = createRequire(join(dshSource, 'package.json'))
  const { register } = await import(pathToFileURL(requireDsh.resolve('tsx/esm/api')).href)
  const unregister = register({ tsconfig: join(dshSource, 'tsconfig.base.json') })
  after(unregister)
  ;({ Context } = await import(pathToFileURL(join(dshSource, 'vendor/cordis/src/index.ts')).href))
  ;({ HostConnectionService } = await import(pathToFileURL(connectionSource).href))
}

async function fixture(t, { webProvider = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'prts-desktop-transport-'))
  const releasesDir = join(dir, 'releases')
  await mkdir(releasesDir)
  const shared = createSharedState({ configPath: join(dir, 'config.json'), releasesDir, patchConfig: {} })
  const ctx = new Context()
  const webRoutes = new Map()
  let webFiber
  if (webProvider) webFiber = await ctx.plugin({ name: 'desktop-test-legacy-web', apply(inner) {
    inner.provide('webServer', { register(route) {
      webRoutes.set(route.path, route)
      return () => { webRoutes.delete(route.path) }
    } })
  } })
  // The desktop carrier already authenticates requests before invoking this service's shared Fetch handler.
  const connectionFiber = await ctx.plugin({
    name: 'desktop-test-connection',
    inject: webProvider ? ['webServer'] : [],
    apply(inner) { new HostConnectionService(inner, [], {}) },
  })
  const uiFiber = await ctx.plugin({
    name: 'desktop-test-prts', inject: ['connection'],
    apply(inner) { applyUi(inner, shared) },
  })
  const transport = ctx.get('connection').createSharedFetchHandler('/api')
  const request = (path, options = {}) => transport.fetch(new Request(`https://dsh.invalid${path}`, options))
  const rpc = (endpoint, payload = {}, options = {}) => request('/api/prts-corpus/rpc', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }), ...options,
  })
  t.after(async () => {
    await uiFiber.dispose()
    await connectionFiber.dispose()
    await webFiber?.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  if (!webProvider) assert.equal(ctx.get('webServer'), undefined)
  return { ctx, shared, request, rpc, transport, webRoutes, dispose: () => uiFiber.dispose() }
}

nativeTest('Electron：无 webServer 时共享 Fetch 提供状态、配置及业务错误', async (t) => {
  const { shared, request, rpc, transport } = await fixture(t)
  assert.equal(transport.requestBodyMode({ method: 'POST', url: new URL('https://dsh.invalid/api/prts-corpus/rpc') }), 'streaming')
  const status = await (await rpc('status')).json()
  assert.equal(status.ok, true)
  assert.equal(status.value.store.installed, false)
  assert.equal(status.value.store.loaded, false)
  assert.equal(status.type, undefined, '业务响应不复制 DSH 的 RPC 信封')
  const saved = await (await rpc('config.update', { patch: { uiSkin: 'endfield-aic' } })).json()
  assert.equal(saved.ok, true)
  assert.equal(shared.effective().uiSkin, 'endfield-aic')
  assert.deepEqual(await (await request('/api/prts-corpus/ui-skin.json')).json(), { uiSkin: 'endfield-aic' })
  const invalid = await (await rpc('config.update', { patch: { enabledGames: [] } })).json()
  assert.equal(invalid.error.code, 'bad-request')
  const unknown = await (await rpc('__proto__')).json()
  assert.equal(unknown.error.code, 'not-found')
  assert.equal((await request('/api/prts-corpus/rpc')).status, 404)
})

nativeTest('Electron：原生 CSS、JS、JSON、PNG 与 HEAD 使用 identity 字节', async (t) => {
  const { request } = await fixture(t)
  const mapRoot = join(packageDir, 'lib/endfield-map')
  const names = await readdir(join(mapRoot, 'resources'))
  const jsonName = names.find(name => name.endsWith('.json.br')).replace(/\.br$/, '')
  const pngName = names.find(name => name.endsWith('.png'))
  const cases = [
    ...['common.css', 'prts-agent.css', 'endfield-aic.css'].map(name => ({
      path: `/api/prts-corpus/skins/${name}`, disk: join(packageDir, 'lib/skins', name), mime: 'text/css',
    })),
    { path: '/api/prts-corpus/endfield-map/map.js', disk: join(mapRoot, 'map.js'), mime: 'text/javascript' },
    { path: `/api/prts-corpus/endfield-map/resources/${jsonName}`, disk: join(mapRoot, 'resources', jsonName), mime: 'application/json' },
    { path: `/api/prts-corpus/endfield-map/resources/${pngName}`, disk: join(mapRoot, 'resources', pngName), mime: 'image/png' },
  ]
  for (const entry of cases) {
    const expected = existsSync(entry.disk) ? await readFile(entry.disk)
      : existsSync(`${entry.disk}.br`) ? brotliDecompressSync(await readFile(`${entry.disk}.br`))
        : gunzipSync(await readFile(`${entry.disk}.gz`))
    const response = await request(entry.path, { headers: { 'accept-encoding': 'br, gzip' } })
    assert.equal(response.status, 200, entry.path)
    assert.equal(response.headers.get('content-encoding'), null)
    assert.ok(response.headers.get('content-type').startsWith(entry.mime))
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected)
    const head = await request(entry.path, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.body, null)
    assert.equal(Number(head.headers.get('content-length')), expected.length)
  }
  const head = await request('/api/prts-corpus/ui-skin.json', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.body, null)
})

nativeTest('Electron：资源只允许固定白名单，遍历和物理压缩路径返回 404', async (t) => {
  const { request } = await fixture(t)
  for (const path of [
    '/api/prts-corpus/endfield-map/../package.json',
    '/api/prts-corpus/endfield-map/%2e%2e%2fpackage.json',
    '/api/prts-corpus/endfield-map/resources/%2e%2e%5cmap.js',
    '/api/prts-corpus/endfield-map/map.js.br',
    '/api/prts-corpus/endfield-map/resources/map-0000000000000000.json',
    '/api/prts-corpus/skins/../../package.json',
    '/api/prts-corpus/skins/missing.css',
  ]) assert.equal((await request(path)).status, 404, path)
})

nativeTest('Electron：流式 JSON 请求按实际字节限额并拒绝畸形输入', async (t) => {
  const { request } = await fixture(t)
  const post = (body, headers = { 'content-type': 'application/json' }) => request('/api/prts-corpus/rpc', {
    method: 'POST', headers, body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  })
  assert.equal((await post('{}', { 'content-type': 'text/plain' })).status, 415)
  assert.equal((await post('{')).status, 400)
  assert.equal((await post('[]')).status, 400)
  assert.equal((await post('{"endpoint":17}')).status, 400)
  assert.equal((await post('{}', { 'content-type': 'application/json', 'content-length': String(1024 * 1024 + 1) })).status, 413)
  let cancelled = false
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(65536)) },
    cancel() { cancelled = true },
  })
  const tooLarge = await post(body)
  assert.equal(tooLarge.status, 413)
  assert.equal((await tooLarge.json()).error.code, 'bad-request')
  assert.equal(cancelled, true)
  for (const [headers, expectedStatus] of [
    [{ 'content-type': 'text/plain' }, 415],
    [{ 'content-type': 'application/json', 'content-length': String(1024 * 1024 + 1) }, 413],
  ]) {
    let uploadClosed = false
    const response = await post(new ReadableStream({ cancel() { uploadClosed = true } }), headers)
    assert.equal(response.status, expectedStatus)
    assert.equal(uploadClosed, true, '提前拒绝也必须关闭上传流')
  }
})

nativeTest('Electron：取消未完成上传或配置请求不会修改配置', async (t) => {
  const { shared, request, rpc } = await fixture(t)
  const initial = shared.effective().uiSkin
  const abort = new AbortController()
  abort.abort()
  assert.equal((await (await rpc('config.update', { patch: { uiSkin: 'endfield-aic' } }, { signal: abort.signal })).json()).error.code, 'cancelled')
  assert.equal(shared.effective().uiSkin, initial)
  let earlyCancelled = false
  const early = await request('/api/prts-corpus/rpc', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: abort.signal, duplex: 'half',
    body: new ReadableStream({ cancel() { earlyCancelled = true } }),
  })
  assert.equal((await early.json()).error.code, 'cancelled')
  assert.equal(earlyCancelled, true)
  const uploading = new AbortController()
  let cancelled = false
  const pending = request('/api/prts-corpus/rpc', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: uploading.signal, duplex: 'half',
    body: new ReadableStream({ cancel() { cancelled = true } }),
  })
  await tick()
  uploading.abort()
  assert.equal((await (await pending).json()).error.code, 'cancelled')
  assert.equal(cancelled, true)
})

nativeTest('Electron：未消费的资源占用配额，消费、取消和卸载会释放', async (t) => {
  const { request, dispose } = await fixture(t)
  const path = '/api/prts-corpus/skins/common.css'
  const held = []
  for (let index = 0; index < 32; index += 1) {
    const response = await request(path)
    assert.equal(response.status, 200)
    held.push(response)
  }
  assert.equal((await request(path)).status, 503)
  await held.shift().body.cancel()
  const replacement = await request(path)
  assert.equal(replacement.status, 200)
  await replacement.arrayBuffer()
  const controller = new AbortController()
  const aborted = await request(path, { signal: controller.signal })
  controller.abort()
  await assert.rejects(aborted.arrayBuffer(), /取消/)
  const last = await request(path)
  assert.equal(last.status, 200)
  for (const response of held) await response.arrayBuffer()
  await dispose()
  await assert.rejects(last.arrayBuffer(), /取消/)
  assert.equal((await request(path)).status, 404)
  assert.equal((await request('/api/prts-corpus/ui-skin.json')).status, 404)
})

nativeTest('Web：webServer 后到或卸载不影响共享 Fetch 路由', async (t) => {
  const { ctx, request } = await fixture(t)
  const routes = new Map()
  const web = await ctx.plugin({ name: 'desktop-test-web-server', apply(inner) {
    inner.provide('webServer', { register(route) {
      routes.set(route.path, route)
      return () => { routes.delete(route.path) }
    } })
  } })
  await tick()
  for (const runtime of ctx.registry.values()) for (const fiber of runtime.fibers) await fiber.await()
  assert.equal(routes.has('/prts-corpus'), false, '无 webServer 注入的 Connection 提供者跳过旧 RPC')
  assert.ok(routes.has('/prts-corpus/endfield-map'))
  assert.equal((await request('/api/prts-corpus/ui-skin.json')).status, 200)
  await web.dispose()
  assert.equal(routes.size, 0)
  assert.equal((await request('/api/prts-corpus/ui-skin.json')).status, 200)
})

nativeTest('旧 Web：提供者声明 webServer 时仍注册 legacy RPC 和静态路径', async (t) => {
  const { ctx, webRoutes, request, dispose } = await fixture(t, { webProvider: true })
  for (const runtime of ctx.registry.values()) for (const fiber of runtime.fibers) await fiber.await()
  assert.ok(webRoutes.has('/prts-corpus'))
  assert.ok(webRoutes.has('/prts-corpus/ui-skin.json'))
  assert.ok(webRoutes.has('/prts-corpus/endfield-map'))
  assert.equal((await request('/api/prts-corpus/ui-skin.json')).status, 200)
  await dispose()
  assert.equal(webRoutes.size, 0)
})
