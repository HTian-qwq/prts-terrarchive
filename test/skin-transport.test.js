import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const hostDir = process.env.PRTS_DSH_SOURCE_DIR
const playwrightModule = process.env.PRTS_PLAYWRIGHT_MODULE

test('browser Fetch loads authenticated skins and map assets, reports errors, and cancels on unload', {
  skip: !hostDir || !playwrightModule
    ? 'Set PRTS_DSH_SOURCE_DIR and PRTS_PLAYWRIGHT_MODULE for the browser compatibility check'
    : false,
}, async (t) => {
  const hostRequire = createRequire(resolve(hostDir, 'package.json'))
  const webRequire = createRequire(resolve(hostDir, 'apps/web/package.json'))
  const buildRequire = createRequire(hostRequire.resolve('tsx/package.json'))
  const { build } = buildRequire('esbuild')
  const { outputFiles } = await build({
    absWorkingDir: hostDir,
    stdin: { resolveDir: hostDir, contents: `
      import React from ${JSON.stringify(webRequire.resolve('react'))};
      import { createRoot } from ${JSON.stringify(webRequire.resolve('react-dom/client'))};
      window.fixtureReact = { React, createRoot };
    ` },
    bundle: true, write: false, format: 'iife', platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  const files = new Map([
    ['/react.js', ['text/javascript', outputFiles[0].contents]],
    ['/client.js', ['text/javascript', await readFile(new URL('../lib/client.js', import.meta.url))]],
  ])
  for (const skin of ['common', 'prts-agent', 'endfield-aic']) {
    files.set(`/api/prts-corpus/skins/${skin}.css`, ['text/css',
      await readFile(new URL(`../lib/skins/${skin}.css`, import.meta.url))])
  }
  const requests = []
  let configuredSkin = 'endfield-aic'
  let responseMode = 'success'
  let heldResponse = null
  let cancelled = false
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture')
    const record = { path: url.pathname, search: url.search, method: request.method }
    requests.push(record)
    const send = (status, type, body) => {
      response.writeHead(status, { 'content-type': `${type}; charset=utf-8` })
      response.end(body)
    }
    if (url.pathname === '/') {
      response.setHeader('set-cookie', 'fixture_auth=1; HttpOnly; SameSite=Lax; Path=/')
      send(200, 'text/html', '<!doctype html><html><head></head><body><div id="shell"></div></body></html>')
      return
    }
    if (url.pathname.startsWith('/api/') && !request.headers.cookie?.includes('fixture_auth=1')) {
      send(401, 'text/plain', 'Authentication required')
      return
    }
    const file = files.get(url.pathname)
    if (file) { send(200, ...file); return }
    if (url.pathname === '/api/prts-corpus/ui-skin.json') {
      send(200, 'application/json', JSON.stringify({ uiSkin: configuredSkin }))
      return
    }
    if (url.pathname === '/api/prts-corpus/endfield-map/map.js') {
      send(200, 'text/javascript', `
        window.__PRTS_ENDFIELD_MAP__ = {
          RUNTIME_ABI: 3, REGION_LIST: [],
          async createRegionMap(element, options) {
            const response = await fetch('/api/prts-corpus/endfield-map/resources/fixture.json',
              { signal: options.signal });
            if (!response.ok) throw new Error('Map resource failed');
            await response.json();
            window.mapCreated = (window.mapCreated || 0) + 1;
            element.dataset.mapReady = 'true';
            options.onProgress(100, 'Ready');
            return { pause() {}, resume() {}, setFocusPoint() {}, dispose() {
              window.mapDisposed = (window.mapDisposed || 0) + 1;
            } };
          }
        };
      `)
      return
    }
    if (url.pathname === '/api/prts-corpus/endfield-map/resources/fixture.json') {
      send(200, 'application/json', '{}')
      return
    }
    if (url.pathname === '/api/prts-corpus/rpc' && request.method === 'POST') {
      let body = ''
      for await (const chunk of request) body += chunk
      const { endpoint, payload } = JSON.parse(body)
      record.endpoint = endpoint
      if (endpoint === 'config.update') {
        if (responseMode === 'http') { send(503, 'text/plain', 'Unavailable'); return }
        if (responseMode === 'invalid') { send(200, 'application/json', '{}'); return }
        if (responseMode === 'reject') {
          send(200, 'application/json', JSON.stringify({ ok: false, error: { message: 'Fixture config rejected' } }))
          return
        }
        if (responseMode === 'hold') {
          heldResponse = response
          response.once('close', () => { cancelled = true })
          return
        }
        configuredSkin = payload.patch.uiSkin
        send(200, 'application/json', JSON.stringify({ ok: true, value: { config: { uiSkin: configuredSkin } } }))
        return
      }
      send(200, 'application/json', JSON.stringify({ ok: true,
        value: endpoint === 'status' ? { config: { uiSkin: configuredSkin } } : {} }))
      return
    }
    send(404, 'text/plain', 'Not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)) })
  const { chromium } = await import(pathToFileURL(resolve(playwrightModule)).href)
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PRTS_BROWSER_EXECUTABLE
      ? { executablePath: process.env.PRTS_BROWSER_EXECUTABLE } : {}),
  })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.addScriptTag({ url: '/react.js' })
  await page.evaluate(() => {
    window.__ModuleLoader__ = { load: (entry) => { window.pluginEntry = entry } }
  })
  await page.addScriptTag({ url: '/client.js' })
  await page.evaluate(() => {
    const { React, createRoot } = window.fixtureReact
    const effects = []
    const snapshot = { ids: [], byId: {}, current: undefined }
    window.plugin = window.pluginEntry.factory((name) => {
      if (name === 'react') return React
      throw new Error(`Unexpected dependency: ${name}`)
    })
    const ctx = {
      // Calling the old transport is a test failure, even if it is swallowed.
      connection: { rpc: { call() { window.legacyRpcUsed = true; throw new Error('Legacy RPC unavailable') } } },
      effect(operation) {
        const cleanup = operation()
        if (typeof cleanup === 'function') effects.push(cleanup)
        return cleanup || (() => {})
      },
      slots: {
        inject(_name, callback) { return callback() },
        register(descriptor, Component) {
          if (descriptor.name !== 'shell.overlay') return () => {}
          const container = document.createElement('div')
          container.dataset.slot = 'shell.overlay'
          document.querySelector('#shell').append(container)
          const root = createRoot(container)
          root.render(React.createElement(Component, { useSessions: (selector) => selector(snapshot) }))
          return () => { root.unmount(); container.remove() }
        },
      },
      theme: { overrideTokens: () => () => {} },
      sessions: { open() {}, async create() { return 'session' } },
    }
    window.unloadPlugin = () => { for (const cleanup of effects.splice(0).reverse()) cleanup() }
    window.plugin.apply(ctx)
  })
  await page.waitForSelector('[data-map-ready="true"]')
  assert.equal(await page.evaluate(() => document.body.dataset.prtsSkin), 'endfield-aic')
  assert.equal(await page.evaluate(() => window.__PRTS_ENDFIELD_MAP__.RUNTIME_ABI), 3)
  assert.equal(requests.some((request) => request.path === '/api/prts-corpus/skins/prts-agent.css'), false)
  assert.equal(requests.find((request) => request.path.endsWith('/map.js'))?.search, '?abi=3')
  assert.ok(requests.some((request) => request.path.endsWith('/resources/fixture.json')))

  await page.evaluate(() => window.plugin.__skinStateForTest.setSkin('harness', {
    beforeCommit: () => window.plugin.__skinStateForTest.writeSkinConfig('harness'),
  }))
  assert.equal(configuredSkin, 'harness')
  assert.equal(await page.locator('.aic-map').count(), 0)
  assert.equal(await page.evaluate(() => window.mapDisposed), 1)
  assert.equal(await page.locator('link[href$="endfield-aic.css"]').count(), 0)
  await page.evaluate(() => window.plugin.__skinStateForTest.setSkin('endfield-aic', {
    beforeCommit: () => window.plugin.__skinStateForTest.writeSkinConfig('endfield-aic'),
  }))
  await page.waitForSelector('[data-map-ready="true"]')
  assert.equal(await page.evaluate(() => window.mapCreated), 2)
  assert.equal(requests.filter((request) => request.path.endsWith('/map.js')).length, 1,
    'remount should reuse the already loaded ABI-compatible runtime')

  for (const [mode, message] of [['http', /HTTP 503/], ['invalid', /无效响应/], ['reject', /Fixture config rejected/]]) {
    responseMode = mode
    const error = await page.evaluate(async () => {
      try { await window.plugin.__skinStateForTest.writeSkinConfig('harness'); return null }
      catch (error) { return error.message }
    })
    assert.match(error, message)
    assert.equal(configuredSkin, 'endfield-aic')
  }
  responseMode = 'hold'
  await page.evaluate(() => {
    window.pendingWrite = window.plugin.__skinStateForTest.writeSkinConfig('harness')
      .then(() => 'resolved', (error) => error.name)
  })
  for (let attempt = 0; !heldResponse && attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(heldResponse, 'the pending request must reach the server before unload')
  await page.evaluate(() => window.unloadPlugin())
  assert.equal(await page.evaluate(() => window.pendingWrite), 'AbortError')
  for (let attempt = 0; !cancelled && attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(cancelled, true, 'unload must close the real in-flight fetch')
  assert.equal(await page.locator('.aic-map').count(), 0)
  assert.equal(await page.evaluate(() => window.mapDisposed), 2)
  assert.equal(await page.locator('link[data-plugin="prts-terrarchive"]').count(), 0)
  assert.equal(await page.evaluate(() => window.__PRTS_ENDFIELD_MAP__ === undefined), true)
  assert.equal(await page.evaluate(() => Boolean(window.legacyRpcUsed)), false)
  assert.equal(requests.some((request) => request.path.startsWith('/prts-corpus/')), false)
  assert.deepEqual(pageErrors, [])
})
