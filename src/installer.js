/**
 * 设置页显式调用的资料包下载器。下载完成并激活 release 后，CorpusStore 才会打开。
 *
 * 下载前先从 PRTS.chat current、release manifest 与 pack manifest 取得受信
 * release ID、data_version 和逐文件摘要；下载源只负责提供与摘要匹配的字节：
 *   1. modelscope —— PRTS.chat 登记的固定 release 镜像；
 *   2. site       —— PRTS.chat 站点资源接口（published/preview 匿名可取）。
 *
 * 任一源下载失败即切换下一源；分片只按 PRTS.chat 可信清单的 sha256 校验，
 * 已存在且校验一致的文件跳过（跨源断点续传天然成立：同一构建的分片哈希相同）。
 * 全部通过后才写 current.json 指针——中途失败不产生“半激活”状态。
 *
 * ModelScope 布局（agent/scripts/publish_modelscope_mirrors.py 发布）：
 *   releases/<release_id>/dataset-manifest.json      ← 仅供镜像自检，插件不信任此清单
 *   releases/<release_id>/<pack>/{pack-manifest.json, shards/*.jsonl.gz,
 *     search-index/*.bin.gz, catalog/documents.jsonl.gz}
 *
 * 站点布局（backend/routers/agent_data.py）：
 *   /api/agent/data/releases/<id>/release-manifest.json
 *   /api/agent/data/releases/<id>/<pack>/pack-manifest.json   ← 逐分片 size+sha256
 *   /api/agent/data/releases/<id>/<pack>/{shards|search-index}/...
 */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { AGENT_VERSION, compareSemver, parseSemver } from './release-compatibility.js'

/** ModelScope 分仓：两款游戏各自资料 + 跨游戏共享审校资料。 */
export const MODELSCOPE_REPOS = Object.freeze({
  official: 'HTiantian/prts-agent-corpus-arknights-gamedata',
  endfield: 'HTiantian/prts-agent-corpus-endfield',
  community: 'HTiantian/prts-agent-corpus-selfbuilt',
})

/**
 * ModelScope 按资料所有权分仓。只更新终末地时，未变化的明日方舟与共享包
 * 不复制到新 release 目录，而是继续引用其最后一次已发布清单。组合关系
 * 必须显式固定，不能按“各仓最新”猜测，否则并发发布时会拼出未经审核的版本。
 */
export const MODELSCOPE_RELEASE_COMPOSITIONS = Object.freeze({
  'agent-corpus-v2-20260903-xuesong-youmeng-v1': Object.freeze({
    dataVersion: '77df7c534525256af1dd36b68128cdd878ac2f3bc109636c5051fa85dd3dae09',
    releases: Object.freeze({
      official: 'agent-corpus-v1-20260826-timeline-v1',
      endfield: 'agent-corpus-v2-20260903-xuesong-youmeng-v1',
      community: 'agent-corpus-v1-20260826-timeline-v1',
    }),
  }),
  'agent-corpus-v2-20260905-character-activity-split-v1': Object.freeze({
    dataVersion: 'ebf6bec17dc40894c8bc1987197f34bd9800be77baa578de4a04f241c542fba9',
    releases: Object.freeze({
      official: 'agent-corpus-v2-20260904-retraveler-alias-fix-v1',
      endfield: 'agent-corpus-v2-20260904-retraveler-alias-fix-v1',
      community: 'agent-corpus-v2-20260905-character-activity-split-v1',
    }),
  }),
})

/** 默认 pin 的 release（站点已发布；ModelScope 未就绪时自动回退站点源）。 */
export const DEFAULT_RELEASE_ID = 'agent-corpus-v2-20260903-xuesong-youmeng-v1'

export const DEFAULT_SITE_BASE_URL = 'https://prts.chat'

/** 字节回退站点必须是 HTTPS；仅本地开发允许环回 HTTP。它不参与选版或摘要签发。 */
export function normalizeSiteBaseUrl(value = DEFAULT_SITE_BASE_URL) {
  let url
  try { url = new URL(String(value ?? '')) } catch {
    throw new InstallerFault('INVALID_REQUEST', 'siteBaseUrl 不是有效 URL')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new InstallerFault('INVALID_REQUEST',
      'siteBaseUrl 必须使用 HTTPS（本地环回可用 HTTP），且不能包含凭证、查询或片段')
  }
  return url.toString().replace(/\/+$/, '')
}

/**
 * release id 白名单：必须以字母/数字开头，禁止路径分隔符与纯点号段（"."、
 * ".." 会被直接拒绝），避免 releaseId 拼进 releasesDir 后逃逸到上级目录
 * （ui.js 的 delete 路由会对该目录执行递归删除）。
 */
export const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const PACK_IDS = ['official_game', 'endfield_official_game', 'endfield_reviewed_knowledge',
  'reviewed_wiki', 'terra_journey', 'entities', 'references']
const PACK_DESCRIPTOR_FIELDS = Object.freeze([
  'pack_id', 'manifest_path', 'authority', 'data_version', 'document_count',
  'line_count', 'compressed_size', 'uncompressed_size', 'shard_count',
])
const PACK_DESCRIPTOR_FIELD_SET = new Set(PACK_DESCRIPTOR_FIELDS)
const REQUIRED_GAME_PACK = Object.freeze({
  arknights: 'official_game',
  endfield: 'endfield_official_game',
})
const ASSET_PATH_PATTERN = /^(?:shards\/[A-Za-z0-9._-]+\.jsonl|search-index\/[A-Za-z0-9._-]+\.bin|catalog\/[A-Za-z0-9._-]+\.jsonl)\.gz$/
const wait = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds) })

/** 清单类请求的显式超时与响应体大小上限（被劫持源不得用超大清单拖垮内存/磁盘）。 */
const MANIFEST_TIMEOUT_MS = 20_000
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024
const MAX_CURRENT_POINTER_BYTES = 64 * 1024
/** 源未提供 sha256 的文件（站点 pack/release 清单本体）允许的最大体积。 */
const MAX_UNVERIFIED_BYTES = 4 * 1024 * 1024
const RELEASE_ALGORITHM = 'prts-browser-corpus-release-v1'
const PACK_ALGORITHMS = Object.freeze({
  'prts-browser-corpus-pack-v1': 1,
  'prts-browser-corpus-pack-v2': 2,
})
export const SUPPORTED_SEARCH_INDEX_ALGORITHMS = Object.freeze({
  'prts-browser-trigram-postings-v1': 1,
  'prts-browser-ngram-postings-v2': 2,
})
// 只接受本模块从固定 PRTS.chat origin 解析出来的对象作为跨层快照。WeakMap
// 保存一份与公开返回值分离的不可变副本；即使内部调用者尝试修改返回对象，
// 下载器也只读取私有 canonical 值。
const trustedCurrentSnapshots = new WeakMap()

/**
 * 资料包资源上限是本地解析器的安全不变量，不随部署配置放宽。当前正式包约
 * 621 个资源、155 MiB 压缩 / 617 MiB 解压；这里保留数倍增长空间，同时
 * 阻止恶意清单借文件数、下载总量或 gzip 膨胀耗尽 Host 资源。
 */
export const CORPUS_RESOURCE_LIMITS = Object.freeze({
  maxAssets: 4096,
  maxAssetCompressedBytes: 64 * 1024 * 1024,
  maxAssetUncompressedBytes: 128 * 1024 * 1024,
  maxReleaseCompressedBytes: 1024 * 1024 * 1024,
  maxReleaseUncompressedBytes: 4 * 1024 * 1024 * 1024,
})
/**
 * 单文件下载整体超时：慢速滴流的源不应长期占用下载槽位。按体积给足带宽
 * 余量（≥64 KiB/s），下限 60s、上限 15 分钟；体积未知时按 60s 计。
 */
const downloadTimeoutMs = (size) => (Number.isInteger(size) && size > 0
  ? Math.min(15 * 60_000, Math.max(60_000, 60_000 + Math.ceil(size / 65536) * 1000))
  : 60_000)

