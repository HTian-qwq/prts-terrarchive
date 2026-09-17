/* 浏览器控制台多指标测量；不要用 Node 执行。
 * 预览页：npm run preview:rhine，转发 4177 后在本机浏览器打开预览。
 * DSH 宿主：打开「资料馆」窗口即可；插件会把实例挂到 window.rhineWorkbench。
 * F12 → Console，粘贴本文件；脚本会先等模型加载完成，期间保持资料馆前台和当前视图。
 * 每个视图/状态粘贴一次（阵列、档案架、检索动画、360° 查看器……），结果依次追加到
 * window.__rhinePerfHistory；全部测完执行 copy(window.__rhinePerfHistory) 一次复制。
 * 单次报告仍在 window.__rhinePerf；提前停止用 window.__rhinePerfStop()。
 * 360° 查看器打开时粘贴，自动改测查看器画布。
 *
 * 三段采集：真实 FPS（RAF 计数，无干预）→ 同步帧成本（仅确实渲染的场景 RAF 回调 +
 * gl.finish 强制等 GPU，含探针开销，不是独立 GPU 时间）→ 上下文快照（LOD、烘焙、
 * 剔除、资源池、绘制调用、JS 堆）。不修改产品画质。
 * 软件渲染器结果仅供诊断，不作为真实硬件或多档优化对照。
 */
