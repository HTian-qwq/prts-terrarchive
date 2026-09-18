import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../ui/rhine/deferred-preparation.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
const { DeferredPreparation } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

function scheduler() {
  let nextId = 0
  let time = 0
  const frames = new Map(), timers = new Map()
  return {
    requestAnimationFrame(callback) { const id = nextId++; frames.set(id, callback); return id },
    cancelAnimationFrame(id) { frames.delete(id) },
    setTimeout(callback, delay) {
      assert.equal(delay, 0)
      const id = nextId++; timers.set(id, callback); return id
    },
    clearTimeout(id) { timers.delete(id) },
    frame() {
      time += 16
      for (const [id, callback] of [...frames]) {
        if (!frames.delete(id)) continue
        callback(time)
      }
    },
    timer() {
      for (const [id, callback] of [...timers]) {
        if (!timers.delete(id)) continue
        callback()
      }
    },
    frames, timers,
  }
}

async function tick(clock) {
  clock.frame()
  clock.timer()
  await Promise.resolve()
}

test('twelve preparations each require a separate frame and subsequent task', async () => {
  const clock = scheduler()
  const queue = new DeferredPreparation({ scheduler: clock })
  const calls = []
  for (let index = 0; index < 12; index++) queue.enqueue(`shelf:${index}`, () => { calls.push(index) })
  assert.equal(clock.frames.size, 1)
  assert.equal(clock.timers.size, 0)
  clock.timer()
  assert.deepEqual(calls, [])
  for (let index = 0; index < 12; index++) {
    clock.frame()
    assert.equal(calls.length, index)
    clock.timer()
    assert.equal(calls.length, index + 1)
    await Promise.resolve()
    clock.timer()
    assert.equal(calls.length, index + 1, 'completion cannot execute another task without a new RAF')
  }
  assert.deepEqual(calls, Array.from({ length: 12 }, (_, index) => index))
  assert.deepEqual(queue.stats(), { pending: 0, running: false, completed: 12 })
  assert.equal(clock.frames.size, 0)
})

test('pending replacements keep FIFO order and priorities can advance urgent work', async () => {
  const clock = scheduler()
  const queue = new DeferredPreparation({ scheduler: clock })
  const calls = []
  queue.enqueue('first', () => calls.push('obsolete'))
  queue.enqueue('second', () => calls.push('second'))
  queue.enqueue('first', () => calls.push('updated'))
  queue.enqueue('urgent', () => calls.push('urgent'), 2)
  queue.enqueue('cancelled', () => calls.push('cancelled'), 5)
  queue.cancel('cancelled')
  assert.equal(queue.stats().pending, 3)
  await tick(clock); await tick(clock); await tick(clock)
  assert.deepEqual(calls, ['urgent', 'updated', 'second'])
})

test('a running promise serializes subsequent work including another task with its key', async () => {
  const clock = scheduler()
  const queue = new DeferredPreparation({ scheduler: clock })
  const calls = []
  let resolve
  queue.enqueue('model', () => {
    calls.push('start')
    return new Promise(done => { resolve = done })
  })
  await tick(clock)
  queue.enqueue('model', () => calls.push('superseded'))
  queue.enqueue('model', () => calls.push('next model'))
  queue.enqueue('label', () => calls.push('label'))
  await tick(clock); await tick(clock)
  assert.deepEqual(calls, ['start'])
  assert.deepEqual(queue.stats(), { pending: 2, running: true, completed: 0 })
  assert.equal(clock.frames.size, 0)
  resolve()
  await Promise.resolve()
  clock.timer()
  assert.deepEqual(calls, ['start'])
  await tick(clock); await tick(clock)
  assert.deepEqual(calls, ['start', 'next model', 'label'])
  assert.equal(queue.stats().completed, 3)
})

test('pause and cancellation invalidate callbacks already scheduled for an old frame', async () => {
  const clock = scheduler()
  const queue = new DeferredPreparation({ scheduler: clock })
  let completed = 0
  queue.enqueue('file', () => { completed++ })
  const staleFrame = [...clock.frames.values()][0]
  queue.setActive(false)
  assert.equal(clock.frames.size, 0)
  staleFrame(16)
  assert.equal(clock.timers.size, 0)
  queue.setActive(true)
  clock.frame()
  const staleTimer = [...clock.timers.values()][0]
  queue.setActive(false)
  assert.equal(clock.timers.size, 0)
  queue.setActive(true)
  staleTimer()
  assert.equal(completed, 0)
  await tick(clock)
  assert.equal(completed, 1)
  queue.enqueue('cancelled', () => { completed++ })
  queue.cancel('cancelled')
  await tick(clock)
  assert.equal(completed, 1)
  assert.equal(clock.frames.size, 0)
})