const isTimeoutError = (error) => error?.name === 'TimeoutError'
  || (error?.name === 'AbortError' && error?.message?.includes('timeout'))

async function linuxProcessStart(pid) {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid < 1) return null
  try {
    const value = await readFile(`/proc/${pid}/stat`, 'utf8')
    const suffix = value.slice(value.lastIndexOf(') ') + 2).trim().split(/\s+/u)
    return suffix[19] || null // proc_pid_stat(5) field 22, suffix starts at field 3
  } catch {
    return null
  }
}

const processGone = async (pid, recordedStart = null) => {
  try {
    process.kill(pid, 0)
    if (recordedStart) {
      const currentStart = await linuxProcessStart(pid)
      if (currentStart && currentStart !== recordedStart) return true
    }
    return false
  } catch (probe) {
    return probe?.code === 'ESRCH'
  }
}

const LEASE_NAME_PATTERN = /^lease-(\d+)-(\d+|na)-([0-9a-f]{24})$/u

/**
 * 跨进程锁采用 Lamport bakery 式的唯一 lease 文件，而不是共用一个需要
 * “判断后删除”的 lockfile。每个竞争者只会删除自己的随机文件；崩溃残留
 * 也按该唯一文件回收，因而不存在 reaper 把新主锁误删或自身残留永久
 * 業死锁的竞态。文件初始内容为 choosing，随后写入单调 ticket；同 ticket
 * 用唯一文件名排序。
 */
async function readLease(lockDir, name) {
  const match = LEASE_NAME_PATTERN.exec(name)
  if (!match) return null
  const path = join(lockDir, name)
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) return null
    const content = info.size <= 64 ? String(await readFile(path, 'utf8')).trim() : ''
    const ticket = /^[1-9]\d{0,15}$/u.test(content) ? Number(content) : null
    return {
      name, path, pid: Number(match[1]), processStart: match[2] === 'na' ? null : match[2],
      ticket: Number.isSafeInteger(ticket) ? ticket : null,
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function activeLeases(lockDir) {
  const names = await readdir(lockDir)
  const leases = (await Promise.all(names.map((name) => readLease(lockDir, name))))
    .filter(Boolean)
  const active = []
  for (const lease of leases) {
    if (await processGone(lease.pid, lease.processStart)) {
      // 路径含 96-bit 随机 token，新竞争者不会复用；这里精确删除
      // 已消失进程的 lease，不会命中另一个刚创建的锁。
      await rm(lease.path, { force: true }).catch(() => {})
    } else {
      active.push(lease)
    }
  }
  return active
}

async function acquireReleaseMutationLock(releasesDir) {
  await mkdir(resolve(releasesDir), { recursive: true, mode: 0o700 })
  const releasesRoot = await realpath(resolve(releasesDir))
  const lockDirPath = join(releasesRoot, '.release-mutation-locks')
  await mkdir(lockDirPath, { mode: 0o700 }).catch((error) => {
    if (error?.code !== 'EEXIST') throw error
  })
  const lockDir = await requireContainedDirectory(lockDirPath, releasesRoot,
    '资料变更锁目录', 'INVALID_RELEASE')
  const processStart = await linuxProcessStart(process.pid)
  const token = randomBytes(12).toString('hex')
  const name = `lease-${process.pid}-${processStart ?? 'na'}-${token}`
  const path = join(lockDir, name)
  const handle = await open(path, 'wx', 0o600)
  const deadline = Date.now() + 30_000
  try {
    await handle.writeFile('choosing\n')
    await handle.sync()
    const existing = await activeLeases(lockDir)
    const maximum = existing.reduce((value, lease) =>
      lease.ticket == null ? value : Math.max(value, lease.ticket), 0)
    const ticket = maximum + 1
    await handle.truncate(0)
    await handle.write(`${ticket}\n`, 0, 'utf8')
    await handle.sync()
    for (;;) {
      const leases = await activeLeases(lockDir)
      const blocked = leases.some((lease) => lease.name !== name
        && (lease.ticket == null || lease.ticket < ticket
          || (lease.ticket === ticket && lease.name < name)))
      if (!blocked) {
        return async () => {
          await handle.close()
          await rm(path, { force: true })
        }
      }
      if (Date.now() >= deadline) {
        throw new InstallerFault('DOWNLOAD_BUSY', '另一个进程正在下载、激活或删除资料版本')
      }
      await wait(100)
    }
  } catch (error) {
    await handle.close().catch(() => {})
    await rm(path, { force: true }).catch(() => {})
    throw error
  }
}

/** 跨 Host 进程串行化 release 指针与目录变更。 */
export async function withReleaseMutationLock(releasesDir, operation) {
  const release = await acquireReleaseMutationLock(releasesDir)
  try {
    return await operation()
  } finally {
    await release()
  }
}

async function ensureManagedReleaseDirectory(releasesDir, releaseId) {
  await mkdir(resolve(releasesDir), { recursive: true, mode: 0o700 })
  const releasesRoot = await realpath(resolve(releasesDir))
  const requested = join(releasesRoot, releaseId)
  await mkdir(requested, { recursive: true, mode: 0o700 })
  const releaseDir = await requireContainedDirectory(requested, releasesRoot,
    `release ${releaseId}`, 'INVALID_RELEASE')
  return { releasesRoot, releaseDir }
}

async function prepareAssetTarget(releaseDir, relativePath) {
  const [packId, category, filename, ...extra] = relativePath.split('/')
  if (extra.length || !PACK_IDS.includes(packId)
      || !['shards', 'search-index', 'catalog'].includes(category) || !filename) {
    throw new InstallerFault('INVALID_MANIFEST', `资源路径非法: ${relativePath}`)
  }
  let parent = releaseDir
  for (const segment of [packId, category]) {
    const child = join(parent, segment)
    await mkdir(child, { recursive: false, mode: 0o700 }).catch((error) => {
      if (error?.code !== 'EEXIST') throw error
    })
    const link = await lstat(child)
    if (!link.isDirectory() || link.isSymbolicLink()) {
      throw new InstallerFault('INVALID_RELEASE', `资源父目录不是受管目录: ${relativePath}`)
    }
    const actual = await realpath(child)
    if (!isContainedPath(releaseDir, actual)) {
      throw new InstallerFault('INVALID_RELEASE', `资源父目录越出 release: ${relativePath}`)
    }
    parent = child
  }
  return join(parent, filename)
}

async function writeJsonAtomically(path, value) {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

async function currentReleaseReady(releasesDir, requested, expectedDataVersion = null) {
  try {
    const pointer = await readCurrentReleasePointer(releasesDir)
    const releaseId = pointer.release_id
    // 调用方给出 releaseId 就是显式 pin；绝不能因为 current 指向另一个
    // 完整版本就返回 present，否则用户要的版本实际上从未准备。
    if (releaseId !== requested) return false
    const manifest = await validateLocalRelease(releasesDir, releaseId, { verifyHashes: true })
    return (!pointer.data_version || pointer.data_version === manifest.data_version)
      && (!expectedDataVersion || manifest.data_version === expectedDataVersion)
  } catch {
    return false
  }
}

export class InstallerFault extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** 返回当前 release 相对启用游戏所缺的官方资料包。 */
export function missingEnabledGamePacks(manifest, enabledGames = []) {
  const packs = new Set((manifest?.packs || []).map((pack) => String(pack?.pack_id || '')))
  return [...new Set(enabledGames)].filter((game) => REQUIRED_GAME_PACK[game]
    && !packs.has(REQUIRED_GAME_PACK[game]))
}

async function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path).on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

const isContainedPath = (root, target) => {
  const child = relative(root, target)
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

/** 有界读取受管 current.json，避免符号链接或超大本地指针先于 release 校验生效。 */
export async function readCurrentReleasePointer(releasesDir) {
  const root = await realpath(resolve(releasesDir))
  const path = join(root, 'current.json')
  const link = await lstat(path)
  if (!link.isFile() || link.isSymbolicLink() || link.size > MAX_CURRENT_POINTER_BYTES) {
    throw new InstallerFault('INVALID_RELEASE', 'current.json 不是有效的受管指针')
  }
  const actual = await realpath(path)
  if (!isContainedPath(root, actual)) {
    throw new InstallerFault('INVALID_RELEASE', 'current.json 越出 releases 目录')
  }
  let pointer
  try { pointer = JSON.parse(await readFile(path, 'utf8')) } catch {
    throw new InstallerFault('INVALID_RELEASE', 'current.json 不是有效 JSON')
  }
  const releaseId = String(pointer?.release_id ?? '')
  if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer)
      || !RELEASE_ID_PATTERN.test(releaseId)
      || (pointer.data_version != null
        && !SHA256_PATTERN.test(String(pointer.data_version)))) {
    throw new InstallerFault('INVALID_RELEASE', 'current.json 内容非法')
  }
  return { ...pointer, release_id: releaseId }
}

