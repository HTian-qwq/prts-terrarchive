/** Verify all Host entry points using only shipped code, outside the checkout's dependency tree. */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'

export function checkRuntime(packageRoot) {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  if (Object.keys(manifest.dependencies || {}).length) throw new Error('Bundle runtime dependencies before shipping the plugin')
  const versions = JSON.parse(readFileSync(join(packageRoot, 'lib/runtime/versions.json'), 'utf8'))
  for (const name of ['js-yaml', 'zod']) {
    if (versions[name] !== manifest.devDependencies[name]) throw new Error(`Stale bundled ${name}; run npm run build:runtime`)
    readFileSync(join(packageRoot, 'lib/runtime/licenses', `${name}-MIT.txt`))
  }
  const entries = Object.entries(manifest.exports).filter(([name, path]) =>
    name !== './client' && typeof path === 'string' && /\.[cm]?js$/.test(path))
  const temporary = mkdtempSync(join(tmpdir(), 'prts-runtime-'))
  try {
    const staged = join(temporary, 'plugin')
    mkdirSync(staged)
    // Include assets too: Host UI discovers packaged map files during import.
    // These paths must also be selected for the actual npm package.
    for (const path of ['package.json', 'src', 'presets', 'contracts', 'resources', 'lib']) {
      if (path !== 'package.json' && !manifest.files.some(item => path === item || path.startsWith(item + '/'))) {
        throw new Error(`Runtime tree is excluded from the npm package: ${path}`)
      }
      cpSync(join(packageRoot, path), join(staged, path), { recursive: true,
        filter: file => !relative(packageRoot, file).split(/[\\/]/).includes('node_modules') })
    }
    const probe = join(staged, '__prts_runtime_check__.mjs')
    writeFileSync(probe, `
      for (const name of ${JSON.stringify(entries.map(([name]) => name === '.' ? manifest.name : manifest.name + name.slice(1)))}) {
        await import(name)
      }
      const { readPlugins, writePlugins } = await import('./presets/composition.js')
      const plugins = readPlugins('- id: probe\\n  name: test/probe\\n  disabled: !!js process.platform === "win32"\\n')
      if (readPlugins(writePlugins(plugins))[0].disabled.__jsExpr !== 'process.platform === "win32"') {
        throw new Error('Bundled preset parser lost the Cordis expression')
      }
    `)
    const result = spawnSync(process.execPath, [probe], {
      cwd: staged, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
    })
    if (result.status !== 0) throw new Error(`Isolated plugin load failed:\n${result.error || result.stderr || result.stdout}`)
    return { entries: entries.map(([name]) => name), dependencies: versions }
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { package: { type: 'string' } } })
  const result = checkRuntime(resolve(values.package || fileURLToPath(new URL('../', import.meta.url))))
  console.error(`PRTS runtime: ${result.entries.length} Host entries loaded without node_modules`)
}
