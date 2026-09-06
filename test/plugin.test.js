/**
 * 插件契约测试：以 cordis loader 的方式加载插件（动态 import → apply），
 * 断言注册出的 ToolDefinition 形态符合 dsh 宿主期望，并端到端执行工具调用。
 * （无需真实 dsh CLI；dsh 侧的最终加载由 dsh plugin add / --dump-config 验证）
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { CorpusStore } from '../src/store.js'
import { executeRead } from '../src/read.js'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const testDshHome = await mkdtemp(resolve(tmpdir(), 'prts-plugin-home-'))
const previousDshHome = process.env.DSH_HOME
process.env.DSH_HOME = testDshHome
after(async () => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  await rm(testDshHome, { recursive: true, force: true })
})

const LOCAL_CONFIG = Object.freeze({
  releasesDir: resolve(packageDir, 'data/releases'),
  download: { enabled: false },
  registerUi: false,
  enabledGames: ['arknights'],
})
const corpusTest = existsSync(resolve(LOCAL_CONFIG.releasesDir, 'current.json')) ? test : test.skip

function makeCtx() {
  const registered = []
  const promptContexts = []
  const eventListeners = new Map()
  const tools = {
    register: (definition) => {
      registered.push(definition)
      return () => {
        const index = registered.indexOf(definition)
        if (index >= 0) registered.splice(index, 1)
      }
    },
  }
  const effects = []
  let rpcHandler = null
  const ctx = {
    tools,
    on: (name, callback) => {
      const values = eventListeners.get(name) || []
      values.push(callback)
      eventListeners.set(name, values)
      return () => {
        const index = values.indexOf(callback)
        if (index >= 0) values.splice(index, 1)
      }
    },
    systemPrompt: { context: (definition) => {
      promptContexts.push(definition)
      return () => {
        const index = promptContexts.indexOf(definition)
        if (index >= 0) promptContexts.splice(index, 1)
      }
    } },
    connection: { rpc: { handle: (_channel, handler) => { rpcHandler = handler; return () => {} } } },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
      return dispose ?? (() => {})
    },
    inject: (dependencies, callback) => {
      if (dependencies.includes('tools')) callback(ctx)
      else if (dependencies.includes('connection')) callback(ctx)
    },
    logger: { warn: () => {}, info: () => {} },
  }
  return {
    registered,
    promptContexts,
    ctx,
    get rpcHandler() { return rpcHandler },
    dispose: () => { for (const effect of effects.splice(0).reverse()) effect() },
  }
}

async function collectSearchDocuments(searchTool, request) {
  const documents = []
  let page = await searchTool.execute(request, {})
  for (let calls = 0; ; calls += 1) {
    assert.ok(calls < 100, 'corpus_search title continuation chain did not exhaust')
    documents.push(...page.documents)
    if (page.page.exhausted) return { documents, final: page }
    assert.ok(page.page.next_after?.title)
    page = await searchTool.execute({ ...request, after: page.page.next_after }, {})
  }
}

test('未安装资料时仍可挂载 preset，本地工具统一提示用户前往设置安装', async () => {
  const plugin = await import('../src/index.js')
  const dir = await mkdtemp(resolve(tmpdir(), 'prts-preset-admission-'))
  const fixture = makeCtx()
  try {
    await plugin.apply(fixture.ctx, {
      releasesDir: resolve(dir, 'releases'),
      registerUi: false,
      download: { enabled: false },
    })
    assert.deepEqual(fixture.registered.map((item) => item.name),
      ['corpus_search', 'corpus_read', 'timeline_search'])
    for (const tool of fixture.registered) {
      await assert.rejects(tool.execute({}, {}), (error) => error.code === 'CORPUS_NOT_INSTALLED'
        && /本地数据包暂未安装.*提醒用户.*设置.*安装/.test(error.message))
    }
  } finally {
    fixture.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Host UI 同时等待 connection 与 webServer，避免 AIC 地图路由漏挂', async () => {
  const plugin = await import('../src/index.js')
  const dependencies = []
  await plugin.apply({
    inject: (required) => { dependencies.push(required) },
    effect: () => () => {},
    logger: { warn: () => {}, info: () => {} },
  }, { registerTools: false, registerUi: true })
  assert.deepEqual(dependencies, [['connection', 'webServer']])
})

test('releasesDir 拒绝 DSH_HOME 等宽目录，避免 UI 删除误伤宿主文件', async () => {
  const plugin = await import('../src/index.js')
  const fixture = makeCtx()
  try {
    await assert.rejects(plugin.apply(fixture.ctx, {
      releasesDir: testDshHome, registerTools: false, registerUi: false,
    }), (error) => error.code === 'INVALID_CONFIG' && /宽目录/u.test(error.message))
  } finally {
    fixture.dispose()
  }
})

test('默认配置注册本地三工具与动态实体上下文，schema 在 DSH 支持子集内', async () => {
  const plugin = await import('../src/index.js')

  // cordis 插件要素：name + async apply；可选能力通过 ctx.inject 随服务生命周期挂载
  assert.equal(plugin.name, 'prts-corpus')
  assert.equal(plugin.inject, undefined)
  assert.equal(typeof plugin.apply, 'function')

  const { registered, promptContexts, ctx, dispose } = makeCtx()
  await plugin.apply(ctx, LOCAL_CONFIG)

  assert.deepEqual(registered.map((item) => item.name),
    ['corpus_search', 'corpus_read', 'timeline_search'])
  assert.equal(promptContexts.length, 1)
  assert.equal(promptContexts[0].name, 'prts-terrarchive:retrieval-entities')
  assert.equal(promptContexts[0].text({ scope: {} }), '')

  const tool = registered.find((item) => item.name === 'corpus_read')
  assert.equal(typeof tool.description, 'string')
  assert.ok(tool.description.length > 50)
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.required, undefined)
  assert.equal(tool.parameters.properties.ref, undefined)
  assert.equal(tool.parameters.properties.document_uid.type, 'string')
  assert.match(tool.description, /document_uid.*替代 title.*不得同时提交 title/u)
  assert.match(tool.parameters.properties.title.description, /不得与 document_uid 同时提交/u)
  assert.match(tool.parameters.properties.document_uid.description, /替代 title.*不得与 title/u)
  assert.match(tool.parameters.properties.mode.description,
    /title 不会自动推断.*document_uid.*可自动推断单篇全文/u)
  assert.equal(tool.parameters.properties.activity_id, undefined)
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(typeof tool.output.presentationMeta, 'function')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(tool.isConcurrencySafe(), false, 'corpus_read 必须串行，才能依据已提交结果做读取覆盖去重')
  assert.equal(tool.presentCall({ stage_code: '15-17', story_part: 'before' }).title,
    '读取 PRTS 本地原文 · 明日方舟 · 15-17')
  const searchTool = registered.find((item) => item.name === 'corpus_search')
  assert.equal(searchTool.presentCall({ query: '提弗洛斯', games: ['endfield'] }).title,
    '搜索 PRTS 本地资料 · 终末地 · 提弗洛斯')
  const timelineTool = registered.find((item) => item.name === 'timeline_search')
  assert.equal(timelineTool.presentCall({ entity_names: ['凯尔希'] }).title,
    '搜索 PRTS 本地年表 · 明日方舟 · 凯尔希')

  // DSH ctx.tools 的 JSON Schema 子集不允许 anyOf/$defs/$ref/pattern/min*/max*
  const FORBIDDEN = ['anyOf', 'allOf', '$defs', '$ref', 'pattern',
    'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'multipleOf']
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return
    assert.equal(Array.isArray(node.type), false, `${path}.type 必须是 DSH 支持的单一字符串`)
    for (const key of FORBIDDEN) {
      assert.equal(node[key], undefined, `${path} 使用了不支持的关键字 ${key}`)
    }
    for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`)
  }
  for (const item of registered) {
    walk(item.parameters, `${item.name}.parameters`)
    walk(item.output.schema, `${item.name}.output.schema`)
  }
  dispose()
})

test('PRTS preset 等待异步 tools 子 fiber 完成后才宣告挂载成功', async () => {
  const plugin = await import('../src/index.js')
  const fixture = makeCtx()
  const immediateInject = fixture.ctx.inject
  fixture.ctx.inject = (dependencies, callback) => {
    if (!dependencies.includes('tools')) return immediateInject(dependencies, callback)
    return new Promise((resolve) => setTimeout(() => {
      callback(fixture.ctx)
      resolve()
    }, 20))
  }

  const mounting = plugin.apply(fixture.ctx, LOCAL_CONFIG)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(fixture.registered, [], '工具服务未就绪时 apply 不得提前完成或暴露半套工具')
  await mounting
  assert.deepEqual(fixture.registered.map((item) => item.name),
    ['corpus_search', 'corpus_read', 'timeline_search'])
  fixture.dispose()
})

test('配置 cloud.baseUrl 后注册五工具', async () => {
  const plugin = await import('../src/index.js')
  const { registered, ctx, dispose } = makeCtx()
  await plugin.apply(ctx, {
    ...LOCAL_CONFIG,
    cloud: { baseUrl: 'https://prts.chat', token: 'test-token' },
  })
  assert.deepEqual(registered.map((item) => item.name),
    ['corpus_search', 'corpus_read', 'timeline_search', 'cloud_search', 'cloud_inspect'])
  const cloudSearch = registered.find((item) => item.name === 'cloud_search')
  assert.deepEqual(cloudSearch.parameters.required, ['query'])
  assert.equal(cloudSearch.timeoutMs, 180_000)
  assert.equal(cloudSearch.presentCall({ query: '提丰和提弗洛斯的关系',
    games: ['arknights', 'endfield'] }).title,
  '搜索 PRTS 云端资料 · 明日方舟 + 终末地 · 提丰和提弗洛斯的关系')
  const cloudInspect = registered.find((item) => item.name === 'cloud_inspect')
  assert.equal(cloudInspect.presentCall({ section: 'selected_sources', games: ['endfield'] }).title,
    '查看 PRTS 云端检索详情 · 终末地')
  dispose()
})

test('设置 RPC 修改 cloudEnabled 后云端工具热注册/注销', async () => {
  const plugin = await import('../src/index.js')
  const fixture = makeCtx()
  await plugin.apply(fixture.ctx, { ...LOCAL_CONFIG, registerUi: true })
  assert.deepEqual(fixture.registered.map((item) => item.name),
    ['corpus_search', 'corpus_read', 'timeline_search'])

  const enabled = await fixture.rpcHandler('config.update', {
    patch: { cloudEnabled: true, cloudBaseUrl: 'https://prts.chat' },
  })
  assert.equal(enabled.ok, true)
  assert.deepEqual(fixture.registered.map((item) => item.name),
    ['corpus_search', 'corpus_read', 'timeline_search', 'cloud_search', 'cloud_inspect'])

  const disabled = await fixture.rpcHandler('config.update', { patch: { cloudEnabled: false } })
  assert.equal(disabled.ok, true)
  assert.deepEqual(fixture.registered.map((item) => item.name),
    ['corpus_search', 'corpus_read', 'timeline_search'])
  fixture.dispose()
})

test('PRTS 检索策略注册为按需 skill，不注入 system prompt', async () => {
  const skill = await import('../src/skill.js')
  const registered = []
  const dispose = () => {}
  const result = await skill.apply({ skills: { register: (value) => {
    registered.push(value)
    return dispose
  } } })
  assert.equal(skill.name, 'prts-retrieval-skill')
  assert.deepEqual(skill.inject, ['skills'])
  assert.equal(result, dispose)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'prts-retrieval')
  assert.equal(registered[0].source, 'bundled')
  assert.equal(registered[0].provider, 'prts-terrarchive')
  assert.equal(registered[0].resourceBase.kind, 'directory')
  assert.match(registered[0].description, /明日方舟：终末地/)
  assert.match(registered[0].description, /跨游戏关系/)
  assert.match(registered[0].content, /本次会话的资料范围/)
  assert.match(registered[0].content, /只适用于当前动态上下文快照对应的用户问题/u)
  assert.match(registered[0].content, /不得把前一轮的实体或关系提示沿用到新问题/u)
  assert.match(registered[0].content, /按问题选择最短路线/)
  assert.match(registered[0].content, /默认 `cloud_search` 发现候选/)
  assert.match(registered[0].content, /零命中只表示当前查询未命中/)
  assert.match(registered[0].content, /不得静默替代游戏资料证据/)
  assert.match(registered[0].content, /当前模块：明日方舟/)
  assert.match(registered[0].content, /当前模块：明日方舟：终末地/)
  assert.match(registered[0].content, /当前模式：双模块联合检索/)
  assert.match(registered[0].content, /当前工具契约/)
  assert.match(registered[0].content, /# 推荐检索过程/)
  assert.match(registered[0].content, /# 双模块检索配方/)
  assert.match(registered[0].content, /关卡代号.*stage_code.*story_part/u)
  assert.match(registered[0].content, /collection_name.*mode:"collection"/u)
  for (const call of [
    'corpus_search({games:["arknights"], resource_types:["character_activity_wiki"], character_names:[角色]})',
    'corpus_search({games:["arknights"], resource_types:["character_activity_wiki"], activity_names:[活动]})',
    'corpus_search({games:["arknights"], resource_types:["character_activity_wiki"], character_names:[角色], activity_names:[活动]})',
  ]) assert.ok(registered[0].content.includes(call), `默认 Skill 缺少角色—活动关系配方：${call}`)
  assert.match(registered[0].content,
    /保持原条件翻页到 `page\.exhausted=true`；零命中只表示当前资料版本/u)
  assert.doesNotMatch(registered[0].content, /# 明日方舟检索配方/)
  assert.doesNotMatch(registered[0].content, /# 终末地检索配方/)
  assert.match(registered[0].content, /可以直接支持.*这一有限结论/)
  assert.match(registered[0].content, /无需强求游戏剧情重复证明该登记/)
  assert.match(registered[0].content, /不要发送[\s\S]*`scene_search`/)
})

test('PRTS Skill catalog 保持双游戏可发现，正文标明当前启用范围', async () => {
  const configPath = resolve(testDshHome, 'prts-corpus.json')
  await writeFile(configPath, JSON.stringify({ enabledGames: ['endfield'] }))
  try {
    const skill = await import('../src/skill.js')
    const registered = []
    await skill.apply({ skills: { register(value) { registered.push(value); return () => {} } } })
    assert.equal(registered.length, 1)
    assert.match(registered[0].description, /明日方舟：终末地/)
    assert.match(registered[0].description, /跨游戏关系/)
    assert.match(registered[0].content, /会话创建时启用：\*\*明日方舟：终末地\*\*/)
    assert.match(registered[0].content, /当前模块：明日方舟：终末地/)
    assert.doesNotMatch(registered[0].content, /# 当前模块：明日方舟\n/)
    assert.doesNotMatch(registered[0].content, /当前模式：双模块联合检索/)
    assert.match(registered[0].content, /`original_story`/)
    assert.match(registered[0].content, /# 推荐检索过程/)
    assert.match(registered[0].content, /# 终末地检索配方/)
    assert.doesNotMatch(registered[0].content, /# 明日方舟检索配方/)
    assert.doesNotMatch(registered[0].content, /# 双模块检索配方/)
    assert.doesNotMatch(registered[0].content, /retraveler_relations/)
    assert.doesNotMatch(registered[0].content, /character_activity_wiki/)
    assert.match(registered[0].content, /稳定定位字段已经足够时直接读取，不要先搜索标题/u)
  } finally {
    await rm(configPath, { force: true })
  }
})

test('PRTS Skill 仅启用明日方舟时不装配终末地与双模块说明', async () => {
  const skill = await import('../src/skill.js')
  const registered = []
  await skill.apply({ skills: { register(value) { registered.push(value); return () => {} } } },
    { enabledGames: ['arknights'] })
    assert.match(registered[0].content, /# 当前模块：明日方舟\n/)
    assert.doesNotMatch(registered[0].content, /当前模块：明日方舟：终末地/)
    assert.doesNotMatch(registered[0].content, /当前模式：双模块联合检索/)
    assert.match(registered[0].content, /`operator_record`/)
    assert.match(registered[0].content, /当前工具契约/)
    assert.match(registered[0].content, /# 推荐检索过程/)
    assert.match(registered[0].content, /# 明日方舟检索配方/)
    assert.match(registered[0].content, /稳定定位字段已经足够时直接读取，不要先搜索标题/u)
    assert.doesNotMatch(registered[0].content, /# 终末地检索配方/)
    assert.doesNotMatch(registered[0].content, /# 双模块检索配方/)
    assert.doesNotMatch(registered[0].content, /retraveler_relations/)
})

test.skip('legacy search/read 富响应兼容轨迹（v2 facade 已替换）', async () => {
  const plugin = await import('../src/index.js')
  const { registered, ctx, dispose } = makeCtx()
  await plugin.apply(ctx, LOCAL_CONFIG)
  const searchTool = registered.find((item) => item.name === 'corpus_search')
  const readTool = registered.find((item) => item.name === 'corpus_read')
  const timelineTool = registered.find((item) => item.name === 'timeline_search')

  // 1) 搜索命中 → 2) 用返回的稳定 ref 直读（同名标题也不会串文档）
  const searched = await searchTool.execute({
    query: '阿米娅', character_names: ['阿米娅'], max_results: 3,
  }, { signal: undefined })
  assert.equal(searched.status, 'ok')
  assert.ok(searched.hits.length > 0)
  assert.match(searched.hits[0].ref, /:L\d+$/)
  assert.match(searched.hits[0].document_uid, /^doc_[A-Za-z0-9_-]{16}$/)
  assert.ok(searched.hits[0].title, 'hit 应带完整 title 供 corpus_read 直读')
  assert.ok(Array.isArray(searched.hits[0].preview.lines))
  assert.equal(typeof searched.hits[0].preview.truncated, 'boolean')

  const agentA = { session: { events: [], surface: { nodes: [] } } }
  const markVisible = (callId, response) => {
    const seq = agentA.session.events.length
    agentA.session.events.push({ type: 'tool/result',
      data: { message: { source: { callId }, content: [{ isError: false,
        content: readTool.output.render({}, response) }] } } })
    agentA.session.surface.nodes.push(seq)
  }
  const result = await readTool.execute({
    title: searched.hits[0].title, document_uid: searched.hits[0].document_uid,
    line: searched.hits[0].match.line_number, before: 1, after: 1,
  }, { signal: undefined, agent: agentA, callId: 'read-original' })
  assert.equal(result.status, 'ok')
  assert.equal(result.contract_version, 'prts-corpus-tools-v1')
  assert.ok(result.content.lines.length >= 2)
  markVisible('read-original', result)

  // 同一 Agent 已完整读取的范围从内存证据账本回放；另一个 Agent 不共享正文状态。
  const repeatedRead = await readTool.execute({
    title: searched.hits[0].title, document_uid: searched.hits[0].document_uid,
    line: searched.hits[0].match.line_number, before: 1, after: 1,
  }, { signal: undefined, agent: agentA, callId: 'read-repeat' })
  assert.equal(repeatedRead.status, 'ok')
  assert.equal(repeatedRead.duplicate_read, true)
  assert.equal(repeatedRead.stats.reused_local_evidence, true)
  assert.match(readTool.output.render({}, repeatedRead)[0].text, /复用已核验原文/)

  // 部分重叠只补读未覆盖的尾部，不把旧行再次送入模型上下文。
  const extendAfter = result.document.line_count - result.selection.line_end >= 2
  const overlapStart = extendAfter ? Math.max(1, result.selection.line_end - 1)
    : Math.max(1, result.selection.line_start - 2)
  const overlapEnd = extendAfter ? result.selection.line_end + 2
    : Math.min(result.document.line_count, result.selection.line_start + 1)
  const partialRead = await readTool.execute({
    title: searched.hits[0].title, document_uid: searched.hits[0].document_uid,
    mode: 'range', start_line: overlapStart, end_line: overlapEnd,
  }, { signal: undefined, agent: agentA, callId: 'read-partial' })
  assert.equal(partialRead.status, 'ok')
  assert.equal(partialRead.partial_read_reused, true)
  assert.equal(partialRead.coverage.complete, true)
  assert.ok(partialRead.coverage.reused_ranges.length >= 1)
  assert.ok(partialRead.content.lines.every((line) => line.line_number < result.selection.line_start
    || line.line_number > result.selection.line_end))
  assert.match(readTool.output.render({}, partialRead)[0].text, /旧行就在上方可见工具结果中/)
  markVisible('read-partial', partialRead)

  const coveredAfterPartial = await readTool.execute({
    title: searched.hits[0].title, document_uid: searched.hits[0].document_uid,
    mode: 'range', start_line: overlapStart, end_line: overlapEnd,
  }, { signal: undefined, agent: agentA, callId: 'read-covered' })
  assert.equal(coveredAfterPartial.duplicate_read, true)

  // 上下文压缩移除了最初原文结果后，内存里虽有旧行，也不得声称“就在上面”。
  agentA.session.surface.nodes = [1] // 只保留 read-partial；read-original 已不在模型可见 surface
  const afterCompaction = await readTool.execute({
    title: searched.hits[0].title, document_uid: searched.hits[0].document_uid,
    line: searched.hits[0].match.line_number, before: 1, after: 1,
  }, { signal: undefined, agent: agentA, callId: 'read-after-compaction' })
  assert.equal(afterCompaction.status, 'ok')
  assert.equal(afterCompaction.duplicate_read, undefined)
  assert.equal(afterCompaction.partial_read_reused, undefined)
  const otherAgentRead = await readTool.execute({
    title: searched.hits[0].title, document_uid: searched.hits[0].document_uid,
    line: searched.hits[0].match.line_number, before: 1, after: 1,
  }, { signal: undefined, agent: {} })
  assert.equal(otherAgentRead.status, 'ok')
  assert.equal(otherAgentRead.duplicate_read, undefined)

  // 角色 Wiki 用角色过滤精确定位；读取命中 ref 后不能落到同名实体资料。
  const wiki = await searchTool.execute({
    resource_types: ['character_wiki'], character_names: ['凯尔希'], max_results: 5,
  }, { signal: undefined })
  assert.equal(wiki.status, 'ok')
  assert.equal(wiki.hits.length, 1)
  assert.equal(wiki.hits[0].title, '凯尔希')
  const wikiRead = await readTool.execute({ title: wiki.hits[0].title,
    document_uid: wiki.hits[0].document_uid, mode: 'document', max_lines: 5 },
    { signal: undefined })
  assert.equal(wikiRead.status, 'ok')
  assert.equal(wikiRead.document.document_type, 'knowledge')
  assert.equal(wikiRead.document.document_kind, 'wiki')

  // 角色页字段级检索：直接回答“参加过哪些活动”，不再整页盲读。
  const activities = await searchTool.execute({ resource_types: ['character_wiki'],
    character_names: ['凯尔希'], wiki_sections: ['相关活动'], max_results: 5 },
  { signal: undefined })
  assert.equal(activities.status, 'ok')
  assert.equal(activities.hits.length, 1)
  assert.equal(activities.hits[0].match.wiki_section, '相关活动')
  assert.equal(activities.hits[0].match.section_start, 107)
  assert.equal(activities.hits[0].match.section_end, 125)
  const activitiesRead = await readTool.execute({ title: activities.hits[0].title,
    document_uid: activities.hits[0].document_uid, mode: 'section', section: '相关活动' },
  { signal: undefined })
  assert.equal(activitiesRead.status, 'ok')
  assert.equal(activitiesRead.selection.wiki_section, '相关活动')
  assert.equal(activitiesRead.content.lines[0].text.startsWith('巴别塔：'), true)
  assert.equal(activitiesRead.content.lines.at(-1).text.startsWith('直到大地变成一颗酸橙：'), true)
  assert.ok(activitiesRead.content.lines.every((line) => !/<\/?相关活动>/u.test(line.text)))

  // 活动 Wiki：按活动名 + 字段组合，角色概括可继续叠加 query。
  const keyPeople = await searchTool.execute({ resource_types: ['story_wiki'],
    activity_names: ['孤星'], wiki_sections: ['关键人物'], max_results: 5 },
  { signal: undefined })
  assert.equal(keyPeople.status, 'ok')
  assert.equal(keyPeople.hits.length, 1)
  assert.equal(keyPeople.hits[0].wiki_role, 'story')
  assert.equal(keyPeople.hits[0].match.wiki_section, '关键人物')
  assert.match(keyPeople.hits[0].preview.lines.map((line) => line.text).join('\n'), /凯尔希/u)

  const kaltsitInLoneTrail = await searchTool.execute({ query: '凯尔希',
    resource_types: ['story_wiki'], activity_names: ['孤星'],
    wiki_sections: ['角色剧情概括'], max_results: 5 }, { signal: undefined })
  assert.equal(kaltsitInLoneTrail.status, 'ok')
  assert.equal(kaltsitInLoneTrail.hits.length, 1)
  assert.equal(kaltsitInLoneTrail.hits[0].match.wiki_section, '角色剧情概括')

  // 角色×活动辅助 Wiki 的角色名来自正文“名称:”字段，活动名来自展示标题。
  const auxiliary = await searchTool.execute({ resource_types: ['character_activity_wiki'],
    character_names: ['卡罗琳'], activity_names: ['雪山降临1101'],
    wiki_sections: ['相关剧情总结'], max_results: 5 }, { signal: undefined })
  assert.equal(auxiliary.status, 'ok')
  assert.equal(auxiliary.hits.length, 1)
  assert.equal(auxiliary.hits[0].wiki_role, 'character_activity')
  assert.equal(auxiliary.hits[0].match.wiki_section, '相关剧情总结')

  // Harness 严格 lossless-JSON 边界：普通剧情命中不得携带 undefined。
  const story = await searchTool.execute({ query: '重生', resource_types: ['story'], max_results: 20 },
    { signal: undefined })
  assert.equal(story.status, 'ok')
  const visit = (value, path = '$') => {
    assert.notEqual(value, undefined, `${path} 不得为 undefined`)
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}[${index}]`))
    else Object.entries(value).forEach(([key, item]) => visit(item, `${path}.${key}`))
  }
  visit(story)
  visit(wikiRead)
  assert.ok(story.hits.every((hit) => hit.hit_id && hit.document_uid))
  assert.ok(result.normalized_request.locator.document_id)
  const blocks = readTool.output.render({}, result)
  assert.equal(blocks[0].type, 'text')
  assert.ok(blocks[0].text.includes('阿米娅'))
  const searchBlocks = searchTool.output.render({}, searched)
  assert.match(searchBlocks[0].text, /可读取位置：《.+》第 \d+ 行/)

  // 相同 DSH callId 重试返回同一份结果；换参数不得复用旧调用。
  const idempotentArgs = { query: '重生', resource_types: ['story'], max_results: 2 }
  const firstCall = await searchTool.execute(idempotentArgs, { callId: 'search-idempotent' })
  const repeatedCall = await searchTool.execute(idempotentArgs, { callId: 'search-idempotent' })
  assert.deepEqual(repeatedCall, firstCall)
  const rebound = await searchTool.execute({ ...idempotentArgs, query: '凯尔希' },
    { callId: 'search-idempotent' })
  assert.equal(rebound.status, 'error')
  assert.equal(rebound.error.code, 'INVALID_REQUEST')

  // around 缺 line → 参数级 error 响应（不抛异常）
  const missingLine = await readTool.execute({ title: searched.hits[0].title }, { signal: undefined })
  assert.equal(missingLine.status, 'error')
  assert.equal(missingLine.error.code, 'INVALID_REQUEST')

  // 3) 时间线：活动过滤 + 标记反查
  const timeline = await timelineTool.execute({
    activity_names: ['不义之财'], max_results: 5,
  }, { signal: undefined })
  assert.equal(timeline.status, 'ok')
  assert.equal(timeline.mode, 'search')
  assert.ok(timeline.events.length > 0)
  assert.match(timeline.events[0].source_marker, /^年表出处:tle_[0-9a-f]{24}$/)
  visit(timeline)

  const lookup = await timelineTool.execute({
    source_marker: timeline.events[0].source_marker,
  }, { signal: undefined })
  assert.equal(lookup.status, 'ok')
  assert.equal(lookup.mode, 'source')
  assert.equal(lookup.event.event, timeline.events[0].event)
  assert.ok(lookup.provenance.sources !== undefined)
  visit(lookup)

  // 改进后的实体场景检索：排除一行式 [uc] synopsis，并把同篇相邻命中聚类。
  const entityScenes = await searchTool.execute({ entity_names: ['凯尔希'],
    resource_types: ['story'], max_results: 40 }, { signal: undefined })
  assert.equal(entityScenes.status, 'ok')
  assert.ok(entityScenes.hits.length > 0)
  assert.ok(entityScenes.hits.every((hit) => !hit.title.startsWith('[uc]info/')))
  const perDocument = entityScenes.hits.reduce((counts, hit) => {
    counts[hit.document_uid] = (counts[hit.document_uid] || 0) + 1
    return counts
  }, {})
  assert.ok(Object.values(perDocument).every((count) => count <= 3))
  assert.ok(entityScenes.hits.some((hit) => hit.match.evidence_kind))
  dispose()
})

