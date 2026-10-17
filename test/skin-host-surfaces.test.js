import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const hostDir = process.env.PRTS_DSH_SOURCE_DIR ? resolve(process.env.PRTS_DSH_SOURCE_DIR) : null
const playwrightModule = process.env.PRTS_PLAYWRIGHT_MODULE
const SKINS = ['harness', 'prts-agent', 'endfield-aic', 'rhine-lab']

/** In-page measurement helpers: WCAG contrast over the real composited backdrop, borders and boxes. */
const PROBE = `
window.__skinProbe = (() => {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  const toRgba = value => {
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = 'rgba(0, 0, 0, 0)'
    context.fillStyle = value
    context.fillRect(0, 0, 1, 1)
    const data = context.getImageData(0, 0, 1, 1).data
    return { r: data[0], g: data[1], b: data[2], a: data[3] / 255 }
  }
  const composite = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  })
  const backdrop = element => {
    const layers = []
    for (let node = element; node !== null; node = node.parentElement) {
      const layer = toRgba(getComputedStyle(node).backgroundColor)
      if (layer.a > 0) {
        layers.push(layer)
        if (layer.a >= 1) break
      }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 }
    for (let index = layers.length - 1; index >= 0; index -= 1) base = composite(layers[index], base)
    return base
  }
  const luminance = color => {
    const linear = value => {
      const channel = value / 255
      return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
  }
  const css = color => 'rgb(' + Math.round(color.r) + ', ' + Math.round(color.g) + ', ' + Math.round(color.b) + ')'
  return {
    contrast(element) {
      const style = getComputedStyle(element)
      const background = backdrop(element)
      const effective = composite(toRgba(style.color), background)
      const first = luminance(effective)
      const second = luminance(background)
      return {
        ratio: (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05),
        color: style.color,
        background: style.backgroundColor,
        backdrop: css(background),
      }
    },
    border(element) {
      const style = getComputedStyle(element)
      return {
        width: Number.parseFloat(style.borderTopWidth),
        style: style.borderTopStyle,
        color: style.borderTopColor,
        alpha: toRgba(style.borderTopColor).a,
      }
    },
    box(element) {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom }
    },
  }
})()
`

/** Two frames are enough for the Host's MutationObserver/rAF layout repair and skin scenes to settle. */
const settle = page => page.evaluate(
  () => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))),
)

const documentWidth = page => page.evaluate(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  innerWidth: window.innerWidth,
}))

const readInventory = page => page.evaluate(() => {
  const section = document.querySelector('[data-slot="settings.section"]')
  const entries = section === null ? [] : Array.from(section.querySelectorAll('[data-plugin-entry]'))
  const first = entries[0]
  const title = first === undefined ? null : first.querySelector('strong')
  const preset = document.querySelector('[data-plugin-scope="preset"]')
  const globalGroup = document.querySelector('[data-plugin-scope="global"]')
  const groupTitle = preset === null ? null : preset.querySelector('button[aria-expanded] > span')
  const globalTitle = globalGroup === null ? null : globalGroup.querySelector('button[aria-expanded] > span')
  const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
  return {
    count: entries.length,
    scopes: Array.from(document.querySelectorAll('[data-slot="settings.section"] [data-plugin-scope]'))
      .map(node => node.getAttribute('data-plugin-scope')),
    title: title === null ? null : window.__skinProbe.contrast(title),
    groupTitle: groupTitle === null ? null : window.__skinProbe.contrast(groupTitle),
    globalTitle: globalTitle === null ? null : window.__skinProbe.contrast(globalTitle),
    border: first === undefined ? null : window.__skinProbe.border(first),
    box: first === undefined ? null : window.__skinProbe.box(first),
    overflow: first === undefined ? null : { scrollWidth: first.scrollWidth, clientWidth: first.clientWidth },
    dialog: dialog === null ? null : window.__skinProbe.box(dialog),
    details: section === null ? 0 : section.querySelectorAll('[data-loader-entry]').length,
  }
})

const readToast = page => page.evaluate(() => {
  const toast = document.querySelector('body > div[role="alert"]')
  if (toast === null) return null
  const style = getComputedStyle(toast)
  return {
    parentIsBody: toast.parentElement === document.body,
    text: toast.textContent,
    zIndex: style.zIndex,
    opacity: style.opacity,
    visibility: style.visibility,
    animation: style.animationName + ' ' + style.animationDuration + ' ' + style.animationDelay + ' ' + style.animationFillMode,
    animations: toast.getAnimations().map(animation => ({
      state: animation.playState,
      time: animation.currentTime,
      delay: animation.effect.getTiming().delay,
    })),
    contrast: window.__skinProbe.contrast(toast),
    box: window.__skinProbe.box(toast),
  }
})

