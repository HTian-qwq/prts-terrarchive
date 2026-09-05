/**
 * 设置界面的 Host 半边：通过 Host Connection 的认证 RPC 通道
 * 挂载资料管理能力，供浏览器设置 tab 调用。
 *
 * 纯路由逻辑抽成 buildApi()（方法+路径+体 → {status, json}），
 * Connection 统一处理 Host/Origin/cookie 认证和 RPC 包络，便于无网络单测。
 *
 * 路由一览：
 *   GET  /api/prts-corpus/status    当前版本/文档数/下载进度/生效配置（脱敏）
 *   GET  /api/prts-corpus/releases  本地已装 release 清单（大小/版本/是否激活/需解压）
 *   GET  /api/prts-corpus/check-update  联网检查站点是否有更新版本（本地/远程对比）
 *   POST /api/prts-corpus/download  触发下载 { releaseId? }；省略则使用 PRTS.chat current
 *   POST /api/prts-corpus/activate  切换激活版本 { releaseId }（热重载 store）
 *   POST /api/prts-corpus/delete    删除非当前版本 { releaseId }
 *   GET  /api/prts-corpus/config    生效配置 + 用户层（脱敏）
 *   PUT  /api/prts-corpus/config    写配置补丁（立即生效，cloud 工具热重建）
 */
import { lstat, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { brotliDecompress, gunzip } from 'node:zlib'
import { ensureCorpusRelease, missingEnabledGamePacks, RELEASE_ID_PATTERN,
  readCurrentReleasePointer, resolveTrustedCurrentRelease, validateLocalRelease,
  withReleaseMutationLock } from './installer.js'
import { redactConfig } from './state.js'
import { executeRead } from './read.js'
import { documentGame } from './store.js'

const MAX_BODY_BYTES = 1024 * 1024
const SKIN_STYLES_ROOT = resolve(fileURLToPath(new URL('../lib/skins/', import.meta.url)))
const SKIN_STYLESHEETS = Object.freeze({
  'common.css': join(SKIN_STYLES_ROOT, 'common.css'),
  'prts-agent.css': join(SKIN_STYLES_ROOT, 'prts-agent.css'),
  'endfield-aic.css': join(SKIN_STYLES_ROOT, 'endfield-aic.css'),
})
const ENDFIELD_MAP_ROOT = resolve(fileURLToPath(new URL('../lib/endfield-map/', import.meta.url)))
const ENDFIELD_MAP_MIME = Object.freeze({
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
})
const brotliDecompressAsync = promisify(brotliDecompress)
const gunzipAsync = promisify(gunzip)
const MAX_MAP_COMPRESSED_BYTES = 8 * 1024 * 1024
const MAX_MAP_TEXT_BYTES = 16 * 1024 * 1024
const MAX_MAP_BINARY_BYTES = 32 * 1024 * 1024
const MAX_IDENTITY_CACHE_BYTES = 24 * 1024 * 1024
const MAX_MAP_REQUESTS = 32
const MAP_RESPONSE_TIMEOUT_MS = 60_000
const MAX_IDENTITY_WAITERS = 32
const MAX_IDENTITY_REQUESTS = 64
const ENDFIELD_MAP_ASSETS = (() => {
  const assets = new Set(['map.js'])
  // HTTP 只接受打包时实际存在的逻辑资源名。去掉 .br/.gz 物理后缀后
  // 建表，防止攻击者用随机 .json 路径制造无界的解压 miss 任务。
  for (const name of readdirSync(join(ENDFIELD_MAP_ROOT, 'resources'))) {
    const logical = name.replace(/\.(?:br|gz)$/u, '')
    if (/^map-[0-9a-f]{16}\.(?:json|png)$/u.test(logical)) {
      assets.add(`resources/${logical}`)
    }
  }
  return assets
})()
const identityCache = new Map()
const identityInflight = new Map()
let identityCacheBytes = 0
let activeIdentityDecompressions = 0
let activeIdentityRequests = 0
let activeMapRequests = 0
const identityWaiters = []

/** Serve only packaged, fixed-name stylesheets; caller input never becomes a filesystem path. */
async function serveSkinStylesheet(req, res, fileName) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  const target = SKIN_STYLESHEETS[fileName]
  if (!target) {
    res.writeHead(404)
    res.end()
    return
  }
  try {
    const body = await readFile(target)
    res.writeHead(200, {
      'content-type': 'text/css; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  } catch (error) {
    res.writeHead(error?.code === 'ENOENT' ? 404 : 500)
    res.end()
  }
}

const identityFault = (code, message) => Object.assign(new Error(message), { code })

function assertIdentityRequestActive(signal) {
  if (signal?.aborted) throw identityFault('CANCELLED', '地图资源请求已取消')
}

function acquireIdentityRequest() {
  if (activeIdentityRequests >= MAX_IDENTITY_REQUESTS) {
    throw identityFault('MAP_BUSY', '地图资源解压请求过多')
  }
  activeIdentityRequests += 1
  let released = false
  return () => {
    if (released) return
    released = true
    activeIdentityRequests -= 1
  }
}

function acquireMapRequest() {
  if (activeMapRequests >= MAX_MAP_REQUESTS) {
    throw identityFault('MAP_BUSY', '地图静态资源请求过多')
  }
  activeMapRequests += 1
  let released = false
  return () => {
    if (released) return
    released = true
    activeMapRequests -= 1
  }
}

/**
 * 地图资源会把数 MiB 的 Buffer 交给 ServerResponse。处理函数返回并不代表
 * Buffer 已被 socket 消费，因此总请求槽必须持有到 finish/close；否则不读取
 * 响应的慢客户端可不断累积待发送 Buffer。close/aborted 同时取消尚在排队的
 * identity 解压任务。
 */
function trackMapResponse(req, res, releaseRequest) {
  const controller = new AbortController()
  const hasResponseLifecycle = typeof res.once === 'function'
  let workSettled = false
  let responseSettled = false
  let released = false
  const responseTimer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort()
    responseSettled = true
    res.destroy?.()
    releaseIfSettled()
  }, MAP_RESPONSE_TIMEOUT_MS)
  responseTimer.unref?.()
  const cleanup = () => {
    clearTimeout(responseTimer)
    req.removeListener?.('aborted', onDisconnect)
    res.removeListener?.('finish', onFinish)
    res.removeListener?.('close', onDisconnect)
  }
  const releaseIfSettled = () => {
    if (released) return
    if (!workSettled || !responseSettled) return
    released = true
    cleanup()
    releaseRequest()
  }
  const onDisconnect = () => {
    if (!controller.signal.aborted) controller.abort()
    responseSettled = true
    releaseIfSettled()
  }
  const onFinish = () => {
    responseSettled = true
    releaseIfSettled()
  }
  req.once?.('aborted', onDisconnect)
  res.once?.('finish', onFinish)
  res.once?.('close', onDisconnect)
  if (req.aborted || res.destroyed) onDisconnect()
  return {
    signal: controller.signal,
    complete(responseHandedOff) {
      workSettled = true
      if (!responseHandedOff) {
        if (!controller.signal.aborted) controller.abort()
        responseSettled = true
      } else if (!hasResponseLifecycle) {
        // 单测或非 Node 兼容宿主可能没有 EventEmitter 接口；这种情况下
        // 无法观察 socket 生命周期，只能在 end() 后视为发送完成。
        responseSettled = true
      }
      releaseIfSettled()
    },
  }
}