const invalid = (code, message) => {
  throw new InstallerFault(code, message)
}

function requireInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER,
  code = 'INVALID_MANIFEST' } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(code, `${label} 非法`)
  }
  return value
}

function normalizePackDescriptor(descriptor, label, code = 'INVALID_MANIFEST') {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)
      || Object.keys(descriptor).some((key) => !PACK_DESCRIPTOR_FIELD_SET.has(key))) {
    invalid(code, `${label} pack 描述包含非法字段`)
  }
  const packId = requirePackId(String(descriptor.pack_id ?? ''), code)
  const authority = descriptor.authority == null ? 'official' : String(descriptor.authority)
  if (descriptor.manifest_path !== `${packId}/pack-manifest.json`
      || !SHA256_PATTERN.test(String(descriptor.data_version ?? ''))
      || !authority || authority.length > 128 || /[\p{Cc}\p{Cf}]/u.test(authority)) {
    invalid(code, `${label} pack 描述非法: ${packId}`)
  }
  return Object.freeze({
    pack_id: packId,
    manifest_path: descriptor.manifest_path,
    authority,
    data_version: descriptor.data_version,
    document_count: requireInteger(descriptor.document_count, `${label}.${packId}.document_count`, {
      minimum: 1, maximum: 10_000_000, code,
    }),
    line_count: requireInteger(descriptor.line_count, `${label}.${packId}.line_count`, {
      maximum: 100_000_000, code,
    }),
    compressed_size: requireInteger(descriptor.compressed_size, `${label}.${packId}.compressed_size`, {
      minimum: 1, maximum: CORPUS_RESOURCE_LIMITS.maxReleaseCompressedBytes, code,
    }),
    uncompressed_size: requireInteger(descriptor.uncompressed_size, `${label}.${packId}.uncompressed_size`, {
      minimum: 1, maximum: CORPUS_RESOURCE_LIMITS.maxReleaseUncompressedBytes, code,
    }),
    shard_count: requireInteger(descriptor.shard_count, `${label}.${packId}.shard_count`, {
      minimum: 1, maximum: CORPUS_RESOURCE_LIMITS.maxAssets, code,
    }),
  })
}

async function requireContainedDirectory(path, root, label, code = 'INVALID_RELEASE') {
  const link = await lstat(path)
  if (!link.isDirectory() || link.isSymbolicLink()) invalid(code, `${label} 不是受管目录`)
  const actual = await realpath(path)
  if (!isContainedPath(root, actual)) invalid(code, `${label} 越出 releases 目录`)
  return actual
}

async function readContainedJson(path, root, label, code = 'INVALID_RELEASE') {
  const link = await lstat(path)
  if (!link.isFile() || link.isSymbolicLink() || link.size > MAX_MANIFEST_BYTES) {
    invalid(code, `${label} 不是有效的受管清单`)
  }
  const actual = await realpath(path)
  if (!isContainedPath(root, actual)) invalid(code, `${label} 越出 release 目录`)
  let value
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error instanceof InstallerFault) throw error
    invalid(code, `${label} 不是有效 JSON`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(code, `${label} 顶层必须是对象`)
  }
  return value
}

function validateReleaseHeader(releaseId, manifest, code = 'INVALID_MANIFEST') {
  if (manifest?.algorithm !== RELEASE_ALGORITHM || manifest?.schema_version !== 1
      || manifest?.release_id !== releaseId
      || !SHA256_PATTERN.test(String(manifest?.data_version ?? ''))
      || !Array.isArray(manifest?.required_packs) || manifest.required_packs.length === 0
      || manifest.required_packs.length > PACK_IDS.length
      || !Array.isArray(manifest?.packs) || manifest.packs.length === 0
      || manifest.packs.length > PACK_IDS.length) {
    invalid(code, 'release-manifest 内容不完整或与 releaseId 不匹配')
  }
  const minimumAgentVersion = manifest.minimum_agent_version
  if (!parseSemver(minimumAgentVersion)) {
    invalid(code, 'release-manifest minimum_agent_version 缺失或不是有效 SemVer')
  }
  if (!parseSemver(AGENT_VERSION)) {
    invalid('INCOMPATIBLE_RELEASE', `插件自身版本不是有效 SemVer: ${AGENT_VERSION}`)
  }
  if (compareSemver(AGENT_VERSION, minimumAgentVersion) < 0) {
    invalid('INCOMPATIBLE_RELEASE',
      `资料版本至少需要 prts-terrarchive ${minimumAgentVersion}，当前为 ${AGENT_VERSION}`)
  }
  const descriptors = new Map()
  for (const rawDescriptor of manifest.packs) {
    const descriptor = normalizePackDescriptor(rawDescriptor, 'release', code)
    const packId = descriptor.pack_id
    if (descriptors.has(packId)) {
      invalid(code, `release pack 描述非法: ${packId}`)
    }
    descriptors.set(packId, descriptor)
  }
  const required = new Set()
  for (const value of manifest.required_packs) {
    const packId = requirePackId(String(value || ''), code)
    if (required.has(packId) || !descriptors.has(packId)) {
      invalid(code, `required pack 描述非法: ${packId}`)
    }
    required.add(packId)
  }
  return descriptors
}

