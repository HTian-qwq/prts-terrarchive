/**
 * cloud.js 单元测试：匿名 PoW 会话、契约版本自检、401 刷新、错误映射。
 * 全部使用注入的 fetchImpl 假实现，不产生真实网络请求。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  solvePow, AnonymousSessionProvider, StaticTokenProvider,
  CloudRetrievalClient, CloudFault, createAgentCloudClientRegistry,
  httpFault, cloudErrorResponse, readOrCreateClientId,
} from '../src/cloud.js'

const jsonResponse = (status, payload) => new Response(JSON.stringify(payload), {
  status, headers: { 'Content-Type': 'application/json' },
})

const stalledResponse = (signal, status = 200) => new Response(new ReadableStream({
  start(controller) {
    signal.addEventListener('abort', () => {
      const error = new Error('aborted while reading body')
      error.name = 'AbortError'
      controller.error(error)
    }, { once: true })
  },
}), { status, headers: { 'Content-Type': 'application/json' } })

test('solvePow：找到满足难度前缀的 nonce', async () => {
  const nonce = await solvePow('seed', 2)
  const hex = createHash('sha256').update(`seed${nonce}`, 'utf8').digest('hex')
  assert.ok(hex.startsWith('00'), hex)
})

test('solvePow：计算期间响应用户取消', async () => {
  const controller = new AbortController()
  const pending = solvePow('never-finish', 6, { signal: controller.signal })
  setTimeout(() => controller.abort(), 5)
  await assert.rejects(() => pending,
    (error) => error instanceof CloudFault && error.code === 'CANCELLED')
})

test('匿名认证：限制响应大小及 PoW 参数', async () => {
  const oversized = new AnonymousSessionProvider({ baseUrl: 'https://example.test',
    fetchImpl: async () => new Response('x'.repeat(300 * 1024), { status: 200 }) })
  await assert.rejects(() => oversized.getToken(),
    (error) => error instanceof CloudFault && error.code === 'RESPONSE_TOO_LARGE')

  const invalidPow = new AnonymousSessionProvider({ baseUrl: 'https://example.test',
    fetchImpl: async () => jsonResponse(200, { data: {
      session_token: 'session', pow_seed: 'seed', pow_difficulty: 7,
    } }) })
  await assert.rejects(() => invalidPow.getToken(),
    (error) => error instanceof CloudFault && error.code === 'AUTH_REQUIRED')
  await assert.rejects(() => solvePow('x'.repeat(513), 1),
    (error) => error instanceof CloudFault && error.code === 'AUTH_REQUIRED')
})

test('AnonymousSessionProvider：init-session + PoW + login 换取 Bearer', async () => {
  const calls = []
  const session = new AnonymousSessionProvider({
    baseUrl: 'https://prts.chat',
    userId: 'dsh-test',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      if (String(url).endsWith('/api/init-session')) {
        return jsonResponse(200, { code: 200, data: { session_token: 'st-1', pow_seed: 's1', pow_difficulty: 1 } })
      }
      if (String(url).endsWith('/api/login')) {
        assert.equal(init.headers['X-Session-Token'], 'st-1')
        assert.equal(JSON.parse(init.body).user_id, 'dsh-test')
        return jsonResponse(200, { code: 200, data: 'raw-token' })
      }
      throw new Error(`unexpected url ${url}`)
    },
  })
  const token = await session.getToken()
  assert.equal(token, 'Bearer raw-token')
  assert.equal(await session.getToken(), 'Bearer raw-token', 'token 应缓存')
  assert.equal(calls.length, 2)
  assert.ok(calls.every((call) => call.init.redirect === 'error'))

  await session.getToken({ forceRefresh: true })
  assert.equal(calls.length, 4, 'forceRefresh 应重新登录')
})

test('AnonymousSessionProvider：并发首次取 token 只登录一次', async () => {
  let calls = 0
  const session = new AnonymousSessionProvider({
    baseUrl: 'https://prts.chat', userId: 'dsh-concurrent',
    fetchImpl: async (url) => {
      calls += 1
      await new Promise((resolve) => { setTimeout(resolve, 5) })
      return String(url).endsWith('/api/init-session')
        ? jsonResponse(200, { code: 200, data: { session_token: 'st-concurrent' } })
        : jsonResponse(200, { code: 200, data: 'same-token' })
    },
  })
  const tokens = await Promise.all(Array.from({ length: 8 }, () => session.getToken()))
  assert.deepEqual([...new Set(tokens)], ['Bearer same-token'])
  assert.equal(calls, 2)
})

test('AnonymousSessionProvider：init-session 阶段响应取消', async () => {
  const controller = new AbortController()
  const session = new AnonymousSessionProvider({
    baseUrl: 'https://prts.chat', userId: 'dsh-cancel-init',
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    }),
  })
  const pending = session.getToken({ signal: controller.signal })
  controller.abort()
  await assert.rejects(() => pending,
    (error) => error instanceof CloudFault && error.code === 'CANCELLED')
})

test('AnonymousSessionProvider：收到响应头后读取认证响应体仍响应取消', async () => {
  const controller = new AbortController()
  const session = new AnonymousSessionProvider({
    baseUrl: 'https://prts.chat', userId: 'dsh-cancel-auth-body',
    fetchImpl: async (_url, init) => stalledResponse(init.signal),
  })
  const pending = session.getToken({ signal: controller.signal })
  await new Promise((resolve) => { setImmediate(resolve) })
  controller.abort()
  await assert.rejects(() => pending,
    (error) => error instanceof CloudFault && error.code === 'CANCELLED')
})

test('AnonymousSessionProvider：一个等待者取消不打断同 Agent 的其他等待者', async () => {
  const first = new AbortController()
  let releaseInit
  const session = new AnonymousSessionProvider({
    baseUrl: 'https://prts.chat', userId: 'dsh-shared-login',
    fetchImpl: async (url) => {
      if (String(url).endsWith('/api/init-session')) {
        await new Promise((resolve) => { releaseInit = resolve })
        return jsonResponse(200, { code: 200, data: { session_token: 'st-shared' } })
      }
      return jsonResponse(200, { code: 200, data: 'shared-token' })
    },
  })
  const cancelled = session.getToken({ signal: first.signal })
  const surviving = session.getToken()
  first.abort()
  releaseInit()
  await assert.rejects(() => cancelled,
    (error) => error instanceof CloudFault && error.code === 'CANCELLED')
  assert.equal(await surviving, 'Bearer shared-token')
})

test('StaticTokenProvider：原样返回并补 Bearer 前缀', async () => {
  assert.equal(await new StaticTokenProvider('Bearer x').getToken(), 'Bearer x')
  assert.equal(await new StaticTokenProvider('x').getToken(), 'Bearer x')
})

test('capabilities：契约版本不匹配 → CONTRACT_MISMATCH，且失败后可重试', async () => {
  let version = 'agent-cloud-retrieval.v0'
  const client = new CloudRetrievalClient({
    baseUrl: 'https://prts.chat',
    tokenProvider: { async getToken() { return 'Bearer t' } },
    fetchImpl: async () => jsonResponse(200, { code: 200, data: { contract_version: version } }),
  })
  await assert.rejects(() => client.capabilities(),
    (error) => error instanceof CloudFault && error.code === 'CONTRACT_MISMATCH')
  version = 'agent-cloud-retrieval.v1'
  const response = await client.capabilities()
  assert.equal(response.data.contract_version, 'agent-cloud-retrieval.v1')
})

test('search：注入 request_id；inspect 不持有跨调用请求状态', async () => {
  const seen = []
  const client = new CloudRetrievalClient({
    baseUrl: 'https://prts.chat',
    tokenProvider: { async getToken() { return 'Bearer t' } },
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null })
      if (String(url).endsWith('/capabilities')) return jsonResponse(200, { code: 200, data: { contract_version: 'agent-cloud-retrieval.v1' } })
      return jsonResponse(200, { code: 200, data: { ok: true } })
    },
  })
  await client.search({ query: '凯尔希的过去' })
  assert.match(seen.at(-1).body.request_id, /^req-/)
  assert.equal(seen.at(-1).body.query, '凯尔希的过去')
  assert.deepEqual(seen.at(-1).body.games, ['arknights', 'endfield'])

  await client.inspect({ section: 'candidates' })
  assert.equal(seen.at(-1).body.request_id, undefined, 'request_id 应由插件的 Agent 证据状态注入')
})

test('createAgentCloudClientRegistry：不同 Agent 隔离客户端，同 Agent 复用', () => {
  let sequence = 0
  const registry = createAgentCloudClientRegistry(() => ({ id: ++sequence }))
  const agentA = {}
  const agentB = {}
  assert.equal(registry.forExecution({ agent: agentA }), registry.forExecution({ agent: agentA }))
  assert.notEqual(registry.forExecution({ agent: agentA }), registry.forExecution({ agent: agentB }))
  assert.notEqual(registry.forExecution({}), registry.forExecution({}), '无 Agent 上下文时不得共享')
})

test('CloudRetrievalClient：认证阶段透传取消信号', async () => {
  const controller = new AbortController()
  let receivedSignal
  const client = new CloudRetrievalClient({
    baseUrl: 'https://prts.chat',
    tokenProvider: {
      async getToken({ signal }) {
        receivedSignal = signal
        await new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
          reject(new CloudFault('CANCELLED', '云端请求已取消'))
        }, { once: true }))
      },
    },
    fetchImpl: async () => { throw new Error('认证取消后不应发请求') },
  })
  const pending = client.search({ query: 'q' }, { signal: controller.signal })
  controller.abort()
  await assert.rejects(() => pending,
    (error) => error instanceof CloudFault && error.code === 'CANCELLED')
  assert.equal(receivedSignal, controller.signal)
})

test('CloudRetrievalClient：收到响应头后读取响应体仍响应取消', async () => {
  const controller = new AbortController()
  const client = new CloudRetrievalClient({
    baseUrl: 'https://prts.chat',
    tokenProvider: { async getToken() { return 'Bearer t' } },
    fetchImpl: async (_url, init) => stalledResponse(init.signal),
  })
  const pending = client.search({ query: 'q' }, { signal: controller.signal })
  await new Promise((resolve) => { setImmediate(resolve) })
  controller.abort()
  await assert.rejects(() => pending,
    (error) => error instanceof CloudFault && error.code === 'CANCELLED')
})

test('CloudRetrievalClient：响应体读取时间计入客户端超时', async () => {
  const client = new CloudRetrievalClient({
    baseUrl: 'https://prts.chat', timeoutMs: 10,
    tokenProvider: { async getToken() { return 'Bearer t' } },
    fetchImpl: async (_url, init) => stalledResponse(init.signal),
  })
  await assert.rejects(() => client.search({ query: 'q' }),
    (error) => error instanceof CloudFault && error.code === 'CLOUD_TIMEOUT')
})

test('search：401 → 刷新 token 重试一次', async () => {
  let calls = 0
  const client = new CloudRetrievalClient({
    baseUrl: 'https://prts.chat',
    tokenProvider: { async getToken({ forceRefresh = false } = {}) { return forceRefresh ? 'Bearer new' : 'Bearer old' } },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/capabilities')) return jsonResponse(200, { code: 200, data: { contract_version: 'agent-cloud-retrieval.v1' } })
      calls += 1
      return calls === 1
        ? jsonResponse(401, { detail: 'token expired' })
        : new Response(JSON.stringify({ code: 200, data: { via: init.headers.Authorization } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })
  const response = await client.search({ query: 'q' })
  assert.equal(calls, 2)
  assert.equal(response.data.via, 'Bearer new')
})

test('httpFault：状态码 → 契约错误码映射', () => {
  assert.deepEqual([httpFault(401, {}).code, httpFault(401, {}).retryable], ['AUTH_REQUIRED', false])
  assert.deepEqual([httpFault(429, {}).code, httpFault(429, {}).retryable], ['CLOUD_BUSY', true])
  assert.deepEqual([httpFault(504, {}).code, httpFault(504, {}).retryable], ['CLOUD_TIMEOUT', true])
  assert.equal(httpFault(500, {}).retryable, true)
  assert.equal(httpFault(422, { detail: [{ loc: ['body', 'query'], msg: 'required' }] }).message,
    'body.query: required')
})

test('响应超限与无效响应', async () => {
  const client = new CloudRetrievalClient({
    baseUrl: 'https://prts.chat', maxResponseBytes: 16,
    tokenProvider: { async getToken() { return 'Bearer t' } },
    fetchImpl: async (url) => {
      if (String(url).endsWith('/capabilities')) return jsonResponse(200, { code: 200, data: { contract_version: 'agent-cloud-retrieval.v1' } })
      return jsonResponse(200, { code: 200, data: { pad: 'x'.repeat(64) } })
    },
  })
  await assert.rejects(() => client.search({ query: 'q' }),
    (error) => error.code === 'RESPONSE_TOO_LARGE')
})

test('cloudErrorResponse：CloudFault → 契约 error 响应', () => {
  const response = cloudErrorResponse(new CloudFault('CLOUD_BUSY', 'busy', true, { http_status: 429 }))
  assert.equal(response.status, 'error')
  assert.deepEqual(response.error, { code: 'CLOUD_BUSY', message: 'busy', retryable: true, details: { http_status: 429 } })
  const generic = cloudErrorResponse(new Error('boom'))
  assert.equal(generic.error.code, 'CLOUD_INTERNAL_ERROR')
})

test('CloudRetrievalClient：请求携带 X-Client 标识（服务端据此区分 DSH 流量）', async () => {
  const seen = []
  const client = new CloudRetrievalClient({
    baseUrl: 'https://prts.chat',
    tokenProvider: new StaticTokenProvider('t'),
    fetchImpl: async (url, init) => {
      seen.push(init)
      return jsonResponse(200, { code: 200, data: { contract_version: 'agent-cloud-retrieval.v1' } })
    },
  })
  await client.capabilities()
  assert.match(seen[0].headers['X-Client'], /^dsh-plugin\/\d+\.\d+\.\d+/,
    'X-Client 应为 dsh-plugin/<package version>')
  assert.equal(seen[0].redirect, 'error', '云端 API 不应自动跟随跨边界跳转')
})

test('云端客户端拒绝带凭证的地址及超大请求体', async () => {
  assert.throws(() => new CloudRetrievalClient({
    baseUrl: 'https://user:secret@example.test', tokenProvider: new StaticTokenProvider('t'),
  }), /不能包含凭证/u)
  const client = new CloudRetrievalClient({
    baseUrl: 'https://example.test', tokenProvider: new StaticTokenProvider('t'),
    fetchImpl: async () => { throw new Error('不应发起网络请求') },
  })
  await assert.rejects(() => client.search({ query: 'x'.repeat(1024 * 1024) }),
    (error) => error instanceof CloudFault && error.code === 'INVALID_REQUEST')
})

test('readOrCreateClientId：持久 client id 创建/复用/并发胜者', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-clientid-'))
  try {
    const path = join(dir, 'nested', 'client-id')
    const first = await readOrCreateClientId(path)
    assert.match(first, /^dsh-[0-9a-f]{20}$/)
    // 第二次读取复用同一 id（跨重启稳定 → 服务端可统计独立用户）
    assert.equal(await readOrCreateClientId(path), first)
    // 并发首创建：wx 保证只有一个胜者，另一个读到同一 id
    const [a, b] = await Promise.all([
      readOrCreateClientId(join(dir, 'c2', 'client-id')),
      readOrCreateClientId(join(dir, 'c2', 'client-id')),
    ])
    assert.equal(a, b)
    // 损坏文件显式失败，而不是悄悄换新 id
    await mkdir(join(dir, 'c3'), { recursive: true })
    await writeFile(join(dir, 'c3', 'client-id'), '!!!\n', { flag: 'wx' })
    await assert.rejects(() => readOrCreateClientId(join(dir, 'c3', 'client-id')), /损坏/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
