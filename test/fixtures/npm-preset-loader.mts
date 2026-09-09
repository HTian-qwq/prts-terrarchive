/** Run with the selected DSH checkout's tsx resolver, never stale lib output. */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const [pluginRoot, dshRoot] = process.argv.slice(2)
const { load } = createRequire(join(dshRoot, 'package.json'))('js-yaml')
const home = mkdtempSync(join(tmpdir(), 'prts-preset-loader-'))
process.env.DSH_HOME = home
const project = join(home, 'desktop', 'staging', 'candidate with 空格', 'profile')
const stagedPackage = join(project, 'node_modules', 'prts-terrarchive')
const packagedRoot = join(stagedPackage, 'presets')
const desktopRoot = join(home, 'desktop-system-presets')
const userRoot = join(home, '.agent-presets')
const rawDefault = { __jsExpr: "'company'" }
let ctx: Context | undefined
let mounted = 0
let disposed = 0
let settingsRegistrations = 0

function preset(root: string, id: string, displayName: string) {
  mkdirSync(join(root, id), { recursive: true })
  writeFileSync(join(root, id, 'agent.cordis.yml'), '[]\n')
  writeFileSync(join(root, id, 'preset.yml'), `name: ${displayName}\n`)
}

try {
  mkdirSync(stagedPackage, { recursive: true })
  for (const name of ['package.json', 'presets']) {
    cpSync(join(pluginRoot, name), join(stagedPackage, name), { recursive: true })
  }
  // Discovery validates installed exports without mounting PRTS tools or data.
  symlinkSync(join(pluginRoot, 'src'), join(stagedPackage, 'src'), 'junction')
  for (const [name, relative] of [
    ['@deepseek-ai/dsh-tool-web', 'packages/web/tool-web'],
    ['@deepseek-ai/dsh-tool-skill', 'packages/skill/tool-skill'],
  ]) {
    const destination = join(project, 'node_modules', ...name.split('/'))
    mkdirSync(dirname(destination), { recursive: true })
    symlinkSync(join(dshRoot, relative), destination, 'junction')
  }
  preset(desktopRoot, 'company', 'Company')
  const markerPath = join(home, 'standing-marker.mjs')
  writeFileSync(markerPath, 'export function apply() {}\n')
  const markerUrl = pathToFileURL(markerPath).href
  writeFileSync(join(desktopRoot, 'company', 'agent.cordis.yml'), `- id: marker\n  name: ${markerUrl}\n`)
  const bundle = load(readFileSync(join(pluginRoot, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
  const roster = {
    id: 'agent-presets', name: '@deepseek-ai/dsh-agent-presets',
    config: { default: rawDefault, roots: [{ path: '/unused-bundle-root', trust: 'system' }], includeShippedRoot: false },
  }
  const composed = applyEntryPatches([roster], bundle, (message: string) => { throw new Error(message) })
  // Desktop replaces bundle roots in its final Host patch.
  const finalRoster = composed.find((entry) => entry.id === 'agent-presets')!
  finalRoster.config = { ...finalRoster.config, roots: [{ path: desktopRoot, trust: 'system' }] }
  const contribution = composed.find((entry) => entry.id === 'prts-preset-seed')!
  assert.ok(contribution)
  assert.equal(finalRoster.inject, undefined)
  const originalInput = structuredClone(finalRoster.config)
  async function createHost() {
    const host = new Context()
    host.baseUrl = pathToFileURL(project).href + '/'
    await host.plugin(Loader)
    host.provide('dshHomePath', dshHomePath)
    host.provide('sessionProjections', { register() {} })
    // Exercise the actual settings-injection child fiber in AgentPresets.
    host.provide('settings', { register(_name, _schema, options) {
      settingsRegistrations++
      return { get: () => options.base }
    } })
    const importModule = host.loader.internal!.import.bind(host.loader.internal)
    host.loader.internal!.import = async (specifier, ...args) => {
      if (specifier === '@deepseek-ai/dsh-agent-presets') return { default: AgentPresets }
      if (specifier === 'prts-terrarchive/presets') {
        return await import(pathToFileURL(join(packagedRoot, 'register.js')).href)
      }
      if (specifier === markerUrl) return { apply(scope) {
        scope.effect(() => { mounted++; return () => { disposed++ } })
      } }
      return await importModule(specifier, ...args)
    }
    return host
  }
  ctx = await createHost()
  await ctx.loader.root.update([finalRoster])
  await ctx.loader.await()
  const normalAgent = createScope(ctx, { test: 'ordinary-agent' })
  await ctx.agentPresets.mount(normalAgent.ctx, 'company')
  assert.equal(mounted, 1)
  const activeRosterUid = ctx.loader.resolve('agent-presets').fiber!.uid
  const originalRoots = structuredClone(ctx.agentPresets.roots)
  const assertUnaffected = () => {
    assert.equal(disposed, 0, 'ordinary sessions retain their standing tools')
    assert.equal(mounted, 1, 'ordinary sessions are never remounted')
    assert.equal(ctx!.loader.resolve('agent-presets').fiber!.uid, activeRosterUid, 'the roster is never restarted')
    assert.equal(settingsRegistrations, 1, 'settings child fibers stay active')
    assert.deepEqual(ctx!.agentPresets.roots, originalRoots)
    assert.equal(ctx!.agentPresets.defaultId, 'company')
  }
  await ctx.loader.root.update([finalRoster, contribution])
  await ctx.loader.await()
  assertUnaffected()
  let selected = await ctx.agentPresets.resolve('prts')
  assert.equal(selected.broken, undefined)
  assert.equal(selected.trust, 'user')
  assert.equal(selected.path, join(userRoot, 'prts', 'agent.cordis.yml'))
  assert.equal(readFileSync(selected.path, 'utf8'), readFileSync(join(packagedRoot, 'prts', 'agent.cordis.yml'), 'utf8'))
  assert.deepEqual(finalRoster.config, originalInput)
  assert.ok(existsSync(join(userRoot, 'prts', '.prts-terrarchive.json')))

  // User edits to a generated preset survive all plugin lifecycle transitions.
  preset(userRoot, 'prts', 'Customized PRTS')
  const customBytes = readFileSync(join(userRoot, 'prts', 'agent.cordis.yml'))
  for (const disabled of [true, false]) {
    await ctx.loader.resolve('prts-preset-seed').update({ disabled })
    await ctx.loader.await()
    assertUnaffected()
    assert.equal((await ctx.agentPresets.resolve('prts')).name, 'Customized PRTS')
    assert.deepEqual(readFileSync(join(userRoot, 'prts', 'agent.cordis.yml')), customBytes)
  }
  await ctx.loader.root.update([finalRoster])
  await ctx.loader.await()
  assertUnaffected()
  assert.equal((await ctx.agentPresets.resolve('prts')).name, 'Customized PRTS', 'uninstall retains user files')

  // A deployment that deliberately disables user roots stays read-only.
  rmSync(userRoot, { recursive: true })
  await ctx.loader.root.update([{ ...finalRoster, config: { ...originalInput, includeUserRoot: false } }, contribution])
  await ctx.loader.await()
  assert.equal(existsSync(userRoot), false)
  assert.deepEqual((await ctx.agentPresets.list()).map((row) => row.id), ['company'])
  assert.deepEqual(ctx.agentPresets.roots, [{ path: desktopRoot, trust: 'system' }])
  await ctx.fiber.dispose()
  ctx = await createHost()
  await ctx.loader.root.update([finalRoster, contribution])
  await ctx.loader.await()
  assert.equal((await ctx.agentPresets.resolve('prts')).broken, undefined, 'cold startup discovers the newly seeded preset')
  assert.equal(ctx.agentPresets.defaultId, 'company')
  console.log('PRTS preset Loader compatibility passed: staging, Desktop roots, settings child fiber, standing sessions, install, disable, re-enable, uninstall, read-only roots, cold startup')
} finally {
  await ctx?.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
}