async function withIdentityDecompressionSlot(operation, { signal } = {}) {
  assertIdentityRequestActive(signal)
  if (activeIdentityDecompressions < 2) activeIdentityDecompressions += 1
  else {
    if (identityWaiters.length >= MAX_IDENTITY_WAITERS) {
      throw identityFault('MAP_BUSY', '地图资源解压队列已满')
    }
    await new Promise((resolveSlot, rejectSlot) => {
      const waiter = { take: null }
      const onAbort = () => {
        const index = identityWaiters.indexOf(waiter)
        if (index >= 0) identityWaiters.splice(index, 1)
        rejectSlot(identityFault('CANCELLED', '地图资源请求已取消'))
      }
      waiter.take = () => {
        signal?.removeEventListener?.('abort', onAbort)
        resolveSlot()
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })
      identityWaiters.push(waiter)
    })
  }
  try {
    assertIdentityRequestActive(signal)
    return await operation()
  } finally {
    const next = identityWaiters.shift()
    if (next) next.take()
    else activeIdentityDecompressions -= 1
  }
}

async function readBoundedStaticFile(path, maximum, { signal } = {}) {
  assertIdentityRequestActive(signal)
  const info = await lstat(path)
  assertIdentityRequestActive(signal)
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) {
    throw new Error('地图资源类型或大小非法')
  }
  let bytes
  try {
    bytes = await readFile(path, signal ? { signal } : undefined)
  } catch (error) {
    if (signal?.aborted && (error?.name === 'AbortError' || error?.code === 'ABORT_ERR')) {
      throw identityFault('CANCELLED', '地图资源请求已取消')
    }
    throw error
  }
  assertIdentityRequestActive(signal)
  if (bytes.length > maximum) throw new Error('地图资源超过大小上限')
  return bytes
}

function acceptedEncodingQuality(header, encoding) {
  const raw = String(header ?? '').trim()
  if (!raw) return encoding === 'identity' ? 1 : 0
  const qualities = new Map()
  for (const part of raw.split(',')) {
    const [namePart, ...parameters] = part.trim().split(';')
    const name = namePart.trim().toLowerCase()
    if (!name) continue
    let quality = 1
    const q = parameters.map((entry) => entry.trim())
      .find((entry) => entry.toLowerCase().startsWith('q='))
    if (q) {
      const parsed = Number(q.slice(2))
      quality = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0
    }
    qualities.set(name, quality)
  }
  if (qualities.has(encoding)) return qualities.get(encoding)
  if (encoding === 'identity') return qualities.get('*') === 0 ? 0 : 1
  return qualities.get('*') ?? 0
}

