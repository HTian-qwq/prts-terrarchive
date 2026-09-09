#!/usr/bin/env node
/**
 * prts-terrarchive 一键安装脚本。
 *
 * 用法：
 *   node bin/install.js web                 # 从当前插件源码目录安装
 *   node bin/install.js web /path/to/pkg    # 安装指定本地目录或压缩包
 *   node bin/install.js web --preset-only   # 打包器已放置插件，只生成/迁移预设
 *
 * 环境变量：
 *   DSH_HOME   宿主根目录（缺省 ~/.dsh）；DSH 插件命令（缺省 dsh）
 *
 * 做什么：
 *   1) 把插件加入 profile（dsh plugin add）
 *   2) 创建 PRTS 用户预设（$DSH_HOME/.agent-presets/prts/*），让模式下拉出现
 *      「PRTS 模式」，且只有选中它的会话才加载语料工具
 *   3) 打印后续指引（如何设为默认模式）
 *
 * 说明：资料管理（设置页 /api + UI）由插件 host 常驻提供；语料三工具由
 * PRTS 预设加载——标准/极简等其它模式不加载 PRTS 工具。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(here, '..')
const packageMetadata = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const argv = process.argv.slice(2)
const presetOnly = argv.includes('--preset-only')
const knownFlags = new Set(['--preset-only'])
const unknownFlag = argv.find((arg) => arg.startsWith('-') && !knownFlags.has(arg))
if (unknownFlag) throw new Error(`未知选项：${unknownFlag}`)
const positionalArgs = argv.filter((arg) => !knownFlags.has(arg))
if (positionalArgs.length > 2) throw new Error('位置参数过多')
const profile = positionalArgs[0] || 'web'
if (profile.toLowerCase() === 'desktop' && !presetOnly) {
  throw new Error('官方 DSH Desktop 的 desktop profile 由应用管理，请在桌面插件管理窗口安装 prts-terrarchive；npm 发布前请使用 Web 本地安装或 Portable。--preset-only 仅供已放置插件的发行版打包器使用。')
}
const pkg = positionalArgs[1] ? resolve(positionalArgs[1]) : packageDir
if (!presetOnly && !existsSync(pkg)) {
  throw new Error(`本地插件目录或压缩包不存在：${pkg}`)
}
if (!profile || profile === '.' || profile === '..' || profile === 'node_modules'
    || profile.startsWith('-') || profile.includes('/') || profile.includes('\\')
    || /[\u0000-\u001f\u007f]/u.test(profile)) {
  throw new Error(`DSH profile 名称非法：${JSON.stringify(profile)}`)
}
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const dshCmd = process.env.DSH || 'dsh'

const PRESET_ID = 'prts'
const presetDir = join(dshHome, '.agent-presets', PRESET_ID)
const compositionPath = join(presetDir, 'agent.cordis.yml')
const metadataPath = join(presetDir, 'preset.yml')

// 预设组合：以 bare 包名加载本插件（dsh plugin add 安装后即可解析，可移植），
// 注册语料工具（registerTools:true）；registerUi:false 让资料管理 API/设置 UI
// 归 host 常驻那份，预设只注册工具，避免重复注册 /api/prts-corpus 路由。
const bundledPreset = join(packageDir, 'presets', PRESET_ID)
const PRESET_COMPOSITION = readFileSync(join(bundledPreset, 'agent.cordis.yml'), 'utf8')
const PRESET_METADATA = readFileSync(join(bundledPreset, 'preset.yml'), 'utf8')

function run(cmd, args) {
  if (process.platform === 'win32') {
    // dsh 在 Windows 上通常是 .cmd，必须经 shell 执行；此时 execFileSync 会把
    // 参数拼成一条命令行，含空格的路径用双引号包裹。cmd.exe 的引用规则无法
    // 在双引号内屏蔽 %VAR% 展开与 & | < > ^ 等元字符——与其静默炸裂，不如
    // 预检后明确报错，让用户换路径或用 DSH 环境变量指向 dsh.cmd 绝对路径。
    const unsafe = /[\r\n%!&|<>^"]/
    for (const value of [cmd, ...args]) {
      if (unsafe.test(String(value))) {
        throw new Error(
          `Windows cmd 无法安全传递含特殊字符的参数：「${value}」。` +
          '请把插件放到不含换行及 % ! & | < > ^ " 的路径后重试，或设置环境变量 DSH 指向 dsh.cmd 的绝对路径。')
      }
    }
    const quote = (value) => `"${String(value)}"`
    execFileSync(quote(cmd), args.map(quote), {
      stdio: 'inherit', shell: true, env: process.env,
    })
    return
  }
  execFileSync(cmd, args, { stdio: 'inherit', env: process.env })
}

const CONFIG_KEY = /^ {2}(?:config|'config'|"config")[ \t]*:/u
const BLOCK_CONFIG = /^ {2}(?:config|'config'|"config")[ \t]*:[ \t]*(?:#[^\r\n]*)?\r?$/u
const ENABLED_GAMES_KEY = /^ {4}(?:enabledGames|'enabledGames'|"enabledGames")[ \t]*:/u

function presetEntryEnd(lines, start) {
  // YAML mapping key order is not fixed: the next plugin may start with name,
  // config, or an anchor. Any top-level sequence item ends this entry's scope.
  const next = lines.findIndex((line, index) => index > start && /^-(?:\s|$)/u.test(line))
  return next < 0 ? lines.length : next
}

function isStandardBlockConfig(lines, configIndex, end) {
  if (!BLOCK_CONFIG.test(lines[configIndex])) return false
  for (let index = configIndex + 1; index < end; index += 1) {
    if (/^\s*(?:#.*)?$/u.test(lines[index])) continue
    const indentation = /^ */u.exec(lines[index])[0].length
    // 不把自定义缩进中的字段挤到安装器使用的四空格层级。
    return indentation <= 2 || indentation === 4
  }
  return true
}

