/**
 * 用户问题的实体别名预识别。匹配器与浏览器端 EntityAliasAutomaton
 * 同构，数据源复用 entities 投影与 char_alias.txt。
 *
 * 这一层只把规范实体提示给 Agent，不改写工具参数、不自动加过滤器，
 * 也不维护候选排序或检索进度。
 */
import { buildAliasGroups } from './timeline.js'
import { loadEntityRelationCatalog } from './entity-routing.js'

const preparedRecognizers = new WeakMap()

const GAME_LABELS = Object.freeze({ arknights: '明日方舟', endfield: '终末地' })

// 实体表属于可更新资料，不是受信任的 prompt。所有进入 plugin user notice 的
// 字段必须保持单行、限长并转义标签边界，避免恶意资料闭合结构标签后伪造指令。
const promptData = (value, maximum = 160) => [...String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim()]
  .slice(0, maximum).join('')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;')

function cancelledError() {
  return Object.assign(new Error('实体预识别已取消'), { code: 'CANCELLED' })
}

function waitForPreparation(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(cancelledError())
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => finish(reject, cancelledError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    )
  })
}

function normalized(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
}

/** Browser 同源的 Aho-Corasick 实体别名匹配器。 */
export class EntityAliasAutomaton {
  constructor(groups = []) {
    this.nodes = [{ next: new Map(), fail: 0, outputs: [] }]
    for (const group of groups) {
      const canonical = String(group.canonical || '').trim()
      for (const rawAlias of group.aliases || []) {
        const alias = normalized(rawAlias)
        if (!canonical || !alias) continue
        let node = 0
        for (const character of alias) {
          if (!this.nodes[node].next.has(character)) {
            this.nodes[node].next.set(character, this.nodes.length)
            this.nodes.push({ next: new Map(), fail: 0, outputs: [] })
          }
          node = this.nodes[node].next.get(character)
        }
        this.nodes[node].outputs.push({ canonical, alias: String(rawAlias).trim(),
          games: [...new Set(group.games || [])], length: [...alias].length })
      }
    }
    const queue = []
    for (const child of this.nodes[0].next.values()) queue.push(child)
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const parent = queue[cursor]
      for (const [character, child] of this.nodes[parent].next) {
        queue.push(child)
        let failure = this.nodes[parent].fail
        while (failure && !this.nodes[failure].next.has(character)) failure = this.nodes[failure].fail
        this.nodes[child].fail = this.nodes[failure].next.get(character) ?? 0
        this.nodes[child].outputs.push(...this.nodes[this.nodes[child].fail].outputs)
      }
    }
  }

  match(text) {
    const characters = [...normalized(text)]
    const found = []
    let node = 0
    for (let index = 0; index < characters.length; index += 1) {
      const character = characters[index]
      while (node && !this.nodes[node].next.has(character)) node = this.nodes[node].fail
      node = this.nodes[node].next.get(character) ?? 0
      for (const output of this.nodes[node].outputs) {
        const start = index - output.length + 1
        // 单字别名在普通句子中误报率过高；仅当整个输入就是该字时保留。
        if (output.length === 1 && characters.length > 1) continue
        found.push({ canonical: output.canonical, alias: output.alias, games: output.games,
          start, end: index + 1 })
      }
    }
    found.sort((left, right) => left.start - right.start
      || (right.end - right.start) - (left.end - left.start)
      || left.canonical.localeCompare(right.canonical, 'zh-CN'))
    const selected = []
    for (const match of found) {
      if (selected.some((item) => match.start >= item.start && match.end <= item.end
        && !(match.start === item.start && match.end === item.end))) continue
      if (selected.some((item) => match.start === item.start && match.end === item.end
        && match.canonical === item.canonical)) continue
      selected.push(match)
    }
    return selected
  }
}

