/* 浏览器控制台「原版 vs 插件」对照测量；不要用 Node 执行。两边通用，口径一致。
 * 原版页：http://127.0.0.1:4173/（RhineLabUI，npm run preview）
 * 插件页：http://127.0.0.1:4177/（npm run preview:rhine）或 DSH 宿主资料馆。
 * F12 → Console，粘贴本文件；在两个标签页分别粘贴，结果各自累积在
 * window.__rhinePerfHistory，测完分别 copy(window.__rhinePerfHistory) 复制对照。
 *
 * 统一口径（两页完全相同的度量）：
 * - 渲染帧 = 该 RAF 节拍内确实发生 WebGL 绘制调用的帧（GL 层判定，不依赖任一方的统计接口）。
 * - 真实FPS：4 秒无干预窗口内渲染帧 ÷ 墙钟；渲染占空比 = 渲染帧 ÷ RAF 节拍。
 * - 同步ms：渲染帧的 RAF 回调耗时 + gl.finish 强制等 GPU，含探针开销，非独立 GPU 时间。
 * - 绘制调用 / 三角形：直接包装该画布 GL 上下文的 drawElements/drawArrays（含实例化），
 *   只统计 TRIANGLES 模式，与 three.js renderer.info 口径一致。
 * 不修改任一侧画质与代码。软件渲染器结果仅供诊断。对照前提：两个标签页窗口尺寸一致、
 * 插件侧为固定性能画质，原版侧请在画质面板调成相同参数再测。
 */