function validatePackManifest(packId, pack, descriptor, totals, code = 'INVALID_MANIFEST') {
  const expectedSchema = PACK_ALGORITHMS[String(pack?.algorithm ?? '')]
  if (!expectedSchema || pack?.schema_version !== expectedSchema
      || (pack.pack_id != null && pack.pack_id !== packId)
      || !SHA256_PATTERN.test(String(pack?.data_version ?? ''))
      || !Array.isArray(pack?.shards) || pack.shards.length === 0) {
    invalid(code, `pack-manifest 内容不完整: ${packId}`)
  }
  if (pack.search_index != null && (!pack.search_index || typeof pack.search_index !== 'object'
      || Array.isArray(pack.search_index) || !Array.isArray(pack.search_index.shards))) {
    invalid(code, `pack-manifest search_index 非法: ${packId}`)
  }
  if (pack.search_index?.shards?.length) {
    const index = pack.search_index
    if (!SUPPORTED_SEARCH_INDEX_ALGORITHMS[index.algorithm]) {
      invalid('INCOMPATIBLE_RELEASE',
        `${packId} 使用当前插件不支持的检索索引算法: ${index.algorithm || '未声明'}`)
    }
    const v1 = index.algorithm === 'prts-browser-trigram-postings-v1'
      && index.schema_version === 1 && index.normalization === 'unicode-nfc-casefold'
      && index.gram_size === 3 && index.format === 'varint-postings-le-v1'
    const v2 = index.algorithm === 'prts-browser-ngram-postings-v2'
      && index.schema_version === 2
      && ['unicode-nfkc-casefold-collapse-space', 'unicode-nfkc-lower-collapse-space']
        .includes(index.normalization)
      && JSON.stringify(index.gram_sizes) === '[1,2,3]'
      && index.format === 'varint-postings-le-v2'
    const range = (shard) => ({ first: v2 ? shard.first_ngram : shard.first_trigram,
      last: v2 ? shard.last_ngram : shard.last_trigram })
    if ((!v1 && !v2) || index.shards.some((shard) => {
      const bounds = range(shard)
      const minimum = v2 ? 1 : 3
      return typeof bounds.first !== 'string' || typeof bounds.last !== 'string'
        || [...bounds.first].length < minimum || [...bounds.first].length > 3
        || [...bounds.last].length < minimum || [...bounds.last].length > 3
        || Buffer.compare(Buffer.from(bounds.first, 'utf8'), Buffer.from(bounds.last, 'utf8')) > 0
    })) invalid(code, `pack-manifest search_index 版本或范围非法: ${packId}`)
  }
  const documentCount = requireInteger(pack.document_count, `${packId}.document_count`,
    { minimum: 1, maximum: 10_000_000, code })
  const lineCount = requireInteger(pack.line_count, `${packId}.line_count`,
    { maximum: 100_000_000, code })
  const searchShards = pack.search_index?.shards ?? []
  const catalog = pack.document_catalog
  if (catalog != null && (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)
      || catalog.algorithm !== 'prts-browser-document-catalog-v1'
      || catalog.schema_version !== 1 || catalog.document_count !== documentCount)) {
    invalid(code, `pack-manifest document_catalog 非法: ${packId}`)
  }
  const catalogAssets = catalog ? [catalog] : []
  if (pack.shards.length + searchShards.length + catalogAssets.length
        > CORPUS_RESOURCE_LIMITS.maxAssets
      || totals.assets + pack.shards.length + searchShards.length + catalogAssets.length
        > CORPUS_RESOURCE_LIMITS.maxAssets) {
    invalid(code, '资料 release 的资源文件数超过上限')
  }
  const assets = [
    ...pack.shards.map((asset) => ({ asset, kind: 'shards/' })),
    ...searchShards.map((asset) => ({ asset, kind: 'search-index/' })),
    ...catalogAssets.map((asset) => ({ asset, kind: 'catalog/' })),
  ]
  const paths = new Set()
  let compressedSize = 0
  let uncompressedSize = 0
  for (const { asset, kind } of assets) {
    const assetPath = String(asset?.path || '')
    const compressed = asset?.compressed_size
    const uncompressed = asset?.uncompressed_size
    const expectedHash = String(asset?.sha256 || '')
    if (!ASSET_PATH_PATTERN.test(assetPath) || !assetPath.startsWith(kind) || paths.has(assetPath)
        || !SHA256_PATTERN.test(expectedHash)) {
      invalid(code, `分片描述非法: ${packId}/${assetPath}`)
    }
    requireInteger(compressed, `${packId}/${assetPath}.compressed_size`, {
      minimum: 1, maximum: CORPUS_RESOURCE_LIMITS.maxAssetCompressedBytes, code,
    })
    requireInteger(uncompressed, `${packId}/${assetPath}.uncompressed_size`, {
      minimum: 1, maximum: CORPUS_RESOURCE_LIMITS.maxAssetUncompressedBytes, code,
    })
    paths.add(assetPath)
    compressedSize += compressed
    uncompressedSize += uncompressed
  }
  totals.assets += assets.length
  totals.compressed += compressedSize
  totals.uncompressed += uncompressedSize
  totals.documents += documentCount
  totals.lines += lineCount
  if (totals.assets > CORPUS_RESOURCE_LIMITS.maxAssets
      || totals.compressed > CORPUS_RESOURCE_LIMITS.maxReleaseCompressedBytes
      || totals.uncompressed > CORPUS_RESOURCE_LIMITS.maxReleaseUncompressedBytes) {
    invalid(code, '资料 release 超过本地资源上限')
  }
  if (pack.compressed_size !== compressedSize || pack.uncompressed_size !== uncompressedSize) {
    invalid(code, `pack-manifest 资源汇总不一致: ${packId}`)
  }
  const comparable = ['data_version', 'document_count', 'line_count', 'compressed_size',
    'uncompressed_size']
  for (const field of comparable) {
    if (descriptor?.[field] != null && descriptor[field] !== pack[field]) {
      invalid(code, `release 与 pack-manifest 的 ${field} 不一致: ${packId}`)
    }
  }
  const packAuthority = String(pack.authority ?? 'official')
  if (!packAuthority || packAuthority.length > 128 || /[\p{Cc}\p{Cf}]/u.test(packAuthority)
      || descriptor?.authority !== packAuthority) {
    invalid(code, `release 与 pack-manifest 的 authority 不一致: ${packId}`)
  }
  if (descriptor?.shard_count != null && descriptor.shard_count !== assets.length) {
    invalid(code, `release 与 pack-manifest 的 shard_count 不一致: ${packId}`)
  }
  return assets.map(({ asset }) => asset)
}