async function readIdentityTextAsset(target, { signal } = {}) {
  assertIdentityRequestActive(signal)
  try {
    return await readBoundedStaticFile(target, MAX_MAP_TEXT_BYTES, { signal })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  assertIdentityRequestActive(signal)
  const cached = identityCache.get(target)
  if (cached) {
    identityCache.delete(target)
    identityCache.set(target, cached)
    return cached
  }
  if (identityInflight.has(target)) {
    const bytes = await identityInflight.get(target)
    assertIdentityRequestActive(signal)
    return bytes
  }
  // 共享 operation 不绑定创建它的首个 HTTP 请求。每个调用者只取消自己的
  // 等待；否则首个客户端断连会把随后加入的正常客户端一并取消。
  const operation = withIdentityDecompressionSlot(async () => {
    for (const [extension, decompress] of [['.br', brotliDecompressAsync], ['.gz', gunzipAsync]]) {
      try {
        const compressed = await readBoundedStaticFile(`${target}${extension}`,
          MAX_MAP_COMPRESSED_BYTES)
        return await decompress(compressed, { maxOutputLength: MAX_MAP_TEXT_BYTES })
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    throw Object.assign(new Error('地图资源不存在'), { code: 'ENOENT' })
  }).then((bytes) => {
    if (bytes.length <= MAX_IDENTITY_CACHE_BYTES) {
      identityCache.set(target, bytes)
      identityCacheBytes += bytes.length
      while (identityCacheBytes > MAX_IDENTITY_CACHE_BYTES && identityCache.size) {
        const oldest = identityCache.keys().next().value
        const removed = identityCache.get(oldest)
        identityCache.delete(oldest)
        identityCacheBytes -= removed.length
      }
    }
    return bytes
  }).finally(() => { identityInflight.delete(target) })
  identityInflight.set(target, operation)
  const bytes = await operation
  assertIdentityRequestActive(signal)
  return bytes
}

/**
 * 静态回传地图资源。文本类（.js/.json）在包内以 .br/.gz 预压缩副本存放
 * （bin/pack-map-assets.mjs，与 endfield.prts.chat 同一压缩方法）：按请求
 * Accept-Encoding 直接回传对应编码 + Content-Encoding 头，浏览器透明解压，
 * 服务端零解压开销。开发态存在明文原件时自动回退。
 */
async function serveEndfieldMapAsset(req, res, routePrefix) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405)
    res.end()
    return
  }
  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://dsh.invalid').pathname)
  } catch {
    // WHATWG URL 会原样保留非法百分号序列（如 %E4%A6），decodeURIComponent
    // 对其抛 URIError；这是畸形请求而非服务器故障，按 400 结束。
    res.writeHead(400)
    res.end()
    return
  }
  const relative = pathname.slice(routePrefix.length).replace(/^\/+/, '')
  if (!ENDFIELD_MAP_ASSETS.has(relative)) {
    res.writeHead(404)
    res.end()
    return
  }
  let releaseMapRequest
  try {
    releaseMapRequest = acquireMapRequest()
  } catch (error) {
    res.writeHead(503, { 'retry-after': '1' })
    res.end()
    return
  }
  const response = trackMapResponse(req, res, releaseMapRequest)
  let handedOff = false
  const endResponse = (status, headers, body) => {
    res.writeHead(status, headers)
    res.end(body)
    handedOff = true
  }
  try {
    if (response.signal.aborted) return
    const target = resolve(normalize(join(ENDFIELD_MAP_ROOT, relative)))
    if (target !== ENDFIELD_MAP_ROOT && !target.startsWith(ENDFIELD_MAP_ROOT + sep)) {
      endResponse(403)
      return
    }
    const textAsset = /\.(js|json)$/.test(target)
    const accept = req.headers?.['accept-encoding']
    const candidates = textAsset
      ? [
          { encoding: 'br', extension: '.br', quality: acceptedEncodingQuality(accept, 'br'), priority: 3 },
          { encoding: 'gzip', extension: '.gz', quality: acceptedEncodingQuality(accept, 'gzip'), priority: 2 },
          { encoding: 'identity', extension: '', quality: acceptedEncodingQuality(accept, 'identity'), priority: 1 },
        ].filter((candidate) => candidate.quality > 0)
          .sort((left, right) => right.quality - left.quality || right.priority - left.priority)
      : [{ encoding: 'identity', extension: '', quality: 1, priority: 1 }]
    if (!candidates.length) {
      endResponse(406, { vary: 'accept-encoding' })
      return
    }
    for (const candidate of candidates) {
      let releaseIdentityRequest = null
      try {
        let body
        if (candidate.encoding === 'identity' && textAsset) {
          releaseIdentityRequest = acquireIdentityRequest()
          body = await readIdentityTextAsset(target, { signal: response.signal })
        } else {
          body = await readBoundedStaticFile(`${target}${candidate.extension}`,
            textAsset ? MAX_MAP_COMPRESSED_BYTES : MAX_MAP_BINARY_BYTES,
            { signal: response.signal })
        }
        assertIdentityRequestActive(response.signal)
        endResponse(200, {
          'content-type': ENDFIELD_MAP_MIME[extname(target)] ?? 'application/octet-stream',
          ...(candidate.encoding === 'identity' ? {} : { 'content-encoding': candidate.encoding }),
          'cache-control': target.endsWith('map.js') ? 'no-cache' : 'public, max-age=31536000, immutable',
          ...(textAsset ? { vary: 'accept-encoding' } : {}),
        }, req.method === 'HEAD' ? undefined : body)
        return
      } catch (error) {
        if (error?.code === 'CANCELLED') return
        if (error?.code === 'MAP_BUSY') {
          endResponse(503, { 'retry-after': '1', ...(textAsset ? { vary: 'accept-encoding' } : {}) })
          return
        }
        if (error?.code !== 'ENOENT' && error?.code !== 'EISDIR' && error?.code !== 'ENOTDIR') throw error
      } finally {
        releaseIdentityRequest?.()
      }
    }
    endResponse(404)
  } finally {
    response.complete(handedOff)
  }
}

