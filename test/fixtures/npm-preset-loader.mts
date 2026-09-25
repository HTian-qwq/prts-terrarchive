/** Exercise the shipped contribution with the selected DSH checkout's real Loader and registry. */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const [pluginRoot, dshRoot] = process.argv.slice(2)
const { load } = createRequire(join(dshRoot, 'package.json'))('js-yaml')
const home = mkdtempSync(join(tmpdir(), 'prts-preset-loader-'))
process.env.DSH_HOME = home
const project = join(home, 'desktop', 'staging', 'candidate with 空格', 'profile')
const stagedPackage = join(project, 'node_modules', 'prts-terrarchive')
const packagedRoot = join(stagedPackage, 'presets')
let ctx: Context | undefined
let mounted = 0
let disposed = 0

try {
  mkdirSync(stagedPackage, { recursive: true })
  for (const name of ['package.json', 'presets']) cpSync(join(pluginRoot, name), join(stagedPackage, name), { recursive: true })
  symlinkSync(join(pluginRoot, 'src'), join(stagedPackage, 'src'), 'junction')
  const bundle = load(readFileSync(join(pluginRoot, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
  const registry = { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'standard' } }
  const composed = applyEntryPatches([registry], bundle, (message: string) => { throw new Error(message) })
  const contribution = composed.find((entry) => entry.id === 'prts-preset-seed')!
  assert.ok(contribution)
  const definition = (await import(pathToFileURL(join(packagedRoot, 'definition.js')).href)).prtsPreset
  assert.deepEqual(definition.plugins, load(readFileSync(join(packagedRoot, 'prts/agent.cordis.yml'), 'utf8')))
  assert.deepEqual({ name: definition.name, description: definition.description, order: definition.order },
    load(readFileSync(join(packagedRoot, 'prts/preset.yml'), 'utf8')))

  ctx = new Context()
  ctx.baseUrl = pathToFileURL(project).href + '/'
  await ctx.plugin(Loader)
  ctx.provide('sessionProjections', { register() {} })
  ctx.provide('settings', { configure() { return () => {} } })
  const importModule = ctx.loader.internal!.import.bind(ctx.loader.internal)
  ctx.loader.internal!.import = async (specifier, ...args) => {
    if (specifier === '@deepseek-ai/dsh-agent-preset-registry') return { default: AgentPresets }
    if (specifier === '@deepseek-ai/dsh-agent-preset') return { default: AgentPreset }
    if (specifier === 'prts-terrarchive/presets') return await import(pathToFileURL(join(packagedRoot, 'register.js')).href)
    if (specifier === 'fixture/standing') return { apply(scope) {
      scope.effect(() => { mounted++; return () => { disposed++ } })
    } }
    if (['prts-terrarchive', 'prts-terrarchive/skill', '@deepseek-ai/dsh-tool-web',
      '@deepseek-ai/dsh-tool-skill'].includes(specifier)) return { apply() {} }
    return await importModule(specifier, ...args)
  }
  const standard = { id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset', config: {
    id: 'standard', plugins: [{ id: 'standing', name: 'fixture/standing' }],
  } }
  // Use the real registry; the standard preset fixture has the same lifetime as a Host row.
  await ctx.loader.root.update([registry, standard])
  await ctx.loader.await()
  const ordinary = createScope(ctx, { test: 'ordinary-agent' })
  await ctx.agentPresets.mount(ordinary.ctx, 'standard')
  assert.equal(mounted, 1)
  const registryUid = ctx.loader.resolve('agent-preset-registry').fiber!.uid
  await ctx.loader.root.update([registry, standard, contribution])
  await ctx.loader.await()
  assert.equal(ctx.loader.resolve('agent-preset-registry').fiber!.uid, registryUid)
  assert.equal(disposed, 0)
  assert.equal(ctx.agentPresets.defaultId, 'standard')
  const prts = await ctx.agentPresets.resolve('prts')
  assert.equal(prts.broken, undefined)
  assert.deepEqual((await ctx.agentPresets.list()).map(row => row.id), ['prts', 'standard'])
  assert.equal(existsSync(join(home, '.agent-presets')), false)
  await ctx.loader.resolve('prts-preset-seed').update({ disabled: true })
  await ctx.loader.await()
  assert.deepEqual((await ctx.agentPresets.list()).map(row => row.id), ['standard'])
  assert.equal(disposed, 0)
  await ctx.loader.resolve('prts-preset-seed').update({ disabled: false })
  await ctx.loader.await()
  assert.equal((await ctx.agentPresets.resolve('prts')).broken, undefined)
  await ctx.loader.root.update([registry, standard])
  await ctx.loader.await()
  assert.deepEqual((await ctx.agentPresets.list()).map(row => row.id), ['standard'])
  assert.equal(disposed, 0)
  await ordinary.dispose()
  assert.equal(disposed, 0, 'the standard definition remains mounted until registry disposal')
  await ctx.fiber.dispose()
  ctx = undefined
  assert.equal(disposed, 1)
  console.log('PRTS preset Loader compatibility passed: declarative registration, ordinary session lifetime, disable, re-enable, uninstall')
} finally {
  await ctx?.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
}
