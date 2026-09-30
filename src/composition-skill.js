import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const name = 'prts-composition-skill'
export const inject = ['skills']

/** Make composition instructions discoverable without adding Agent tools. */
export async function apply(ctx) {
  const directory = new URL('../skills/prts-composition/', import.meta.url)
  const source = await readFile(new URL('SKILL.md', directory), 'utf8')
  const content = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim()
  const dispose = ctx.skills.register({
    name: 'prts-composition',
    description: '在创造模式中组合 PRTS 检索、调查、证据板工具与任意 DSH 工具，创建或修改自定义模式；也可调整 PRTS 模式的工具清单。',
    source: 'bundled', provider: 'prts-terrarchive',
    resourceBase: { kind: 'directory', path: fileURLToPath(directory) }, content,
  })
  return () => dispose?.()
}
