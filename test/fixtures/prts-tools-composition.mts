/** Real Loader + scoped DSH registries; no model calls or network downloads. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Skills from '@deepseek-ai/dsh-skill'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'

const [pluginRoot, dshRoot] = process.argv.slice(2)
const fromHost = (path: string) => import(pathToFileURL(join(dshRoot, path)).href)
const fromPlugin = (path: string) => import(pathToFileURL(join(pluginRoot, path)).href)
const { MemoryStorageBackend } = await fromHost('packages/storage/storage-domain/tests/helpers/memory-backend.ts')
const { readPlugins } = await fromPlugin('presets/composition.js')
const { createSharedState } = await fromPlugin('src/state.js')
const home = mkdtempSync(join(tmpdir(), 'prts-tools-composition-'))
process.env.DSH_HOME = home
const root = new Context()
const scopes = []
try {
  const project = join(home, 'profile')
  mkdirSync(join(project, 'node_modules'), { recursive: true })
  symlinkSync(pluginRoot, join(project, 'node_modules/prts-terrarchive'), 'junction')
  root.baseUrl = pathToFileURL(project).href + '/'
  await root.plugin(Loader)
  await root.plugin(SystemPrompt)
  await root.plugin(Tools)
  await root.plugin(Skills)
  await root.plugin(SessionProjectionRegistry)
  await root.plugin(Storage)
  root.storage.backend.register('memory', new MemoryStorageBackend())
  const facility = new DomainFacility(root, { backend: 'memory', routes: {} })
  root.storage.mount('domain', facility)
  root.provide('storageDomain', facility)
  root.provide('agents', {})
  root.provide('web', {
    async search() { return { sources: [], truncated: false } },
    async fetch() { return { url: 'https://fixture.invalid', statusCode: 200, truncated: false,
      body: { kind: 'text', content: 'fixture' } } },
  })
  // The tool-only entry must not install any Host UI, even if passed UI flags.
  let uiRegistrations = 0
  root.provide('connection', {
    rpc: { handle() { uiRegistrations++; return () => {} } },
    fetch: { register() { uiRegistrations++; return () => {} } },
  })
  const originalImport = root.loader.internal!.import.bind(root.loader.internal)
  root.loader.internal!.import = async (name, ...args) => {
    if (name === '@deepseek-ai/dsh-agent-preset-registry') return { default: AgentPresets }
    if (name === '@deepseek-ai/dsh-agent-preset') return { default: AgentPreset }
    const files = {
      'prts-terrarchive/presets': 'presets/register.js',
      'prts-terrarchive/tools': 'src/tools.js',
      'prts-terrarchive/skill': 'src/skill.js',
      'prts-terrarchive/composition': 'src/composition-skill.js',
      'prts-terrarchive': 'src/index.js',
    }
    if (files[name]) return fromPlugin(files[name])
    const official = {
      '@deepseek-ai/dsh-tool-todo': 'packages/todo/tool-todo/src/index.ts',
      '@deepseek-ai/dsh-tool-skill': 'packages/skill/tool-skill/src/index.ts',
      '@deepseek-ai/dsh-tool-web': 'packages/web/tool-web/src/index.ts',
    }
    if (official[name]) return fromHost(official[name])
    return originalImport(name, ...args)
  }
  const bundle = readPlugins(readFileSync(join(pluginRoot, 'cordis.patch.yml'), 'utf8'))[0].insert
  const registration = bundle.find(row => row.id === 'prts-preset-seed')
  const guide = bundle.find(row => row.id === 'prts-composition-skill')
  const skillLoader = { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' }
  const standard = { id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset', config: {
    id: 'standard', plugins: [
      { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
      skillLoader,
    ],
  } }
  const custom = { id: 'preset-user-research', name: '@deepseek-ai/dsh-agent-preset', config: {
    id: 'user-research', plugins: [
      skillLoader,
      { id: 'my-prts-tools', name: 'prts-terrarchive/tools', config: { registerUi: true, registerTools: false } },
      { id: 'my-prts-guidance', name: 'prts-terrarchive/skill' },
    ],
  } }
  const registry = { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'standard' } }
  // Deliberately put PRTS before standard: startup must not depend on import order.
  await root.loader.root.update([registry, registration, guide, custom, standard])
  await root.loader.await()
  for (const preset of await root.agentPresets.list()) assert.equal(preset.broken, undefined, JSON.stringify(preset))
  const makeAgent = async (id: string, preset: string) => {
    const events = []
    const agent = { id, session: { id, append(type, data) { events.push({ type, data }) } } }
    const scope = createScope(root, agent)
    agent.ctx = scope.ctx
    scopes.push(scope)
    await root.agentPresets.mount(scope.ctx, preset)
    return { agent, events }
  }
  const ordinary = await makeAgent('ordinary', 'standard')
  const prts = await makeAgent('prts-user', 'prts')
  const user = await makeAgent('custom-user', 'user-research')
  const names = agent => root.tools.schemas(agent).map(tool => tool.name)
  assert(names(ordinary.agent).includes('todo_write'))
  assert(!names(ordinary.agent).includes('corpus_search'))
  assert(names(prts.agent).includes('todo_write'))
  for (const name of ['corpus_search', 'corpus_read', 'corpus_i18n', 'timeline_search',
    'cloud_search', 'cloud_inspect']) {
    assert(names(prts.agent).includes(name), name)
    assert(names(user.agent).includes(name), name)
  }
  const boardTools = ['investigation_open', 'investigation_get', 'investigation_stage',
    'investigation_update', 'investigation_publish']
  assert(!names(prts.agent).some(name => boardTools.includes(name)))
  assert(!names(user.agent).some(name => boardTools.includes(name)))
  const config = createSharedState({ configPath: join(home, 'prts-corpus.json'), releasesDir: join(home, 'prts-corpus/releases') })
  await config.saveConfig({ uiSkin: 'rhine-lab' })
  const deadline = Date.now() + 2000
  while (!names(prts.agent).includes('investigation_open') || !names(user.agent).includes('investigation_open')) {
    assert(Date.now() < deadline, 'skin selection reaches both existing Agents')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  for (const name of boardTools) {
    assert(names(prts.agent).includes(name), name)
    assert(names(user.agent).includes(name), name)
    assert(!names(ordinary.agent).includes(name), 'standard Agent does not acquire PRTS tools')
  }
  assert(!names(user.agent).includes('todo_write'), 'custom composition is not forced to inherit standard')
  assert(!names(user.agent).includes('web_search'), 'the reusable entry does not bundle unrelated tools')
  assert.equal(names(prts.agent).length, new Set(names(prts.agent)).size)
  assert.equal(uiRegistrations, 0)
  const globalSkills = await root.skills.list({ scope: ordinary.agent })
  assert(globalSkills.some(skill => skill.name === 'prts-composition'))
  assert(!globalSkills.some(skill => skill.name === 'prts-retrieval'))
  assert((await root.skills.list({ scope: user.agent })).some(skill => skill.name === 'prts-retrieval'))
  let call = 0
  const execute = (agent, name, args) => root.tools.execute({
    agent, name, arguments: args, callId: 'call-' + (++call), signal: new AbortController().signal,
  })
  const todo = await execute(prts.agent, 'todo_write', { todos: [{ content: '研究资料', status: 'in_progress' }] })
  assert.equal(todo.isError, false, JSON.stringify(todo))
  assert.equal(prts.events[0].type, 'todo/write')
  const missing = await execute(user.agent, 'corpus_search', { query: '阿米娅' })
  assert.match(JSON.stringify(missing), /本地数据包暂未安装/)
  root.emit(scopeTarget(root, user.agent), 'agent/inbox/claimed', { agent: user.agent, turn: 1, message: {} })
  const board = await execute(user.agent, 'investigation_open', { mode: 'new', title: '自定义模式的调查', objective: '验证', reason: '用户组合' })
  assert.equal(board.isError, false, JSON.stringify(board))
  const recalled = await execute(user.agent, 'investigation_get', {})
  assert.match(JSON.stringify(recalled), /自定义模式的调查/)
  const elsewhere = await execute(prts.agent, 'investigation_get', {})
  assert(!JSON.stringify(elsewhere).includes('自定义模式的调查'))

  // A user override can remove inherited tools entirely and keep !!js deferred.
  await root.loader.resolve('prts-preset-seed').update({ config: { plugins: [
    { id: 'disabled', name: 'fixture/must-not-import', disabled: { __jsExpr: 'true' } },
  ] } })
  await root.loader.await()
  assert.equal((await root.agentPresets.resolve('prts')).broken, undefined)
  const limited = await makeAgent('limited', 'prts')
  assert.deepEqual(names(limited.agent), [])
  assert(names(prts.agent).includes('todo_write'), 'existing Agent retains its original revision')
  await root.loader.resolve('prts-composition-skill').update({ disabled: true })
  await root.loader.await()
  assert(!(await root.skills.list({ scope: ordinary.agent })).some(skill => skill.name === 'prts-composition'))
  for (const scope of scopes.splice(0)) await scope.dispose()
  await root.loader.root.update([registry, standard])
  await root.loader.await()
  assert.deepEqual((await root.agentPresets.list()).map(row => row.id), ['standard'])
  assert.deepEqual(root.tools.schemas().map(tool => tool.name), [])
  console.log('PRTS tool composition passed: inherited tools, custom mode, skills, no UI, user replacement, session isolation and disposal')
} finally {
  for (const scope of scopes) await scope.dispose()
  await root.fiber.dispose()
  rmSync(home, { recursive: true, force: true })
}
