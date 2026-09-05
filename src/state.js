/**
 * 插件共享状态与运行时配置。
 *
 * 配置分三层（与 DSH settings 的解析顺序同构，但不依赖 schemastery，
 * 保持零 npm 依赖）：
 *   默认值 ← cordis.patch.yml 行内 config（base 层）← 用户文件（$DSH_HOME/prts-corpus.json）
 * 界面（settings tab）改配置 = 写用户层文件并立即生效：
 *   显式下载的字节回退源走 getter 每次调用现读；可信元数据固定来自
 *   https://prts.chat；cloud 工具由
 *   index.js 的 rebuildCloud() 在配置变化时 dispose + 重注册。
 */
import { watch } from 'node:fs'
import { readFile, rename, writeFile, mkdir, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname } from 'node:path'
import { DEFAULT_SITE_BASE_URL } from './installer.js'

/** 运行时可改配置的默认值。 */
export const CONFIG_DEFAULTS = Object.freeze({
  uiSkin: 'harness',
  cloudEnabled: false,
  cloudBaseUrl: DEFAULT_SITE_BASE_URL,
  cloudToken: '',
  cloudGame: 'all',
  enabledGames: Object.freeze(['arknights', 'endfield']),
  cloudUserId: '',
  downloadSiteBaseUrl: DEFAULT_SITE_BASE_URL,
  downloadOrder: Object.freeze(['modelscope', 'site']),
  cloudTimeoutMs: 90_000,
  cloudMaxResponseBytes: 32 * 1024 * 1024,
  cacheShards: 24,
})

/**
 * 云端/字节回退站点地址校验：必须是 https，或仅指向环回主机的 http（本地开发用）。
 * 明文 http 只允许 localhost / 127.0.0.1 / [::1]，避免把 token 或资料
 * 下载暴露给局域网中间人。
 */
const isServiceBaseUrl = (value) => {
  if (typeof value !== 'string') return false
  const raw = value.trim()
  if (!raw || raw.length >= 512) return false
  try {
    const url = new URL(raw)
    if (url.username || url.password || url.search || url.hash) return false
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:'
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  } catch {
    return false
  }
}

const serviceOrigin = (value) => new URL(value).origin

/** 界面可写的键（白名单 + 类型校验器）。 */
const WRITABLE = {
  uiSkin: (v) => v === 'harness' || v === 'prts-agent' || v === 'endfield-aic',
  cloudEnabled: (v) => typeof v === 'boolean',
  cloudBaseUrl: isServiceBaseUrl,
  cloudToken: (v) => typeof v === 'string' && v.length < 4096,
  cloudGame: (v) => v === 'all' || v === 'arknights' || v === 'endfield',
  enabledGames: (v) => Array.isArray(v) && v.length > 0 && v.length <= 2
    && new Set(v).size === v.length
    && v.every((entry) => entry === 'arknights' || entry === 'endfield'),
  cloudUserId: (v) => typeof v === 'string' && v.length < 128,
  downloadSiteBaseUrl: isServiceBaseUrl,
  downloadOrder: (v) => Array.isArray(v) && v.length > 0 && v.length <= 2
    && new Set(v).size === v.length && v.every((entry) => entry === 'modelscope' || entry === 'site'),
  cloudTimeoutMs: (v) => Number.isInteger(v) && v >= 1000 && v <= 10 * 60_000,
  cloudMaxResponseBytes: (v) => Number.isInteger(v) && v >= 1024 && v <= 64 * 1024 * 1024,
  cacheShards: (v) => Number.isInteger(v) && v >= 1 && v <= 128,
}