(async () => {
  const WARMUP_FRAMES = 8
  const SAMPLE_FRAMES = 40
  const FRAME_TIMEOUT_MS = 20000
  const FPS_WINDOW_MS = 4000
  const READY_TIMEOUT_MS = 120000
  const TRIANGLES = 4
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const findCanvas = () => (document.querySelector('.rhine-scene') || document.querySelector('.model-viewer')
    || document.querySelector('#three-scene'))?.querySelector('canvas')
    ?? document.querySelector('#three-scene canvas')
  const plugin = () => !!window.rhineWorkbench?.stats
  const pluginStats = () => window.rhineWorkbench?.stats?.() ?? null
  const upstreamStats = () => {
    try { return JSON.parse(document.querySelector('#three-scene')?.dataset.renderStats || 'null') } catch { return null }
  }
  const app = () => plugin() ? '插件' : '原版'
  console.log('等待三维画布与渲染循环（两边通用）……')
  const began = performance.now()
  let canvas = null
  let gl = null
  while (performance.now() - began < READY_TIMEOUT_MS) {
    canvas = findCanvas()
    gl = canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'))
    if (gl && canvas.width > 1 && canvas.height > 1) break
    await sleep(500)
  }
  if (!gl) {
    console.error('没有找到正在渲染的 WebGL 画布；请等页面完成加载（原版需过完启动流程进入阵列）。')
    return
  }
  if (document.hidden) {
    console.error('请保持页面在前台。')
    return
  }

  /* GL 层计数：实例方法包装，只认 TRIANGLES，口径与 renderer.info 一致。 */
  let drawCalls = 0
  let triangles = 0
  let glDrew = false
  const resetTick = () => { drawCalls = 0; triangles = 0; glDrew = false }
  const wrapGl = () => {
    const add = (mode, count, instances) => {
      if (mode !== TRIANGLES || !count) return
      glDrew = true
      drawCalls++
      triangles += (count / 3) * (instances || 1)
    }
    for (const name of ['drawArrays', 'drawArraysInstanced', 'drawElements', 'drawElementsInstanced', 'drawRangeElements']) {
      const native = gl[name]
      if (typeof native !== 'function') continue
      gl[name] = (...args) => {
        if (name === 'drawArrays') add(args[0], args[2], 0)
        else if (name === 'drawArraysInstanced') add(args[0], args[2], args[3])
        else if (name === 'drawElements') add(args[0], args[1], 0)
        else if (name === 'drawElementsInstanced') add(args[0], args[1], args[4])
        else if (name === 'drawRangeElements') add(args[0], args[3], 0)
        return native.apply(gl, args)
      }
    }
    return () => { for (const name of ['drawArrays', 'drawArraysInstanced', 'drawElements', 'drawElementsInstanced', 'drawRangeElements']) delete gl[name] }
  }
  const unwrapGl = wrapGl()

  /* 第一段：真实 FPS（无同步等待，仅 GL 计数）。 */
  const originalRaf = window.requestAnimationFrame
  let rafTicks = 0
  let drawFrames = 0
  const countingRaf = callback => originalRaf.call(window, () => {
    rafTicks++
    resetTick()
    try { callback() } finally { if (glDrew) drawFrames++ }
  })
  window.requestAnimationFrame = countingRaf
  const fpsStart = performance.now()
  const heapBefore = performance.memory?.usedJSHeapSize ?? null
  await sleep(FPS_WINDOW_MS)
  const fpsWall = (performance.now() - fpsStart) / 1000
  if (window.requestAnimationFrame === countingRaf) window.requestAnimationFrame = originalRaf
  const fps = fpsWall > 0 ? drawFrames / fpsWall : null
  const renderDuty = rafTicks ? drawFrames / rafTicks : null

  /* 第二段：同步帧成本（渲染帧判定 = 该节拍发生过 GL 绘制）。 */
  const perFrame = []
  let enabled = true
  const wrappedRaf = callback => originalRaf.call(window, time => {
    if (!enabled) return callback(time)
    const started = performance.now()
    resetTick()
    try {
      callback(time)
      if (glDrew) {
        gl.finish()
        perFrame.push({ ms: performance.now() - started, calls: drawCalls, tris: triangles })
      }
    } catch (error) {
      stop()
      throw error
    }
  })
  const stop = () => {
    enabled = false
    if (window.requestAnimationFrame === wrappedRaf) window.requestAnimationFrame = originalRaf
  }
  const waitFrames = async count => {
    const deadline = performance.now() + FRAME_TIMEOUT_MS
    while (enabled && perFrame.length < count && performance.now() < deadline) await sleep(50)
    return enabled && perFrame.length >= count
  }
  window.__rhinePerfStop = stop
  window.requestAnimationFrame = wrappedRaf
  let warmed = true
  let sampled = true
  let initialCanvas = null
  try {
    warmed = await waitFrames(WARMUP_FRAMES)
    perFrame.length = 0
    initialCanvas = [canvas.width, canvas.height]
    sampled = warmed && await waitFrames(SAMPLE_FRAMES)
  } finally {
    stop()
    if (window.__rhinePerfStop === stop) delete window.__rhinePerfStop
  }
  unwrapGl()

  const values = perFrame.map(frame => frame.ms).sort((a, b) => a - b)
  const at = p => values.length ? values[Math.min(values.length - 1, Math.floor(values.length * p))] : null
  const span = list => list.length ? [Math.min(...list), Math.max(...list)] : null
  const reasons = []
  if (!warmed || !sampled) reasons.push('渲染帧不足、测量超时或已停止')
  if (!canvas.isConnected || document.hidden || canvas.width <= 1 || canvas.height <= 1
    || gl.isContextLost()) reasons.push('画布隐藏、销毁或上下文不可用')
  if (JSON.stringify(initialCanvas) !== JSON.stringify([canvas.width, canvas.height])) reasons.push('采样期间输出尺寸发生变化')

  /* 第三段：上下文快照（各自接口，字段对齐）。 */
  const ps = pluginStats()
  const us = upstreamStats()
  const s = ps ?? us ?? {}
  const label = window.__rhinePerfLabel || `${app()}·${ps ? (ps.cameraLocation === 'desk' ? `档案架(${ps.physicalFiles ?? '?'}档)` : ps.viewerOpen ? '360°查看器' : '检索阵列') : '阵列'}`
  const debug = gl.getExtension('WEBGL_debug_renderer_info')
  const adapter = gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER)
  const run = {
    label, app: app(), 时刻: new Date().toISOString(),
    有效: reasons.length === 0, 原因: reasons,
    adapter, devicePixelRatio,
    真实FPS: fps !== null ? +fps.toFixed(1) : null,
    渲染帧: drawFrames, RAF节拍: rafTicks, 渲染占空比: renderDuty !== null ? +renderDuty.toFixed(2) : null,
    同步ms_p50: at(0.5), 同步ms_p95: at(0.95), 同步ms_最长: values.at(-1) ?? null, 同步ms_最短: values[0] ?? null,
    样本帧: values.length,
    GL绘制调用区间: span(perFrame.map(frame => frame.calls)),
    GL三角形区间: span(perFrame.map(frame => Math.round(frame.tris))),
    画布: [canvas.width, canvas.height],
    JS堆增量MB: heapBefore != null && performance.memory ? +(((performance.memory.usedJSHeapSize - heapBefore) / 1048576).toFixed(1)) : null,
    上下文: {
      来源: ps ? 'rhineWorkbench.stats' : us ? '#three-scene dataset' : 'unavailable',
      cameraPosition: s.cameraPosition, fieldOfView: s.fieldOfView, loaded: s.loaded,
      drawCalls: s.drawCalls, triangles: s.triangles, archiveCount: s.archiveCount,
      ...(ps ? { quality: ps.renderQuality, physicalFiles: ps.physicalFiles, sourceCount: ps.sourceCount } : {}),
      ...(us ? { datasetFps: Number(document.querySelector('#three-scene')?.dataset.fps || null) } : {}),
    },
  }
  window.__rhinePerf = run
  window.__rhinePerfHistory = [...(window.__rhinePerfHistory || []), run]
  const summary = row => ({
    序号: window.__rhinePerfHistory.indexOf(row), label: row.label, 有效: row.有效,
    真实FPS: row.真实FPS, '同步ms_p50': row.同步ms_p50, '同步ms_p95': row.同步ms_p95,
    '同步ms_最长': row.同步ms_最长, 'GL调用': row.GL绘制调用区间?.[1],
    'GL三角形': row.GL三角形区间?.[1], 画布: row.画布, 渲染占空比: row.渲染占空比,
  })
  if (!run.有效) console.warn('无效样本：' + reasons.join('；'))
  if (/swiftshader|llvmpipe|softpipe|software/i.test(adapter)) console.warn('软件渲染器：本结果只供诊断，不能对比硬件性能。')
  console.table(window.__rhinePerfHistory.map(summary))
  console.log(`「${label}」完成（第 ${window.__rhinePerfHistory.length} 次）；切视图/换标签页再粘贴即可追加，copy(window.__rhinePerfHistory) 复制。`)
})().catch(error => console.error('对照测量失败：', error))