/** 模式准入阶段预热并按 store + dataVersion 共享只读 AC 自动机。 */
export async function prepareEntityRecognition(store, { signal } = {}) {
  if (signal?.aborted) throw cancelledError()
  await waitForPreparation(store.ready(), signal)
  const dataVersion = store.dataVersion
  let state = preparedRecognizers.get(store)
  if (!state || state.dataVersion !== dataVersion) {
    state = { dataVersion, automaton: null, promise: null }
    state.promise = Promise.resolve(store._aliasGroups || buildAliasGroups(store))
      .then((groups) => {
        if (store.dataVersion !== dataVersion) {
          if (preparedRecognizers.get(store) === state) preparedRecognizers.delete(store)
          return prepareEntityRecognition(store)
        }
        store._aliasGroups ||= groups
        state.automaton = new EntityAliasAutomaton(groups)
        return state.automaton
      })
      .catch((error) => {
        if (preparedRecognizers.get(store) === state) preparedRecognizers.delete(store)
        throw error
      })
    preparedRecognizers.set(store, state)
  }
  const automaton = await waitForPreparation(
    state.automaton ? Promise.resolve(state.automaton) : state.promise, signal)
  // 关系表与别名自动机一起预热，才能在 inbox claim 与 prompt assembly
  // 之间的同步窗口内生成完整的本轮动态上下文。
  await waitForPreparation(loadEntityRelationCatalog(store), signal)
  return automaton
}

export function isEntityRecognitionReady(store) {
  const state = preparedRecognizers.get(store)
  return Boolean(store.loaded && state?.dataVersion === store.dataVersion && state.automaton)
}

/** 资料版本变化后自动复用或重建 AC 自动机。 */
export function createEntityRecognizer(store) {
  return {
    async detect(text, { signal } = {}) {
      const automaton = await prepareEntityRecognition(store, { signal })
      if (signal?.aborted) throw cancelledError()
      const catalog = await loadEntityRelationCatalog(store)
      if (signal?.aborted) throw cancelledError()
      return detectEntities(automaton, catalog, text)
    }
  }
}

function detectEntities(automaton, catalog, text) {
  const matches = automaton.match(text)
  const normalizedText = normalized(text)
  const relationHints = []
  for (const row of catalog.retravelers || []) {
    const names = [row.endfield_name, row.terra_memory_prototype].filter(Boolean)
    if (names.some((name) => normalizedText.includes(normalized(name)))) {
      relationHints.push({ kind: 'retraveler_memory_prototype', ...row,
        query_terms: [...new Set([...names, '再旅者', '记忆原型'])] })
    }
  }
  for (const row of catalog.visual_parallels_without_lore_relation || []) {
    const names = [row.endfield_name, row.arknights_name].filter(Boolean)
    if (names.some((name) => normalizedText.includes(normalized(name)))) {
      relationHints.push({ kind: 'visual_parallel_without_lore_relation', ...row,
        query_terms: names })
    }
  }
  return { matches, entities: [...new Set(matches.map((item) => item.canonical))],
    relation_hints: relationHints }
}

/** 仅在后台预热已经完成时同步识别；prompt assembly 不能等待异步 I/O。 */
function detectPreparedEntities(store, text) {
  const state = preparedRecognizers.get(store)
  const catalog = store?._endfieldRelationCatalog
  if (!store?.loaded || !state?.automaton || state.dataVersion !== store.dataVersion
      || catalog?.dataVersion !== store.dataVersion) return null
  return detectEntities(state.automaton, catalog.value, text)
}

function messageText(message) {
  if (message?.source?.kind !== 'user') return ''
  return (message.content || []).filter((block) => block?.type === 'text')
    .map((block) => String(block.text || '')).filter(Boolean).join('\n')
}

