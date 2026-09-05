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
    let applyGeneration = 0
    let skinOperationEpoch = 0
    let skinApplyEpoch = 0
    // Host -> browser 的皮肤快照共享同一代次。启动配置、设置页完整刷新和
    // 状态轮询无论从哪个入口发出，都只能由最后开始的请求提交到本地。
    let hostSkinSyncGeneration = 0
    const pendingSkinOperations = new Set()
    let skinSelectionOwner = null
    let clientAbortController = null
    const NOOP_STYLESHEET_TRANSACTION = Object.freeze({ commit() {}, rollback() {} })
    let prepareSkinStylesheet = async () => NOOP_STYLESHEET_TRANSACTION
    let skinStylesheetOwner = null
    const SKIN_SOURCE = 'prts-terrarchive:prts-agent-skin'

    /* ---- 终末地「开机场」加载屏：由当前 apply/切肤代次独占，旧回调不得操作新遮罩。 ---- */
    const AIC_BOOT_KEY = 'prts.uiSkin'
    let aicBootEl = null
    let aicBootTimer = null
    let aicBootWatchdog = null
    let aicBootTimeouts = new Set()
    let aicBootPct = 0
    let aicBootEpoch = 0
    let aicBootFinishing = false
    let aicBootStyleOwned = false
    let aicBootPreviousBackground
    function aicBootClearTimers() {
      if (aicBootTimer) { clearInterval(aicBootTimer); aicBootTimer = null }
      if (aicBootWatchdog) { clearTimeout(aicBootWatchdog); aicBootWatchdog = null }
      for (const timer of aicBootTimeouts) clearTimeout(timer)
      aicBootTimeouts.clear()
    }
    function aicBootSchedule(callback, delay, token) {
      const timer = setTimeout(() => {
        aicBootTimeouts.delete(timer)
        if (token === aicBootEpoch) callback()
      }, delay)
      aicBootTimeouts.add(timer)
      return timer
    }
    function aicBootRestoreBackground() {
      if (typeof document === 'undefined') return
      if (aicBootPreviousBackground !== undefined) {
        document.documentElement.style.background = aicBootPreviousBackground
        aicBootPreviousBackground = undefined
      }
    }
    function aicBootRestoreDocument() {
      if (typeof document === 'undefined') return
      aicBootRestoreBackground()
      if (aicBootStyleOwned) document.getElementById('aic-boot-style')?.remove()
      aicBootStyleOwned = false
    }
    function aicBootPaint(percent, message, token = aicBootEpoch) {
      if (!aicBootEl || token !== aicBootEpoch) return
      const failed = percent < 0
      const fill = aicBootEl.querySelector('.aic-boot-fill')
      const label = aicBootEl.querySelector('.aic-boot-msg')
      const pct = aicBootEl.querySelector('.aic-boot-pct')
      if (fill) fill.style.width = `${aicBootPct}%`
      if (label) label.textContent = failed
        ? `LOAD FAILED: ${message ?? 'UNKNOWN'}` : `${(message ?? 'LOADING').toUpperCase()}…`
      if (pct) pct.textContent = failed ? 'ERROR' : `${aicBootPct}%`
    }
    function aicBootProgress(percent, message, token = aicBootEpoch) {
      if (!aicBootEl || token !== aicBootEpoch) return
      if (aicBootTimer) { clearInterval(aicBootTimer); aicBootTimer = null }
      if (percent < 0) {
        aicBootPaint(-1, message, token)
        return
      }
      // 进度只进不退（假爬行与真实事件混跑时避免条子回跳）。
      aicBootPct = Math.max(aicBootPct, Math.min(100, Math.round(percent)))
      aicBootPaint(aicBootPct, message, token)
    }
    function aicBootAbort(forceRestore = activeSkin !== 'endfield-aic') {
      aicBootEpoch += 1
      aicBootClearTimers()
      aicBootEl?.remove()
      aicBootEl = null
      aicBootFinishing = false
      if (forceRestore) aicBootRestoreDocument()
    }
    function aicBootShow(message = 'INITIALIZING', restart = false) {
      if (typeof document === 'undefined') return 0
      if (aicBootEl && !restart && !aicBootFinishing) {
        aicBootProgress(aicBootPct, message)
        return aicBootEpoch
      }
      if (aicBootEl) aicBootAbort(false)
      const token = ++aicBootEpoch
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
          + '@media(prefers-reduced-motion:reduce){.aic-boot,.aic-boot-fill{transition:none!important}}'
        document.head.appendChild(style)
        aicBootStyleOwned = true
      }
      aicBootEl = document.createElement('div')
      aicBootEl.className = 'aic-boot'
      aicBootEl.innerHTML = '<div class="aic-boot-box"><div class="aic-boot-logo">AIC</div>'
        + '<div class="aic-boot-sub">ENDFIELD INDUSTRIES // TALOS-II SURVEY SYSTEM</div>'
        + '<div class="aic-boot-bar"><div class="aic-boot-fill"></div></div>'
        + '<div class="aic-boot-line"><span class="aic-boot-msg"></span><span class="aic-boot-pct"></span></div></div>'
      document.body.appendChild(aicBootEl)
      if (aicBootPreviousBackground === undefined) {
        aicBootPreviousBackground = document.documentElement.style.background
      }
      document.documentElement.style.background = '#0b0d10'
      aicBootPct = 4
      aicBootFinishing = false
      aicBootPaint(aicBootPct, message, token)
      // 真实进度（地图资源 / 插件装载事件）到来前缓慢爬行，避免停在 0%。
      aicBootTimer = setInterval(() => {
        if (!aicBootEl || token !== aicBootEpoch) return
        aicBootPct = Math.min(90, aicBootPct + Math.random() * 3)
        aicBootPaint(aicBootPct, 'LOADING', token)
      }, 160)
      // 看门狗：任何挂起（配置请求悬挂、地图脚本阻塞、席位未渲染）最多 30s 强制放行，绝不卡死界面。
      aicBootWatchdog = setTimeout(() => {
        if (!aicBootEl || token !== aicBootEpoch) return
        aicBootProgress(-1, 'STARTUP TIMEOUT', token)
        aicBootSchedule(() => aicBootDone(token, false), 2500, token)
      }, 30000)
      return token
    }
    function aicBootDone(token = aicBootEpoch, succeeded = true) {
      if (!aicBootEl || token !== aicBootEpoch || aicBootFinishing) return
      // Failed startup already paints an ERROR state. Do not overwrite it with a
      // misleading success message while the overlay is fading out.
      if (succeeded) aicBootProgress(100, 'SYSTEM ONLINE', token)
      const el = aicBootEl
      aicBootClearTimers()
      aicBootFinishing = true
      aicBootSchedule(() => {
        el.classList.add('done')
        aicBootSchedule(() => {
          el.remove()
          if (aicBootEl === el) aicBootEl = null
          aicBootFinishing = false
          if (aicBootStyleOwned) document.getElementById('aic-boot-style')?.remove()
          aicBootStyleOwned = false
          if (activeSkin !== 'endfield-aic') aicBootRestoreDocument()
        }, 900, token)
      }, 260, token)
    }


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

    const normalizeSkin = (skin) => skin === 'prts-agent' || skin === 'endfield-aic'
      ? skin : 'harness'
    const skinTokens = (skin) => skin === 'prts-agent' ? PRTS_AGENT_TOKENS
      : skin === 'endfield-aic' ? ENDFIELD_AIC_TOKENS : null
    const writeSkinDataset = (skin) => {
      if (typeof document !== 'undefined') {
        if (skin === 'prts-agent') document.body.dataset.prtsSkin = 'agent'
        else if (skin === 'endfield-aic') document.body.dataset.prtsSkin = 'endfield-aic'
        else delete document.body.dataset.prtsSkin
      }
    }
    const persistSkin = (skin) => {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(AIC_BOOT_KEY, skin)
      } catch { /* 隐私模式等无 localStorage 环境不影响已提交的皮肤 */ }
    }
    const setSkin = async (skin, options = {}) => {
      const next = normalizeSkin(skin)
      const operation = ++skinApplyEpoch
      const assertCurrent = () => {
        if (operation !== skinApplyEpoch) throw makeAbortError('皮肤切换已被新的操作取代')
        options.assertCurrent?.()
      }
      const stylesheet = await prepareSkinStylesheet(next)
      try {
        assertCurrent()
      } catch (error) {
        stylesheet.rollback()
        throw error
      }
      if (next === activeSkin) {
        // 同值也要修复运行时挂载；slot owner HMR 或旧版半切换状态不能被短路。
        try {
          await options.beforeCommit?.({ previous: activeSkin, next })
          assertCurrent()
          syncScene()
          syncAicLayout()
          stylesheet.commit()
          // AIC 的 boot 已完成时会刻意保留根节点黑底。轮询或裸 setSkin
          // 离开 AIC 不会再经过 boot 淡出，因此在成功提交后独立恢复原值。
          if (next !== 'endfield-aic') aicBootRestoreBackground()
          persistSkin(next)
          return next
        } catch (error) {
          stylesheet.rollback()
          throw error
        }
      }
      const previous = activeSkin
      const previousDispose = removeSkinTokens
      const nextTokens = skinTokens(next)
      let nextDispose = null
      let runtimeStarted = false
      try {
        // External persistence is the asynchronous prepare phase. Do it while
        // activeSkin, tokens, scene and the committed stylesheet are untouched.
        await options.beforeCommit?.({ previous, next })
        assertCurrent()
        runtimeStarted = true
        // 同 source 的新层会原子替换旧层，旧 disposer 自动变成 no-op。
        if (nextTokens && themeRuntime) {
          nextDispose = themeRuntime.overrideTokens(SKIN_SOURCE, nextTokens)
        }
        activeSkin = next
        writeSkinDataset(next)
        syncScene()
        syncAicLayout()
        if (!nextDispose) previousDispose?.()
        removeSkinTokens = nextDispose
        // Runtime and CSS commit form one synchronous section, so cleanup/HMR
        // cannot interleave and let an obsolete rollback overwrite a new owner.
        stylesheet.commit()
        if (next !== 'endfield-aic') aicBootRestoreBackground()
        persistSkin(next)
        return next
      } catch (error) {
        stylesheet.rollback()
        if (!runtimeStarted) throw error
        // 清掉新皮肤已经安装的 DOM/slot，再恢复旧 token、dataset 与运行时。
        try {
          activeSkin = 'harness'
          syncScene()
          syncAicLayout()
        } catch { /* 尽最大努力回滚，保留原始异常 */ }
        try { nextDispose?.() } catch (rollbackError) {
          console.error('[prts-terrarchive] failed to dispose rejected skin tokens', rollbackError)
        }
        const previousTokens = skinTokens(previous)
        try {
          removeSkinTokens = previousTokens && themeRuntime
            ? themeRuntime.overrideTokens(SKIN_SOURCE, previousTokens)
            : previousDispose
        } catch (rollbackError) {
          removeSkinTokens = previousDispose
          console.error('[prts-terrarchive] failed to restore previous skin tokens', rollbackError)
        }
        activeSkin = previous
        writeSkinDataset(previous)
        try { syncScene(); syncAicLayout() } catch { /* 保留原始异常 */ }
        throw error
      }
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
    // Endfield AIC skin CSS lives in lib/skins/endfield-aic.css.

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

    // 浏览器半边是预构建 classic script，不能直接 import CSS；Host 只暴露这两份
    // 固定白名单资源。候选样式 load 成功后才交给 setSkin 做二阶段提交，旧样式在此
    // 之前始终保留，避免 404、超时和快速切换留下“有皮肤状态、无皮肤 CSS”。
    const SKIN_COMMON_STYLESHEET = Object.freeze({
      id: 'common', href: '/prts-corpus/skins/common.css',
    })
    const SKIN_STYLESHEETS = Object.freeze({
      'prts-agent': '/prts-corpus/skins/prts-agent.css',
      'endfield-aic': '/prts-corpus/skins/endfield-aic.css',
    })
    const SKIN_STYLESHEET_TIMEOUT_MS = 8000
    const createSkinStylesheet = (id, href) => {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = href
      link.dataset.plugin = 'prts-terrarchive'
      link.dataset.pluginCss = `${id}-skin`
      return link
    }
    const installSkinStylesheets = () => {
      // Defend against an overlapping/re-entrant apply that installs a replacement
      // effect before the previous cleanup. Retire that owner now so its ready
      // candidate/committed links cannot survive beside the replacement manager.
      skinStylesheetOwner?.dispose?.()
      const owner = {}
      // This tiny fail-closed rule prevents a missing common.css from exposing
      // the always-registered evidence UI as naked browser controls.
      const commonSafetyStyle = document.createElement('style')
      commonSafetyStyle.dataset.plugin = 'prts-terrarchive'
      commonSafetyStyle.dataset.pluginCss = 'common-safety'
      commonSafetyStyle.textContent = '.prts-header-badge,.prts-evidence-layer{display:none}'
      document.head.appendChild(commonSafetyStyle)
      let commonLink = null
      let commonRequest = null
      let committedLink = null
      let committedSkin = 'harness'
      let currentRequest = null
      let disposed = false

      const ensureCommon = () => {
        if (disposed) return Promise.reject(makeAbortError('皮肤样式管理器已卸载'))
        if (commonLink) return Promise.resolve(commonLink)
        if (commonRequest) return commonRequest.promise
        const candidate = createSkinStylesheet(
          SKIN_COMMON_STYLESHEET.id, SKIN_COMMON_STYLESHEET.href)
        let resolveReady
        let rejectReady
        const request = {
          candidate, timer: null, finished: false,
          promise: new Promise((resolve, reject) => {
            resolveReady = resolve
            rejectReady = reject
          }),
          finish(error) {
            if (request.finished) return
            request.finished = true
            clearTimeout(request.timer)
            candidate.removeEventListener('load', onLoad)
            candidate.removeEventListener('error', onError)
            if (commonRequest === request) commonRequest = null
            if (error) {
              candidate.remove()
              rejectReady(error)
              return
            }
            commonLink = candidate
            commonSafetyStyle.remove()
            resolveReady(candidate)
          },
        }
        const onLoad = () => request.finish()
        const onError = () => {
          console.error('[prts-terrarchive] failed to load common stylesheet')
          request.finish(new Error('公共皮肤样式加载失败'))
        }
        candidate.addEventListener('load', onLoad, { once: true })
        candidate.addEventListener('error', onError, { once: true })
        request.timer = setTimeout(() => {
          request.finish(new Error('公共皮肤样式加载超时'))
        }, SKIN_STYLESHEET_TIMEOUT_MS)
        commonRequest = request
        document.head.appendChild(candidate)
        return request.promise
      }

      const invalidateCurrent = (error = makeAbortError('皮肤样式加载已被取代')) => {
        const request = currentRequest
        if (!request) return
        currentRequest = null
        request.rollback(error)
      }
      const prepare = async (skin) => {
        const id = normalizeSkin(skin)
        invalidateCurrent()
        if (disposed) return Promise.reject(makeAbortError('皮肤样式管理器已卸载'))
        await ensureCommon()
        if (disposed) throw makeAbortError('皮肤样式管理器已卸载')
        // Even an already-resolved common promise yields a microtask. A newer
        // back-to-back switch may have installed its request in that gap.
        invalidateCurrent()
        const href = SKIN_STYLESHEETS[id]
        if (committedSkin === id) return Promise.resolve(NOOP_STYLESHEET_TRANSACTION)
        if (!href) {
          let finished = false
          return Promise.resolve({
            commit() {
              if (finished || disposed) return
              finished = true
              committedLink?.remove()
              committedLink = null
              committedSkin = 'harness'
            },
            rollback() { finished = true },
          })
        }
        const candidate = createSkinStylesheet(id, href)
        let resolveReady
        let rejectReady
        const request = {
          id, candidate, state: 'loading', finished: false, timer: null,
          promise: new Promise((resolve, reject) => {
            resolveReady = resolve
            rejectReady = reject
          }),
          cleanup() {
            clearTimeout(request.timer)
            candidate.removeEventListener('load', onLoad)
            candidate.removeEventListener('error', onError)
          },
          commit() {
            if (request.finished || request.state !== 'ready' || disposed
                || currentRequest !== request) {
              throw makeAbortError('皮肤样式事务已失效')
            }
            request.finished = true
            request.cleanup()
            if (currentRequest === request) currentRequest = null
            committedLink?.remove()
            committedLink = candidate
            committedSkin = id
          },
          rollback(error) {
            if (request.finished) return
            request.finished = true
            request.cleanup()
            candidate.remove()
            if (currentRequest === request) currentRequest = null
            if (request.state === 'loading') rejectReady(error)
          },
        }
        const onLoad = () => {
          if (currentRequest !== request || request.finished) return
          request.state = 'ready'
          request.cleanup()
          resolveReady(request)
        }
        const onError = () => {
          console.error(`[prts-terrarchive] failed to load ${id} skin stylesheet`)
          request.rollback(new Error(`${id} 皮肤样式加载失败`))
        }
        candidate.addEventListener('load', onLoad, { once: true })
        candidate.addEventListener('error', onError, { once: true })
        request.timer = setTimeout(() => {
          request.rollback(new Error(`${id} 皮肤样式加载超时`))
        }, SKIN_STYLESHEET_TIMEOUT_MS)
        currentRequest = request
        document.head.appendChild(candidate)
        return request.promise
      }
      const dispose = () => {
        if (disposed) return
        disposed = true
        invalidateCurrent(makeAbortError('皮肤样式管理器已卸载'))
        commonRequest?.finish(makeAbortError('皮肤样式管理器已卸载'))
        commonRequest = null
        commonLink?.remove()
        commonSafetyStyle.remove()
        committedLink?.remove()
        if (skinStylesheetOwner === owner) {
          skinApplyEpoch += 1
          skinStylesheetOwner = null
          prepareSkinStylesheet = async () => NOOP_STYLESHEET_TRANSACTION
        }
      }
      owner.prepare = prepare
      owner.dispose = dispose
      skinStylesheetOwner = owner
      prepareSkinStylesheet = prepare
      // Start fetching immediately; prepare() joins this request and treats any
      // failure as a transaction failure. A later switch retries with a new link.
      void ensureCommon().catch(() => {})
      return dispose
    }

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
      return callApi(endpoint, payload, init.signal)
    }
    const makeAbortError = (message = '操作已取消') => {
      const error = new Error(message)
      error.name = 'AbortError'
      return error
    }
    const beginHostSkinSync = () => {
      hostSkinSyncGeneration += 1
      return hostSkinSyncGeneration
    }
    const assertHostSkinSyncActive = (generation) => {
      if (generation !== hostSkinSyncGeneration) {
        throw makeAbortError('Host 皮肤快照已被更新的请求取代')
      }
    }
    const assertApplyActive = (generation, signal) => {
      if (signal?.aborted || generation !== applyGeneration || !clientContext) throw makeAbortError()
    }
    const assertConfiguredSkinActive = (generation, signal, skinEpoch, hostSyncGeneration) => {
      assertApplyActive(generation, signal)
      if (skinEpoch !== skinOperationEpoch) throw makeAbortError('皮肤配置已被新的用户操作取代')
      assertHostSkinSyncActive(hostSyncGeneration)
    }
    const waitWithDeadline = (promise, { signal, timeout = 10000, label = '请求' } = {}) =>
      new Promise((resolve, reject) => {
        let settled = false
        const finish = (callback, value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          callback(value)
        }
        const onAbort = () => finish(reject, makeAbortError())
        const timer = setTimeout(() => finish(reject, new Error(`${label}超时`)), timeout)
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) { onAbort(); return }
        Promise.resolve(promise).then(
          (value) => finish(resolve, value),
          (error) => finish(reject, error),
        )
      })
    const writeSkinConfig = async (skin, {
      signal = clientAbortController?.signal, timeout = 10000,
    } = {}) => {
      if (signal?.aborted) throw makeAbortError('皮肤配置写入已取消')
      const controller = new AbortController()
      let timer = null
      let rejectControl
      const control = new Promise((_resolve, reject) => { rejectControl = reject })
      const cancel = (error) => {
        if (controller.signal.aborted) return
        controller.abort(error)
        rejectControl(error)
      }
      const onAbort = () => cancel(makeAbortError('皮肤配置写入已取消'))
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => cancel(makeAbortError('皮肤配置写入超时')), timeout)
      try {
        return await Promise.race([
          jsonFetch('/config', {
            method: 'PUT', body: JSON.stringify({ patch: { uiSkin: normalizeSkin(skin) } }),
            signal: controller.signal,
          }),
          control,
        ])
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
    }
    const fetchWithDeadline = async (url, init, { signal, timeout = 8000 } = {}) => {
      const controller = new AbortController()
      const abort = () => controller.abort(signal?.reason)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      const timer = setTimeout(() => controller.abort(makeAbortError('配置请求超时')), timeout)
      try {
        return await fetch(url, { ...init, signal: controller.signal })
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
    }
    const activateConfiguredSkin = (skin, options = {}) => {
      const next = normalizeSkin(skin)
      if (next === 'endfield-aic' && !aicBootEl) aicBootShow('CONNECTING TERMINAL')
      return setSkin(next, options)
    }
    const loadConfiguredSkin = async ({ signal, generation, skinEpoch, hostSyncGeneration }) => {
      const assertCurrent = () => {
        assertConfiguredSkinActive(generation, signal, skinEpoch, hostSyncGeneration)
      }
      let resolved = null
      if (typeof fetch === 'function') {
        try {
          const response = await fetchWithDeadline('/prts-corpus/ui-skin.json', { cache: 'no-store' }, { signal })
          assertCurrent()
          if (response.ok) {
            const payload = await waitWithDeadline(response.json(), {
              signal, timeout: 3000, label: '皮肤配置解析',
            })
            assertCurrent()
            resolved = await activateConfiguredSkin(payload?.uiSkin, { assertCurrent })
          }
        } catch (error) {
          if (signal?.aborted || generation !== applyGeneration
              || skinEpoch !== skinOperationEpoch
              || hostSyncGeneration !== hostSkinSyncGeneration) throw makeAbortError()
          console.error('[prts-terrarchive] skin endpoint activation failed', error)
        }
      }
      if (resolved === null) {
        try {
          const status = await waitWithDeadline(jsonFetch('/status'), {
            signal, timeout: 10000, label: '皮肤配置 RPC',
          })
          assertCurrent()
          resolved = await activateConfiguredSkin(status?.config?.uiSkin, { assertCurrent })
        } catch (error) {
          if (error?.name === 'AbortError') throw error
          // 配置通道失败时立即撤下开机场，回退到当前界面，绝不能把 boot 屏留在原地。
          aicBootAbort()
          throw error
        }
      }
      assertCurrent()
      // setSkin 已在 stylesheet 提交后写入；这里用最终解析值再次校准启动缓存。
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
        // React props/state may still describe the previous render. The module
        // owner is the synchronous de-duplication lock; even clicking the item
        // that appears selected must be allowed to confirm Host config and
        // invalidate an unresolved startup/status snapshot.
        if (skinSelectionOwner) return
        const selectionOwner = {}
        skinSelectionOwner = selectionOwner
        beginHostSkinSync()
        const operationEpoch = ++skinOperationEpoch
        pendingSkinOperations.add(selectionOwner)
        setSaving(true)
        setMessage(null)
        const previous = activeSkin
        const normalizedNext = normalizeSkin(next)
        const changesRuntime = normalizedNext !== activeSkin
        // 切肤开机场：终末地等地图就绪后由 aicBootDone 撤下，其它皮肤短暂过渡后立即收尾。
        // 重申当前 Host 值不重启开机场；AIC runtime 已就绪时不会产生新的
        // map-ready 事件，若重启遮罩只能等待 watchdog。
        const bootToken = changesRuntime ? aicBootShow(normalizedNext === 'endfield-aic'
          ? 'REBUILDING INTERFACE' : 'SWITCHING SKIN', true) : 0
        let hostCommitted = false
        try {
          // CSS 先 ready，Host 确认后再同步提交本地运行时、移除旧 CSS 与写缓存。
          await setSkin(next, { beforeCommit: async () => {
            await writeSkinConfig(next)
            hostCommitted = true
          } })
          if (operationEpoch !== skinOperationEpoch) return
          onChanged(normalizedNext)
          if (normalizedNext !== 'endfield-aic') {
            if (changesRuntime) aicBootDone(bootToken)
            // activeSkin 仍是 Harness 但迟到的启动快照可能已经展示 AIC
            // 遮罩。此时没有本次过渡可淡出，必须立即撤下旧 owner。
            else aicBootAbort(true)
          }
        } catch (error) {
          let reportedError = error
          // 只有 Host 已接受而本地最终提交失败时才需要补偿写；常见的 PUT
          // 失败已经由 setSkin 在旧 CSS 仍在时完成纯本地回滚。
          if (hostCommitted && operationEpoch === skinOperationEpoch) {
            try {
              await writeSkinConfig(previous)
            } catch (rollbackError) {
              console.error('[prts-terrarchive] failed to roll back host skin config', rollbackError)
              reportedError = new Error(`${error?.message ?? String(error)}；Host 配置回滚失败：${rollbackError?.message ?? String(rollbackError)}`)
            }
          }
          if (operationEpoch === skinOperationEpoch) {
            aicBootAbort()
            setMessage(reportedError?.message ?? String(reportedError))
          }
        } finally {
          // 让选择期间发出的旧 status 请求失效；成功与回滚都以此处状态为准。
          pendingSkinOperations.delete(selectionOwner)
          if (skinOperationEpoch === operationEpoch) {
            skinOperationEpoch += 1
            setSaving(false)
          }
          if (skinSelectionOwner === selectionOwner) skinSelectionOwner = null
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
      const [skin, setSkinState] = useState(() => activeSkin)
      const aliveRef = useRef(true)
      const statusInFlightRef = useRef(false)
      const hostSyncRef = useRef(0)

      const beginStatusSync = useCallback(() => {
        const generation = beginHostSkinSync()
        hostSyncRef.current = generation
        return generation
      }, [])

      const commitStatusSkin = useCallback(async (nextStatus, syncGeneration,
        observedSkinEpoch, repairSame = false) => {
        const assertCurrent = () => {
          if (!aliveRef.current || pendingSkinOperations.size !== 0
              || observedSkinEpoch !== skinOperationEpoch) throw makeAbortError()
          assertHostSkinSyncActive(syncGeneration)
        }
        assertCurrent()
        setStatus(nextStatus)
        const nextSkin = normalizeSkin(nextStatus?.config?.uiSkin)
        const committedSkin = nextSkin === activeSkin && !repairSame
          ? nextSkin : await setSkin(nextSkin, { assertCurrent })
        assertCurrent()
        setSkinState(committedSkin)
        // A stale startup AIC request may already have mounted its boot screen.
        // Host-driven non-AIC snapshots have no transition to finish it, so
        // retire that overlay only after this newest snapshot is committed.
        if (committedSkin !== 'endfield-aic') aicBootAbort()
        return committedSkin
      }, [])

      const refreshStatus = useCallback(async () => {
        if (statusInFlightRef.current || pendingSkinOperations.size !== 0
            || (typeof document !== 'undefined' && document.hidden)) return
        const observedSkinEpoch = skinOperationEpoch
        const syncGeneration = beginStatusSync()
        statusInFlightRef.current = true
        try {
          const nextStatus = await jsonFetch('/status')
          await commitStatusSkin(nextStatus, syncGeneration, observedSkinEpoch, false)
          assertHostSkinSyncActive(syncGeneration)
          setError(null)
        } catch (caught) {
          if (aliveRef.current && syncGeneration === hostSkinSyncGeneration
              && caught?.name !== 'AbortError') setError(caught.message)
        } finally {
          statusInFlightRef.current = false
        }
      }, [beginStatusSync, commitStatusSkin])

      const refresh = useCallback(async () => {
        const observedSkinEpoch = skinOperationEpoch
        const syncGeneration = beginStatusSync()
        try {
          const [nextStatus, nextReleases] = await Promise.all([
            jsonFetch('/status'), jsonFetch('/releases'),
          ])
          await commitStatusSkin(nextStatus, syncGeneration, observedSkinEpoch, true)
          assertHostSkinSyncActive(syncGeneration)
          setReleaseList(nextReleases)
          setError(null)
        } catch (caught) {
          if (aliveRef.current && syncGeneration === hostSkinSyncGeneration
              && caught?.name !== 'AbortError') setError(caught.message)
        }
      }, [beginStatusSync, commitStatusSkin])

      useEffect(() => {
        aliveRef.current = true
        void refresh()
        const onVisibility = () => { if (!document.hidden) void refreshStatus() }
        const timer = setInterval(() => { void refreshStatus() }, 2000)
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          aliveRef.current = false
          if (hostSyncRef.current === hostSkinSyncGeneration) beginHostSkinSync()
          hostSyncRef.current = 0
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
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

      const onSkinChanged = useCallback((next) => {
        setSkinState(next)
        setStatus((previous) => previous ? { ...previous,
          config: { ...(previous.config ?? {}), uiSkin: next } } : previous)
      }, [])

      return h('div', { style: S.wrap, className: 'prts-settings-wrap' },
        error && h('div', { style: { ...S.card, ...S.error } }, error),
        h(SkinCard, { skin, onChanged: onSkinChanged }),
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
    const MAP_RUNTIME_ABI = 2
    let mapBundlePromise = null
    let cancelMapBundleLoad = null
    let loadedMapRuntime = null
    const validMapRuntime = (runtime) => runtime?.RUNTIME_ABI === MAP_RUNTIME_ABI
      && typeof runtime.createRegionMap === 'function'
    const ensureMapBundle = () => {
      if (validMapRuntime(globalThis.__PRTS_ENDFIELD_MAP__)) {
        loadedMapRuntime = globalThis.__PRTS_ENDFIELD_MAP__
        return Promise.resolve(loadedMapRuntime)
      }
      // 未标 ABI 的旧 bundle 不得跨 HMR 复用。
      if (globalThis.__PRTS_ENDFIELD_MAP__) delete globalThis.__PRTS_ENDFIELD_MAP__
      if (mapBundlePromise) return mapBundlePromise
      let currentPromise
      let cancelCurrentLoad = null
      const pending = new Promise((resolve, reject) => {
        const script = document.createElement('script')
        script.src = `/prts-corpus/endfield-map/map.js?abi=${MAP_RUNTIME_ABI}`
        script.async = true
        let settled = false
        let loadTimer = null
        const finish = (callback, value) => {
          if (settled) return
          settled = true
          if (loadTimer !== null) clearTimeout(loadTimer)
          script.onload = null
          script.onerror = null
          script.remove()
          callback(value)
        }
        cancelCurrentLoad = (error = makeAbortError('地图模块加载已取消')) => finish(reject, error)
        cancelMapBundleLoad = cancelCurrentLoad
        script.onload = () => {
          const runtime = globalThis.__PRTS_ENDFIELD_MAP__
          if (!validMapRuntime(runtime)) {
            if (globalThis.__PRTS_ENDFIELD_MAP__ === runtime) {
              delete globalThis.__PRTS_ENDFIELD_MAP__
            }
            loadedMapRuntime = null
            finish(reject, new Error(`地图模块 ABI 不兼容（需要 ${MAP_RUNTIME_ABI}）`))
            return
          }
          loadedMapRuntime = runtime
          finish(resolve, runtime)
        }
        script.onerror = () => finish(reject, new Error('地图模块加载失败'))
        document.head.appendChild(script)
        // 订阅者超时只取消自己的等待；底层也必须有 watchdog，否则一次既不
        // load 也不 error 的 script 会把后续所有 AIC 重挂永久钉在同一 pending。
        loadTimer = setTimeout(() => {
          cancelCurrentLoad(new Error('地图模块加载超时'))
        }, 45000)
      })
      currentPromise = pending.finally(() => {
        if (mapBundlePromise === currentPromise) mapBundlePromise = null
        if (cancelMapBundleLoad === cancelCurrentLoad) cancelMapBundleLoad = null
      })
      mapBundlePromise = currentPromise
      return currentPromise
    }
    const loadMapBundle = (signal) => {
      if (signal?.aborted) return Promise.reject(makeAbortError('地图加载已取消'))
      // script 是同一插件实例内的共享加载任务。组件卸载只取消自己的等待，
      // 不移除共享 script；否则快速切肤/slot 重挂会让旧实例误伤新实例。
      return waitWithDeadline(ensureMapBundle(), {
        signal, timeout: 50000, label: '地图模块加载',
      })
    }

    function AicMap({ focusPoint = .66 }) {
      const host = useRef(null)
      const mapRef = useRef(null)
      const focusPointRef = useRef(focusPoint)
      focusPointRef.current = focusPoint
      const [status, setStatus] = useState('MAP_ASSET_SYNC 0%')
      const [stats, setStats] = useState({ cx: 0, cy: 0, size: 0, fps: 0, meshes: 0, tris: 0 })
      const [positions, setPositions] = useState([])
      const [selected, setSelected] = useState(null)
      const [regions, setRegions] = useState([])
      useEffect(() => {
        let disposed = false
        const controller = new AbortController()
        const bootToken = aicBootEpoch
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
        modalObserver.observe(document.body, { childList: true, subtree: true, attributes: true,
          attributeFilter: ['aria-modal', 'role'] })
        syncModalState()
        void loadMapBundle(controller.signal).then(async (runtime) => {
          if (disposed || !host.current) return
          setRegions(runtime.REGION_LIST ?? [])
          const map = await runtime.createRegionMap(host.current, {
            signal: controller.signal,
            focusPoint: focusPointRef.current,
            onProgress: (progress, message) => {
              if (disposed) return
              setStatus(progress < 0 ? `ERROR // ${message}` : `MAP_ASSET_SYNC ${progress}% // ${message}`)
              // 开机场加载屏由地图真实进度驱动；失败时停留片刻再撤下，露出页面内的错误状态。
              if (progress < 0) {
                aicBootProgress(-1, message, bootToken)
                aicBootSchedule(() => aicBootDone(bootToken, false), 2500, bootToken)
              } else aicBootProgress(progress, message, bootToken)
            },
            onStats: (value) => { if (!disposed) setStats(value) },
            onSelectLv: (value) => { if (!disposed) setSelected(value) },
            onRegionPositions: (value) => { if (!disposed) setPositions(value) },
          })
          if (disposed) map.dispose()
          else {
            // 装载期间响应式布局可能已变宽；应用最新值，不能丢掉那次更新。
            map.setFocusPoint?.(focusPointRef.current)
            mapRef.current = map
            syncMapActivity()
            setStatus('')
            aicBootDone(bootToken)
          }
        }).catch((error) => {
          if (disposed || error?.name === 'AbortError') return
          const message = error?.message || '地图加载失败'
          setStatus(`ERROR // ${message}`)
          aicBootProgress(-1, message, bootToken)
          aicBootSchedule(() => aicBootDone(bootToken, false), 2500, bootToken)
        })
        return () => {
          disposed = true
          controller.abort(makeAbortError('AIC 地图已卸载'))
          document.removeEventListener('visibilitychange', syncMapActivity)
          globalThis.removeEventListener('prts-shell-visibility', syncMapActivity)
          modalObserver.disconnect()
          document.body.classList.remove('aic-modal-open')
          mapRef.current?.dispose()
          mapRef.current = null
        }
      }, [])
      useEffect(() => {
        focusPointRef.current = focusPoint
        mapRef.current?.setFocusPoint?.(focusPoint)
      }, [focusPoint])
      const positionByLv = Object.fromEntries(positions.map((item) => [item.lv, item]))
      return h(Fragment, null,
        h('div', { ref: host, className: 'aic-map' }),
        status && h('div', { className: `aic-map-status${status.startsWith('ERROR') ? ' error' : ''}` }, status),
        ...regions.map((region) => {
          const point = positionByLv[region.lv]
          if (!point?.visible) return null
          return h('button', { key: region.lv, type: 'button',
            className: `aic-region-label${selected === region.lv ? ' selected' : ''}`,
            'aria-pressed': selected === region.lv,
            'aria-label': `查看区域：${region.name}（${region.lv.toUpperCase()}）`,
            onClick: () => {
              mapRef.current?.setSelected?.(region.lv)
              mapRef.current?.focusLv?.(region.lv)
              setSelected(region.lv)
            },
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
        h('div', { className: 'aic-hud aic-hud-br' },
          'DRAG/方向键 平移 // WHEEL/+/- 缩放 // TAB 区域按钮'),
        h('button', { type: 'button', className: 'aic-map-reset', onClick: () => mapRef.current?.resetView(),
          title: '重置地图视角' }, 'RESET_VIEW'))
    }

    const aicViewportWidth = () => Math.max(1,
      globalThis.document?.documentElement?.clientWidth || globalThis.innerWidth || 1)
    const aicBandRange = (viewportWidth) => {
      if (viewportWidth <= 980) {
        const fixed = Math.min(720, viewportWidth)
        return { min: fixed, max: fixed, preferred: fixed }
      }
      const max = Math.max(320, Math.min(1200, viewportWidth - 320))
      const min = Math.min(520, max)
      const preferred = Math.max(min, Math.min(max, 960, Math.max(760, viewportWidth * .46),
        viewportWidth - 360))
      return { min, max, preferred }
    }

    function AicRoot({ useSessions }) {
      // useSessions 由 ui-session 的 provideRoot 提供给 root 槽位；不含该包的
      // 组合下为 undefined——历史抽屉退化为空列表，新建对话仍走 sessions 服务。
      const sessions = useSessions?.((snapshot) => snapshot)
        ?? { ids: [], byId: {}, current: undefined }
      const [historyOpen, setHistoryOpen] = useState(false)
      const [clock, setClock] = useState(() => new Date())
      const [viewportWidth, setViewportWidth] = useState(aicViewportWidth)
      const bandRange = aicBandRange(viewportWidth)
      const defaultBandWidth = bandRange.preferred
      const [chatBandWidth, setChatBandWidth] = useState(defaultBandWidth)
      const [chatResizeActive, setChatResizeActive] = useState(false)
      const stopChatResizeRef = useRef(null)
      const historyButtonRef = useRef(null)
      const historyDrawerRef = useRef(null)
      useEffect(() => {
        let timer = null
        const syncClock = () => {
          if (timer !== null) clearInterval(timer)
          timer = null
          if (!document.hidden) {
            setClock(new Date())
            timer = setInterval(() => setClock(new Date()), 1000)
          }
        }
        document.addEventListener('visibilitychange', syncClock)
        syncClock()
        return () => {
          document.removeEventListener('visibilitychange', syncClock)
          if (timer !== null) clearInterval(timer)
        }
      }, [])
      useEffect(() => {
        const resize = () => {
          const width = aicViewportWidth()
          const range = aicBandRange(width)
          setViewportWidth(width)
          setChatBandWidth((currentWidth) => Math.max(range.min, Math.min(range.max, currentWidth)))
        }
        globalThis.addEventListener('resize', resize)
        globalThis.visualViewport?.addEventListener('resize', resize)
        resize()
        return () => {
          globalThis.removeEventListener('resize', resize)
          globalThis.visualViewport?.removeEventListener('resize', resize)
        }
      }, [])
      useEffect(() => {
        document.body.style.setProperty('--prts-aic-band-width', `${chatBandWidth}px`)
        return () => { document.body.style.removeProperty('--prts-aic-band-width') }
      }, [chatBandWidth])
      useEffect(() => () => { stopChatResizeRef.current?.() }, [])
      const current = sessions.current
      const currentSummary = current === undefined ? undefined : sessions.byId[current]
      const currentTitle = currentSummary?.title || (currentSummary?.blank ? '新会话' : 'AIC_TERMINAL')
      const sessionRows = useMemo(() => sessions.ids.map((id) => sessions.byId[id]).filter(Boolean),
        [sessions.ids, sessions.byId])
      useEffect(() => {
        if (!historyOpen) return undefined
        const drawer = historyDrawerRef.current
        const previousFocus = document.activeElement
        const focusables = () => [...(drawer?.querySelectorAll(
          'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ) ?? [])]
        focusables()[0]?.focus()
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setHistoryOpen(false)
            return
          }
          if (event.key !== 'Tab') return
          const items = focusables()
          if (!items.length) { event.preventDefault(); return }
          const first = items[0]
          const last = items[items.length - 1]
          if (!drawer?.contains(document.activeElement)) {
            event.preventDefault()
            ;(event.shiftKey ? last : first).focus()
          } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault(); last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault(); first.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('keydown', onKeyDown)
          if (typeof previousFocus?.focus === 'function' && previousFocus.isConnected) previousFocus.focus()
          else historyButtonRef.current?.focus()
        }
      }, [historyOpen])
      const newSession = () => {
        const options = currentSummary?.cwd ? { cwd: currentSummary.cwd } : {}
        void clientContext?.sessions?.create(options)
          .then((sessionId) => { clientContext?.sessions?.open(sessionId) })
          .catch((error) => console.error('[prts-terrarchive] failed to create session', error))
      }
      const openSettings = () => {
        const trigger = document.querySelector(
          '[data-slot="sidebar.settings"] button[aria-haspopup="dialog"]')
        if (trigger instanceof HTMLElement) trigger.click()
      }
      const startChatResize = (event) => {
        if (viewportWidth <= 980) return
        event.preventDefault()
        stopChatResizeRef.current?.()
        setChatResizeActive(true)
        document.body.classList.add('aic-chat-resizing')
        const resize = (moveEvent) => {
          const range = aicBandRange(aicViewportWidth())
          setChatBandWidth(Math.max(range.min, Math.min(range.max, moveEvent.clientX)))
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
      const resizeChatWithKeyboard = (event) => {
        if (viewportWidth <= 980) return
        let next = null
        if (event.key === 'ArrowLeft') next = chatBandWidth - 24
        else if (event.key === 'ArrowRight') next = chatBandWidth + 24
        else if (event.key === 'Home') next = bandRange.min
        else if (event.key === 'End') next = bandRange.max
        if (next === null) return
        event.preventDefault()
        setChatBandWidth(Math.max(bandRange.min, Math.min(bandRange.max, next)))
      }
      const focusPoint = Math.max(.55, Math.min(.86,
        .66 + (chatBandWidth - defaultBandWidth) / (Math.max(1, viewportWidth) * 2)))
      return h('main', { className: 'aic-root', style: {
        '--aic-band-width': `${chatBandWidth}px`,
        '--prts-aic-band-width': `${chatBandWidth}px`,
      } },
        h(AicMap, { focusPoint }),
        h('section', { className: 'aic-chat-band' },
          h('div', { className: 'aic-band-backdrop', 'aria-hidden': 'true' }),
          h('div', { className: 'aic-chat-resize', role: 'separator', tabIndex: 0,
            title: '拖动或使用左右方向键调整聊天区域宽度',
            'aria-label': '调整聊天区域宽度', 'aria-orientation': 'vertical',
            'aria-valuemin': Math.round(bandRange.min), 'aria-valuemax': Math.round(bandRange.max),
            'aria-valuenow': Math.round(chatBandWidth), onKeyDown: resizeChatWithKeyboard,
            onPointerDown: startChatResize }),
          h('section', { className: 'aic-start-brand', 'aria-hidden': 'true' },
            h('div', { className: 'aic-start-wordmark' }, 'PRTS'),
            h('div', { className: 'aic-start-submark' },
              h('s', null, 'PRIMITIVE RHODES ISLAND TERMINAL SERVICE'), ' // PRIES—???'),
            h('h2', null, '想从泰拉的故事里了解什么？'),
            h('p', null, '我会先检索线索，再回到本地资料逐行核验，并把可复查的原文放在回答旁边。')),
          h('div', { className: 'aic-terminal-overlay' },
            h('div', { className: 'aic-terminal-name' }, h('i', { className: 'aic-terminal-dot' }),
              h('span', { title: currentTitle }, currentTitle),
              h('small', { className: 'aic-terminal-ver' }, 'V9.2 // WULING_NODE')),
            h('button', { type: 'button', className: 'aic-band-btn aic-settings-trigger',
              onClick: openSettings }, '设置'),
            h('button', { ref: historyButtonRef, type: 'button',
              className: `aic-band-btn${historyOpen ? ' on' : ''}`,
              'aria-expanded': historyOpen, 'aria-controls': 'aic-session-archive',
              onClick: () => setHistoryOpen((value) => !value) }, '◷ 历史记录'),
            h('button', { type: 'button', className: 'aic-band-btn', onClick: newSession }, '＋ 新建对话'))),
        chatResizeActive && h('div', { className: 'aic-chat-resize-line',
          style: { left: `${chatBandWidth}px` } }),
        h('div', { className: 'aic-hud aic-hud-tr' },
          h('span', { className: 'aic-clock' }, clock.toLocaleTimeString('zh-CN', { hour12: false }))),
        historyOpen && h(Fragment, null,
          h('div', { className: 'aic-drawer-scrim', 'aria-hidden': 'true',
            onPointerDown: (event) => { event.preventDefault(); setHistoryOpen(false) } }),
          h('aside', { ref: historyDrawerRef, id: 'aic-session-archive',
            className: 'aic-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': '历史会话' },
          h('header', { className: 'aic-drawer-head' }, h('span', null, 'SESSION_ARCHIVE'),
            h('button', { type: 'button', className: 'aic-close', 'aria-label': '关闭历史会话',
              onClick: () => setHistoryOpen(false) }, '×')),
          h('button', { type: 'button', className: 'aic-band-btn', onClick: newSession }, '＋ 新建对话'),
          h('div', { className: 'aic-session-list' }, sessionRows.length
            ? sessionRows.map((session) => h('button', { type: 'button', key: session.id,
              className: `aic-session${session.id === current ? ' active' : ''}`,
              'aria-current': session.id === current ? 'page' : undefined,
              onClick: () => { clientContext?.sessions?.open(session.id); setHistoryOpen(false) } },
            h('b', null, session.title || (session.blank ? '新会话' : `会话_${String(session.id).slice(0, 6)}`)),
            h('small', null, `${session.blank ? 'STANDBY' : 'ARCHIVED'} // ${new Date(session.updatedAt).toLocaleString('zh-CN')}`)))
            : h('div', { className: 'aic-empty' }, 'NO SESSION RECORDS'))))
        )
    }

    syncAicLayout = () => {
      if (!clientContext) return
      if (activeSkin !== 'endfield-aic') {
        if (disposeAicLayout) disposeAicLayout()
        disposeAicLayout = null
        return
      }
      if (disposeAicLayout) return
      const owner = clientContext
      // shell.overlay 由 ui-layout 的 root entry 动态声明。inject 会等待声明，
      // declaration collapse 时卸载，并在 owner HMR 重挂后自动重新注册。
      const disposeInjection = owner.slots.inject('shell.overlay', () => {
        if (activeSkin !== 'endfield-aic' || clientContext !== owner) return () => {}
        return owner.slots.register({
          name: 'shell.overlay', id: 'prts-aic-shell', order: -100,
        }, AicRoot)
      })
      disposeAicLayout = () => { disposeInjection() }
    }

    /* ---- 插件入口：Settings → Plugins 的「PRTS 语料」tab ---- */
    exports.__sceneStateForTest = { buildSceneSnapshotModel, sceneSnapshotSignature }
    exports.__skinStateForTest = {
      setSkin, writeSkinConfig, SkinCard, PrtsSection,
      finishAicBoot: () => aicBootDone(),
      getActiveSkin: () => activeSkin,
      getHostSkinSyncGeneration: () => hostSkinSyncGeneration,
    }
    exports.inject = ['slots', 'connection', 'theme', 'sessions']

    exports.apply = (ctx) => {
      // A replacement apply must invalidate and cancel the previous owner's
      // asynchronous skin transaction before installing its own stylesheet owner.
      clientAbortController?.abort(makeAbortError('PRTS 浏览器插件已被新实例替换'))
      skinApplyEpoch += 1
      skinOperationEpoch += 1
      beginHostSkinSync()
      pendingSkinOperations.clear()
      skinSelectionOwner = null
      // Retire runtime handles while they still point at the previous context.
      // Otherwise a truthy old AIC disposer makes syncAicLayout() skip mounting
      // the shell into the replacement slot owner, and old theme tokens can leak
      // when the new context exposes a different theme runtime.
      if (disposeAicLayout) disposeAicLayout()
      disposeAicLayout = null
      if (disposeScene) disposeScene()
      disposeScene = null
      if (removeSkinTokens) removeSkinTokens()
      removeSkinTokens = null
      activeSkin = 'harness'
      writeSkinDataset('harness')
      aicBootAbort(true)
      const generation = ++applyGeneration
      const controller = new AbortController()
      clientAbortController = controller
      clientContext = ctx
      themeRuntime = ctx.theme
      if (typeof document !== 'undefined') {
        ctx.effect(installSkinStylesheets, 'prts-corpus: skin stylesheets')
      }
      const instanceCallApi = async (endpoint, payload, signal) => {
        const result = await ctx.connection.rpc.call('/prts-corpus', endpoint, payload, signal)
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      }
      callApi = instanceCallApi
      ctx.effect(() => () => {
        controller.abort(makeAbortError('PRTS 浏览器插件已卸载'))
        if (generation !== applyGeneration) return
        applyGeneration += 1
        skinOperationEpoch += 1
        skinApplyEpoch += 1
        beginHostSkinSync()
        if (disposeAicLayout) disposeAicLayout()
        disposeAicLayout = null
        if (disposeScene) disposeScene()
        disposeScene = null
        clientContext = null
        themeRuntime = null
        if (clientAbortController === controller) clientAbortController = null
        if (callApi === instanceCallApi) callApi = null
        if (removeSkinTokens) removeSkinTokens()
        removeSkinTokens = null
        activeSkin = 'harness'
        pendingSkinOperations.clear()
        skinSelectionOwner = null
        writeSkinDataset('harness')
        aicBootAbort(true)
        if (loadedMapRuntime && globalThis.__PRTS_ENDFIELD_MAP__ === loadedMapRuntime) {
          delete globalThis.__PRTS_ENDFIELD_MAP__
        }
        loadedMapRuntime = null
        cancelMapBundleLoad?.()
        cancelMapBundleLoad = null
        mapBundlePromise = null
      }, 'prts-corpus: skin cleanup')
      ctx.effect(() => ctx.slots.inject('settings.plugins.tab',
        () => ctx.slots.register(
          { name: 'settings.plugins.tab', id: 'prts-corpus', label: 'PRTS 语料', order: 60 },
          PrtsSection)), 'prts-corpus: settings plugins tab')
      ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities',
        () => ctx.slots.register(
          { name: 'conversation.session.header.utilities', id: 'prts-evidence', order: 18 },
          EvidenceControl)), 'prts-corpus: evidence header control')
      // 从 apply 内接管启动屏，使 DOM、计时器和背景都归当前 Cordis fiber 所有。
      try {
        if (typeof localStorage !== 'undefined' && localStorage.getItem(AIC_BOOT_KEY) === 'endfield-aic') {
          console.info('[prts-terrarchive] boot takeover: cached endfield skin, showing AIC loading screen')
          aicBootShow('CONNECTING TERMINAL')
        }
      } catch { /* 隐私模式等无 localStorage 环境：退回默认启动屏 */ }
      const configuredSkinEpoch = skinOperationEpoch
      const configuredHostSyncGeneration = beginHostSkinSync()
      void loadConfiguredSkin({ signal: controller.signal, generation,
        skinEpoch: configuredSkinEpoch,
        hostSyncGeneration: configuredHostSyncGeneration }).catch((error) => {
        if (error?.name === 'AbortError' || generation !== applyGeneration) return
        console.error('[prts-terrarchive] failed to activate configured skin', error)
        aicBootAbort(true)
      })
    }

    return module.exports
  },
})