// 只改安装器使用的块映射；用户写成行内映射、alias 或 anchor 时保留原文。
// 在没有完整 YAML parser 的安装环境里，不能把不认识的写法当成缺失键。
/** 在已有 PRTS preset 中启用 DSH 安全 provider 支撑的 web_fetch，不触碰其他 entry。 */
function enableSafeWebFetch(composition) {
  const lines = composition.split('\n')
  const start = lines.findIndex((line) => /^- id: tool-web\s*$/.test(line))
  if (start < 0) return composition
  const end = presetEntryEnd(lines, start)
  const configIndex = lines.findIndex((line, index) => index > start && index < end
    && CONFIG_KEY.test(line))
  if (configIndex >= 0 && !isStandardBlockConfig(lines, configIndex, end)) return composition
  const fetchIndex = lines.findIndex((line, index) => index > start && index < end
    && /^ {4}(?:fetch|'fetch'|"fetch")[ \t]*:/u.test(line))
  if (fetchIndex >= 0) {
    lines[fetchIndex] = '    fetch: true'
    return lines.join('\n')
  }
  if (configIndex >= 0) lines.splice(configIndex + 1, 0, '    fetch: true')
  else lines.splice(end, 0, '  config:', '    fetch: true')
  return lines.join('\n')
}

/** 为安装器生成的双游戏云端 preset 显式固定本地资料范围。 */
function enableDualGameModules(composition) {
  const lines = composition.split('\n')
  const start = lines.findIndex((line) => /^- id: prts-corpus\s*$/.test(line))
  if (start < 0) return composition
  const end = presetEntryEnd(lines, start)
  const block = lines.slice(start, end)
  if (block.some((line) => ENABLED_GAMES_KEY.test(line))) return composition
  if (block.some((line) => CONFIG_KEY.test(line) && !BLOCK_CONFIG.test(line))) return composition
  const usesDefaultDualCloud = block.some((line) => /^\s{6}baseUrl:\s*https:\/\/prts\.chat\s*$/u.test(line))
    && block.some((line) => /^\s{6}game:\s*all\s*$/u.test(line))
  if (!usesDefaultDualCloud) return composition
  const registerUi = lines.findIndex((line, index) => index > start && index < end
    && /^\s{4}registerUi:\s*/u.test(line))
  const registerTools = lines.findIndex((line, index) => index > start && index < end
    && /^\s{4}registerTools:\s*/u.test(line))
  const insertAfter = registerUi >= 0 ? registerUi : registerTools
  if (insertAfter < 0) return composition
  lines.splice(insertAfter + 1, 0, '    enabledGames:', '      - arknights', '      - endfield')
  return lines.join('\n')
}

/** 让独立 Skill entry 与安装器生成的双模块工具 entry 使用同一基础范围。 */
function enableDualSkillModules(composition) {
  const lines = composition.split('\n')
  const start = lines.findIndex((line) => /^- id: prts-retrieval-skill\s*$/u.test(line))
  if (start < 0) return composition
  const end = presetEntryEnd(lines, start)
  if (lines.slice(start, end).some((line) => ENABLED_GAMES_KEY.test(line))) return composition
  const nameIndex = lines.findIndex((line, index) => index > start && index < end
    && /^\s{2}name:\s*prts-terrarchive\/skill\s*$/u.test(line))
  if (nameIndex < 0) return composition
  const configIndex = lines.findIndex((line, index) => index > start && index < end
    && CONFIG_KEY.test(line))
  if (configIndex >= 0) {
    if (!isStandardBlockConfig(lines, configIndex, end)) return composition
    lines.splice(configIndex + 1, 0, '    enabledGames:', '      - arknights', '      - endfield')
  } else {
    lines.splice(nameIndex + 1, 0, '  config:', '    enabledGames:',
      '      - arknights', '      - endfield')
  }
  return lines.join('\n')
}

