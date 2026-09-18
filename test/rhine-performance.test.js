import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AsyncGpuTimer, RenderPerformanceCapture, summarizeFrames, liveFrameSummary } from '../ui/rhine/temporary-performance.ts'

function fakeGL(supported = true) {
  const ext = { TIME_ELAPSED_EXT: 1, GPU_DISJOINT_EXT: 2, QUERY_COUNTER_BITS_EXT: 3 }
  const queries = []
  let active = null, disjoint = false, lost = false, resultReads = 0, created = 0
  const gl = {
    CURRENT_QUERY: 4, QUERY_RESULT_AVAILABLE: 5, QUERY_RESULT: 6, RENDERER: 7, VENDOR: 8,
    getExtension: name => name === 'EXT_disjoint_timer_query_webgl2' && supported ? ext : null,
    getQuery: (_target, parameter) => parameter === ext.QUERY_COUNTER_BITS_EXT ? 64 : active,
    getParameter: parameter => parameter === ext.GPU_DISJOINT_EXT ? disjoint : 'test hardware',
    createQuery: () => { created++; const q = { available: false, ns: 12_500_000, deleted: false }; queries.push(q); return q },
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
    get queries() { return queries }, get active() { return active }, get resultReads() { return resultReads }, get created() { return created },
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

import { resourceKind, sanitizePerformanceEntry } from '../ui/rhine/temporary-performance-observers.ts'

test('v2 separates delayed callback entry from RAF timestamps and partitions synchronous stages', () => {
  let now = 1000
  const capture = new RenderPerformanceCapture(() => now), target = renderer(fakeGL(false))
  capture.register('scene', target, () => ({ buffers: { composer: { width: 640, height: 480 } } }))
  capture.start({}, 120)
  let token = capture.begin(990, target, 'array')
  now += 2; capture.checkpoint(token, 'collection')
  now += 3; capture.checkpoint(token, 'composer')
  now++; capture.end(token)
  now = 1310; token = capture.begin(1006, target, 'array')
  now += 4; capture.end(token)
  assert.equal(capture.samples[1].intervalMs, 16)
  assert.equal(capture.samples[1].callbackIntervalMs, 310)
  assert.equal(capture.samples[1].rafLagMs, 304)
  assert.equal(capture.samples[1].outsideFrameMs, 304)
  assert.equal(capture.samples[1].rafAt, 6)
  assert.equal(capture.samples[1].at, 310)
  assert.deepEqual(capture.samples[0].stages, { collection: 2, composer: 3, tail: 1 })
  assert.equal(Object.values(capture.samples[0].stages).reduce((a,b) => a+b), capture.samples[0].cpuMs)
  assert.equal(capture.report().summary.callbackOver50ms, 1)
  assert.equal(capture.report().schema, 'rhine-render-capture/v3')
  assert.equal(capture.rendererStates().scene.buffers.composer.width, 640)
  capture.breakTimeline('hidden'); now = 2000
  capture.end(capture.begin(1990, target, 'array'))
  assert.equal(capture.samples.at(-1).callbackIntervalMs, null)
  assert.equal(capture.samples.at(-1).outsideFrameMs, null)
  capture.end(capture.begin(null, target, 'array'))
  now += 16; capture.end(capture.begin(2010, target, 'array'))
  assert.equal(capture.samples.at(-1).callbackIntervalMs, null, 'one-off render must not distort callback interval')
  capture.dispose()
})

test('GPU-off comparison creates no queries; query availability latency is distinct from GPU execution', () => {
  let now = 100
  const gl = fakeGL(), target = renderer(gl), capture = new RenderPerformanceCapture(() => now)
  capture.register('scene', target); capture.start({}, 30, { gpuTiming: false })
  capture.end(capture.begin(100, target, 'array')); capture.poll()
  assert.equal(gl.created, 0); assert.equal(capture.samples[0].gpuStatus, 'disabled')
  assert.equal(capture.report().summary.gpuMs.mean, null)
  capture.stop(); capture.start({}, 30)
  const token = capture.begin(100, target, 'array'), query = gl.active
  now += 3; capture.end(token); now += 40; query.available = true; capture.poll()
  assert.equal(capture.samples[0].gpuQueryLatencyMs, 40)
  assert.equal(capture.samples[0].gpuMs, 12.5)
  capture.dispose()
})

test('diagnostic streams are bounded, filter capture boundaries and isolate late preparation completions', () => {
  let now = 100
  const capture = new RenderPerformanceCapture(() => now)
  capture.start({}, 30)
  capture.diagnostic('resources', { resource: 'font' }, 99)
  assert.equal(capture.diagnostics.resources.length, 0)
  now = 150
  for (let i=0;i<245;i++) capture.diagnostic('heartbeat', { hidden: false })
  assert.equal(capture.diagnostics.heartbeat.length, 240)
  assert.equal(capture.report().dropped.heartbeat, 5)
  const end = capture.beginWork('archive-preparation-sync')
  now += 7; end(true)
  assert.equal(capture.diagnostics.backgroundWork[0].durationMs, 7)
  const stale = capture.beginWork('archive-preparation-lifetime')
  capture.stop(); now += 20
  capture.diagnostic('resources', { resource: 'model' })
  assert.equal(capture.diagnostics.resources.length, 0)
  capture.start({}, 30); stale(true, true)
  assert.equal(capture.diagnostics.backgroundWork.length, 0)
  assert.deepEqual(capture.dropped, {})
  capture.dispose()
})

test('browser timing sanitization excludes URLs, input, DOM nodes, function names and exception text', () => {
  const secret = 'DO_NOT_EXPORT_PRIVATE_QUESTION'
  const raw = { startTime: 150, duration: 80, blockingDuration: 30, renderStart: 170, styleAndLayoutStart: 190,
    firstUIEventTimestamp: 0, name: 'https://host/private/' + secret + '?token=' + secret,
    scripts: [{ sourceURL: 'https://host/rhine/rhine.js?secret=' + secret, sourceFunctionName: secret, invoker: secret,
      invokerType: 'user-callback', executionStart: 155, duration: 18, sourceCharPosition: 345,
      forcedStyleAndLayoutDuration: 7, windowAttribution: 'self' }],
    target: { textContent: secret }, sources: [{ node: secret }], value: 0.02, hadRecentInput: true }
  for (const type of ['long-animation-frame','event','resource','layout-shift']) {
    assert(!JSON.stringify(sanitizePerformanceEntry(type, raw, 100)).includes(secret))
  }
  const loaf = sanitizePerformanceEntry('long-animation-frame', raw, 100)
  assert.equal(loaf.renderStart, 70); assert.equal(loaf.firstUIEventTimestamp, null)
  assert.equal(loaf.scripts[0].source, 'rhine-bundle'); assert.equal(loaf.scripts[0].executionStart, 55)
  assert.equal(resourceKind('https://host/assets/private.glb?question=' + secret), 'model')
  assert.equal(resourceKind('file:///C:/Private/' + secret + '.js'), 'other-script')
  const capped = sanitizePerformanceEntry('long-animation-frame', {...raw, scripts: Array(20).fill(raw.scripts[0])}, 100)
  assert.equal(capped.scripts.length,16); assert.equal(capped.scriptsOmitted,4)
  const event = sanitizePerformanceEntry('event', {name:'keydown', startTime:100, processingStart:130, processingEnd:135, duration:48},0)
  assert.equal(event.inputDelayMs,30); assert.equal(event.processingMs,5)
})

test('live display work stays bounded with 24000 historical frames and reads late GPU results', () => {
  const rows = Array.from({length:24000}, (_,i) => ({...sample(4,2), at:i*4, callbackIntervalMs:4, rafLagMs:0,
    outsideFrameMs:2, probeBeginMs:0.1, probeEndMs:0.1}))
  let reads=0
  const guarded = new Proxy(rows, {get(target,key) {
    if (/^\d+$/.test(String(key))) reads++
    return Reflect.get(target,key)
  }})
  const live=liveFrameSummary(guarded,rows.at(-1).at)
  assert.equal(live.frames,501); assert(reads>500 && reads<=514);assert.equal(live.cpuMs.mean,2)
  rows.at(-1).gpuStatus='valid'; rows.at(-1).gpuMs=7
  assert.equal(liveFrameSummary(rows, rows.at(-1).at).gpuMs.mean,7)
  assert.equal(liveFrameSummary(rows, rows.at(-1).at+3000).frames,0)
  assert.equal(liveFrameSummary(rows, rows.at(-1).at,10000).frames,512)
})

test('120s observer and layout floods preserve late panel/UI diagnostics and exact slow intervals', () => {
  let now=100
  const capture=new RenderPerformanceCapture(()=>now);capture.start({},120)
  for(let second=0;second<120;second++) {
    for(let i=0;i<180;i++) {
      now=100+second*1000+i*5
      capture.diagnostic('overhead',{kind:'observer',entryType:'layout-shift',entries:1,durationMs:0.1})
      capture.diagnostic('layoutShifts',{value:0.001,hadRecentInput:i%2===0,surfaces:['other-ui']})
    }
    capture.diagnostic('overhead',{kind:'panel',visible:true,durationMs:second===110?23:1})
    capture.diagnostic('overhead',{kind:'heartbeat',durationMs:0.2})
    capture.diagnostic('uiWork',{kind:'renderStatus',durationMs:second===100?60:0.5})
  }
  assert.deepEqual(capture.dropped,{})
  const observer=capture.diagnostics.overhead.filter(e=>e.kind==='observer')
  assert.equal(observer.length,120);assert.equal(observer.reduce((n,e)=>n+e.count,0),21600)
  assert.equal(capture.diagnostics.layoutShifts.reduce((n,e)=>n+e.count,0),21600)
  const panels=capture.diagnostics.overhead.filter(e=>e.kind==='panel')
  assert.equal(panels.length,120);assert.equal(panels.at(-1).at,119000)
  assert.equal(capture.diagnostics.slowWork.find(e=>e.kind==='panel').durationMs,23)
  assert.equal(capture.diagnostics.slowWork.find(e=>e.kind==='renderStatus').at,100895)
})

test('loading lifecycle spans include pre-start, pending, failure, abort and capture restart without payloads', async () => {
  let now=10
  const capture=new RenderPerformanceCapture(()=>now)
  const finish=capture.beginLoad('model-fetch-decode',{asset:'archive-cassette.glb'})
  now=100;capture.start({},120)
  assert.equal(capture.diagnostics.loads[0].startedBeforeCapture,true)
  assert.equal(capture.diagnostics.loads[0].elapsedBeforeCaptureMs,90)
  capture.stop();now=120;capture.start({},120);now=130;finish()
  const row=capture.diagnostics.loads[0]
  assert.equal(row.status,'complete');assert.equal(row.durationMs,120);assert.equal(row.endAt,10)
  finish('error');assert.equal(row.status,'complete','completion is idempotent')
  await assert.rejects(capture.trackLoad('api:read',async()=>{throw new Error('private message')}))
  await assert.rejects(capture.trackLoad('api:read',async()=>{throw new DOMException('private','AbortError')}))
  assert.deepEqual(capture.diagnostics.loads.map(e=>e.status),['complete','error','aborted'])
  const done=capture.beginLoad('api:archive.search');capture.stop();now+=15;done()
  assert.equal(capture.diagnostics.loads.at(-1).finishedAfterCapture,true)
  assert(!JSON.stringify(capture.report()).includes('private'))
  assert.equal(capture.loadingState().active.length,0)
})

test('stage submission deltas partition actual draw calls including the final tail', () => {
  let now=100
  const capture=new RenderPerformanceCapture(()=>now),target=renderer(fakeGL(false))
  capture.register('scene',target);capture.start({},30)
  const token=capture.begin(100,target,'array')
  target.info.render.calls=99;target.info.render.triangles=12000;now++
  capture.checkpoint(token,'composer')
  target.info.render.calls+=2;target.info.render.triangles+=24;now++
  capture.checkpoint(token,'labelOverlay')
  target.info.render.calls++;now++;capture.end(token)
  const frame=capture.samples[0]
  assert.deepEqual(frame.submissions,{composer:{calls:99,triangles:12000},labelOverlay:{calls:2,triangles:24},tail:{calls:1,triangles:0}})
  assert.equal(Object.values(frame.submissions).reduce((n,p)=>n+p.calls,0),frame.calls)
})


// Detailed captures preserve the old whole-frame path as an explicit comparison mode.
import { Texture } from 'three'
import { uploadSize } from '../ui/rhine/temporary-render-diagnostics.ts'

test('detailed GPU passes are sequential and asynchronously summed, with original draw work retained', () => {
  let now = 100
  const gl = fakeGL(), target = renderer(gl), capture = new RenderPerformanceCapture(() => now)
  const pass = { render() { assert.equal(this, pass); now += 2; target.info.render.calls += 3; target.info.render.triangles += 40 } }
  const original = pass.render
  capture.register('scene', target, undefined, () => [{ name: 'scene-color', pass }])
  capture.start({}, 30)
  const frame = capture.begin(100, target, 'array')
  pass.render(); capture.checkpoint(frame, 'composer')
  capture.gpuStage(target, 'label-overlay'); now++; target.info.render.calls++; target.info.render.triangles += 2
  capture.end(frame)
  assert.equal(gl.active, null); assert.equal(gl.created, 3)
  assert.equal(frame.sample.gpuMode, 'segments'); assert.equal(frame.sample.calls, 4)
  assert.deepEqual(frame.sample.passWork['scene-color'], { cpuMs: 2, calls: 3, triangles: 40 })
  gl.queries[0].available = true; capture.poll(); assert.equal(frame.sample.gpuMs, null)
  assert.equal(frame.sample.gpuStatus, 'pending')
  for (const q of gl.queries) q.available = true
  capture.poll(); assert.equal(frame.sample.gpuMs, 37.5)
  assert.equal(Object.values(frame.sample.gpuStages).reduce((n,s)=>n+s.gpuMs,0), frame.sample.gpuMs)
  capture.stop(); assert.equal(pass.render, original)
  capture.start({}, 30, { detailed: false }); assert.equal(pass.render, original)
  const whole = capture.begin(105, target, 'array'); pass.render(); capture.end(whole)
  assert.equal(whole.sample.gpuMode, 'whole'); assert.equal(whole.sample.gpuStages, undefined)
  capture.dispose()
})

test('detail bursts retain the next navigation frame, cap large captures, and do not invent GPU results', () => {
  let now = 100
  const gl = fakeGL(false), target = renderer(gl), capture = new RenderPerformanceCapture(() => now)
  capture.register('scene', target); capture.start({}, 120)
  for (let i = 0; i < 1250; i++) {
    now++; capture.mark('archive-navigation')
    const frame = capture.begin(now, target, 'array'); capture.end(frame)
  }
  capture.poll()
  assert.equal(capture.report().detailSampling.sampledFrames, 1200)
  assert.equal(capture.samples[1].detailReason, 'interaction')
  assert.equal(capture.samples[1200].gpuMode, 'whole')
  assert.equal(capture.samples[0].gpuMs, null); assert.equal(capture.samples[0].gpuStatus, 'unsupported')
  assert.equal(gl.created, 0); capture.dispose()
})

test('lost context, disjoint and restart invalidate segmented queries without keeping old hooks', () => {
  let now = 100
  const gl = fakeGL(), target = renderer(gl), capture = new RenderPerformanceCapture(() => now)
  const pass = { render() {} }, original = pass.render
  capture.register('scene', target, undefined, () => [{ name: 'color', pass }]); capture.start({}, 30)
  let frame = capture.begin(now, target, 'array'); pass.render(); capture.end(frame)
  gl.setDisjoint(true); capture.poll(); assert.equal(frame.sample.gpuStatus, 'disjoint'); assert.equal(frame.sample.gpuMs, null)
  gl.setDisjoint(false); now++; frame = capture.begin(now, target, 'array'); capture.gpuStage(target, 'label')
  gl.setLost(true); target.domElement.dispatchEvent(new Event('webglcontextlost')); capture.end(frame); capture.poll()
  assert.equal(frame.sample.gpuStatus, 'context-lost'); assert.equal(capture.pendingGpu, 0)
  gl.setLost(false); target.domElement.dispatchEvent(new Event('webglcontextrestored'))
  capture.stop(); assert.equal(pass.render, original)
  capture.start({}, 30, { gpuTiming: false }); now++; frame = capture.begin(now, target, 'array'); pass.render(); capture.end(frame)
  assert.equal(frame.sample.gpuStatus, 'disabled'); assert.equal(frame.sample.gpuStages, undefined)
  capture.dispose(); assert.equal(pass.render, original)
})

test('texture dirties link to actual Three upload callbacks without recording pixels and restore on stop', () => {
  let now = 100, calls = 0
  const capture = new RenderPerformanceCapture(() => now), target = renderer(fakeGL(false))
  capture.register('scene', target); capture.start({}, 30)
  const secret = 'PRIVATE-DOCUMENT-CONTENT'
  const texture = new Texture({ width: 1536, height: 714, textContent: secret })
  texture.userData = { title: secret, sourceId: secret }
  const original = function() { assert.equal(this, texture); calls++ }; texture.onUpdate = original
  capture.texturePaint(texture, 'hero-label', () => { now++; texture.needsUpdate = true }, 42)
  capture.texturePaint(texture, 'hero-label', () => { now++; texture.needsUpdate = true }, 42)
  const frame = capture.begin(now, target, 'array'); capture.gpuStage(target, 'label-overlay'); texture.onUpdate(texture); capture.end(frame)
  const rows = capture.diagnostics.resourceUpdates
  assert.equal(rows.length, 3); assert.equal(rows[0].texture, rows[2].texture)
  assert.equal(rows[0].cacheEntry, 42); assert.equal(rows[2].cacheEntry, 42)
  assert.equal(rows[2].kind, 'texture-upload-complete'); assert.equal(rows[2].version, 2)
  assert.equal(rows[2].frame, frame.sample.id); assert.equal(rows[2].stage, 'label-overlay')
  assert.equal(rows[0].rgba8BaseBytes, 1536*714*4); assert.equal(calls, 1)
  assert(!JSON.stringify(capture.report()).includes(secret))
  texture.dispose(); assert.equal(texture.onUpdate, original); assert.equal(capture.textures.size, 0)
  capture.stop(); assert.equal(texture.onUpdate, original)
  capture.start({}, 30, { detailed: false }); capture.texturePaint(texture, 'hero-label', ()=>texture.needsUpdate=true)
  assert.equal(texture.onUpdate, original); assert.equal(capture.diagnostics.resourceUpdates.length,0)
  capture.dispose(); texture.dispose()
})

test('GL payload counters use dimensions and typed lengths; draw sampling restores methods even after throws', () => {
  assert.deepEqual(uploadSize('bufferData', [1, 100, 3]), { sourceBytes: 0, sourcePixels: 0, allocationBytes: 100 })
  assert.equal(uploadSize('bufferSubData',[1,0,new Float32Array(10),2,3]).sourceBytes,12)
  assert.equal(uploadSize('texImage2D',[1,0,2,3,4,{width:10,height:20,textContent:'private'}]).sourcePixels,200)
  let now = 100
  const gl = fakeGL(false), target = renderer(gl), capture = new RenderPerformanceCapture(()=>now)
  const upload = gl.texSubImage2D = function() { assert.equal(this, gl); now++ }
  const draw = target.renderBufferDirect = function() { target.info.render.calls++; target.info.render.triangles+=100 }
  const pass = { render() { target.renderBufferDirect(null,null,null,{isMeshPhysicalMaterial:true},{userData:{surface:'Optical_Film',performanceFamily:'shelf'},name:'private-document'}); throw Error('test exception') } }
  capture.register('scene',target,undefined,()=>[{name:'scene-color',pass}]);capture.start({},30)
  const frame=capture.begin(now,target,'rack');gl.texSubImage2D(1,0,0,0,2,2,4,5,new Uint8Array(16))
  assert.throws(()=>pass.render(),/test exception/);capture.end(frame,true)
  assert.equal(frame.sample.glWork['update:texSubImage2D'].sourceBytes,16)
  assert.deepEqual(frame.sample.drawFamilies,[{family:'shelf',part:'Optical_Film',material:'physical',phase:'scene-color',calls:1,triangles:100}])
  assert.equal(frame.sample.failed,true);assert(!JSON.stringify(capture.report()).includes('private-document'))
  capture.stop();assert.equal(gl.texSubImage2D,upload);assert.equal(target.renderBufferDirect,draw)
  capture.dispose()
})


test('segmented backlog is bounded at 96 queries and partial busy frames never report a summed GPU duration', () => {
  let now=100
  const gl=fakeGL(), target=renderer(gl), capture=new RenderPerformanceCapture(()=>now)
  capture.register('scene',target); capture.start({},120)
  for(let i=0;i<40;i++){
    now++;capture.mark('archive-navigation');const frame=capture.begin(now,target,'array')
    capture.gpuStage(target,'color');capture.gpuStage(target,'label');capture.end(frame)
  }
  assert.equal(gl.created,96);assert.equal(capture.pendingGpu,96);assert.equal(gl.active,null)
  for(const q of gl.queries)q.available=true
  capture.poll();assert.equal(capture.pendingGpu,0)
  assert(capture.samples.some(s=>s.gpuStatus==='valid'))
  assert(capture.samples.some(s=>s.gpuStatus==='busy'&&s.gpuMs===null))
  capture.stop();capture.dispose();assert(gl.queries.every(q=>q.deleted))
})


test('interaction summaries preserve a full 120s event flood and nested work identifies its parent', () => {
  let now = 1000
  const capture = new RenderPerformanceCapture(() => now)
  capture.start({}, 120, { gpuTiming: false, detailed: true })
  for (let second = 0; second < 120; second++) {
    now = 1000 + second * 1000
    for (let i = 0; i < 50; i++) capture.diagnostic('interactionSummary', { kind: 'other', durationMs: 16, inputDelayMs: 2 })
  }
  assert.equal(capture.diagnostics.interactionSummary.length, 120)
  assert.equal(capture.diagnostics.interactionSummary.reduce((n, r) => n + r.count, 0), 6000)
  assert.equal(capture.dropped.interactionSummary, undefined)
  const endOuter = capture.beginUiWork('snapshot-update'); now += 1
  const endInner = capture.beginUiWork('snapshot-classify'); now += 10
  endInner(); now += 1; endOuter(); endOuter()
  const spans = capture.diagnostics.slowWork.filter(r => r.kind.startsWith('snapshot-'))
  assert.equal(spans.length, 2)
  assert.equal(spans[0].parentId, spans[1].spanId)
  assert.equal(spans[1].parentId, null)
  assert.equal(spans[0].durationMs, 10)
  assert.equal(spans[1].durationMs, 12)
  capture.stop()
})


test('cached textures can be observed after capture start without inventing a repaint', () => {
  let now = 100, updates = 0
  const capture = new RenderPerformanceCapture(() => now), texture = new Texture({width:1536,height:714})
  texture.needsUpdate = true
  const original = () => updates++; texture.onUpdate = original
  capture.start({},30); capture.observeTexture(texture,'hero-label',77); texture.onUpdate(texture)
  assert.equal(capture.diagnostics.resourceUpdates.length,1)
  assert.equal(capture.diagnostics.resourceUpdates[0].kind,'texture-upload-complete')
  assert.equal(capture.diagnostics.resourceUpdates[0].cacheEntry,77)
  assert.equal(capture.diagnostics.resourceUpdates[0].stage,'outside-frame')
  capture.stop(); assert.equal(texture.onUpdate,original); assert.equal(updates,1)
  capture.start({},30); capture.observeTexture(texture,'shelf-label',77); texture.dispose()
  assert.equal(texture.onUpdate,original); capture.dispose()
})