function validateReleaseTotals(manifest, totals, code = 'INVALID_MANIFEST') {
  const fields = [
    ['document_count', 'documents', 10_000_000],
    ['line_count', 'lines', 100_000_000],
    ['compressed_size', 'compressed', CORPUS_RESOURCE_LIMITS.maxReleaseCompressedBytes],
    ['uncompressed_size', 'uncompressed', CORPUS_RESOURCE_LIMITS.maxReleaseUncompressedBytes],
  ]
  for (const [field, total, maximum] of fields) {
    requireInteger(manifest[field], `release.${field}`, {
      minimum: field === 'document_count' ? 1 : 0, maximum, code,
    })
    if (manifest[field] !== totals[total]) invalid(code, `release.${field} 与 pack 汇总不一致`)
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * release.data_version 是构建器对 pack 逐文件哈希投影的内容根。这一步使
 * current 返回的唯一可信根真正约束后续 versioned pack-manifest；否则
 * 被污染的中间缓存可在保持汇总尺寸不变时替换逐文件哈希。
 */
function validateTrustedReleaseRoot(manifest, packManifests, code = 'INVALID_MANIFEST') {
  const compilerVersion = String(manifest?.compiler_version ?? '')
  const sourceUpdateId = String(manifest?.source_update_id ?? '')
  const snapshotPrefix = 'local-snapshot:'
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(compilerVersion)
      || !sourceUpdateId.startsWith(snapshotPrefix)
      || !/^[A-Za-z0-9._-]{1,160}$/u.test(sourceUpdateId.slice(snapshotPrefix.length))
      || manifest.corpus_version !== manifest.data_version
      || manifest.content_tree_sha256 !== manifest.data_version) {
    invalid(code, 'release 缺少可验证的内容根元数据')
  }
  const packs = manifest.packs.map((descriptor) => {
    const pack = packManifests.get(descriptor.pack_id)
    if (!pack) invalid(code, `release 缺少 pack 清单: ${descriptor.pack_id}`)
    const authority = String(pack.authority ?? 'official')
    if (!authority || authority.length > 128 || /[\p{Cc}\p{Cf}]/u.test(authority)) {
      invalid(code, `pack authority 非法: ${descriptor.pack_id}`)
    }
    return {
      pack_id: descriptor.pack_id,
      data_version: pack.data_version,
      authority,
      shards: pack.shards.map((asset) => ({ path: asset.path, sha256: asset.sha256 })),
      search_index_shards: (pack.search_index?.shards ?? [])
        .map((asset) => ({ path: asset.path, sha256: asset.sha256 })),
      ...(pack.document_catalog ? { document_catalog: {
        path: pack.document_catalog.path, sha256: pack.document_catalog.sha256,
      } } : {}),
    }
  })
  const calculated = createHash('sha256').update(canonicalJson({
    compiler_version: compilerVersion,
    source_snapshot: sourceUpdateId.slice(snapshotPrefix.length),
    packs,
  })).digest('hex')
  if (calculated !== manifest.data_version) {
    invalid(code, 'release data_version 无法约束 pack 逐文件哈希')
  }
}

/**
 * 验证一个本地 release 的全部声明 pack、资源路径、尺寸与汇总字段。调用方
 * 可要求逐文件 SHA-256 校验；Store 和激活流程始终启用该选项。
 */
export async function validateLocalRelease(releasesDir, releaseId,
  { verifyHashes = false, details = false } = {}) {
  if (!RELEASE_ID_PATTERN.test(String(releaseId || ''))) {
    throw new InstallerFault('INVALID_RELEASE', 'releaseId 非法')
  }
  const releasesRoot = await realpath(resolve(releasesDir))
  const releaseDir = await requireContainedDirectory(join(releasesRoot, releaseId), releasesRoot,
    `release ${releaseId}`)
  const manifest = await readContainedJson(join(releaseDir, 'release-manifest.json'), releaseDir,
    'release-manifest', 'INVALID_RELEASE')
  const descriptors = validateReleaseHeader(releaseId, manifest, 'INVALID_RELEASE')
  const totals = { assets: 0, compressed: 0, uncompressed: 0, documents: 0, lines: 0 }
  const packManifests = new Map()
  for (const [packId, descriptor] of descriptors) {
    const packDir = await requireContainedDirectory(join(releaseDir, packId), releaseDir,
      `pack ${packId}`)
    const packPath = join(packDir, 'pack-manifest.json')
    const pack = await readContainedJson(packPath, releaseDir, `${packId}/pack-manifest.json`,
      'INVALID_RELEASE')
    const assets = validatePackManifest(packId, pack, descriptor, totals, 'INVALID_RELEASE')
    packManifests.set(packId, pack)
    for (const asset of assets) {
      const relative = String(asset?.path || '')
      const categoryDir = join(packDir, relative.split('/')[0])
      const category = await lstat(categoryDir)
      if (!category.isDirectory() || category.isSymbolicLink()) {
        invalid('INVALID_RELEASE', `分片目录不是受管目录: ${packId}/${relative}`)
      }
      const assetPath = join(packDir, relative)
      const link = await lstat(assetPath)
      if (!link.isFile() || link.isSymbolicLink() || link.size !== asset.compressed_size) {
        invalid('INVALID_RELEASE', `分片缺失或大小不符: ${packId}/${relative}`)
      }
      const actualPath = await realpath(assetPath)
      if (!isContainedPath(releaseDir, actualPath)) {
        invalid('INVALID_RELEASE', `分片越出 release 目录: ${packId}/${relative}`)
      }
      if (verifyHashes && await sha256File(assetPath) !== asset.sha256) {
        invalid('INVALID_RELEASE', `分片 SHA-256 不符: ${packId}/${relative}`)
      }
    }
  }
  validateReleaseTotals(manifest, totals, 'INVALID_RELEASE')
  validateTrustedReleaseRoot(manifest, packManifests, 'INVALID_RELEASE')
  return details ? { manifest, packManifests, releaseDir } : manifest
}

async function fetchJson(url, { fetchImpl, signal }) {
  // 显式超时 + 响应体大小上限：慢速/恶意的清单源不能无限占用下载流程，
  // 也不能借超大清单把进程内存或磁盘当缓冲区。
  const timeoutSignal = AbortSignal.timeout(MANIFEST_TIMEOUT_MS)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  let response
  try {
    response = await fetchImpl(url, { redirect: 'error', signal: requestSignal })
  } catch (error) {
    if (signal?.aborted) throw new InstallerFault('CANCELLED', '资料下载已取消')
    if (isTimeoutError(error)) {
      throw new InstallerFault('DOWNLOAD_FAILED', `连接 ${new URL(url).host} 超时（${MANIFEST_TIMEOUT_MS / 1000}s）`)
    }
    throw new InstallerFault('DOWNLOAD_FAILED', `无法连接 ${new URL(url).host}（${error?.message ?? error}）`)
  }
  if (!response.ok) {
    const code = response.status === 404 ? 'RELEASE_NOT_FOUND'
      : response.status === 403 ? 'ACCESS_DENIED' : 'DOWNLOAD_FAILED'
    throw new InstallerFault(code, `请求失败 HTTP ${response.status}: ${url}`)
  }
  const declared = Number(response.headers?.get?.('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > MAX_MANIFEST_BYTES) {
    throw new InstallerFault('INVALID_MANIFEST', `清单超过大小上限（${MAX_MANIFEST_BYTES} 字节）: ${url}`)
  }
  let text
  try {
    const bytes = await readBounded(response, MAX_MANIFEST_BYTES, url)
    text = bytes.toString('utf8')
  } catch (error) {
    if (signal?.aborted) throw new InstallerFault('CANCELLED', '资料下载已取消')
    throw error
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new InstallerFault('INVALID_MANIFEST', `返回的不是有效 JSON: ${url}`)
  }
}

/** 读取响应体到大小上限为止；超出即中止接收并报错。返回 Buffer（可直接按 utf8 解码）。 */
async function readBounded(response, maxBytes, url) {
  const reader = response.body?.getReader?.()
  if (!reader) {
    // 无流式 body 的实现（测试桩 / 旧运行时）：优先 text()，其次 arrayBuffer()。
    const bytes = typeof response.text === 'function'
      ? Buffer.from(await response.text(), 'utf8')
      : Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > maxBytes) {
      throw new InstallerFault('INVALID_MANIFEST', `响应超过大小上限（${maxBytes} 字节）: ${url}`)
    }
    return bytes
  }
  const chunks = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new InstallerFault('INVALID_MANIFEST', `响应超过大小上限（${maxBytes} 字节）: ${url}`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, received)
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function safeDownloadRedirect(next, initial) {
  const modelscopeOriginHost = (hostname) => /^(?:www\.)?modelscope\.cn$/u
    .test(hostname.toLowerCase())
  const modelscopeLfsHost = (hostname) => /^cdn-lfs-[a-z0-9-]+\.modelscope\.cn$/u
    .test(hostname.toLowerCase())
  if (next.username || next.password || next.hash) return false
  if (next.protocol !== initial.protocol) return false
  if (next.origin === initial.origin) return !next.search || modelscopeLfsHost(next.hostname)
  // ModelScope 的 resolve 端点会把 LFS 对象跳转到官方 cdn-lfs-* 子域；
  // LFS 的临时鉴权参数位于 query，因此仅对这个受限主机命名空间放行 query。
  return next.protocol === 'https:'
    && modelscopeOriginHost(initial.hostname)
    && modelscopeLfsHost(next.hostname)
}

async function fetchDownload(fetchImpl, url, init) {
  const initial = new URL(url)
  let current = initial
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetchImpl(current.toString(), { ...init, redirect: 'manual' })
    if (!REDIRECT_STATUSES.has(response.status)) return response
    const location = response.headers?.get?.('location')
    if (!location || redirects === 5) {
      await response.body?.cancel?.().catch(() => {})
      throw new InstallerFault('DOWNLOAD_FAILED', `下载跳转链非法或过长: ${initial.host}`)
    }
    const next = new URL(location, current)
    if (!safeDownloadRedirect(next, initial)) {
      await response.body?.cancel?.().catch(() => {})
      throw new InstallerFault('DOWNLOAD_FAILED', `下载源试图跳转到不安全地址: ${next.host}`)
    }
    await response.body?.cancel?.().catch(() => {})
    current = next
  }
  throw new InstallerFault('DOWNLOAD_FAILED', `下载跳转链过长: ${initial.host}`)
}

/**
 * 下载一个文件到临时路径，按清单校验（sha256 为空表示该源未提供哈希，仅落盘），
 * 校验通过后原子改名。网络错误（含超时）重试一次。
 * 正文流式落盘：先按 Content-Length 预检大小，超限立即中止接收；哈希在
 * 数据流经时增量计算，任何时刻都不在内存里缓存整个文件。
 * 清单未提供 size 的文件（站点 pack/release 清单本体）以 MAX_UNVERIFIED_BYTES
 * 为字节上限——无哈希锚点的下载不能无限写盘。
 */
async function downloadVerified(url, targetPath, expected, env) {
  const attempt = async (retry) => {
    const tempPath = `${targetPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    const timeoutMs = downloadTimeoutMs(expected.size ?? null)
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const requestSignal = env.signal
      ? AbortSignal.any([env.signal, timeoutSignal]) : timeoutSignal
    const sizeLimit = expected.size ?? MAX_UNVERIFIED_BYTES
    let handle = null
    try {
      const response = await fetchDownload(env.fetchImpl, url, { signal: requestSignal })
      if (!response.ok) {
        throw new InstallerFault('DOWNLOAD_FAILED', `下载失败 HTTP ${response.status}: ${url}`)
      }
      const declared = Number(response.headers?.get?.('content-length') ?? NaN)
      if (expected.size != null && Number.isFinite(declared) && declared !== expected.size) {
        throw new InstallerFault('CHECKSUM_MISMATCH',
          `${url} 大小不符（期望 ${expected.size}，Content-Length ${declared}）`)
      }
      if (expected.size == null && Number.isFinite(declared) && declared > sizeLimit) {
        throw new InstallerFault('DOWNLOAD_FAILED',
          `${url} 超过未校验文件大小上限（${sizeLimit} 字节）`)
      }
      await mkdir(dirname(targetPath), { recursive: true })
      handle = await open(tempPath, 'wx', 0o600)
      const hash = expected.sha256 ? createHash('sha256') : null
      let received = 0
      const overLimit = () => expected.size != null
        ? new InstallerFault('CHECKSUM_MISMATCH',
          `${url} 大小不符（期望 ${expected.size}，已接收 ${received}）`)
        : new InstallerFault('DOWNLOAD_FAILED',
          `${url} 超过未校验文件大小上限（${sizeLimit} 字节，已接收 ${received}）`)
      const reader = response.body?.getReader?.()
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          received += value.byteLength
          if (received > sizeLimit) {
            await reader.cancel().catch(() => {})
            throw overLimit()
          }
          await handle.write(value)
          hash?.update(value)
        }
      } else {
        // 无流式 body 的实现（测试桩 / 旧运行时）：退回整段缓冲。
        const bytes = new Uint8Array(await response.arrayBuffer())
        received = bytes.byteLength
        if (expected.size != null && received !== expected.size) {
          throw new InstallerFault('CHECKSUM_MISMATCH',
            `${url} 大小不符（期望 ${expected.size}，得到 ${received}）`)
        }
        if (expected.size == null && received > sizeLimit) throw overLimit()
        await handle.write(bytes)
        hash?.update(bytes)
      }
      if (expected.size != null && received !== expected.size) {
        throw new InstallerFault('CHECKSUM_MISMATCH',
          `${url} 大小不符（期望 ${expected.size}，得到 ${received}）`)
      }
      if (hash && hash.digest('hex') !== expected.sha256) {
        throw new InstallerFault('CHECKSUM_MISMATCH', `${url} sha256 不符`)
      }
      await handle.close()
      handle = null
      await rename(tempPath, targetPath)
      return received
    } catch (error) {
      if (handle) await handle.close().catch(() => {})
      await rm(tempPath, { force: true })
      if (env.signal?.aborted) throw error
      if (error instanceof InstallerFault) throw error
      // 网络错误（含显式超时）重试一次；最终失败时把超时转成可读错误。
      if (!retry) {
        throw isTimeoutError(error)
          ? new InstallerFault('DOWNLOAD_FAILED',
            `下载超时（${Math.round(timeoutMs / 1000)}s）: ${url}`)
          : error
      }
      return attempt(retry - 1)
    }
  }
  return attempt(1)
}

const requirePackId = (packId, code = 'INVALID_MANIFEST') => {
  if (!PACK_IDS.includes(packId)) throw new InstallerFault(code, `pack_id 非法: ${packId}`)
  return packId
}

function validateCurrentSummary(data) {
  const releaseId = String(data?.release_id ?? '')
  const dataVersion = String(data?.data_version ?? '')
  if (!RELEASE_ID_PATTERN.test(releaseId) || !SHA256_PATTERN.test(dataVersion)
      || !Array.isArray(data?.packs) || data.packs.length === 0
      || data.packs.length > PACK_IDS.length) {
    throw new InstallerFault('INVALID_MANIFEST', 'PRTS.chat current 元数据不完整')
  }
  const minimumAgentVersion = data.minimum_agent_version
  if (!parseSemver(minimumAgentVersion)) {
    throw new InstallerFault('INVALID_MANIFEST',
      'PRTS.chat current.minimum_agent_version 缺失或不是有效 SemVer')
  }
  if (compareSemver(AGENT_VERSION, minimumAgentVersion) < 0) {
    throw new InstallerFault('INCOMPATIBLE_RELEASE',
      `最新资料至少需要 prts-terrarchive ${minimumAgentVersion}，当前为 ${AGENT_VERSION}`)
  }
  requireInteger(data.document_count, 'current.document_count', {
    minimum: 1, maximum: 10_000_000,
  })
  requireInteger(data.line_count, 'current.line_count', { maximum: 100_000_000 })
  requireInteger(data.compressed_size, 'current.compressed_size', {
    maximum: CORPUS_RESOURCE_LIMITS.maxReleaseCompressedBytes,
  })
  requireInteger(data.uncompressed_size, 'current.uncompressed_size', {
    maximum: CORPUS_RESOURCE_LIMITS.maxReleaseUncompressedBytes,
  })
  const packIds = new Set()
  const packs = []
  const totals = { document_count: 0, line_count: 0, compressed_size: 0,
    uncompressed_size: 0 }
  for (const rawDescriptor of data.packs) {
    const descriptor = normalizePackDescriptor(rawDescriptor, 'current')
    const packId = descriptor.pack_id
    if (packIds.has(packId)) {
      throw new InstallerFault('INVALID_MANIFEST', `PRTS.chat current pack 描述非法: ${packId}`)
    }
    for (const field of Object.keys(totals)) totals[field] += descriptor[field]
    packIds.add(packId)
    packs.push(descriptor)
  }
  for (const field of Object.keys(totals)) {
    if (totals[field] !== data[field]) {
      throw new InstallerFault('INVALID_MANIFEST', `PRTS.chat current.${field} 与 pack 汇总不一致`)
    }
  }
  return { releaseId, dataVersion, minimumAgentVersion, packs }
}

function validateMirrorDescriptors(mirrors, releaseId, releasePacks) {
  if (mirrors == null) return []
  if (!Array.isArray(mirrors) || mirrors.length > 16) {
    throw new InstallerFault('INVALID_MANIFEST', 'PRTS.chat 镜像列表非法')
  }
  const accepted = []
  const assignedPacks = new Set()
  for (const mirror of mirrors) {
    let base
    try { base = new URL(String(mirror?.base_url ?? '')) } catch {
      throw new InstallerFault('INVALID_MANIFEST', 'PRTS.chat 镜像地址非法')
    }
    const packIds = Array.isArray(mirror?.pack_ids)
      ? mirror.pack_ids.map((value) => requirePackId(String(value ?? ''))) : []
    if (mirror?.provider !== 'modelscope' || !packIds.length
        || new Set(packIds).size !== packIds.length || base.protocol !== 'https:'
        || !['modelscope.cn', 'www.modelscope.cn'].includes(base.hostname)
        || base.username || base.password || base.search || base.hash
        || !base.pathname.endsWith(`/releases/${releaseId}/`)) {
      throw new InstallerFault('INVALID_MANIFEST', 'PRTS.chat 镜像描述非法')
    }
    if (packIds.some((packId) => !releasePacks.has(packId) || assignedPacks.has(packId))) {
      throw new InstallerFault('INVALID_MANIFEST', 'PRTS.chat 镜像 pack 范围非法或重复')
    }
    packIds.forEach((packId) => assignedPacks.add(packId))
    accepted.push({ baseUrl: base.toString(), packIds })
  }
  return accepted
}

function immutableTrustedCurrent(values) {
  const packs = Object.freeze(values.packs.map((pack) => Object.freeze({
    pack_id: pack.pack_id,
    manifest_path: pack.manifest_path,
    authority: pack.authority,
    data_version: pack.data_version,
    document_count: pack.document_count,
    line_count: pack.line_count,
    compressed_size: pack.compressed_size,
    uncompressed_size: pack.uncompressed_size,
    shard_count: pack.shard_count,
  })))
  const mirrors = Object.freeze(values.mirrors.map((mirror) => Object.freeze({
    baseUrl: mirror.baseUrl,
    packIds: Object.freeze([...mirror.packIds]),
  })))
  return Object.freeze({
    releaseId: values.releaseId,
    dataVersion: values.dataVersion,
    minimumAgentVersion: values.minimumAgentVersion,
    documentCount: values.documentCount,
    lineCount: values.lineCount,
    compressedSize: values.compressedSize,
    uncompressedSize: values.uncompressedSize,
    packs,
    mirrors,
  })
}

function rememberTrustedCurrent(values) {
  const canonical = immutableTrustedCurrent(values)
  const exposed = immutableTrustedCurrent(canonical)
  trustedCurrentSnapshots.set(exposed, canonical)
  return exposed
}

/**
 * 从 PRTS.chat 的可变 current 指针读取唯一可信的最新 release 与内容摘要。
 * ModelScope 的目录列表和 dataset-manifest 不参与版本选择，避免镜像仓自行
 * 宣称“最新”或同时替换数据与哈希。
 */
export async function resolveTrustedCurrentRelease(env = {}) {
  const fetchImpl = env.fetchImpl ?? fetch
  const signal = env.signal
  if (env.siteBaseUrl != null
      && normalizeSiteBaseUrl(env.siteBaseUrl) !== DEFAULT_SITE_BASE_URL) {
    throw new InstallerFault('INVALID_REQUEST',
      `可信元数据源固定为 ${DEFAULT_SITE_BASE_URL}；siteBaseUrl 仅可配置字节回退源`)
  }
  const payload = await fetchJson(
    `${DEFAULT_SITE_BASE_URL}/api/agent/data/releases/current`, { fetchImpl, signal })
  const data = payload?.data
  const { releaseId, dataVersion, minimumAgentVersion, packs } = validateCurrentSummary(data)
  return rememberTrustedCurrent({
    releaseId,
    dataVersion,
    minimumAgentVersion,
    documentCount: data.document_count,
    lineCount: data.line_count,
    compressedSize: data.compressed_size,
    uncompressedSize: data.uncompressed_size,
    packs,
    mirrors: validateMirrorDescriptors(data.mirrors, releaseId,
      new Set(packs.map((pack) => pack.pack_id))),
  })
}

async function loadTrustedReleaseMetadata(releaseId, env, snapshot) {
  const current = trustedCurrentSnapshots.get(snapshot)
  if (!current || current.releaseId !== releaseId) {
    throw new InstallerFault('INVALID_REQUEST',
      '远程 release 必须由同一次 PRTS.chat current 快照选定')
  }
  const url = (path) => `${DEFAULT_SITE_BASE_URL}/api/agent/data/releases/${releaseId}/${path}`
  const releaseManifest = await fetchJson(url('release-manifest.json'), env)
  const descriptors = validateReleaseHeader(releaseId, releaseManifest)
  {
    const fields = [
      ['data_version', current.dataVersion],
      ['minimum_agent_version', current.minimumAgentVersion],
      ['document_count', current.documentCount],
      ['line_count', current.lineCount],
      ['compressed_size', current.compressedSize],
      ['uncompressed_size', current.uncompressedSize],
    ]
    if (fields.some(([field, expected]) => releaseManifest[field] !== expected)) {
      throw new InstallerFault('INVALID_MANIFEST', 'PRTS.chat current 与 release-manifest 摘要不一致')
    }
    const currentPacks = new Map(current.packs.map((pack) => [pack.pack_id, pack]))
    if (currentPacks.size !== descriptors.size) {
      throw new InstallerFault('INVALID_MANIFEST', 'PRTS.chat current 与 release-manifest packs 不一致')
    }
    for (const [packId, descriptor] of descriptors) {
      const summary = currentPacks.get(packId)
      if (!summary || Object.entries(descriptor).some(([key, value]) => summary[key] !== value)) {
        throw new InstallerFault('INVALID_MANIFEST', `PRTS.chat current 与 release pack 不一致: ${packId}`)
      }
    }
  }
  const totals = { assets: 0, compressed: 0, uncompressed: 0, documents: 0, lines: 0 }
  const packManifests = new Map()
  const entries = []
  for (const [packId, descriptor] of descriptors) {
    const pack = await fetchJson(url(descriptor.manifest_path), env)
    const assets = validatePackManifest(packId, pack, descriptor, totals)
    packManifests.set(packId, pack)
    for (const asset of assets) {
      entries.push({
        relativePath: `${packId}/${asset.path}`,
        sha256: asset.sha256,
        size: asset.compressed_size,
        uncompressedSize: asset.uncompressed_size,
      })
    }
  }
  validateReleaseTotals(releaseManifest, totals)
  validateTrustedReleaseRoot(releaseManifest, packManifests)
  if (new Set(entries.map((entry) => entry.relativePath)).size !== entries.length) {
    throw new InstallerFault('INVALID_MANIFEST', 'release 包含重复资源路径')
  }
  return {
    releaseId,
    dataVersion: releaseManifest.data_version,
    releaseManifest,
    packManifests,
    entries,
    mirrors: current.mirrors,
  }
}

/** ---- 源 1：由 PRTS.chat 摘要约束的 ModelScope 固定 release ---- */

/**
 * @deprecated 使用 resolveTrustedCurrentRelease；保留导出供旧客户端模块平滑升级。
 */
export async function resolveModelScopeCurrentRelease(env = {}) {
  const trusted = await resolveTrustedCurrentRelease(env)
  return { releaseId: trusted.releaseId, dataVersion: trusted.dataVersion }
}

const groupForPack = (packId) => packId === 'official_game' ? 'official'
  : packId.startsWith('endfield_') ? 'endfield' : 'community'

/** Resolve one hash-verified asset URL while honoring an immutable split-repo composition. */
export function modelScopeAssetUrl(releaseId, dataVersion, relativePath, mirrorBaseUrl = null) {
  const packId = requirePackId(String(relativePath ?? '').split('/')[0])
  const group = groupForPack(packId)
  const composition = MODELSCOPE_RELEASE_COMPOSITIONS[releaseId]
  if (composition && composition.dataVersion !== dataVersion) {
    throw new InstallerFault('INVALID_MANIFEST',
      `ModelScope 分仓组合与 release data_version 不匹配: ${releaseId}`)
  }
  const sourceReleaseId = composition?.releases?.[group] ?? releaseId
  const baseUrl = mirrorBaseUrl
    ?? `https://modelscope.cn/datasets/${MODELSCOPE_REPOS[group]}/resolve/master/releases/${sourceReleaseId}/`
  return new URL(relativePath, baseUrl).toString()
}

async function listFromModelScope(trusted) {
  const mirrorByPack = new Map()
  for (const mirror of trusted.mirrors) {
    for (const packId of mirror.packIds) mirrorByPack.set(packId, mirror.baseUrl)
  }
  const entries = trusted.entries.map((entry) => {
    const packId = entry.relativePath.split('/')[0]
    return { ...entry, url: modelScopeAssetUrl(trusted.releaseId, trusted.dataVersion,
      entry.relativePath, mirrorByPack.get(packId)) }
  })
  return { dataVersion: trusted.dataVersion, entries }
}

/** ---- 源 2：PRTS.chat 站点（与浏览器前端同源） ---- */

async function listFromSite(trusted, siteBaseUrl) {
  const base = normalizeSiteBaseUrl(siteBaseUrl)
  const prefix = `${base}/api/agent/data/releases/${trusted.releaseId}/`
  return {
    dataVersion: trusted.dataVersion,
    entries: trusted.entries.map((entry) => ({ ...entry, url: `${prefix}${entry.relativePath}` })),
  }
}

/** ---- 主流程 ---- */

/**
 * 确保本地资料就绪：指定的本地版本已完整校验则直接返回；任何需要
 * 联网的下载都先解析 PRTS.chat current，并且只允许该快照选定的 release。
 * release/pack 清单同样固定从 PRTS.chat 取得；随后按 order 从镜像或可配置
 * 站点取字节，所有字节均由该快照导出的内容根约束。
 * @param {{ releasesDir: string, releaseId?: string, order?: ('modelscope'|'site')[],
 *           siteBaseUrl?: string, fetchImpl?: typeof fetch, signal?: AbortSignal,
 *           logger?: { info?: Function, warn?: Function }, requireRelease?: boolean,
 *           onProgress?: (state: { phase: 'listing'|'downloading'|'done', source: string,
 *             releaseId: string, filesDone: number, filesTotal: number|null, bytesDone: number }) => void }} options
 * @returns {Promise<{ status: 'present' | 'downloaded', releaseId?: string, source?: string, files?: number, bytes?: number }>}
 */
export async function ensureCorpusRelease(options) {
  const { releasesDir, signal, logger } = options
  const onProgress = options.onProgress
  const requestedReleaseId = options.releaseId == null ? null : String(options.releaseId)
  if (requestedReleaseId != null && !RELEASE_ID_PATTERN.test(requestedReleaseId)) {
    throw new InstallerFault('INVALID_REQUEST', 'releaseId 非法')
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const env = { fetchImpl, signal }
  const siteBaseUrl = normalizeSiteBaseUrl(options.siteBaseUrl ?? DEFAULT_SITE_BASE_URL)
  const order = options.order ?? ['modelscope', 'site']
  if (!Array.isArray(order) || order.length === 0 || new Set(order).size !== order.length
    || order.some((source) => source !== 'modelscope' && source !== 'site')) {
    throw new InstallerFault('INVALID_REQUEST', 'download order 非法')
  }
  const suppliedSnapshot = options.trustedCurrent ?? null
  const suppliedCurrent = suppliedSnapshot == null
    ? null : trustedCurrentSnapshots.get(suppliedSnapshot)
  if (suppliedSnapshot != null && (!suppliedCurrent
      || requestedReleaseId == null || suppliedCurrent.releaseId !== requestedReleaseId)) {
    throw new InstallerFault('INVALID_REQUEST', '可信 current 快照非法或与 releaseId 不匹配')
  }

  const releaseLock = await acquireReleaseMutationLock(releasesDir)
  try {
  // 本地显式 pin 已就绪时仍保持零网络，但验证和返回必须在
  // 跨进程变更锁内，避免与另一 Host 的删除/激活操作交错后误报 present。
  if (requestedReleaseId && await currentReleaseReady(
    releasesDir, requestedReleaseId, suppliedCurrent?.dataVersion,
  )) {
    return { status: 'present' }
  }
  const trustedSnapshot = suppliedSnapshot
    ?? await resolveTrustedCurrentRelease({ fetchImpl, signal })
  const trustedCurrent = trustedCurrentSnapshots.get(trustedSnapshot)
  if (!trustedCurrent) {
    throw new InstallerFault('INVALID_REQUEST', '可信 current 快照未由安装器签发')
  }
  if (requestedReleaseId && requestedReleaseId !== trustedCurrent.releaseId) {
    throw new InstallerFault('RELEASE_NOT_CURRENT',
      `PRTS.chat 最新版本为 ${trustedCurrent.releaseId}，拒绝远程下载未被 current 选定的版本`)
  }
  const releaseId = trustedCurrent.releaseId

    if (await currentReleaseReady(releasesDir, releaseId, trustedCurrent.dataVersion)) {
      return { status: 'present' }
    }

    const trusted = await loadTrustedReleaseMetadata(releaseId, env, trustedSnapshot)
    const { releaseDir } = await ensureManagedReleaseDirectory(releasesDir, releaseId)
    let lastError = null
    for (const source of order) {
      if (signal?.aborted) throw new InstallerFault('CANCELLED', '资料下载已取消')
      try {
      const listing = source === 'site'
        ? await listFromSite(trusted, siteBaseUrl)
        : await listFromModelScope(trusted)

      // 2) 跳过已校验文件，其余小并发下载
      const pending = []
      for (const entry of listing.entries) {
        const targetPath = await prepareAssetTarget(releaseDir, entry.relativePath)
        try {
          const existing = await lstat(targetPath)
          if (existing.isSymbolicLink() || !existing.isFile()) {
            throw new InstallerFault('INVALID_RELEASE',
              `现有资源不是受管普通文件: ${entry.relativePath}`)
          }
          // 哈希与大小都一致 → 已就绪跳过；否则重新下载覆盖。
          if (existing.size === entry.size && await sha256File(targetPath) === entry.sha256) continue
        } catch (error) {
          if (error instanceof InstallerFault) throw error
          // 不存在或普通 I/O 失败 → 交给原子下载覆盖。
        }
        pending.push({ ...entry, targetPath })
      }
      if (pending.length) {
        logger?.info?.(`prts-corpus: 从 ${source === 'site' ? siteBaseUrl : 'ModelScope'} 下载 ${releaseId}`
          + `（${pending.length}/${listing.entries.length} 个文件待取，data_version=${listing.dataVersion.slice(0, 12)}…）`)
      }
      const queue = [...pending]
      let files = 0
      let bytes = 0
      // 任一 worker 失败后置位：其余 worker 完成手头文件即停止取新任务，
      // 不再产生与回退源并发写盘的孤儿下载。
      let failure = null
      onProgress?.({ phase: 'downloading', source, releaseId,
        filesDone: 0, filesTotal: pending.length, bytesDone: 0 })
      const worker = async () => {
        for (;;) {
          if (failure || signal?.aborted) return
          const entry = queue.shift()
          if (!entry) return
          try {
            const downloadedBytes = await downloadVerified(entry.url, entry.targetPath,
              { sha256: entry.sha256, size: entry.size }, env)
            // 不要写成 `bytes += await ...`：复合赋值会在 await 前读取旧值，
            // 多 worker 完成顺序交错时会覆盖其他 worker 已累计的字节数。
            bytes += downloadedBytes
          } catch (error) {
            failure = error
            return
          }
          files += 1
          onProgress?.({ phase: 'downloading', source, releaseId,
            filesDone: files, filesTotal: pending.length, bytesDone: bytes })
        }
      }
      await Promise.all(Array.from({ length: Math.min(6, pending.length) }, worker))
      if (failure) throw failure
      if (signal?.aborted) throw new InstallerFault('CANCELLED', '资料下载已取消')
      onProgress?.({ phase: 'done', source, releaseId, filesDone: files,
        filesTotal: pending.length, bytesDone: bytes })

      // 3) 只落盘 PRTS.chat 预先验证过的清单；镜像返回的清单从不进入信任链。
      for (const [packId, manifest] of trusted.packManifests) {
        await writeJsonAtomically(join(releaseDir, packId, 'pack-manifest.json'), manifest)
      }
      await writeJsonAtomically(join(releaseDir, 'release-manifest.json'), trusted.releaseManifest)
      await validateLocalRelease(releasesDir, releaseId, { verifyHashes: true })
      const pointerTemp = join(releasesDir, `current.json.${randomBytes(6).toString('hex')}.tmp`)
      await writeFile(pointerTemp, JSON.stringify({
        release_id: releaseId, data_version: trusted.dataVersion,
        channel: source, public_download: true, schema_version: 1,
        downloaded_at: new Date().toISOString(),
      }))
      await rename(pointerTemp, join(releasesDir, 'current.json'))
      logger?.info?.(`prts-corpus: 资料包就绪 ${releaseId}（源=${source}，新下载 ${files} 个文件，${Math.round(bytes / 1048576)} MiB）`)
      return { status: 'downloaded', releaseId, source, files, bytes }
      } catch (error) {
        lastError = error
        logger?.warn?.(`prts-corpus: ${source} 源失败（${error?.code ?? 'ERROR'}: ${error?.message ?? error}）`)
      }
    }
    throw lastError ?? new InstallerFault('DOWNLOAD_FAILED', '没有可用的下载源')
  } finally {
    await releaseLock()
  }
}
