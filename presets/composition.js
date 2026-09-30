import { JSON_SCHEMA, Type, load, dump } from '../lib/runtime/yaml.js'

// Cordis's entry-list dialect: expressions belong to each child, including
// platform switches and lookups of isolated services.
export const entryListSchema = JSON_SCHEMA.extend(new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (value) => typeof value === 'string',
  construct: (value) => ({ __jsExpr: value }),
  predicate: (value) => value !== null && typeof value === 'object' && typeof value.__jsExpr === 'string',
  represent: (value) => value.__jsExpr,
}))

export function readPlugins(content) {
  const plugins = load(content, { schema: entryListSchema })
  if (!Array.isArray(plugins)) throw new Error('PRTS preset: expected a Cordis plugin list')
  return plugins
}

export function writePlugins(plugins) {
  return dump(plugins, { schema: entryListSchema, noRefs: true, lineWidth: -1 })
}

/** Extend the host's standard composition without duplicating shared tools. */
export function withPrtsPlugins(standard, additions) {
  if (!Array.isArray(standard)) throw new Error('PRTS preset: standard mode has no plugin list')
  const result = structuredClone(standard)
  for (const addition of structuredClone(additions)) {
    const index = result.findIndex((entry) => entry.id === addition.id || entry.name === addition.name)
    if (index < 0) {
      result.push(addition)
      continue
    }
    const existing = result[index]
    // Keep user choices such as renamed or disabled standard tools.
    if (existing.name !== addition.name) throw new Error('PRTS preset: conflicting plugin id ' + addition.id)
    result[index] = { ...existing, ...(addition.config ? {
      config: { ...existing.config, ...addition.config },
    } : {}) }
  }
  return result
}

/** Read declarations before activation settles, avoiding startup order races. */
export async function standardPlugins(ctx) {
  const loader = ctx.get?.('loader')
  if (loader) {
    const entry = [...loader.entries()].find(({ options }) =>
      options.name === '@deepseek-ai/dsh-agent-preset' && options.config?.id === 'standard')
    if (entry) return entry.options.config.plugins
  }
  const document = await ctx.agentPresets.readDocument('standard')
  return readPlugins(document.content)
}
