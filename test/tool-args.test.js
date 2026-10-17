import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { dropEmptyPlaceholders } from '../src/tool-args.js'
import { documentUid } from '../src/store.js'
import { zeroHitHints, projectSearch } from '../src/search-projection.js'
import { CloudFault, cloudFaultError } from '../src/cloud.js'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testDshHome = await mkdtemp(join(tmpdir(), 'prts-tool-args-'))
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
  const effects = []
  const ctx = {
    tools: { register: (definition) => {
      registered.push(definition)
      return () => { const index = registered.indexOf(definition); if (index >= 0) registered.splice(index, 1) }
    } },
    on: () => () => {},
    systemPrompt: { context: () => () => {} },
    connection: { rpc: { handle: () => () => {} }, fetch: { register: () => () => {} } },
    webServer: { register: () => () => {} },
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose); return dispose ?? (() => {}) },
    inject: (dependencies, callback) => {
      if (['tools', 'connection', 'webServer'].some((name) => dependencies.includes(name))) callback(ctx)
    },
    logger: { warn: () => {}, info: () => {} },
  }
  return { registered, ctx, dispose: () => { for (const effect of effects.splice(0).reverse()) effect() } }
}

test('dropEmptyPlaceholders 只删除明确的空占位', () => {
  assert.deepEqual(dropEmptyPlaceholders({
    query: '重生', cursor: '', after: {}, story_names: [], context_terms: ['', '  '],
    games: ['arknights'], match_mode: null, character_names: ['', '瓦列里奥'],
  }), { query: '重生', games: ['arknights'], character_names: ['瓦列里奥'] })
  // 全空的分页凭据（含 position: 0）整体视为占位
  assert.deepEqual(dropEmptyPlaceholders({ query: 'x',
    after: { data_version: '', resource_type: '', title: '', position: 0 } }), { query: 'x' })
  // 部分填写的分页凭据保留，交给执行层严格报错
  assert.deepEqual(dropEmptyPlaceholders({ after: { data_version: 'abc', position: 0 } }),
    { after: { data_version: 'abc', position: 0 } })
  // 0 只在显式列出的从 1 计数字段上删除
  assert.deepEqual(dropEmptyPlaceholders({ cursor: 0, event_sequence_from: 0, limit: 0, event_time_from: '' },
    { zeroFields: ['event_sequence_from', 'limit'] }), { cursor: 0 })
  assert.deepEqual(dropEmptyPlaceholders({ options: { search_intent: '' }, games: [] }), {})
  assert.equal(dropEmptyPlaceholders(null), null)
})

test('零命中提示按实际过滤条件解释强约束', () => {
  const hints = zeroHitHints({ query: '瓦列里奥', story_names: ['昨日海'], context_terms: ['海'] })
  assert.ok(hints.some((hint) => /前后 3 行/u.test(hint)))
  assert.ok(hints.some((hint) => /activity_names/u.test(hint)))
  assert.deepEqual(zeroHitHints({ query: '瓦列里奥' }), [])
  assert.deepEqual(zeroHitHints({ query: '瓦列里奥', context_terms: [''], story_names: [] }), [])
  const text = projectSearch({ result_kind: 'text_matches', documents: [],
    page: { exhausted: true, next_after: null } }, { args: { query: 'x', context_terms: ['y'] } })
  assert.match(text, /context_terms 是强约束/u)
})

test('cloudFaultError 带错误码与恢复指引，未知异常不泄露内部信息', () => {
  const invalid = cloudFaultError(new CloudFault('INVALID_REQUEST', 'event_time_from: Input should have timezone info'),
    'cloud_inspect')
  assert.equal(invalid.code, 'INVALID_REQUEST')
  assert.match(invalid.message, /^\[cloud_inspect:INVALID_REQUEST\] event_time_from/u)
  assert.match(invalid.message, /直接省略/u)
  const busy = cloudFaultError(new CloudFault('CLOUD_BUSY', 'busy', true), 'cloud_search')
  assert.equal(busy.retryable, true)
  assert.match(busy.message, /corpus_search/u)
  const internal = cloudFaultError(new TypeError('secret path /x/y'), 'cloud_search')
  assert.equal(internal.code, 'CLOUD_INTERNAL_ERROR')
  assert.doesNotMatch(internal.message, /secret/u)
})

