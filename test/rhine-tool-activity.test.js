import { test } from 'node:test'
import assert from 'node:assert/strict'
import { investigationActivity, latestReadFocus, operationSource, ReadCardMotion } from '../ui/rhine/tool-activity.ts'

const base = { sessionId: 'session', investigationId: 'turn:1', running: true, searching: false,
  tool: '', query: '', sources: [], answer: '', operations: [], toolCalls: [] }
const source = { id: 'a', documentUid: 'uid-a', dataVersion: 'v1', title: '孤星', kind: 'story', origin: 'local', state: 'found', excerpt: '' }
const read = { id: 'r1', tool: 'corpus_read', kind: 'read', state: 'active', sourceIds: [], documentUid: source.documentUid }

test('HUD displays actual tools and parallel work; an intermediate answer is not a report', () => {
  const current = investigationActivity({ ...base, answer: '先查阅资料。', toolCalls: [
    { id: 'parallel', tool: 'parallel', state: 'active' },
    { id: 'parallel:web', tool: 'web_search', state: 'active', query: '孤星' },
    { id: 'parallel:read', tool: 'corpus_read', state: 'active' },
  ] })
  assert.equal(current.label, '正在调用 corpus_read')
  assert.equal(current.active.length, 2)
  assert.match(current.detail, /另有 1 个/)
  assert.equal(current.recent.length, 3)
  assert.equal(current.showReport, false)
})

test('idle, waiting, interrupted and completed states remain distinct', () => {
  assert.equal(investigationActivity({ ...base, running: false }).label, '等待开始调查')
  const waiting = investigationActivity({ ...base, toolCalls: [{id:'s',tool:'cloud_search',state:'complete'}] })
  assert.equal(waiting.label, '等待下一步')
  assert.match(waiting.detail, /cloud_search 已返回/)
  const interrupted = investigationActivity({ ...base, running: false, outcome: 'interrupted', answer: '部分内容' })
  assert.equal(interrupted.label, '调查已停止')
  assert.equal(interrupted.showReport, true)
  assert.equal(investigationActivity({ ...base, running: false, outcome: 'completed', answer: '结果' }).showReport, true)
})

test('read focus uses exact identity and version, moves once per call, and never rewinds to an older parallel read', () => {
  assert.equal(operationSource(read, [source]), source)
  assert.equal(operationSource({ ...read, dataVersion: 'v2' }, [source]), undefined)
  assert.equal(operationSource({ ...read, documentUid: '', query: '孤星' }, [source]), undefined)
  assert.equal(operationSource({ ...read, documentUid: '', sourceIds: ['a'] }, [source]), source)
  const first = latestReadFocus({ ...base, operations: [read] }, [source])
  const second = latestReadFocus({ ...base, operations: [read, { ...read, id: 'r2', state: 'complete' }] }, [source])
  assert.notEqual(first.key, second.key)
  assert.equal(second.operation.id, 'r2')
  assert.equal(latestReadFocus({ ...base, operations: [{ ...read, state: 'error' }] }, [source]).operation.state, 'error')
})

test('single source reveal travels downward once and respects reduced motion', () => {
  const calls = []; let canceled = 0
  const element = { animate(frames, options) { calls.push({ frames, options }); return { cancel() { canceled++ } } } }
  const motion = new ReadCardMotion()
  motion.reveal(element, false)
  assert.equal(calls[0].frames[0].transform, 'translateY(-20px)')
  assert.equal(calls[0].frames[1].transform, 'translateY(0)')
  assert.equal(calls[0].options.iterations, undefined)
  motion.reveal(element, false)
  assert.equal(canceled, 1)
  motion.reveal(element, true)
  assert.equal(canceled, 2)
  assert.equal(calls.length, 2)
})
