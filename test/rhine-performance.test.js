import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsyncGpuTimer, RenderPerformanceCapture, summarizeFrames } from '../ui/rhine/temporary-performance.ts'

function fakeGL(supported = true) {
  const ext = { TIME_ELAPSED_EXT: 1, GPU_DISJOINT_EXT: 2, QUERY_COUNTER_BITS_EXT: 3 }
  let active = null, disjoint = false, lost = false, resultReads = 0, created = 0
  const gl = {
    CURRENT_QUERY: 4, QUERY_RESULT_AVAILABLE: 5, QUERY_RESULT: 6, RENDERER: 7, VENDOR: 8,
    getExtension: name => name === 'EXT_disjoint_timer_query_webgl2' && supported ? ext : null,
    getQuery: (_target, parameter) => parameter === ext.QUERY_COUNTER_BITS_EXT ? 64 : active,
    getParameter: parameter => parameter === ext.GPU_DISJOINT_EXT ? disjoint : 'test hardware',
    createQuery: () => { created++; return { available: false, ns: 12_500_000, deleted: false } },
    deleteQuery: query => { query.deleted = true },
    beginQuery: (_target, query) => { assert.equal(active, null, 'queries must not nest'); active = query },
    endQuery: () => { assert(active); active = null },
    getQueryParameter: (query, parameter) => {
      assert(!query.deleted)
      if (parameter === gl.QUERY_RESULT_AVAILABLE) return query.available
      assert(query.available, 'unavailable result must never be read'); resultReads++; return query.ns
    },
    isContextLost: () => lost,
    setDisjoint: value => { disjoint = value }, setLost: value => { lost = value },
    get active() { return active }, get resultReads() { return resultReads }, get created() { return created },
  }
  return gl
}
function sample(intervalMs = null, cpuMs = 2) { return { intervalMs, cpuMs, gpuMs: null, gpuStatus: 'unsupported', calls: 73, triangles: 879480 } }
function renderer(gl) {
  const canvas = new EventTarget(); canvas.width = 1280; canvas.height = 720
  const info = { autoReset: true, render: { calls: 0, triangles: 0 }, memory: { geometries: 200, textures: 25 }, programs: [1, 2],
    reset() { info.render.calls = info.render.triangles = 0 } }
  return { getContext: () => gl, domElement: canvas, info }
}

test('GPU timing is asynchronous, converts nanoseconds, reuses queries and stays bounded under GPU backlog', () => {
  const gl = fakeGL(), timer = new AsyncGpuTimer(gl), first = sample()
  timer.begin(first); const query = gl.active; timer.end(first)
  timer.poll(); assert.equal(gl.resultReads, 0); assert.equal(first.gpuMs, null)
  query.available = true; timer.poll()
  assert.equal(first.gpuMs, 12.5); assert.equal(first.gpuStatus, 'valid')
  const next = sample(); timer.begin(next); assert.equal(gl.active, query); query.available = false; timer.end(next)
  for (let n = 0; n < 11; n++) { const s = sample(); timer.begin(s); timer.end(s) }
  const overflow = sample(); timer.begin(overflow); timer.end(overflow)
  assert.equal(overflow.gpuStatus, 'busy'); assert.equal(gl.created, 12)
  timer.dispose(); assert.equal(next.gpuStatus, 'timeout'); assert.equal(timer.waiting, 0)
})

test('disjoint and lost contexts never produce valid GPU numbers; unsupported is not reported as zero', () => {
  const gl = fakeGL(), timer = new AsyncGpuTimer(gl), a = sample(), b = sample()
  timer.begin(a); const query = gl.active; timer.end(a); query.available = true
  gl.setDisjoint(true); timer.poll()
  assert.equal(a.gpuMs, null); assert.equal(a.gpuStatus, 'disjoint'); assert.equal(gl.resultReads, 0)
  gl.setDisjoint(false); timer.begin(b); timer.end(b); gl.setLost(true); timer.poll()
  assert.equal(b.gpuStatus, 'context-lost'); assert.equal(timer.waiting, 0)
  const unsupported = new AsyncGpuTimer(fakeGL(false)), c = sample(); unsupported.begin(c); unsupported.end(c)
  assert.equal(c.gpuMs, null); assert.equal(summarizeFrames([c]).gpuMs.count, 0)
})

test('existing external GPU timer is respected without ending its query', () => {
  const gl = fakeGL(), timer = new AsyncGpuTimer(gl), foreign = gl.createQuery()
  gl.beginQuery(1, foreign)
  const s = sample(); timer.begin(s); timer.end(s); timer.dispose()
  assert.equal(s.gpuStatus, 'busy'); assert.equal(gl.active, foreign)
})

test('FPS uses real interval total, preserves a stall and excludes initial/hidden/viewer boundaries', () => {
  let now = 1000
  const capture = new RenderPerformanceCapture(() => now), first = renderer(fakeGL(false)), second = renderer(fakeGL(false))
  capture.register('scene', first); capture.register('viewer', second); capture.start({}, 120)
  const draw = (raf, target = first) => {
    const token = capture.begin(raf, target, target === first ? 'array' : 'viewer')
    now += 3; target.info.render.calls += 4; target.info.render.triangles += 100
    capture.end(token)
  }
  draw(1000); draw(1016); draw(1116)
  capture.breakTimeline('hidden'); now = 40_000; draw(40_000); draw(40_016)
  draw(40_100, second); draw(null, second); draw(40_120, second)
  assert.deepEqual(capture.samples.map(s => s.intervalMs), [null, 16, 100, null, 16, null, null, 20])
  const summary = capture.report().summary
  assert.equal(summary.fps, 4000 / 152); assert.equal(summary.over50ms, 1); assert.equal(summary.frameMs.p95, 100)
  assert.equal(summary.cpuMs.mean, 3); assert.equal(summary.calls.mean, 4)
  assert.equal(first.info.autoReset, true); assert.equal(second.info.autoReset, true)
  capture.dispose()
})

test('stopping drains pending GPU results, restart cannot contaminate new run, and timeout is explicit', () => {
  let now = 100
  const capture = new RenderPerformanceCapture(() => now), gl = fakeGL(), target = renderer(gl)
  capture.register('scene', target); capture.start({}, 30)
  const token = capture.begin(100, target, 'array'); const query = gl.active; now += 2; capture.end(token)
  capture.stop(); query.available = true; capture.poll()
  assert.equal(capture.samples[0].gpuMs, 12.5)
  capture.start({}, 30); assert.equal(query.deleted, true); assert.equal(capture.samples.length, 0)
  capture.end(capture.begin(110, target, 'array'), true)
  capture.stop(); now += 5100; capture.poll()
  assert.equal(capture.samples[0].gpuStatus, 'timeout'); assert.equal(capture.report().summary.failedFrames, 1)
  assert.equal(capture.begin(6000, target, 'array'), undefined)
  capture.dispose()
})

test('capture limits wall duration, collects only this run long tasks and removes context listeners', () => {
  let now = 100
  const capture = new RenderPerformanceCapture(() => now), target = renderer(fakeGL(false))
  const unregister = capture.register('scene', target); capture.start({}, 30)
  now = 200; capture.addLongTask(99, 100); capture.addLongTask(150, 60)
  assert.deepEqual(capture.longTasks, [{ at: 50, durationMs: 60 }])
  now = 30_101; capture.poll(); assert.equal(capture.running, false)
  assert.equal(capture.report().stopReason, 'limit')
  const before = capture.events.length; unregister(); target.domElement.dispatchEvent(new Event('webglcontextlost'))
  assert.equal(capture.events.length, before); capture.dispose()
})
