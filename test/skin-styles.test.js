import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { createSharedState } from '../src/state.js'
import { applyUi } from '../src/ui.js'

test('共享控件与两套皮肤以独立 CSS 白名单资源提供，并随 Host UI 生命周期卸载', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-skin-css-'))
  const routes = []
  const disposed = []
  const effects = []
  try {
    const shared = createSharedState({ configPath: join(dir, 'config.json'), releasesDir: dir,
      patchConfig: {} })
    const ctx = {
      connection: { rpc: { handle: () => () => {} } },
      webServer: { register: (entry) => {
        routes.push(entry)
        return () => { disposed.push(entry.path) }
      } },
      effect: (operation) => {
        const cleanup = operation()
        effects.push(cleanup)
        return cleanup
      },
      logger: { info: () => {}, warn: () => {} },
    }
    assert.equal(applyUi(ctx, shared), true)

    const cases = [
      ['common', '/prts-corpus/skins/common.css'],
      ['prts-agent', '/prts-corpus/skins/prts-agent.css'],
      ['endfield-aic', '/prts-corpus/skins/endfield-aic.css'],
    ]
    for (const [skin, path] of cases) {
      const route = routes.find((entry) => entry.kind === 'exact' && entry.path === path)
      assert.ok(route, `${skin} stylesheet route missing`)
      const response = {
        status: null, headers: {}, body: undefined,
        writeHead(status, headers = {}) { this.status = status; this.headers = headers },
        end(body) { this.body = body },
      }
      await route.handler({ method: 'GET' }, response)
      assert.equal(response.status, 200)
      assert.equal(response.headers['content-type'], 'text/css; charset=utf-8')
      assert.equal(response.headers['x-content-type-options'], 'nosniff')
      assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin')
      const packaged = await readFile(new URL(`../lib/skins/${skin}.css`, import.meta.url))
      assert.deepEqual(response.body, packaged)

      const head = {
        status: null, headers: {}, body: 'not-ended',
        writeHead(status, headers = {}) { this.status = status; this.headers = headers },
        end(body) { this.body = body },
      }
      await route.handler({ method: 'HEAD' }, head)
      assert.equal(head.status, 200)
      assert.equal(head.body, undefined)
      assert.equal(Number(head.headers['content-length']), packaged.length)

      const rejected = {
        status: null,
        writeHead(status) { this.status = status },
        end() {},
      }
      await route.handler({ method: 'POST' }, rejected)
      assert.equal(rejected.status, 405)
    }

    const agentCss = await readFile(new URL('../lib/skins/prts-agent.css', import.meta.url), 'utf8')
    assert.match(agentCss, /\.prts-agent-scene \.prts-cpu-assembly\{width:70vw;left:58%\}/,
      'tablet CPU override must match the desktop selector specificity')
    assert.match(agentCss, /\.prts-agent-scene \.prts-hero-identity\{left:50%;width:88vw\}/,
      'phone hero override must match the desktop selector specificity')
    assert.match(agentCss,
      /\.prts-evidence-drawer\{[^}]*box-sizing:border-box;[^}]*width:min\(430px,92vw\)/,
      'evidence drawer nominal width must include padding and border')
    assert.match(agentCss,
      /\.prts-source-reader\{[^}]*box-sizing:border-box;[^}]*width:min\(560px,94vw\)/,
      'source reader nominal width must include padding and border')

    const aicCss = await readFile(new URL('../lib/skins/endfield-aic.css', import.meta.url), 'utf8')
    assert.match(aicCss, /height:calc\(100dvh - 84px/,
      'phone conversation must follow the dynamic viewport')
    assert.match(aicCss, /top:calc\(84px \+ env\(safe-area-inset-top,0px\)\)!important;width:100vw!important/,
      'phone conversation and terminal header must share one boundary')
    assert.match(aicCss, /width:max\(0px,calc\(100vw - 20px - env\(safe-area-inset-left,0px\)/,
      'phone welcome panel width must stay non-negative and safe-area aware')
    assert.match(aicCss, /\.aic-terminal-name span\{[^}]*text-overflow:ellipsis/,
      'long session titles must not push terminal actions off-screen')
    assert.match(aicCss,
      /\[aria-modal="true"\]\[role="dialog"\]:has\(\[data-slot="settings\.section"\]\)\{[^}]*width:min\(1180px/,
      'large terminal geometry must be scoped to the DSH settings dialog')
    assert.doesNotMatch(aicCss,
      /\[aria-modal="true"\]\[role="dialog"\]\{[^}]*width:min\(1180px/,
      'generic aria-modal dialogs such as history must not inherit settings geometry')
    assert.match(aicCss,
      /\.aic-drawer\{[^}]*width:min\(400px,calc\(100vw - 40px\)\)/,
      'desktop history drawer must keep its compact geometry')
    assert.match(aicCss,
      /@media\(max-width:680px\)[\s\S]*\.aic-drawer\{[^}]*left:env\(safe-area-inset-left,0px\);width:auto\}/,
      'phone history drawer must expand to its safe-area edges')

    const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
    assert.match(client, /aicBootDone\(bootToken, false\)/,
      'failed map startup must dismiss without painting SYSTEM ONLINE')
    assert.match(client, /aicBootProgress\(-1, 'STARTUP TIMEOUT', token\)[\s\S]*aicBootDone\(token, false\)/,
      'the startup watchdog must report timeout instead of SYSTEM ONLINE')
    assert.doesNotMatch(client, /const (?:SKIN_CSS|AIC_CSS) = `/)
    assert.match(client, /\/prts-corpus\/skins\/common\.css/)
    assert.match(client, /\/prts-corpus\/skins\/prts-agent\.css/)
    assert.match(client, /\/prts-corpus\/skins\/endfield-aic\.css/)
    assert.match(client, /const href = SKIN_STYLESHEETS\[id\]/,
      'active skin stylesheet must be selected by normalized skin id')
    assert.doesNotMatch(client, /SKIN_STYLESHEETS\.map/,
      'the browser must not eagerly load both skin stylesheets')

    const commonCss = await readFile(new URL('../lib/skins/common.css', import.meta.url), 'utf8')
    assert.match(commonCss, /\.prts-skin-options/)
    assert.match(commonCss, /\.prts-header-badge, \.prts-evidence-layer \{ display: none; \}/,
      'always-registered evidence UI must stay hidden outside the Agent skin')
    assert.doesNotMatch(agentCss, /\.prts-settings-wrap/,
      'shared settings controls must not make AIC depend on the Agent stylesheet')
    assert.doesNotMatch(aicCss, /^\.prts-settings-wrap\s*\{/m,
      'shared settings controls must live only in common.css')

    for (const cleanup of effects.reverse()) cleanup?.()
    assert.ok(disposed.includes('/prts-corpus/skins/prts-agent.css'))
    assert.ok(disposed.includes('/prts-corpus/skins/endfield-aic.css'))
    assert.ok(disposed.includes('/prts-corpus/skins/common.css'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

const flushTasks = () => new Promise((resolve) => { setImmediate(resolve) })
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const createBrowserSkinHarness = async ({
  themeOverride, rpcCall, manualTimeouts = false, manualIntervals = false,
  autoLoadCommon = true, initialDocumentBackground = '',
} = {}) => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let entry = null
  const connected = []
  const timers = []
  const intervals = []
  const storage = new Map()
  const storageWrites = []
  const tokenOverrides = []
  const tokenOwners = []
  const tokenDisposalOwners = []
  const slotRegistrations = []
  const slotDisposals = []
  const loggedErrors = []
  const documentListeners = new Map()
  const makeElement = (tag) => {
    const listeners = new Map()
    const element = {
      tagName: String(tag).toUpperCase(), dataset: {}, style: {}, className: '', id: '',
      attributes: {},
      classList: { add(name) {
        const values = new Set(String(element.className).split(/\s+/u).filter(Boolean))
        values.add(name)
        element.className = [...values].join(' ')
      } },
      setAttribute(name, value) { this.attributes[name] = String(value) },
      addEventListener(type, callback) {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type).add(callback)
      },
      removeEventListener(type, callback) { listeners.get(type)?.delete(callback) },
      emit(type) { for (const callback of [...(listeners.get(type) ?? [])]) callback() },
      querySelector: () => null,
      remove() {
        const index = connected.indexOf(element)
        if (index >= 0) connected.splice(index, 1)
      },
    }
    return element
  }
  const append = (element) => { if (!connected.includes(element)) connected.push(element) }
  const document = {
    head: { appendChild: append },
    body: { dataset: {}, appendChild: append, prepend: append,
      style: { setProperty() {}, removeProperty() {} } },
    documentElement: { style: { background: initialDocumentBackground }, clientWidth: 1280 },
    hidden: false,
    createElement: makeElement,
    getElementById: (id) => connected.find((element) => element.id === id) ?? null,
    addEventListener(type, callback) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set())
      documentListeners.get(type).add(callback)
    },
    removeEventListener(type, callback) { documentListeners.get(type)?.delete(callback) },
  }
  const setTimeoutImpl = manualTimeouts
    ? (callback, delay) => {
        const timer = { callback, delay, cleared: false }
        timers.push(timer)
        return timer
      }
    : setTimeout
  const clearTimeoutImpl = manualTimeouts
    ? (timer) => { if (timer) timer.cleared = true }
    : clearTimeout
  const setIntervalImpl = manualIntervals
    ? (callback, delay) => {
        const interval = { callback, delay, cleared: false }
        intervals.push(interval)
        return interval
      }
    : setInterval
  const clearIntervalImpl = manualIntervals
    ? (interval) => { if (interval) interval.cleared = true }
    : clearInterval
  const consoleStub = {
    ...console,
    error: (...args) => { loggedErrors.push(args) },
  }
  const window = { __ModuleLoader__: { load: (value) => { entry = value } } }
  vm.runInNewContext(source, {
    window, document, console: consoleStub, AbortController,
    setTimeout: setTimeoutImpl, clearTimeout: clearTimeoutImpl,
    setInterval: setIntervalImpl, clearInterval: clearIntervalImpl,
    addEventListener() {}, removeEventListener() {}, Element: class {},
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        const normalized = String(value)
        storage.set(key, normalized)
        storageWrites.push([key, normalized])
      },
    },
  })
  let currentRenderer = null
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => currentRenderer
      ? currentRenderer.useState(initial)
      : [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: (effect, deps) => currentRenderer?.useEffect(effect, deps),
    useCallback: (fn, deps) => currentRenderer?.useCallback(fn, deps) ?? fn,
    useMemo: (fn, deps) => currentRenderer?.useMemo(fn, deps) ?? fn(),
    useRef: (initial) => currentRenderer?.useRef(initial) ?? { current: initial },
    Fragment: 'Fragment',
  }
  const plugin = entry.factory((id) => {
    if (id === 'react') return reactStub
    throw new Error(`意外依赖 ${id}`)
  })
  const effects = []
  const mounts = []
  const sameDeps = (left, right) => Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  const mount = (Component, props = {}) => {
    const hooks = []
    let cursor = 0
    let output = null
    let pendingEffects = []
    let scheduled = false
    let mounted = true
    const scheduleRender = () => {
      if (!mounted || scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        if (mounted) render()
      })
    }
    const renderer = {
      useState(initial) {
        const index = cursor++
        if (!hooks[index]) {
          const slot = { value: typeof initial === 'function' ? initial() : initial }
          slot.set = (next) => {
            if (!mounted) return
            const value = typeof next === 'function' ? next(slot.value) : next
            if (Object.is(value, slot.value)) return
            slot.value = value
            scheduleRender()
          }
          hooks[index] = slot
        }
        return [hooks[index].value, hooks[index].set]
      },
      useRef(initial) {
        const index = cursor++
        if (!hooks[index]) hooks[index] = { value: { current: initial } }
        return hooks[index].value
      },
      useCallback(fn, deps) {
        const index = cursor++
        const slot = hooks[index]
        if (!slot || !sameDeps(slot.deps, deps)) hooks[index] = { value: fn, deps }
        return hooks[index].value
      },
      useMemo(fn, deps) {
        const index = cursor++
        const slot = hooks[index]
        if (!slot || !sameDeps(slot.deps, deps)) hooks[index] = { value: fn(), deps }
        return hooks[index].value
      },
      useEffect(effect, deps) {
        const index = cursor++
        const slot = hooks[index]
        if (slot && sameDeps(slot.deps, deps)) return
        const next = slot ?? {}
        next.deps = deps
        hooks[index] = next
        pendingEffects.push(() => {
          next.cleanup?.()
          next.cleanup = effect()
        })
      },
    }
    const render = () => {
      cursor = 0
      pendingEffects = []
      currentRenderer = renderer
      try { output = Component(props) } finally { currentRenderer = null }
      const readyEffects = pendingEffects
      pendingEffects = []
      for (const run of readyEffects) run()
    }
    const find = (predicate, node = output) => {
      if (!node || typeof node !== 'object') return null
      if (predicate(node)) return node
      for (const child of node.children ?? []) {
        if (Array.isArray(child)) {
          for (const nested of child) {
            const match = find(predicate, nested)
            if (match) return match
          }
        } else {
          const match = find(predicate, child)
          if (match) return match
        }
      }
      return null
    }
    const instance = {
      get output() { return output },
      find,
      unmount() {
        if (!mounted) return
        mounted = false
        for (const slot of hooks) slot?.cleanup?.()
      },
    }
    mounts.push(instance)
    render()
    return instance
  }
  const createContext = ({ owner = 'ctx1', contextRpcCall = rpcCall,
    contextThemeOverride = themeOverride } = {}) => ({
    effect: (operation) => {
      const cleanup = operation()
      if (typeof cleanup === 'function') effects.push(cleanup)
      return cleanup ?? (() => {})
    },
    slots: {
      inject: (_key, callback) => {
        const cleanup = callback()
        return typeof cleanup === 'function' ? cleanup : () => {}
      },
      register: (descriptor) => {
        slotRegistrations.push({ owner, id: descriptor?.id })
        let disposed = false
        return () => {
          if (disposed) return
          disposed = true
          slotDisposals.push({ owner, id: descriptor?.id })
        }
      },
    },
    connection: { rpc: { call: contextRpcCall ?? (async (_path, endpoint) => ({ ok: true,
      value: endpoint === 'status' ? { config: { uiSkin: 'harness' } } : {} })) } },
    theme: { overrideTokens: (sourceId, tokens) => {
      tokenOverrides.push(tokens)
      tokenOwners.push(owner)
      if (contextThemeOverride) return contextThemeOverride(sourceId, tokens, tokenOverrides.length)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        tokenDisposalOwners.push(owner)
      }
    } },
    sessions: { open() {}, async create() { return 'session' } },
  })
  const ctx = createContext()
  plugin.apply(ctx)
  if (autoLoadCommon) {
    const common = connected.find((element) => element.tagName === 'LINK'
      && element.href.endsWith('/common.css'))
    assert.ok(common, 'apply should start the common stylesheet request')
    common.emit('load')
  }
  await flushTasks()
  return {
    plugin, ctx, createContext, effects, connected, document, timers, intervals,
    storage, storageWrites, mount,
    tokenOverrides, tokenOwners, tokenDisposalOwners, slotRegistrations, slotDisposals, loggedErrors,
    link(suffix) {
      return connected.find((element) => element.tagName === 'LINK'
        && element.href.endsWith(suffix))
    },
    async cleanup() {
      for (const mounted of mounts.reverse()) mounted.unmount()
      for (const cleanup of effects.reverse()) cleanup()
      await flushTasks()
    },
  }
}

test('浏览器端始终挂 common.css，且只挂当前 AIC 皮肤而不预载 Agent CSS', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let entry = null
  const connected = []
  const makeElement = (tag) => {
    const listeners = new Map()
    const element = {
      tagName: String(tag).toUpperCase(), dataset: {}, style: {}, className: '', id: '',
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = String(value) },
      addEventListener(type, callback) {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type).add(callback)
      },
      removeEventListener(type, callback) { listeners.get(type)?.delete(callback) },
      emit(type) { for (const callback of [...(listeners.get(type) ?? [])]) callback() },
      querySelector: () => null,
      remove() {
        const index = connected.indexOf(element)
        if (index >= 0) connected.splice(index, 1)
      },
    }
    return element
  }
  const append = (element) => { if (!connected.includes(element)) connected.push(element) }
  const documentElementStyle = { background: '' }
  const document = {
    head: { appendChild: append },
    body: { dataset: {}, appendChild: append, prepend: append,
      style: { setProperty() {}, removeProperty() {} } },
    documentElement: { style: documentElementStyle, clientWidth: 1280 },
    createElement: makeElement,
    getElementById: (id) => connected.find((element) => element.id === id) ?? null,
  }
  const window = { __ModuleLoader__: { load: (value) => { entry = value } } }
  vm.runInNewContext(source, { window, document, console, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener() {}, removeEventListener() {}, Element: class {} })
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
  const ctx = {
    effect: (operation) => {
      const cleanup = operation()
      if (typeof cleanup === 'function') effects.push(cleanup)
      return cleanup ?? (() => {})
    },
    slots: {
      inject: (_key, callback) => {
        const cleanup = callback()
        return typeof cleanup === 'function' ? cleanup : () => {}
      },
      register: () => () => {},
    },
    connection: { rpc: { call: async (_path, endpoint) => ({ ok: true,
      value: endpoint === 'status' ? { config: { uiSkin: 'endfield-aic' } } : {} }) } },
    theme: { overrideTokens: () => () => {} },
    sessions: { open() {}, async create() { return 'session' } },
  }
  plugin.apply(ctx)
  await new Promise((resolve) => { setImmediate(resolve) })
  const common = connected.find((element) => element.tagName === 'LINK'
    && element.href.endsWith('/common.css'))
  assert.ok(common)
  common.emit('load')
  await flushTasks()
  const links = connected.filter((element) => element.tagName === 'LINK')
  assert.deepEqual(links.map((link) => link.href).sort(), [
    '/prts-corpus/skins/common.css',
    '/prts-corpus/skins/endfield-aic.css',
  ])
  assert.equal(links.some((link) => link.href.endsWith('/prts-agent.css')), false)
  links.find((link) => link.href.endsWith('/endfield-aic.css'))?.emit('load')
  await flushTasks()

  for (const cleanup of effects.reverse()) cleanup()
  assert.equal(connected.some((element) => element.tagName === 'LINK'), false)
})

test('common.css 失败会关闭式阻止皮肤提交，并允许下一次切换重试', async () => {
  const harness = await createBrowserSkinHarness({ autoLoadCommon: false })
  try {
    const switching = harness.plugin.__skinStateForTest.setSkin('endfield-aic')
    const failedCommon = harness.link('/common.css')
    assert.ok(failedCommon)
    failedCommon.emit('error')
    await assert.rejects(switching, /公共皮肤样式加载失败/)
    assert.equal(harness.plugin.__skinStateForTest.getActiveSkin(), 'harness')
    assert.equal(harness.document.body.dataset.prtsSkin, undefined)
    assert.equal(harness.storageWrites.length, 0)
    assert.equal(harness.tokenOverrides.length, 0)
    assert.ok(harness.connected.some((element) => element.tagName === 'STYLE'
      && element.dataset.pluginCss === 'common-safety'),
    'common.css 缺失时最小安全规则必须继续隐藏证据层')

    const retry = harness.plugin.__skinStateForTest.setSkin('endfield-aic')
    const retryCommon = harness.link('/common.css')
    assert.ok(retryCommon)
    assert.notEqual(retryCommon, failedCommon)
    retryCommon.emit('load')
    await flushTasks()
    const aic = harness.link('/endfield-aic.css')
    assert.ok(aic)
    aic.emit('load')
    assert.equal(await retry, 'endfield-aic')
    assert.equal(harness.document.body.dataset.prtsSkin, 'endfield-aic')
    assert.equal(harness.connected.some((element) => element.tagName === 'STYLE'
      && element.dataset.pluginCss === 'common-safety'), false)
  } finally {
    await harness.cleanup()
  }
})

test('皮肤 CSS 加载失败时不提交 dataset、token 或启动缓存', async () => {
  const harness = await createBrowserSkinHarness()
  try {
    const writesBefore = harness.storageWrites.length
    const switching = harness.plugin.__skinStateForTest.setSkin('endfield-aic')
    await flushTasks()
    const candidate = harness.link('/endfield-aic.css')
    assert.ok(candidate, '切肤应创建候选 stylesheet')
    assert.equal(harness.plugin.__skinStateForTest.getActiveSkin(), 'harness')
    assert.equal(harness.document.body.dataset.prtsSkin, undefined)
    assert.equal(harness.tokenOverrides.length, 0)
    assert.equal(harness.storageWrites.length, writesBefore)

    candidate.emit('error')
    await assert.rejects(switching, /皮肤样式加载失败/)
    assert.equal(harness.plugin.__skinStateForTest.getActiveSkin(), 'harness')
    assert.equal(harness.document.body.dataset.prtsSkin, undefined)
    assert.equal(harness.tokenOverrides.length, 0)
    assert.equal(harness.storageWrites.length, writesBefore,
      '无 stylesheet 的皮肤不得写入启动缓存')
    assert.equal(harness.link('/endfield-aic.css'), undefined)
    assert.ok(harness.link('/common.css'), 'common.css 应常驻')
  } finally {
    await harness.cleanup()
  }
})

test('快速切肤会作废旧候选，只提交最后成功加载的 stylesheet', async () => {
  const harness = await createBrowserSkinHarness()
  try {
    const firstSwitch = harness.plugin.__skinStateForTest.setSkin('prts-agent')
    const firstResult = firstSwitch.catch((error) => error)
    // Deliberately do not yield between calls: an already-ready common.css still
    // makes prepare() cross a microtask boundary.
    const finalSwitch = harness.plugin.__skinStateForTest.setSkin('endfield-aic')
    await flushTasks()
    const finalLink = harness.link('/endfield-aic.css')
    assert.ok(finalLink)
    const staleError = await firstResult
    assert.equal(staleError.name, 'AbortError')
    assert.equal(harness.link('/prts-agent.css'), undefined)

    finalLink.emit('load')
    assert.equal(await finalSwitch, 'endfield-aic')
    assert.equal(harness.plugin.__skinStateForTest.getActiveSkin(), 'endfield-aic')
    assert.equal(harness.document.body.dataset.prtsSkin, 'endfield-aic')
    assert.equal(harness.storage.get('prts.uiSkin'), 'endfield-aic')
    assert.equal(harness.tokenOverrides.length, 1)
    assert.ok(harness.link('/endfield-aic.css'))
    assert.equal(harness.link('/prts-agent.css'), undefined)
    assert.deepEqual(harness.connected.filter((element) => element.tagName === 'LINK')
      .map((element) => element.href).sort(), [
      '/prts-corpus/skins/common.css', '/prts-corpus/skins/endfield-aic.css',
    ], 'back-to-back 切换后不能遗留孤儿 stylesheet')
  } finally {
    await harness.cleanup()
  }
})

test('stylesheet 就绪后的运行时提交失败会回滚并保留旧皮肤', async () => {
  const harness = await createBrowserSkinHarness({
    themeOverride: (_sourceId, _tokens, callCount) => {
      if (callCount === 2) throw new Error('token commit failed')
      return () => {}
    },
  })
  try {
    const initialSwitch = harness.plugin.__skinStateForTest.setSkin('endfield-aic')
    await flushTasks()
    harness.link('/endfield-aic.css').emit('load')
    await initialSwitch
    const writesBefore = harness.storageWrites.length
    const committedLink = harness.link('/endfield-aic.css')

    const failedSwitch = harness.plugin.__skinStateForTest.setSkin('prts-agent')
    await flushTasks()
    const candidate = harness.link('/prts-agent.css')
    assert.ok(candidate)
    candidate.emit('load')
    await assert.rejects(failedSwitch, /token commit failed/)

    assert.equal(harness.plugin.__skinStateForTest.getActiveSkin(), 'endfield-aic')
    assert.equal(harness.document.body.dataset.prtsSkin, 'endfield-aic')
    assert.equal(harness.storageWrites.length, writesBefore)
    assert.equal(harness.storage.get('prts.uiSkin'), 'endfield-aic')
    assert.equal(harness.link('/endfield-aic.css'), committedLink)
    assert.equal(harness.link('/prts-agent.css'), undefined)
    assert.equal(harness.tokenOverrides.length, 3,
      '失败的新 token 后必须重新覆盖回旧 token')
  } finally {
    await harness.cleanup()
  }
})

test('Host 配置写入失败时旧 stylesheet 原地保留且不写启动缓存', async () => {
  const harness = await createBrowserSkinHarness()
  try {
    const initialSwitch = harness.plugin.__skinStateForTest.setSkin('endfield-aic')
    await flushTasks()
    harness.link('/endfield-aic.css').emit('load')
    await initialSwitch
    const committedLink = harness.link('/endfield-aic.css')
    const writesBefore = harness.storageWrites.length
    const tokensBefore = harness.tokenOverrides.length

    const failedSwitch = harness.plugin.__skinStateForTest.setSkin('harness', {
      beforeCommit: async () => { throw new Error('host config rejected') },
    })
    await assert.rejects(failedSwitch, /host config rejected/)
    assert.equal(harness.plugin.__skinStateForTest.getActiveSkin(), 'endfield-aic')
    assert.equal(harness.document.body.dataset.prtsSkin, 'endfield-aic')
    assert.equal(harness.link('/endfield-aic.css'), committedLink,
      'Host 拒绝时不得移除再重新下载旧 stylesheet')
    assert.equal(harness.storageWrites.length, writesBefore)
    assert.equal(harness.tokenOverrides.length, tokensBefore,
      'Host 提交屏障失败前不得预先更换本地 token')
  } finally {
    await harness.cleanup()
  }
})

test('Host 皮肤配置写入有 deadline，悬挂 RPC 不会永久占住事务', async () => {
  const never = new Promise(() => {})
  let writeSignal = null
  const harness = await createBrowserSkinHarness({
    manualTimeouts: true,
    rpcCall: async (_path, endpoint, _payload, signal) => {
      if (endpoint === 'config.update') {
        writeSignal = signal
        return never
      }
      return { ok: true, value: endpoint === 'status' ? { config: { uiSkin: 'harness' } } : {} }
    },
  })
  try {
    const writing = harness.plugin.__skinStateForTest.writeSkinConfig('endfield-aic')
    const deadline = harness.timers.find((timer) => timer.delay === 10000 && !timer.cleared)
    assert.ok(deadline, 'Host config PUT 必须有 10 秒 deadline')
    deadline.callback()
    await assert.rejects(writing, /皮肤配置写入超时/)
    assert.equal(writeSignal?.aborted, true,
      'deadline 必须中止底层 RPC，而不是只放弃等待响应')
  } finally {
    await harness.cleanup()
  }
})

test('设置页以已提交皮肤初始化，显式点击当前项仍会确认 Host 并压过迟到启动快照', async () => {
  const startupStatus = deferred()
  const configWrites = []
  const harness = await createBrowserSkinHarness({
    rpcCall: async (_path, endpoint, payload) => {
      if (endpoint === 'status') return startupStatus.promise
      if (endpoint === 'config.update') {
        configWrites.push(payload)
        return { ok: true, value: { config: payload.patch } }
      }
      return { ok: true, value: {} }
    },
  })
  try {
    const switching = harness.plugin.__skinStateForTest.setSkin('endfield-aic')
    await flushTasks()
    harness.link('/endfield-aic.css').emit('load')
    await switching
    const section = harness.mount(harness.plugin.__skinStateForTest.PrtsSection)
    const initializedCard = section.find((node) => node.type
      === harness.plugin.__skinStateForTest.SkinCard)
    assert.equal(initializedCard?.props.skin, 'endfield-aic',
      '设置页不能把已运行的 AIC 暂时伪装成 Harness')
    section.unmount()

    await harness.plugin.__skinStateForTest.setSkin('harness')
    const selected = []
    const card = harness.mount(harness.plugin.__skinStateForTest.SkinCard,
      { skin: 'harness', onChanged: (skin) => { selected.push(skin) } })
    const harnessButton = card.find((node) => node.type === 'button'
      && node.children?.[0]?.children?.includes('Harness 默认'))
    assert.ok(harnessButton)
    harnessButton.props.onClick()
    await flushTasks()
    assert.equal(configWrites.at(-1)?.patch?.uiSkin, 'harness',
      '即使当前渲染项相同，明确点击也必须写回 Host')
    assert.deepEqual(selected, ['harness'])

    startupStatus.resolve({ ok: true,
      value: { config: { uiSkin: 'endfield-aic' } } })
    await flushTasks()
    assert.equal(harness.plugin.__skinStateForTest.getActiveSkin(), 'harness')
    assert.equal(harness.link('/endfield-aic.css'), undefined,
      '用户选择开始前发出的启动快照不得重新覆盖界面')
  } finally {
    await harness.cleanup()
  }
})

test('启动 AIC 等待 CSS 时点击当前 Harness，会立即撤下失效 boot owner', async () => {
  const originalBackground = 'rgb(21, 22, 23)'
  const configWrites = []
  const harness = await createBrowserSkinHarness({
    manualTimeouts: true, manualIntervals: true,
    initialDocumentBackground: originalBackground,
    rpcCall: async (_path, endpoint, payload) => {
      if (endpoint === 'status') return { ok: true,
        value: { config: { uiSkin: 'endfield-aic' } } }
      if (endpoint === 'config.update') {
        configWrites.push(payload)
        return { ok: true, value: {} }
      }
      return { ok: true, value: {} }
    },
  })
  try {
    await flushTasks()
    assert.ok(harness.link('/endfield-aic.css'), '启动 AIC 应正在等待候选 CSS')
    assert.equal(harness.plugin.__skinStateForTest.getActiveSkin(), 'harness')
    assert.equal(harness.document.documentElement.style.background, '#0b0d10')
    assert.ok(harness.connected.some((element) => element.className === 'aic-boot'))

    const card = harness.mount(harness.plugin.__skinStateForTest.SkinCard,
      { skin: 'harness', onChanged: () => {} })
    const harnessButton = card.find((node) => node.type === 'button'
      && node.children?.[0]?.children?.includes('Harness 默认'))
    harnessButton.props.onClick()
    await flushTasks()

    assert.equal(configWrites.at(-1)?.patch?.uiSkin, 'harness')
    assert.equal(harness.plugin.__skinStateForTest.getActiveSkin(), 'harness')
    assert.equal(harness.link('/endfield-aic.css'), undefined)
    assert.equal(harness.connected.some((element) => element.className === 'aic-boot'), false,
      '失效启动快照的遮罩不得等待 30 秒 watchdog')
    assert.equal(harness.document.getElementById('aic-boot-style'), null)
    assert.equal(harness.document.documentElement.style.background, originalBackground)
  } finally {
    await harness.cleanup()
  }
})

test('完整刷新与轮询共享 Host 代次，迟到的旧 status/release 不回写任何界面状态', async () => {
  const startupStatus = deferred()
  const oldReleases = deferred()
  let statusCalls = 0
  const harness = await createBrowserSkinHarness({
    manualIntervals: true,
    rpcCall: async (_path, endpoint) => {
      if (endpoint === 'status') {
        statusCalls += 1
        if (statusCalls === 1) return startupStatus.promise
        if (statusCalls === 2) return { ok: true,
          value: { marker: 'old', config: { uiSkin: 'prts-agent' } } }
        return { ok: true,
          value: { marker: 'new', config: { uiSkin: 'endfield-aic' } } }
      }
      if (endpoint === 'releases') return oldReleases.promise
      return { ok: true, value: {} }
    },
  })
  try {
    const section = harness.mount(harness.plugin.__skinStateForTest.PrtsSection)
    await flushTasks()
    const poll = harness.intervals.find((interval) => interval.delay === 2000)
    assert.ok(poll)
    poll.callback()
    await flushTasks()
    const aic = harness.link('/endfield-aic.css')
    assert.ok(aic)
    aic.emit('load')
    await flushTasks()

    let dataset = section.find((node) => node.type?.name === 'DatasetLibraryCard')
    let skinCard = section.find((node) => node.type
      === harness.plugin.__skinStateForTest.SkinCard)
    assert.equal(dataset?.props.status?.marker, 'new')
    assert.equal(skinCard?.props.skin, 'endfield-aic')

    oldReleases.resolve({ ok: true, value: { releases: [{ id: 'stale-release' }] } })
    startupStatus.resolve({ ok: true,
      value: { marker: 'startup-old', config: { uiSkin: 'prts-agent' } } })
    await flushTasks()
    dataset = section.find((node) => node.type?.name === 'DatasetLibraryCard')
    skinCard = section.find((node) => node.type
      === harness.plugin.__skinStateForTest.SkinCard)
    assert.equal(dataset?.props.status?.marker, 'new', '旧 status 不得回写')
    assert.equal(dataset?.props.releases?.length, 0, '与旧 status 同批的 releases 也不得回写')
    assert.equal(skinCard?.props.skin, 'endfield-aic')
    assert.equal(harness.link('/prts-agent.css'), undefined)
  } finally {
    await harness.cleanup()
  }
})

test('完整刷新同值时修复 runtime，轮询同值时不重复提交', async () => {
  const startupStatus = deferred()
  let statusCalls = 0
  const harness = await createBrowserSkinHarness({
    manualIntervals: true,
    rpcCall: async (_path, endpoint) => {
      if (endpoint === 'status') {
        statusCalls += 1
        if (statusCalls === 1) return startupStatus.promise
        return { ok: true, value: { marker: statusCalls === 2 ? 'refresh' : 'poll',
          config: { uiSkin: 'harness' } } }
      }
      if (endpoint === 'releases') return { ok: true, value: { releases: [] } }
      return { ok: true, value: {} }
    },
  })
  try {
    const section = harness.mount(harness.plugin.__skinStateForTest.PrtsSection)
    await flushTasks()
    assert.equal(harness.storageWrites.filter(([key, value]) =>
      key === 'prts.uiSkin' && value === 'harness').length, 1,
    '完整刷新即使同值也应通过 setSkin 修复并确认 runtime')

    harness.intervals.find((interval) => interval.delay === 2000).callback()
    await flushTasks()
    assert.equal(harness.storageWrites.filter(([key, value]) =>
      key === 'prts.uiSkin' && value === 'harness').length, 1,
    '高频轮询同值时不得重复提交')
    const dataset = section.find((node) => node.type?.name === 'DatasetLibraryCard')
    assert.equal(dataset?.props.status?.marker, 'poll')
  } finally {
    await harness.cleanup()
  }
})

test('Host 快照在 stylesheet 等待期间失效时，setSkin 二次校验阻止旧提交', async () => {
  const startupStatus = deferred()
  let statusCalls = 0
  const harness = await createBrowserSkinHarness({
    manualIntervals: true,
    rpcCall: async (_path, endpoint) => {
      if (endpoint === 'status') {
        statusCalls += 1
        if (statusCalls === 1) return startupStatus.promise
        if (statusCalls === 2) return { ok: true,
          value: { marker: 'old-loading', config: { uiSkin: 'endfield-aic' } } }
        return { ok: true,
          value: { marker: 'new-harness', config: { uiSkin: 'harness' } } }
      }
      if (endpoint === 'releases') return { ok: true, value: { releases: [] } }
      return { ok: true, value: {} }
    },
  })
  try {
    const section = harness.mount(harness.plugin.__skinStateForTest.PrtsSection)
    await flushTasks()
    const staleAic = harness.link('/endfield-aic.css')
    assert.ok(staleAic, '旧完整刷新应已进入 stylesheet prepare 阶段')

    harness.intervals.find((interval) => interval.delay === 2000).callback()
    await flushTasks()
    staleAic.emit('load')
    await flushTasks()

    const dataset = section.find((node) => node.type?.name === 'DatasetLibraryCard')
    const skinCard = section.find((node) => node.type
      === harness.plugin.__skinStateForTest.SkinCard)
    assert.equal(dataset?.props.status?.marker, 'new-harness')
    assert.equal(skinCard?.props.skin, 'harness')
    assert.equal(harness.plugin.__skinStateForTest.getActiveSkin(), 'harness')
    assert.equal(harness.link('/endfield-aic.css'), undefined,
      '旧候选就绪后必须回滚，不能借迟到 load 事件提交')
  } finally {
    startupStatus.resolve({ ok: true, value: { config: { uiSkin: 'harness' } } })
    await harness.cleanup()
  }
})

test('AIC boot 完成后裸 setSkin 离开会精确恢复进入前的根节点 inline background', async () => {
  const originalBackground = 'rgb(12, 34, 56)'
  const harness = await createBrowserSkinHarness({
    manualTimeouts: true, manualIntervals: true, initialDocumentBackground: originalBackground,
    rpcCall: async (_path, endpoint) => ({ ok: true,
      value: endpoint === 'status' ? { config: { uiSkin: 'endfield-aic' } } : {} }),
  })
  try {
    await flushTasks()
    harness.link('/endfield-aic.css').emit('load')
    await flushTasks()
    assert.equal(harness.plugin.__skinStateForTest.getActiveSkin(), 'endfield-aic')
    assert.equal(harness.document.documentElement.style.background, '#0b0d10')

    harness.plugin.__skinStateForTest.finishAicBoot()
    harness.timers.find((timer) => timer.delay === 260 && !timer.cleared).callback()
    harness.timers.find((timer) => timer.delay === 900 && !timer.cleared).callback()
    assert.equal(harness.document.documentElement.style.background, '#0b0d10',
      'AIC 活跃期间 boot 完成后仍应保留黑色根背景')

    await harness.plugin.__skinStateForTest.setSkin('harness')
    assert.equal(harness.document.documentElement.style.background, originalBackground)
  } finally {
    await harness.cleanup()
  }
})

test('重叠 apply 会退役旧 owner，旧事务不能借新 context 提交', async () => {
  const harness = await createBrowserSkinHarness()
  try {
    const initial = harness.plugin.__skinStateForTest.setSkin('endfield-aic')
    await flushTasks()
    harness.link('/endfield-aic.css').emit('load')
    await initial
    const oldCommon = harness.link('/common.css')
    const oldCommitted = harness.link('/endfield-aic.css')
    const oldEffectCount = harness.effects.length
    assert.equal(harness.plugin.__skinStateForTest.getActiveSkin(), 'endfield-aic')

    let enterBarrier
    let releaseBarrier
    const entered = new Promise((resolve) => { enterBarrier = resolve })
    const barrier = new Promise((resolve) => { releaseBarrier = resolve })
    const staleSwitch = harness.plugin.__skinStateForTest.setSkin('prts-agent', {
      beforeCommit: async () => { enterBarrier(); await barrier },
    })
    const staleResult = staleSwitch.catch((error) => error)
    await flushTasks()
    const oldCandidate = harness.link('/prts-agent.css')
    oldCandidate.emit('load')
    await entered

    // Simulate Cordis installing the replacement before invoking old cleanups.
    const ctx2 = harness.createContext({ owner: 'ctx2', contextRpcCall: async (_path, endpoint) => ({
      ok: true, value: endpoint === 'status' ? { config: { uiSkin: 'endfield-aic' } } : {},
    }) })
    harness.plugin.apply(ctx2)
    assert.deepEqual(harness.tokenDisposalOwners, ['ctx1'],
      '旧 theme token 必须在覆盖 context 前卸载')
    assert.deepEqual(harness.slotDisposals.filter((entry) => entry.id === 'prts-aic-shell'),
      [{ owner: 'ctx1', id: 'prts-aic-shell' }],
      '旧 AIC shell injection 必须在覆盖 context 前卸载')
    assert.equal(harness.plugin.__skinStateForTest.getActiveSkin(), 'harness')
    assert.equal(harness.document.body.dataset.prtsSkin, undefined)
    assert.equal(harness.connected.includes(oldCommon), false)
    assert.equal(harness.connected.includes(oldCommitted), false)
    assert.equal(harness.connected.includes(oldCandidate), false)
    const replacementCommon = harness.link('/common.css')
    assert.ok(replacementCommon)
    assert.notEqual(replacementCommon, oldCommon)

    releaseBarrier()
    const staleError = await staleResult
    assert.equal(staleError.name, 'AbortError')
    replacementCommon.emit('load')
    await flushTasks()
    const replacementAic = harness.link('/endfield-aic.css')
    assert.ok(replacementAic)
    replacementAic.emit('load')
    await flushTasks()
    assert.equal(harness.plugin.__skinStateForTest.getActiveSkin(), 'endfield-aic')
    assert.equal(harness.link('/prts-agent.css'), undefined)
    assert.deepEqual(harness.tokenOwners, ['ctx1', 'ctx2'])
    assert.ok(harness.slotRegistrations.some((entry) =>
      entry.owner === 'ctx2' && entry.id === 'prts-aic-shell'))
    assert.deepEqual(harness.connected.filter((element) => element.tagName === 'LINK')
      .map((element) => element.href).sort(), [
      '/prts-corpus/skins/common.css', '/prts-corpus/skins/endfield-aic.css',
    ])

    // The first fiber's cleanup may arrive after ctx2 has fully committed.
    // It must be idempotent/owner-checked and leave ctx2 resources untouched.
    const oldEffects = harness.effects.splice(0, oldEffectCount)
    for (const cleanup of oldEffects.reverse()) cleanup()
    await flushTasks()
    assert.equal(harness.plugin.__skinStateForTest.getActiveSkin(), 'endfield-aic')
    assert.equal(harness.link('/common.css'), replacementCommon)
    assert.equal(harness.link('/endfield-aic.css'), replacementAic)
    assert.equal(harness.tokenDisposalOwners.includes('ctx2'), false)
    assert.equal(harness.slotDisposals.some((entry) =>
      entry.owner === 'ctx2' && entry.id === 'prts-aic-shell'), false)
  } finally {
    await harness.cleanup()
  }
})

test('皮肤 stylesheet 超时与 error 一样回滚候选且不持久化', async () => {
  const harness = await createBrowserSkinHarness({ manualTimeouts: true })
  try {
    const writesBefore = harness.storageWrites.length
    const switching = harness.plugin.__skinStateForTest.setSkin('prts-agent')
    await flushTasks()
    const timeout = harness.timers.find((timer) => timer.delay === 8000 && !timer.cleared)
    assert.ok(timeout, '候选 stylesheet 必须有加载 deadline')
    timeout.callback()
    await assert.rejects(switching, /皮肤样式加载超时/)
    assert.equal(harness.plugin.__skinStateForTest.getActiveSkin(), 'harness')
    assert.equal(harness.document.body.dataset.prtsSkin, undefined)
    assert.equal(harness.storageWrites.length, writesBefore)
    assert.equal(harness.link('/prts-agent.css'), undefined)
  } finally {
    await harness.cleanup()
  }
})