function recognitionContext(result, enabledGames) {
  const aliases = new Map()
  for (const match of result.matches) {
    const value = aliases.get(match.canonical) || { aliases: new Set(), games: new Set() }
    value.aliases.add(match.alias)
    for (const game of match.games || []) value.games.add(game)
    aliases.set(match.canonical, value)
  }
  for (const hint of result.relation_hints || []) {
    if (hint.endfield_name) {
      const value = aliases.get(hint.endfield_name) || { aliases: new Set(), games: new Set() }
      value.aliases.add(hint.endfield_name)
      value.games.add('endfield')
      aliases.set(hint.endfield_name, value)
    }
    const arknightsName = hint.terra_memory_prototype || hint.arknights_name
    if (arknightsName) {
      const value = aliases.get(arknightsName) || { aliases: new Set(), games: new Set() }
      value.aliases.add(arknightsName)
      value.games.add('arknights')
      aliases.set(arknightsName, value)
    }
  }
  const lines = [...aliases].map(([canonical, value]) => {
    const ownership = [...value.games].map((game) => GAME_LABELS[game]).filter(Boolean)
    return `- ${promptData(canonical)} — ${ownership.length ? ownership.join(' + ') : '归属未确定'}` +
      `（问题中命中：${[...value.aliases].map((alias) => promptData(alias)).join('、')}）`
  })
  const enabled = enabledGames.map((game) => GAME_LABELS[game]).filter(Boolean)
  const relationLines = (result.relation_hints || []).map((hint) =>
    hint.kind === 'retraveler_memory_prototype'
      ? `- ${promptData(hint.endfield_name)}：再旅者；泰拉记忆原型=${promptData(hint.terra_memory_prototype || '未登记')}。检索词：${(Array.isArray(hint.query_terms) ? hint.query_terms : []).map((term) => promptData(term)).join('、')}。两者不是别名。`
      : `- ${promptData(hint.endfield_name)} / ${promptData(hint.arknights_name)}：仅登记外观相似；现有剧情没有关系证据，不得推断为再旅者或记忆原型。`)
  return [
    '<prts:retrieval-context>',
    `当前搭载资料：${enabled.join('、') || '无'}。`,
    ...(lines.length ? ['用户问题中识别到的规范实体与游戏归属：', ...lines] : []),
    ...relationLines,
    '</prts:retrieval-context>',
  ].join('\n')
}

function skillArguments(event) {
  if (event?.type !== 'tool/call' || event.data?.name !== 'skill') return null
  try { return JSON.parse(event.data.arguments) }
  catch { return null }
}

function hasVisibleRetrievalSkill(agent, messages) {
  if ((messages || []).some((message) => message?.source?.kind === 'skill-invocation'
      && message.source.name === 'prts-retrieval')) return true
  const session = agent?.session
  if (typeof session?.snapshotEvents !== 'function') return false
  const events = session.snapshotEvents()
  const visible = new Set(session.surface?.nodes || [])
  const calls = new Set(events.filter((event) => {
    const args = skillArguments(event)
    return args?.name === 'prts-retrieval'
  }).map((event) => event.data.callId))
  return events.some((event) => visible.has(event.seq) && (
    (event.type === 'user/message' && event.data?.source?.kind === 'skill-invocation'
      && event.data.source.name === 'prts-retrieval')
    || (event.type === 'tool/result' && calls.has(event.data?.message?.source?.callId)
      && event.data.message.isError !== true)))
}

/**
 * 把当前用户问题的实体结果贡献给 DSH 动态上下文快照。
 *
 * inbox claim 发生在 prompt assembly 之前，因此预热完成时可以同步切换到
 * 本轮实体；DSH 的 runtime-context 投影负责让新快照取代旧快照。Skill
 * 尚未加载时 provider 返回空串，实体块会等到 Skill 结果可见后的下一步。
 */
export function applyEntityRecognition(ctx, store, shared = null) {
  if (typeof ctx.on !== 'function' || typeof ctx.systemPrompt?.context !== 'function') return false
  const recognizer = createEntityRecognizer(store)
  const turns = new WeakMap()
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const text = messageText(message)
    if (!text) return
    const state = { turn, text, context: '' }
    turns.set(agent, state)
    const enabledGames = () => shared?.effective?.().enabledGames || ['arknights', 'endfield']
    const prepared = detectPreparedEntities(store, text)
    if (prepared) {
      state.context = recognitionContext(prepared, enabledGames())
      return
    }
    // 冷启动只影响当前第一次 assembly；异步结果会在本轮的下一次步骤或
    // 下一轮 assembly 生效。正常 Web 部署会在首问前完成后台预热。
    recognizer.detect(text).then((result) => {
      if (turns.get(agent) === state) state.context = recognitionContext(result, enabledGames())
    }).catch((error) => {
      if (turns.get(agent) !== state || error?.code === 'CANCELLED') return
      ctx.logger?.warn?.(`prts-corpus: 实体预识别失败，已跳过: ${error?.message ?? error}`)
      state.context = ''
    })
  })
  ctx.systemPrompt.context({
    name: 'prts-terrarchive:retrieval-entities',
    order: 1000,
    text: ({ scope }) => {
      const state = turns.get(scope)
      return state?.context && hasVisibleRetrievalSkill(scope, []) ? state.context : ''
    },
  })
  return true
}
