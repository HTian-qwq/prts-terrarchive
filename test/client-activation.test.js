import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setImmediate as nextTurn } from 'node:timers/promises'
import vm from 'node:vm'

const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const required = ['slots', 'connection', 'theme', 'sessions', 'remote', 'remote.agentPresets', 'remote.session', 'workspaces', 'modelDirectories']
function loadClient(errors = []) {
  let plugin
  vm.runInNewContext(code, {
    window: { __ModuleLoader__: { load({ factory }) { plugin = factory(() => ({})) } },
      requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout },
    console: { ...console, error: (...args) => errors.push(args.map(String).join(' ')) },
    AbortController, DOMException, performance, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => ({ ok: true, json: async () => ({ uiSkin: 'harness' }) }),
  })
  return plugin
}

test('client dependency declaration names services supported by DSH Cordis', () => {
  const plugin = loadClient()
  assert(Array.isArray(plugin.inject), 'DSH Cordis treats object keys as service names, not required/optional groups')
  assert.deepEqual([...plugin.inject], required)
})

const hostDir = process.env.PRTS_DSH_SOURCE_DIR
for (const modern of [false, true]) test(`real Cordis activates the client and navigates with ${modern ? 'late modern navigation services' : 'legacy services only'}`, {
  skip: !hostDir && 'Set PRTS_DSH_SOURCE_DIR to a built DSH checkout for its real Cordis runtime',
  timeout: 10000,
}, async t => {
  const { Context, Service } = await import(pathToFileURL(resolve(hostDir, 'vendor/cordis/lib/index.js')).href)
  const root = new Context(), errors = [], registered = new Set(), opened = [], retained = new Set()
  const plugin = loadClient(errors)
  t.after(() => root.fiber.dispose())
  const store = state => ({ getSnapshot: () => state, subscribe: () => () => {} })
  const catalog = { ids: ['a', 'b'], byId: { a: { id: 'a', blank: true }, b: { id: 'b', blank: false } }, ...(!modern && { current: 'a' }) }
  let cancels = 0, navigations = 0
  const session = { ...store({ blank: true, running: false }), cancel: async () => { cancels++; return { ok: true } } }
  const sessions = { list: store(catalog), binding: () => ({ session }), refresh: async () => {},
    create: async () => { catalog.ids.push('new'); catalog.byId.new = { id: 'new', blank: true }; return 'new' },
    ...(!modern && { open: id => opened.push(id) }),
    ...(modern && { retain(id) { retained.add(id); return { ready: Promise.resolve(), release() { retained.delete(id) } } } }),
  }
  const presets = { list: async () => ({ ok: true, value: { presets: [{ id: 'prts', name: 'PRTS' }] } }),
    select: async (id, mode) => { if (modern) assert(retained.has(id)); catalog.byId[id].projectionValues = { agentPreset: mode }; return { ok: true } } }
  const services = { sessions, connection: {}, theme: {}, remote: { agentPresets: presets, session: {} },
    'remote.agentPresets': presets, 'remote.session': {},
    workspaces: { list: store({ items: [], archivedSessionIds: [] }) },
    modelDirectories: { directoryFor: () => ({ store: store({ status: 'ready', routable: true, groups: [] }), load: async () => {} }) },
    slots: { inject: (_name, install) => install(), register: entry => { registered.add(entry.id); return () => registered.delete(entry.id) } },
  }
  for (const [name, value] of Object.entries(services)) root.provide(name, value)
  // Load the shipped module through a real plugin fiber, not plugin.apply(mock).
  const fiber = root.plugin(plugin)
  await nextTurn()
  assert.equal(fiber.state, 2, `client must be ACTIVE; unresolved inject: ${Object.keys(fiber.inject).filter(name => root.get(name) === undefined).join(', ')}`)
  assert.deepEqual([...registered].sort(), ['prts-corpus', 'prts-evidence', 'prts-rhine'])
  assert.throws(() => fiber.ctx.uiWorkspace, /without inject/)
  let navigationProvider
  if (modern) {
    root.provide('layout', { beginNavigation() { navigations++; return new AbortController().signal }, selectPanel() {} })
    class Navigation extends Service {
      constructor(ctx) { super(ctx, 'uiWorkspace') }
      openSession(id) { this.ctx.layout.selectPanel(null); opened.push(id) }
    }
    navigationProvider = root.plugin({ inject: ['layout'], apply(ctx) { new Navigation(ctx) } })
    await navigationProvider
  }
  const controls = plugin.__rhineStateForTest.createRhineHostControls(fiber.ctx, 'a')
  t.after(() => controls.dispose())
  await controls.refresh()
  await controls.cancel()
  await controls.createSession('prts')
  assert.equal(cancels, 1)
  assert.deepEqual(opened, ['new'])
  assert.equal(catalog.byId.new.projectionValues.agentPreset, 'prts')
  assert.equal(retained.size, 0)
  assert.equal(navigations, modern ? 1 : 0)
  if (modern) {
    await navigationProvider.dispose()
    await assert.rejects(controls.openSession('b'), /当前宿主未提供会话导航/)
  } else {
    await controls.openSession('b')
    assert.deepEqual(opened, ['new', 'b'])
  }
  await nextTurn()
  assert.deepEqual(errors, [])
  await fiber.dispose()
  assert.equal(registered.size, 0)
})
