import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Run against a checked-out Host and an installed Playwright; the plugin's
// ordinary Node suite does not require either development dependency.
const hostDir = process.env.PRTS_DSH_SOURCE_DIR
const playwrightModule = process.env.PRTS_PLAYWRIGHT_MODULE

test('AIC keeps Host right-sidebar controls reachable without reserving empty map space', {
  skip: !hostDir || !playwrightModule
    ? 'Set PRTS_DSH_SOURCE_DIR and PRTS_PLAYWRIGHT_MODULE for the browser compatibility check'
    : false,
}, async (t) => {
  const { chromium } = await import(pathToFileURL(resolve(playwrightModule)).href)
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PRTS_BROWSER_EXECUTABLE
      ? { executablePath: process.env.PRTS_BROWSER_EXECUTABLE } : {}),
  })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  // The real Host sheets determine panel visibility, width and hit testing.
  // CSS Modules only rename these class selectors in the assembled app.
  const hostCss = await Promise.all([
    'packages/client/ui-layout/src/client/AppFrame.module.css',
    'packages/client/ui-sidebar-right/src/client/shell/SidebarRight.module.css',
  ].map((path) => readFile(resolve(hostDir, path), 'utf8')))
  const skin = await readFile(new URL('../lib/skins/endfield-aic.css', import.meta.url), 'utf8')
  await page.setContent(`<style>
    html,body,#root,[data-slot="root"]{height:100%;margin:0}
    :root{--dsw-alias-bg-base:#14181b;--ds-transition-duration-slow:0s}
    ${hostCss.join('\n')}
    #chat-action{position:absolute;left:100px;top:100px}
    #file-action{position:absolute;right:100px;top:100px}
  </style>
  <div id="root"><div data-slot="root">
    <div class="frame" style="grid-template-columns:240px minmax(0,1fr) 576px">
      <div class="sidebarCol"></div>
      <div class="centerCol"><div data-slot="conversation"><div data-phase="active">
        <button id="chat-action">Send</button>
      </div></div></div>
      <div class="rightbarCol" data-rightbar-col><div data-slot="rightbar">
        <div class="panel" data-sidebar-right-panel="push" data-sidebar-right-open
          style="width:576px"><button id="file-action">Read file</button></div>
      </div></div>
      <div class="overlayLayer" data-shell-overlay="true">
        <div data-slot="shell.overlay"></div>
      </div>
      <div class="handle" data-side="rightbar" style="left:864px"></div>
    </div>
  </div></div>`)
  await page.addStyleTag({ content: skin })
  const hit = (x, y) => page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y)
    return {
      panel: Boolean(element?.closest('[data-sidebar-right-panel]')),
      map: Boolean(element?.closest('.aic-map')),
      handle: element?.getAttribute('data-side') === 'rightbar',
      history: Boolean(element?.closest('.aic-drawer')),
      float: Boolean(element?.closest('[data-sidebar-right-float-host]')),
    }
  }, { x, y })
  const setPanel = (mode, width = 576) => page.evaluate(({ mode, width }) => {
    const panel = document.querySelector('[data-sidebar-right-panel]')
    panel.dataset.sidebarRightPanel = mode === 'fullscreen' ? 'fullscreen' : 'push'
    panel.toggleAttribute('data-sidebar-right-open', mode !== 'closed')
    panel.style.width = mode === 'fullscreen' ? '100%' : `${width}px`
    const handle = document.querySelector('[data-side="rightbar"]')
    handle.style.display = mode === 'push' ? '' : 'none'
    handle.style.left = `${innerWidth - width}px`
  }, { mode, width })

  // The stylesheet must leave the default Harness presentation alone.
  assert.equal((await hit(1300, 180)).panel, true)
  await page.evaluate(() => {
    document.body.dataset.prtsSkin = 'endfield-aic'
    document.querySelector('[data-slot="shell.overlay"]').innerHTML =
      '<main class="aic-root" style="animation:none"><div class="aic-map"></div></main>'
    document.querySelector('#file-action').onclick = () => { window.fileClicks = (window.fileClicks || 0) + 1 }
    document.querySelector('#chat-action').onclick = () => { window.chatClicks = (window.chatClicks || 0) + 1 }
  })
  assert.equal((await hit(1300, 180)).panel, true, 'normal sidebar must cover the interactive map')
  await page.locator('#file-action').click()
  await page.locator('#chat-action').click()
  assert.equal(await page.evaluate(() => window.fileClicks), 1)
  assert.equal(await page.evaluate(() => window.chatClicks), 1)
  assert.equal((await hit(864, 450)).handle, true, 'normal resize handle must stay above map and sidebar')

  // Simulate the Host's published geometry after a resize.
  await setPanel('push', 700)
  assert.equal((await hit(740, 450)).handle, true)
  assert.equal((await hit(800, 450)).panel, true)
  await setPanel('fullscreen')
  assert.equal((await hit(140, 215)).panel, true, 'fullscreen must cover the fixed chat as well as the map')
  assert.equal((await hit(1300, 180)).panel, true)
  await page.locator('#file-action').click()
  assert.equal(await page.evaluate(() => window.fileClicks), 2)

  await setPanel('closed')
  assert.equal((await hit(1300, 180)).map, true, 'closing must expose the map again')
  const columns = await page.locator('.frame').evaluate((element) =>
    getComputedStyle(element).gridTemplateColumns.split(' ').map(parseFloat))
  assert.deepEqual(columns, [0, 1440, 0], 'closed sidebar must not leave an empty reserved column')
  await page.locator('#chat-action').click()
  assert.equal(await page.evaluate(() => window.chatClicks), 2)

  await page.setViewportSize({ width: 640, height: 800 })
  await setPanel('fullscreen')
  assert.equal((await hit(140, 190)).panel, true, 'phone fullscreen must cover the phone chat layout')
  await setPanel('closed')
  assert.equal((await hit(600, 40)).map, true)

  // AIC history is modal; independently floating Host tabs also remain above
  // the sidebar. Opening the sidebar must not bury either surface.
  await page.setViewportSize({ width: 1440, height: 900 })
  await setPanel('fullscreen')
  await page.evaluate(() => {
    document.querySelector('.aic-root').insertAdjacentHTML('beforeend',
      '<aside class="aic-drawer" style="animation:none">History</aside>')
  })
  assert.equal((await hit(100, 200)).history, true)
  await page.locator('.aic-drawer').evaluate((element) => element.remove())
  await page.evaluate(() => {
    const floating = document.createElement('div')
    floating.dataset.sidebarRightFloatHost = ''
    floating.style.cssText = 'position:fixed;inset:80px 80px auto auto;width:300px;height:200px;z-index:60;background:black'
    document.body.append(floating)
  })
  assert.equal((await hit(1300, 180)).float, true)

  // Old Web Hosts have no rightbar attributes: chat and map must still work.
  await page.locator('[data-sidebar-right-float-host]').evaluate((element) => element.remove())
  await page.locator('[data-rightbar-col]').evaluate((element) => element.remove())
  await page.locator('[data-side="rightbar"]').evaluate((element) => element.remove())
  assert.equal((await hit(1300, 180)).map, true)
  await page.locator('#chat-action').click()
  assert.equal(await page.evaluate(() => window.chatClicks), 3)
})
