import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { snapshotWorkload, version } from './helpers/rhine-snapshot-fixture.js'
let api
vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load({ factory }) { api = factory(() => ({})).__rhineStateForTest } } },
  console, AbortController, setTimeout, clearTimeout,
})
const plain = value => JSON.parse(JSON.stringify(value))
const fixture = () => {
  const input = snapshotWorkload(), diagnostics = api.createRhineSnapshotDiagnostics()
  const select = api.createRhineSnapshotSelector(diagnostics)
  const check = () => {
    const signature = select(input)
    assert.deepEqual(JSON.parse(signature), JSON.parse(api.rhineSnapshotSignature(input)))
    assert.deepEqual(plain(select.read(signature)), JSON.parse(signature))
    return select.read(signature)
  }
  return { input, diagnostics, select, check }
}

test('unchanged notifications and answer chunks reuse history, material and serialized fields', () => {
  const { input, diagnostics, select, check } = fixture()
  const first = check(), before = plain(diagnostics.performanceStats())
  for (let i = 0; i < 100; i++) {
    assert.equal(select.read(select(input)), first)
    // New host objects with identical content must also hit the cache.
    if (i % 10 === 0) input.nodes = new Map(structuredClone([...input.nodes]))
  }
  assert.equal(diagnostics.performanceStats().counts['host-snapshot-build'], 1)
  for (let i = 0; i < 100; i++) {
    input.nodes.get('answer').data.blocks[0].text = 'Answer ' + i
    const next = check()
    assert.equal(next.sources, first.sources)
    assert.equal(next.records, first.records)
    assert.equal(next.turnSources, first.turnSources)
  }
  const stats = diagnostics.performanceStats()
  assert.equal(stats.cache.inputHits, 100)
  assert.equal(stats.cache.toolMisses, before.cache.toolMisses)
  assert.equal(stats.cache.materialMisses, before.cache.materialMisses)
  assert.equal(stats.cache.serializeMisses - before.cache.serializeMisses, 100)
  assert.equal(stats.counts['host-snapshot-parse'], 0)
})

test('same-length, nested and in-place material/tool edits invalidate without poisoning old outputs', () => {
  const { input, select, check } = fixture(), first = check(), old = JSON.stringify(first)
  const root = input.nodes.get('tool-0').data.root
  const mutations = [
    () => { root.content[0].text = 'same length A' },
    () => { root.content[0].text = 'same length B' },
    () => { root.meta.sources[0].excerpt = 'X'.repeat(100) + 'A' },
    () => { root.meta.sources[0].excerpt = 'X'.repeat(100) + 'B' },
    () => { root.meta.sources[0].ranges[0].end = 9 },
    () => { root.meta.sources[0].readRanges[0].start = 4 },
    () => { root.meta.sources[0].dataVersion = 'b'.repeat(64) },
    () => { root.meta.sources[0].extra = { nested: ['preserve', 'unknown source data'] } },
    () => { root.meta.sources[0].extra.nested.pop() },
    () => { delete root.meta.sources[0].sourceRef },
    () => { root.call.argsRaw = { query: 'mutable query' } },
    () => { root.call.argsRaw.query = 'another query' },
    () => { root.meta.error = 'business failure' },
    () => { delete root.meta.error; root.isError = true },
    () => { root.isError = false },
  ]
  for (const mutate of mutations) { mutate(); check() }
  assert.equal(JSON.stringify(first), old)
  // Concurrent/older render must read its own signature, not the latest value.
  assert.deepEqual(plain(select.read(old)), JSON.parse(old))
})

test('historical and current citations withdraw, obey prefix order, versions and exact refs', () => {
  const { input, check } = fixture()
  const historical = input.nodes.get('answer-7').data.blocks[0]
  const active = input.nodes.get('answer').data.blocks[0]
  check()
  for (const text of ['《Fixture document 49》第 1–3 行。', 'No citation',
    'source_ref=client_data:fixture:2:L1', 'source_ref=client_data:fixture:2:L199',
    '《Fixture document 49》第 1–300 行。']) {
    historical.text = text; active.text = text; check()
  }
  input.nodes.get('tool-10').data.root.meta.sources.push({
    ...input.nodes.get('tool-0').data.root.meta.sources[0], dataVersion: 'b'.repeat(64),
  })
  active.text = '《Fixture document 0》第 1–3 行。'; check()
})

test('nested receipts, wiki fields, active tools, stop and restart preserve original semantics', () => {
  const { input, check } = fixture()
  const child = { callId: 'read', name: 'corpus_read', argsRaw: '{}' }
  const root = { name: 'parallel', subCalls: [child] }
  input.nodes.set('nested', { kind: 'tool-call', data: { root } }); input.order.push('nested')
  check(); root.subCalls.push(root); check() // The existing cycle bound still applies.
  Object.assign(child, { kind: 'tool-result', parentCallId: 'parent', call: { name: 'corpus_read', argsRaw: '{}' }, content: [
    { type: 'prts-archive-receipt', version: 1, callId: 'read', parentCallId: 'parent', tool: 'corpus_read', meta: {
      kind: 'prts-corpus-read-v1', title: 'Wiki fixture', data_version: version, line_start: 1, line_end: 8,
      sources: [{ title: 'Wiki fixture', document_id: 'wiki', line_start: 1, line_end: 8 }],
    } }, { type: 'text', text: '引用：《Wiki fixture》Wiki·简介' },
  ] })
  input.order.splice(input.order.indexOf('answer'), 1); input.order.push('answer')
  input.nodes.get('answer').data.blocks[0].text = '《Wiki fixture》Wiki·简介。'
  check(); child.content[1].text = '引用：《Wiki fixture》Wiki·背景'; check()
  child.content[0].parentCallId = 'unrelated'; check()
  delete child.kind; delete child.call; input.nodes.get('answer').data.status = 'interrupted'; check()
  input.nodes.get('answer').data.status = 'running'; check()
})

test('turn end, pending input, timeline replacement and older history stay correct', () => {
  const { input, check } = fixture()
  const turn = { turn: 9, start: { seq: 10 } }
  input.timeline = { turnOrder: [9], turns: new Map([[9, turn]]) }
  for (const node of input.nodes.values()) node.location = { turn }
  check()
  for (const kind of ['completed', 'aborted', 'error', 'max-tokens', 'blocked']) {
    turn.end = { type: 'turn/end', seq: 100, time: 123, data: { reason: { kind, error: { message: 'A failure' } } } }; check()
  }
  input.nodes.set('pending', { kind: 'user', data: { seq: 101, content: [{ type: 'text', text: 'New question' }] } })
  input.order.push('pending'); check()
  delete turn.end; check()
  input.timeline.turns.set(9, { ...turn, turn: 10 }); check()
  delete input.timeline; check()
  input.order.reverse(); check()
  input.order.splice(0, 20); check()
  input.order = []; check()
  input.order = [...input.nodes.keys()]; check()
})

test('separate selectors and retained old outputs do not share cache state', () => {
  const { input, check } = fixture(), first = check()
  const other = api.createRhineSnapshotSelector()
  const empty = other.read(other({ order: [], nodes: new Map() }))
  assert.equal(empty.sources.length, 0)
  input.nodes.clear(); input.order.length = 0; check()
  assert.equal(first.sources.length, 274)
  assert.equal(other.read(other({ order: [], nodes: new Map() })), empty)
})