corpusTest('v4 facade：可穷尽按文档搜索、完整 Wiki 字段、自然读取与标题锚点', async () => {
  const plugin = await import('../src/index.js')
  const { registered, ctx, dispose } = makeCtx()
  await plugin.apply(ctx, LOCAL_CONFIG)
  try {
    const searchTool = registered.find((item) => item.name === 'corpus_search')
    const readTool = registered.find((item) => item.name === 'corpus_read')
    const timelineTool = registered.find((item) => item.name === 'timeline_search')
    assert.equal(searchTool.parameters.properties.max_results, undefined)
    assert.deepEqual(searchTool.parameters.properties.match_mode.enum, ['literal', 'regex'])
    assert.deepEqual(searchTool.parameters.properties.after.required,
      ['data_version', 'resource_type', 'title', 'position'])
    assert.equal(searchTool.parameters.properties.after.properties.data_version.type, 'string')
    assert.deepEqual(readTool.parameters.properties.story_part.enum, ['before', 'after', 'story'])

    // 明日方舟关卡剧情不再要求模型拼接“活动 · 代号 · 篇名 · 行动前后”。
    const stageAround = await readTool.execute({ stage_code: 'bb－7', story_part: 'before',
      line: 137, before: 1, after: 1 }, { agent: {}, callId: 'v2-read-stage-around' })
    assert.equal(stageAround.primary.title, '巴别塔 · BB-7 · 阴影显现 · 行动前')
    assert.equal(stageAround.primary.stage_code, 'BB-7')
    assert.equal(stageAround.primary.story_part, 'before')
    assert.equal(stageAround.primary.selection.line_start, 136)
    assert.equal(stageAround.primary.selection.line_end, 138)

    const chapterStage = await readTool.execute({ stage_code: '15-17', story_part: 'after',
      line: 1, before: 0, after: 0 }, { agent: {}, callId: 'v2-read-stage-main' })
    assert.equal(chapterStage.primary.title, '离解复合 · 15-17 · “她” · 行动后')

    // 只有一篇的纯剧情关无需再伪造行动前/后；幕间统一使用公开值 story。
    const storyOnlyStage = await readTool.execute({ stage_code: 'TW-ST-1', max_lines: 2 },
      { agent: {}, callId: 'v2-read-stage-story-only' })
    assert.equal(storyOnlyStage.primary.story_part, 'story')
    assert.match(storyOnlyStage.primary.title, /TW-ST-1/u)

    // 多段密录必须显式段号，标题和续页也保留段号。
    await assert.rejects(() => readTool.execute({ character_name: '安洁莉娜',
      record_name: '没写收件人的包裹' }, { agent: {}, callId: 'v2-record-ambiguous' }),
    (error) => error?.code === 'DOCUMENT_AMBIGUOUS' && /segment/u.test(error.message))
    const operatorRecord = await readTool.execute({ character_name: '安洁莉娜',
      record_name: '没写收件人的包裹', segment: 2, max_lines: 2 },
    { agent: {}, callId: 'v2-record-segment' })
    assert.match(operatorRecord.primary.title, /第 2 段 · 正文/u)
    assert.equal(operatorRecord.page.continuation.segment, 2)

    const characterProfile = await readTool.execute({ character_name: '凯尔希',
      material: 'profile', max_lines: 2 }, { agent: {}, callId: 'v2-character-profile' })
    assert.equal(characterProfile.primary.title, '凯尔希 / 干员档案')
    assert.equal(characterProfile.page.continuation.material, 'profile')

    const activityPage = await readTool.execute({ activity_name: '骑兵与猎人',
      mode: 'activity', max_lines: 2 }, { agent: {}, callId: 'v2-activity-page' })
    assert.equal(activityPage.primary.kind, 'official_story_collection')
    assert.deepEqual(activityPage.page.continuation, {
      activity_name: '骑兵与猎人', mode: 'activity', position: 3,
      data_version: activityPage.presentation.data_version,
    })
    assert.equal(activityPage.primary.lines[0].document_title.includes('GT-1'), true)
    assert.doesNotMatch(readTool.output.render({}, activityPage)[0].text, /cursor/u)

    const stagePage1 = await readTool.execute({ stage_code: 'gt-3', story_part: 'after',
      mode: 'document', max_lines: 2 }, { agent: {}, callId: 'v2-read-stage-page-1' })
    assert.deepEqual(stagePage1.page.continuation, {
      stage_code: 'GT-3', story_part: 'after', mode: 'document', line: 3,
      data_version: stagePage1.presentation.data_version,
    })
    const stagePage2 = await readTool.execute(stagePage1.page.continuation,
      { agent: {}, callId: 'v2-read-stage-page-2' })
    assert.equal(stagePage2.primary.title, '骑兵与猎人 · GT-3 · 意外之旅 · 行动后')
    assert.equal(stagePage2.primary.lines[0].line, 3)
    assert.match(readTool.output.render({}, stagePage1)[0].text,
      /corpus_read\(\{"stage_code":"GT-3","story_part":"after","mode":"document","line":3,"data_version":"[0-9a-f]{64}"\}\)/u)
    await assert.rejects(() => readTool.execute({ ...stagePage1.page.continuation,
      data_version: '0'.repeat(64) }, { agent: {}, callId: 'v2-read-stage-wrong-version' }),
    (error) => error?.code === 'PACKAGE_VERSION_MISMATCH')

    const chapterTimeline = await timelineTool.execute({ query: '第17章' }, {})
    assert.equal(chapterTimeline.status, 'ok')
    assert.ok(chapterTimeline.events.length > 0)
    assert.ok(chapterTimeline.events.every((event) => event.activity_name === '相变临界'))
    assert.ok(chapterTimeline.events.some((event) => /^1102 年/u.test(event.time)))
    assert.match(timelineTool.output.render({}, chapterTimeline)[0].text, /1102 年/u)

    const chapterStory = await collectSearchDocuments(searchTool,
      { query: '妹妹', resource_types: ['story'], activity_names: ['第17章'], speakers: ['塔露拉'] })
    const chapterStoryDocuments = chapterStory.documents
    assert.ok(chapterStoryDocuments.some((item) => item.title.includes('17-13')))
    assert.equal(chapterStory.final.page.total_relation, 'eq')
    assert.equal(chapterStory.final.page.total_documents, chapterStoryDocuments.length)
    assert.equal(new Set(chapterStoryDocuments.map((item) => item.title)).size,
      chapterStoryDocuments.length)

    const distantSingleCharacter = await searchTool.execute({ query: '1070',
      resource_types: ['reference'], entity_names: ['陈'] }, {})
    assert.ok(distantSingleCharacter.documents.every((item) => item.title !== 'activity_timelines'))

    const branchRead = await readTool.execute({
      title: '离解复合 · 15-17 · “她” · 幕间 · 分支1', line: 30, before: 1, after: 1,
    }, { agent: {}, callId: 'v2-read-branch' })
    assert.equal(branchRead.primary.title, '离解复合 · 15-17 · “她” · 幕间 · 分支1')

    const searched = await searchTool.execute({ query: '重生', resource_types: ['story'] }, {})
    assert.equal(searched.result_kind, 'text_matches')
    assert.ok(searched.documents.length > 0)
    assert.ok(searched.documents.every((document) => !('document_uid' in document)))
    const document = searched.documents.find((item) => item.matches.length)
    const match = document.matches[0]
    assert.ok(match.excerpt.some((line) => line.role === 'match'))
    assert.match(match.citation, /^《.+》第 \d+(?:-\d+)? 行$/u)

    if (searched.page.next_after) {
      assert.match(searched.page.next_after.data_version, /^[0-9a-f]{64}$/u)
      assert.equal(searched.page.next_after.data_version, stagePage1.presentation.data_version)
      const next = await searchTool.execute({ query: '重生', resource_types: ['story'],
        after: searched.page.next_after }, {})
      assert.equal(next.result_kind, searched.result_kind)
    }

    const sections = await searchTool.execute({ resource_types: ['character_wiki'],
      character_names: ['凯尔希'], wiki_sections: ['相关活动'] }, {})
    assert.equal(sections.result_kind, 'complete_sections')
    assert.equal(sections.documents[0].section_content.completeness, 'complete')
    assert.match(sections.documents[0].section_content.blocks[0].text, /巴别塔/u)

    const entityProfiles = await collectSearchDocuments(searchTool,
      { query: '乌萨斯', resource_types: ['entity_profile'] })
    const ursus = entityProfiles.documents.find((item) => item.title === '乌萨斯 / 实体资料')
    assert.ok(ursus?.entity_summary)
    assert.match(ursus.entity_summary.description, /帝国/u)
    assert.equal(ursus.matches.length, 0)
    assert.doesNotMatch(searchTool.output.render({ query: '乌萨斯' },
      { ...entityProfiles.final, documents: entityProfiles.documents })[0].text,
      /canonical_name|"aliases"/u)

    // 同名的通用概念记录与完整实体专页不能形成模型无法解除的标题歧义。
    const snowPriestProfiles = await collectSearchDocuments(searchTool,
      { query: '雪祀', resource_types: ['entity_profile'] })
    assert.equal(snowPriestProfiles.documents.filter((item) =>
      item.title === '雪祀 / 实体资料').length, 1)
    const snowPriest = await readTool.execute({ title: '雪祀', mode: 'document',
      max_lines: 100, max_chars: 20000 }, { agent: {}, callId: 'v2-read-snow-priest' })
    assert.equal(snowPriest.primary.title, '雪祀 / 实体资料')
    assert.match(JSON.stringify(snowPriest.primary.lines), /history_summary/u)

    const wikiByNaturalTitle = await readTool.execute({ title: '凯尔希 / 角色 Wiki', section: '相关活动' },
      { agent: {}, callId: 'v2-read-wiki-natural-title' })
    assert.equal(wikiByNaturalTitle.primary.kind, 'wiki_curated')
    assert.match(wikiByNaturalTitle.primary.citation, /《凯尔希 \/ 角色 Wiki》Wiki·相关活动/u)

    await assert.rejects(() => readTool.execute({ title: '凯尔希 / 角色 Wiki', max_lines: 20 },
      { agent: {}, callId: 'v2-read-title-without-mode' }),
    (error) => error?.code === 'INVALID_REQUEST' && /max_lines\/max_chars.*不能代替读取方式/u.test(error.message))
    await assert.rejects(() => readTool.execute({ title: '凯尔希 / 角色 Wiki',
      document_uid: 'doc_0t23T_OgquiZQG8_', line: 1 },
    { agent: {}, callId: 'v2-read-title-and-uid' }),
    (error) => error?.code === 'INVALID_REQUEST' && /document_uid 会替代 title.*不要同时提交/u.test(error.message))

    const read = await readTool.execute({ title: document.title, line: match.line_start,
      before: 1, after: 1 }, { agent: {}, callId: 'v2-read' })
    assert.equal(read.primary.title, document.title)
    assert.ok(read.primary.lines.length >= 2)
    assert.ok(!JSON.stringify(read).includes('source_ref'))
    assert.ok(read.presentation.document_id)
    assert.equal(read.companions, undefined)
    const renderedRead = readTool.output.render({}, read)[0].text
    assert.match(renderedRead, /引用：《/u)
    assert.equal(renderedRead.includes(read.presentation.document_id), false)
    const readMeta = readTool.output.presentationMeta({}, read)
    assert.equal(readMeta.kind, 'prts-corpus-read-v1')
    assert.equal(readMeta.locator.document_id, read.presentation.document_id)
    assert.equal(readMeta.title, read.primary.title)

    const firstPage = await readTool.execute({ title: document.title, mode: 'document',
      max_lines: 2 }, { agent: {}, callId: 'v2-read-page-1' })
    assert.equal(firstPage.page.returned_lines, 2)
    assert.equal(firstPage.page.has_more, true)
    const expectedContinuation = firstPage.primary.stage_code
      ? { stage_code: firstPage.primary.stage_code, story_part: firstPage.primary.story_part,
          mode: 'document', line: firstPage.primary.selection.line_end + 1,
          data_version: firstPage.presentation.data_version }
      : { title: document.title, mode: 'document', line: firstPage.primary.selection.line_end + 1,
          data_version: firstPage.presentation.data_version }
    assert.deepEqual(firstPage.page.continuation, expectedContinuation)
    assert.equal(firstPage.page.next_cursor, undefined,
      '模型可见的读取结果不应暴露内部 cursor')
    assert.doesNotMatch(readTool.output.render({}, firstPage)[0].text, /cursor/u)
    assert.match(readTool.output.render({}, firstPage)[0].text,
      new RegExp(`继续阅读《${document.title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}》`, 'u'))
    const secondPage = await readTool.execute(firstPage.page.continuation,
      { agent: {}, callId: 'v2-read-page-2' })
    assert.equal(secondPage.primary.title, document.title)
    assert.equal(secondPage.primary.lines[0].line, firstPage.primary.selection.line_end + 1)
    assert.equal(secondPage.primary.selection.mode, 'document')

    // 已经写入旧会话的签名 cursor 仍可恢复，并允许模型附带自然标题及改变预算。
    const legacyStore = new CorpusStore({ releasesDir: LOCAL_CONFIG.releasesDir })
    await legacyStore.ready()
    const legacyDocument = await legacyStore.getDocumentByTitle(document.title)
    const legacyFirst = await executeRead(legacyStore, {
      intent_id: 'legacy-cursor', locator: { document_id: legacyDocument.record.document.document_id },
      selection: { mode: 'document' }, limits: { max_lines: 2 },
    }, {})
    const legacyNext = await readTool.execute({ title: document.title,
      cursor: legacyFirst.page.next_cursor, max_lines: 3 },
    { agent: {}, callId: 'v2-read-legacy-cursor' })
    assert.equal(legacyNext.primary.lines[0].line, 3)
    assert.equal(legacyNext.page.returned_lines, 3)
  } finally { dispose() }
})

