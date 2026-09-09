/** Seed a user preset without changing the Host roster or its live mounts. */
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const name = 'prts-preset-seed'
export const inject = ['agentPresets']
const packageName = 'prts-terrarchive'
const markerName = '.prts-terrarchive.json'
const filenames = ['agent.cordis.yml', 'preset.yml']
const digest = (content) => createHash('sha256').update(content).digest('hex')

function readOptional(path) {
  try { return readFileSync(path, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

function writeAtomic(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, content, { flag: 'wx' })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export async function apply(ctx) {
  const roster = ctx.agentPresets
  // Match DSH's authoring policy. A deployment with no user root stays read-only.
  const root = roster.roots.find((entry) => entry.trust === 'user')
  if (!root) return
  const directory = resolve(root.path, 'prts')
  try {
    const existing = (await roster.list()).find((preset) => preset.id === 'prts')
    if (existing && resolve(existing.path) !== join(directory, 'agent.cordis.yml')) return
    const files = Object.fromEntries(filenames.map((file) => [
      file, readFileSync(new URL(`./prts/${file}`, import.meta.url), 'utf8'),
    ]))
    const marker = {
      format: 1, package: packageName,
      version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
      files: Object.fromEntries(filenames.map((file) => [file, digest(files[file])])),
    }
    mkdirSync(resolve(root.path), { recursive: true })
    let created = false
    try {
      mkdirSync(directory)
      created = true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    if (!created) {
      if (!lstatSync(directory).isDirectory()) return
      let previous
      try { previous = JSON.parse(readOptional(join(directory, markerName))) } catch { return }
      if (previous?.format !== 1 || previous.package !== packageName) return
      // Unmarked CLI presets, user edits, deleted files, and symlinks belong to
      // the user. Only a complete, unchanged generated pair can be upgraded.
      for (const file of filenames) {
        const content = readOptional(join(directory, file))
        if (content === undefined || !lstatSync(join(directory, file)).isFile()
          || digest(content) !== previous.files?.[file]) return
      }
    }
    for (const file of filenames) {
      const path = join(directory, file)
      if (readOptional(path) !== files[file]) writeAtomic(path, files[file])
    }
    const markerPath = join(directory, markerName)
    const markerContent = JSON.stringify(marker, null, 2) + '\n'
    if (readOptional(markerPath) !== markerContent) writeAtomic(markerPath, markerContent)
  } catch (error) {
    ctx.logger.warn('Could not prepare the PRTS user preset in %s. Check directory permissions: %s', directory, error.message)
  }
}
