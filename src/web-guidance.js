/** Observe the official web tools without replacing providers or handling their credentials. */
const searchSetup = 'DSH 网页搜索的凭据独立于桌面账号登录。缺少 Key 时请告知用户在插件 → 网页搜索中配置搜索提供方的 API Key；旧版可在设置 → 模型配置对应凭据。不要索取聊天中的密钥，不要把登录 token 当 API Key，也不要自行更换端点。'
const fetchSetup = 'web_fetch 不需要网页搜索的 API Key。单个站点连接失败不能推断整个网络不可用；可换用另一个已知的权威来源核验。若多个站点持续失败，提示用户检查 DSH 启动进程的网络/HTTPS_PROXY 配置并重启，不要猜测代理地址或关闭证书验证。'
const fetchCredentialSetup = '当前联网抓取由 DeepSeek 官方接口提供，需要与聊天相同的 API Key：请提示用户在模型配置中补齐该凭据，或改回默认的匿名 HTTP 抓取。单个站点失败不能推断整个网络不可用；配置未改变前不要重复抓取同一个 URL。'

// 0.2.x 有两套 DeepSeek 联网实现：聊天同源的 deepseek-official 报 "DeepSeek search has no
// API key"，新版 Search/Fetch 接口报 "DeepSeek web access has no API key"。两者都带
// WEB_PROVIDER_CREDENTIAL_MISSING，文案匹配保证旧宿主与新版开关都能命中。
const credentialMissing = (code, text) => code === 'WEB_PROVIDER_CREDENTIAL_MISSING'
  || /DeepSeek (?:search|web access) has no API key/.test(text)

export function webFailureGuidance(name, result) {
  if (!['web_search', 'web_fetch'].includes(name) || !result.isError) return null
  const code = result.error?.info?.code || result.error?.code || ''
  const text = (result.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n')
  if (/ABORT|CANCEL/.test(code) || /aborted|cancelled|已取消/i.test(text)) return null
  if (name === 'web_search' && credentialMissing(code, text)) {
    return { code: 'WEB_PROVIDER_CREDENTIAL_MISSING', guidance: searchSetup + '配置未改变前不要重复搜索；继续本地核验，并明确说明现实资料尚未完成联网查证。' }
  }
  if (name === 'web_fetch' && credentialMissing(code, text)) {
    return { code: 'WEB_PROVIDER_CREDENTIAL_MISSING', guidance: fetchCredentialSetup }
  }
  if (name === 'web_fetch' && /web fetch failed/.test(text)) {
    return { code: 'WEB_FETCH_CONNECTION_FAILED', guidance: fetchSetup }
  }
  return null
}

export function mountWebGuidance(ctx) {
  if (typeof ctx.on !== 'function' || typeof ctx.systemPrompt?.context !== 'function') return false
  const states = new WeakMap()
  ctx.on('tools/result', (exec, result) => {
    if (!exec.agent || !['web_search', 'web_fetch'].includes(exec.name)) return
    let key = exec.name
    if (exec.name === 'web_fetch') {
      try { key += ':' + new URL(exec.arguments?.url).origin } catch { return }
    }
    const state = states.get(exec.agent) || new Map()
    const issue = webFailureGuidance(exec.name, result)
    if (issue) {
      // No provider error text, API key, URL path, or request headers enter context.
      state.set(key, { tool: exec.name, ...(exec.name === 'web_fetch' ? { origin: key.slice(10) } : {}), ...issue })
      if (state.size > 8) state.delete(state.keys().next().value)
      states.set(exec.agent, state)
    } else if (!result.isError) state.delete(key)
  })
  // interpolate:false keeps literal text: DSH 0.2.1 resolves {{name}} in contexts
  // and throws on unknown names, while this text is data/receipt prose.
  ctx.systemPrompt.context({ name: 'prts-terrarchive:web-access', order: 1006, interpolate: false, text: ({ scope }) => {
    const issues = scope && states.get(scope)
    if (!issues?.size) return ''
    return '<prts:web-access>\n以下是本会话最近的联网工具故障及恢复指引。不得把未抓取到的网页或模型记忆说成已联网核实的来源。\n'
      + JSON.stringify([...issues.values()]).replaceAll('<', '\\u003c') + '\n</prts:web-access>'
  } })
  return true
}
