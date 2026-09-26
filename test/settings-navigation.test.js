import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'

let api
vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load({ factory }) { api = factory(() => ({})).__skinStateForTest } } },
})
const { openHostSettings, isHostSettingsOpen } = api
const emptyDocument = { querySelector: () => null }
const shellEntry = (open) => ({
  children: { 'settings.launcher': { kind: 'single', scope: 'root' } },
  store: { create: () => ({ actions: { open } }) },
})

test('DSH 0.1.7: settings opens without a dialog trigger or simulated account-menu click', () => {
  let opened = 0
  let activeEntry = shellEntry(() => { opened += 1 })
  const ctx = { slots: { entriesOfSlot(key) {
    assert.equal(key, 'sidebar.settings')
    return [activeEntry]
  } } }
  assert.equal(openHostSettings(ctx, emptyDocument), true)
  assert.equal(opened, 1)
  // Host reload replaces the shell: the next click must resolve its new owner.
  let replacementOpened = 0
  activeEntry = shellEntry(() => { replacementOpened += 1 })
  assert.equal(openHostSettings(ctx, emptyDocument), true)
  assert.equal(opened, 1)
  assert.equal(replacementOpened, 1)
})

test('DSH 0.1.3/0.1.5: settings still opens through the mounted legacy trigger', () => {
  let opened = 0
  const button = { click() { opened += 1 } }
  const doc = { querySelector: selector => selector.endsWith('button[aria-haspopup="dialog"]') ? button : null }
  const ctx = { slots: { entries() { assert.fail('Legacy settings needs no new slot API') } } }
  assert.equal(openHostSettings(ctx, doc), true)
  assert.equal(opened, 1)
  button.disabled = true
  assert.equal(openHostSettings({}, doc), false)
  assert.equal(opened, 1)
})

test('an open settings panel is not toggled or reopened', () => {
  const doc = { querySelector: () => ({}) }
  assert.equal(openHostSettings(null, doc), true)
})

test('missing settings or a shadowed shell reports unavailable without opening another owner', () => {
  assert.equal(openHostSettings(null, emptyDocument), false)
  assert.equal(openHostSettings({ slots: {} }, emptyDocument), false)
  const inactive = shellEntry(() => { assert.fail('Must not open the shadowed shell') })
  assert.equal(openHostSettings({ slots: { entriesOfSlot: () => [{}], entries: () => [inactive] } }, emptyDocument), false)
  assert.equal(openHostSettings({ slots: { entries: () => [{ ...inactive, store: undefined }] } }, emptyDocument), false)
  assert.equal(openHostSettings({ slots: { entries: () => [shellEntry(undefined)] } }, emptyDocument), false)
})

const hostDir = process.env.PRTS_DSH_SOURCE_DIR

test('real DOM: legacy inline/portal settings and new account launcher remain compatible', {
  skip: !hostDir ? 'Set PRTS_DSH_SOURCE_DIR to use the host DOM test runtime' : false,
}, async () => {
  const hostRequire = createRequire(resolve(hostDir, 'package.json'))
  const { JSDOM } = hostRequire('jsdom')
  const dom = new JSDOM('<!doctype html><div data-slot="sidebar.settings"></div>')
  const doc = dom.window.document
  const sidebar = doc.querySelector('[data-slot="sidebar.settings"]')
  try {
    // Old settings is component-local, its button can be hidden by the skin.
    sidebar.innerHTML = '<button aria-haspopup="dialog" style="display:none">设置</button>'
    const trigger = sidebar.querySelector('button')
    trigger.onclick = () => {
      sidebar.insertAdjacentHTML('beforeend', '<div role="dialog" aria-modal="true"><span data-slot="settings.header">设置</span></div>')
    }
    assert.equal(isHostSettingsOpen(doc), false)
    assert.equal(openHostSettings({}, doc), true)
    assert.equal(isHostSettingsOpen(doc), true)
    const panel = sidebar.querySelector('[role="dialog"]')
    // Settings may portal outside the sidebar, without the new shortcut marker.
    doc.body.append(panel)
    assert.equal(isHostSettingsOpen(doc), true)
    panel.remove()
    assert.equal(isHostSettingsOpen(doc), false)
    // Other dialogs must not disable Rhine keyboard handling as settings.
    doc.body.insertAdjacentHTML('beforeend', '<div role="dialog" aria-modal="true">Unrelated</div>')
    assert.equal(isHostSettingsOpen(doc), false)
    sidebar.innerHTML = '<button aria-haspopup="menu">账号菜单</button>'
    sidebar.querySelector('button').onclick = () => assert.fail('Do not open or navigate the account menu')
    const current = shellEntry(() => {
      doc.body.insertAdjacentHTML('beforeend', '<div role="dialog" aria-modal="true" data-shortcut-modal="settings"></div>')
    })
    assert.equal(openHostSettings({ slots: { entries: () => [current] } }, doc), true)
    assert.equal(isHostSettingsOpen(doc), true)
    assert.equal(openHostSettings({}, doc), true)
    assert.equal(doc.querySelectorAll('[data-shortcut-modal="settings"]').length, 1)
    doc.querySelector('[data-shortcut-modal="settings"]').remove()
    assert.equal(isHostSettingsOpen(doc), false)
  } finally {
    dom.window.close()
  }
})
