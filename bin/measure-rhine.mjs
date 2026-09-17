#!/usr/bin/env node
// Node / Playwright: npm run measure:rhine
// 在本机浏览器控制台测量请使用 bin/measure-rhine-console.js。
// 只测产品当前实际画质，不修改设置，不比较多个档位。
// 软件渲染器的结果只供诊断，不能作为真实硬件 FPS 或优化倍数对照。
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const env = process.env

function playwright() {
  if (env.PRTS_PLAYWRIGHT_MODULE) return require(env.PRTS_PLAYWRIGHT_MODULE)
  try { return require('playwright') } catch { /* fall through */ }
  throw new Error('需要 Playwright：设置 PRTS_PLAYWRIGHT_MODULE，或在有 playwright 的环境里运行')
}

const url = env.PRTS_RHINE_MEASURE_URL || 'http://127.0.0.1:4177/'
const width = Number(env.PRTS_RHINE_MEASURE_WIDTH || 1280)
const height = Number(env.PRTS_RHINE_MEASURE_HEIGHT || 720)
const settleMs = Number(env.PRTS_RHINE_MEASURE_SETTLE || 3000)
const sampleMs = Number(env.PRTS_RHINE_MEASURE_WINDOW || 6000)
const headless = env.PRTS_BROWSER_HEADLESS !== '0'
if (![width, height, sampleMs].every(value => Number.isFinite(value) && value > 0)
  || !Number.isFinite(settleMs) || settleMs < 0) throw new Error('视口和采样窗口必须为正数，稳定等待时间不能为负数')
if (env.PRTS_RHINE_MEASURE_CONFIGS)
  console.warn('PRTS_RHINE_MEASURE_CONFIGS 已停用；本次只测产品当前实际画质。')
// Software rendering is never forced by this script. Record the real adapter.
const args = (env.PRTS_BROWSER_ARGS || '--no-sandbox,--disable-dev-shm-usage').split(',').filter(Boolean)
const { chromium } = playwright()
const output = env.PRTS_RHINE_MEASURE_OUT || await mkdtemp(join(tmpdir(), 'prts-rhine-measure-'))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({
  headless,
  ...(env.PRTS_BROWSER_EXECUTABLE ? { executablePath: env.PRTS_BROWSER_EXECUTABLE } : {}),
  args,
})

try {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error.message).slice(0, 200)))
  const stats = () => page.evaluate(() => window.rhineWorkbench?.stats?.() ?? null)
  const surface = () => page.evaluate(() => {
    const host = document.querySelector('.rhine-scene') || document.querySelector('#three-scene')
    const canvas = host?.querySelector('canvas')
    let metrics = {}
    try { metrics = JSON.parse(host?.dataset.renderQuality || '{}') } catch { /* unavailable */ }
    return {
      metrics,
      canvas: canvas ? [canvas.width, canvas.height] : null,
      host: host ? [host.clientWidth, host.clientHeight] : null,
      hidden: document.hidden,
    }
  })
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => window.rhineWorkbench?.stats?.().archiveCount > 0,
    undefined, { polling: 500, timeout: 300_000 })
  const adapter = await page.evaluate(() => {
    const host = document.querySelector('.rhine-scene') || document.querySelector('#three-scene')
    const canvas = host?.querySelector('canvas')
    const gl = canvas?.getContext('webgl2') || canvas?.getContext('webgl')
    if (!gl) return { renderer: 'unavailable', devicePixelRatio }
    const debug = gl.getExtension('WEBGL_debug_renderer_info')
    return { renderer: gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER), devicePixelRatio }
  })
  const before = (await stats())?.renderedFrames ?? 0
  let warmed = true
  try {
    await page.waitForFunction(({ from }) => (window.rhineWorkbench?.stats?.().renderedFrames ?? 0) >= from + 2,
      { from: before }, { polling: 250, timeout: 120_000 })
  } catch { warmed = false }
  await page.waitForTimeout(settleMs)
  const startSurface = await surface()
  const mark = await stats()
  const started = performance.now()
  await page.waitForTimeout(sampleMs)
  const after = await stats()
  const elapsedSeconds = (performance.now() - started) / 1000
  const endSurface = await surface()
  const frames = (after?.renderedFrames ?? 0) - (mark?.renderedFrames ?? 0)
  const reasons = []
  if (!warmed) reasons.push('未等到两个实际预热帧')
  if (!Number.isFinite(frames) || frames < 2) reasons.push('采样期间不足两个实际渲染帧')
  if (startSurface.hidden || endSurface.hidden || !endSurface.host?.every(value => value > 0)
    || !endSurface.canvas?.every(value => value > 1)) reasons.push('场景隐藏或渲染尺寸无效')
  if (JSON.stringify(startSurface.canvas) !== JSON.stringify(endSurface.canvas)
    || JSON.stringify(mark?.renderQuality) !== JSON.stringify(after?.renderQuality)
    || mark?.cameraLocation !== after?.cameraLocation) reasons.push('采样期间视图、画质或输出尺寸发生变化')
  if (errors.length) reasons.push('页面出现错误')
  const valid = reasons.length === 0
  const row = {
    key: 'current', label: '当前实际画质', valid, reasons,
    fps: valid ? frames / elapsedSeconds : null,
    frames, elapsedSeconds,
    triangles: after?.renderedTriangles, renderSurface: after?.renderSurface,
    ...endSurface,
    quality: after?.renderQuality, cameraLocation: after?.cameraLocation,
  }
  const softwareRenderer = /swiftshader|llvmpipe|softpipe|software/i.test(adapter.renderer)
  const report = {
    mode: 'current-quality',
    method: 'Single current product configuration; actual rendered-frame counter over wall time; no quality controls or settings changed.',
    limitation: 'Software-renderer measurements are diagnostic only, not hardware FPS or an optimization comparison.',
    url, viewport: [width, height], adapter, softwareRenderer, args, headless, settleMs, sampleMs,
    rows: [row], errors,
  }
  await writeFile(join(output, 'measure.json'), JSON.stringify(report, null, 2))
  console.log('当前实际画质', JSON.stringify(row.quality))
  console.log(valid ? row.fps.toFixed(1) + ' fps（实际渲染计数 / 墙钟时间）' : '无效样本：' + reasons.join('；'),
    'frames ' + frames, 'tris ' + (row.triangles ?? '-'), 'canvas ' + (row.canvas?.join('x') ?? '-'))
  console.log('adapter', adapter.renderer)
  if (softwareRenderer) console.warn('软件渲染器：本结果不能作为真实硬件 FPS 或性能优化对照。')
  console.log('单档测量报告', join(output, 'measure.json'))
  if (errors.length) console.log('page errors', errors.slice(0, 3))
} finally {
  await browser.close()
}
