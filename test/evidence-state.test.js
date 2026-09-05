import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEvidenceStateRegistry, rememberCloudMappings, rememberRead,
  rememberSearchCandidates, planReadCoverage, visibleToolResults } from '../src/evidence-state.js'
import { readableRenderedLine } from '../src/read.js'

test('证据状态按 Agent 隔离并对候选、映射做有界去重', () => {
  const registry = createEvidenceStateRegistry()
  const agent = {}
  const state = registry.forExecution({ agent })
  assert.equal(registry.forExecution({ agent }), state)
  assert.notEqual(registry.forExecution({ agent: {} }), state)
  const execution = {}
  assert.equal(registry.forExecution(execution), registry.forExecution(execution))
  assert.notEqual(registry.forExecution({}), registry.forExecution({}),
    '缺少 Agent 时不同执行对象不得共享证据状态')

  rememberSearchCandidates(state, { documents: [{ title: '测试',
    matches: [{ line_start: 2 }] }] })
  rememberSearchCandidates(state, { documents: [{ title: '测试',
    matches: [{ line_start: 2 }] }] })
  assert.equal(state.searchCandidates.length, 1)
  assert.equal(state.searchCandidates[0].line, 2)

  rememberCloudMappings(state, { data: { request: { request_id: 'req-1' } },
    local_source_mappings: [{ evidence_id: 'evi-1', document_id: 'story:test', line: 2 }] })
  assert.equal(state.lastCloudRequestId, 'req-1')
  assert.equal(state.cloudSourceMappings.length, 1)
})

test('证据状态按 data_version 隔离，热切换后不回放旧原文', () => {
  const registry = createEvidenceStateRegistry()
  const agent = {}
  const oldState = registry.forExecution({ agent }, 'a'.repeat(64))
  oldState.documents.set('story:test', { lines: new Map([[1, { line_number: 1, text: '旧行' }]]) })
  oldState.readCoverage.push({ documentId: 'story:test', lineStart: 1, lineEnd: 1 })
  const sameState = registry.forExecution({ agent }, 'a'.repeat(64))
  assert.equal(sameState, oldState)
  const newState = registry.forExecution({ agent }, 'b'.repeat(64))
  assert.notEqual(newState, oldState)
  assert.equal(newState.documents.size, 0)
  assert.deepEqual(newState.readCoverage, [])
})

test('部分覆盖计划只列出尚未读取的连续行段', () => {
  const state = createEvidenceStateRegistry().forExecution({ agent: {} })
  const lines = new Map(); const lineSources = new Map()
  for (const [start, end, callId] of [[20, 40, 'read-1'], [51, 55, 'read-2']]) {
    for (let line = start; line <= end; line += 1) {
      lines.set(line, { line_number: line, text: `line ${line}` })
      lineSources.set(line, new Set([callId]))
    }
  }
  state.documents.set('story:test', { lines, lineSources })
  const visible = new Map([
    ['read-1', [...lines.values()].filter((line) => line.line_number <= 40)
      .map((line) => `L${line.line_number}  ${line.text}`).join('\n')],
    ['read-2', [...lines.values()].filter((line) => line.line_number >= 51)
      .map((line) => `L${line.line_number}  ${line.text}`).join('\n')],
  ])
  const plan = planReadCoverage(state, { documentId: 'story:test', lineStart: 30, lineEnd: 60 }, visible)
  assert.deepEqual(plan.reusedRanges, [
    { lineStart: 30, lineEnd: 40 }, { lineStart: 51, lineEnd: 55 },
  ])
  assert.deepEqual(plan.unreadRanges, [
    { lineStart: 41, lineEnd: 50 }, { lineStart: 56, lineEnd: 60 },
  ])
})

test('只有当前模型 surface 中仍存在的工具结果才能作为复用依据', () => {
  const events = [
    { type: 'tool/result', data: { message: { source: { callId: 'visible-read' },
      content: [{ isError: false, content: [{ type: 'text', text: 'visible body' }] }] } } },
    { type: 'tool/result', data: { message: { source: { callId: 'compacted-read' },
      content: [{ isError: false, content: [{ type: 'text', text: 'old body' }] }] } } },
  ]
  const agent = { session: { events, surface: { nodes: [0] } } }
  assert.deepEqual([...visibleToolResults(agent)], [['visible-read', 'visible body']])
})

test('对话行的覆盖判定与 renderRead 的模型可见渲染逐字一致', () => {
  const state = createEvidenceStateRegistry().forExecution({ agent: {} })
  // 语料中对话行 text 以 "说话人：" 前缀开头，而模型可见文本会剥离该前缀。
  const line = { line_number: 9, line_type: 'dialogue', speaker_raw: '阿米娅',
    text: '阿米娅：博士，请听我说。' }
  rememberRead(state, {
    status: 'ok', data_version: 'v',
    document: { document_id: 'story:test' },
    selection: { line_start: 9, line_end: 9 },
    content: { format: 'lines', lines: [line] },
  }, { callId: 'read-1' })
  const rendered = readableRenderedLine(line)
  assert.equal(rendered, 'L9 dialogue 阿米娅: 博士，请听我说。')
  const plan = planReadCoverage(state, { documentId: 'story:test', lineStart: 9, lineEnd: 9 },
    new Map([['read-1', `# 标题\n${rendered}\n引用：《x》`]]))
  assert.deepEqual(plan.reusedRanges, [{ lineStart: 9, lineEnd: 9 }])
  assert.deepEqual(plan.unreadRanges, [])
})
