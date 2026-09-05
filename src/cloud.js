/**
 * dsh 版云端检索适配器：cloud_search / cloud_inspect 的 Node HTTP 客户端。
 *
 * 与浏览器端 agent/browser/src/cloud-client.js 及 frontend/src/agent-demo/prts-auth.js 语义对齐：
 *   - 固定同站路径 /api/agent/retrieval/{capabilities,search,inspect}，URL 永不受模型控制；
 *   - 认证：匿名 PoW 会话（GET /api/init-session → 解工作量证明 → POST /api/login），
 *     或配置静态 token（cloud.token）跳过登录；401 时强制刷新一次重试；
 *   - 响应上限 32MiB；code===200 校验；HTTP 状态 → 契约错误码映射（agent-cloud-retrieval.v1）。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'

export const CLOUD_CONTRACT_VERSION = 'agent-cloud-retrieval.v1'

/** 随包版本走的调用方标识；服务端据此把 DSH 插件流量与 web 前端分开统计。 */
export const DSH_CLIENT_HEADER = `dsh-plugin/${createRequire(import.meta.url)('../package.json').version}`

const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/
const MAX_CLOUD_REQUEST_BYTES = 1024 * 1024

function normalizeCloudBaseUrl(value) {
  let url
  try { url = new URL(String(value ?? '')) } catch {
    throw new TypeError('cloud baseUrl 必须是有效 URL')
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new TypeError('cloud baseUrl 必须使用 HTTPS（本地环回可用 HTTP），且不能包含凭证、查询或片段')
  }
  return url.toString().replace(/\/+$/, '')
}

function remoteMessage(value, fallback) {
  if (typeof value !== 'string') return fallback
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return normalized ? normalized.slice(0, 1000) : fallback
}

/**
 * 匿名会话的持久 client id：同一安装跨重启保持稳定，服务端按它统计
 * 独立用户。文件 0600、目录 0700，并发首次创建以 wx 保证只有一个胜者。
 * @param {string} path 如 $DSH_HOME/prts-corpus/client-id
 * @returns {Promise<string>}
 */