(async () => {
  const WARMUP_FRAMES = 8
  const SAMPLE_FRAMES = 40
  const FRAME_TIMEOUT_MS = 20000
  const FPS_WINDOW_MS = 4000
  const READY_TIMEOUT_MS = 120000
  const EXPOSE_TIMEOUT_MS = 10000
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const stats = () => window.rhineWorkbench?.stats?.() ?? null
  const sceneHost = () => document.querySelector('.rhine-scene') || document.querySelector('#three-scene')
  const viewerCanvas = () => document.querySelector('.model-viewer canvas')
  const hostHint = '在 DSH 宿主里请先打开「资料馆」窗口并等模型加载；新版插件打开时会挂载 window.rhineWorkbench，旧版未挂载，请更新插件或改用 npm run preview:rhine 预览页。'
  console.log('等待资料馆场景就绪（宿主、画布、统计、模型）……')
  const began = performance.now()
  let host = null
  let canvas = null
  let viewer = false
  while (performance.now() - began < READY_TIMEOUT_MS) {
    host = sceneHost()
    viewer = !!stats()?.viewerOpen && !!viewerCanvas()
    canvas = viewer ? viewerCanvas() : host?.querySelector('canvas') ?? null
    const state = stats()
    if (canvas && (viewer || (Number.isFinite(state?.renderedFrames) && (state?.archiveCount ?? 0) > 0))) break
    if (!viewer && document.querySelector('.rhine-workbench.rhine-scene-unavailable')) {
      console.error('资料馆三维场景不可用（rhine-scene-unavailable）：WebGL 被禁用或资源加载失败，无法测量。')
      return
    }
    if (window.__PRTS_RHINE__ && !window.rhineWorkbench && performance.now() - began > EXPOSE_TIMEOUT_MS) {
      console.error(hostHint)
      return
    }
    await sleep(500)
  }
  const ready = () => {
    const state = stats()
    return !!canvas && canvas.isConnected && (viewer
      ? state?.viewerOpen
      : Number.isFinite(state?.renderedFrames) && (state?.archiveCount ?? 0) > 0)
  }
  if (!ready()) {
    console.error(window.__PRTS_RHINE__ ? hostHint : '请先打开资料馆预览（npm run preview:rhine）并等待模型加载；需要 window.rhineWorkbench.stats()。')
    return
  }
  if (document.hidden) {
    console.error('请保持资料馆可见且在前台。')
    return
  }
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
  if (!gl || typeof gl.finish !== 'function') {
    console.error('拿不到场景的 WebGL 上下文。')
    return
  }
  window.__rhinePerfStop?.()
  const debug = gl.getExtension('WEBGL_debug_renderer_info')
  const adapter = gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER)
  const softwareRenderer = /swiftshader|llvmpipe|softpipe|software/i.test(adapter)
  const heap = () => performance.memory?.usedJSHeapSize ?? null
  const metrics = () => { try { return JSON.parse(host?.dataset.renderQuality || '{}') } catch { return {} } }

  /* 第一段：真实 FPS。轻量 RAF 计数，不做任何同步等待，不干预产品渲染节奏。 */
  const originalRaf = window.requestAnimationFrame
  let rafTicks = 0
  let viewerTicks = 0
  const countingRaf = callback => originalRaf.call(window, time => {
    rafTicks++
    if (viewer && canvas.isConnected) viewerTicks++
    callback(time)
  })
  window.requestAnimationFrame = countingRaf
  const fpsBefore = stats()?.renderedFrames ?? 0
  const fpsStart = performance.now()
  const heapBefore = heap()
  await sleep(FPS_WINDOW_MS)
  const fpsAfter = stats()?.renderedFrames ?? 0
  const fpsWall = (performance.now() - fpsStart) / 1000
  if (window.requestAnimationFrame === countingRaf) window.requestAnimationFrame = originalRaf
  const fpsFrames = viewer ? viewerTicks : fpsAfter - fpsBefore
  const fps = fpsWall > 0 ? fpsFrames / fpsWall : null
  const renderDuty = rafTicks ? fpsFrames / rafTicks : null

  /* 第二段：同步帧成本。只记确实渲染的回调，gl.finish 串行 CPU/GPU，含探针开销。 */
  const perFrame = []
  let enabled = true
  const wrappedRaf = callback => originalRaf.call(window, time => {
    // Already scheduled wrappers become pass-through after cleanup.
    if (!enabled) return callback(time)
    const before = stats()?.renderedFrames
    const started = performance.now()
    try {
      callback(time)
      const after = stats()
      const counted = viewer ? after?.viewerOpen && canvas.isConnected
        : Number.isFinite(before) && after?.renderedFrames > before
      if (counted) {
        gl.finish()
        perFrame.push({
          ms: performance.now() - started,
          tris: after?.renderedTriangles, calls: after?.drawCalls,
          moving: !!after?.movingCamera, transfers: after?.transfers ?? 0,
        })
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
  let before = null
  let after = null
  let initialCanvas = null
  let initialViewer = viewer
  try {
    warmed = await waitFrames(WARMUP_FRAMES)
    perFrame.length = 0
    before = stats()
    initialCanvas = [canvas.width, canvas.height]
    sampled = warmed && await waitFrames(SAMPLE_FRAMES)
    after = stats()
  } finally {
    stop()
    if (window.__rhinePerfStop === stop) delete window.__rhinePerfStop
  }

  const values = perFrame.map(frame => frame.ms).sort((a, b) => a - b)
  const at = p => values.length ? values[Math.min(values.length - 1, Math.floor(values.length * p))] : null
  const span = list => list.length ? [Math.min(...list), Math.max(...list)] : null
  const reasons = []
  if (!warmed || !sampled) reasons.push('实际场景帧不足、测量超时或已停止')
  if (!canvas.isConnected || document.hidden || canvas.width <= 1 || canvas.height <= 1
    || gl.isContextLost()) reasons.push('画布隐藏、销毁或上下文不可用')
  if (initialViewer !== !!after?.viewerOpen) reasons.push('查看器开关状态在采样期间变化')
  if (!viewer && host && (!host.isConnected || !host.clientWidth || !host.clientHeight)) reasons.push('场景宿主不可见')
  if (JSON.stringify(initialCanvas) !== JSON.stringify([canvas.width, canvas.height])) reasons.push('采样期间输出尺寸发生变化')
  if (!viewer && (JSON.stringify(before?.renderQuality) !== JSON.stringify(after?.renderQuality)
    || before?.cameraLocation !== after?.cameraLocation)) reasons.push('采样期间视图或画质发生变化')
  if (!viewer && (after?.renderedFrames ?? 0) - (before?.renderedFrames ?? 0) < SAMPLE_FRAMES) reasons.push('产品渲染计数不足')

  /* 第三段：上下文快照。LOD、烘焙、剔除、资源池、准备队列与动态帧计数。 */
  const s = after ?? {}
  const label = window.__rhinePerfLabel || (viewer ? '360°查看器'
    : s.cameraLocation === 'desk' ? `档案架(${s.physicalFiles ?? '?'}档)` : '检索阵列')
  const run = {
    label, mode: viewer ? 'viewer' : 'scene', 时刻: new Date().toISOString(),
    有效: reasons.length === 0, 原因: reasons,
    adapter, softwareRenderer, devicePixelRatio,
    硬件线程: navigator.hardwareConcurrency ?? null,
    真实FPS: fps !== null ? +fps.toFixed(1) : null,
    FPS样本帧: fpsFrames, RAF节拍: rafTicks, 渲染占空比: renderDuty !== null ? +renderDuty.toFixed(2) : null,
    同步ms_p50: at(0.5), 同步ms_p95: at(0.95), 同步ms_最长: values.at(-1) ?? null, 同步ms_最短: values[0] ?? null,
    样本帧: values.length,
    实际渲染帧: viewer ? perFrame.length + WARMUP_FRAMES : (after?.renderedFrames ?? 0) - (before?.renderedFrames ?? 0),
    三角形区间: span(perFrame.map(frame => frame.tris).filter(Number.isFinite)),
    绘制调用区间: span(perFrame.map(frame => frame.calls).filter(Number.isFinite)),
    动画帧: perFrame.filter(frame => frame.moving).length,
    抽取帧: perFrame.filter(frame => frame.transfers > 0).length,
    画布: [canvas.width, canvas.height], 宿主: viewer ? null : [host?.clientWidth ?? 0, host?.clientHeight ?? 0],
    JS堆增量MB: heapBefore != null && heap() != null ? +(((heap() - heapBefore) / 1048576).toFixed(1)) : null,
    上下文: {
      cameraLocation: s.cameraLocation, location: s.location, quality: s.renderQuality,
      archiveCount: s.archiveCount, archiveInstances: s.archiveInstances,
      physicalFiles: s.physicalFiles, sourceCount: s.sourceCount,
      transfers: s.transfers, searching: s.searching, preparation: s.preparation,
      arrayVisibility: s.arrayVisibility && {
        activeSlots: s.arrayVisibility.activeSlots, visibleSlots: s.arrayVisibility.visibleSlots,
        culledSlots: s.arrayVisibility.culledSlots, shadowSlots: s.arrayVisibility.shadowSlots,
        lod: s.arrayVisibility.lod, batches: s.arrayVisibility.batches,
      },
      shelfInterior: s.shelfInterior && {
        mode: s.shelfInterior.mode, textured: s.shelfInterior.textured, detailed: s.shelfInterior.detailed,
      },
      arrayInterior: s.arrayInterior && {
        mode: s.arrayInterior.mode, arrayGroups: s.arrayInterior.arrayGroups,
        arrayTrianglesPerCassette: s.arrayInterior.arrayTrianglesPerCassette,
        arrayLowTrianglesPerCassette: s.arrayInterior.arrayLowTrianglesPerCassette,
      },
      collectionResources: s.collectionResources,
    },
    metrics: metrics(),
  }
  window.__rhinePerf = run
  window.__rhinePerfHistory = [...(window.__rhinePerfHistory || []), run]
  const summary = row => ({
    序号: window.__rhinePerfHistory.indexOf(row), label: row.label, 有效: row.有效,
    真实FPS: row.真实FPS, '同步ms_p50': row.同步ms_p50, '同步ms_p95': row.同步ms_p95,
    '同步ms_最长': row.同步ms_最长, 三角形: row.三角形区间?.[1], 绘制调用: row.绘制调用区间?.[1],
    画布: row.画布, 动画帧: row.动画帧, 抽取帧: row.抽取帧,
  })
  if (!run.有效) console.warn('无效样本：' + reasons.join('；'))
  if (softwareRenderer) console.warn('软件渲染器：不能用本结果对比真实硬件 FPS 或性能提升。')
  console.table(window.__rhinePerfHistory.map(summary))
  console.log(`第 ${window.__rhinePerfHistory.length} 次测量「${label}」完成；单次报告在 window.__rhinePerf。`)
  console.log('切换到其他视图/状态后再粘贴一次即可追加；全部完成后执行 copy(window.__rhinePerfHistory) 复制汇总。')
})().catch(error => console.error('资料馆测量失败：', error))