class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const releaseDirSize = async (dir) => {
  let total = 0
  const walk = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile()) total += (await stat(child)).size
    }
  }
  await walk(dir)
  return total
}

const emptyDataset = (game) => ({
  game, present: false, documentCount: 0, compressedSize: 0, packs: [],
  releaseName: null, releaseTitle: null, gameVersion: null, sourceVersion: null, dataVersion: null,
})

/** 把联合 release 中的 pack 汇总成用户可理解的两个游戏资料库。 */
async function readReleaseDatasets(dir, manifest, packManifests = null) {
  const datasets = {
    arknights: emptyDataset('arknights'),
    endfield: emptyDataset('endfield'),
  }
  const sharedPacks = []
  for (const pack of Array.isArray(manifest?.packs) ? manifest.packs : []) {
    const manifestPath = String(pack?.manifest_path ?? '')
    if (!manifestPath || manifestPath.includes('..') || manifestPath.startsWith('/')) continue
    let detail = packManifests?.get(String(pack?.pack_id ?? ''))
    if (!detail) {
      try { detail = JSON.parse(await readFile(join(dir, manifestPath), 'utf8')) } catch { continue }
    }
    const packId = String(detail.pack_id ?? pack.pack_id ?? '')
    const game = detail.game === 'arknights' || detail.game === 'endfield'
      ? detail.game
      : packId === 'official_game' ? 'arknights'
        : packId.startsWith('endfield_') ? 'endfield' : null
    const summary = {
      packId,
      authority: detail.authority ?? pack.authority ?? null,
      documentCount: detail.document_count ?? pack.document_count ?? 0,
      compressedSize: detail.compressed_size ?? pack.compressed_size ?? 0,
      releaseName: detail.release_id ?? null,
      releaseTitle: detail.release_title ?? detail.release_name ?? null,
      gameVersion: detail.game_version ?? null,
      sourceVersion: detail.source_version ?? null,
      dataVersion: detail.data_version ?? pack.data_version ?? null,
    }
    if (!game) { sharedPacks.push(summary); continue }
    const target = datasets[game]
    target.present = true
    target.documentCount += Number(summary.documentCount) || 0
    target.compressedSize += Number(summary.compressedSize) || 0
    target.packs.push(summary)
    // 官方游戏导出的版本信息优先于 reviewed knowledge 的构建哈希。
    if (summary.authority === 'official' || String(summary.authority).includes('official_game')) {
      target.releaseName = summary.releaseName ?? target.releaseName
      target.releaseTitle = summary.releaseTitle ?? target.releaseTitle
      target.gameVersion = summary.gameVersion ?? target.gameVersion
      target.sourceVersion = summary.sourceVersion ?? target.sourceVersion
      target.dataVersion = summary.dataVersion ?? target.dataVersion
    } else {
      target.releaseName ??= summary.releaseName
      target.releaseTitle ??= summary.releaseTitle
      target.gameVersion ??= summary.gameVersion
      target.sourceVersion ??= summary.sourceVersion
      target.dataVersion ??= summary.dataVersion
    }
  }
  return { ...datasets, sharedPacks }
}

async function readLocalReleases(shared, sizeCache = new Map()) {
  const releases = []
  let activeId = null
  try {
    activeId = (await readCurrentReleasePointer(shared.releasesDir)).release_id
  } catch { /* 尚无激活版本 */ }
  let entries = []
  try {
    entries = await readdir(shared.releasesDir, { withFileTypes: true })
  } catch { return { activeId, releases } }
  for (const entry of entries) {
    if (!entry.isDirectory() || !RELEASE_ID_PATTERN.test(entry.name)) continue
    const dir = join(shared.releasesDir, entry.name)
    let manifest = null
    let packManifests = null
    try {
      const validated = await validateLocalRelease(shared.releasesDir, entry.name, { details: true })
      manifest = validated.manifest
      packManifests = validated.packManifests
    } catch { /* 半成品/外来目录：仍列出，标记不完整 */ }
    let sizeBytes = sizeCache.get(entry.name)
    if (sizeBytes === undefined) {
      sizeBytes = await releaseDirSize(dir).catch(() => 0)
      if (manifest) sizeCache.set(entry.name, sizeBytes)
    }
    releases.push({
      releaseId: entry.name,
      active: entry.name === activeId,
      complete: Boolean(manifest),
      dataVersion: manifest?.data_version ?? null,
      documentCount: manifest?.document_count ?? null,
      compressedSize: manifest?.compressed_size ?? null,
      createdAt: manifest?.created_at ?? null,
      sizeBytes,
      needsExtract: true, // 本地分片以 .jsonl.gz 存储，打开时需解压
      datasets: manifest ? await readReleaseDatasets(dir, manifest, packManifests) : null,
    })
  }
  releases.sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))
  return { activeId, releases }
}