export async function readOrCreateClientId(path) {
  try {
    const existing = (await readFile(path, 'utf8')).trim()
    if (CLIENT_ID_PATTERN.test(existing)) return existing
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const created = `dsh-${randomUUID().replaceAll('-', '').slice(0, 20)}`
  try {
    await writeFile(path, `${created}\n`, { flag: 'wx', mode: 0o600 })
    return created
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const existing = (await readFile(path, 'utf8')).trim()
    if (!CLIENT_ID_PATTERN.test(existing)) throw new Error('cloud client id 文件损坏')
    return existing
  }
}

const PATHS = {
  capabilities: '/api/agent/retrieval/capabilities',
  cloud_search: '/api/agent/retrieval/search',
  cloud_inspect: '/api/agent/retrieval/inspect',
}

export class CloudFault extends Error {
  /**
   * @param {string} code 契约错误码
   * @param {string} message
   * @param {boolean} [retryable]
   * @param {object} [details]
   */
  constructor(code, message, retryable = false, details = undefined) {
    super(message)
    this.code = code
    this.retryable = retryable
    this.details = details
  }
}

/** ---- 匿名会话（init-session + PoW + login，与浏览器 prts-auth 同构） ---- */

const AUTH_RESPONSE_MAX_BYTES = 256 * 1024
const MAX_POW_SEED_CHARS = 512
const MAX_POW_DIFFICULTY = 6

function powHex(seed, nonce) {
  return createHash('sha256').update(`${seed}${nonce}`, 'utf8').digest('hex')
}

function cancelledFault() {
  return new CloudFault('CANCELLED', '云端请求已取消')
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancelledFault()
}

/** 解工作量证明：sha256(seed+nonce) 十六进制前缀 difficulty 个 0。定期让出事件循环以响应取消。 */
export async function solvePow(seed, difficulty, { signal } = {}) {
  if (typeof seed !== 'string' || !seed || [...seed].length > MAX_POW_SEED_CHARS
      || !Number.isInteger(difficulty) || difficulty < 0 || difficulty > MAX_POW_DIFFICULTY) {
    throw new CloudFault('AUTH_REQUIRED', 'PRTS 会话返回了非法的工作量证明参数')
  }
  const prefix = '0'.repeat(difficulty)
  const deadline = Date.now() + 8000
  for (let nonce = 0; ; nonce += 1) {
    throwIfCancelled(signal)
    if (Date.now() > deadline) throw new CloudFault('AUTH_REQUIRED', 'PRTS 会话验证计算超时')
    if (powHex(seed, nonce).startsWith(prefix)) return String(nonce)
    if (nonce > 0 && nonce % 2048 === 0) {
      await new Promise((resolve) => { setImmediate(resolve) })
    }
  }
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs, signal, consume = (response) => response) {
  throwIfCancelled(signal)
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    // 云端 API 没有跨源跳转语义；拒绝 redirect，避免静态 token 或匿名会话
    // 被配置源借 30x 带往另一个网络边界。
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal })
    return await consume(response)
  } catch (error) {
    if (signal?.aborted) throw cancelledFault()
    if (error instanceof CloudFault) throw error
    if (timedOut || error?.name === 'AbortError') {
      throw new CloudFault('CLOUD_TIMEOUT', '云端请求超时', true)
    }
    throw new CloudFault('CLOUD_UNAVAILABLE', `无法连接 ${new URL(url).host}`, true,
      { exception_type: error?.constructor?.name || typeof error })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

async function readJsonResponse(response, serviceName) {
  const bytes = await readResponseBytes(response, AUTH_RESPONSE_MAX_BYTES)
  const text = new TextDecoder().decode(bytes)
  let payload = null
  if (text.trim()) {
    try {
      payload = JSON.parse(text)
    } catch {
      throw new CloudFault('INVALID_RESPONSE', `${serviceName}返回了无法解析的响应（HTTP ${response.status}）`)
    }
  }
  if (!response.ok) {
    const detail = payload?.detail || payload?.error?.message
    throw new CloudFault('CLOUD_ERROR', remoteMessage(detail,
      `${serviceName}不可用（HTTP ${response.status}）`),
      response.status >= 500)
  }
  if (!payload) throw new CloudFault('INVALID_RESPONSE', `${serviceName}返回了空响应`)
  return payload
}

/**
 * 匿名会话提供者：token 缓存在单个 Agent 的客户端内存（不落盘）。
 */
export class AnonymousSessionProvider {
  /**
   * @param {{ baseUrl: string, userId?: string, timeoutMs?: number, fetchImpl?: typeof fetch }} options
   */
  constructor({ baseUrl, userId, timeoutMs = 8000, fetchImpl } = {}) {
    this.baseUrl = normalizeCloudBaseUrl(baseUrl)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60_000) {
      throw new TypeError('cloud timeoutMs 超出允许范围')
    }
    if (userId != null && (typeof userId !== 'string' || !userId || userId.length > 128)) {
      throw new TypeError('cloud userId 非法')
    }
    this.userId = userId || `dsh-${randomUUID().slice(0, 12)}`
    this.timeoutMs = timeoutMs
    this.fetchImpl = fetchImpl || fetch
    /** @type {string | null} */
    this.token = null
    /** @type {{ promise: Promise<string>, controller: AbortController, waiters: number } | null} */
    this.inFlight = null
  }

  /** @param {{ forceRefresh?: boolean, signal?: AbortSignal }} [options] @returns {Promise<string>} Bearer token */
  async getToken({ forceRefresh = false, signal } = {}) {
    throwIfCancelled(signal)
    if (forceRefresh) {
      this.token = null
      // 强刷不复用 refresh 之前已在途的登录：它可能正是产出刚被 401 的令牌的
      // 一次登录，等待它会在"token 未变化"的判定下放弃 401 重试。脱离引用
      // 后旧登录照常完成并让自身的等待者拿到结果，只是不再作为本次的来源。
      this.inFlight = null
    }
    if (this.token) return this.token
    if (!this.inFlight) {
      const controller = new AbortController()
      const record = { controller, waiters: 0, promise: null }
      record.promise = this.login({ signal: controller.signal }).finally(() => {
        if (this.inFlight === record) this.inFlight = null
      })
      this.inFlight = record
    }
    return this.waitForLogin(this.inFlight, signal)
  }

  async waitForLogin(record, signal) {
    record.waiters += 1
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (callback, value) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        record.waiters -= 1
        callback(value)
      }
      const onAbort = () => {
        finish(reject, cancelledFault())
        if (record.waiters === 0) record.controller.abort()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) return onAbort()
      record.promise.then(
        (token) => finish(resolve, token),
        (error) => finish(reject, error),
      )
    })
  }

  async login({ signal } = {}) {
    const sessionPayload = await fetchWithTimeout(this.fetchImpl,
      `${this.baseUrl}/api/init-session`, { headers: { Accept: 'application/json' } }, this.timeoutMs, signal,
      (response) => readJsonResponse(response, 'PRTS 会话服务'))
    const session = sessionPayload?.data
    if (typeof session?.session_token !== 'string' || !session.session_token
        || session.session_token.length > 4096) {
      throw new CloudFault('AUTH_REQUIRED', 'PRTS 会话响应缺少有效的 session_token')
    }
    const nonce = session.pow_seed
      ? await solvePow(session.pow_seed, session.pow_difficulty ?? 3, { signal })
      : null
    const loginPayload = await fetchWithTimeout(this.fetchImpl,
      `${this.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json',
        'X-Session-Token': session.session_token },
      body: JSON.stringify({ user_id: this.userId, nonce }),
    }, this.timeoutMs, signal, (response) => readJsonResponse(response, 'PRTS 登录服务'))
    if (typeof loginPayload?.data !== 'string' || !loginPayload.data
        || loginPayload.data.length > 16 * 1024) {
      throw new CloudFault('AUTH_REQUIRED', 'PRTS 登录响应缺少有效的访问令牌')
    }
    const token = loginPayload.data
    this.token = token.startsWith('Bearer ') ? token : `Bearer ${token}`
    return this.token
  }
}

async function readResponseBytes(response, maximum) {
  const declared = Number(response.headers?.get?.('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > maximum) {
    throw new CloudFault('RESPONSE_TOO_LARGE', '云端检索响应超过接收上限')
  }
  const reader = response.body?.getReader?.()
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maximum) throw new CloudFault('RESPONSE_TOO_LARGE', '云端检索响应超过接收上限')
    return bytes
  }
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maximum) {
      await reader.cancel().catch(() => {})
      throw new CloudFault('RESPONSE_TOO_LARGE', '云端检索响应超过接收上限')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** 静态 token 提供者（cloud.token 配置）。 */
export class StaticTokenProvider {
  constructor(token) {
    if (typeof token !== 'string' || !token || token.length > 16 * 1024) {
      throw new TypeError('cloud token 非法')
    }
    this.token = token.startsWith('Bearer ') ? token : `Bearer ${token}`
  }

  async getToken({ signal } = {}) {
    throwIfCancelled(signal)
    return this.token
  }
}

/** 为每个 Agent 惰性创建独立客户端；缺少 Agent 上下文时不缓存，避免意外跨执行共享。 */
export function createAgentCloudClientRegistry(createClient) {
  const clients = new WeakMap()
  return {
    forExecution(exec) {
      const agent = exec?.agent
      if ((typeof agent !== 'object' || agent === null) && typeof agent !== 'function') {
        return createClient()
      }
      let client = clients.get(agent)
      if (!client) {
        client = createClient()
        clients.set(agent, client)
      }
      return client
    },
  }
}

/** ---- 云端检索客户端 ---- */

/**
 * @param {{ baseUrl: string, tokenProvider: { getToken(options?: {forceRefresh?: boolean, signal?: AbortSignal}): Promise<string> },
 *           game?: 'all' | 'arknights' | 'endfield', games?: ('arknights' | 'endfield')[],
 *           timeoutMs?: number, maxResponseBytes?: number, fetchImpl?: typeof fetch }} options
 */
export class CloudRetrievalClient {
  constructor({
    baseUrl, tokenProvider, game = 'all', games, timeoutMs = 90_000,
    maxResponseBytes = 32 * 1024 * 1024, fetchImpl,
  } = {}) {
    if (!['all', 'arknights', 'endfield'].includes(game)) throw new TypeError('不支持的游戏命名空间')
    const effectiveGames = games || (game === 'all' ? ['arknights', 'endfield'] : [game])
    if (!Array.isArray(effectiveGames) || effectiveGames.length < 1 || effectiveGames.length > 2
        || new Set(effectiveGames).size !== effectiveGames.length
        || effectiveGames.some((item) => !['arknights', 'endfield'].includes(item))) {
      throw new TypeError('games 只能包含不重复的 arknights / endfield')
    }
    this.baseUrl = normalizeCloudBaseUrl(baseUrl)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60_000) {
      throw new TypeError('cloud timeoutMs 超出允许范围')
    }
    if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1
        || maxResponseBytes > 64 * 1024 * 1024) {
      throw new TypeError('cloud maxResponseBytes 超出允许范围')
    }
    this.tokenProvider = tokenProvider
    this.game = game
    this.games = [...effectiveGames]
    this.timeoutMs = timeoutMs
    this.maxResponseBytes = maxResponseBytes
    this.fetchImpl = fetchImpl || fetch
    /** @type {unknown | null} capabilities 成功结果缓存 */
    this._capabilities = null
  }

  /** 契约版本自检；成功结果在单个 Agent 的客户端内缓存。并发首检各自响应取消。 */
  async capabilities({ signal } = {}) {
    if (this._capabilities) return this._capabilities
    const response = await this.request('capabilities', 'GET', undefined, { signal })
    if (response.data?.contract_version !== CLOUD_CONTRACT_VERSION) {
      throw new CloudFault('CONTRACT_MISMATCH',
        `云端检索契约版本不兼容（期望 ${CLOUD_CONTRACT_VERSION}，得到 ${response.data?.contract_version}）`)
    }
    this._capabilities = response
    return response
  }

  /**
   * cloud_search：注入 request_id / intent 维度字段由调用方（插件层）补齐。
   * @param {object} arguments_ 已展开的模型参数（含 query 等）
   */
  async search(arguments_, { signal } = {}) {
    const payload = structuredClone(arguments_)
    payload.request_id ||= `req-${randomUUID().replaceAll('-', '').slice(0, 24)}`
    payload.games ||= [...this.games]
    return this.request('cloud_search', 'POST', payload, { signal })
  }

  /** cloud_inspect：request_id 由按 Agent 隔离的插件证据状态注入。 */
  async inspect(arguments_, { signal } = {}) {
    const payload = structuredClone(arguments_)
    return this.request('cloud_inspect', 'POST', payload, { signal })
  }

  async request(tool, method, body = undefined, { signal } = {}) {
    throwIfCancelled(signal)
    const serializedBody = body === undefined ? undefined : JSON.stringify(body)
    if (serializedBody !== undefined && Buffer.byteLength(serializedBody) > MAX_CLOUD_REQUEST_BYTES) {
      throw new CloudFault('INVALID_REQUEST', '云端检索请求体超过客户端上限')
    }
    let token = await this.tokenProvider.getToken({ forceRefresh: false, signal })
    const perform = async (authorization) => {
      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, this.timeoutMs)
      const onAbort = () => controller.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) controller.abort()
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${PATHS[tool]}`, {
          method,
          headers: { Accept: 'application/json', Authorization: authorization,
            ...(this.games.length === 1 ? { 'X-Game': this.games[0] } : { 'X-Games': this.games.join(',') }),
            'X-Client': DSH_CLIENT_HEADER,
            ...(body ? { 'Content-Type': 'application/json' } : {}) },
          ...(serializedBody !== undefined ? { body: serializedBody } : {}),
          redirect: 'error',
          signal: controller.signal,
        })
        const bytes = await readResponseBytes(response, this.maxResponseBytes)
        return { response, bytes }
      } catch (error) {
        if (signal?.aborted) throw new CloudFault('CANCELLED', '云端检索已取消')
        if (error instanceof CloudFault) throw error
        if (timedOut || error?.name === 'AbortError') {
          throw new CloudFault('CLOUD_TIMEOUT', '云端检索超过客户端等待期限', true)
        }
        throw new CloudFault('CLOUD_UNAVAILABLE', '无法连接云端检索服务', true,
          { exception_type: error?.constructor?.name || typeof error })
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
    }
    let result = await perform(token)
    // 本地缓存的 JWT 可能比服务端有效期短：401 时强制刷新一次重试，
    // 避免过期 token 让整轮 agent 的云端工具全部失效。
    if (result.response.status === 401) {
      const refreshed = await this.tokenProvider.getToken({ forceRefresh: true, signal })
      if (refreshed && refreshed !== token) {
        token = refreshed
        result = await perform(token)
      }
    }
    const { response, bytes } = result
    let parsed
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw new CloudFault('INVALID_RESPONSE', '云端检索返回的不是有效 JSON')
    }
    if (!response.ok) throw httpFault(response.status, parsed)
    if (parsed?.code !== 200) throw new CloudFault('INVALID_RESPONSE', '云端检索返回无效响应')
    return parsed
  }
}