test('云端工具：参数错误抛出（isError），空结果给出路线提示', async () => {
  const plugin = await import('../src/index.js')
  const { registered, ctx, dispose } = makeCtx()
  await plugin.apply(ctx, { ...LOCAL_CONFIG, cloud: { baseUrl: 'https://prts.chat', token: 'test-token' } })
  const inspect = registered.find((item) => item.name === 'cloud_inspect')
  const search = registered.find((item) => item.name === 'cloud_search')
  const props = inspect.parameters.properties
  assert.equal(props.candidate_ids, undefined, '模型拿不到候选 ID，不应暴露该过滤字段')
  assert.ok(props.source_types.items.enum.includes('vector_original'))
  assert.match(props.event_time_from.description, /时区/u)

  await assert.rejects(inspect.execute({ section: 'events', event_time_from: '2025-01-01 08:00:00' }, {}),
    (error) => error.code === 'INVALID_REQUEST' && /带时区/u.test(error.message))
  await assert.rejects(inspect.execute({ section: 'events', event_sequence_to: -1 }, {}),
    (error) => error.code === 'INVALID_REQUEST')

  const strictEmpty = search.output.render({ query: '瓦列里奥的经历',
    options: { search_intent: 'single_sentence_search' } }, { code: 200, data: { answer_context: '' } })
  assert.match(strictEmpty[0].text, /single_sentence_search/u)
  assert.match(strictEmpty[0].text, /corpus_search/u)
  const mixedEmpty = search.output.render({ query: 'x' }, { code: 200, data: {} })
  assert.doesNotMatch(mixedEmpty[0].text, /single_sentence_search/u)
  assert.match(mixedEmpty[0].text, /没有返回可用材料/u)
  const warningsOnly = search.output.render({ query: 'x', evidence_policy: 'original_only' },
    { code: 200, data: { answer_context: '', errors: [{ message: '向量通道超时' }] } })
  assert.match(warningsOnly[0].text, /original_only/u)
  assert.match(warningsOnly[0].text, /向量通道超时/u)
  const fellBack = search.output.render({ query: 'x', options: { search_intent: 'single_sentence_search' } },
    { code: 200, data: { answer_context: '', errors: [{ stage: 'route_fallback', message: '已自动改用默认混合路线' }] } })
  assert.doesNotMatch(fellBack[0].text, /重试一次/u)
  assert.match(fellBack[0].text, /已自动改用默认混合路线/u)
  assert.match(fellBack[0].text, /corpus_search/u)
  await assert.rejects(inspect.execute({ section: 'events', event_time_from: '2025-01-01T08:00:00' }, {}),
    (error) => error.code === 'INVALID_REQUEST')
  dispose()
})

corpusTest('corpus_search：空占位参数不再导致失败', async () => {
  const plugin = await import('../src/index.js')
  const { registered, ctx, dispose } = makeCtx()
  await plugin.apply(ctx, LOCAL_CONFIG)
  const searchTool = registered.find((item) => item.name === 'corpus_search')
  const clean = await searchTool.execute({ query: '重生' }, {})
  assert.ok(clean.documents.length > 0)
  const placeholder = await searchTool.execute({ query: '重生', cursor: '', after: {},
    story_names: [], activity_names: [], context_terms: [], speakers: [''], entity_names: [] }, {})
  assert.deepEqual(placeholder.documents.map((item) => item.title), clean.documents.map((item) => item.title))
  const readTool = registered.find((item) => item.name === 'corpus_read')
  const title = clean.documents[0].title
  const cleanRead = await readTool.execute({ title, mode: 'document' }, { callId: 'read-clean' })
  const placeholderRead = await readTool.execute({ title, mode: 'document', line: 0, before: 0, after: 0,
    position: 0, max_lines: 0, document_uid: '', section: '', material: '', content_types: [] },
  { callId: 'read-placeholder' })
  assert.ok(cleanRead.primary?.lines?.length > 0)
  assert.deepEqual(placeholderRead.primary.lines, cleanRead.primary.lines)
  const uid = documentUid(cleanRead.presentation.document_id)
  const uidRead = await readTool.execute({ document_uid: uid, mode: 'document', max_chars: 8000 }, {})
  const filled = { activity_name: '', after: 3, before: 3, character_name: '', collection_name: '',
    content_types: [], cursor: '', data_version: '', document_uid: uid, game: 'endfield', line: 1,
    material: 'profile', max_chars: 8000, max_lines: 100, mode: 'document', position: 0,
    record_name: '', section: '剧情总结', segment: 1, stage_code: '', story_part: 'story', title: '' }
  const filledRead = await readTool.execute(filled, { callId: 'read-filled' })
  assert.deepEqual(filledRead.primary, uidRead.primary)
  assert.deepEqual(filledRead.page, uidRead.page)
  assert.match(readTool.output.render(filled, filledRead)[0].text, /未应用 section=剧情总结/u)
  for (const field of ['story_part', 'material', 'game', 'mode', 'section']) {
    assert.equal(readTool.parameters.properties[field].enum[0], '')
    assert.ok(!readTool.parameters.properties[field].enum.includes('invalid-value'))
  }
  await assert.rejects(readTool.execute({ document_uid: uid, title, mode: 'document' }, {}),
    (error) => error.code === 'INVALID_REQUEST' && /实际冲突：title 与 document_uid/u.test(error.message)
      && error.message.includes(JSON.stringify({ document_uid: uid, mode: 'document' })))
  for (const extra of [{ stage_code: '15-17' }, { character_name: '阿米娅', material: 'profile' },
    { character_name: '阿米娅', record_name: '真实密录' }, { collection_name: '着新墨' }]) {
    await assert.rejects(readTool.execute({ document_uid: uid, mode: 'document', ...extra }, {}),
      (error) => error.code === 'INVALID_REQUEST' && /实际冲突/u.test(error.message))
  }
  for (const extra of [{ story_part: 'after' }, { segment: 2 }, { material: 'voice' }]) {
    await assert.rejects(readTool.execute({ document_uid: uid, mode: 'document', ...extra }, {}),
      (error) => error.code === 'INVALID_REQUEST' && /附属参数/u.test(error.message))
  }
  for (const data_version of ['bad', 'f'.repeat(64)]) {
    await assert.rejects(readTool.execute({ ...filled, data_version }, {}),
      (error) => ['INVALID_REQUEST', 'PACKAGE_VERSION_MISMATCH'].includes(error.code))
  }
  // 真实但错误的分页凭据仍严格报错
  await assert.rejects(searchTool.execute({ query: '重生', after: { data_version: 'bad', position: 1 } }, {}),
    (error) => error.code === 'INVALID_REQUEST')
  dispose()
})
