import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSharedState } from '../src/state.js'
import { mountInvestigationTools } from '../src/investigation-tools.js'

test('skin changes remove board schemas, prompts and queued calls without discarding source receipts', async t => {
  const home = await mkdtemp(join(tmpdir(), 'prts-skin-policy-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const shared = createSharedState({ configPath: join(home, 'config.json'), releasesDir: home })
  const tools = new Map(), contexts = new Map(), hooks = new Map()
  const register = map => entry => {
    assert(!map.has(entry.name), `duplicate registration: ${entry.name}`)
    map.set(entry.name, entry)
    return () => map.delete(entry.name)
  }
  let writes = 0, receipts = 0, finishRecovery
  const service = {
    peek: () => undefined, reviewSummary: () => ({}),
    open: async () => { writes++; return {} },
    recordSources: async () => { receipts++ },
    prepare: () => new Promise(resolve => { finishRecovery = resolve }),
  }
  const stop = mountInvestigationTools({
    tools: { register: register(tools) }, systemPrompt: { context: register(contexts) },
    on: (name, handler) => hooks.set(name, handler),
  }, service, shared)
  t.after(stop)
  const name = 'prts-terrarchive:investigations'
  const agent = { session: { id: 'same-session' } }
  for (const uiSkin of ['harness', 'prts-agent', 'endfield-aic']) {
    await shared.saveConfig({ uiSkin })
    assert.equal(tools.size, 0)
    assert(!contexts.has(name))
    hooks.get('tools/result')({ agent, name: 'web_search', callId: uiSkin }, {
      value: { sources: [{ url: `https://example.com/${uiSkin}`, title: '实际返回资料' }] },
    })
  }
  assert.equal(receipts, 3, 'passive archives survive ordinary chat without opening a board')
  assert.match(contexts.get('prts-terrarchive:conversation-interface').text(), /历史消息中的调查板工作流当前不适用/)
  await shared.saveConfig({ uiSkin: 'rhine-lab' })
  assert.equal(tools.size, 5)
  assert.match(contexts.get(name).text({ scope: agent }), /prts-investigation/)
  const queued = tools.get('investigation_open')
  await queued.execute({}, { agent })
  assert.equal(writes, 1)
  // Host and Agent configs are separate snapshots. Even before the watcher
  // removes a borrowed definition, executing it must recheck the saved skin.
  const hostConfig = createSharedState({ configPath: join(home, 'config.json'), releasesDir: home })
  await hostConfig.loadConfig()
  await hostConfig.saveConfig({ uiSkin: 'endfield-aic' })
  assert.equal(tools.size, 5, 'the Agent still has its previous config snapshot')
  await assert.rejects(queued.execute({}, { agent }), { code: 'INVESTIGATION_SKIN_INACTIVE' })
  assert.equal(writes, 1)
  assert.equal(tools.size, 0, 'the saved skin is authoritative before filesystem notification')
  await shared.saveConfig({ uiSkin: 'rhine-lab' })
  const assembly = { contexts: [{ name, text: contexts.get(name).text({ scope: agent }) }] }
  const pending = hooks.get('system-prompt/assemble')(assembly, { scope: agent }, async () => assembly)
  await shared.saveConfig({ uiSkin: 'prts-agent' })
  finishRecovery()
  await pending
  assert.equal(assembly.contexts[0].text, '', 'a suspended assembly cannot restore the old board prompt')
  assert.equal(tools.size, 0)
  assert(!contexts.has(name))
  await assert.rejects(queued.execute({}, { agent }), { code: 'INVESTIGATION_SKIN_INACTIVE' })
  assert.equal(writes, 1)
  for (let n = 0; n < 3; n++) {
    await shared.saveConfig({ uiSkin: 'rhine-lab' })
    await shared.saveConfig({ uiSkin: 'rhine-lab', cacheShards: 24 + n })
    assert.equal(tools.size, 5)
    await shared.saveConfig({ uiSkin: 'harness' })
    assert.equal(tools.size, 0)
  }
  stop()
  await shared.saveConfig({ uiSkin: 'rhine-lab' })
  assert.equal(tools.size, 0, 'disposing the owner removes the subscription')
})