export function httpFault(status, body) {
  const mapping = { 401: ['AUTH_REQUIRED', false], 403: ['ACCESS_DENIED', false],
    404: ['TRACE_NOT_FOUND', false], 409: ['REQUEST_CONFLICT', true],
    413: ['RESPONSE_TOO_LARGE', false], 422: ['INVALID_REQUEST', false],
    429: ['CLOUD_BUSY', true], 503: ['CLOUD_UNAVAILABLE', true], 504: ['CLOUD_TIMEOUT', true] }
  const [code, retryable] = mapping[status] || ['CLOUD_ERROR', status >= 500]
  const rawMessage = typeof body?.detail === 'string' ? body.detail
    : Array.isArray(body?.detail)
      ? body.detail.slice(0, 20).map((item) =>
        `${(Array.isArray(item?.loc) ? item.loc : []).slice(0, 12).join('.')}: ${item?.msg || '参数无效'}`).join('；')
      : '云端检索请求失败'
  const message = remoteMessage(rawMessage, '云端检索请求失败')
  return new CloudFault(code, message, retryable, { http_status: status,
    ...(body?.detail ? { validation: body.detail } : {}) })
}

/** ---- 插件层薄封装：错误 → 契约 error 响应 ---- */

export function cloudErrorResponse(error) {
  if (error instanceof CloudFault) {
    return { contract_version: CLOUD_CONTRACT_VERSION, status: 'error',
      error: { code: error.code, message: error.message, retryable: error.retryable,
        ...(error.details ? { details: error.details } : {}) } }
  }
  return { contract_version: CLOUD_CONTRACT_VERSION, status: 'error',
    error: { code: 'CLOUD_INTERNAL_ERROR', message: '云端检索执行失败；详情请查看 DSH Host 日志', retryable: false } }
}