/**
 * 检查是否有更新版本。PRTS.chat current 是最新 release 与内容哈希的信任锚；
 * ModelScope 只承载被该摘要约束的文件字节，不参与版本选择。
 * @param {ReturnType<import('./state.js').createSharedState>} shared
 * @param {{ fetchImpl?: typeof fetch }} [env]
 */
async function checkForUpdate(shared, env = {}, sizeCache) {
  const fetchImpl = env.fetchImpl ?? fetch
  const local = await readLocalReleases(shared, sizeCache)
  const localRelease = local.releases.find((release) => release.active)
  const localInfo = {
    releaseId: local.activeId ?? null,
    dataVersion: localRelease?.dataVersion ?? null,
    documentCount: localRelease?.documentCount ?? null,
    sizeBytes: localRelease?.sizeBytes ?? null,
  }
  try {
    const trusted = await resolveTrustedCurrentRelease({ fetchImpl,
      signal: AbortSignal.timeout(20_000) })
    const remote = {
      releaseId: trusted.releaseId,
      dataVersion: trusted.dataVersion,
      minimumAgentVersion: trusted.minimumAgentVersion,
      documentCount: trusted.documentCount,
      compressedSize: trusted.compressedSize,
      uncompressedSize: trusted.uncompressedSize,
      createdAt: null,
    }
    const updateAvailable = local.activeId !== trusted.releaseId
      || (localInfo.dataVersion != null && localInfo.dataVersion !== trusted.dataVersion)
    return { source: 'site', local: localInfo, remote, updateAvailable }
  } catch (error) {
    return { source: null, local: localInfo, remote: null, updateAvailable: false,
      error: `检查更新失败：${error?.message ?? error}` }
  }
}

/**
 * 构建纯 API 核心。
 * @param {ReturnType<import('./state.js').createSharedState>} shared
 * @param {{ logger?: object }} [env]
 */
