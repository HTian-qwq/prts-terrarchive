/**
 * prts-terrarchive 浏览器半边（手写，无构建步骤）。
 *
 * 格式与 @deepseek-ai 官方 client 包的 lib/client.js 一致：
 *   window.__ModuleLoader__.load({ id, factory(require) { ... return module.exports } })
 * react 由平台模块表注入。本插件只依赖 connection、slots 与 theme 服务（零 UI 库依赖，
 * 组件用内联样式原生元素）。
 *
 * 注册：Settings → Plugins 里的「PRTS 语料」tab（settings.plugins.tab slot）。
 * 数据：Host Connection 认证 RPC 通道 /prts-corpus。
 */
window.__ModuleLoader__.load({
  id: 'prts-terrarchive',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { useState, useEffect, useCallback, useMemo, useRef, createElement: h, Fragment } = React

    let callApi = null
    let themeRuntime = null
    let removeSkinTokens = null
    let activeSkin = 'harness'
    let clientContext = null
    let disposeAicLayout = null
    let disposeScene = null
    let syncAicLayout = () => {}
    let sceneSnapshotModel = null
    let notifySceneSnapshot = () => {}
    const SKIN_SOURCE = 'prts-terrarchive:prts-agent-skin'

    /* ---- 终末地「开机场」加载屏：启动与切肤时全屏接管，样式自包含（不依赖皮肤样式表时序）。 ---- */
    const AIC_BOOT_KEY = 'prts.uiSkin'
    let aicBootEl = null
    let aicBootTimer = null
    let aicBootWatchdog = null
    let aicBootPct = 0
    function aicBootClearTimers() {
      if (aicBootTimer) { clearInterval(aicBootTimer); aicBootTimer = null }
      if (aicBootWatchdog) { clearTimeout(aicBootWatchdog); aicBootWatchdog = null }
    }
    function aicBootPaint(percent, message) {
      const failed = percent < 0
      aicBootEl.querySelector('.aic-boot-fill').style.width = `${aicBootPct}%`
      aicBootEl.querySelector('.aic-boot-msg').textContent = failed
        ? `LOAD FAILED: ${message ?? 'UNKNOWN'}` : `${(message ?? 'LOADING').toUpperCase()}…`
      aicBootEl.querySelector('.aic-boot-pct').textContent = `${aicBootPct}%`
    }
    function aicBootProgress(percent, message) {
      if (!aicBootEl) return
      if (aicBootTimer) { clearInterval(aicBootTimer); aicBootTimer = null }
      // 进度只进不退（假爬行与真实事件混跑时避免条子回跳）。
      aicBootPct = Math.max(aicBootPct, Math.min(100, Math.round(percent)))
      aicBootPaint(aicBootPct, message)
    }
    function aicBootShow(message = 'INITIALIZING') {
      if (typeof document === 'undefined') return
      if (aicBootEl) { aicBootProgress(aicBootPct, message); return }
      if (!document.getElementById('aic-boot-style')) {
        const style = document.createElement('style')
        style.id = 'aic-boot-style'
        style.textContent = '.aic-boot{position:fixed;inset:0;z-index:99999;background:#0b0d10;display:flex;align-items:center;justify-content:center;transition:opacity .6s ease .15s,visibility .6s ease .15s}'
          + '.aic-boot.done{opacity:0;visibility:hidden;pointer-events:none}'
          + '.aic-boot-box{width:380px;max-width:82vw;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}'
          + '.aic-boot-logo{font-size:44px;font-weight:900;letter-spacing:10px;color:#faff3f}'
          + '.aic-boot-sub{font-size:10px;letter-spacing:2px;color:rgba(255,255,255,.4);margin:8px 0 26px}'
          + '.aic-boot-bar{height:3px;background:rgba(255,255,255,.1);overflow:hidden}'
          + '.aic-boot-fill{height:100%;width:0;background:#faff3f;box-shadow:0 0 8px rgba(250,255,63,.7);transition:width .3s ease}'
          + '.aic-boot-line{display:flex;justify-content:space-between;margin-top:8px;font-size:10px;letter-spacing:1px;color:rgba(255,255,255,.5)}'
        document.head.appendChild(style)
      }
      aicBootEl = document.createElement('div')
      aicBootEl.className = 'aic-boot'
      aicBootEl.innerHTML = '<div class="aic-boot-box"><div class="aic-boot-logo">AIC</div>'
        + '<div class="aic-boot-sub">ENDFIELD INDUSTRIES // TALOS-II SURVEY SYSTEM</div>'
        + '<div class="aic-boot-bar"><div class="aic-boot-fill"></div></div>'
        + '<div class="aic-boot-line"><span class="aic-boot-msg"></span><span class="aic-boot-pct"></span></div></div>'
      document.body.appendChild(aicBootEl)
      document.documentElement.style.background = '#0b0d10'
      aicBootPct = 4
      aicBootPaint(aicBootPct, message)
      // 真实进度（地图资源 / 插件装载事件）到来前缓慢爬行，避免停在 0%。
      aicBootTimer = setInterval(() => {
        if (!aicBootEl) return
        aicBootPct = Math.min(90, aicBootPct + Math.random() * 3)
        aicBootPaint(aicBootPct, 'LOADING')
      }, 160)
      // 看门狗：任何挂起（配置请求悬挂、地图脚本阻塞、席位未渲染）最多 30s 强制放行，绝不卡死界面。
      aicBootWatchdog = setTimeout(() => { if (aicBootEl) aicBootDone() }, 30000)
    }
    function aicBootAbort() {
      aicBootClearTimers()
      aicBootEl?.remove()
      aicBootEl = null
      if (typeof document !== 'undefined' && activeSkin !== 'endfield-aic') document.documentElement.style.background = ''
    }
    function aicBootDone() {
      if (!aicBootEl) return
      aicBootProgress(100, 'SYSTEM ONLINE')
      const el = aicBootEl
      aicBootEl = null
      aicBootClearTimers()
      setTimeout(() => {
        el.classList.add('done')
        setTimeout(() => {
          el.remove()
          if (activeSkin !== 'endfield-aic') document.documentElement.style.background = ''
        }, 900)
      }, 260)
    }
    // 上次会话是终末地皮肤时，抢先盖住 Harness 白色启动屏（同步执行，早于任何异步配置）。
    try {
      if (typeof localStorage !== 'undefined' && localStorage.getItem(AIC_BOOT_KEY) === 'endfield-aic') {
        console.info('[prts-terrarchive] boot takeover: cached endfield skin, showing AIC loading screen')
        aicBootShow('CONNECTING TERMINAL')
      }
    } catch { /* 隐私模式等无 localStorage 环境：退回默认启动屏 */ }


    // PRTS Agent 原版是“深色侧栏 + 亮色阅读区”的固定混合亮度，
    // 不是 Harness 主题的一个普通亮/暗配色。因此两种 base scheme 投影到
    // 同一套 canonical token；侧栏的反白文字由局部 CSS token 负责。
    const canonical = (value) => ({ light: value, dark: value })
    const PRTS_AGENT_TOKENS = Object.freeze({
      '--dsw-alias-bg-base': canonical('rgba(255,255,255,.01)'),
      '--dsw-alias-bg-layer-1': canonical('rgba(248,249,246,.9)'),
      '--dsw-alias-bg-layer-2': canonical('rgba(255,255,255,.95)'),
      '--dsw-alias-bg-layer-3': canonical('#ffffff'),
      '--dsw-alias-bg-module-platform': canonical('rgba(239,239,235,.9)'),
      '--dsw-alias-bg-multi-select': canonical('#f1f2ef'),
      '--dsw-alias-bg-overlay': canonical('#f2f3f0'),
      '--dsw-alias-border-l1': canonical('rgba(17,18,20,.075)'),
      '--dsw-alias-border-l2': canonical('rgba(17,18,20,.15)'),
      '--dsw-alias-border-l2-darkmode-thin': canonical('rgba(17,18,20,.11)'),
      '--dsw-alias-border-l3': canonical('rgba(17,18,20,.2)'),
      '--dsw-alias-border-l4': canonical('rgba(17,18,20,.28)'),
      '--dsw-alias-brand-primary': canonical('#111214'),
      '--dsw-alias-brand-text': canonical('#111214'),
      '--dsw-alias-button-elevated-fill': canonical('rgba(255,255,255,.92)'),
      '--dsw-alias-button-floating-fill': canonical('rgba(255,255,255,.9)'),
      '--dsw-alias-button-floating-hover': canonical('#efefeb'),
      '--dsw-alias-button-ghost-active-fill': canonical('rgba(17,18,20,.095)'),
      '--dsw-alias-button-ghost-active-hover': canonical('rgba(17,18,20,.13)'),
      '--dsw-alias-button-info-fill': canonical('#111214'),
      '--dsw-alias-button-info-hover': canonical('#292b2f'),
      '--dsw-alias-button-primary-dimmed': canonical('#e5e6e2'),
      '--dsw-alias-button-primary-hover': canonical('#34373b'),
      '--dsw-alias-interactive-bg-active': canonical('rgba(17,18,20,.095)'),
      '--dsw-alias-interactive-bg-hover': canonical('rgba(17,18,20,.055)'),
      '--dsw-alias-interactive-bg-hover-accent': canonical('rgba(40,105,216,.12)'),
      '--dsw-alias-interactive-bg-hover-solid': canonical('#f1f1ed'),
      '--dsw-alias-label-primary': canonical('#111214'),
      '--dsw-alias-label-primary-dimmed': canonical('#34373b'),
      '--dsw-alias-label-primary-foreground': canonical('#ffffff'),
      '--dsw-alias-label-primary-inverted': canonical('#ffffff'),
      '--dsw-alias-label-secondary': canonical('#34373b'),
      '--dsw-alias-label-tertiary': canonical('#62666c'),
      '--dsw-alias-label-caption': canonical('#858a91'),
      '--dsw-alias-label-dimmed': canonical('#b4b7bb'),
      '--dsw-alias-markdown-citation': canonical('#e4ecfb'),
      '--dsw-alias-markdown-code-block': canonical('rgba(245,246,243,.9)'),
      '--dsw-alias-markdown-code-block-banner': canonical('#efefeb'),
      '--dsw-alias-markdown-inline-code': canonical('#efefeb'),
      '--dsw-alias-scrollbar-bg-l1': canonical('rgba(127,130,132,.25)'),
      '--dsw-alias-scrollbar-bg-l2': canonical('rgba(127,130,132,.32)'),
      '--dsw-alias-scrollbar-hover-l1': canonical('rgba(98,102,108,.45)'),
      '--dsw-alias-scrollbar-hover-l2': canonical('rgba(98,102,108,.55)'),
      '--dsw-alias-state-business-primary': canonical('#2869d8'),
      '--dsw-alias-state-business-tertiary': canonical('#e4ecfb'),
      '--dsw-alias-state-error-primary': canonical('#f25a5a'),
      '--dsw-alias-state-success-primary': canonical('#35ad64'),
      '--dsw-alias-state-warn-primary': canonical('#e89a1c'),
      '--dsw-specific-bubble': canonical('rgba(255,255,255,.82)'),
      '--dsw-specific-bubble-highlight': canonical('#e4ecfb'),
      '--dsw-specific-input-major': canonical('rgba(255,255,255,.9)'),
      '--dsw-specific-menu': canonical('rgba(255,255,255,.97)'),
      '--dsw-specific-selector': canonical('#f5f6f3'),
      '--dsw-specific-sidebar-fill': canonical('transparent'),
      '--dsw-specific-sidebar-nav-item-active': canonical('rgba(255,255,255,.14)'),
      '--dsw-specific-sidebar-nav-item-hover': canonical('rgba(255,255,255,.08)'),
      '--dsw-specific-tip': canonical('rgba(245,246,243,.94)'),
    })

    // 皮肤接管整套 --dsw-* token：终末地是固定暗色界面，而 Harness 主题仍是
    // light 基线，漏掉的 token（如 bg-module-platform、button-floating-fill）
    // 会保持近白填充，与近白文字叠成"白块"。因此对照 design-platform 全集补齐。
    const ENDFIELD_AIC_TOKENS = Object.freeze({
      '--dsw-alias-bg-base': canonical('#0b0d10'),
      '--dsw-alias-bg-layer-1': canonical('rgba(12,15,17,.88)'),
      '--dsw-alias-bg-layer-2': canonical('rgba(18,21,23,.94)'),
      '--dsw-alias-bg-layer-3': canonical('#15191c'),
      '--dsw-alias-bg-mask-1': canonical('rgba(0,0,0,.55)'),
      '--dsw-alias-bg-mask-2': canonical('rgba(0,0,0,.28)'),
      '--dsw-alias-bg-mask-3': canonical('rgba(0,0,0,.48)'),
      '--dsw-alias-bg-module-platform': canonical('rgba(255,255,255,.07)'),
      '--dsw-alias-bg-multi-select': canonical('rgba(255,255,255,.06)'),
      '--dsw-alias-bg-overlay': canonical('rgba(16,19,22,.92)'),
      '--dsw-alias-bg-skeleton': canonical('rgba(255,255,255,.07)'),
      // 会话思考状态的 shimmer 直接引用品牌蓝 static token，覆写成酸性黄。
      '--dsw-static-deepseek-500': canonical('#faff3f'),
      '--dsw-static-deepseek-200': canonical('#fdffa3'),
      '--dsw-alias-border-l1': canonical('rgba(255,255,255,.1)'),
      '--dsw-alias-border-l2': canonical('rgba(255,255,255,.17)'),
      '--dsw-alias-border-l2-darkmode-thin': canonical('rgba(255,255,255,.1)'),
      '--dsw-alias-border-l3': canonical('rgba(250,255,63,.38)'),
      '--dsw-alias-border-l4': canonical('rgba(255,255,255,.26)'),
      '--dsw-alias-border-inverted': canonical('rgba(255,255,255,.06)'),
      '--dsw-alias-border-inverted2': canonical('rgba(255,255,255,.08)'),
      '--dsw-alias-brand-primary': canonical('#faff3f'),
      '--dsw-alias-brand-primary-invert': canonical('#080a0c'),
      '--dsw-alias-brand-primary-new-colorprimary-new-color': canonical('#faff3f'),
      '--dsw-alias-brand-text': canonical('#faff3f'),
      '--dsw-alias-button-contrast-fill': canonical('rgba(238,240,235,.85)'),
      '--dsw-alias-button-elevated-fill': canonical('rgba(18,21,24,.95)'),
      '--dsw-alias-button-floating-fill': canonical('rgba(14,17,20,.94)'),
      '--dsw-alias-button-floating-hover': canonical('rgba(30,34,38,.96)'),
      '--dsw-alias-button-ghost-active-border': canonical('rgba(250,255,63,.55)'),
      '--dsw-alias-button-ghost-active-fill': canonical('rgba(250,255,63,.12)'),
      '--dsw-alias-button-ghost-active-hover': canonical('rgba(250,255,63,.18)'),
      '--dsw-alias-button-info-fill': canonical('#dce12f'),
      '--dsw-alias-button-info-hover': canonical('#faff3f'),
      '--dsw-alias-button-primary-dimmed': canonical('rgba(250,255,63,.35)'),
      '--dsw-alias-button-primary-fill': canonical('#faff3f'),
      '--dsw-alias-button-primary-hover': canonical('#fdff86'),
      '--dsw-alias-button-tool-bar-fill': canonical('rgba(84,85,87,.5)'),
      '--dsw-alias-button-tool-bar-fill-invisible': canonical('rgba(31,31,31,.36)'),
      '--dsw-alias-button-tool-bar-hover': canonical('rgba(84,85,87,.6)'),
      '--dsw-alias-interactive-bg-active': canonical('rgba(250,255,63,.12)'),
      '--dsw-alias-interactive-bg-hover': canonical('rgba(255,255,255,.07)'),
      '--dsw-alias-interactive-bg-hover-accent': canonical('rgba(250,255,63,.14)'),
      '--dsw-alias-interactive-bg-hover-danger': canonical('rgba(255,103,103,.16)'),
      '--dsw-alias-interactive-bg-hover-solid': canonical('rgba(28,32,36,.95)'),
      '--dsw-alias-label-primary': canonical('#f2f3ef'),
      '--dsw-alias-label-primary-bluish': canonical('#f2f3ef'),
      '--dsw-alias-label-primary-dimmed': canonical('#d8d9d5'),
      '--dsw-alias-label-primary-foreground': canonical('#080a0c'),
      '--dsw-alias-label-primary-inverted': canonical('#101316'),
      '--dsw-alias-label-secondary': canonical('rgba(242,243,239,.74)'),
      '--dsw-alias-label-tertiary': canonical('rgba(242,243,239,.5)'),
      '--dsw-alias-label-caption': canonical('rgba(242,243,239,.35)'),
      '--dsw-alias-label-dimmed': canonical('rgba(242,243,239,.42)'),
      '--dsw-alias-markdown-citation': canonical('rgba(250,255,63,.12)'),
      '--dsw-alias-markdown-code-block': canonical('rgba(5,7,8,.78)'),
      '--dsw-alias-markdown-code-block-banner': canonical('rgba(250,255,63,.08)'),
      '--dsw-alias-markdown-code-segment-selected': canonical('rgba(255,255,255,.1)'),
      '--dsw-alias-markdown-code-segment-unselected': canonical('rgba(255,255,255,.05)'),
      '--dsw-alias-markdown-inline-code': canonical('rgba(250,255,63,.1)'),
      '--dsw-alias-markdown-placeholder': canonical('rgba(255,255,255,.07)'),
      '--dsw-alias-markdown-tag': canonical('rgba(255,255,255,.08)'),
      '--dsw-alias-scrollbar-bg-l1': canonical('rgba(255,255,255,.12)'),
      '--dsw-alias-scrollbar-bg-l2': canonical('rgba(255,255,255,.18)'),
      '--dsw-alias-scrollbar-hover-l1': canonical('rgba(250,255,63,.42)'),
      '--dsw-alias-scrollbar-hover-l2': canonical('rgba(250,255,63,.45)'),
      '--dsw-alias-state-business-primary': canonical('#faff3f'),
      '--dsw-alias-state-business-tertiary': canonical('rgba(250,255,63,.1)'),
      '--dsw-alias-state-error-primary': canonical('#ff6767'),
      '--dsw-alias-state-error-secondary': canonical('#ff8585'),
      '--dsw-alias-state-success-primary': canonical('#b9e85b'),
      '--dsw-alias-state-success-secondary': canonical('#b9e85b'),
      '--dsw-alias-state-success-tertiary': canonical('rgba(185,232,91,.12)'),
      '--dsw-alias-state-warn-label': canonical('#dce12f'),
      '--dsw-alias-state-warn-primary': canonical('#faff3f'),
      '--dsw-alias-state-warn-secondary': canonical('rgba(250,255,63,.75)'),
      '--dsw-alias-state-warn-tertiary': canonical('rgba(250,255,63,.1)'),
      '--dsw-alias-toast-bg': canonical('rgba(17,20,23,.98)'),
      '--dsw-alias-tooltip-bg': canonical('rgba(17,20,23,.98)'),
      '--dsw-specific-bubble': canonical('rgba(10,12,14,.74)'),
      '--dsw-specific-bubble-highlight': canonical('rgba(250,255,63,.08)'),
      '--dsw-specific-input-major': canonical('rgba(13,16,18,.94)'),
      '--dsw-specific-login-input': canonical('rgba(255,255,255,.06)'),
      '--dsw-specific-menu': canonical('rgba(10,12,14,.98)'),
      '--dsw-specific-selector': canonical('rgba(255,255,255,.05)'),
      '--dsw-specific-sidebar-fill': canonical('rgba(8,10,12,.96)'),
      '--dsw-specific-sidebar-nav-item-active': canonical('rgba(250,255,63,.1)'),
      '--dsw-specific-sidebar-nav-item-active-accent': canonical('rgba(250,255,63,.14)'),
      '--dsw-specific-sidebar-nav-item-hover': canonical('rgba(255,255,255,.06)'),
      '--dsw-specific-tip': canonical('rgba(10,12,14,.96)'),
    })

    const setSkin = (skin) => {
      const next = skin === 'prts-agent' || skin === 'endfield-aic' ? skin : 'harness'
      if (next === activeSkin) return next
      if (removeSkinTokens) {
        removeSkinTokens()
        removeSkinTokens = null
      }
      if (typeof document !== 'undefined') {
        if (next === 'prts-agent') document.body.dataset.prtsSkin = 'agent'
        else if (next === 'endfield-aic') document.body.dataset.prtsSkin = 'endfield-aic'
        else delete document.body.dataset.prtsSkin
      }
      if (next === 'prts-agent' && themeRuntime) {
        removeSkinTokens = themeRuntime.overrideTokens(SKIN_SOURCE, PRTS_AGENT_TOKENS)
      } else if (next === 'endfield-aic' && themeRuntime) {
        removeSkinTokens = themeRuntime.overrideTokens(SKIN_SOURCE, ENDFIELD_AIC_TOKENS)
      }
      activeSkin = next
      syncScene()
      syncAicLayout()
      return next
    }

    const PRTS_SEARCH_TOOLS = ['cloud_search', 'cloud_inspect', 'corpus_search', 'timeline_search']
    const PRTS_SCENE_TOOLS = [...PRTS_SEARCH_TOOLS, 'corpus_read']
    const emptyToolVisual = () => ({ state: 'standby', calls: 0, latest: null })
    const compactSceneText = (value, fallback, limit = 32) => {
      const text = String(value ?? '').trim().replace(/\s+/gu, ' ')
      if (!text) return fallback
      return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
    }
    const parseToolArguments = (raw) => {
      if (raw && typeof raw === 'object') return raw
      try { return JSON.parse(String(raw || '{}')) } catch { return {} }
    }
    const toolSnapshot = (root) => {
      if (!root) return null
      if ('kind' in root) return {
        name: root.call?.name || '', argsRaw: root.call?.argsRaw || '{}',
        state: root.isError ? 'error' : 'complete', time: root.time || 0,
      }
      return { name: root.name || '', argsRaw: root.argsRaw || '{}', state: 'active', time: root.time || 0 }
    }
    const visibleAssistantText = (blocks) => (Array.isArray(blocks) ? blocks : [])
      .filter((block) => block?.kind === 'text')
      .map((block) => block.text || '').join('').trim()

    /** DSH Chat snapshot -> PRTS Agent 四阶段视觉模型。 */
    const buildSceneSnapshotModel = (order, nodes) => {
      const visuals = Object.fromEntries(PRTS_SCENE_TOOLS.map((name) => [name, emptyToolVisual()]))
      const assistantSteps = []
      for (let index = 0; index < (Array.isArray(order) ? order.length : 0); index += 1) {
        const node = nodes?.get?.(order[index])
        if (node?.kind === 'tool-call') {
          const call = toolSnapshot(node.data?.root)
          if (!call || !Object.hasOwn(visuals, call.name)) continue
          const visual = visuals[call.name]
          visual.calls += 1
          visual.latest = { ...call, index, arguments: parseToolArguments(call.argsRaw) }
          visual.state = call.state
        } else if (node?.kind === 'assistant-step') {
          assistantSteps.push({
            index, status: node.data?.status || 'settled',
            text: visibleAssistantText(node.data?.blocks),
          })
        }
      }
      const aggregate = (names) => {
        const states = names.map((name) => visuals[name].state)
        if (states.includes('active')) return 'active'
        if (states.includes('error') && !states.includes('complete')) return 'error'
        if (states.includes('complete')) return 'complete'
        if (states.includes('error')) return 'error'
        return 'standby'
      }
      const searchCalls = PRTS_SEARCH_TOOLS.flatMap((name) => {
        const latest = visuals[name].latest
        return latest ? [{ ...latest, name, calls: visuals[name].calls }] : []
      }).sort((left, right) => left.index - right.index)
      const latestQuery = searchCalls.at(-1) || null
      const latestRead = visuals.corpus_read.latest
      const hasToolCall = PRTS_SCENE_TOOLS.some((name) => visuals[name].calls > 0)
      const assistantRunning = assistantSteps.some((step) => step.status === 'running')
      const finalAnswer = [...assistantSteps].reverse().find((step) => step.text && step.status !== 'running')
      const planState = hasToolCall ? 'complete' : assistantRunning ? 'active' : 'standby'
      const recallState = aggregate(PRTS_SEARCH_TOOLS)
      const readState = visuals.corpus_read.state
      let verifyState = 'standby'
      if (readState === 'error') verifyState = 'error'
      else if (latestRead) {
        const answerAfterRead = finalAnswer && finalAnswer.index > latestRead.index
        verifyState = answerAfterRead ? 'complete' : 'active'
      }

      const queryArgs = latestQuery?.arguments || {}
      const queryValue = queryArgs.query?.text || queryArgs.query || ''
      const queryScopes = queryArgs.options?.channels || queryArgs.resource_types
        || queryArgs.filters?.resource_types || []
      const queryScope = Array.isArray(queryScopes) && queryScopes.length
        ? queryScopes.join(' + ')
        : latestQuery?.name?.startsWith('cloud_') ? `${queryArgs.depth || 'standard'} / cloud` : 'local corpus + timeline'
      const readArgs = latestRead?.arguments || {}
      const selection = readArgs.selection || readArgs
      const sourceRange = selection.mode === 'range'
        ? `L${selection.start_line || '?'}—L${selection.end_line || '?'}`
        : readArgs.line || selection.line
          ? `L${readArgs.line || selection.line} ± ${selection.before ?? 3}/${selection.after ?? 3}`
          : selection.mode === 'document' ? 'DOCUMENT / PAGED' : '文档 · 行号 · 说话人'
      const localCalls = visuals.corpus_search.calls + visuals.timeline_search.calls
      const recallTitle = visuals.cloud_search.calls ? '云端召回候选'
        : visuals.timeline_search.calls ? '检索事件时间线' : '召回候选片段'
      const recallMeta = visuals.cloud_search.calls ? `云端检索 / ${visuals.cloud_search.calls} 次`
        : localCalls ? `本地索引 / ${localCalls} 次` : '本地索引 / 待命'
      const stateLabel = (state, labels) => labels[state] || labels.standby
      const running = assistantRunning || PRTS_SCENE_TOOLS.some((name) => visuals[name].state === 'active')
      const latestActivity = latestRead?.state === 'active' ? '正在核验原文'
        : latestQuery?.state === 'active' ? '正在检索候选'
          : verifyState === 'active' ? '正在核对来源与主张'
            : hasToolCall ? '本地证据链' : '本地检索'

      return {
        visuals,
        plan: { state: planState, title: '拆解问题意图', meta: stateLabel(planState, {
          active: '正在解析实体 · 时间 · 因果', complete: '检索计划已生成',
          error: '计划生成异常', standby: '实体 · 时间 · 因果',
        }) },
        recall: { state: recallState, title: recallTitle, meta: recallMeta },
        read: { state: readState, title: '定位原文上下文', meta: sourceRange },
        verify: { state: verifyState, title: '交叉核验证据', meta: stateLabel(verifyState, {
          active: '正在核对来源与主张', complete: '证据核验完成',
          error: '证据核验异常', standby: '等待已读原文',
        }) },
        query: {
          state: latestQuery?.state || planState,
          text: compactSceneText(queryValue, '等待用户问题'),
          scope: compactSceneText(queryScope, 'local corpus'),
          status: stateLabel(latestQuery?.state || planState, {
            active: 'QUERYING RETRIEVAL SERVICE', complete: 'QUERY RESOLVED',
            error: 'QUERY FAILED', standby: 'WAITING FOR AGENT',
          }),
        },
        source: {
          state: readState,
          title: compactSceneText(readArgs.title || readArgs.locator?.display_title, '等待定位原文'),
          range: sourceRange,
          status: stateLabel(readState, {
            active: 'READING SOURCE CONTEXT', complete: 'SOURCE CONTEXT READY',
            error: 'SOURCE READ FAILED', standby: 'WAITING FOR SOURCE',
          }),
        },
        stack: [
          `01  cloud.search  ×${visuals.cloud_search.calls}`,
          `02  corpus.search ×${visuals.corpus_search.calls}`,
          `03  source.read   ×${visuals.corpus_read.calls}`,
        ],
        ticker: latestActivity,
        tickerState: running ? 'LIVE' : hasToolCall || finalAnswer ? 'DONE' : 'IDLE',
        running,
      }
    }

    const sceneSnapshotSignature = (snapshot) => (snapshot?.order || []).map((key) => {
      const node = snapshot.nodes?.get?.(key)
      if (node?.kind === 'tool-call') {
        const call = toolSnapshot(node.data?.root)
        return call ? `t:${call.name}:${call.state}:${call.argsRaw}` : 't:'
      }
      if (node?.kind === 'assistant-step') {
        return `a:${node.data?.status}:${visibleAssistantText(node.data?.blocks).length}`
      }
      return node?.kind || ''
    }).join('|')

    const SCENE_HTML = `
      <div class="hero-system-map">
      <div class="prts-scene-grid"></div>
      <div class="prts-scene-shard prts-shard-dark"></div>
      <div class="prts-scene-shard prts-shard-glass"></div>
      <div class="prts-scene-shard prts-shard-silver"></div>
      <div class="prts-scan-orbit"><i></i><i></i><i></i><i></i><span>SEARCH<br>RADIUS</span></div>
      <div class="prts-crosshair prts-crosshair-a"><i></i></div>
      <div class="prts-crosshair prts-crosshair-b"><i></i></div>
      <div class="prts-ambient-type">RETRIEVAL<br><strong>PROCESS</strong><small>PRTS / 04—16</small></div>
      <div class="prts-trace-window prts-trace-query"><header><span>QUERY_DECOMPOSE</span><i></i></header><p><em>intent</em> <span>等待用户问题</span></p><p><em>scope</em> <span>local corpus</span></p><b><i></i><strong>WAITING FOR AGENT</strong></b></div>
      <div class="prts-trace-window prts-trace-source"><header><span>SOURCE_READ</span><i></i></header><p><em>doc</em> <span>等待定位原文</span></p><p><em>range</em> <span>文档 · 行号 · 说话人</span></p><b><i></i><strong>WAITING FOR SOURCE</strong></b></div>
      <div class="prts-trace-stack"><span>01&nbsp;&nbsp;cloud.search</span><span>02&nbsp;&nbsp;corpus.search</span><span>03&nbsp;&nbsp;source.read</span></div>
      <div class="prts-system-node prts-node-plan"><i></i><small>01 · QUERY PLAN</small><b>拆解问题意图</b><span>等待计划生成</span></div>
      <div class="prts-system-node prts-node-recall"><i></i><small>02 · RETRIEVAL</small><b>云端召回候选</b><span>本地 / 云端检索</span></div>
      <div class="prts-system-node prts-node-read"><i></i><small>03 · SOURCE READ</small><b>定位原文上下文</b><span>DOCUMENT / PAGED</span></div>
      <div class="prts-system-node prts-node-verify"><i></i><small>04 · VERIFY</small><b>交叉核验证据</b><span>证据链完成</span></div>
      <div class="prts-system-caption"><span></span>LOCAL AGENT PROCESSOR <em>STANDBY</em></div>
      <div class="prts-system-ticker"><b>AGENT TRACE</b><span>本地检索</span><i>IDLE</i></div>
      <svg class="prts-cpu-assembly" viewBox="0 0 620 410" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs><linearGradient id="prts-cpu-board" x1="185" y1="185" x2="433" y2="332" gradientUnits="userSpaceOnUse"><stop stop-color="#F8F8F5"/><stop offset=".52" stop-color="#E8E9E5"/><stop offset="1" stop-color="#FDFDFC"/></linearGradient><linearGradient id="prts-cpu-die" x1="257" y1="196" x2="365" y2="276" gradientUnits="userSpaceOnUse"><stop stop-color="#16181B"/><stop offset=".58" stop-color="#3B4047"/><stop offset="1" stop-color="#0E1012"/></linearGradient><linearGradient id="prts-cpu-lid" x1="250" y1="70" x2="404" y2="180" gradientUnits="userSpaceOnUse"><stop stop-color="#FFF"/><stop offset="1" stop-color="#D7D9D5"/></linearGradient><filter id="prts-cpu-shadow" x="120" y="120" width="390" height="250" filterUnits="userSpaceOnUse"><feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#16181B" flood-opacity=".14"/></filter><filter id="prts-lid-shadow" x="190" y="22" width="280" height="220" filterUnits="userSpaceOnUse"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#16181B" flood-opacity=".13"/></filter></defs>
        <g class="prts-circuit-lines" stroke="#9DA19F"><path d="M20 255H135L178 227M36 284H145L185 260M63 318H165L205 292M600 242H485L446 221M584 277H473L435 253M552 314H452L415 286"/><circle cx="20" cy="255" r="3" fill="#9DA19F"/><circle cx="36" cy="284" r="3" fill="#9DA19F"/><circle cx="600" cy="242" r="3" fill="#9DA19F"/><circle cx="584" cy="277" r="3" fill="#9DA19F"/></g>
        <g filter="url(#prts-cpu-shadow)"><path d="M176 204L305 147L447 215L315 299L176 231V204Z" fill="#CBCDCA"/><path d="M176 204L305 136L447 204L315 288L176 220V204Z" fill="url(#prts-cpu-board)" stroke="#B7BAB7"/><path d="M202 207L306 152L421 207L314 273L202 221V207Z" stroke="#C4C7C4"/><path d="M228 207L307 165L394 207L314 257L228 218V207Z" stroke="#D1D3D0"/><g class="prts-cpu-die-group"><path class="prts-cpu-die" d="M267 204L308 182L354 204L313 230L267 210V204Z" fill="url(#prts-cpu-die)" stroke="#0A0B0D"/><path d="M267 204L313 226L354 202" stroke="#777D83" opacity=".55"/><path class="prts-cpu-die-highlight" d="M278 201L308 186L342 202L312 221L278 207V201Z" fill="#68717B" opacity=".42"/></g></g>
        <g class="prts-cpu-pins" stroke="#B4B7B4" stroke-width="2"><path d="M191 232L174 242M210 241L193 252M231 251L214 262M252 261L235 272M273 271L256 282M296 282L279 293M333 279L350 290M354 266L371 277M375 253L392 264M397 239L414 250M418 226L435 237"/></g>
        <g class="prts-cpu-lid" filter="url(#prts-lid-shadow)"><path d="M228 112L313 68L404 112L317 166L228 122V112Z" fill="#C6C9C6"/><path d="M228 104L313 60L404 104L317 158L228 114V104Z" fill="url(#prts-cpu-lid)" stroke="#AEB2AF"/><path d="M251 104L314 72L381 105L316 145L251 114V104Z" stroke="#C1C4C1"/><path d="M299 100L314 92L330 100L314 110L299 103V100Z" fill="#17191C"/></g><g class="prts-assembly-guides" stroke="#8E9391" stroke-dasharray="4 7"><path d="M242 126L242 186M388 119L388 190M316 166V184"/></g>
      </svg>
      </div><div class="prts-empty-hero"><div class="prts-hero-identity"><div class="prts-hero-wordmark"><svg viewBox="0 0 1567 299" aria-label="PRTS"><g fill="#111214"><path d="M0 0H260C300 0 331 28 331 63V135C331 171 300 200 260 200H58C54 200 52 203 52 207V298H0V127H51V145C51 150 54 153 58 153H247C265 153 279 139 279 121V78C279 62 266 49 251 49H44Z"/><path d="M428 0H696C734 0 765 28 765 62V139C765 172 738 200 707 200H686L762 296L698 298L610 200H483C481 200 480 203 480 207V280L479 298H430V127H478V145C478 150 481 153 484 153H683C700 153 714 139 714 121V88C714 66 701 49 685 49H469Z"/><path d="M867 0H1163V49H1045C1043 49 1042 51 1042 53V262L1041 297L1029 298L991 263V53C991 51 989 49 987 49H867Z"/><path d="M1319 0H1554L1512 49H1333C1319 49 1308 61 1308 75V103C1308 116 1319 127 1332 127H1506C1541 127 1566 155 1566 189V244C1566 274 1542 298 1513 298H1310L1289 275C1289 272 1291 269 1293 267L1305 256C1308 253 1311 252 1315 252H1487C1504 252 1517 239 1517 222V199C1517 185 1507 174 1495 174H1315C1282 174 1256 147 1256 124V59C1256 26 1284 0 1319 0Z"/></g></svg><em>BETA</em></div><small><s>PRIMITIVE RHODES ISLAND TERMINAL SERVICE</s> // PRIES—???</small></div><h2>想从泰拉的故事里了解什么？</h2><p>我会先检索线索，再回到本地资料逐行核验，并把可复查的原文放在回答旁边。</p></div>
    `
    const AIC_CSS = `
      body[data-prts-skin="endfield-aic"]{margin:0;overflow:hidden;color:#eef0eb;background:#14181b;color-scheme:dark;font-family:"Arial Narrow","Roboto Condensed","PingFang SC","Microsoft YaHei",sans-serif}
      .aic-root,.aic-root *{box-sizing:border-box}.aic-root{--acid:#faff3f;--ink:#080a0c;--panel:rgba(8,10,12,.82);--aic-band-width:min(clamp(760px,46vw,960px),calc(100vw - 360px));position:fixed;z-index:40;inset:0;overflow:hidden;pointer-events:none;color:#eef0eb;background:transparent;isolation:isolate;animation:aic-root-in .28s ease-out both}
      body.aic-chat-resizing,body.aic-chat-resizing *{cursor:col-resize!important;user-select:none!important;-webkit-user-select:none!important}
      .aic-map{position:absolute;z-index:0;inset:0;overflow:hidden;pointer-events:auto;background:#2c3337}
      .aic-map-status{position:absolute;z-index:2;right:25%;bottom:42px;color:rgba(240,242,236,.55);font:10px/1.4 ui-monospace,monospace;letter-spacing:.12em}.aic-map-status.error{color:#ff6c6c}
      body[data-prts-skin="endfield-aic"] #root>[data-slot="root"]>div{grid-template-columns:0 minmax(0,1fr) 0!important;background:#14181b}body[data-prts-skin="endfield-aic"] #root>[data-slot="root"]>div>div:first-child{visibility:visible;width:0!important;overflow:visible!important;pointer-events:none}body[data-prts-skin="endfield-aic"].aic-modal-open #root>[data-slot="root"]>div>div:first-child{position:relative;z-index:100!important}body[data-prts-skin="endfield-aic"] #root>[data-slot="root"]>div>div:first-child [data-slot="sidebar.settings"] button[aria-haspopup="dialog"]{display:none!important}body[data-prts-skin="endfield-aic"] #root>[data-slot="root"]>div>div:first-child [data-slot="sidebar.settings"]>[role="presentation"]{visibility:visible;pointer-events:auto}body[data-prts-skin="endfield-aic"] [data-shell-overlay="true"]{z-index:40!important}body[data-prts-skin="endfield-aic"] [data-slot="conversation"]>div{position:fixed!important;z-index:50;top:104px;bottom:0;left:0;width:var(--prts-aic-band-width,min(clamp(760px,46vw,960px),calc(100vw - 360px)));height:calc(100vh - 104px)!important;min-height:0;overflow:visible!important;background:transparent!important;box-shadow:none;pointer-events:none}body[data-prts-skin="endfield-aic"] [data-slot="conversation"]>div::before{content:none!important}body[data-prts-skin="endfield-aic"] [data-slot="conversation"] :is([data-conversation-scroll],[data-composer-seat],button,textarea,select,details,[contenteditable="true"]){pointer-events:auto}body[data-prts-skin="endfield-aic"] [data-slot="conversation"] button,body[data-prts-skin="endfield-aic"] [data-slot="conversation"] textarea,body[data-prts-skin="endfield-aic"] [data-slot="conversation"] select{border-radius:0!important}body[data-prts-skin="endfield-aic"] [data-slot="conversation"] details,body[data-prts-skin="endfield-aic"] [data-slot="conversation"] pre{border-radius:0!important}body[data-prts-skin="endfield-aic"] [data-slot="conversation.composer.bar"]>div{border-color:rgba(255,255,255,.18)!important;background:rgba(10,13,15,.96)!important;box-shadow:none!important}body[data-prts-skin="endfield-aic"] [data-slot="conversation.input.model"] button,body[data-prts-skin="endfield-aic"] [data-slot="conversation.input.plan"] button,body[data-prts-skin="endfield-aic"] [data-slot="conversation.hero.workspace"] button{color:rgba(238,240,235,.78)!important;background:transparent!important}body[data-prts-skin="endfield-aic"] [data-slot="shell.overlay"]{position:fixed;z-index:40;inset:0;pointer-events:none}
      .aic-map-reset{position:absolute;z-index:8;top:22px;right:286px;height:26px;padding:0 12px;border:1px solid rgba(255,255,255,.18);border-radius:0;color:rgba(244,245,241,.7);background:rgba(7,9,10,.52);font:9px ui-monospace,monospace;cursor:pointer;pointer-events:auto}.aic-map-reset:hover{border-color:var(--acid);color:var(--acid)}
      .aic-region-card{position:absolute;z-index:9;right:24px;top:92px;width:300px;padding:16px;border:1px solid rgba(250,255,63,.28);border-left:3px solid var(--acid);color:#e8eae5;background:rgba(7,9,10,.9);box-shadow:0 18px 45px rgba(0,0,0,.32);backdrop-filter:blur(10px)}.aic-region-card small{color:var(--acid);font:8px ui-monospace,monospace;letter-spacing:.1em}.aic-region-card h3{margin:12px 0 1px;font-size:20px}.aic-region-card em{color:rgba(238,240,235,.35);font:9px ui-monospace,monospace}.aic-region-card p{margin:14px 0;color:rgba(238,240,235,.7);font-size:12px;line-height:1.7}.aic-region-card b{color:rgba(238,240,235,.38);font:8px ui-monospace,monospace}
      .aic-hud{position:absolute;z-index:30;font:10px/1.35 ui-monospace,monospace;letter-spacing:.08em;text-shadow:0 1px 4px #000}.aic-hud-tl{top:24px;left:24px}.aic-hud-tr{top:22px;right:22px;display:flex;align-items:center;gap:8px}.aic-hud-br{right:25px;bottom:20px;color:rgba(238,240,235,.38)}
      .aic-brand{display:flex;align-items:center;gap:9px}.aic-brand-mark{width:10px;height:10px;background:var(--acid);box-shadow:0 0 12px rgba(250,255,63,.8)}.aic-brand-name{font-size:16px;font-weight:800;letter-spacing:.12em}.aic-brand-sub{color:rgba(238,240,235,.42)}.aic-coords{display:flex;gap:17px;margin-top:8px;color:var(--acid)}
      .aic-clock{font-weight:700;letter-spacing:.1em}
      .aic-hud-tr{pointer-events:auto}.aic-terminal-overlay{position:relative;z-index:2;display:flex;flex:none;align-items:center;gap:8px;width:100%;height:104px;margin-right:4px;padding:64px 20px 12px;border-bottom:1px solid rgba(255,255,255,.14);pointer-events:auto;background:transparent}.aic-terminal-overlay .aic-terminal-name{margin-right:auto}
      .aic-chat-band{position:absolute;z-index:25;top:0;bottom:0;left:0;width:var(--aic-band-width);display:flex;flex-direction:column;pointer-events:none}.aic-chat-resize{position:absolute;z-index:35;top:112px;right:-15px;width:30px;height:30px;display:grid;place-items:center;padding:0;border:1px solid rgba(255,255,255,.18);border-radius:0;color:rgba(255,255,255,.52);background:rgba(8,10,12,.88);cursor:col-resize;pointer-events:auto}.aic-chat-resize:hover,.aic-chat-resize:focus-visible{border-color:rgba(250,255,63,.72);outline:none;color:var(--acid)}.aic-chat-resize::before{content:"↔";font:12px ui-monospace,monospace}.aic-chat-resize-line{position:fixed;z-index:80;top:0;bottom:0;width:1px;background:rgba(250,255,63,.78);box-shadow:0 0 8px rgba(250,255,63,.24);pointer-events:none}
      .aic-band-backdrop{position:absolute;z-index:1;top:0;bottom:0;left:0;width:calc(100% + 260px);pointer-events:none;background:linear-gradient(90deg,rgba(9,11,13,.82) 0%,rgba(9,11,13,.62) 45%,rgba(9,11,13,.25) 75%,transparent 100%);-webkit-backdrop-filter:blur(16px) saturate(1.1);backdrop-filter:blur(16px) saturate(1.1);-webkit-mask-image:linear-gradient(90deg,#000 0%,#000 40%,transparent 96%);mask-image:linear-gradient(90deg,#000 0%,#000 40%,transparent 96%)}
      .aic-band-head,.aic-messages,.aic-composer{pointer-events:auto}.aic-band-head{display:flex;align-items:center;justify-content:space-between;height:45px;padding:0 14px;border-block:1px solid rgba(255,255,255,.12);background:rgba(7,9,10,.22)}.aic-terminal-name{display:flex;align-items:center;gap:9px;font:700 12px/1 ui-monospace,monospace;letter-spacing:.12em}.aic-terminal-dot{width:8px;height:8px;background:var(--acid)}.aic-terminal-ver{color:rgba(238,240,235,.3);font-size:8px}.aic-band-actions{display:flex;gap:8px}.aic-band-btn{display:flex;align-items:center;gap:7px;height:30px;padding:0 13px;border:1px solid rgba(255,255,255,.16);border-radius:0;color:rgba(238,240,235,.65);background:rgba(8,10,12,.62);font:10px/1 inherit;cursor:pointer}.aic-band-btn:hover,.aic-band-btn.on{border-color:rgba(250,255,63,.6);color:var(--acid)}
      .aic-native-conversation{min-height:0;height:100%;overflow:hidden;pointer-events:auto;--dsh-chat-content-width:100%;--dsh-composer-card-max-width:100%;--dsh-composer-side-clearance:8px}.aic-native-conversation>[data-slot="conversation"],.aic-native-conversation>[data-slot="conversation"]>div{height:100%;min-height:0;background:transparent!important}.aic-native-conversation button,.aic-native-conversation textarea,.aic-native-conversation select{border-radius:0!important}.aic-native-conversation textarea{font-family:inherit}.aic-native-conversation [data-slot="conversation.composer.bar"]>div{border-color:rgba(255,255,255,.18)!important;background:rgba(10,13,15,.94)!important;box-shadow:none!important}.aic-native-conversation [data-slot="conversation.input.model"] button,.aic-native-conversation [data-slot="conversation.input.plan"] button,.aic-native-conversation [data-slot="conversation.hero.workspace"] button{color:rgba(238,240,235,.72)!important;background:transparent!important}.aic-native-conversation details{border-radius:0!important}.aic-native-conversation [data-slot="conversation.chat.node"]{font-family:inherit}.aic-native-conversation [data-slot="conversation.chat.node"] pre{border-radius:0!important}
      .aic-native-settings{height:26px}.aic-native-settings>[data-slot="sidebar.settings"]{height:26px}.aic-native-settings>[data-slot="sidebar.settings"]>button{width:auto;height:26px;margin:0;padding:0 12px;border:1px solid rgba(255,255,255,.18);border-radius:0;color:rgba(244,245,241,.7);background:rgba(7,9,10,.52);font:9px/1 ui-monospace,monospace;letter-spacing:.08em}.aic-native-settings>[data-slot="sidebar.settings"]>button:hover{border-color:var(--acid);color:var(--acid);background:rgba(250,255,63,.06)}.aic-native-settings>[data-slot="sidebar.settings"]>button svg{display:none}.aic-root [role="dialog"]{width:min(1180px,calc(100vw - 56px));max-width:none;height:min(860px,calc(100vh - 56px));border:1px solid rgba(250,255,63,.24);border-radius:0!important;background:#090b0d!important;box-shadow:0 28px 90px rgba(0,0,0,.72)!important}.aic-root [role="dialog"] nav{border-right:1px solid rgba(250,255,63,.18);background:linear-gradient(180deg,#0c0f11,#07090a)}.aic-root [role="dialog"] button,.aic-root [role="dialog"] input,.aic-root [role="dialog"] select{border-radius:0!important}.aic-root [role="dialog"] button[aria-current="true"]{border-left:2px solid var(--acid);background:rgba(250,255,63,.07)!important}.aic-root [role="dialog"] [data-slot="settings.section"]{background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:42px 42px}.aic-root [role="dialog"] h3{color:var(--acid)!important;font-family:ui-monospace,monospace!important;letter-spacing:.08em}
      body[data-prts-skin="endfield-aic"] [role="dialog"]{border-radius:0!important}body[data-prts-skin="endfield-aic"] [role="presentation"]>[aria-hidden="true"]{background:rgba(3,5,6,.82)!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important}body[data-prts-skin="endfield-aic"] [aria-modal="true"][role="dialog"]{width:min(1180px,calc(100vw - 56px));max-width:none;height:min(860px,calc(100vh - 56px));border:1px solid rgba(250,255,63,.24);background:#090b0d!important;box-shadow:0 28px 90px rgba(0,0,0,.72)!important}body[data-prts-skin="endfield-aic"] [aria-modal="true"][role="dialog"] nav{border-right:1px solid rgba(250,255,63,.18);background:linear-gradient(180deg,#0c0f11,#07090a)}body[data-prts-skin="endfield-aic"] [aria-modal="true"][role="dialog"] button,body[data-prts-skin="endfield-aic"] [aria-modal="true"][role="dialog"] input,body[data-prts-skin="endfield-aic"] [aria-modal="true"][role="dialog"] select{border-radius:0!important}body[data-prts-skin="endfield-aic"] [aria-modal="true"][role="dialog"] button[aria-current="true"]{border-left:2px solid #faff3f;background:rgba(250,255,63,.07)!important}body[data-prts-skin="endfield-aic"] [aria-modal="true"][role="dialog"] [data-slot="settings.section"]{background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:42px 42px}body[data-prts-skin="endfield-aic"] [aria-modal="true"][role="dialog"] h3{color:#faff3f!important;font-family:ui-monospace,monospace!important;letter-spacing:.08em}
      /* 原生 transcript / reasoning / tool-call 不删字段、不折叠成自定义摘要，只换成终端外观。 */
      body[data-prts-skin="endfield-aic"] [data-phase="active"] [data-conversation-scroll]{padding-top:18px}
      body[data-prts-skin="endfield-aic"] [data-phase="active"] [data-chat-flow-kind]{border-radius:0!important;font-family:"Arial Narrow","PingFang SC",sans-serif}
      body[data-prts-skin="endfield-aic"] [data-phase="active"] [data-chat-flow-kind="tool-call"]{border-color:rgba(250,255,63,.24)!important;background:rgba(3,5,6,.5)!important}
      body[data-prts-skin="endfield-aic"] [data-phase="active"] [data-tool]{border-radius:0!important}
      /* 思考状态对齐原版 AIC 终端：暗白文字 + 闪烁酸性黄光标 ▊，不用品牌蓝/纯黄渐变扫光。 */
      body[data-prts-skin="endfield-aic"] [data-conversation-scroll] [role="status"][aria-live="polite"]{color:rgba(255,255,255,.45)!important;-webkit-text-fill-color:rgba(255,255,255,.45)!important;background:none!important;font:500 11px/18px ui-monospace,SFMono-Regular,Menlo,monospace!important;letter-spacing:.08em!important;animation:none!important;text-shadow:none!important}
      body[data-prts-skin="endfield-aic"] [data-conversation-scroll] [role="status"][aria-live="polite"]::before{content:"▊ ";color:#faff3f;-webkit-text-fill-color:#faff3f;animation:aic-blink 1s infinite}
      body[data-prts-skin="endfield-aic"] [data-phase="active"] [data-chat-flow-kind="tool-call"]{border-color:transparent!important;background:rgba(255,255,255,.025)!important}
      /* 会话流折叠行（Think / Tool call / 上下文注入）：扁平终端日志风。
         酸黄是稀缺强调色——只用于悬停反馈，标签一律暗白大写等宽。 */
      body[data-prts-skin="endfield-aic"] [data-variant="think"] [class*="_row_"],body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="context"] [class*="_row_"],body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="tool-call"] [class*="_row_"]{min-height:0;padding:2px 8px;border-radius:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;transition:background .12s}
      body[data-prts-skin="endfield-aic"] [data-variant="think"] [class*="_row_"]:hover,body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="context"] [class*="_row_"]:hover,body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="tool-call"] [class*="_row_"]:hover{background:rgba(255,255,255,.05)}
      body[data-prts-skin="endfield-aic"] [data-variant="think"] [class*="_title"],body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="context"] [class*="_title"],body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="tool-call"] [class*="_title"]{color:rgba(255,255,255,.42)!important;-webkit-text-fill-color:rgba(255,255,255,.42)!important;font:700 10px/18px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace!important;letter-spacing:.18em;text-transform:uppercase}
      body[data-prts-skin="endfield-aic"] [data-variant="think"] [class*="_row_"]:hover [class*="_title"],body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="context"] [class*="_row_"]:hover [class*="_title"],body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="tool-call"] [class*="_row_"]:hover [class*="_title"]{color:#faff3f!important;-webkit-text-fill-color:#faff3f!important}
      body[data-prts-skin="endfield-aic"] [data-variant="think"] [class*="_leading"] svg,body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="context"] [class*="_leading"] svg,body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="tool-call"] [class*="_leading"] svg{color:rgba(255,255,255,.38)}
      body[data-prts-skin="endfield-aic"] [data-variant="think"] [class*="_row_"]:hover [class*="_leading"] svg,body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="context"] [class*="_row_"]:hover [class*="_leading"] svg,body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="tool-call"] [class*="_row_"]:hover [class*="_leading"] svg{color:#faff3f}
      body[data-prts-skin="endfield-aic"] [data-variant="think"] [class*="_summary"],body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="context"] [class*="_summary"],body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="context"] [data-context-source],body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="tool-call"] [class*="_summary"],body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="tool-call"] [class*="_fileLink"]{color:rgba(255,255,255,.6)!important;-webkit-text-fill-color:rgba(255,255,255,.6)!important;font:400 11px/18px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace!important;letter-spacing:.02em}
      body[data-prts-skin="endfield-aic"] [data-variant="think"] [class*="_chevron"],body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="context"] [class*="_chevron"],body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="tool-call"] [class*="_chevron"]{color:rgba(255,255,255,.3)}
      body[data-prts-skin="endfield-aic"] [data-variant="think"] [class*="_thinkBody"],body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="context"] [data-context-injection-body]{color:rgba(255,255,255,.55)!important;font-size:11px!important;line-height:1.7!important;border-top:1px solid rgba(255,255,255,.07)}
      /* 会话头部恢复轨迹/对话视图 tab：面包屑隐藏，tab 做成终端按钮。 */
      body[data-prts-skin="endfield-aic"] [data-slot="conversation.session.header"]{display:block!important;background:transparent!important}
      body[data-prts-skin="endfield-aic"] [data-slot="conversation.session.header"] header{min-height:0;padding:2px 16px 6px;border-bottom:0;background:transparent}
      body[data-prts-skin="endfield-aic"] [data-slot="conversation.session.header"] nav{display:none!important}
      body[data-prts-skin="endfield-aic"] [data-slot="conversation.session.header"] header>div:first-child{justify-content:flex-end}
      body[data-prts-skin="endfield-aic"] [data-slot="conversation.session.header"] header>div:first-child>div:first-child{display:none!important}
      body[data-prts-skin="endfield-aic"] [data-slot="conversation.session.header"] header>div:first-child>div:last-child{margin-left:auto}
      body[data-prts-skin="endfield-aic"] [data-slot="conversation.session.header"] [role="tablist"]{gap:6px;padding:0 8px 4px}
      body[data-prts-skin="endfield-aic"] [data-slot="conversation.session.header"] [role="tab"]{height:22px;padding:0 12px;border:1px solid rgba(255,255,255,.16);border-radius:0;color:rgba(238,240,235,.6);background:rgba(8,10,12,.62);font:700 10px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.14em;text-transform:uppercase;cursor:pointer}
      body[data-prts-skin="endfield-aic"] [data-slot="conversation.session.header"] [role="tab"]:hover{border-color:rgba(250,255,63,.5);color:#faff3f}
      body[data-prts-skin="endfield-aic"] [data-slot="conversation.session.header"] [role="tab"][aria-selected="true"]{border-color:rgba(250,255,63,.6);color:#faff3f;background:rgba(250,255,63,.07)}
      /* 连排日志行（tool-call / context / 纯 Think 步骤）紧凑化：相邻时抵消大部分列间距，正文消息不受影响。 */
      body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="tool-call"] + [data-chat-flow-kind="tool-call"],
      body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="context"] + [data-chat-flow-kind="context"],
      body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="context"] + [data-chat-flow-kind="tool-call"],
      body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="tool-call"] + [data-chat-flow-kind="context"],
      body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="tool-call"] + [data-chat-flow-kind="assistant-step"]:has([data-variant="think"]):not(:has(p)),
      body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="assistant-step"]:has([data-variant="think"]):not(:has(p)) + [data-chat-flow-kind="tool-call"],
      body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="assistant-step"]:has([data-variant="think"]):not(:has(p)) + [data-chat-flow-kind="assistant-step"]:has([data-variant="think"]):not(:has(p)),
      body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="assistant-step"]:has([data-variant="think"]):not(:has(p)) + [data-chat-flow-kind="context"],
      body[data-prts-skin="endfield-aic"] [data-chat-flow-kind="context"] + [data-chat-flow-kind="assistant-step"]:has([data-variant="think"]):not(:has(p)){margin-top:-12px}
      /* Start screen: retain Harness's real translucent composer and controls,
         but replace its product hero with the PRTS identity used by our first skin. */
      .aic-start-brand{position:absolute;z-index:8;top:clamp(128px,17vh,205px);left:0;width:min(clamp(760px,46vw,960px),calc(100vw - 360px));color:#eef0eb;text-align:center;pointer-events:none;opacity:1;transform:translateY(0);transition:opacity .22s ease,transform .22s ease,filter .22s ease}
      body[data-prts-skin="endfield-aic"]:has([data-slot="conversation"]>[data-phase="active"]) .aic-start-brand{opacity:0;transform:translateY(-18px);filter:blur(3px)}
      .aic-start-wordmark{font-family:var(--dsw-font-family),"DeepSeek Sans",Inter,sans-serif;font-size:78px;font-weight:750;line-height:.9;letter-spacing:.28em;text-indent:.28em;color:#f1f2ed;text-shadow:0 0 28px rgba(255,255,255,.055)}
      .aic-start-submark{margin-top:13px;color:rgba(238,240,235,.38);font:8px/1.4 ui-monospace,monospace;letter-spacing:.105em}.aic-start-submark s{text-decoration-color:rgba(255,93,93,.72);text-decoration-thickness:1px}
      .aic-start-brand h2{margin:25px 0 5px;color:#f1f2ed;font-family:var(--dsw-font-family),"DeepSeek Sans",sans-serif;font-size:23px;font-weight:500;line-height:1.35}.aic-start-brand p{margin:0;color:rgba(238,240,235,.48);font-family:var(--dsw-font-family),"DeepSeek Sans",sans-serif;font-size:12px;line-height:1.65}
      /* Canonical AIC welcome: same pane and glass values before and after the first turn. */
      body[data-prts-skin="endfield-aic"] [data-slot="conversation"]>div{background:transparent!important}
      body[data-prts-skin="endfield-aic"] :is([data-phase="hero"],[data-phase="active"]) [data-conversation-scroll]{background:transparent!important}
      .aic-start-brand{top:134px;left:19px;width:calc(min(clamp(760px,46vw,960px),calc(100vw - 360px)) - 42px);padding:0 16px 18px;border-left:3px solid #faff3f;text-align:left}
      .aic-start-brand::before{content:"AIC";display:flex;align-items:center;gap:12px;margin:0 0 17px;color:#faff3f;font:800 13px/1 ui-monospace,monospace;letter-spacing:.11em}
      .aic-start-brand::after{content:"";position:absolute;top:6px;right:0;left:58px;height:1px;background:rgba(255,255,255,.12)}
      .aic-start-wordmark{display:inline-block;padding:7px 10px;border:1px solid rgba(250,255,63,.56);color:#faff3f;font-size:42px;font-weight:750;line-height:1;letter-spacing:.22em;text-indent:.22em}
      .aic-start-submark{display:inline-block;margin:0 0 0 12px;vertical-align:bottom}
      .aic-start-brand h2{margin:22px 0 6px;font-size:20px;font-weight:600}.aic-start-brand p{max-width:690px;font-size:13px;line-height:1.75}
      body[data-prts-skin="endfield-aic"] [data-phase="hero"]{--dsh-chat-content-width:100%;--dsh-composer-card-max-width:100%;--dsh-composer-side-clearance:0;overflow:hidden!important}
      body[data-prts-skin="endfield-aic"] [data-phase="hero"] [data-conversation-scroll]{justify-content:flex-end!important;padding:0 19px 18px!important;overflow:hidden!important}
      body[data-prts-skin="endfield-aic"] [data-phase="hero"] [data-composer-seat]{width:100%;flex:none}
      body[data-prts-skin="endfield-aic"] [data-phase="hero"] [data-chain-overlay-fallback="conversation.composer"]>div{width:100%!important;max-width:none!important;padding:0!important;gap:8px!important}
      body[data-prts-skin="endfield-aic"] [data-phase="hero"] [data-chain-overlay-fallback="conversation.composer"]>div>svg,body[data-prts-skin="endfield-aic"] [data-phase="hero"] [data-chain-overlay-fallback="conversation.composer"]>div>div:first-of-type{display:none!important}
      body[data-prts-skin="endfield-aic"] [data-phase="hero"] [data-chain-overlay-fallback="conversation.composer"]>div>div:nth-of-type(2){min-height:32px;margin:0!important;padding:0 8px!important;border-top:1px solid rgba(255,255,255,.13)!important;color:rgba(238,240,235,.68);font:11px/32px var(--dsw-font-family),sans-serif}
      body[data-prts-skin="endfield-aic"] [data-phase="hero"] [data-composer-card]{width:100%!important;max-width:none!important;gap:7px!important;padding:8px 0 0!important;border:1px solid rgba(255,255,255,.19)!important;border-radius:0!important;background:rgba(13,16,18,.78)!important;box-shadow:none!important;backdrop-filter:blur(10px)}
      body[data-prts-skin="endfield-aic"] [data-phase="hero"] [data-input-scroll]{border:0!important;background:transparent!important}
      body[data-prts-skin="endfield-aic"] [data-phase="hero"] [data-input-scroll] [contenteditable]{min-height:42px!important;padding:6px 14px 2px!important;font-size:13px!important}
      body[data-prts-skin="endfield-aic"] [data-phase="hero"] [data-composer-placeholder]{inset:6px 14px auto!important;font-size:13px}
      body[data-prts-skin="endfield-aic"] [data-phase="hero"] [data-composer-card]>div:last-child{margin:0!important;padding:3px 8px 6px!important;border-top:1px solid rgba(255,255,255,.1)!important}
      body[data-prts-skin="endfield-aic"] [data-phase="hero"] [data-composer-card]>div:last-child>div:last-child>button:last-child{width:82px!important;height:34px!important;border-radius:0!important;background:rgba(250,255,63,.68)!important;transform:none!important}
      body[data-prts-skin="endfield-aic"] [data-phase="hero"] [data-composer-card]>div:last-child>div:last-child>button:last-child svg{display:none!important}
      body[data-prts-skin="endfield-aic"] [data-phase="hero"] [data-composer-card]>div:last-child>div:last-child>button:last-child::after{content:"SEND"!important;color:#080a0c;font:700 11px/1 ui-monospace,monospace;letter-spacing:.12em}
      /* 原生发送/停止键把图标写死成白色 currentColor，压在酸性黄底上对比度不足。 */
      body[data-prts-skin="endfield-aic"] [data-composer-card]>div:last-child>div:last-child>button:last-child{color:#080a0c!important}
      .aic-messages{min-height:0;padding:22px 16px 34px;overflow:auto;scrollbar-width:thin;scrollbar-color:rgba(250,255,63,.38) transparent}.aic-empty{display:flex;height:100%;min-height:230px;align-items:center;justify-content:center;color:rgba(238,240,235,.45);font:10px/1.7 ui-monospace,monospace;letter-spacing:.08em;text-align:center}.aic-empty strong{display:block;color:#f3f4ef;font-size:18px;letter-spacing:.1em}.aic-empty i{display:block;width:32px;height:2px;margin:12px auto;background:var(--acid)}
      .aic-msg{position:relative;margin:0 0 24px;padding:0 0 0 14px;border-left:2px solid rgba(255,255,255,.54);animation:aic-msg-in .24s ease-out both}.aic-msg.bot{border-left-color:var(--acid)}.aic-msg.context{opacity:.55;border-left-style:dashed}.aic-msg-head{display:flex;align-items:center;gap:10px;margin-bottom:11px;color:rgba(238,240,235,.58);font:700 10px/1 ui-monospace,monospace;letter-spacing:.12em}.aic-msg.bot .aic-msg-role{color:var(--acid)}.aic-msg-rule{height:1px;flex:1;background:rgba(255,255,255,.1)}.aic-msg-live{color:var(--acid);animation:aic-blink 1s steps(2,end) infinite}
      .aic-msg-body{color:#e5e7e1;font-size:14px;line-height:1.8;letter-spacing:.01em;overflow-wrap:anywhere}.aic-msg-body p{margin:0 0 10px}.aic-msg-body h1,.aic-msg-body h2,.aic-msg-body h3{margin:18px 0 10px;color:#f5f6f1;font-size:17px;line-height:1.45}.aic-msg-body li{margin:5px 0}.aic-msg-body strong{color:#fff}.aic-msg-body code{padding:1px 4px;color:var(--acid);background:rgba(250,255,63,.07);font:12px ui-monospace,monospace}.aic-msg-body blockquote{margin:4px 0 13px;padding:5px 12px;border-left:2px solid var(--acid);color:rgba(238,240,235,.72)}.aic-msg-body pre{padding:12px;overflow:auto;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.4);white-space:pre-wrap}.aic-reasoning{margin:0 0 12px;border:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.22)}.aic-reasoning summary{padding:8px 10px;color:rgba(238,240,235,.45);font:9px ui-monospace,monospace;letter-spacing:.1em;cursor:pointer}.aic-reasoning pre{margin:0;padding:10px;border-top:1px solid rgba(255,255,255,.08);color:rgba(238,240,235,.55);font:11px/1.65 ui-monospace,monospace;white-space:pre-wrap}
      .aic-process{margin:0 0 18px;border:1px solid rgba(255,255,255,.12);border-left:2px solid rgba(250,255,63,.42);background:rgba(4,6,7,.44);animation:aic-msg-in .2s ease-out both}.aic-process.running{border-left-color:var(--acid);box-shadow:inset 3px 0 18px rgba(250,255,63,.025)}.aic-process.failed{border-left-color:#ff6767}.aic-process>summary{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;min-height:42px;padding:7px 11px;color:rgba(238,240,235,.63);font:9px/1.4 ui-monospace,monospace;letter-spacing:.08em;cursor:pointer;list-style:none}.aic-process>summary::-webkit-details-marker{display:none}.aic-process-chevron{color:rgba(238,240,235,.35);transition:transform .15s}.aic-process[open] .aic-process-chevron{transform:rotate(90deg)}.aic-process-title{min-width:0;display:flex;flex-direction:column;gap:2px;overflow:hidden}.aic-process-title b{overflow:hidden;color:inherit;font:inherit;text-overflow:ellipsis;white-space:nowrap}.aic-process-title small{overflow:hidden;color:rgba(250,255,63,.55);font:7px/1.3 ui-monospace,monospace;letter-spacing:.06em;text-overflow:ellipsis;white-space:nowrap}.aic-process.running .aic-process-title b{color:var(--acid)}.aic-process.failed .aic-process-title b{color:#ff8585}.aic-process-count{color:rgba(238,240,235,.32);white-space:nowrap}.aic-process-body{padding:8px 10px 2px;border-top:1px solid rgba(255,255,255,.08)}.aic-process-body .aic-tool{margin-bottom:7px;background:rgba(0,0,0,.18)}.aic-process-body .aic-reasoning{margin-bottom:7px}
      .aic-tool{margin:0 0 14px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.31)}.aic-tool[open]{border-left:2px solid var(--acid)}.aic-tool summary{display:flex;align-items:center;gap:9px;padding:8px 10px;color:rgba(238,240,235,.58);font:9px/1.4 ui-monospace,monospace;letter-spacing:.08em;cursor:pointer}.aic-tool-state{width:6px;height:6px;background:var(--acid)}.aic-tool.error .aic-tool-state{background:#ff6767}.aic-tool pre{max-height:300px;margin:0;padding:11px;overflow:auto;border-top:1px solid rgba(255,255,255,.1);color:rgba(238,240,235,.58);font:10px/1.55 ui-monospace,monospace;white-space:pre-wrap}.aic-notice{margin:9px 0;padding:8px 10px;border-left:2px solid rgba(255,255,255,.25);color:rgba(238,240,235,.47);background:rgba(0,0,0,.25);font:10px/1.5 ui-monospace,monospace}.aic-notice.error{border-color:#ff6767;color:#ff8a8a}
      .aic-composer{display:grid;grid-template-columns:minmax(0,1fr) 84px;gap:10px;padding-top:12px;border-top:1px solid rgba(255,255,255,.15)}.aic-composer textarea{width:100%;min-height:43px;max-height:132px;padding:12px;border:1px solid rgba(255,255,255,.2);border-radius:0;outline:0;resize:none;color:#f2f3ef;background:rgba(13,16,18,.92);font:13px/1.45 inherit}.aic-composer textarea:focus{border-color:rgba(250,255,63,.7)}.aic-composer textarea::placeholder{color:rgba(238,240,235,.28)}.aic-send{border:1px solid rgba(250,255,63,.45);border-radius:0;color:#080a0c;background:rgba(250,255,63,.78);font:700 11px/1 ui-monospace,monospace;letter-spacing:.1em;cursor:pointer}.aic-send:hover{background:var(--acid)}.aic-send:disabled{opacity:.28;cursor:not-allowed}
      .aic-drawer{position:absolute;z-index:26;top:60px;bottom:16px;left:20px;width:min(400px,calc(100vw - 40px));padding:14px;border:1px solid rgba(250,255,63,.25);background:rgba(7,9,10,.97);box-shadow:24px 0 70px rgba(0,0,0,.42);pointer-events:auto;animation:aic-drawer-in .2s ease-out both}.aic-drawer-head{display:flex;align-items:center;justify-content:space-between;padding:7px 3px 14px;border-bottom:1px solid rgba(255,255,255,.12);color:var(--acid);font:700 11px ui-monospace,monospace;letter-spacing:.12em}.aic-close{width:27px;height:27px;border:1px solid rgba(255,255,255,.15);border-radius:0;color:#fff;background:none;cursor:pointer}.aic-session-list{height:calc(100% - 90px);padding-top:10px;overflow:auto}.aic-session{display:block;width:100%;padding:11px 12px;border:0;border-left:2px solid transparent;color:rgba(238,240,235,.58);background:transparent;text-align:left;cursor:pointer}.aic-session:hover{color:#fff;background:rgba(255,255,255,.04)}.aic-session.active{border-left-color:var(--acid);color:var(--acid);background:rgba(250,255,63,.06)}.aic-session b,.aic-session small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.aic-session b{font-size:12px}.aic-session small{margin-top:4px;color:rgba(238,240,235,.3);font:8px ui-monospace,monospace}
      body[data-prts-skin="endfield-aic"]:has(.aic-drawer) [data-slot="conversation"]>div{z-index:30}
      .aic-settings-layer{position:absolute;z-index:40;inset:0;display:grid;grid-template-columns:16.25rem minmax(0,1fr);background:#090b0d;animation:aic-root-in .2s ease-out both}.aic-settings-nav{position:relative;padding:28px 22px;border-right:1px solid rgba(250,255,63,.18);background:linear-gradient(180deg,#0c0f11,#07090a)}.aic-settings-nav::after{content:"CONFIGURATION NODE";position:absolute;right:-5px;bottom:94px;color:rgba(250,255,63,.11);font:700 38px/1 ui-monospace,monospace;letter-spacing:-.08em;writing-mode:vertical-rl}.aic-settings-brand{display:flex;align-items:center;gap:9px;color:var(--acid);font:800 16px ui-monospace,monospace;letter-spacing:.12em}.aic-settings-nav p{margin:8px 0 34px;color:rgba(238,240,235,.33);font:9px/1.6 ui-monospace,monospace}.aic-settings-tab{display:block;width:100%;margin:3px 0;padding:11px 12px;border:0;border-left:2px solid var(--acid);color:#eef0eb;background:rgba(250,255,63,.06);text-align:left;font:10px ui-monospace,monospace;letter-spacing:.08em}.aic-settings-back{position:absolute;bottom:24px;left:22px;padding:9px 13px;border:1px solid rgba(255,255,255,.17);border-radius:0;color:rgba(238,240,235,.7);background:transparent;cursor:pointer}.aic-settings-main{padding:28px 38px 60px;overflow:auto;background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:42px 42px}.aic-settings-title{margin:0 0 6px;color:#f4f5f0;font:500 28px/1.2 inherit}.aic-settings-sub{margin:0 0 28px;color:rgba(238,240,235,.35);font:9px ui-monospace,monospace;letter-spacing:.1em}.aic-settings-main .prts-settings-wrap{max-width:1040px}.aic-settings-main .prts-settings-wrap>div{border-radius:0!important;border-color:rgba(255,255,255,.13)!important;background:rgba(8,10,12,.9)!important}.aic-settings-main .prts-settings-wrap h3{color:var(--acid);font:700 11px ui-monospace,monospace!important;letter-spacing:.1em}.aic-settings-main :is(button,input,select){border-radius:0!important}.aic-settings-main button{color:#e9ebe5!important}.aic-settings-main button[style*="button-info-fill"]{color:#080a0c!important}.aic-settings-main .prts-skin-option[aria-pressed="true"]{border-color:var(--acid)!important;box-shadow:inset 3px 0 var(--acid)!important}
      .aic-region-label{position:absolute;z-index:4;display:flex;align-items:center;gap:7px;padding:7px 10px;color:#f1f2ed;background:rgba(7,9,10,.73);border:1px solid rgba(255,255,255,.12);font:700 9px ui-monospace,monospace;pointer-events:none}.aic-region-label i{width:6px;height:6px;background:var(--acid)}.aic-region-label small{color:rgba(238,240,235,.35)}
      @keyframes aic-root-in{from{opacity:0}to{opacity:1}}@keyframes aic-msg-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}@keyframes aic-drawer-in{from{opacity:0;transform:translateX(-18px)}to{opacity:1;transform:none}}@keyframes aic-blink{50%{opacity:.25}}
      @media(max-width:980px){.aic-chat-band{width:min(720px,100vw);padding-top:92px}.aic-chat-resize{display:none}.aic-hud-br{display:none}.aic-settings-layer{grid-template-columns:190px minmax(0,1fr)}.aic-settings-main{padding:24px 20px}.aic-brand-sub,.aic-coords span:nth-child(n+2){display:none}}
      @media(max-width:680px){.aic-chat-band{padding:84px 10px 10px}.aic-band-backdrop{right:-80px}.aic-hud-tr{right:10px}.aic-settings-layer{display:block}.aic-settings-nav{height:112px;padding:18px}.aic-settings-nav p,.aic-settings-tab,.aic-settings-nav::after{display:none}.aic-settings-back{right:18px;bottom:auto;left:auto;top:20px}.aic-settings-main{position:absolute;inset:112px 0 0}.aic-msg-body{font-size:13px}.prts-skin-options{grid-template-columns:1fr}}
      @media(prefers-reduced-motion:reduce){.aic-root,.aic-msg,.aic-drawer,.aic-settings-layer{animation:none!important}}
    `

    const installScene = () => {
      if (typeof document === 'undefined') return () => {}
      const scene = document.createElement('div')
      scene.id = 'prts-agent-scene'
      scene.className = 'prts-agent-scene'
      scene.setAttribute('aria-hidden', 'true')
      scene.innerHTML = SCENE_HTML
      document.body.prepend(scene)
      const replayCpu = (forcePurple = false) => {
        const cpu = scene.querySelector('.prts-cpu-assembly')
        if (!cpu) return
        const replacement = cpu.cloneNode(true)
        replacement.classList.toggle('is-purple', forcePurple || Math.random() < .05)
        cpu.replaceWith(replacement)
      }
      let cpuDebugBuffer = ''
      const handleCpuDebugKeydown = (event) => {
        const target = event.target
        if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey
          || (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]'))) {
          cpuDebugBuffer = ''
          return
        }
        if (event.key.length !== 1) return
        cpuDebugBuffer = `${cpuDebugBuffer}${event.key.toLowerCase()}`.slice(-9)
        if (cpuDebugBuffer !== 'priestess') return
        cpuDebugBuffer = ''
        replayCpu(true)
      }
      globalThis.addEventListener('keydown', handleCpuDebugKeydown)
      if (Math.random() < .05) scene.querySelector('.prts-cpu-assembly')?.classList.add('is-purple')
      let frame = null
      let heroExitTimer = null
      let hasShownHero = false
      const stateFor = (names) => {
        const rows = names.flatMap((name) => [...document.querySelectorAll(`[data-tool="${name}"]`)])
        if (rows.some((row) => row.dataset.state === 'running')) return 'active'
        if (rows.some((row) => row.dataset.state === 'error')) return 'error'
        if (rows.length) return 'complete'
        return 'standby'
      }
      const setStage = (selector, value) => {
        const element = scene.querySelector(selector)
        if (!element || !value) return
        element.dataset.state = value.state
        const title = element.querySelector(':scope > b')
        const meta = element.querySelector(':scope > span')
        if (title) title.textContent = value.title
        if (meta) meta.textContent = value.meta
      }
      const setTrace = (selector, value) => {
        const element = scene.querySelector(selector)
        if (!element || !value) return
        element.dataset.state = value.state
        const lines = element.querySelectorAll(':scope > p > span')
        if (lines[0]) lines[0].textContent = value.text || value.title
        if (lines[1]) lines[1].textContent = value.scope || value.range
        const status = element.querySelector(':scope > b > strong')
        if (status) status.textContent = value.status
      }
      const applySnapshotModel = (model, search, read) => {
        if (!model) return
        const resolved = {
          ...model,
          recall: { ...model.recall, state: search === 'active' ? 'active' : model.recall.state },
          read: { ...model.read, state: read === 'active' ? 'active' : model.read.state },
          query: { ...model.query,
            state: search === 'active' ? 'active' : model.query.state,
            status: search === 'active' ? 'QUERYING RETRIEVAL SERVICE' : model.query.status },
          source: { ...model.source,
            state: read === 'active' ? 'active' : model.source.state,
            status: read === 'active' ? 'READING SOURCE CONTEXT' : model.source.status },
          verify: { ...model.verify,
            state: read === 'active' ? 'active' : model.verify.state,
            meta: read === 'active' ? '正在核对来源与主张' : model.verify.meta },
        }
        setStage('.prts-node-plan', resolved.plan)
        setStage('.prts-node-recall', resolved.recall)
        setStage('.prts-node-read', resolved.read)
        setStage('.prts-node-verify', resolved.verify)
        setTrace('.prts-trace-query', resolved.query)
        setTrace('.prts-trace-source', resolved.source)
        const stack = scene.querySelectorAll('.prts-trace-stack > span')
        resolved.stack.forEach((text, index) => { if (stack[index]) stack[index].textContent = text })
        const caption = scene.querySelector('.prts-system-caption > em')
        if (caption) caption.textContent = resolved.running ? 'ACTIVE' : resolved.tickerState
      }
      const sync = () => {
        frame = null
        const conversation = document.querySelector('[data-phase]:not(#prts-agent-scene)')
        const conversationRect = conversation?.getBoundingClientRect?.()
        if (conversationRect?.width > 0) {
          const shellOverlay = document.querySelector('[data-shell-overlay]')
          const shell = shellOverlay?.parentElement
          const sidebarRect = shell?.querySelector(':scope > div:nth-of-type(1)')?.getBoundingClientRect?.()
          const contentLeft = Math.max(conversationRect.left, sidebarRect?.right ?? 0)
          const contentRightEdge = conversationRect.right
          const contentCenter = contentLeft + (contentRightEdge - contentLeft) / 2
          scene.style.setProperty('--agent-content-left', `${contentLeft}px`)
          scene.style.setProperty('--agent-content-right', `${document.documentElement.clientWidth - contentRightEdge}px`)
          scene.style.setProperty('--agent-content-center', `${contentCenter}px`)

          // Harness 的 hero composer 在某些 shell 布局下仍以 viewport 为
          // 横轴。测量实际卡片中心并补偿到侧栏右侧内容列中心；把累计值
          // 写在 Conversation 上，后续侧栏拖宽/折叠不会来回振荡。
          const composerSeat = conversation.querySelector('[data-composer-seat]')
          const composerCard = conversation.querySelector('[data-composer-card]')
          const composerSeatRect = composerSeat?.getBoundingClientRect?.()
          const composerRect = composerCard?.getBoundingClientRect?.()
          if (composerRect?.width > 0) {
            const currentShift = Number.parseFloat(conversation.style.getPropertyValue('--prts-agent-composer-shift')) || 0
            const actualCenter = composerRect.left + composerRect.width / 2
            const nextShift = currentShift + contentCenter - actualCenter
            if (Math.abs(nextShift - currentShift) > .5) {
              conversation.style.setProperty('--prts-agent-composer-shift', `${nextShift}px`)
            }
          }

          // 原版 CPU 在 fixed system-map，字标在其下方的 hero 流中。
          // 当前场景是独立 overlay，因此用 SVG 的真实绘图 bbox 恢复两者
          // 至少 34px 的视觉间距，而不是继续猜一个固定 top。
          const cpu = scene.querySelector('.prts-cpu-assembly')
          const wordmark = scene.querySelector('.prts-hero-wordmark')
          const cpuRect = cpu?.getBoundingClientRect?.()
          const cpuBox = typeof cpu?.getBBox === 'function' ? cpu.getBBox() : null
          const wordmarkRect = wordmark?.getBoundingClientRect?.()
          if (cpuRect?.height > 0 && cpuBox && wordmarkRect?.height > 0) {
            const cpuArtBottom = cpuRect.top + ((cpuBox.y + cpuBox.height) / 410) * cpuRect.height
            const currentHeroTop = Number.parseFloat(scene.style.getPropertyValue('--agent-hero-top')) || 371
            const baseWordmarkTop = wordmarkRect.top - currentHeroTop + 371
            const nextHeroTop = 371 + Math.max(0, 34 - (baseWordmarkTop - cpuArtBottom))
            if (Math.abs(nextHeroTop - currentHeroTop) > .5) {
              scene.style.setProperty('--agent-hero-top', `${nextHeroTop}px`)
            }
          }

          // 欢迎文案和 Harness composer 属于两个独立定位层。垂直测量必须
          // 覆盖整个 seat（含工作区/模式工具栏），不能只测白色输入卡。
          // 文案下方至少留 44px，同时给整个 composer 底部保留 24px。
          // 用“去掉当前位移后的基准 top”计算，避免重复同步累加。
          const heroRect = scene.querySelector('.prts-empty-hero')?.getBoundingClientRect?.()
          if (conversation.dataset.phase === 'hero' && composerSeatRect?.height > 0 && heroRect?.height > 0) {
            const currentY = Number.parseFloat(
              conversation.style.getPropertyValue('--prts-agent-composer-y'),
            ) || 0
            const baseComposerTop = composerSeatRect.top - currentY
            const contentBottom = Math.min(document.documentElement.clientHeight, conversationRect.bottom)
            const wantedY = Math.max(0, heroRect.bottom + 44 - baseComposerTop)
            const maxY = Math.max(0, contentBottom - 24 - composerSeatRect.height - baseComposerTop)
            const nextY = Math.min(wantedY, maxY)
            if (Math.abs(nextY - currentY) > .5) {
              conversation.style.setProperty('--prts-agent-composer-y', `${nextY}px`)
            }
          }
        }
        // 场景本身也会写 data-phase；必须只读取 Harness Conversation，
        // 否则第一次写入 hero 后会永远读回自己，已有会话也不会退场。
        const phase = conversation?.dataset.phase ?? 'hero'
        const search = stateFor(['cloud_search', 'corpus_search', 'timeline_search'])
        const read = stateFor(['corpus_read'])
        if (phase === 'hero') {
          hasShownHero = true
          if (heroExitTimer !== null) clearTimeout(heroExitTimer)
          heroExitTimer = null
          scene.dataset.phase = 'hero'
        } else if (phase === 'active' && hasShownHero && scene.dataset.phase !== 'active') {
          scene.dataset.phase = 'leaving'
          if (heroExitTimer === null) {
            const reduceMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
            heroExitTimer = setTimeout(() => {
              heroExitTimer = null
              scene.dataset.phase = 'active'
            }, reduceMotion ? 0 : 760)
          }
        } else if (scene.dataset.phase !== 'leaving') {
          scene.dataset.phase = phase
        }
        scene.dataset.search = search
        scene.dataset.read = read
        applySnapshotModel(sceneSnapshotModel, search, read)
        const snapshotRunning = sceneSnapshotModel?.running === true
        scene.dataset.running = search === 'active' || read === 'active' || snapshotRunning ? 'true' : 'false'
        const ticker = scene.querySelector('.prts-system-ticker')
        const tickerLabel = ticker?.querySelector('span')
        const tickerState = ticker?.querySelector('i')
        if (tickerLabel) tickerLabel.textContent = read === 'active' ? '正在核验原文'
          : search === 'active' ? '正在检索候选'
            : sceneSnapshotModel?.ticker || (phase === 'active' ? '本地证据链' : '本地检索')
        if (tickerState) tickerState.textContent = scene.dataset.running === 'true'
          ? 'LIVE' : sceneSnapshotModel?.tickerState || (phase === 'active' ? 'DONE' : 'IDLE')
      }
      notifySceneSnapshot = () => schedule()
      const schedule = () => { if (frame == null) frame = requestAnimationFrame(sync) }
      globalThis.addEventListener('resize', schedule)
      const observer = new MutationObserver((records) => {
        // 更新场景自身的 dataset / ticker 也会产生 mutation；忽略这些回声，
        // 避免每帧重新同步。侧栏折叠和拖宽仍由外部节点变更触发。
        if (records.every((record) => record.target === scene || scene.contains(record.target))) return
        schedule()
      })
      observer.observe(document.body, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['data-state', 'data-phase', 'data-tool', 'data-sidebar-collapsed', 'style'] })
      sync()
      return () => {
        observer.disconnect()
        globalThis.removeEventListener('keydown', handleCpuDebugKeydown)
        globalThis.removeEventListener('resize', schedule)
        if (heroExitTimer !== null) clearTimeout(heroExitTimer)
        const conversation = document.querySelector('[data-phase]:not(#prts-agent-scene)')
        conversation?.style.removeProperty('--prts-agent-composer-shift')
        conversation?.style.removeProperty('--prts-agent-composer-y')
        if (frame != null) cancelAnimationFrame(frame)
        notifySceneSnapshot = () => {}
        scene.remove()
      }
    }

    // PRTS Agent 开机场（场景动画 + MutationObserver）只在对应皮肤下挂载；
    // harness / 终末地皮肤不承担这份常驻 DOM 与监听开销。
    const syncScene = () => {
      if (activeSkin === 'prts-agent') {
        if (!disposeScene) disposeScene = installScene()
      } else if (disposeScene) {
        disposeScene()
        disposeScene = null
      }
    }

    const SKIN_CSS = `
      body[data-prts-skin="agent"] {
        color-scheme: light;
        color: #111214;
        background: #fff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
          "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
      }
      body[data-prts-skin="agent"] > :has(> [data-shell-overlay]) { position: relative; z-index: 1; }
      .prts-agent-scene { position: fixed; z-index: 0; inset: 0; display: none; overflow: hidden;
        pointer-events: none; color: #34373b; background: #fff; }
      body[data-prts-skin="agent"] .prts-agent-scene { display: block; }
      .prts-scene-grid { position: absolute; inset: -92px -3vw -74px; opacity: .4;
        background-image: linear-gradient(rgba(36,39,42,.065) 1px,transparent 1px),linear-gradient(90deg,rgba(36,39,42,.065) 1px,transparent 1px);
        background-size: 88px 88px; mask-image: radial-gradient(ellipse 66% 68% at 50% 51%,#000 16%,transparent 78%); }
      .prts-scene-shard { position: absolute; }
      .prts-shard-dark { top: -5%; left: -2%; width: 43%; height: 108%; opacity: .84;
        background: linear-gradient(128deg,rgba(10,11,13,.98),rgba(31,34,38,.78) 48%,rgba(95,101,106,.12));
        clip-path: polygon(0 3%,78% 0,100% 38%,73% 100%,0 88%); }
      .prts-shard-dark::after { content:""; position:absolute; inset:12% -7% 7% 14%; opacity:.38;
        border:1px solid rgba(255,255,255,.18); background:repeating-linear-gradient(135deg,transparent 0 18px,rgba(255,255,255,.04) 19px 20px);
        clip-path:polygon(0 0,100% 14%,81% 100%,13% 81%); }
      .prts-shard-glass { top:-3%; right:9%; width:27%; height:58%; opacity:.48; border-left:1px solid rgba(98,104,110,.22);
        background:linear-gradient(143deg,rgba(255,255,255,.14),rgba(176,183,190,.32),rgba(255,255,255,.04));
        clip-path:polygon(25% 0,100% 0,79% 100%,0 71%); backdrop-filter:blur(3px); }
      .prts-shard-silver { right:-3%; bottom:-7%; width:49%; height:37%; opacity:.52;
        background:linear-gradient(154deg,rgba(226,229,226,.18),rgba(136,143,148,.38),rgba(250,250,248,.72));
        clip-path:polygon(19% 3%,100% 22%,100% 100%,0 100%); }
      .prts-scan-orbit { position:absolute; top:27%; left:32%; width:248px; height:248px; border:1px solid rgba(17,18,20,.12); border-radius:50%; opacity:.54; transform:translateX(-50%); }
      .prts-scan-orbit::before,.prts-scan-orbit::after,.prts-scan-orbit i { content:""; position:absolute; border:1px solid rgba(17,18,20,.12); border-radius:50%; }
      .prts-scan-orbit::before{inset:14px}.prts-scan-orbit::after{inset:31px}.prts-scan-orbit i:nth-child(1){inset:49px}.prts-scan-orbit i:nth-child(2){inset:66px}.prts-scan-orbit i:nth-child(3){inset:82px;background:rgba(17,18,20,.035)}
      .prts-scan-orbit i:nth-child(4){top:50%;left:-28px;width:274px;height:1px;border:0;border-top:1px solid rgba(17,18,20,.18);border-radius:0}
      .prts-scan-orbit>span{position:absolute;top:87px;left:78px;color:rgba(17,18,20,.44);font:8px/12px ui-monospace,monospace;letter-spacing:.08em}
      .prts-crosshair{position:absolute;width:17px;height:17px}.prts-crosshair::before,.prts-crosshair::after{content:"";position:absolute;background:rgba(17,18,20,.36)}
      .prts-crosshair::before{top:8px;left:0;width:17px;height:1px}.prts-crosshair::after{top:0;left:8px;width:1px;height:17px}.prts-crosshair i{position:absolute;inset:5px;border:1px solid rgba(17,18,20,.42);border-radius:50%}
      .prts-crosshair-a{top:10%;left:42%}.prts-crosshair-b{right:22%;bottom:12%;transform:scale(1.4)}
      .prts-ambient-type{position:absolute;top:7%;right:12%;color:rgba(17,18,20,.055);font:700 clamp(34px,4vw,58px)/.82 sans-serif;letter-spacing:-.06em;text-align:right}
      .prts-ambient-type strong{color:rgba(17,18,20,.1)}.prts-ambient-type small{position:absolute;top:-18px;right:0;color:rgba(17,18,20,.24);font:8px/12px ui-monospace,monospace;letter-spacing:.1em;white-space:nowrap}
      .prts-trace-window{position:absolute;width:208px;overflow:hidden;border:1px solid rgba(17,18,20,.16);color:rgba(36,39,43,.76);background:rgba(245,246,243,.67);box-shadow:0 12px 34px rgba(17,18,20,.07);font:8px/15px ui-monospace,monospace;text-align:left;backdrop-filter:blur(8px)}
      .prts-trace-window header{display:flex;align-items:center;justify-content:space-between;height:21px;padding:0 7px;color:rgba(255,255,255,.82);background:rgba(17,18,20,.78);letter-spacing:.06em}.prts-trace-window header i{width:5px;height:5px;border-radius:50%;background:#f0f1ee;box-shadow:-10px 0 rgba(255,255,255,.34)}
      .prts-trace-window p{margin:0;padding:3px 8px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.prts-trace-window p em{color:#8b9095;font-style:normal}.prts-trace-window b{display:flex;align-items:center;gap:5px;margin-top:4px;padding:4px 8px 6px;border-top:1px solid rgba(17,18,20,.08);color:rgba(17,18,20,.52);font-size:7px;font-weight:500;letter-spacing:.05em}.prts-trace-window b>i{width:4px;height:4px;border-radius:50%;background:#111214;animation:prts-trace-blink 1.4s ease-in-out infinite}.prts-trace-window b>strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:inherit}
      .prts-trace-query{top:18%;left:17%;transform:rotate(-1.5deg)}.prts-trace-source{top:25%;right:11%;transform:rotate(1deg)}
      .prts-trace-stack{position:absolute;bottom:47%;left:24%;display:grid;width:190px;color:rgba(255,255,255,.58);font:7px/18px ui-monospace,monospace}.prts-trace-stack span{margin-top:-1px;padding:0 7px;border:1px solid rgba(255,255,255,.12);background:rgba(17,18,20,.4)}.prts-trace-stack span:nth-child(2){transform:translateX(13px)}.prts-trace-stack span:nth-child(3){transform:translateX(28px)}
      .prts-system-node{position:absolute;width:185px;padding:10px 12px 11px;border-top:1px solid rgba(17,18,20,.38);color:#62666c;background:linear-gradient(110deg,rgba(255,255,255,.82),rgba(245,246,243,.24));text-align:left;backdrop-filter:blur(5px);transition:opacity .22s,filter .22s,box-shadow .22s}.prts-system-node::before{content:"";position:absolute;top:-3px;left:0;width:6px;height:6px;border-radius:50%;background:#72777c}.prts-system-node i{position:absolute;top:0;left:0;width:2px;height:100%;background:linear-gradient(rgba(17,18,20,.18),transparent)}.prts-system-node small,.prts-system-node b,.prts-system-node span{display:block}.prts-system-node small{font:7px/12px ui-monospace,monospace;letter-spacing:.08em}.prts-system-node b{margin-top:6px;color:#34373b;font-size:11px;line-height:16px}.prts-system-node span{margin-top:2px;color:#858a91;font-size:8px;line-height:13px}
      .prts-node-plan{top:9%;left:13%}.prts-node-recall{top:12%;right:4%}.prts-node-read{top:36%;left:14%}.prts-node-verify{top:38%;right:7%}
      .prts-system-caption{position:absolute;top:43%;left:40%;color:rgba(17,18,20,.35);font:7px/12px ui-monospace,monospace;letter-spacing:.08em}.prts-system-caption span{display:inline-block;width:28px;height:1px;margin-right:7px;background:rgba(17,18,20,.35);vertical-align:middle}.prts-system-caption em{margin-left:6px;font-style:normal}
      .prts-system-ticker{position:absolute;right:11%;top:50%;display:flex;align-items:center;gap:8px;width:min(380px,30vw);min-height:27px;padding:0 8px;border-block:1px solid rgba(17,18,20,.18);color:rgba(17,18,20,.42);font:7px/12px ui-monospace,monospace;letter-spacing:.04em}.prts-system-ticker b{color:#202327;font-size:8px}.prts-system-ticker span{flex:1}.prts-system-ticker i{padding:1px 4px;color:#fff;background:#111214;font-style:normal}
      .prts-cpu-assembly{position:absolute;top:8%;left:52%;width:min(560px,42vw);height:360px;opacity:.76;transform:translateX(-50%);transition:opacity .5s,transform .7s,filter .5s}.prts-cpu-board,.prts-cpu-lid{position:absolute;left:50%;width:210px;height:132px;transform:translateX(-50%) skewY(-27deg) rotate(30deg);border:1px solid #aeb2af;background:linear-gradient(145deg,#fdfdfb,#d7d9d5);box-shadow:0 18px 32px rgba(17,18,20,.14)}.prts-cpu-board{top:156px}.prts-cpu-board i{position:absolute;inset:33px 50px;border:1px solid #777d83;background:linear-gradient(145deg,#111214,#68717b);box-shadow:0 0 12px rgba(17,18,20,.28)}.prts-cpu-board b{position:absolute;inset:12px;border:1px solid rgba(120,125,126,.28)}.prts-cpu-lid{top:68px;width:154px;height:96px;animation:prts-cpu-open 1.45s cubic-bezier(.2,.78,.2,1) both}.prts-cpu-lid i{position:absolute;inset:24px;border:1px solid #c1c4c1}.prts-cpu-lines{position:absolute;top:218px;width:180px;height:80px;border-block:1px dashed #9da19f;opacity:.55}.prts-cpu-lines.left{left:0}.prts-cpu-lines.right{right:0}.prts-cpu-lines::after{content:"";position:absolute;top:38px;width:100%;border-top:1px dashed #9da19f}
      .prts-hero-identity{position:absolute;z-index:2;top:47%;left:50%;width:600px;transform:translateX(-50%);text-align:center;transition:opacity .45s,transform .6s,filter .45s}.prts-hero-identity>div{display:flex;align-items:center;justify-content:center;gap:10px}.prts-hero-p{display:grid;place-items:center;width:34px;height:34px;border-radius:9px;color:#fff;background:#111214;font:900 20px/1 ui-monospace,monospace;transform:skew(-5deg)}.prts-hero-identity strong{font-size:38px;letter-spacing:-.06em}.prts-hero-identity em{padding:2px 6px;border:1px solid rgba(17,18,20,.2);font:8px ui-monospace,monospace;font-style:normal}.prts-hero-identity small{display:block;margin-top:8px;color:#858a91;font:8px ui-monospace,monospace;letter-spacing:.09em}.prts-hero-identity h2{margin:26px 0 0;font-size:25px;letter-spacing:-.035em}.prts-hero-identity p{margin:8px 0 0;color:#62666c;font-size:13px}
      .prts-agent-scene[data-phase="active"] .prts-cpu-assembly{opacity:0;transform:translate(-50%,-120px) scale(.94);filter:blur(5px)}.prts-agent-scene[data-phase="active"] .prts-hero-identity{opacity:0;transform:translate(-50%,-30px) scale(.96);filter:blur(3px)}
      .prts-agent-scene[data-search="active"] :is(.prts-node-plan,.prts-node-recall,.prts-trace-query),.prts-agent-scene[data-read="active"] :is(.prts-node-read,.prts-node-verify,.prts-trace-source){opacity:1;filter:contrast(1.08);box-shadow:0 14px 38px rgba(17,18,20,.13),0 0 0 1px rgba(91,124,189,.22)}
      .prts-agent-scene[data-search="active"] :is(.prts-node-plan,.prts-node-recall)::before,.prts-agent-scene[data-read="active"] :is(.prts-node-read,.prts-node-verify)::before{background:#6f8fcd;box-shadow:0 0 0 4px rgba(91,124,189,.14),0 0 15px rgba(91,124,189,.42)}.prts-agent-scene[data-running="true"] .prts-system-ticker i{background:#6f8fcd;box-shadow:0 0 12px rgba(91,124,189,.38)}
      .prts-system-node[data-state="active"],.prts-trace-window[data-state="active"]{opacity:1;filter:contrast(1.08);box-shadow:0 14px 38px rgba(17,18,20,.13),0 0 0 1px rgba(91,124,189,.22)}
      .prts-system-node[data-state="active"]::before{background:#6f8fcd;box-shadow:0 0 0 4px rgba(91,124,189,.14),0 0 15px rgba(91,124,189,.42)}
      .prts-system-node[data-state="complete"]::before,.prts-trace-window[data-state="complete"] b>i{background:#3f9b68;box-shadow:0 0 0 3px rgba(63,155,104,.12)}
      .prts-system-node[data-state="complete"]{filter:contrast(1.03)}
      .prts-system-node[data-state="error"]::before,.prts-trace-window[data-state="error"] b>i{background:#c94b4b;box-shadow:0 0 0 3px rgba(201,75,75,.13)}

      body[data-prts-skin="agent"] :has(> [data-shell-overlay]) { position:relative;z-index:1;background:transparent!important; }
      body[data-prts-skin="agent"] :has(> [data-shell-overlay]) > div:nth-of-type(1) { border-right:1px solid rgba(255,255,255,.13)!important;
        background:linear-gradient(180deg,rgba(17,19,22,.94),rgba(37,40,43,.82) 64%,rgba(104,108,109,.58))!important;
        --dsw-alias-label-primary:#f7f7f4;--dsw-alias-label-secondary:#e2e3df;--dsw-alias-label-tertiary:#c1c5c6;--dsw-alias-label-caption:#969b9f;
        --dsw-alias-border-l1:rgba(255,255,255,.1);--dsw-alias-border-l2:rgba(255,255,255,.16);--dsw-alias-interactive-bg-hover:rgba(255,255,255,.08);
        --dsw-specific-sidebar-nav-item-hover:rgba(255,255,255,.08);--dsw-specific-sidebar-nav-item-active:rgba(255,255,255,.14); }
      body[data-prts-skin="agent"] :has(> [data-shell-overlay]) > div:nth-of-type(2),body[data-prts-skin="agent"] [data-phase],body[data-prts-skin="agent"] [data-conversation-scroll]{background:transparent!important}
      body[data-prts-skin="agent"] [data-slot="sidebar.brand.mark"]>* { display:none!important }
      body[data-prts-skin="agent"] [data-slot="sidebar.brand.mark"]::before { content:"P";display:grid;place-items:center;width:30px;height:30px;border-radius:9px;color:#fff;background:#111214;box-shadow:inset 0 -1px rgba(255,255,255,.12);font:900 18px/1 ui-monospace,monospace;transform:skew(-5deg) }
      body[data-prts-skin="agent"] [data-slot="sidebar.brand.name"]>* { display:none!important }
      body[data-prts-skin="agent"] [data-slot="sidebar.brand.name"] { display:block!important;flex:none!important;width:132px!important;min-width:132px!important;height:38px!important;overflow:visible!important;white-space:nowrap!important }
      body[data-prts-skin="agent"] span:has(> [data-slot="sidebar.brand.name"]),body[data-prts-skin="agent"] span:has(> span > [data-slot="sidebar.brand.name"]){height:38px!important;overflow:visible!important;align-items:center!important}
      body[data-prts-skin="agent"] [data-slot="sidebar.brand.name"]::before { content:"PRTS Agent";display:block;white-space:nowrap;color:#f7f7f4;font-size:15px;line-height:20px;font-weight:650;letter-spacing:0 }
      body[data-prts-skin="agent"] [data-slot="sidebar.brand.name"]::after { content:"剧情检索与原文核验";display:block;margin-top:1px;white-space:nowrap;color:#969b9f;font-size:10px;line-height:15px;font-weight:400;letter-spacing:0 }
      body[data-prts-skin="agent"] [data-slot="conversation.hero.brand.mark"]>*{display:none!important}body[data-prts-skin="agent"] [data-slot="conversation.hero.brand.mark"]::before{content:"P";display:grid;place-items:center;width:36px;height:36px;border-radius:10px;color:#fff;background:#111214;font:900 22px/1 ui-monospace,monospace;transform:skew(-5deg)}
      body[data-prts-skin="agent"] [data-phase="hero"] [data-conversation-scroll]{justify-content:flex-end!important;padding-bottom:14px}
      body[data-prts-skin="agent"] [data-phase="hero"] [data-conversation-scroll] div:has(> span > [data-slot="conversation.hero.brand.mark"]){visibility:hidden}
      body[data-prts-skin="agent"] [data-phase="hero"] [data-composer-seat]{width:100%;background:transparent!important}
      body[data-prts-skin="agent"] [data-phase="hero"] [data-composer-card]{background:rgba(255,255,255,.9)!important}
      body[data-prts-skin="agent"] [data-phase="active"]:not(#prts-agent-scene)>:first-child:not([data-conversation-scroll]){background:rgba(255,255,255,.74)!important;backdrop-filter:blur(16px);border-bottom-color:rgba(17,18,20,.08)!important}
      body[data-prts-skin="agent"] [data-phase="active"],body[data-prts-skin="agent"] [data-phase="active"] [data-conversation-scroll],body[data-prts-skin="agent"] [data-phase="active"] [data-conversation-scroll]>:not([data-composer-seat]){background:transparent!important}
      body[data-prts-skin="agent"] [data-phase="active"] [data-conversation-scroll]{position:relative;z-index:1}
      body[data-prts-skin="agent"] [data-chat-flow-kind="assistant-step"]:not([data-turn-process-member]){position:relative;padding-left:46px}
      body[data-prts-skin="agent"] [data-chat-flow-kind="assistant-step"]:not([data-turn-process-member])::before{content:"P";position:absolute;top:0;left:0;display:grid;place-items:center;width:30px;height:30px;border-radius:9px;color:#fff;background:#111214;font:900 17px/1 ui-monospace,monospace;transform:skew(-5deg);box-shadow:0 8px 22px rgba(17,18,20,.09)}
      body[data-prts-skin="agent"] [data-phase="active"]:not(#prts-agent-scene) [data-chat-flow]>[data-chat-flow-key]{animation:prts-chat-history-enter .3s cubic-bezier(.2,.72,.2,1) both}
      body[data-prts-skin="agent"] [data-chat-flow-kind="tool-call"] [data-tool]{border-radius:9px;transition:background .15s,color .15s}
      body[data-prts-skin="agent"] [data-chat-flow-kind="tool-call"] [data-tool]:hover{background:rgba(17,18,20,.035)}
      body[data-prts-skin="agent"] [data-tool][data-state="running"]{--dsw-alias-state-business-primary:#6f8fcd}
      body[data-prts-skin="agent"] [data-composer-seat]{background:linear-gradient(180deg,rgba(255,255,255,0) 0,rgba(255,255,255,.92) 38px)!important}
      body[data-prts-skin="agent"] [data-composer-card]{border-radius:18px!important;border-color:rgba(17,18,20,.11)!important;background:rgba(255,255,255,.88)!important;box-shadow:0 18px 50px rgba(17,18,20,.12),0 2px 8px rgba(17,18,20,.06)!important;backdrop-filter:blur(18px) saturate(.9)}
      .prts-header-badge{display:none;align-items:center;gap:7px;height:28px;padding:0 10px;border:1px solid rgba(17,18,20,.09);border-radius:15px;color:#62666c;background:rgba(255,255,255,.5);font:11px/1 inherit;cursor:pointer;backdrop-filter:blur(8px)}body[data-prts-skin="agent"] .prts-header-badge{display:inline-flex}.prts-header-badge:hover{color:#111214;background:rgba(255,255,255,.82)}.prts-header-badge i{width:6px;height:6px;border-radius:50%;background:#4ed17e;box-shadow:0 0 0 3px rgba(78,209,126,.12)}.prts-header-badge b{display:grid;place-items:center;min-width:16px;height:16px;padding:0 4px;border-radius:8px;color:#fff;background:#111214;font:8px/1 ui-monospace,monospace}
      .prts-evidence-layer{display:none}body[data-prts-skin="agent"] .prts-evidence-layer{display:block}.prts-evidence-scrim{position:fixed;z-index:80;inset:0;border:0;background:rgba(17,18,20,.2);backdrop-filter:blur(2px);animation:prts-fade-in .16s ease-out}.prts-evidence-drawer{position:fixed;z-index:81;top:0;right:0;bottom:0;width:min(430px,92vw);padding:22px;overflow:auto;color:#111214;background:rgba(249,250,247,.96);border-left:1px solid rgba(17,18,20,.12);box-shadow:-28px 0 70px rgba(17,18,20,.16);backdrop-filter:blur(22px);animation:prts-drawer-in .24s cubic-bezier(.2,.72,.2,1)}.prts-evidence-drawer>header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-bottom:17px;border-bottom:1px solid rgba(17,18,20,.12)}.prts-evidence-drawer h3{margin:0;font-size:19px;line-height:26px}.prts-evidence-drawer header p{margin:3px 0 0;color:#858a91;font:8px/13px ui-monospace,monospace;letter-spacing:.08em}.prts-evidence-close{width:30px;height:30px;border:1px solid rgba(17,18,20,.12);border-radius:50%;color:#34373b;background:#fff;cursor:pointer}.prts-evidence-list{display:grid;gap:10px;padding-top:16px}.prts-evidence-card{position:relative;padding:13px 14px 14px 39px;border:1px solid rgba(17,18,20,.1);background:rgba(255,255,255,.76);text-align:left;cursor:pointer}.prts-evidence-card::before{content:attr(data-index);position:absolute;top:14px;left:13px;color:#858a91;font:8px/12px ui-monospace,monospace}.prts-evidence-card:hover{border-color:rgba(40,105,216,.4);box-shadow:0 2px 10px rgba(40,105,216,.08)}.prts-evidence-card b{display:block;margin-bottom:6px;font:8px/12px ui-monospace,monospace;letter-spacing:.07em}.prts-evidence-card p{margin:0;color:#4c5055;font-size:11px;line-height:18px;white-space:pre-wrap}.prts-evidence-empty{padding:58px 20px;border:1px dashed rgba(17,18,20,.17);color:#858a91;text-align:center;font-size:12px;line-height:20px}
.prts-source-reader{position:fixed;z-index:81;top:0;right:0;bottom:0;width:min(560px,94vw);padding:22px;overflow:auto;color:#111214;background:rgba(249,250,247,.97);border-left:1px solid rgba(17,18,20,.12);box-shadow:-28px 0 70px rgba(17,18,20,.16);backdrop-filter:blur(22px);animation:prts-drawer-in .24s cubic-bezier(.2,.72,.2,1)}.prts-source-reader>header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-bottom:17px;border-bottom:1px solid rgba(17,18,20,.12)}.prts-source-reader h3{margin:0;font-size:18px;line-height:26px;word-break:break-word}.prts-source-reader header p{margin:3px 0 0;color:#858a91;font:8px/13px ui-monospace,monospace;letter-spacing:.08em}.prts-source-body{padding-top:14px}.prts-source-state{padding:52px 20px;color:#858a91;text-align:center;font-size:12px;line-height:20px}.prts-source-error{color:#b64444}.prts-source-line{display:flex;gap:9px;padding:3px 2px;line-height:1.7;font-size:12px;color:#34373b}.prts-source-line .prts-source-no{flex:none;width:30px;color:#9aa0a6;font:9px/1.7 ui-monospace,monospace;text-align:right}.prts-source-line .prts-source-speaker{flex:none;color:#8a5800;font-weight:500}.prts-source-line.narration{color:#5a5f66}.prts-source-line.active{background:rgba(40,105,216,.12);box-shadow:inset 2px 0 0 var(--agent-blue,#2869d8)}

      /* agent-demo 原版系统地图：尺寸、坐标和 SVG 动画直接迁移，只做命名隔离。 */
      .prts-agent-scene{--agent-content-left:260px;--agent-content-right:0px;--agent-content-center:calc(50% + 130px);--agent-hero-top:371px;--agent-mono:"SF Mono","JetBrains Mono","Fira Code",Consolas,"Liberation Mono",Menlo,"PingFang SC","Microsoft YaHei"}
      .prts-agent-scene::before{content:"";position:absolute;z-index:0;inset:0;background:radial-gradient(ellipse 46% 34% at 50% 42%,rgba(255,255,255,.98) 0 26%,rgba(255,255,255,.26) 68%,transparent 100%),radial-gradient(circle at 64% 30%,rgba(142,155,171,.13),transparent 28%),radial-gradient(circle at 35% 58%,rgba(193,197,191,.2),transparent 32%),linear-gradient(144deg,rgba(11,12,14,.94) 0,rgba(24,26,29,.82) 17%,rgba(105,109,111,.42) 35%,rgba(226,228,225,.14) 49%,transparent 66%),linear-gradient(124deg,rgba(226,228,224,.58),transparent 30% 68%,rgba(194,201,208,.46))}.prts-agent-scene::after{content:"";position:absolute;z-index:0;inset:0;opacity:.42;background:linear-gradient(112deg,transparent 0 19%,rgba(17,18,20,.035) 19.1% 19.25%,transparent 19.35% 71%,rgba(17,18,20,.025) 71.1% 71.25%,transparent 71.35%),linear-gradient(18deg,transparent 0 24%,rgba(255,255,255,.7) 24.1% 36%,transparent 36.1% 100%)}
      .prts-agent-scene .hero-system-map{position:fixed;z-index:0;top:0;left:50%;width:100vw;height:560px;pointer-events:none;transform:translateX(-50%)}
      .prts-agent-scene .prts-scene-grid{inset:-92px -3vw -74px;opacity:.4;background-size:88px 88px}
      .prts-agent-scene .prts-shard-dark{top:-42px;left:-2%;width:43%;height:590px;opacity:.72;background:linear-gradient(128deg,rgba(10,11,13,.96),rgba(31,34,38,.64) 46%,rgba(95,101,106,.08));clip-path:polygon(0 4%,80% 0,100% 38%,73% 100%,0 88%)}
      .prts-agent-scene .prts-shard-glass{top:-30px;right:9%;width:27%;height:430px}.prts-agent-scene .prts-shard-silver{right:-3%;bottom:-70px;width:42%;height:270px}
      .prts-agent-scene .prts-scan-orbit{z-index:1;top:215px;left:32%}.prts-agent-scene .prts-crosshair{z-index:1}.prts-agent-scene .prts-crosshair-a{top:82px;left:42%}.prts-agent-scene .prts-crosshair-b{right:22%;bottom:46px}
      .prts-agent-scene .prts-ambient-type{z-index:0;top:70px;right:13%;font:700 50px/.82 sans-serif}.prts-agent-scene .prts-trace-window{z-index:3}.prts-agent-scene .prts-trace-query{top:178px;left:17%}.prts-agent-scene .prts-trace-source{top:252px;right:12%}.prts-agent-scene .prts-trace-stack{z-index:2;bottom:44px;left:23%}.prts-agent-scene .prts-system-ticker{z-index:2;top:auto;right:17%;bottom:27px;width:auto;min-width:380px}
      .prts-agent-scene :is(.prts-system-node,.prts-trace-window){opacity:.58}.prts-agent-scene .prts-trace-stack span{opacity:.38}.prts-agent-scene[data-search="complete"] :is(.prts-node-plan,.prts-node-recall,.prts-trace-query),.prts-agent-scene[data-read="complete"] :is(.prts-node-read,.prts-node-verify,.prts-trace-source){opacity:.78}.prts-agent-scene[data-search="complete"] .prts-trace-stack span:nth-child(-n+2),.prts-agent-scene[data-read="complete"] .prts-trace-stack span:nth-child(3){opacity:.75;color:rgba(255,255,255,.86)}
      .prts-agent-scene .prts-cpu-assembly{position:absolute;z-index:2;top:86px;left:var(--agent-content-center);width:min(680px,45vw);height:auto;overflow:visible;opacity:.7;transform:translateX(-50%)}
      .prts-agent-scene .prts-circuit-lines{opacity:.5;stroke-width:1;stroke-dasharray:3 4;animation:prts-circuit-trace 5s linear infinite}.prts-agent-scene .prts-cpu-lid{position:static;width:auto;height:auto;border:0;background:none;box-shadow:none;transform-origin:316px 210px;animation:prts-cpu-lid-open 1.45s cubic-bezier(.2,.78,.2,1) both}.prts-agent-scene .prts-cpu-die-group{transform-origin:312px 206px;animation:prts-cpu-core-reveal 1.45s ease-out both}.prts-agent-scene .prts-assembly-guides{opacity:.56;animation:prts-guide-pulse 2.8s ease-in-out infinite}
      .prts-agent-scene .prts-cpu-assembly.is-purple #prts-cpu-die stop:nth-child(1){stop-color:#26143f}.prts-agent-scene .prts-cpu-assembly.is-purple #prts-cpu-die stop:nth-child(2){stop-color:#9b66d5}.prts-agent-scene .prts-cpu-assembly.is-purple #prts-cpu-die stop:nth-child(3){stop-color:#3f1e67}.prts-agent-scene .prts-cpu-assembly.is-purple .prts-cpu-die{stroke:#4f2b75;filter:drop-shadow(0 0 10px rgba(155,102,213,.72))}.prts-agent-scene .prts-cpu-assembly.is-purple .prts-cpu-die-highlight{fill:#d1a2ff;opacity:.58}
      .prts-agent-scene .prts-system-node{z-index:3;width:185px;padding:10px 12px 11px}.prts-agent-scene .prts-system-node::before{top:-4px;width:7px;height:7px;background:#111214;box-shadow:0 0 0 4px rgba(17,18,20,.07)}.prts-agent-scene .prts-system-node::after{content:"";position:absolute;top:-1px;width:clamp(32px,5vw,76px);border-top:1px solid rgba(17,18,20,.2)}.prts-agent-scene .prts-system-node i{top:18px;height:24px;animation:prts-node-scan 3s ease-in-out infinite}.prts-agent-scene .prts-system-node small{font:8px/13px var(--agent-mono)}.prts-agent-scene .prts-system-node b{margin-top:3px;font-size:12px;line-height:18px}.prts-agent-scene .prts-system-node span{margin-top:1px;font:9px/14px var(--agent-mono)}
      .prts-agent-scene .prts-node-plan{top:94px;left:13%}.prts-agent-scene .prts-node-read{top:350px;left:14.5%}.prts-agent-scene :is(.prts-node-plan,.prts-node-read)::before{right:-3px;left:auto}.prts-agent-scene :is(.prts-node-plan,.prts-node-read)::after{left:100%}.prts-agent-scene .prts-node-recall{top:116px;right:10%}.prts-agent-scene .prts-node-verify{top:372px;right:11%}.prts-agent-scene :is(.prts-node-recall,.prts-node-verify)::before{left:-3px}.prts-agent-scene :is(.prts-node-recall,.prts-node-verify)::after{right:100%}
      .prts-agent-scene .prts-system-caption{top:438px;left:var(--agent-content-center);display:flex;align-items:center;color:#8b8f94;font:8px/13px var(--agent-mono);letter-spacing:.11em;transform:translateX(-50%);white-space:nowrap}.prts-agent-scene .prts-system-caption span{position:absolute;right:calc(100% + 7px);width:38px}.prts-agent-scene .prts-system-caption em{color:#383c41}
      .prts-agent-scene .prts-empty-hero{position:fixed;z-index:2;top:var(--agent-hero-top);right:var(--agent-content-right);left:var(--agent-content-left);text-align:center;transition:opacity .58s ease,transform .72s cubic-bezier(.22,.8,.24,1),filter .58s ease}.prts-agent-scene .prts-hero-identity{position:relative;top:auto;left:auto;display:inline-flex;width:auto;transform:none;flex-direction:column;align-items:flex-start;text-align:left;filter:drop-shadow(0 2px 12px rgba(255,255,255,.95))}.prts-agent-scene .prts-hero-wordmark{position:relative;display:flex;align-items:flex-start}.prts-agent-scene .prts-hero-wordmark svg{display:block;width:clamp(250px,31vw,470px);height:auto}.prts-agent-scene .prts-hero-wordmark em{position:absolute;top:1px;left:calc(100% + 9px);padding:0 6px;border:1px solid rgba(17,18,20,.36);border-radius:2px;color:rgba(255,255,255,.88);background:rgba(17,18,20,.82);font:600 8px/16px var(--agent-mono);letter-spacing:.08em;white-space:nowrap}.prts-agent-scene .prts-hero-identity small{display:flex;align-items:center;gap:9px;margin-top:11px;color:#111214;font:9px/15px var(--agent-mono);letter-spacing:.035em}.prts-agent-scene .prts-hero-identity small s{color:#858a91;text-decoration-color:#f25a5a}.prts-agent-scene .prts-empty-hero h2{margin:16px 0 7px;font-size:26px;line-height:34px;font-weight:500;letter-spacing:-.4px}.prts-agent-scene .prts-empty-hero>p{max-width:600px;margin:0 auto;color:#62666c;font-size:14px;line-height:22px}
      .prts-agent-scene[data-phase="active"] .prts-empty-hero{opacity:0;transform:translateY(-34px) scale(.96);filter:blur(3px)}.prts-agent-scene[data-phase="active"] .prts-cpu-assembly{opacity:0;translate:0 -148px;transform:translateX(-50%);filter:blur(5px)}.prts-agent-scene[data-phase="active"] :is(.prts-trace-query,.prts-trace-source,.prts-trace-stack,.prts-node-plan,.prts-node-read,.prts-node-recall,.prts-node-verify,.prts-system-ticker){opacity:1}.prts-agent-scene[data-phase="active"] :is(.prts-trace-source,.prts-node-recall,.prts-node-verify,.prts-system-ticker){translate:7vw 8px}.prts-agent-scene[data-phase="active"] .prts-node-plan{opacity:.48}
      .prts-agent-scene[data-phase="leaving"] .prts-empty-hero{opacity:0;transform:translateY(-34px) scale(.96);filter:blur(3px)}.prts-agent-scene[data-phase="leaving"] .prts-cpu-assembly{opacity:0;translate:0 -118px;transform:translateX(-50%);filter:blur(4px)}.prts-agent-scene[data-phase="leaving"] :is(.prts-trace-query,.prts-trace-source,.prts-trace-stack,.prts-node-plan,.prts-node-read,.prts-node-recall,.prts-node-verify,.prts-system-ticker){opacity:1}.prts-agent-scene[data-phase="leaving"] :is(.prts-trace-source,.prts-node-recall,.prts-node-verify,.prts-system-ticker){translate:7vw 8px}.prts-agent-scene[data-phase="leaving"] .prts-node-plan{opacity:.48}
      body[data-prts-skin="agent"] :has(> [data-shell-overlay])>div:nth-of-type(1){background:rgba(250,250,247,.045)!important;box-shadow:none!important;backdrop-filter:none!important}
      body[data-prts-skin="agent"] :has(> [data-shell-overlay])>div:nth-of-type(1) :is(span,b,small,p,h1,h2,h3,label):not([role="dialog"] *){color:transparent!important;background:linear-gradient(180deg,rgba(250,250,247,.96) 0,rgba(250,250,247,.94) 49vh,rgba(20,22,25,.96) 49.08vh,rgba(20,22,25,.96) 76vh) fixed;background-clip:text;-webkit-background-clip:text}body[data-prts-skin="agent"] :has(> [data-shell-overlay])>div:nth-of-type(1) svg:not([role="dialog"] *){color:rgba(250,250,247,.92)!important;mix-blend-mode:difference}body[data-prts-skin="agent"] [data-slot="sidebar.brand.name"]::before,body[data-prts-skin="agent"] [data-slot="sidebar.brand.name"]::after{color:transparent;background:linear-gradient(180deg,rgba(250,250,247,.96) 0,rgba(250,250,247,.94) 49vh,rgba(20,22,25,.96) 49.08vh,rgba(20,22,25,.96) 76vh) fixed;background-clip:text;-webkit-background-clip:text}
      body[data-prts-skin="agent"] :has(> [data-shell-overlay])>div:nth-of-type(1) [role="dialog"]{--dsw-alias-label-primary:#111214;--dsw-alias-label-secondary:#34373b;--dsw-alias-label-tertiary:#62666c;--dsw-alias-label-caption:#858a91;--dsw-alias-border-l1:rgba(17,18,20,.08);--dsw-alias-border-l2:rgba(17,18,20,.13);--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#f4f4f1;--dsw-alias-bg-layer-2:#fff;--dsw-alias-bg-layer-3:#fff;--dsw-alias-interactive-bg-hover:rgba(17,18,20,.055);--dsw-specific-sidebar-nav-item-hover:rgba(17,18,20,.055);--dsw-specific-sidebar-nav-item-active:rgba(17,18,20,.095);color:#111214!important;background:#fff!important}
      body[data-prts-skin="agent"] :has(> [data-shell-overlay])>div:nth-of-type(1) [role="dialog"] :is(span,b,small,p,h1,h2,h3,label){color:inherit!important;background:none!important;background-clip:border-box!important;-webkit-background-clip:border-box!important;-webkit-text-fill-color:currentColor!important}body[data-prts-skin="agent"] :has(> [data-shell-overlay])>div:nth-of-type(1) [role="dialog"] svg{color:currentColor!important;mix-blend-mode:normal!important}
      body[data-prts-skin="agent"] :has(> [data-shell-overlay])>div:nth-of-type(1) button:is([aria-label="新会话"],[aria-label="新建会话"],[aria-label="New chat"],[aria-label="New session"],[aria-label="New conversation"]):has(>svg){border-color:rgba(255,255,255,.1)!important;color:#f7f7f4!important;background:rgba(255,255,255,.1)!important}
      /* DSH 会话行保持原生单行 flex 语义。过去强制改成两行 grid 会把状态
         的 screen-reader 文本挤回可视区，形成标题与“进行中”重叠。 */
      body[data-prts-skin="agent"] div[role="treeitem"][aria-selected]:has(>span:nth-child(4)){position:relative;display:flex!important;align-items:center!important;gap:0!important;box-sizing:border-box;height:44px!important;margin:3px 0!important;padding:6px 10px!important;border-radius:12px!important}
      body[data-prts-skin="agent"] div[role="treeitem"][aria-selected]:has(>span:nth-child(4))>span:nth-child(1){flex:none!important;width:18px!important;height:22px!important;margin-right:5px!important;align-items:center!important;justify-content:center!important}
      body[data-prts-skin="agent"] div[role="treeitem"][aria-selected]:has(>span:nth-child(4))>span:nth-child(1)>span:not([data-state]){position:absolute!important;width:1px!important;height:1px!important;margin:-1px!important;padding:0!important;overflow:hidden!important;clip:rect(0 0 0 0)!important;clip-path:inset(50%)!important;white-space:nowrap!important}
      body[data-prts-skin="agent"] div[role="treeitem"][aria-selected]:has(>span:nth-child(4))>span:nth-child(2){flex:1!important;min-width:0;margin:0 8px 0 0!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important;font-size:14px!important;line-height:22px!important;font-weight:600!important}
      body[data-prts-skin="agent"] div[role="treeitem"][aria-selected]:has(>span:nth-child(4))>span:nth-child(3){flex:none!important;max-width:64px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px!important;line-height:20px!important}
      body[data-prts-skin="agent"] div[role="treeitem"][aria-selected]:has(>span:nth-child(4))>span:nth-child(4){position:static!important;flex:none!important;height:24px!important;align-items:center!important}
      body[data-prts-skin="agent"] [data-phase="hero"] [data-composer-seat]{position:absolute;right:0;bottom:228px;left:0;padding:0!important;translate:var(--prts-agent-composer-shift,0px) var(--prts-agent-composer-y,0px)}

      .prts-settings-wrap { --prts-accent: var(--dsw-alias-state-business-primary); }
      .prts-skin-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
      .prts-skin-option { position: relative; min-height: 104px; padding: 12px; overflow: hidden;
        border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px;
        color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
        text-align: left; cursor: pointer; transition: border-color .18s, background .18s, transform .18s; }
      .prts-skin-option:hover { transform: translateY(-1px); border-color: var(--prts-accent); }
      .prts-skin-option[aria-pressed="true"] { border-color: var(--prts-accent);
        box-shadow: inset 0 0 0 1px var(--prts-accent); }
      .prts-skin-option strong, .prts-skin-option small { position: relative; z-index: 2; display: block; }
      .prts-skin-option strong { font-size: 13px; font-weight: 650; }
      .prts-skin-option small { margin-top: 4px; color: var(--dsw-alias-label-caption); font-size: 11px; }
      .prts-skin-swatch { position: absolute; right: -12px; bottom: -20px; width: 124px; height: 88px;
        border: 1px solid rgba(17,18,20,.12); background: #fff; transform: rotate(-7deg); }
      .prts-skin-swatch::before { content: ""; position: absolute; inset: 0 72% 0 0; background: #f2f2ee; }
      .prts-skin-swatch::after { content: ""; position: absolute; inset: 18px 11px 16px 43px;
        border-top: 2px solid #2869d8; border-bottom: 1px solid rgba(17,18,20,.12);
        background: repeating-linear-gradient(180deg, transparent 0 10px, rgba(17,18,20,.08) 10px 11px); }
      .prts-skin-swatch.prts { background: linear-gradient(145deg, #111214 0 24%, #aeb2b2 24.5% 42%, #fff 63%); }
      .prts-skin-swatch.prts::before { background: rgba(250,250,247,.2); border-right: 1px solid rgba(255,255,255,.2); }
      .prts-skin-swatch.prts::after { border-top-color: #111214; background: rgba(255,255,255,.68); }
      .prts-skin-swatch.endfield { background:radial-gradient(circle at 72% 42%,rgba(250,255,63,.18),transparent 26%),linear-gradient(145deg,#080a0c 0 54%,#22282c 54.5% 100%);-webkit-mask-image:linear-gradient(135deg,transparent 42%,#000 68%);mask-image:linear-gradient(135deg,transparent 42%,#000 68%) }
      .prts-skin-swatch.endfield::before { background:rgba(8,10,12,.84);border-right:1px solid rgba(250,255,63,.34); }
      .prts-skin-swatch.endfield::after { border:1px solid rgba(250,255,63,.42);border-left:3px solid #faff3f;background:rgba(10,12,14,.86); }
      .prts-skin-note { margin: 9px 0 0; color: var(--dsw-alias-label-caption); font-size: 11px; line-height: 1.55; }
      @keyframes prts-trace-blink{0%,100%{opacity:.28}50%{opacity:1;box-shadow:0 0 0 3px rgba(17,18,20,.08)}}
      @keyframes prts-cpu-open{0%,17%{transform:translateX(-50%) translateY(88px) skewY(-27deg) rotate(30deg) scale(.96)}58%{transform:translateX(-50%) translateY(-12px) skewY(-27deg) rotate(30deg) scale(1.015)}100%{transform:translateX(-50%) skewY(-27deg) rotate(30deg)}}
      @keyframes prts-fade-in{from{opacity:0}to{opacity:1}}@keyframes prts-drawer-in{from{transform:translateX(26px);opacity:0}to{transform:translateX(0);opacity:1}}
      @keyframes prts-chat-history-enter{from{opacity:0;translate:0 6px}to{opacity:1;translate:0 0}}
      @keyframes prts-cpu-lid-open{0%,17%{transform:translateY(101px) scale(.96)}58%{transform:translateY(-12px) scale(1.015)}76%{transform:translateY(4px) scale(.995)}100%{transform:translateY(0) scale(1)}}@keyframes prts-cpu-core-reveal{0%,27%{opacity:.12;transform:scale(.9);filter:brightness(.7)}64%{opacity:1;transform:scale(1.035);filter:brightness(1.18)}100%{opacity:1;transform:scale(1);filter:none}}@keyframes prts-guide-pulse{0%,100%{opacity:.32}50%{opacity:.78}}@keyframes prts-circuit-trace{to{stroke-dashoffset:-28}}@keyframes prts-node-scan{0%,100%{opacity:.2;transform:scaleY(.45)}50%{opacity:.9;transform:scaleY(1)}}
      @media (max-width:900px){.prts-agent-scene :is(.prts-trace-window,.prts-system-node,.prts-trace-stack,.prts-system-ticker,.prts-ambient-type){opacity:.25}.prts-cpu-assembly{width:70vw;left:58%}.prts-hero-identity{width:min(600px,80vw);left:58%}}
      @media (max-width:680px){.prts-shard-dark{width:72%}.prts-agent-scene :is(.prts-trace-window,.prts-system-node,.prts-trace-stack,.prts-system-ticker,.prts-scan-orbit){display:none}.prts-hero-identity{left:50%;width:88vw}.prts-cpu-assembly{left:50%;width:90vw;opacity:.45}body[data-prts-skin="agent"] [data-chat-flow-kind="assistant-step"]:not([data-turn-process-member]){padding-left:38px}body[data-prts-skin="agent"] [data-chat-flow-kind="assistant-step"]:not([data-turn-process-member])::before{width:26px;height:26px;font-size:15px}.prts-skin-options{grid-template-columns:1fr}}
      @media (prefers-reduced-motion:reduce){.prts-agent-scene *,body[data-prts-skin="agent"] [data-chat-flow]>[data-chat-flow-key]{animation:none!important;transition:none!important}}
    `
    const ENDPOINTS = Object.freeze({
      '/status': 'status', '/releases': 'releases', '/check-update': 'check-update',
      '/config:GET': 'config.get', '/config:PUT': 'config.update',
      '/download': 'download', '/activate': 'activate', '/delete': 'delete',
    })
    const jsonFetch = async (path, init = {}) => {
      if (!callApi) throw new Error('PRTS Connection 尚未就绪')
      const method = init.method ?? 'GET'
      const endpoint = ENDPOINTS[`${path}:${method}`] ?? ENDPOINTS[path]
      if (!endpoint) throw new Error(`未知 PRTS 操作 ${method} ${path}`)
      const payload = init.body ? JSON.parse(init.body) : {}
      return callApi(endpoint, payload)
    }
    const loadConfiguredSkin = async () => {
      let resolved = null
      if (typeof fetch === 'function') {
        try {
          const response = await fetch('/prts-corpus/ui-skin.json', { cache: 'no-store' })
          if (response.ok) resolved = setSkin((await response.json())?.uiSkin)
        } catch (error) { console.error('[prts-terrarchive] skin endpoint activation failed', error) }
      }
      if (resolved === null) {
        try {
          const status = await jsonFetch('/status')
          resolved = setSkin(status?.config?.uiSkin)
        } catch (error) {
          // 配置通道失败时立即撤下开机场，回退到当前界面，绝不能把 boot 屏留在原地。
          aicBootAbort()
          throw error
        }
      }
      // 缓存到 localStorage，下次启动可在插件装载阶段同步接管启动屏。
      try { if (resolved) localStorage.setItem(AIC_BOOT_KEY, resolved) } catch { /* 忽略 */ }
      if (resolved !== 'endfield-aic') aicBootAbort()
      return resolved
    }

    /* ---- 证据抽取：优先走会话快照（不依赖视图 DOM），DOM 抓取仅作回退 ---- */

    const rowText = (row) => String(row.textContent ?? '').replace(/\s+/g, ' ').trim()

    /** 一条 corpus_read 模型投影 → 人类可读标题与引用范围。 */
    const rememberReadBlock = (byTitle, full) => {
      const titleMatch = full.match(/#\s+(.+?)\s+(?:范围：|字段：)/u)
      const citationMatch = full.match(/引用：《([^》]+)》(?:第\s*(\d+)(?:[-–](\d+))?\s*行|Wiki)/u)
      const title = String(citationMatch?.[1] || titleMatch?.[1] || '').replace(/\s+/g, ' ').trim()
      if (!title) return
      const lineStart = citationMatch?.[2] ? Number(citationMatch[2]) : null
      const lineEnd = citationMatch?.[3] ? Number(citationMatch[3]) : lineStart
      const excerpt = full.slice(0, 260)
      if (!byTitle.has(title)) {
        byTitle.set(title, { title, lineStart, lineEnd, excerpt })
      }
    }

    /**
     * 会话快照版（首选）：tool-call 节点的 tool-result 带 renderRead 全文，
     * 最后一条含正文的 assistant-step 是引用解析对象。与当前挂载的是哪个
     * 会话视图（chat / trajectory）无关。
     */
    const collectSnapshotEvidence = (order, nodes) => {
      const byTitle = new Map()
      let lastAnswer = ''
      if (!Array.isArray(order) || !nodes) return { byTitle, lastAnswer }
      for (const key of order) {
        const node = typeof nodes.get === 'function' ? nodes.get(key) : null
        if (!node) continue
        if (node.kind === 'tool-call') {
          const root = node.data?.root
          if (root?.kind !== 'tool-result' || root.call?.name !== 'corpus_read') continue
          const full = contentText(root.content).replace(/\s+/g, ' ').trim()
          if (full.includes('引用：《')) rememberReadBlock(byTitle, full)
        } else if (node.kind === 'assistant-step') {
          const text = assistantParts(node.data?.blocks).text
          if (text) lastAnswer = String(text).replace(/\s+/g, ' ').trim()
        }
      }
      return { byTitle, lastAnswer }
    }

    /** DOM 版（回退）：轨迹视图 tr[data-kind="tool"] 与默认会话视图 [data-tool="corpus_read"] 都要覆盖。 */
    const collectDomEvidence = () => {
      const byTitle = new Map()
      if (typeof document === 'undefined') return { byTitle, lastAnswer: '' }
      for (const row of document.querySelectorAll('tr[data-kind="tool"]')) {
        const full = rowText(row)
        if (full.includes('corpus_read') && full.includes('引用：《')) rememberReadBlock(byTitle, full)
      }
      for (const row of document.querySelectorAll('[data-tool="corpus_read"]')) {
        const full = rowText(row)
        if (full.includes('引用：《')) rememberReadBlock(byTitle, full)
      }
      let lastAnswer = ''
      const answerRows = [...document.querySelectorAll('tr[data-kind="message"]')]
        .filter((row) => /ASSISTANT/i.test(row.querySelector('td[class*="event"]')?.textContent ?? ''))
      if (answerRows.length) lastAnswer = rowText(answerRows.at(-1))
      else {
        const steps = [...document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')]
          .map((node) => rowText(node))
          .filter((text) => text && !text.includes('引用：《'))
        if (steps.length) lastAnswer = steps.at(-1)
      }
      return { byTitle, lastAnswer }
    }

    /** 由读取映射 + 最后一条回答计算证据卡：只取回答真正引用的主要参考资料。 */
    const buildEvidence = ({ byTitle, lastAnswer }) => {
      // 「标题 → 文档」解析：优先精确匹配完整展示标题；回答可能用简写（如《黄金三角》），
      // 仅在唯一命中且非泛指词时做包含匹配，避免《行动前》这类短词误命中多篇。
      const resolveTitle = (raw) => {
        const title = String(raw ?? '').replace(/\s+/g, ' ').trim()
        if (byTitle.has(title)) return { title, ...byTitle.get(title) }
        if (title.length < 3) return null
        const candidates = [...byTitle.keys()].filter((key) => key.length >= title.length && key.includes(title))
        if (candidates.length !== 1) return null
        const key = candidates[0]
        return { title: key, ...byTitle.get(key) }
      }
      const cited = new Map()
      // 行内可溯源引用：《标题》…第 N(-M)? 行。
      for (const m of lastAnswer.matchAll(/《([^》]+)》[^。；\n]{0,40}?第\s*(\d+)(?:\s*[-—–~]\s*(\d+))?\s*行/g)) {
        const hit = resolveTitle(m[1])
        if (!hit) continue
        const lineStart = Number(m[2])
        const lineEnd = m[3] ? Number(m[3]) : lineStart
        cited.set(hit.title, { ...hit, lineStart, lineEnd })
      }
      // 其余《标题》引用（如「主要参考资料」清单），一并纳入。
      for (const m of lastAnswer.matchAll(/《([^》]+)》/g)) {
        const hit = resolveTitle(m[1])
        if (hit && !cited.has(hit.title)) cited.set(hit.title, { ...hit, lineStart: hit.lineStart, lineEnd: hit.lineEnd })
      }
      // 回答里没有可映射引用时，回退到已读取的工具行，避免证据面板空置。
      const used = cited.size ? cited : new Map(byTitle)
      const seen = new Set()
      let index = 0
      return [...used.values()].map((item) => {
        const signature = [item.documentId, item.lineStart, item.title].join('|') || `source-${++index}`
        if (seen.has(signature)) return null
        seen.add(signature)
        return { id: `${index}-${signature.slice(0, 24)}`, title: item.title, kind: 'story',
          documentId: item.documentId, sourceRef: item.documentId ? `${item.documentId}:L${item.lineStart || 1}` : '',
          lineStart: item.lineStart, lineEnd: item.lineEnd,
          excerpt: item.excerpt || '已在回答中引用该资料，点开查看全文。' }
      }).filter(Boolean)
    }

    const readEvidenceFromPage = () => buildEvidence(collectDomEvidence())

    // 点开证据卡 → 读全文：复用与 corpus_read 工具一致的 read RPC。
    async function readEvidenceSource(item) {
      const locator = item.title ? { display_title: item.title } : null
      if (!locator) throw new Error('该证据缺少可读取的自然语言标题')
      const result = await callApi('read', { locator, selection: { mode: 'document' },
        max_lines: 500, max_chars: 100000 })
      if (!result?.ok || result?.error) throw new Error(result?.error?.message || '无法读取原文')
      return result.response
    }

    function SourceReader({ item, onClose }) {
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [lines, setLines] = useState([])
      useEffect(() => {
        let active = true
        setLoading(true); setError('')
        readEvidenceSource(item).then((response) => {
          if (!active) return
          if (response.status !== 'ok') throw new Error(response.error?.message || '读取失败')
          const pageLines = (response?.content?.lines || [])
          setLines(pageLines.map((line) => ({
            line_number: line.line_number, speaker_raw: line.speaker_raw,
            text: line.text, source_ref: line.source_ref,
          })))
        }).catch((err) => { if (active) setError(err.message || '读取失败') })
          .finally(() => { if (active) setLoading(false) })
        const close = (event) => { if (event.key === 'Escape') onClose() }
        document.addEventListener('keydown', close)
        return () => { active = false; document.removeEventListener('keydown', close) }
      }, [item])
      return h('div', { className: 'prts-evidence-layer' },
        h('button', { type: 'button', className: 'prts-evidence-scrim', onClick: onClose,
          'aria-label': '关闭原文查看器' }),
        h('aside', { className: 'prts-source-reader', role: 'dialog', 'aria-modal': 'true',
          'aria-label': `原文：${item.title}` },
        h('header', null,
          h('div', null, h('h3', null, item.title),
            h('p', null, 'LOCAL CORPUS / SOURCE READER')),
          h('button', { type: 'button', className: 'prts-evidence-close', onClick: onClose,
            'aria-label': '关闭' }, '×')),
        h('div', { className: 'prts-source-body' },
          loading && h('div', { className: 'prts-source-state' }, '正在读取原文…'),
          error && h('div', { className: 'prts-source-state prts-source-error' }, error),
          !loading && !error && lines.length === 0 && h('div', { className: 'prts-source-state' },
            '该资料没有可展示的正文。'),
          !loading && !error && lines.map((line) => h('p', {
            className: [
              'prts-source-line', line.speaker_raw ? '' : 'narration',
              item.lineStart && line.line_number === item.lineStart ? 'active' : '',
            ].filter(Boolean).join(' '),
            key: `${line.line_number}-${line.source_ref || ''}`,
          },
          h('span', { className: 'prts-source-no' }, String(line.line_number)),
          line.speaker_raw && h('span', { className: 'prts-source-speaker' }, line.speaker_raw),
          line.text)))))
    }

    function EvidenceControl({ useChat }) {
      const [open, setOpen] = useState(false)
      const [reader, setReader] = useState(null)
      // 首选会话快照（useChat 是 session 槽位的标准 prop，ui-chat 组合必给）；
      // 拿不到时回退 DOM 抓取 + MutationObserver。
      const snapshotOrder = useChat ? useChat((snapshot) => snapshot?.order ?? []) : null
      const snapshotNodes = useChat ? useChat((snapshot) => snapshot?.nodes ?? null) : null
      const sceneRevision = useChat ? useChat(sceneSnapshotSignature) : ''
      const sceneModel = useMemo(() => (useChat
        ? buildSceneSnapshotModel(snapshotOrder, snapshotNodes)
        : null), [snapshotOrder, snapshotNodes, sceneRevision])
      const [domEvidence, setDomEvidence] = useState([])
      useEffect(() => {
        sceneSnapshotModel = sceneModel
        notifySceneSnapshot()
        return () => {
          if (sceneSnapshotModel !== sceneModel) return
          sceneSnapshotModel = null
          notifySceneSnapshot()
        }
      }, [sceneModel])
      useEffect(() => {
        if (useChat || typeof document === 'undefined') return undefined
        let timer = null
        const sync = () => {
          timer = null
          const next = readEvidenceFromPage()
          const signature = JSON.stringify(next)
          setDomEvidence((previous) => JSON.stringify(previous) === signature ? previous : next)
        }
        const schedule = () => {
          if (timer == null) timer = setTimeout(sync, 80)
        }
        const observer = new MutationObserver(schedule)
        observer.observe(document.body, { childList: true, subtree: true, characterData: true,
          attributes: true, attributeFilter: ['data-state', 'data-tool'] })
        sync()
        return () => { observer.disconnect(); if (timer != null) clearTimeout(timer) }
      }, [])
      const evidence = useMemo(() => (useChat
        ? buildEvidence(collectSnapshotEvidence(snapshotOrder, snapshotNodes))
        : domEvidence), [snapshotOrder, snapshotNodes, domEvidence])
      useEffect(() => {
        if (!open && !reader || typeof document === 'undefined') return undefined
        const close = (event) => { if (event.key === 'Escape') { if (reader) setReader(null); else setOpen(false) } }
        document.addEventListener('keydown', close)
        return () => document.removeEventListener('keydown', close)
      }, [open, reader])
      return h(Fragment, null,
        h('button', { type: 'button', className: 'prts-header-badge', onClick: () => setOpen(true),
          title: '查看本轮本地资料读取记录', 'aria-expanded': open },
        h('i'), '证据', h('b', null, String(evidence.length))),
        reader && h('div', { className: 'prts-evidence-layer' },
          h(SourceReader, { item: reader, onClose: () => setReader(null) })),
        open && !reader && h('div', { className: 'prts-evidence-layer' },
          h('button', { type: 'button', className: 'prts-evidence-scrim', onClick: () => setOpen(false),
            'aria-label': '关闭证据面板' }),
          h('aside', { className: 'prts-evidence-drawer', role: 'dialog', 'aria-modal': 'true',
            'aria-label': '本轮证据' },
          h('header', null,
            h('div', null, h('h3', null, '本轮证据'), h('p', null, 'LOCAL CORPUS / SOURCE READ TRACE')),
            h('button', { type: 'button', className: 'prts-evidence-close', onClick: () => setOpen(false),
              'aria-label': '关闭' }, '×')),
          h('div', { className: 'prts-evidence-list' }, evidence.length
            ? evidence.map((item, index) => h('button', {
              type: 'button', className: 'prts-evidence-card', key: item.id,
              'data-index': String(index + 1).padStart(2, '0'),
              onClick: () => setReader(item), title: item.documentId
                ? `点击阅读全文（${item.documentId}）` : '点击阅读全文',
            },
            h('b', null, 'CORPUS_READ · VERIFIED'), h('p', null, item.excerpt)))
            : h('div', { className: 'prts-evidence-empty' }, '本轮还没有读取本地原文。\n检索并读取资料后，证据卡会出现在这里。')))))
    }

    const fmtBytes = (bytes) => {
      if (!Number.isFinite(bytes)) return '—'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
      if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`
      return `${(bytes / 1073741824).toFixed(2)} GB`
    }
    const shortVersion = (value) => (value ? `${String(value).slice(0, 12)}…` : '—')
    const fmtDate = (value) => {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /* ---- 内联样式 ---- */
    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '16px', fontSize: '13px' },
      card: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px',
        padding: '14px 16px', background: 'var(--dsw-alias-bg-layer-1)' },
      cardTitle: { fontWeight: 600, margin: '0 0 10px', fontSize: '13px' },
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', margin: '4px 0' },
      key: { opacity: 0.65, minWidth: '96px', flex: '0 0 auto' },
      val: { fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' },
      badge: { padding: '1px 8px', borderRadius: '999px', fontSize: '11px', flex: '0 0 auto',
        background: 'var(--dsw-alias-state-business-tertiary)', color: 'var(--dsw-alias-state-business-primary)' },
      badgeGray: { padding: '1px 8px', borderRadius: '999px', fontSize: '11px', flex: '0 0 auto',
        background: 'rgba(128,128,128,.18)', color: '#999' },
      badgeGreen: { padding: '1px 8px', borderRadius: '999px', fontSize: '11px', flex: '0 0 auto',
        background: 'var(--dsw-alias-state-success-tertiary)', color: 'var(--dsw-alias-state-success-primary)' },
      badgeRed: { padding: '1px 8px', borderRadius: '999px', fontSize: '11px', flex: '0 0 auto',
        background: 'var(--dsw-alias-interactive-bg-hover-danger)', color: 'var(--dsw-alias-state-error-primary)' },
      button: { padding: '5px 12px', borderRadius: '7px', border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '12px', flex: '0 0 auto' },
      buttonPrimary: { padding: '5px 12px', borderRadius: '7px', border: 'none',
        background: 'var(--dsw-alias-button-info-fill)', color: '#fff', cursor: 'pointer', fontSize: '12px', flex: '0 0 auto' },
      input: { boxSizing: 'border-box', padding: '4px 8px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'inherit',
        fontSize: '12px', flex: '1 1 160px', minWidth: '120px', maxWidth: '100%' },
      select: { boxSizing: 'border-box', padding: '4px 8px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'inherit',
        fontSize: '12px', flex: '0 1 auto', minWidth: '120px', maxWidth: '100%' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '12.5px', tableLayout: 'fixed' },
      th: { textAlign: 'left', padding: '6px 8px', opacity: 0.6, fontWeight: 500,
        borderBottom: '1px solid rgba(128,128,128,.3)', whiteSpace: 'nowrap' },
      td: { padding: '6px 8px', borderBottom: '1px solid rgba(128,128,128,.16)', verticalAlign: 'top' },
      progressTrack: { height: '8px', borderRadius: '4px', background: 'rgba(128,128,128,.22)',
        overflow: 'hidden', flex: 1, minWidth: '180px' },
      progressFill: { height: '100%', background: 'var(--dsw-alias-state-business-primary)', transition: 'width .3s' },
      hint: { opacity: 0.6, fontSize: '12px' },
      datasetGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
        gap: '10px', marginTop: '14px' },
      datasetCard: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '11px',
        padding: '13px', background: 'var(--dsw-alias-bg-base)', transition: 'border-color .15s, box-shadow .15s' },
      datasetCardEnabled: { borderColor: 'var(--dsw-alias-state-business-primary)',
        boxShadow: '0 0 0 1px var(--dsw-alias-state-business-primary)' },
      buttonLink: { padding: '3px 0', border: 'none', background: 'transparent', color: 'inherit',
        opacity: 0.72, cursor: 'pointer', fontSize: '12px' },
      versionPanel: { marginTop: '12px', padding: '12px', borderRadius: '9px',
        background: 'rgba(128,128,128,.07)', border: '1px solid rgba(128,128,128,.18)' },
      versionRow: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 0',
        borderBottom: '1px solid rgba(128,128,128,.16)' },
      grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '6px 12px' },
      field: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', margin: '6px 0' },
      fieldKey: { minWidth: '140px', opacity: 0.75, flex: '0 0 auto' },
      error: { color: 'var(--dsw-alias-state-error-primary)' },
    }

    function SkinCard({ skin, onChanged }) {
      const [saving, setSaving] = useState(false)
      const [message, setMessage] = useState(null)
      const choose = async (next) => {
        if (saving || next === skin) return
        setSaving(true)
        setMessage(null)
        // 切肤开机场：终末地等地图就绪后由 aicBootDone 撤下，其它皮肤短暂过渡后立即收尾。
        if (next === 'endfield-aic') aicBootShow('REBUILDING INTERFACE')
        else {
          aicBootShow('SWITCHING SKIN')
          setTimeout(() => { if (aicBootEl) aicBootDone() }, 700)
        }
        try {
          try { localStorage.setItem(AIC_BOOT_KEY, next) } catch { /* 忽略 */ }
          await jsonFetch('/config', { method: 'PUT', body: JSON.stringify({ patch: { uiSkin: next } }) })
          setSkin(next)
          onChanged(next)
          if (next !== 'endfield-aic') aicBootDone()
        } catch (error) {
          aicBootAbort()
          setMessage(error?.message ?? String(error))
        } finally {
          setSaving(false)
        }
      }
      const option = (id, title, description, swatchClass) => h('button', {
        type: 'button', className: 'prts-skin-option', 'aria-pressed': skin === id,
        disabled: saving, onClick: () => { void choose(id) },
      }, h('strong', null, title), h('small', null, description),
      h('span', { className: `prts-skin-swatch ${swatchClass}` }))
      return h('div', { style: S.card },
        h('h3', { style: S.cardTitle }, '界面皮肤'),
        h('div', { className: 'prts-skin-options' },
          option('harness', 'Harness 默认', '跟随 DeepSeek Harness 原生视觉', ''),
          option('prts-agent', 'PRTS Agent', '迁移自 PRTS.chat Agent 的冷白、石墨与蓝色强调', 'prts'),
          option('endfield-aic', 'AIC 终末地', '完整武陵地图终端布局与酸性黄工业界面', 'endfield')),
        h('p', { className: 'prts-skin-note', style: message ? S.error : null },
          message || (saving ? '正在应用…' : '选择后立即生效，并保留当前的明亮 / 暗色偏好。')))
    }

    /* ---- 资料库选择与按游戏展开的版本管理 ---- */
    function DatasetLibraryCard({ status, releases, activeRelease, enabledGames, savingGames,
      onEnabledGames, onRefresh, onCheckUpdate, checking, updateInfo,
      onActivate, onDelete, onDownload, downloading }) {
      const store = status?.store ?? {}
      const download = status?.download ?? {}
      const percent = download.filesTotal
        ? Math.round((download.filesDone / download.filesTotal) * 100) : null
      const [expandedGame, setExpandedGame] = useState(null)
      const [showManual, setShowManual] = useState(false)
      const games = [
        { id: 'arknights', title: '明日方舟', subtitle: '剧情、档案、Wiki 与实体资料' },
        { id: 'endfield', title: '明日方舟：终末地', subtitle: '剧情原文、档案库与自建 Wiki' },
      ]
      const activeDatasets = activeRelease?.datasets ?? {}
      const shared = activeDatasets.sharedPacks ?? []
      const sharedDocuments = shared.reduce((sum, item) => sum + (Number(item.documentCount) || 0), 0)
      const sharedCompressedSize = shared.reduce((sum, item) =>
        sum + (Number(item.compressedSize) || 0), 0)
      const toggle = (game) => {
        const selected = enabledGames.includes(game)
          ? enabledGames.filter((item) => item !== game)
          : [...enabledGames, game]
        if (!selected.length || savingGames) return
        void onEnabledGames(selected)
      }
      const versionTitle = (dataset, release) => {
        const knownTitles = { 'xuesong-youmeng': '雪凇幽梦' }
        const releaseName = dataset?.releaseTitle
          || knownTitles[dataset?.releaseName] || dataset?.releaseName
        const names = [releaseName, dataset?.gameVersion].filter(Boolean)
        return names.length ? names.join(' · ') : release.releaseId
      }
      const versionRows = expandedGame == null ? [] : (releases ?? [])
        .filter((release) => release.datasets?.[expandedGame]?.present)
      const submitCustom = (event) => {
        const input = event.currentTarget.parentElement?.querySelector('input')
        const releaseId = input?.value.trim()
        if (releaseId) { onDownload({ releaseId }); input.value = '' }
      }
      return h('div', { style: S.card },
        h('div', { style: { ...S.row, justifyContent: 'space-between' } },
          h('div', null,
            h('h3', { style: { ...S.cardTitle, marginBottom: '3px' } }, '资料库'),
            h('span', { style: S.hint }, '选择 Agent 可以检索的资料；至少启用一个。')),
          h('div', { style: S.row },
            h('button', { style: S.button, onClick: onRefresh }, '刷新'),
            h('button', { style: S.button, disabled: checking, onClick: onCheckUpdate },
              checking ? '检查中…' : '检查更新'),
            h('button', { style: S.buttonPrimary, disabled: downloading, onClick: () => onDownload() },
              downloading ? '下载中…' : '下载最新'))),
        store.installed === false && h('div', { style: { ...S.error, marginTop: '8px' } },
          `本地资料尚未就绪：${store.installationIssue || '未找到有效版本'}。便携版用户还应确认 ZIP 已完整解压。`),
        store.installed === true && !store.loaded && h('div', { style: { ...S.hint, marginTop: '8px' } },
          '已检测到语料，正在加载索引；首次启动可能需要一些时间。'),
        h('div', { style: S.datasetGrid }, ...games.map((game) => {
          const dataset = activeDatasets[game.id]
          const enabled = enabledGames.includes(game.id)
          return h('section', { key: game.id, style: {
            ...S.datasetCard,
            ...(enabled ? S.datasetCardEnabled : {}),
            ...(!dataset?.present ? { opacity: 0.72 } : {}),
          } },
          h('div', { style: { ...S.row, flexWrap: 'nowrap', alignItems: 'flex-start' } },
            h('input', { type: 'checkbox', checked: enabled, disabled: savingGames,
              'aria-label': `启用${game.title}资料`, onChange: () => toggle(game.id),
              style: { width: '17px', height: '17px', marginTop: '2px', accentColor: 'var(--dsw-alias-state-business-primary)' } }),
            h('label', { style: { flex: 1, cursor: 'pointer' }, onClick: () => toggle(game.id) },
              h('strong', { style: { display: 'block', fontSize: '14px', marginBottom: '4px' } }, game.title),
              h('span', { style: S.hint }, game.subtitle))),
          h('div', { style: { ...S.row, marginTop: '12px' } },
            dataset?.present
              ? h(Fragment, null,
                  h('span', { style: store.loaded ? S.badgeGreen : S.badgeGray }, store.loaded ? '已就绪' : '加载中'),
                  h('span', null, `${dataset.documentCount.toLocaleString()} 篇`),
                  h('span', { style: S.hint }, `${fmtBytes(dataset.compressedSize)} 专属包`))
              : h('span', { style: S.badgeGray }, '未安装')),
          h('div', { style: { ...S.row, justifyContent: 'space-between', marginTop: '8px' } },
            h('span', { style: S.hint }, dataset?.present
              ? versionTitle(dataset, activeRelease) : '没有可用版本'),
            h('button', { style: S.buttonLink, disabled: !dataset?.present,
              onClick: () => setExpandedGame(expandedGame === game.id ? null : game.id) },
            expandedGame === game.id ? '收起版本' : '查看版本')))
        })),
        sharedDocuments > 0 && h('div', { style: { ...S.hint, marginTop: '9px' } },
          `另含 ${sharedDocuments.toLocaleString()} 篇共享资料（${fmtBytes(sharedCompressedSize)}），两款游戏共同使用。`),
        updateInfo?.text && h('div', { style: { ...S.row, marginTop: '8px' } },
          h('span', { style: updateInfo.kind === 'error' ? S.error : updateInfo.kind === 'update' ? S.badgeGreen : S.badgeGray },
            updateInfo.text),
          updateInfo.kind === 'update' && updateInfo.remoteReleaseId
            && h('button', { style: S.buttonPrimary, onClick: updateInfo.onDownload }, '下载更新')),
        download.phase && download.phase !== 'idle'
          ? h('div', { style: { ...S.row, marginTop: '8px' } },
              h('span', { style: S.key }, download.active ? '下载中' : '下载状态'),
              h('span', { style: S.badge }, `${download.source ?? ''} · ${download.phase}`),
              percent !== null && h('div', { style: S.progressTrack },
                h('div', { style: { ...S.progressFill, width: `${percent}%` } })),
              h('span', { style: S.hint },
                `${download.filesDone}/${download.filesTotal ?? '?'} 文件 · ${fmtBytes(download.bytesDone)}`),
              download.error && h('span', { style: S.error }, download.error))
          : null,
        expandedGame && h('div', { style: S.versionPanel },
          h('div', { style: { ...S.row, justifyContent: 'space-between' } },
            h('strong', null, `${games.find((item) => item.id === expandedGame)?.title} · 已安装版本`),
            h('span', { style: S.hint }, '版本切换会同时切换联合资料包')),
          ...versionRows.map((release) => {
            const dataset = release.datasets[expandedGame]
            return h('div', { key: release.releaseId, style: S.versionRow },
              h('div', { style: { minWidth: 0, flex: 1 } },
                h('strong', { style: { display: 'block' } }, versionTitle(dataset, release)),
                h('span', { style: S.hint },
                  `${release.releaseId} · ${dataset.documentCount.toLocaleString()} 篇 · ${fmtBytes(dataset.compressedSize)}`),
                h('span', { style: { ...S.hint, display: 'block' } },
                  `数据 ${shortVersion(dataset.dataVersion)}${release.createdAt ? ` · ${fmtDate(release.createdAt)}` : ''}`)),
              release.active
                ? h('span', { style: S.badgeGreen }, '当前')
                : h(Fragment, null,
                    h('button', { style: S.button, disabled: !release.complete,
                      onClick: () => onActivate(release.releaseId) }, '切换'),
                    h('button', { style: S.button, onClick: () => onDelete(release.releaseId) }, '删除')))
          }),
          versionRows.length === 0 && h('span', { style: S.hint }, '本地没有这个资料库的版本。'),
          h('button', { style: S.buttonLink, onClick: () => setShowManual((value) => !value) },
            showManual ? '收起指定版本' : '安装指定版本…'),
          showManual && h('div', { style: S.row },
            h('input', { style: S.input, placeholder: 'releaseId', defaultValue: '' }),
            h('button', { style: S.button, disabled: downloading, onClick: submitCustom }, '下载'))),
        h('div', { style: { ...S.hint, marginTop: '9px' } },
          '下载与更新优先使用 ModelScope；切换版本后索引自动重建，无需重启。'))
    }

    /* ---- 配置编辑 ---- */
    const NUMBER_FIELDS = [
      ['cacheShards', '分片缓存数'],
      ['cloudTimeoutMs', '云端超时（ms）'],
      ['cloudMaxResponseBytes', '云端响应上限（B）'],
    ]

    function ConfigCard({ config, onSaved }) {
      const [draft, setDraft] = useState(null)
      const [saving, setSaving] = useState(false)
      const [message, setMessage] = useState(null)
      if (!config) return null
      const value = draft ?? {}
      const current = (key, fallback) => Object.hasOwn(value, key) ? value[key] : (config[key] ?? fallback)
      const set = (key, cast) => (event) => {
        const raw = event.target.type === 'checkbox' ? event.target.checked : event.target.value
        setDraft((previous) => ({ ...(previous ?? {}), [key]: cast ? cast(raw) : raw }))
      }
      const save = async () => {
        setSaving(true)
        setMessage(null)
        try {
          await jsonFetch('/config', { method: 'PUT', body: JSON.stringify({ patch: value }) })
          setDraft(null)
          setMessage('已保存并生效')
          onSaved()
        } catch (error) {
          setMessage(error.message)
        } finally {
          setSaving(false)
        }
      }
      return h('div', { style: S.card },
        h('h3', { style: S.cardTitle }, '插件配置'),
        h('div', { style: S.field },
          h('span', { style: S.fieldKey }, '云端工具'),
          h('input', { type: 'checkbox', checked: Boolean(current('cloudEnabled', false)),
            onChange: set('cloudEnabled') }),
          h('span', { style: S.hint }, 'cloud_search / cloud_inspect（保存后即时注册/注销）')),
        h('div', { style: S.field },
          h('span', { style: S.fieldKey }, '云端检索地址'),
          h('input', { style: S.input, value: String(current('cloudBaseUrl', '')),
            onChange: set('cloudBaseUrl') }),
          h('span', { style: { ...S.hint, flexBasis: '100%', marginLeft: '148px' } }, 'cloud_search / cloud_inspect 服务')),
        h('div', { style: S.field },
          h('span', { style: S.fieldKey }, '访问令牌'),
          h('input', { style: S.input, type: 'password',
            placeholder: config.hasCloudToken ? '已设置（不修改即保持）' : '留空使用匿名会话',
            value: String(current('cloudToken', '')), onChange: set('cloudToken') })),
        h('div', { style: S.grid2 },
          ...NUMBER_FIELDS.map(([key, label]) => h('div', { key, style: S.field },
            h('span', { style: S.fieldKey }, label),
            h('input', { style: { ...S.input, flex: '0 0 96px', width: '96px' }, type: 'number',
              value: String(current(key, '')), onChange: set(key, Number) })))),
        h('div', { style: S.field },
          h('span', { style: S.fieldKey }, '默认资料版本'),
          h('input', { style: S.input, value: String(current('downloadReleaseId', '')),
            onChange: set('downloadReleaseId') })),
        h('div', { style: S.field },
          h('span', { style: S.fieldKey }, '资料站点地址'),
          h('input', { style: S.input, value: String(current('downloadSiteBaseUrl', '')),
            onChange: set('downloadSiteBaseUrl') })),
        h('div', { style: S.field },
          h('span', { style: S.fieldKey }, '下载源顺序'),
          h('select', { style: S.select, value: current('downloadOrder', ['modelscope', 'site']).join(','),
              onChange: set('downloadOrder', (raw) => raw.split(',')) },
            h('option', { value: 'modelscope,site' }, 'ModelScope → PRTS.chat'),
            h('option', { value: 'site,modelscope' }, 'PRTS.chat → ModelScope'),
            h('option', { value: 'modelscope' }, '仅 ModelScope'),
            h('option', { value: 'site' }, '仅 PRTS.chat'))),
        h('div', { style: { ...S.row, marginTop: '8px' } },
          h('button', { style: S.buttonPrimary, disabled: !draft || saving, onClick: save },
            saving ? '保存中…' : '保存'),
          draft && h('button', { style: S.button, onClick: () => { setDraft(null) } }, '放弃'),
          message && h('span', { style: message.includes('已保存') ? S.badgeGreen : S.error }, message),
          h('span', { style: S.hint }, '持久化于 $DSH_HOME/prts-corpus.json，覆盖 patch 配置')))
    }

    /* ---- 设置页主组件 ---- */
    function PrtsSection() {
      const [status, setStatus] = useState(null)
      const [releaseList, setReleaseList] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [checking, setChecking] = useState(false)
      const [savingGames, setSavingGames] = useState(false)
      const [updateInfo, setUpdateInfo] = useState(null)
      const [skin, setSkinState] = useState('harness')

      const refreshStatus = useCallback(async () => {
        try {
          setStatus(await jsonFetch('/status'))
          setError(null)
        } catch (caught) {
          setError(caught.message)
        }
      }, [])

      const refresh = useCallback(async () => {
        try {
          const [nextStatus, nextReleases] = await Promise.all([
            jsonFetch('/status'), jsonFetch('/releases'),
          ])
          setStatus(nextStatus)
          setSkinState(setSkin(nextStatus?.config?.uiSkin))
          setReleaseList(nextReleases)
          setError(null)
        } catch (caught) {
          setError(caught.message)
        }
      }, [])

      useEffect(() => {
        void refresh()
        const timer = setInterval(() => { void refreshStatus() }, 2000)
        return () => { clearInterval(timer) }
      }, [refresh, refreshStatus])

      const activeRelease = (releaseList?.releases ?? []).find((item) => item.active) ?? null
      const enabledGames = Array.isArray(status?.config?.enabledGames)
        ? status.config.enabledGames : ['arknights', 'endfield']

      const updateEnabledGames = async (games) => {
        const ordered = ['arknights', 'endfield'].filter((game) => games.includes(game))
        if (!ordered.length) return
        setSavingGames(true)
        try {
          await jsonFetch('/config', { method: 'PUT', body: JSON.stringify({ patch: {
            enabledGames: ordered,
            // 同步旧版配置键，使降级到旧插件时仍保持用户选择。
            cloudGame: ordered.length === 2 ? 'all' : ordered[0],
          } }) })
          await refresh()
        } catch (caught) {
          setError(caught.message)
        } finally {
          setSavingGames(false)
        }
      }

      const checkUpdate = async () => {
        setChecking(true)
        setUpdateInfo(null)
        try {
          const result = await jsonFetch('/check-update')
          if (result.updateAvailable && result.remote) {
            setUpdateInfo({ kind: 'update', remoteReleaseId: result.remote.releaseId,
              text: `发现新版本 ${result.remote.releaseId}（${result.remote.documentCount ?? '?'} 篇）` })
          } else if (!result.error && result.remote) {
            setUpdateInfo({ kind: 'latest', text: `已是最新版本（${result.remote.releaseId}）` })
          } else {
            setUpdateInfo({ kind: 'error', text: result.error || '检查失败' })
          }
        } catch (caught) {
          setUpdateInfo({ kind: 'error', text: caught.message })
        } finally {
          setChecking(false)
        }
      }

      const download = async (options) => {
        setBusy(true)
        try {
          await jsonFetch('/download', { method: 'POST',
            body: JSON.stringify(options?.releaseId ? { releaseId: options.releaseId } : {}) })
          if (updateInfo?.kind === 'update') setUpdateInfo(null)
          void refresh()
        } catch (caught) {
          setError(caught.message)
        } finally {
          setBusy(false)
        }
      }
      const activate = async (releaseId) => {
        if (!window.confirm(`切换激活版本到 ${releaseId}？索引将重建。`)) return
        try {
          await jsonFetch('/activate', { method: 'POST', body: JSON.stringify({ releaseId }) })
          void refresh()
        } catch (caught) { setError(caught.message) }
      }
      const remove = async (releaseId) => {
        if (!window.confirm(`删除本地版本 ${releaseId}？不可恢复。`)) return
        try {
          await jsonFetch('/delete', { method: 'POST', body: JSON.stringify({ releaseId }) })
          void refresh()
        } catch (caught) { setError(caught.message) }
      }

      const statusUpdateInfo = updateInfo?.kind === 'update'
        ? { ...updateInfo, onDownload: () => download({ releaseId: updateInfo.remoteReleaseId }) }
        : updateInfo

      return h('div', { style: S.wrap, className: 'prts-settings-wrap' },
        error && h('div', { style: { ...S.card, ...S.error } }, error),
        h(SkinCard, { skin, onChanged: setSkinState }),
        h(DatasetLibraryCard, { status, activeRelease,
          releases: releaseList?.releases ?? [], enabledGames, savingGames,
          onEnabledGames: updateEnabledGames, onRefresh: refresh,
          onCheckUpdate: checkUpdate, checking, updateInfo: statusUpdateInfo,
          onActivate: activate, onDelete: remove, onDownload: download,
          downloading: busy || Boolean(status?.download?.active),
        }),
        h(ConfigCard, { config: status?.config, onSaved: refresh }))
    }

    const contentText = (content) => (Array.isArray(content) ? content : []).map((block) => {
      if (typeof block === 'string') return block
      if (typeof block?.text === 'string') return block.text
      if (block?.type === 'image' || block?.kind === 'image') return '[IMAGE_ATTACHMENT]'
      return ''
    }).filter(Boolean).join('\n')
    const assistantParts = (blocks) => {
      const parts = { text: [], reasoning: [] }
      for (const block of Array.isArray(blocks) ? blocks : []) {
        if (block?.kind === 'text' && block.text) parts.text.push(block.text)
        else if (block?.kind === 'reasoning' && block.text) parts.reasoning.push(block.text)
      }
      return { text: parts.text.join('\n'), reasoning: parts.reasoning.join('\n') }
    }
    let mapBundlePromise = null
    const loadMapBundle = () => {
      if (globalThis.__PRTS_ENDFIELD_MAP__) return Promise.resolve(globalThis.__PRTS_ENDFIELD_MAP__)
      if (mapBundlePromise) return mapBundlePromise
      mapBundlePromise = new Promise((resolve, reject) => {
        const script = document.createElement('script')
        script.src = '/prts-corpus/endfield-map/map.js'
        script.async = true
        script.onload = () => globalThis.__PRTS_ENDFIELD_MAP__
          ? resolve(globalThis.__PRTS_ENDFIELD_MAP__)
          : reject(new Error('地图模块没有导出运行时'))
        script.onerror = () => reject(new Error('地图模块加载失败'))
        document.head.appendChild(script)
      }).catch((error) => { mapBundlePromise = null; throw error })
      return mapBundlePromise
    }

    function AicMap({ focusPoint = .66 }) {
      const host = useRef(null)
      const mapRef = useRef(null)
      const [status, setStatus] = useState('MAP_ASSET_SYNC 0%')
      const [stats, setStats] = useState({ cx: 0, cy: 0, size: 0, fps: 0, meshes: 0, tris: 0 })
      const [positions, setPositions] = useState([])
      const [selected, setSelected] = useState(null)
      const [regions, setRegions] = useState([])
      useEffect(() => {
        let disposed = false
        // WebView2 进入托盘后 document.visibilityState 不一定立刻变化，桌面壳
        // 会额外发送 prts-shell-visibility。两条信号统一控制 Three.js 的 RAF，
        // 避免隐藏窗口仍持续渲染并让 renderer/GPU working set 不断增长。
        const pageIsActive = () => document.visibilityState !== 'hidden'
          && globalThis.__PRTS_SHELL_BACKGROUND__ !== true
          && !document.querySelector('[aria-modal="true"][role="dialog"]')
        const syncMapActivity = () => {
          const map = mapRef.current
          if (!map) return
          if (pageIsActive()) map.resume?.()
          else map.pause?.()
        }
        const syncModalState = () => {
          document.body.classList.toggle('aic-modal-open',
            Boolean(document.querySelector(
              '[data-slot="sidebar.settings"] [aria-modal="true"][role="dialog"]')))
          syncMapActivity()
        }
        document.addEventListener('visibilitychange', syncMapActivity)
        globalThis.addEventListener('prts-shell-visibility', syncMapActivity)
        // 设置弹窗覆盖 WebGL 时暂停 RAF。尤其在 macOS WebKit 中，全屏蒙层与
        // 持续运行的 Three.js 合成会显著放大 GPU 压力，表现为发光后卡死。
        const modalObserver = new MutationObserver(syncModalState)
        modalObserver.observe(document.body, { childList: true, subtree: true })
        syncModalState()
        void loadMapBundle().then(async (runtime) => {
          if (disposed || !host.current) return
          setRegions(runtime.REGION_LIST ?? [])
          const map = await runtime.createRegionMap(host.current, {
            focusPoint,
            onProgress: (progress, message) => {
              setStatus(progress < 0 ? `ERROR // ${message}` : `MAP_ASSET_SYNC ${progress}% // ${message}`)
              // 开机场加载屏由地图真实进度驱动；失败时停留片刻再撤下，露出页面内的错误状态。
              if (progress < 0) {
                aicBootProgress(-1, message)
                setTimeout(() => { if (aicBootEl) aicBootDone() }, 2500)
              } else aicBootProgress(progress, message)
            },
            onStats: setStats,
            onSelectLv: setSelected,
            onRegionPositions: setPositions,
          })
          if (disposed) map.dispose()
          else {
            mapRef.current = map
            syncMapActivity()
            setStatus('')
            aicBootDone()
          }
        }).catch((error) => {
          if (!disposed) setStatus(`ERROR // ${error.message}`)
          aicBootProgress(-1, error.message)
          setTimeout(() => { if (aicBootEl) aicBootDone() }, 2500)
        })
        return () => {
          disposed = true
          document.removeEventListener('visibilitychange', syncMapActivity)
          globalThis.removeEventListener('prts-shell-visibility', syncMapActivity)
          modalObserver.disconnect()
          document.body.classList.remove('aic-modal-open')
          mapRef.current?.dispose()
          mapRef.current = null
        }
      }, [])
      useEffect(() => { mapRef.current?.setFocusPoint?.(focusPoint) }, [focusPoint])
      const positionByLv = Object.fromEntries(positions.map((item) => [item.lv, item]))
      return h(Fragment, null,
        h('div', { ref: host, className: 'aic-map' }),
        status && h('div', { className: `aic-map-status${status.startsWith('ERROR') ? ' error' : ''}` }, status),
        ...regions.map((region) => {
          const point = positionByLv[region.lv]
          if (!point?.visible) return null
          return h('div', { key: region.lv, className: 'aic-region-label',
            style: { left: `${point.x}px`,
              top: `${point.y}px`, transform: 'translate(-50%,-50%)' } },
          h('i'), region.name, h('small', null, region.lv.toUpperCase()))
        }),
        selected && (() => {
          const region = regions.find((item) => item.lv === selected)
          return region ? h('aside', { className: 'aic-region-card' },
            h('small', null, `REGION_INTEL // ${region.lv.toUpperCase()}`),
            h('h3', null, region.name), h('em', null, region.nameEn),
            h('p', null, region.description), h('b', null, region.sourceLabel)) : null
        })(),
        h('div', { className: 'aic-hud aic-hud-tl' },
          h('div', { className: 'aic-brand' }, h('i', { className: 'aic-brand-mark' }),
            h('b', { className: 'aic-brand-name' }, 'AIC'),
            h('span', { className: 'aic-brand-sub' }, 'ENDFIELD_INDUSTRIES // TALOS-II SURVEY')),
          h('div', { className: 'aic-coords' }, h('span', null, `VIEW ${stats.cx},${stats.cy}`),
            h('span', null, `ZOOM ${stats.size}`))),
        h('div', { className: 'aic-hud aic-hud-br' }, 'DRAG 平移 // WHEEL 缩放 // CLICK 选中建筑组'),
        h('button', { type: 'button', className: 'aic-map-reset', onClick: () => mapRef.current?.resetView(),
          title: '重置地图视角' }, 'RESET_VIEW'))
    }

    function AicRoot({ useSessions }) {
      // useSessions 由 ui-session 的 provideRoot 提供给 root 槽位；不含该包的
      // 组合下为 undefined——历史抽屉退化为空列表，新建对话仍走 sessions 服务。
      const sessions = useSessions?.((snapshot) => snapshot)
        ?? { ids: [], byId: {}, current: undefined }
      const [historyOpen, setHistoryOpen] = useState(false)
      const [clock, setClock] = useState(() => new Date())
      const defaultBandWidth = Math.min(Math.max(760, globalThis.innerWidth * .46), 960,
        Math.max(520, globalThis.innerWidth - 360))
      const [chatBandWidth, setChatBandWidth] = useState(defaultBandWidth)
      const [chatResizeActive, setChatResizeActive] = useState(false)
      const stopChatResizeRef = useRef(null)
      useEffect(() => {
        const timer = setInterval(() => setClock(new Date()), 1000)
        return () => clearInterval(timer)
      }, [])
      useEffect(() => {
        document.body.style.setProperty('--prts-aic-band-width', `${chatBandWidth}px`)
        return () => { document.body.style.removeProperty('--prts-aic-band-width') }
      }, [chatBandWidth])
      useEffect(() => () => { stopChatResizeRef.current?.() }, [])
      const current = sessions.current
      const sessionRows = sessions.ids.map((id) => sessions.byId[id]).filter(Boolean)
      const newSession = () => {
        const currentSummary = current === undefined ? undefined : sessions.byId[current]
        const options = currentSummary?.cwd ? { cwd: currentSummary.cwd } : {}
        void clientContext?.sessions?.create(options).then((sessionId) => { clientContext?.sessions?.open(sessionId) })
      }
      const openSettings = () => {
        const trigger = document.querySelector(
          '[data-slot="sidebar.settings"] button[aria-haspopup="dialog"]')
        if (trigger instanceof HTMLElement) trigger.click()
      }
      const startChatResize = (event) => {
        if (globalThis.innerWidth <= 980) return
        event.preventDefault()
        stopChatResizeRef.current?.()
        setChatResizeActive(true)
        document.body.classList.add('aic-chat-resizing')
        const resize = (moveEvent) => {
          const minWidth = Math.min(520, globalThis.innerWidth - 320)
          const maxWidth = Math.min(1200, globalThis.innerWidth - 320)
          setChatBandWidth(Math.max(minWidth, Math.min(maxWidth, moveEvent.clientX)))
        }
        const stop = () => {
          setChatResizeActive(false)
          globalThis.removeEventListener('pointermove', resize)
          globalThis.removeEventListener('pointerup', stop)
          globalThis.removeEventListener('pointercancel', stop)
          document.body.classList.remove('aic-chat-resizing')
          stopChatResizeRef.current = null
        }
        stopChatResizeRef.current = stop
        globalThis.addEventListener('pointermove', resize)
        globalThis.addEventListener('pointerup', stop, { once: true })
        globalThis.addEventListener('pointercancel', stop, { once: true })
      }
      const focusPoint = Math.max(.55, Math.min(.86,
        .66 + (chatBandWidth - defaultBandWidth) / (globalThis.innerWidth * 2)))
      return h('main', { className: 'aic-root', style: {
        '--aic-band-width': `${chatBandWidth}px`,
        '--prts-aic-band-width': `${chatBandWidth}px`,
      } },
        h(AicMap, { focusPoint }),
        h('section', { className: 'aic-chat-band' },
          h('div', { className: 'aic-band-backdrop', 'aria-hidden': 'true' }),
          h('button', { type: 'button', className: 'aic-chat-resize',
            title: '拖动调整聊天区域宽度', 'aria-label': '拖动调整聊天区域宽度',
            onPointerDown: startChatResize }),
          h('section', { className: 'aic-start-brand', 'aria-hidden': 'true' },
            h('div', { className: 'aic-start-wordmark' }, 'PRTS'),
            h('div', { className: 'aic-start-submark' },
              h('s', null, 'PRIMITIVE RHODES ISLAND TERMINAL SERVICE'), ' // PRIES—???'),
            h('h2', null, '想从泰拉的故事里了解什么？'),
            h('p', null, '我会先检索线索，再回到本地资料逐行核验，并把可复查的原文放在回答旁边。')),
          h('div', { className: 'aic-terminal-overlay' },
            h('div', { className: 'aic-terminal-name' }, h('i', { className: 'aic-terminal-dot' }),
              h('span', null, 'AIC_TERMINAL'), h('small', { className: 'aic-terminal-ver' }, 'V9.2 // WULING_NODE')),
            h('button', { type: 'button', className: 'aic-band-btn aic-settings-trigger',
              onClick: openSettings }, '设置'),
            h('button', { type: 'button', className: `aic-band-btn${historyOpen ? ' on' : ''}`,
              onClick: () => setHistoryOpen((value) => !value) }, '◷ 历史记录'),
            h('button', { type: 'button', className: 'aic-band-btn', onClick: newSession }, '＋ 新建对话'))),
        chatResizeActive && h('div', { className: 'aic-chat-resize-line',
          style: { left: `${chatBandWidth}px` } }),
        h('div', { className: 'aic-hud aic-hud-tr' },
          h('span', { className: 'aic-clock' }, clock.toLocaleTimeString('zh-CN', { hour12: false }))),
        historyOpen && h('aside', { className: 'aic-drawer' },
          h('header', { className: 'aic-drawer-head' }, h('span', null, 'SESSION_ARCHIVE'),
            h('button', { type: 'button', className: 'aic-close', onClick: () => setHistoryOpen(false) }, '×')),
          h('button', { type: 'button', className: 'aic-band-btn', onClick: newSession }, '＋ 新建对话'),
          h('div', { className: 'aic-session-list' }, sessionRows.length
            ? sessionRows.map((session) => h('button', { type: 'button', key: session.id,
              className: `aic-session${session.id === current ? ' active' : ''}`,
              onClick: () => { clientContext?.sessions?.open(session.id); setHistoryOpen(false) } },
            h('b', null, session.title || (session.blank ? '新会话' : `会话_${String(session.id).slice(0, 6)}`)),
            h('small', null, `${session.blank ? 'STANDBY' : 'ARCHIVED'} // ${new Date(session.updatedAt).toLocaleString('zh-CN')}`)))
            : h('div', { className: 'aic-empty' }, 'NO SESSION RECORDS'))))
    }

    syncAicLayout = () => {
      if (!clientContext) return
      if (activeSkin !== 'endfield-aic') {
        if (disposeAicLayout) disposeAicLayout()
        disposeAicLayout = null
        return
      }
      if (disposeAicLayout) return
      const disposeShell = clientContext.slots.register({
        name: 'shell.overlay', id: 'prts-aic-shell', order: -100,
      }, AicRoot)
      disposeAicLayout = () => { disposeShell() }
    }

    /* ---- 插件入口：Settings → Plugins 的「PRTS 语料」tab ---- */
    exports.__sceneStateForTest = { buildSceneSnapshotModel, sceneSnapshotSignature }
    exports.inject = ['slots', 'connection', 'theme', 'sessions']

    exports.apply = (ctx) => {
      clientContext = ctx
      themeRuntime = ctx.theme
      if (typeof document !== 'undefined') {
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = 'prts-terrarchive'
          tag.dataset.pluginCss = 'prts-agent-skin'
          tag.textContent = SKIN_CSS + AIC_CSS
          document.head.appendChild(tag)
          return () => { tag.remove() }
        }, 'prts-corpus: skin stylesheet')
      }
      callApi = async (endpoint, payload) => {
        const result = await ctx.connection.rpc.call('/prts-corpus', endpoint, payload)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      }
      void loadConfiguredSkin().catch((error) => {
        console.error('[prts-terrarchive] failed to activate configured skin', error)
        aicBootAbort()
      })
      ctx.effect(() => () => {
        if (disposeAicLayout) disposeAicLayout()
        disposeAicLayout = null
        if (disposeScene) disposeScene()
        disposeScene = null
        clientContext = null
        themeRuntime = null
        callApi = null
        if (removeSkinTokens) removeSkinTokens()
        removeSkinTokens = null
        // 重置活动皮肤：否则热重载后 setSkin(同值) 会提前返回而不重新挂 token。
        activeSkin = 'harness'
        if (typeof document !== 'undefined') delete document.body.dataset.prtsSkin
      }, 'prts-corpus: skin cleanup')
      ctx.effect(() => ctx.slots.inject('settings.plugins.tab',
        () => ctx.slots.register(
          { name: 'settings.plugins.tab', id: 'prts-corpus', label: 'PRTS 语料', order: 60 },
          PrtsSection)), 'prts-corpus: settings plugins tab')
      ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities',
        () => ctx.slots.register(
          { name: 'conversation.session.header.utilities', id: 'prts-evidence', order: 18 },
          EvidenceControl)), 'prts-corpus: evidence header control')
    }

    return module.exports
  },
})
