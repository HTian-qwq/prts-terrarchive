/** Exercise legacy assets through DSH's real HTTP bridge and signed browser cookie. */
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'

const [pluginRoot, dshRoot] = process.argv.slice(2)
const fromHost = (path: string) => import(pathToFileURL(join(dshRoot, path)).href)
const connectionPlugin = await fromHost('packages/client/connection/src/index.ts')
const { provideBrowserCredentials } = await fromHost('packages/client/connection/tests/browser-credentials.ts')
const { applyUi } = await import(pathToFileURL(join(pluginRoot, 'src/ui.js')).href)
const { createSharedState } = await import(pathToFileURL(join(pluginRoot, 'src/state.js')).href)
const home = await mkdtemp(join(tmpdir(), 'prts-dsh-assets-'))
const root = new Context()
const routes: WebRoute[] = []
let connection: HostConnectionHandle
const server = createServer((req, res) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname
  if (pathname === '/') {
    if (connection.authorizeIndex(req, res)) { res.writeHead(200); res.end('authenticated') }
    return
  }
  const route = routes.find(r => r.kind === 'exact' && r.path === pathname)
    || routes.filter(r => r.kind === 'prefix' && pathname.startsWith(r.path))
      .sort((a, b) => b.path.length - a.path.length)[0]
  if (!route) { res.writeHead(404); res.end(); return }
  Promise.resolve(route.handler(req, res)).catch(error => { res.destroy(error) })
})
try {
  provideBrowserCredentials(root)
  root.provide('webServer', {
    register(route: WebRoute) {
      assert(!routes.some(r => r.kind === route.kind && r.path === route.path))
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    registerUpgrade: () => () => {}, tapIndex: () => () => {}, port: 0,
  } as unknown as WebServer)
  await root.plugin(connectionPlugin).await()
  connection = root.get('connection') as HostConnectionHandle
  const shared = createSharedState({ configPath: join(home, 'config.json'), releasesDir: home })
  await root.plugin({ inject: ['connection', 'webServer'], apply(ctx) { assert(applyUi(ctx, shared)) } }).await()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  const exchange = await fetch(connection.authenticatedUrl(base), { redirect: 'manual' })
  assert.equal(exchange.status, 303)
  const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]
  assert(cookie, 'the host launch-token exchange creates a signed browser cookie')
  const legacy = routes.filter(r => r.path.startsWith('/prts-corpus/') || r.path === '/webmap3d/resources')
  assert(legacy.length >= 8)
  const paths = ['/api/prts-corpus/ui-skin.json', ...legacy.map(r => r.kind === 'prefix'
    ? r.path === '/webmap3d/resources' ? `${r.path}/map-00b0d0744a1b4404.json` : `${r.path}/map.js`
    : r.path)]
  for (const path of paths) {
    for (const method of ['GET', 'HEAD']) {
      const anonymous = await fetch(base + path, { method })
      assert.equal(anonymous.status, 401, `${method} ${path} without a cookie`)
      await anonymous.arrayBuffer()
      const crossOrigin = await fetch(base + path, { method, headers: { cookie, origin: 'https://untrusted.example' } })
      assert.equal(crossOrigin.status, 403, `${method} ${path} with a foreign Origin`)
      await crossOrigin.arrayBuffer()
      // Node Fetch overwrites Host. Use the raw HTTP client for a real forged-Host request.
      const foreignHost = await new Promise<number | undefined>((resolve, reject) => {
        const req = httpRequest(base + path, { method, headers: { cookie, host: 'untrusted.example' } }, res => {
          res.resume()
          res.once('end', () => resolve(res.statusCode))
          res.once('error', reject)
        })
        req.once('error', reject)
        req.end()
      })
      assert.equal(foreignHost, 403, `${method} ${path} with a foreign Host`)
    }
    const authenticated = await fetch(base + path, { method: 'HEAD', headers: { cookie } })
    assert.equal(authenticated.status, 200, `authenticated HEAD ${path}`)
    assert.equal((await authenticated.arrayBuffer()).byteLength, 0)
  }
  for (const path of ['/api/prts-corpus/ui-skin.json', '/prts-corpus/ui-skin.json']) {
    const response = await fetch(base + path, { headers: { cookie } })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { uiSkin: 'harness' })
  }
  console.log('DSH native asset admission passed: cookies, Host/Origin, legacy assets and shared Fetch')
} finally {
  server.closeAllConnections()
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await root.fiber.dispose()
  await rm(home, { recursive: true, force: true })
}