export function buildApi(shared, env = {}) {
  const sizeCache = new Map()
  const fetchImpl = env.fetchImpl ?? fetch
  let releaseMutation = Promise.resolve()
  const withReleaseMutation = (operation) => {
    const running = releaseMutation.then(operation)
    releaseMutation = running.catch(() => {})
    return running
  }
  const startDownload = async ({ releaseId }) => {
    const progress = shared.download
    if (progress.active) throw new ApiError(409, '已有下载任务在进行中')
    // 目标解析包含最长数十秒的网络请求；下载槽位必须在首个 await 之前同步
    // 占用，否则两次并发 POST /download 都能通过 409 检查并发起双任务。
    progress.active = true
    progress.phase = 'listing'
    progress.source = null
    progress.releaseId = null
    progress.filesDone = 0
    progress.filesTotal = null
    progress.bytesDone = 0
    progress.error = null
    progress.finishedAt = null
    shared.notifyRuntime()
    const releaseSlot = () => {
      progress.active = false
      progress.phase = 'idle'
      progress.finishedAt = new Date().toISOString()
      shared.notifyRuntime()
    }
    let target
    let trustedCurrent = null
    try {
      const requested = releaseId ? String(releaseId) : null
      if (requested && !RELEASE_ID_PATTERN.test(requested)) throw new ApiError(400, 'releaseId 非法')
      try {
        // 下载与更新每次都重新取 current，并将这一个对象原样传到
        // installer；不在两次请求间重新选版，也不允许过期 UI 指定旧版。
        trustedCurrent = await resolveTrustedCurrentRelease({ fetchImpl,
          signal: AbortSignal.timeout(20_000) })
      } catch (error) {
        throw new ApiError(502, `无法从 PRTS.chat 获取可信最新版本：${error?.message ?? error}`)
      }
      if (requested && requested !== trustedCurrent.releaseId) {
        throw new ApiError(409, `最新版本已变为 ${trustedCurrent.releaseId}，请重新检查更新`)
      }
      target = trustedCurrent.releaseId
    } catch (error) {
      releaseSlot()
      throw error
    }
    progress.releaseId = target
    shared.notifyRuntime()

    // 后台执行；结果写回 shared.download，界面轮询 status 跟踪
    void (async () => {
      try {
        const config = shared.effective()
        const result = await ensureCorpusRelease({
          releasesDir: shared.releasesDir,
          releaseId: target,
          ...(trustedCurrent ? { trustedCurrent } : {}),
          order: config.downloadOrder,
          siteBaseUrl: config.downloadSiteBaseUrl,
          requireRelease: true,
          fetchImpl,
          logger: env.logger,
          onProgress: (update) => {
            progress.phase = update.phase
            progress.source = update.source
            progress.filesDone = update.filesDone
            progress.filesTotal = update.filesTotal
            progress.bytesDone = update.bytesDone
          },
        })
        progress.phase = result.status === 'present' ? 'present' : 'done'
        sizeCache.delete(target)
        // 新版本就绪 → 热重载 store（若当前激活版本变了）
        if (shared.store) {
          try {
            const pointer = await readCurrentReleasePointer(shared.releasesDir)
            if (pointer.release_id !== shared.store.releaseId) {
              shared.store.reset()
            }
          } catch { /* current.json 异常时保持现状 */ }
        }
      } catch (error) {
        progress.phase = 'error'
        progress.error = `${error?.code ?? 'ERROR'}: ${error?.message ?? error}`
        env.logger?.warn?.(`prts-corpus: 下载失败 ${progress.error}`)
      } finally {
        progress.active = false
        progress.finishedAt = new Date().toISOString()
        shared.notifyRuntime()
      }
    })()
    return { started: true, releaseId: target }
  }

  /** 原始路由分发：ApiError/配置校验错误转为响应，其余向上抛给 HTTP 层。 */
  const routeCall = async (method, pathname, body, { signal } = {}) => {
    const route = pathname.replace(/^\/api\/prts-corpus\/?/, '').split('?')[0]
    // 「点开证据卡 → 读全文」：用与工具一致的 executeRead 拉取目标原文/实体资料。
    // 仅接受 source_ref / document_id 定位，复用同一套契约与数据版本校验。
    if (method === 'POST' && route === 'read') {
      const store = shared.store
      if (!store?.loaded) throw new ApiError(409, '本地资料尚未就绪')
      const locator = body?.locator
      const selection = body?.selection ?? { mode: 'document' }
      if (!locator || typeof locator !== 'object') throw new ApiError(400, '缺少定位器')
      const hasReadLocator = Boolean(locator.source_ref || locator.document_id)
      const hasActivityLocator = Boolean(locator.activity_id || locator.activity_name)
      const hasCollectionLocator = Boolean(locator.collection_name)
      const streamMode = selection.mode === 'activity' || selection.mode === 'collection'
      const hasExpectedLocator = selection.mode === 'activity' ? hasActivityLocator
        : selection.mode === 'collection' ? hasCollectionLocator : hasReadLocator
      if (!hasExpectedLocator) {
        throw new ApiError(400, streamMode
          ? `${selection.mode} 定位缺少对应的活动/集合名称`
          : '定位器需提供 source_ref / document_id')
      }
      const enabledGames = shared.effective().enabledGames
      if (streamMode) {
        let documents
        try {
          documents = selection.mode === 'activity'
            ? store.activityStoryDocuments({ activityId: locator.activity_id,
                activityName: locator.activity_name })
            : store.endfieldCollectionDocuments({ collectionName: locator.collection_name,
                contentTypes: selection.content_types ?? [] })
        } catch (error) {
          if (error?.code === 'DOCUMENT_AMBIGUOUS') {
            throw new ApiError(400, error.message)
          }
          throw error
        }
        if (documents.some((item) => !enabledGames.includes(documentGame(item.document)))) {
          throw new ApiError(400, '该活动或集合所属游戏资料当前未启用')
        }
      } else {
        let documentId = String(locator.document_id || '')
        if (!documentId && locator.source_ref) {
          const sourceRef = String(locator.source_ref)
          const marker = sourceRef.lastIndexOf(':L')
          if (marker > 0) documentId = store.getDocumentIdByPrefix(sourceRef.slice(0, marker)) || ''
        }
        const metadata = documentId ? store.documents.get(documentId)?.document : null
        if (metadata && !enabledGames.includes(documentGame(metadata))) {
          throw new ApiError(400, '该文档所属游戏资料当前未启用')
        }
      }
      // 限制值夹到契约允许的范围，避免客户端传入超限值导致 executeRead 直接报错。
      const clampInt = (value, min, max, fallback) => {
        const n = Number(value)
        if (!Number.isFinite(n)) return fallback
        return Math.min(max, Math.max(min, Math.round(n)))
      }
      const expected = {
        intent_id: `evidence-${Date.now().toString(36)}`,
        ...(body?.data_version ? { expected_data_version: String(body.data_version) } : {}),
        locator,
        selection,
        limits: {
          max_lines: clampInt(body?.max_lines, 1, 500, 500),
          max_chars: clampInt(body?.max_chars, 100, 100000, 100000),
        },
      }
      const result = await executeRead(store, expected, { logger: env.logger })
      if (result.status !== 'ok') {
        return { status: 200, json: { ok: false, error: result.error } }
      }
      return { status: 200, json: { ok: true, response: result } }
    }
    if (method === 'GET' && route === 'status') {
      const store = shared.store
      const ready = Boolean(store?.loaded)
      const config = shared.effective()
      let installed = false
      let installationIssue = null
      try {
        const pointer = await readCurrentReleasePointer(shared.releasesDir)
        const releaseId = String(pointer.release_id || '')
        const manifest = await validateLocalRelease(shared.releasesDir, releaseId)
        const missingGames = missingEnabledGamePacks(manifest, config.enabledGames)
        installed = Boolean((!pointer.data_version || pointer.data_version === manifest.data_version)
          && missingGames.length === 0)
        if (missingGames.length) installationIssue = `当前版本缺少已启用模块：${missingGames.map((game) =>
          game === 'endfield' ? '终末地' : '明日方舟').join('、')}`
        else if (!installed) installationIssue = 'current.json 或 release-manifest.json 内容无效'
      } catch (error) {
        installationIssue = error?.code === 'ENOENT'
          ? '未找到本地语料；请下载资料或检查资料目录配置'
          : `无法读取本地语料配置：${error?.message ?? error}`
      }
      let storeInfo = { loaded: ready, installed, installationIssue,
        releaseId: null, dataVersion: null, documentCount: null, packCount: null }
      if (store && ready && store.releaseId) {
        storeInfo = { ...storeInfo, loaded: true,
          releaseId: store.releaseId, dataVersion: store.dataVersion,
          documentCount: store.documents.size, packCount: store.packs.size }
      }
      return { status: 200, json: { store: storeInfo, download: { ...shared.download }, config: redactConfig(config) } }
    }
    if (method === 'GET' && route === 'releases') {
      const { activeId, releases } = await readLocalReleases(shared, sizeCache)
      return { status: 200, json: { activeId, releases } }
    }
    if (method === 'GET' && route === 'check-update') {
      return { status: 200, json: await checkForUpdate(shared, env, sizeCache) }
    }
    if (method === 'GET' && route === 'config') {
      return { status: 200, json: { config: redactConfig(shared.effective(), shared.userLayer()), defaultsPresent: true } }
    }
    if (method === 'PUT' && route === 'config') {
      const effective = await shared.saveConfig(body?.patch ?? body, { signal })
      return { status: 200, json: { config: redactConfig(effective, shared.userLayer()) } }
    }
    if (method === 'POST' && route === 'download') {
      return withReleaseMutation(async () => ({
        status: 202, json: await startDownload(body ?? {}),
      }))
    }
    if (method === 'POST' && route === 'activate') {
      const releaseId = String(body?.releaseId ?? '')
      if (!RELEASE_ID_PATTERN.test(releaseId)) throw new ApiError(400, 'releaseId 非法')
      return withReleaseMutation(async () => {
        if (shared.download.active) {
          throw new ApiError(409, '资料下载期间不能切换激活版本')
        }
        try {
          return await withReleaseMutationLock(shared.releasesDir, async () => {
        let manifest
        try {
          manifest = await validateLocalRelease(shared.releasesDir, releaseId, { verifyHashes: true })
        } catch (error) {
          throw new ApiError(400, `版本不完整，无法激活：${error?.message ?? error}`)
        }
        const pointerTemp = join(shared.releasesDir, `current.json.${randomBytes(6).toString('hex')}.tmp`)
        await writeFile(pointerTemp, JSON.stringify({
          release_id: releaseId, data_version: manifest.data_version,
          channel: 'manual', public_download: true, schema_version: 1,
          activated_at: new Date().toISOString(),
        }))
        await rename(pointerTemp, join(shared.releasesDir, 'current.json'))
        shared.store?.reset()
        shared.notifyRuntime()
        env.logger?.info?.(`prts-corpus: 激活版本切换为 ${releaseId}`)
        return { status: 200, json: { activated: releaseId } }
          })
        } catch (error) {
          if (error?.code === 'DOWNLOAD_BUSY') throw new ApiError(409, error.message)
          throw error
        }
      })
    }
    if (method === 'POST' && route === 'delete') {
      const releaseId = String(body?.releaseId ?? '')
      if (!RELEASE_ID_PATTERN.test(releaseId)) throw new ApiError(400, 'releaseId 非法')
      return withReleaseMutation(async () => {
        try {
          return await withReleaseMutationLock(shared.releasesDir, async () => {
        let activeId = null
        try {
          activeId = (await readCurrentReleasePointer(shared.releasesDir)).release_id
        } catch { /* 无激活 */ }
        if (releaseId === activeId) throw new ApiError(409, '不能删除当前激活版本')
        if (shared.download.active && shared.download.releaseId === releaseId) {
          throw new ApiError(409, '该版本正在下载')
        }
        try {
          await validateLocalRelease(shared.releasesDir, releaseId)
        } catch (error) {
          throw new ApiError(400, `目录不是可确认的完整资料版本，拒绝递归删除：${error?.message ?? error}`)
        }
        await rm(join(shared.releasesDir, releaseId), { recursive: true, force: true })
        sizeCache.delete(releaseId)
        return { status: 200, json: { deleted: releaseId } }
          })
        } catch (error) {
          if (error?.code === 'DOWNLOAD_BUSY') throw new ApiError(409, error.message)
          throw error
        }
      })
    }
    throw new ApiError(404, `未知路由 ${method} ${pathname}`)
  }

  return {
    async call(method, pathname, body, options = {}) {
      try {
        return await routeCall(method, pathname, body, options)
      } catch (error) {
        if (error instanceof ApiError) return { status: error.status, json: { error: error.message } }
        if (error?.code === 'INVALID_CONFIG') return { status: 400, json: { error: error.message } }
        throw error
      }
    },
  }
}