test('pausing an in-flight promise retains pending work until resumed', async () => {
  const clock = scheduler()
  const queue = new DeferredPreparation({ scheduler: clock })
  let resolve, ranNext = false
  queue.enqueue('running', () => new Promise(done => { resolve = done }))
  queue.enqueue('waiting', () => { ranNext = true })
  await tick(clock)
  queue.setActive(false)
  resolve()
  await Promise.resolve()
  assert.deepEqual(queue.stats(), { pending: 1, running: false, completed: 1 })
  assert.equal(clock.frames.size, 0)
  await tick(clock)
  assert.equal(ranNext, false)
  queue.setActive(true)
  await tick(clock)
  assert.equal(ranNext, true)
})

test('synchronous throws and asynchronous rejections report errors without stalling work', async () => {
  const clock = scheduler()
  const failures = [], calls = []
  const queue = new DeferredPreparation({ scheduler: clock, onError: (error, key) => failures.push([key, error.message]) })
  queue.enqueue('sync', () => { throw new Error('sync failure') })
  queue.enqueue('async', () => Promise.reject(new Error('async failure')))
  queue.enqueue('valid', () => calls.push('valid'))
  await tick(clock); await tick(clock); await tick(clock)
  assert.deepEqual(failures, [['sync', 'sync failure'], ['async', 'async failure']])
  assert.deepEqual(calls, ['valid'])
  assert.deepEqual(queue.stats(), { pending: 0, running: false, completed: 1 })
})

test('dispose clears scheduled work and promise settlement never revives the queue', async () => {
  const clock = scheduler()
  const failures = []
  const queue = new DeferredPreparation({ scheduler: clock, onError: (error, key) => failures.push(key) })
  let reject
  queue.enqueue('running', () => new Promise((resolve, fail) => { reject = fail }))
  queue.enqueue('pending', () => assert.fail('disposed pending work ran'))
  await tick(clock)
  queue.dispose()
  queue.dispose()
  queue.enqueue('too late', () => assert.fail('disposed enqueue ran'))
  queue.setActive(true)
  assert.deepEqual(queue.stats(), { pending: 0, running: true, completed: 0 })
  reject(new Error('late failure'))
  await Promise.resolve()
  assert.deepEqual(failures, ['running'])
  assert.deepEqual(queue.stats(), { pending: 0, running: false, completed: 0 })
  await tick(clock)
  assert.equal(clock.frames.size, 0)
  assert.equal(clock.timers.size, 0)

  const waiting = new DeferredPreparation({ scheduler: clock })
  waiting.enqueue('not started', () => assert.fail('disposed timer ran'))
  clock.frame()
  const oldTimer = [...clock.timers.values()][0]
  waiting.dispose()
  oldTimer()
  assert.equal(clock.timers.size, 0)
  assert.equal(clock.frames.size, 0)
})

test('monitor separates sync work from promise settlement without source keys or queue interference', async () => {
  const clock = scheduler(), events = []
  let resolve
  const queue = new DeferredPreparation({ scheduler: clock, onError: () => {}, monitorTask: (...args) => {
    assert.equal(args.length, 0)
    return (stage, ok) => events.push([stage,ok])
  } })
  queue.enqueue('private-source-id', () => new Promise(done => { resolve = done }))
  await tick(clock)
  assert.deepEqual(events, [['sync',true]])
  resolve(); await Promise.resolve()
  assert.deepEqual(events, [['sync',true],['settled',true]])
  queue.enqueue('throw', () => { throw Error('expected') })
  await tick(clock)
  assert.deepEqual(events.slice(-2), [['sync',false],['settled',false]])
  queue.enqueue('reject', () => Promise.reject(Error('expected')))
  await tick(clock)
  assert.deepEqual(events.slice(-2), [['sync',true],['settled',false]])
  assert.equal(queue.stats().running, false)
  for (const monitorTask of [() => { throw Error('probe') }, () => () => { throw Error('probe') }]) {
    const safe = new DeferredPreparation({ scheduler: clock, monitorTask })
    safe.enqueue('one', () => {}); safe.enqueue('two', () => {})
    await tick(clock); await tick(clock)
    assert.equal(safe.stats().completed, 2)
    safe.dispose()
  }
  queue.dispose()
})
