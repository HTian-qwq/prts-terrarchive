import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const name = 'prts-retrieval-skill'
export const inject = ['skills']

const skillDirectoryUrl = new URL('../skills/prts-retrieval/', import.meta.url)
const skillFileUrl = new URL('SKILL.md', skillDirectoryUrl)
const referenceUrl = (name) => new URL(`references/${name}`, skillDirectoryUrl)

const GAME_LABELS = Object.freeze({ arknights: '明日方舟', endfield: '明日方舟：终末地' })

function normalizedGames(value) {
  if (!Array.isArray(value)) return null
  const games = [...new Set(value.filter((game) => game === 'arknights' || game === 'endfield'))]
  return games.length ? games : null
}

/**
 * Skill 与工具插件是两个 Cordis entry，不共享内存状态。在会话创建时
 * 合并 Skill entry 的基础范围与同一份用户配置，使正文模块和工具范围一致。
 * 实体识别会在本 Skill 加载后注入当前问题的短提示；工具实例的实时范围
 * 用于覆盖会话创建后的热更改。
 */
export async function configuredSkillGames(baseConfig = {}) {
  const configuredHome = process.env.DSH_HOME?.trim()
  const dshHome = resolve(configuredHome || join(homedir(), '.dsh'))
  try {
    const config = JSON.parse(await readFile(join(dshHome, 'prts-corpus.json'), 'utf8'))
    const explicit = normalizedGames(config.enabledGames)
    if (explicit) return explicit
    if (config.cloudGame === 'arknights' || config.cloudGame === 'endfield') return [config.cloudGame]
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // 无效配置由工具插件给出权威错误；Skill 这里保守回退双游戏。
    }
  }
  return normalizedGames(baseConfig.enabledGames)
    || (baseConfig.cloudGame === 'arknights' || baseConfig.cloudGame === 'endfield'
      ? [baseConfig.cloudGame] : null)
    || ['arknights', 'endfield']
}

export function skillDescription(games) {
  void games
  // Catalog 描述负责发现能力，不能随当前开关隐藏另一款游戏；否则用户询问
  // 尚未启用的资料库时，Skill 反而无法加载并说明正确的恢复路径。
  return '使用 PRTS.chat 本地与云端资料检索、核验并回答《明日方舟》《明日方舟：终末地》及跨游戏关系问题；适用于剧情、人物、设定、台词、档案、Wiki 与时间线研究。'
}

function skillBody(source) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(source)
  if (!match) throw new Error('prts-retrieval/SKILL.md 缺少有效 YAML frontmatter')
  return match[1].trim()
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export async function apply(ctx, config = {}) {
  const games = await configuredSkillGames(config ?? {})
  const scope = games.map((game) => GAME_LABELS[game]).join('、')
  const moduleFiles = games.map((game) => `module-${game}.md`)
  if (games.length === 2) moduleFiles.push('module-dual.md')
  // 双模块已有联合路由和两份模块速查，不再重复装入两套单游戏详细配方。
  const recipeFiles = games.length === 2
    ? ['retrieval-recipes-dual.md']
    : [games[0] === 'arknights' ? 'retrieval-recipes.md' : 'retrieval-recipes-endfield.md']
  const moduleBodies = await Promise.all(moduleFiles.map((file) => readFile(referenceUrl(file), 'utf8')))
  const [toolsBody, processBody, recipeBodies] = await Promise.all([
    readFile(referenceUrl('tools-runtime.md'), 'utf8'),
    readFile(referenceUrl('retrieval-process.md'), 'utf8'),
    Promise.all(recipeFiles.map((file) => readFile(referenceUrl(file), 'utf8'))),
  ])
  const content = [
    `## 本次会话的资料范围\n\n会话创建时启用：**${scope}**。` +
      '\n`<prts:retrieval-context>` 只适用于当前动态上下文快照对应的用户问题；新快照会取代旧快照，不得把前一轮的实体或关系提示沿用到新问题。块内实时搭载范围与实体归属优先级更高。',
    skillBody(await readFile(skillFileUrl, 'utf8')),
    ...moduleBodies.map((body) => body.trim()),
    toolsBody.trim(),
    processBody.trim(),
    ...recipeBodies.map((body) => body.trim()),
  ].join('\n\n')
  return ctx.skills.register({
    name: 'prts-retrieval',
    description: skillDescription(games),
    source: 'bundled',
    provider: 'prts-terrarchive',
    resourceBase: { kind: 'directory', path: fileURLToPath(skillDirectoryUrl) },
    content,
  })
}