/**
 * 通过 Host Connection 的认证 RPC 通道挂 UI API。Connection 统一执行
 * Host/Origin 信任检查和浏览器 cookie 认证，插件不再绕过 /api 安全边界。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<import('./state.js').createSharedState>} shared
 */
export function applyUi(ctx, shared) {
  const connection = ctx.get?.('connection') ?? ctx.connection
  if (!connection) return false
  const api = buildApi(shared, { logger: ctx.logger })
  const endpoints = Object.freeze({
    status: ['GET', '/api/prts-corpus/status'],
    releases: ['GET', '/api/prts-corpus/releases'],
    'check-update': ['GET', '/api/prts-corpus/check-update'],
    'config.get': ['GET', '/api/prts-corpus/config'],
    'config.update': ['PUT', '/api/prts-corpus/config'],
    download: ['POST', '/api/prts-corpus/download'],
    activate: ['POST', '/api/prts-corpus/activate'],
    delete: ['POST', '/api/prts-corpus/delete'],
    read: ['POST', '/api/prts-corpus/read'],
  })
  // 第三参在 rc.2 宿主上是必填（register 直接读取 options.authority，缺失即
  // TypeError 且整个 applyUi 中断）；更新的宿主忽略该参数，两版都安全。
  connection.rpc.handle('/prts-corpus', async (endpoint, payload, signal) => {
    const route = endpoints[endpoint]
    if (!route) {
      return { ok: false, error: { code: 'not-found', message: `未知 PRTS RPC 端点 ${endpoint}`, details: {} } }
    }
    if (Buffer.byteLength(JSON.stringify(payload ?? {})) > MAX_BODY_BYTES) {
      return { ok: false, error: { code: 'bad-request', message: '请求体过大', details: {} } }
    }
    try {
      const result = await api.call(route[0], route[1], payload ?? {}, { signal })
      if (result.status >= 400) {
        return { ok: false, error: { code: result.status === 409 ? 'conflict' : 'bad-request',
          message: result.json.error ?? `PRTS API ${result.status}`, details: { status: result.status } } }
      }
      return { ok: true, value: result.json }
    } catch (error) {
      if (signal?.aborted || error?.code === 'CANCELLED' || error?.name === 'AbortError') {
        return { ok: false, error: { code: 'cancelled', message: 'PRTS 请求已取消', details: {} } }
      }
      // 不把原始 error.message 回传浏览器（ENOENT 等会携带宿主绝对路径）；
      // 细节写宿主日志即可。
      ctx.logger?.warn?.(`prts-corpus RPC ${endpoint} 失败：${error?.stack ?? error}`)
      return { ok: false, error: { code: 'internal-error',
        message: 'PRTS 内部错误，详情见宿主日志', details: {} } }
    }
  }, { authority: 'loopback' })
  const webServer = ctx.get?.('webServer') ?? ctx.webServer
  if (webServer) {
    ctx.effect(() => {
      const disposeSkin = webServer.register({
        kind: 'exact', path: '/prts-corpus/ui-skin.json',
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405); res.end(); return
          }
          const body = Buffer.from(JSON.stringify({ uiSkin: shared.effective().uiSkin }))
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(req.method === 'HEAD' ? undefined : body)
        },
      })
      const disposeAgentSkin = webServer.register({
        kind: 'exact', path: '/prts-corpus/skins/prts-agent.css',
        handler: (req, res) => serveSkinStylesheet(req, res, 'prts-agent.css'),
      })
      const disposeCommonSkin = webServer.register({
        kind: 'exact', path: '/prts-corpus/skins/common.css',
        handler: (req, res) => serveSkinStylesheet(req, res, 'common.css'),
      })
      const disposeAicSkin = webServer.register({
        kind: 'exact', path: '/prts-corpus/skins/endfield-aic.css',
        handler: (req, res) => serveSkinStylesheet(req, res, 'endfield-aic.css'),
      })
      const disposeBundle = webServer.register({
        kind: 'prefix', path: '/prts-corpus/endfield-map',
        handler: (req, res) => serveEndfieldMapAsset(req, res, '/prts-corpus/endfield-map'),
      })
      const disposeResources = webServer.register({
        kind: 'prefix', path: '/webmap3d/resources',
        handler: (req, res) => serveEndfieldMapAsset(req, res, '/webmap3d'),
      })
      return () => {
        disposeResources()
        disposeBundle()
        disposeAicSkin()
        disposeCommonSkin()
        disposeAgentSkin()
        disposeSkin()
      }
    }, 'prts-corpus: skin and Endfield map assets')
  }
  ctx.logger?.info?.('prts-corpus: authenticated settings RPC mounted on /prts-corpus')
  return true
}
