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
const PRESET_NAME = 'PRTS 模式'
const PRESET_DESCRIPTION = '加载 PRTS.chat 本地与云端资料检索、DSH 网页搜索及对应检索策略。'
const PRESET_ORDER = 30
const presetDir = join(dshHome, '.agent-presets', PRESET_ID)
const compositionPath = join(presetDir, 'agent.cordis.yml')
const metadataPath = join(presetDir, 'preset.yml')

// 预设组合：以 bare 包名加载本插件（dsh plugin add 安装后即可解析，可移植），
// 注册语料工具（registerTools:true）；registerUi:false 让资料管理 API/设置 UI
// 归 host 常驻那份，预设只注册工具，避免重复注册 /api/prts-corpus 路由。
const PRESET_COMPOSITION = [
  `# PRTS 模式：加载 PRTS 资料工具、DSH 网页搜索与对应 Skill。`,
  `# 只有选中本预设的会话才挂载这些插件，其余模式不加载。`,
  `- id: prts-corpus`,
  `  name: prts-terrarchive`,
  `  config:`,
  `    registerTools: true`,
  `    registerUi: false`,
  `    enabledGames:`,
  `      - arknights`,
  `      - endfield`,
  `    # releasesDir 缺省 $DSH_HOME/prts-corpus/releases；资料放在别处可显式指定绝对路径`,
  `    # （Windows 亦可用正斜杠）。`,
  `    # 默认启用匿名云端组合语义检索；可在设置 → 插件 → PRTS 语料中关闭。`,
  `    cloud:`,
  `      baseUrl: https://prts.chat`,
  `      game: all`,
  `- id: tool-web`,
  `  name: '@deepseek-ai/dsh-tool-web'`,
  `  config:`,
  `    # DSH >= 0.1.2-alpha.1 内置安全 HTTP provider：仅允许公网 HTTP(S)，`,
  `    # 并执行 DNS 校验、地址固定、同源跳转和响应大小限制。`,
  `    fetch: true`,
  `    searchTimeoutMs: 60000`,
  `- id: tool-skill`,
  `  name: '@deepseek-ai/dsh-tool-skill'`,
  `- id: prts-retrieval-skill`,
  `  name: prts-terrarchive/skill`,
  `  config:`,
  `    enabledGames:`,
  `      - arknights`,
  `      - endfield`,
  ``,
].join('\n')

const PRESET_METADATA = [
  `name: ${PRESET_NAME}`,
  `description: ${PRESET_DESCRIPTION}`,
  `order: ${PRESET_ORDER}`,
  ``,
].join('\n')

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

/** 在已有 PRTS preset 中启用 DSH 安全 provider 支撑的 web_fetch，不触碰其他 entry。 */
function enableSafeWebFetch(composition) {
  const lines = composition.split('\n')
  const start = lines.findIndex((line) => /^- id: tool-web\s*$/.test(line))
  if (start < 0) return composition
  let end = lines.findIndex((line, index) => index > start && /^- id:\s+/u.test(line))
  if (end < 0) end = lines.length
  const fetchIndex = lines.findIndex((line, index) => index > start && index < end
    && /^\s{4}fetch:\s*/u.test(line))
  if (fetchIndex >= 0) {
    lines[fetchIndex] = '    fetch: true'
    return lines.join('\n')
  }
  const configIndex = lines.findIndex((line, index) => index > start && index < end
    && /^\s{2}config:\s*$/u.test(line))
  if (configIndex >= 0) lines.splice(configIndex + 1, 0, '    fetch: true')
  else lines.splice(end, 0, '  config:', '    fetch: true')
  return lines.join('\n')
}

/** 为安装器生成的双游戏云端 preset 显式固定本地资料范围。 */
function enableDualGameModules(composition) {
  const lines = composition.split('\n')
  const start = lines.findIndex((line) => /^- id: prts-corpus\s*$/.test(line))
  if (start < 0) return composition
  let end = lines.findIndex((line, index) => index > start && /^- id:\s+/u.test(line))
  if (end < 0) end = lines.length
  const block = lines.slice(start, end)
  if (block.some((line) => /^\s{4}enabledGames:\s*$/u.test(line))) return composition
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
  let end = lines.findIndex((line, index) => index > start && /^- id:\s+/u.test(line))
  if (end < 0) end = lines.length
  if (lines.slice(start, end).some((line) => /^\s{4}enabledGames:\s*$/u.test(line))) return composition
  const nameIndex = lines.findIndex((line, index) => index > start && index < end
    && /^\s{2}name:\s*prts-terrarchive\/skill\s*$/u.test(line))
  if (nameIndex < 0) return composition
  lines.splice(nameIndex + 1, 0, '  config:', '    enabledGames:',
    '      - arknights', '      - endfield')
  return lines.join('\n')
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
  migrated = migrated.replace(
    /(\s{4}cloud:\r?\n\s{6}baseUrl:\s*https:\/\/prts\.chat\r?\n\s{6}game:\s*)arknights\b/u,
    '$1all',
  )
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