/** 从 cordis.patch.yml 行内 config 提取 base 层。 */
function baseLayer(patchConfig = {}) {
  const base = {}
  if (patchConfig.uiSkin) base.uiSkin = String(patchConfig.uiSkin)
  const cloud = patchConfig.cloud
  if (cloud?.baseUrl) {
    base.cloudEnabled = true
    base.cloudBaseUrl = String(cloud.baseUrl)
    if (cloud.token) base.cloudToken = String(cloud.token)
    if (cloud.game) base.cloudGame = cloud.game
    if (cloud.userId) base.cloudUserId = String(cloud.userId)
  }
  if (Array.isArray(patchConfig.enabledGames)) base.enabledGames = [...patchConfig.enabledGames]
  const download = patchConfig.download
  if (download?.siteBaseUrl) base.downloadSiteBaseUrl = String(download.siteBaseUrl)
  if (Array.isArray(download?.order)) base.downloadOrder = [...download.order]
  if (Number.isInteger(cloud?.timeoutMs)) base.cloudTimeoutMs = cloud.timeoutMs
  if (Number.isInteger(cloud?.maxResponseBytes)) base.cloudMaxResponseBytes = cloud.maxResponseBytes
  if (Number.isInteger(patchConfig.cacheShards)) base.cacheShards = patchConfig.cacheShards
  return validateUserLayer(base)
}

const cancelledConfigWrite = () => Object.assign(new Error('PRTS 配置写入已取消'), {
  name: 'AbortError', code: 'CANCELLED',
})

const assertConfigWriteActive = (signal) => {
  if (signal?.aborted) throw cancelledConfigWrite()
}

const atomicWriteJson = async (path, value, { signal } = {}) => {
  assertConfigWriteActive(signal)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  assertConfigWriteActive(signal)
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, signal })
    // rename 是不可取消的原子提交点；进入它之前最后检查一次。进入后即使
    // transport 同时断开，也必须让内存态跟已经替换的磁盘文件保持一致。
    assertConfigWriteActive(signal)
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
      throw cancelledConfigWrite()
    }
    throw error
  }
}

function validateUserLayer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('PRTS 配置文件必须是对象'), { code: 'INVALID_CONFIG' })
  }
  const result = {}
  const deprecated = new Set([
    'approvalMode', 'softIntentCharacters', 'hardIntentCharacters', 'hardIntentRecords', 'autoDownload',
    // 远程下载已改为必须由 PRTS.chat current 选版；旧 pin 键只做无害迁移。
    'downloadReleaseId',
  ])
  for (const [key, entry] of Object.entries(value)) {
    // 旧版用户配置可以无痛升级：预算/审批已经完全交给 DSH，这些键不再生效。
    if (deprecated.has(key)) continue
    const check = WRITABLE[key]
    if (!check) throw Object.assign(new Error(`不可识别或只读的配置项：${key}`), { code: 'INVALID_CONFIG' })
    if (!check(entry)) throw Object.assign(new Error(`配置项 ${key} 的值不合法`), { code: 'INVALID_CONFIG' })
    if (key === 'cloudBaseUrl' || key === 'downloadSiteBaseUrl') result[key] = entry.trim()
    else if (key === 'downloadOrder') result[key] = [...entry]
    else result[key] = entry
  }
  return result
}

/**
 * 创建共享状态单例（每插件实例一个，ui.js 与 index.js 共用）。
 * @param {{ patchConfig?: object, configPath: string, releasesDir: string }} options
 */