const readTabs = page => page.evaluate(() => {
  const panel = document.querySelector('[data-plugin-panel]')
  const list = document.querySelector('[role="tablist"]')
  const firstTab = list === null ? null : list.querySelector('[role="tab"]')
  return {
    hasPanel: panel !== null,
    hasTablist: list !== null,
    tabCount: list === null ? 0 : list.querySelectorAll('[role="tab"]').length,
    firstTabText: firstTab === null ? null : firstTab.textContent,
    insidePanel: panel !== null && list !== null && panel.contains(list),
    contrast: firstTab === null ? null : window.__skinProbe.contrast(firstTab),
    panel: panel === null ? null : window.__skinProbe.box(panel),
    list: list === null ? null : window.__skinProbe.box(list),
  }
})

function assertContrast(label, measured, minimum = 3) {
  assert.ok(measured !== null && Number.isFinite(measured.ratio), `${label}: contrast is measurable`)
  assert.ok(
    measured.ratio >= minimum,
    `${label}: contrast ${measured.ratio.toFixed(2)} must be >= ${minimum} (color ${measured.color} on ${measured.backdrop})`,
  )
}

test('all skins keep DSH 0.2.1 host surfaces (plugin inventory, toast, plugin tabs) readable and unclipped', {
  skip: !hostDir || !playwrightModule ? 'Set PRTS_DSH_SOURCE_DIR and PRTS_PLAYWRIGHT_MODULE' : false,
}, async (t) => {
  const hostRequire = createRequire(resolve(hostDir, 'package.json'))
  const webRequire = createRequire(resolve(hostDir, 'apps/web/package.json'))
  const { build } = createRequire(hostRequire.resolve('tsx/package.json'))('esbuild')
  // Real 0.2.1 host components (settings shell, inventory section, toast, plugin manager)
  // rendered against an in-memory inventory. No npm installs, accounts or Agent requests.
  const { outputFiles } = await build({
    absWorkingDir: hostDir, bundle: true, write: false, outdir: '/tmp/prts-skin-host-surfaces',
    format: 'iife', platform: 'browser', jsx: 'automatic',
    tsconfig: resolve(hostDir, 'tsconfig.base.json'), nodePaths: [resolve(hostDir, 'node_modules')],
    // DSH 0.2.1's plugin manager imports SVG artwork directly.
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl' },
    // Keep the real atoms while excluding unrelated barrel side effects.
    plugins: [{ name: 'host-surface-atoms', setup(builder) {
      builder.onLoad({ filter: /ui-settings-general\/src\/client\/SettingsRoot\.tsx$/ }, async args => ({
        contents: (await readFile(args.path, 'utf8')) + '\nexport { SettingsPanel }', loader: 'tsx',
        resolveDir: resolve(hostDir, 'packages/client/ui-settings-general/src/client'),
      }))
      builder.onLoad({ filter: /ui-primitives\/src\/index\.ts$/ }, () => ({
        contents: ['Button.tsx', 'Input.tsx', 'Modal.tsx', 'StateDot.tsx', 'Switch.tsx', 'Tag.tsx',
          'TerminalBlock.tsx', 'Toast.tsx', 'useAnchoredPosition.ts', 'useDismissOnOutsidePointer.ts',
          'useModalLayer.ts', 'ConnectionIndicator.tsx', 'Tooltip.tsx', 'FishLogo.tsx',
          'Menu.tsx', 'SegmentedTabs.tsx', 'input-modality.ts',
          'icons/index.tsx', 'plugin-artwork.tsx'].map(file => `export * from './${file}'`).join('\n'),
        resolveDir: resolve(hostDir, 'packages/client/ui-primitives/src'), loader: 'ts',
      }))
    } }],
    alias: { react: webRequire.resolve('react'), 'react-dom': webRequire.resolve('react-dom'),
      'react-dom/client': webRequire.resolve('react-dom/client'),
      'react/jsx-runtime': webRequire.resolve('react/jsx-runtime') },
    define: { 'process.env.NODE_ENV': '"production"' },
    stdin: { resolveDir: hostDir, loader: 'tsx', contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { PluginManagerPage } from './packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx';
      import { zh as managerZh } from './packages/client/ui-plugin-manager/src/client/locales.ts';
      import { PluginInventorySettingsTab } from './packages/client/ui-settings-plugin-inventory/src/client/PluginInventorySettingsTab.tsx';
      import { zh as inventoryZh } from './packages/client/ui-settings-plugin-inventory/src/client/locales.ts';
      import { Toast } from './packages/client/ui-primitives/src/Toast.tsx';
      import { SettingsPanel } from './packages/client/ui-settings-general/src/client/SettingsRoot.tsx';
      import frameCss from './packages/client/ui-layout/src/client/AppFrame.module.css';
      import './packages/client/ui-theme/src/styles/design-platform.css';
      import './packages/client/ui-theme/src/styles/base.css';
      window.fixtureReact = React;
      const noop = () => {};
      const textOf = text => typeof text === 'string' ? text : text?.['zh-CN'] || '';
      const translator = dictionary => (key, params = {}) => Object.entries(params)
        .reduce((text, [name, value]) => text.replaceAll('{' + name + '}', value), dictionary[key] || key);
      const managerT = translator(managerZh);
      const inventoryT = translator(inventoryZh);
      // The slot renderer binds every hooks.<name> observable to a use<Name> selector hook;
      // mirror that contract so the real section renders outside the renderer.
      const bindInject = face => {
        const { hooks, ...rest } = face;
        const bound = { ...rest };
        for (const [name, source] of Object.entries(hooks || {})) {
          bound['use' + name.charAt(0).toUpperCase() + name.slice(1)] =
            selector => selector(React.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot));
        }
        return bound;
      };
      // Stable observable and list identity: the section refetches when list changes.
      const clientSyncState = { syncing: false, failures: [] };
      const clientSync = { getSnapshot: () => clientSyncState, subscribe: () => () => {} };
      const inventorySnapshot = {
        entries: [
          { entryId: 'demo-entry', moduleName: '@prts/dsh-demo-plugin', enabled: true, fiberPhase: 'active',
            meta: { title: '演示插件', description: '用于验证宿主界面的本地演示插件。' } },
          { entryId: 'broken-entry', moduleName: 'cordis:demo-broken', enabled: false, fiberPhase: 'failed',
            meta: { error: 'manifest unreadable' } },
        ],
        agentPresets: [{
          id: 'standard', name: '标准模式', isDefault: true,
          rows: [
            { entryId: 'demo-row', moduleName: '@prts/dsh-demo-row', enabled: true, fiberPhase: 'active',
              meta: { title: '预设插件甲', description: '由默认预设按会话提供的插件。' } },
            { entryId: 'win-row', moduleName: '@prts/dsh-win-only', enabled: 'conditional', fiberPhase: null,
              condition: "process.platform === 'win32'", meta: { title: '预设插件乙' } },
          ],
        }],
      };
      const listInventory = async () => inventorySnapshot;
      const presetName = preset => preset.name ?? preset.id;
      const install = { open:false, spec:'', phase:'idle', inputError:null, subject:null, runs:[], detailsOpen:false,
        registries:null, registry:{kind:'offered',registry:null}, registryOpen:false, registryError:false, attempts:null,
        installed:null, restartRequired:false, failure:null, approvedBuilds:[], enabling:false };
      function App() {
        const [surface, setSurface] = useState('inventory');
        const [toast, setToast] = useState(false);
        const [narrow, setNarrow] = useState(false);
        const [tab, setTab] = useState('installed');
        const [view, setView] = useState({ kind: 'list' });
        const [state] = useState({ status:'ready', busy:[], notice:null, confirm:null, highlight:null, install,
          packages:[{ name:'prts-terrarchive', version:'0.2.0', installed:true, optional:false, enabled:true,
            meta:{description:'本地与云端资料检索、原文阅读和莱茵生命资料馆'},
            rows:[{ rowId:'prts', entryId:'prts', moduleName:'prts-terrarchive', enabled:true, phase:'active' }] }] });
        window.fixture = { setSurface, setToast, setNarrow, setTab };
        const page = <PluginManagerPage
          t={managerT} resolveText={textOf}
          useConfigurations={select => select({ view: { namespaces: [] } })}
          usePluginManager={select => select(state)}
          useStore={select => select({ view, tab })}
          actions={{ setView, setTab }}
          // DSH 0.2.1 renders a tab strip for contributed plugins.tab entries.
          usePluginTabs={select => select([{ id: 'demo', label: '演示' }])}
          useConfigLedger={select => select({ items: [{ id: 'shell', label: '终端' }], bundles: new Set(), rows: new Set() })}
          ensure={noop} refresh={noop} clearHighlight={noop}
          openInstall={noop} closeInstall={noop} editInstallSpec={noop} runInstall={noop} dismissNotice={noop}
          setEnabled={noop} setRowEnabled={noop} installFrom={noop}
          renderSlot={name => name === 'plugins.tab'
            ? <div data-demo-tab style={{ padding: 24 }}>演示面板</div>
            : name === 'plugins.item' ? '限制终端命令的运行时间和输出。' : null}
        />;
        const settingsSlot = name => {
          if (name === 'settings.header') return <div data-slot="settings.header">设置</div>;
          if (name === 'settings.close') return <span data-slot="settings.close">关闭设置</span>;
          if (name === 'settings.section') return <div data-slot="settings.section">
            <PluginInventorySettingsTab {...bindInject({
              list: listInventory, presetName, resolveText: textOf, t: inventoryT,
              hooks: { clientSync }, retryClient: noop,
            })} />
          </div>;
          return null;
        };
        return <>
          <div data-slot="root"><div className={frameCss.frame}
            style={{ gridTemplateColumns: narrow ? '60px minmax(0, 1fr) 0px' : '280px minmax(0, 1fr) 0px' }}>
            <div className={frameCss.sidebarCol}><nav style={{ padding: 16, display: 'grid', gap: 24, color: 'var(--dsw-alias-label-primary)' }}>
              <span data-slot="sidebar.brand.name"><b>DeepSeek Harness</b></span>
              <button type="button" onClick={() => setSurface('inventory')}><span>设置</span></button>
              <button type="button" onClick={() => setSurface('plugins')}><span id="plugin-nav">插件</span></button>
              <span id="workspace">默认工作区</span>
            </nav></div>
            <div className={frameCss.centerCol}><div data-slot="main" style={{ display: 'contents' }}>
              {surface === 'plugins'
                ? page
                : <div data-conversation-placeholder style={{ padding: 24 }}>对话</div>}
            </div></div>
            <div className={frameCss.rightbarCol} data-rightbar-col />
            <div className={frameCss.overlayLayer} data-shell-overlay><div data-slot="shell.overlay">
              <main className="aic-root" style={{ animation: 'none' }}>
                <div className="aic-map" />
                <div className="aic-start-brand">AIC / PRTS</div>
              </main>
            </div></div>
          </div></div>
          {surface === 'inventory'
            ? <SettingsPanel rows={[{ id: 'plugins', label: '插件' }]} activeId="plugins"
                onSelect={noop} onClose={noop} renderSlot={settingsSlot} />
            : null}
          {toast
            ? <Toast text="已安装 prts-terrarchive" actions={[{ label: '撤销', onClick: noop }]}
                holdMs={600000} onDone={noop} />
            : null}
        </>;
      }
      createRoot(document.getElementById('root')).render(<App />);
    ` },
  })
  const { chromium } = await import(pathToFileURL(resolve(playwrightModule)).href)
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PRTS_BROWSER_EXECUTABLE ? { executablePath: process.env.PRTS_BROWSER_EXECUTABLE } : {}) })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error(error.stack) })
  const sheets = new Map()
  for (const skin of ['common', 'prts-agent', 'endfield-aic', 'rhine-lab']) {
    sheets.set(skin, await readFile(new URL(`../lib/skins/${skin}.css`, import.meta.url), 'utf8'))
  }
  await page.route('http://skins.test/**', route => {
    const key = new URL(route.request().url()).pathname.split('/').at(-1)?.replace('.css', '')
    return route.fulfill({ contentType: 'text/css; charset=utf-8', body: sheets.get(key) || '' })
  })
  await page.goto('http://skins.test/')
  await page.setContent('<!doctype html><meta charset="utf-8"><div id="root"></div><style>html,body,#root,[data-slot="root"]{height:100%;margin:0}body{font-family:Arial,sans-serif}button,textarea,input{font:inherit}nav button{background:var(--dsw-alias-button-elevated-fill);color:inherit;border:1px solid var(--dsw-alias-border-l2);padding:10px}body:not([data-prts-skin="endfield-aic"]) .aic-root{display:none}</style>')
  for (const file of outputFiles) {
    if (file.path.endsWith('.css')) await page.addStyleTag({ content: file.text })
    if (file.path.endsWith('.js')) await page.addScriptTag({ content: file.text })
  }
  await page.addScriptTag({ content: PROBE })
  await page.waitForSelector('[data-plugin-entry]')
  await page.evaluate(() => { window.__ModuleLoader__ = { load: ({ factory }) => { window.plugin = factory(() => window.fixtureReact) } } })
  await page.addScriptTag({ content: await readFile(new URL('../lib/client.js', import.meta.url), 'utf8') })
  await page.evaluate(() => {
    window.plugin.apply({
      theme: { overrideTokens(_id, tokens) {
        for (const [key, value] of Object.entries(tokens)) document.body.style.setProperty(key, value.light)
        return () => { for (const key of Object.keys(tokens)) document.body.style.removeProperty(key) }
      } },
      slots: { inject: () => () => {}, register: () => () => {} },
      effect: fn => fn(), sessions: {}, connection: { rpc: { call: async () => ({}) } },
    })
    window.setSkin = skin => window.plugin.__skinStateForTest.setSkin(skin)
  })
  const screenshotDir = process.env.PRTS_SKIN_SCREENSHOTS
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true })

  for (const skin of SKINS) {
    await t.test(`${skin}: inventory section, toast and plugin tabs`, async () => {
      const measurements = { skin }
      await page.setViewportSize({ width: 1600, height: 1000 })
      await page.evaluate(skin => window.setSkin(skin), skin)
      await page.evaluate(() => {
        window.fixture.setNarrow(false)
        window.fixture.setToast(false)
        window.fixture.setSurface('inventory')
      })
      await page.waitForSelector('[data-slot="settings.section"] [data-plugin-entry]')
      await settle(page)

      // (a) Real PluginInventorySettingsTab inside the real SettingsPanel shell.
      const wide = await readInventory(page)
      measurements.wide = wide
      assert.ok(wide.count >= 2, `${skin}: inventory renders plugin entry cards (${wide.count})`)
      assert.ok(wide.scopes.includes('preset') && wide.scopes.includes('global'),
        `${skin}: preset and global groups render (${wide.scopes.join(', ')})`)
      assertContrast(`${skin}: first card title`, wide.title)
      assertContrast(`${skin}: preset group title`, wide.groupTitle)
      assert.ok(wide.border.width > 0,
        `${skin}: card keeps a visible border (borderTopWidth ${wide.border.width}px)`)
      assert.ok(wide.border.alpha > 0,
        `${skin}: card border is not fully transparent (borderTopColor ${wide.border.color})`)
      assert.ok(wide.overflow.scrollWidth <= wide.overflow.clientWidth + 1,
        `${skin}: card content has no horizontal overflow (scrollWidth ${wide.overflow.scrollWidth} vs clientWidth ${wide.overflow.clientWidth})`)
      assert.ok(wide.box.right <= wide.dialog.right + 1,
        `${skin}: card right edge ${wide.box.right} stays inside the settings panel right edge ${wide.dialog.right}`)
      if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `${skin}-inventory.png`) })

      // The global group starts folded; opening it proves the second scope's cards render too.
      await page.locator('[data-plugin-scope="global"] button[aria-expanded]').first().click()
      await page.waitForFunction(
        () => document.querySelectorAll('[data-slot="settings.section"] [data-plugin-entry]').length >= 4,
      )
      const opened = await readInventory(page)
      measurements.opened = opened
      assert.equal(opened.count, wide.count + 2, `${skin}: opening the global group reveals its two cards`)
      assertContrast(`${skin}: global group title`, opened.globalTitle)

      // One card expands into its real details surface.
      await page.locator('[data-slot="settings.section"] [data-plugin-entry]').first().locator('button').first().click()
      await page.waitForSelector('[data-slot="settings.section"] [data-loader-entry]')
      assert.ok((await readInventory(page)).details >= 1, `${skin}: expanded card renders its loader entry details`)

      // (b) Real Toast primitive, portalled to body, over the settings layer.
      await page.evaluate(() => window.fixture.setToast(true))
      await page.waitForSelector('body > div[role="alert"]')
      // The entrance animation starts at opacity 0: wait it out before measuring/screenshotting.
      await page.waitForFunction(() => {
        const toast = document.querySelector('body > div[role="alert"]')
        return toast !== null && Number.parseFloat(getComputedStyle(toast).opacity) >= 0.99
      })
      await settle(page)
      const toast = await readToast(page)
      measurements.toast = toast
      assert.ok(toast !== null, `${skin}: toast rendered`)
      assert.ok(toast.parentIsBody, `${skin}: toast is portalled into document.body`)
      assert.match(toast.text, /已安装 prts-terrarchive/, `${skin}: toast carries its message`)
      assert.ok(Number.parseFloat(toast.opacity) >= 0.99,
        `${skin}: toast is fully visible after its entrance animation (opacity ${toast.opacity})`)
      assertContrast(`${skin}: toast label`, toast.contrast)
      assert.equal(toast.zIndex, '1100', `${skin}: toast keeps the 1100 host layer above the settings overlay`)
      if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `${skin}-toast.png`) })
      await page.evaluate(() => window.fixture.setToast(false))

      // Document width must stay at the viewport in both frames.
      const wideDocument = await documentWidth(page)
      assert.ok(wideDocument.scrollWidth <= wideDocument.innerWidth + 1,
        `${skin}: no horizontal document overflow at 1600 (scrollWidth ${wideDocument.scrollWidth} vs ${wideDocument.innerWidth})`)

      await page.setViewportSize({ width: 390, height: 760 })
      await page.evaluate(() => window.fixture.setNarrow(true))
      await settle(page)
      const narrow = await readInventory(page)
      measurements.narrow = narrow
      assert.ok(narrow.dialog.x >= 0 && narrow.dialog.right <= 391,
        `${skin}: settings dialog fits 390 (x ${narrow.dialog.x}, right ${narrow.dialog.right})`)
      assert.ok(narrow.box.right <= narrow.dialog.right + 1,
        `${skin}: card right edge ${narrow.box.right} stays inside the panel at 390 (${narrow.dialog.right})`)
      const narrowDocument = await documentWidth(page)
      assert.ok(narrowDocument.scrollWidth <= narrowDocument.innerWidth + 1,
        `${skin}: no horizontal document overflow at 390 (scrollWidth ${narrowDocument.scrollWidth} vs ${narrowDocument.innerWidth})`)

      // (c) Real PluginManagerPage with a contributed plugins.tab entry.
      await page.setViewportSize({ width: 1600, height: 1000 })
      await page.evaluate(() => {
        window.fixture.setNarrow(false)
        window.fixture.setTab('installed')
        window.fixture.setSurface('plugins')
      })
      await page.waitForSelector('[data-plugin-panel] [role="tablist"]')
      await settle(page)
      const tabs = await readTabs(page)
      measurements.tabs = tabs
      assert.ok(tabs.hasPanel, `${skin}: plugin panel renders`)
      assert.ok(tabs.hasTablist, `${skin}: tab strip renders`)
      assert.ok(tabs.tabCount >= 2, `${skin}: tab strip lists the installed and contributed tabs (${tabs.tabCount})`)
      assert.ok(tabs.insidePanel, `${skin}: tab strip lives inside the plugin panel`)
      assert.ok(tabs.list.width > 0 && tabs.list.height > 0,
        `${skin}: tab strip is visible (${tabs.list.width}x${tabs.list.height})`)
      assert.ok(tabs.list.x >= tabs.panel.x - 1 && tabs.list.right <= tabs.panel.right + 1,
        `${skin}: tab strip stays inside the panel (${tabs.list.x}..${tabs.list.right} in ${tabs.panel.x}..${tabs.panel.right})`)
      assertContrast(`${skin}: first plugin tab`, tabs.contrast)
      if (screenshotDir) await page.screenshot({ path: resolve(screenshotDir, `${skin}-plugins-tabs.png`) })
      const pluginDocument = await documentWidth(page)
      assert.ok(pluginDocument.scrollWidth <= pluginDocument.innerWidth + 1,
        `${skin}: no horizontal document overflow on the plugin page at 1600 (scrollWidth ${pluginDocument.scrollWidth})`)

      await page.setViewportSize({ width: 390, height: 760 })
      await page.evaluate(() => window.fixture.setNarrow(true))
      await settle(page)
      const pluginNarrow = await documentWidth(page)
      assert.ok(pluginNarrow.scrollWidth <= pluginNarrow.innerWidth + 1,
        `${skin}: no horizontal document overflow on the plugin page at 390 (scrollWidth ${pluginNarrow.scrollWidth})`)
      measurements.documents = { wide: wideDocument, narrow: narrowDocument, plugin: pluginDocument, pluginNarrow }
      if (process.env.PRTS_SKIN_DEBUG) {
        console.log('skin-host-surfaces ' + skin + ' ' + JSON.stringify(measurements))
      }

      // The contributed tab opens its own panel instead of the installed list.
      await page.getByRole('tab', { name: '演示' }).click()
      await page.waitForSelector('[data-plugin-panel] [role="tabpanel"] [data-demo-tab]')
    })
  }
  assert.deepEqual(errors, [])
})