function migrateLegacyCloudGame(composition) {
  const lines = composition.split('\n')
  const start = lines.findIndex((line) => /^- id: prts-corpus\s*$/u.test(line))
  if (start < 0) return composition
  const end = presetEntryEnd(lines, start)
  const entry = lines.slice(start, end).join('\n').replace(
    /(\s{4}cloud:\r?\n\s{6}baseUrl:\s*https:\/\/prts\.chat\r?\n\s{6}game:\s*)arknights\b/u,
    '$1all',
  )
  return [...lines.slice(0, start), entry, ...lines.slice(end)].join('\n')
}

console.log(`prts-terrarchive 一键安装 → profile「${profile}」`)

if (!presetOnly) {
  console.log('\n[1/2] 把插件加入 profile（dsh plugin add）…')
  try {
    run(dshCmd, ['plugin', '--profile', profile, 'add', pkg])
    console.log('  已加入。')
  } catch (error) {
    console.error(`  安装失败（${String(error?.message ?? error).split('\n')[0]}）。`)
    console.error(`  请修复后重试：${dshCmd} plugin --profile ${profile} add ${pkg}`)
    process.exitCode = 1
    throw error
  }
} else {
  console.log('\n[1/2] 插件实体由发行版管理，跳过 dsh plugin add。')
}

console.log('\n[2/2] 创建 PRTS 用户预设…')
mkdirSync(presetDir, { recursive: true })
// 各文件独立修复；已存在的组合只迁移本插件旧 guidance，并补齐网页工具和 Skill loader，
// 不覆盖其它用户改动。
if (!existsSync(compositionPath)) {
  writeFileSync(compositionPath, PRESET_COMPOSITION)
} else {
  const existing = readFileSync(compositionPath, 'utf8')
  let migrated = existing.replace(
    /- id: prts-corpus-guidance\r?\n\s+name: prts-terrarchive\/guidance/g,
    '- id: prts-retrieval-skill\n  name: prts-terrarchive/skill',
  )
  // 0.1.0-alpha.1 的官方预设曾把基础层锁死为 arknights，使新版
  // enabledGames 在无用户层配置时无法默认双游戏。只迁移本安装器生成的
  // 标准 baseUrl + game 片段；自定义云端地址和其他 preset 不受影响。
  migrated = migrateLegacyCloudGame(migrated)
  migrated = enableDualGameModules(migrated)
  migrated = enableSafeWebFetch(migrated)
  // Web 搜索 provider 留在 DSH Web host；preset 只需挂载稳定的模型工具。
  if (!/^- id: tool-web\s*$/m.test(migrated)) {
    const toolWeb = "- id: tool-web\n  name: '@deepseek-ai/dsh-tool-web'\n  config:\n    fetch: true\n    searchTimeoutMs: 60000\n"
    const toolSkillAnchor = /^- id: tool-skill\s*$/m
    const retrievalSkillAnchor = /^- id: prts-retrieval-skill\s*$/m
    migrated = toolSkillAnchor.test(migrated)
      ? migrated.replace(toolSkillAnchor, `${toolWeb}- id: tool-skill`)
      : retrievalSkillAnchor.test(migrated)
        ? migrated.replace(retrievalSkillAnchor, `${toolWeb}- id: prts-retrieval-skill`)
        : `${migrated.trimEnd()}\n${toolWeb}`
  }
  // DSH Web 把宿主层 tool-skill 禁用，由每个 agent preset 自行挂载。
  // 旧 PRTS preset 只有 Skill 注册项，没有 catalog/loader，模型看不到也无法加载 Skill。
  if (!/^- id: tool-skill\s*$/m.test(migrated)) {
    const toolSkill = "- id: tool-skill\n  name: '@deepseek-ai/dsh-tool-skill'\n"
    const skillAnchor = /^- id: prts-retrieval-skill\s*$/m
    migrated = skillAnchor.test(migrated)
      ? migrated.replace(skillAnchor, `${toolSkill}- id: prts-retrieval-skill`)
      : `${migrated.trimEnd()}\n${toolSkill}`
  }
  migrated = enableDualSkillModules(migrated)
  if (migrated !== existing) writeFileSync(compositionPath, migrated)
}
if (!existsSync(metadataPath)) writeFileSync(metadataPath, PRESET_METADATA)
console.log(`  已确保预设文件存在（仅自动迁移本插件旧检索指导）：${presetDir}`)

console.log('\n完成。重启 dsh 后：')
console.log('  · 设置 → 插件 →「PRTS 语料」= 资料管理（host 常驻，始终可进）')
console.log('  · 新建会话顶部的模式下拉选「PRTS 模式」→ 加载语料三工具')
console.log('  · 标准/极简等其它模式不加载 PRTS 工具')
console.log(`  · 以后执行 dsh plugin update 后，可运行本命令加 --preset-only 同步预设迁移`)
console.log(`  · 卸载：${dshCmd} plugin --profile ${profile} remove ${packageMetadata.name}`)
console.log(`  · 想让新会话默认就用 PRTS 模式：设置 → Agent 预设 → 设为默认`)