export function createSharedState({ patchConfig, configPath, releasesDir }) {
  const base = baseLayer(patchConfig)
  let user = {}
  let writeChain = Promise.resolve()
  const listeners = new Set()
  const runtimeListeners = new Set()

  const commitUser = (next) => {
    const previous = JSON.stringify(user)
    user = next
    if (JSON.stringify(next) === previous) return
    for (const listener of listeners) listener(state.effective())
  }

  const state = {
    configPath,
    releasesDir,
    /** @type {import('./store.js').CorpusStore | null} */
    store: null,
    /** 下载任务状态（供设置页轮询） */
    download: {
      active: false, phase: 'idle', source: null, releaseId: null,
      filesDone: 0, filesTotal: null, bytesDone: 0, error: null, finishedAt: null,
    },
    /** 载入用户层配置文件；缺失视为空，存在但无效则失败。 */
    async loadConfig() {
      try {
        const parsed = JSON.parse(await readFile(configPath, 'utf8'))
        commitUser(validateUserLayer(parsed))
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        commitUser({})
      }
      return state.effective()
    },
    /** 三层合并后的生效配置 */
    effective() {
      const effective = { ...CONFIG_DEFAULTS, ...base, ...user }
      // 旧配置只有 cloudGame。首次打开新版设置页之前仍沿用旧选择，避免
      // 升级后悄悄把单游戏范围放宽为双游戏。
      const explicitlyEnabled = user.enabledGames ?? base.enabledGames
      const enabledGames = explicitlyEnabled
        ? [...explicitlyEnabled]
        : effective.cloudGame === 'all'
          ? ['arknights', 'endfield'] : [effective.cloudGame]
      return { ...effective, enabledGames, downloadOrder: [...effective.downloadOrder] }
    },
    /** 当前用户层（配置界面的编辑起点） */
    userLayer() {
      return { ...user,
        ...(user.enabledGames ? { enabledGames: [...user.enabledGames] } : {}),
        ...(user.downloadOrder ? { downloadOrder: [...user.downloadOrder] } : {}) }
    },
    /** 订阅已验证配置的变化。 */
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /** 订阅下载、激活和索引准备等非配置状态变化。 */
    subscribeRuntime(listener) {
      runtimeListeners.add(listener)
      return () => { runtimeListeners.delete(listener) }
    },
    /** 通知只读取运行时状态的宿主能力重新求值。 */
    notifyRuntime() {
      for (const listener of runtimeListeners) listener()
    },
    /**
     * 监听其他插件实例或人工编辑写入的配置文件。运行期无效内容保留最后一个
     * 可用快照并记录警告，不让一次手误卸载已经工作的工具。
     */
    async watchConfig(logger) {
      await mkdir(dirname(configPath), { recursive: true, mode: 0o700 })
      let timer = null
      let closed = false
      const reload = () => {
        if (closed) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          state.loadConfig().catch((error) => {
            logger?.warn?.(`prts-corpus: 忽略无效配置更新：${error?.message ?? error}`)
          })
        }, 100)
      }
      const watcher = watch(dirname(configPath), { persistent: false }, (_event, filename) => {
        if (filename == null || String(filename) === basename(configPath)) reload()
      })
      watcher.on('error', (error) => {
        logger?.warn?.(`prts-corpus: 配置监听停止：${error?.message ?? error}`)
      })
      return () => {
        closed = true
        if (timer) clearTimeout(timer)
        watcher.close()
      }
    },
    /**
     * 写入用户层补丁并持久化（原子写）。非法键/类型拒绝，不落盘。
     * @returns {Promise<object>} 新的生效配置
     */
    async saveConfig(patch, { signal } = {}) {
      assertConfigWriteActive(signal)
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw Object.assign(new Error('配置补丁必须是对象'), { code: 'INVALID_CONFIG' })
      }
      validateUserLayer(patch)
      const operation = writeChain.then(async () => {
        // 被取消的排队写不能在较新的选择之后苏醒并覆盖配置。
        assertConfigWriteActive(signal)
        const previousOrigin = serviceOrigin(state.effective().cloudBaseUrl)
        const next = validateUserLayer({ ...user, ...patch })
        const nextOrigin = serviceOrigin({ ...CONFIG_DEFAULTS, ...base, ...next }.cloudBaseUrl)
        // 静态令牌只属于签发它的源。设置页把云端服务切到另一个 origin 时，
        // 未同时提交的新令牌不得被带到新服务；空字符串也能遮住 patch 层令牌。
        if (nextOrigin !== previousOrigin && !Object.hasOwn(patch, 'cloudToken')) {
          next.cloudToken = ''
        }
        await atomicWriteJson(configPath, next, { signal })
        commitUser(next)
        return state.effective()
      })
      writeChain = operation.catch(() => {})
      return operation
    },
  }
  return state
}

/** 配置快照（token 只暴露"是否已设置"，不回传明文）。 */
export function redactConfig(effective, userLayer = {}) {
  return {
    ...effective,
    cloudToken: undefined,
    hasCloudToken: Boolean(effective.cloudToken),
    cloudTokenUserSet: Boolean(userLayer.cloudToken),
  }
}
