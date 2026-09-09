import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { apply } from '../presets/register.js'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const dshSource = process.env.PRTS_DSH_SOURCE_DIR
const markerName = '.prts-terrarchive.json'

function seedContext(root, existing = []) {
  const warnings = []
  return {
    agentPresets: { roots: [{ path: root, trust: 'user' }], async list() { return existing } },
    logger: { warn(...args) { warnings.push(args) } },
    warnings,
  }
}

test('preset activation seeds package templates, upgrades unchanged files and preserves user edits', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'prts-seed-'))
  const root = join(temporary, 'user-presets')
  const target = join(root, 'prts')
  const context = seedContext(root)
  try {
    await apply(context)
    const original = readFileSync(join(target, 'agent.cordis.yml'), 'utf8')
    assert.equal(original, readFileSync(join(packageRoot, 'presets/prts/agent.cordis.yml'), 'utf8'))
    const initialMarker = JSON.parse(readFileSync(join(target, markerName), 'utf8'))
    assert.equal(initialMarker.version, '0.1.0')
    assert.equal(initialMarker.files['agent.cordis.yml'], createHash('sha256').update(original).digest('hex'))

    // An installed package moved by Desktop resolves templates from its own path.
    const staged = join(temporary, 'staging with 空格', 'prts-terrarchive')
    mkdirSync(staged, { recursive: true })
    cpSync(join(packageRoot, 'presets'), join(staged, 'presets'), { recursive: true })
    writeFileSync(join(staged, 'package.json'), JSON.stringify({ type: 'module', version: '0.2.0' }))
    const upgraded = original + '\n# next package template\n'
    writeFileSync(join(staged, 'presets/prts/agent.cordis.yml'), upgraded)
    const { apply: upgrade } = await import(pathToFileURL(join(staged, 'presets/register.js')).href)
    writeFileSync(join(target, 'user-notes.txt'), 'keep this extra file')
    await upgrade(context)
    assert.equal(readFileSync(join(target, 'agent.cordis.yml'), 'utf8'), upgraded)
    assert.equal(JSON.parse(readFileSync(join(target, markerName), 'utf8')).version, '0.2.0')
    assert.equal(readFileSync(join(target, 'user-notes.txt'), 'utf8'), 'keep this extra file')

    const custom = 'name: My customized PRTS\n'
    writeFileSync(join(target, 'preset.yml'), custom)
    await apply(context)
    assert.equal(readFileSync(join(target, 'agent.cordis.yml'), 'utf8'), upgraded, 'one edited file preserves the whole template pair')
    assert.equal(readFileSync(join(target, 'preset.yml'), 'utf8'), custom)
    assert.equal(JSON.parse(readFileSync(join(target, markerName), 'utf8')).version, '0.2.0')
    assert.deepEqual(context.warnings, [])
    assert.equal(readdirSync(target).some((file) => file.endsWith('.tmp')), false)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('preset activation preserves unmarked CLI presets, other roots and read-only deployments', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'prts-seed-preserve-'))
  const root = join(temporary, 'user-presets')
  const target = join(root, 'prts')
  try {
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'agent.cordis.yml'), '# user or previous CLI composition\n[]\n')
    writeFileSync(join(target, 'preset.yml'), 'name: Existing PRTS\n')
    await apply(seedContext(root))
    assert.equal(readFileSync(join(target, 'agent.cordis.yml'), 'utf8'), '# user or previous CLI composition\n[]\n')
    assert.deepEqual(readdirSync(target).sort(), ['agent.cordis.yml', 'preset.yml'])
    rmSync(root, { recursive: true })
    await apply(seedContext(root, [{ id: 'prts', path: join(temporary, 'other-root/prts/agent.cordis.yml') }]))
    assert.equal(existsSync(root), false, 'an existing preset in another root is not shadowed')
    const readOnly = seedContext(root)
    readOnly.agentPresets.roots = [{ path: root, trust: 'system' }]
    await apply(readOnly)
    assert.equal(existsSync(root), false)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('preset write failures warn without breaking the Host', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'prts-seed-failure-'))
  try {
    const root = join(temporary, 'not-a-directory')
    writeFileSync(root, 'unwritable preset root')
    const context = seedContext(root)
    await apply(context)
    assert.equal(context.warnings.length, 1)
    assert.match(context.warnings[0][0], /Check directory permissions/u)
    assert.equal(readFileSync(root, 'utf8'), 'unwritable preset root')
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('官方 Desktop 安装引导不会执行 CLI 或创建用户预设', () => {
  const home = mkdtempSync(join(tmpdir(), 'prts-desktop-install-'))
  try {
    const result = spawnSync(process.execPath, [join(packageRoot, 'bin/install.js'), 'desktop'], {
      env: { ...process.env, DSH_HOME: home, DSH: join(home, 'must-not-run') },
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /桌面插件管理窗口/u)
    assert.equal(existsSync(join(home, '.agent-presets')), false)
    assert.equal(existsSync(join(home, 'profiles')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('npm preset uses the actual Loader across install, Desktop override and unload', {
  skip: !dshSource ? 'Set PRTS_DSH_SOURCE_DIR for the real DSH Loader compatibility check' : false,
}, () => {
  const source = resolve(dshSource)
  const result = spawnSync(process.execPath, [
    '--import', join(source, 'node_modules/tsx/dist/esm/index.mjs'),
    join(packageRoot, 'test/fixtures/npm-preset-loader.mts'),
    packageRoot, source,
  ], {
    cwd: source,
    env: { ...process.env, TSX_TSCONFIG_PATH: join(source, 'tsconfig.json') },
    encoding: 'utf8', timeout: 30_000,
  })
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /PRTS preset Loader compatibility passed/u)
})
