#!/usr/bin/env node
/**
 * 预压缩终末地地图资源（与 endfield.prts.chat 前端 scripts/precompress.mjs
 * 同一方法）：对 map.js 与 resources/*.json 生成 brotli(q9, TEXT) 与 gzip(9)
 * 两种压缩副本，并删除明文原件——npm 包内只携带压缩版，由 ui.js 的静态
 * 路由按 Accept-Encoding 直接回传对应编码。PNG 已是压缩格式，保持原样。
 *
 * 运行：node bin/pack-map-assets.mjs          # 压缩（幂等，可重复执行）
 *       node bin/pack-map-assets.mjs --restore # 用压缩副本还原明文（调试用）
 */
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { brotliCompress, brotliDecompress, constants, gunzip, gzip } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const brotli = promisify(brotliCompress)
const unbrotli = promisify(brotliDecompress)
const gzipFile = promisify(gzip)
const gunzipFile = promisify(gunzip)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'endfield-map')
const restore = process.argv.includes('--restore')

const targets = [join(root, 'map.js')]
const resourcesDir = join(root, 'resources')
const resourceTargets = new Set()
for (const entry of await readdir(resourcesDir, { withFileTypes: true })) {
  if (!entry.isFile()) continue
  const match = /^(.*\.json)(?:\.(?:br|gz))?$/.exec(entry.name)
  if (match) resourceTargets.add(match[1])
}
targets.push(...[...resourceTargets].sort().map((name) => join(resourcesDir, name)))

const megabytes = (bytes) => (bytes / 1_000_000).toFixed(2)
let rawBytes = 0
let brotliBytes = 0
let gzipBytes = 0
let processed = 0

async function readCompressed(filePath) {
  try {
    return await unbrotli(await readFile(`${filePath}.br`))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  try {
    return await gunzipFile(await readFile(`${filePath}.gz`))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  throw Object.assign(new Error(`找不到明文或压缩副本：${filePath}`), { code: 'ENOENT' })
}

for (const filePath of targets) {
  if (restore) {
    // 明文存在说明已是还原态；否则真正解压 .br（缺失时回退 .gz）。
    try {
      await readFile(filePath)
      continue
    } catch { /* 缺明文 → 从压缩副本还原 */ }
    const restored = await readCompressed(filePath)
    const temp = `${filePath}.restore.tmp-${process.pid}`
    await writeFile(temp, restored)
    await rename(temp, filePath)
    await rm(`${filePath}.br`, { force: true })
    await rm(`${filePath}.gz`, { force: true })
    processed += 1
    continue
  }
  let source
  try {
    source = await readFile(filePath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    // 已同时具备两种发布变体即为打包态；重复执行应是无操作。
    try {
      await Promise.all([readFile(`${filePath}.br`), readFile(`${filePath}.gz`)])
      continue
    } catch { /* 副本不完整：从现有副本恢复明文并补齐 */ }
    source = await readCompressed(filePath)
  }
  const [brotliResult, gzipResult] = await Promise.all([
    brotli(source, {
      params: {
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_QUALITY]: 9,
      },
    }),
    gzipFile(source, { level: 9 }),
  ])
  // 原子写压缩副本，确认落盘后再删明文。
  const tmpBr = `${filePath}.br.tmp-${process.pid}`
  const tmpGz = `${filePath}.gz.tmp-${process.pid}`
  await writeFile(tmpBr, brotliResult)
  await writeFile(tmpGz, gzipResult)
  await rename(tmpBr, `${filePath}.br`)
  await rename(tmpGz, `${filePath}.gz`)
  await rm(filePath, { force: true })
  rawBytes += source.length
  brotliBytes += brotliResult.length
  gzipBytes += gzipResult.length
  processed += 1
}

if (!restore) {
  console.log(`[pack-map-assets] ${processed}/${targets.length} files: ${megabytes(rawBytes)} MB raw → `
    + `${megabytes(brotliBytes)} MB br + ${megabytes(gzipBytes)} MB gzip`)
} else {
  console.log(`[pack-map-assets] restored ${processed}/${targets.length} files to plain text`)
}