corpusTest('v4 读取覆盖去重：完整复用、部分补读、压缩后重读与 Agent 隔离', async () => {
  const plugin = await import('../src/index.js')
  const { registered, ctx, dispose } = makeCtx()
  await plugin.apply(ctx, LOCAL_CONFIG)
  try {
    const searchTool = registered.find((item) => item.name === 'corpus_search')
    const readTool = registered.find((item) => item.name === 'corpus_read')
    const searched = await searchTool.execute({ query: '重生', resource_types: ['story'] }, {})
    assert.equal(searched.result_kind, 'text_matches')
    const document = searched.documents.find((item) => item.matches.some((match) => match.line_start))
    assert.ok(document, '应存在带行号命中的剧情文档')
    // 锚点留出前文余量，保证 before:4 的部分补读窗口完整落在文档内
    const anchor = Math.max(5, document.matches.find((match) => match.line_start).line_start)

    const agent = { session: { events: [], surface: { nodes: [] } } }
    const markVisible = (callId, response) => {
      const seq = agent.session.events.length
      agent.session.events.push({ type: 'tool/result',
        data: { message: { source: { callId }, content: [{ isError: false,
          content: readTool.output.render({}, response) }] } } })
      agent.session.surface.nodes.push(seq)
    }

    // 1) 首次读取（around ±1）
    const first = await readTool.execute({ title: document.title, line: anchor, before: 1, after: 1 },
      { agent, callId: 'dedup-read-1' })
    assert.equal(first.primary.title, document.title)
    assert.ok(first.primary.lines.length >= 1)
    markVisible('dedup-read-1', first)
    const coveredStart = first.primary.selection.line_start
    const coveredEnd = first.primary.selection.line_end

    // 2) 同一 Agent 重复读取已可见范围 → 回放同一范围，不向上下文重复注入
    const repeated = await readTool.execute({ title: document.title, line: anchor, before: 1, after: 1 },
      { agent, callId: 'dedup-read-2' })
    assert.equal(repeated.primary.title, document.title)
    assert.deepEqual(repeated.primary.lines.map((line) => line.line),
      first.primary.lines.map((line) => line.line))

    // 3) 部分重叠（around 前 4 行）→ 只返回未覆盖的新行，旧行不再送入模型
    const partial = await readTool.execute({ title: document.title, line: anchor, before: 4, after: 1 },
      { agent, callId: 'dedup-read-3' })
    assert.ok(partial.primary.lines.length >= 1, '部分补读应返回新读取行')
    assert.ok(partial.primary.lines.every((line) => line.line < coveredStart || line.line > coveredEnd),
      '补读不得重复返回已可见行')
    markVisible('dedup-read-3', partial)

    // 4) 上下文压缩清空可见 surface 后 → 重新完整读取，不得声称“在上面”
    agent.session.surface.nodes = []
    const afterCompaction = await readTool.execute({ title: document.title, line: anchor,
      before: 1, after: 1 }, { agent, callId: 'dedup-read-4' })
    assert.deepEqual(afterCompaction.primary.lines.map((line) => line.line),
      first.primary.lines.map((line) => line.line))

    // 5) 另一个 Agent 不共享证据状态：同一请求得到完整窗口而非补读
    const otherAgentRead = await readTool.execute({ title: document.title, line: anchor,
      before: 4, after: 1 }, { agent: { session: { events: [], surface: { nodes: [] } } },
      callId: 'dedup-read-5' })
    assert.equal(otherAgentRead.primary.selection.line_start, anchor - 4)
    assert.equal(otherAgentRead.primary.selection.line_end, anchor + 1)

    // 6) 相同 DSH callId 幂等；换参数不得复用旧调用绑定
    const idempotentArgs = { query: '重生', resource_types: ['story'] }
    const idempotentExec = { callId: 'search-idempotent' }
    const firstCall = await searchTool.execute(idempotentArgs, idempotentExec)
    const repeatedCall = await searchTool.execute(idempotentArgs, idempotentExec)
    assert.deepEqual(repeatedCall, firstCall)
    const rebound = await searchTool.execute({ ...idempotentArgs, query: '凯尔希' },
      idempotentExec)
    assert.equal(rebound.error?.code, 'INVALID_REQUEST')
  } finally { dispose() }
})

test('cordis.patch.yml 是合法 YAML 且引用本包', { skip: (() => { try { createRequire(import.meta.url).resolve('js-yaml'); return false } catch { return 'js-yaml 不可用' } })() }, () => {
  const yaml = require('js-yaml')
  const fs = require('node:fs')
  const doc = yaml.load(fs.readFileSync(resolve(packageDir, 'cordis.patch.yml'), 'utf8'))
  const row = doc[0].insert[0]
  assert.equal(row.id, 'prts-corpus')
  assert.equal(row.name, 'prts-terrarchive')
  assert.ok(typeof row.config.releasesDir === 'string')
})
