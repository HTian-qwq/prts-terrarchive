import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createSharedState } from '../src/state.js'
import { createInvestigationStore } from '../src/investigation-store.js'
import { buildApi } from '../src/ui.js'

const host = process.env.PRTS_DSH_SOURCE_DIR
const playwrightPath = process.env.PRTS_PLAYWRIGHT_MODULE
test('an existing ordinary conversation opens its saved board when switching to Rhine and retains it across skins', {
  skip: (!host || !playwrightPath) && 'Set PRTS_DSH_SOURCE_DIR and PRTS_PLAYWRIGHT_MODULE for the real React/browser regression', timeout: 60000,
}, async t => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const home = await mkdtemp(join(tmpdir(), 'prts-rhine-skin-session-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const values = new Map()
  const service = createInvestigationStore({ async open(spec) {
    let queue = Promise.resolve()
    return { close: async () => {}, table: () => ({ get: () => values.get(spec.name),
      put: async (_key, value) => values.set(spec.name, structuredClone(value)),
      update(_key, operation) {
        const task = queue.then(() => {
          const next = spec.tables.portfolios.valueSchema.parse(operation(values.get(spec.name)))
          values.set(spec.name, structuredClone(next)); return structuredClone(next)
        })
        queue = task.catch(() => {}); return task
      },
    }) }
  } })
  t.after(() => service.close())
  const session = 'integration-session'
  const board = await service.open(session, { mode: 'new', title: '原会话的调查', objective: '保留线索', reason: '回归测试' }, { callId: 'open', turnId: 1 })
  await service.update(session, { ...board, expected_revision: 0, clues: [{ title: '原来的线索', kind: 'question' }] }, { callId: 'clue', turnId: 1 })
  const shared = createSharedState({ configPath: join(home, 'config.json'), releasesDir: join(home, 'releases') })
  await shared.saveConfig({ uiSkin: 'prts-agent' })
  shared.investigations = service
  const api = buildApi(shared)
  const hostRequire = createRequire(join(resolve(host), 'packages/client/ui-conversation/package.json'))
  const localRequire = createRequire(new URL('../package.json', import.meta.url))
  const { build } = createRequire(localRequire.resolve('vite/package.json'))('esbuild')
  const entry = (await readFile(new URL('./fixtures/rhine-host.js', import.meta.url), 'utf8'))
    .replace('"@host-react"', JSON.stringify(hostRequire.resolve('react')))
    .replace('"@host-react-dom"', JSON.stringify(hostRequire.resolve('react-dom/client')))
  const bundle = await build({ stdin: { contents: entry, resolveDir: root }, bundle: true, write: false, format: 'iife' })
  const { chromium } = await import(pathToFileURL(resolve(playwrightPath)).href)
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PRTS_BROWSER_EXECUTABLE ? { executablePath: process.env.PRTS_BROWSER_EXECUTABLE } : {}),
  })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
  const errors = [], calls = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      return /^webgl/.test(type) ? null : original.call(this, type, ...args)
    }
  })
  await page.route('http://rhine-switch.test/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><meta charset="utf-8"><div id="host"></div></html>' })
    if (path === '/api/prts-corpus/ui-skin.json') return route.fulfill({ json: { uiSkin: shared.effective().uiSkin } })
    if (path === '/api/prts-corpus/rpc') {
      const { endpoint, payload } = route.request().postDataJSON()
      if (endpoint === 'status') return route.fulfill({ json: { ok: true, value: { config: shared.effective() } } })
      if (endpoint === 'config.update') {
        await shared.saveConfig(payload.patch)
        return route.fulfill({ json: { ok: true, value: { config: shared.effective() } } })
      }
      if (endpoint === 'investigation.watch') return route.fulfill({ json: { ok: false, error: { message: 'Polling disabled in fixture' } } })
      if (endpoint.startsWith('investigation.')) {
        calls.push({ endpoint, sessionId: payload.session_id })
        const result = await api.call('POST', `/api/prts-corpus/${endpoint.replace('.', '/')}`, payload)
        return route.fulfill({ json: { ok: result.status === 200, value: result.json, error: { message: result.json.error } } })
      }
      return route.fulfill({ json: { ok: true, value: { games: ['arknights'], sources: [], page: { has_more: false } } } })
    }
    const relative = path.replace('/api/prts-corpus/', '')
    if (!/^(skins|rhine)\/[\w./-]+$/.test(relative) || relative.includes('..')) return route.fulfill({ status: 404 })
    return route.fulfill({ body: await readFile(join(root, 'lib', relative)), contentType: relative.endsWith('.js') ? 'text/javascript'
      : relative.endsWith('.css') ? 'text/css' : 'application/octet-stream' })
  })
  await page.goto('http://rhine-switch.test/')
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.evaluate(() => { window.__ModuleLoader__ = { load({ factory }) { window.hostPlugin = factory(() => window.hostReact) } } })
  await page.addScriptTag({ path: join(root, 'lib/client.js') })
  await page.evaluate(() => {
    const slots = [], cleanups = []
    window.hostPlugin.apply({ theme: { overrideTokens: () => () => {} }, sessions: { binding: () => ({ session: {} }) },
      slots: { inject: (_name, fn) => fn(), register: (entry, Component) => { slots.push({ entry, Component }); return () => {} } },
      effect: fn => { const dispose = fn(); cleanups.push(dispose); return dispose },
    })
    window.renderRhineHost(slots)
    window.hostSession.blank = false
    window.hostChat.order = ['previous-question']
    window.hostChat.nodes.set('previous-question', { kind: 'user', data: { content: [{ type: 'text', text: '之前的问题' }] } })
    window.hostEmit()
    window.cleanup = () => { window.hostRoot.unmount(); for (const dispose of cleanups.reverse()) dispose?.() }
  })
  await page.waitForFunction(() => document.body.dataset.prtsSkin === 'agent')
  assert.equal(await page.locator('.prts-rhine-overlay').count(), 0)
  assert.equal(calls.length, 0, 'ordinary skin does not open a board UI')
  const skin = value => page.evaluate(async value => {
    const state = window.hostPlugin.__skinStateForTest
    await state.setSkin(value, { beforeCommit: () => state.writeSkinConfig(value) })
  }, value)
  for (const previous of ['prts-agent', 'harness']) {
    await skin('rhine-lab')
    await page.waitForFunction(() => window.rhineWorkbench?.stats().investigations.clues === 1)
    assert.equal(await page.locator('.prts-rhine-overlay').count(), 1)
    assert.match(await page.locator('.rhine-investigation-picker option').first().textContent(), /^原会话的调查 · 1 条线索$/)
    assert(calls.every(call => call.sessionId === session), 'all UI reads keep the original session identity')
    await skin(previous)
    await page.waitForFunction(() => !document.querySelector('.prts-rhine-overlay'))
    assert.equal((await service.read(session, { board_id: board.board_id })).board.clues.length, 1)
  }
  assert.equal((await service.read(session)).boards.length, 1)
  await page.evaluate(() => window.cleanup())
  assert.deepEqual(errors, [])
})
