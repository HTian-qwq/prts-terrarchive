import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readPlugins, writePlugins, withPrtsPlugins, standardPlugins } from '../presets/composition.js'
import { prtsPreset } from '../presets/definition.js'
import { registerPreset } from '../presets/register.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const host = process.env.PRTS_DSH_SOURCE_DIR

test('composition retains platform expressions, private groups and user-disabled tools without mutating standard', () => {
  const standard = readPlugins([
    '- id: shell', '  name: fixture/shell', "  disabled: !!js process.platform === 'win32'",
    '- id: planning', '  name: cordis:group', '  group: true', '  isolate:', '    planMode: true',
    '  config:', '    - id: plan-mode', '      name: fixture/plan',
    '- id: custom-web', '  name: "@deepseek-ai/dsh-tool-web"', '  disabled: true',
    '  config:', '    maxResults: 7', '    fetch: false',
    '- id: tool-skill', '  name: "@deepseek-ai/dsh-tool-skill"', '',
  ].join('\n'))
  const before = structuredClone(standard)
  const result = withPrtsPlugins(standard, prtsPreset.plugins)
  assert.deepEqual(standard, before)
  assert.deepEqual(result.slice(0, 2), standard.slice(0, 2))
  assert.deepEqual(readPlugins(writePlugins(result)), result)
  assert.equal(result.filter(row => row.name === '@deepseek-ai/dsh-tool-web').length, 1)
  assert.equal(result.filter(row => row.name === '@deepseek-ai/dsh-tool-skill').length, 1)
  const web = result.find(row => row.id === 'custom-web')
  assert.equal(web.disabled, true)
  assert.equal(web.config.maxResults, 7)
  assert.equal(web.config.fetch, true)
  assert.throws(() => withPrtsPlugins([{ id: 'prts-corpus', name: 'user/other' }], prtsPreset.plugins), /conflicting/)
})

test('explicit user composition may remove all default tools and is disposed normally', async () => {
  let registered, disposed = false
  const effects = []
  const ctx = {
    agentPresets: {
      async readDocument() { throw new Error('must not inherit when the user owns plugins') },
      async register(definition) { registered = definition; return () => { disposed = true } },
    },
    effect(fn) { effects.push(fn()) },
  }
  await registerPreset(ctx, { plugins: [] })
  assert.deepEqual(registered.plugins, [])
  effects[0]()
  assert.equal(disposed, true)
})

test('default composition cannot silently degrade when standard is unavailable', async () => {
  await assert.rejects(standardPlugins({
    get() { return { entries: () => [] } },
    agentPresets: { async readDocument() { throw new Error('standard unavailable') } },
  }), /standard unavailable/)
})

test('every entry from the actual shipped standard preset survives the extension', {
  skip: !host && 'Set PRTS_DSH_SOURCE_DIR for shipped standard comparison',
}, () => {
  const patch = readPlugins(readFileSync(join(host, 'packages/bundle/web-app/presets/standard.patch.yml'), 'utf8'))
  const standard = patch[0].insert[0].config.plugins
  const result = withPrtsPlugins(standard, prtsPreset.plugins)
  for (const entry of standard) {
    assert.deepEqual(result.find(row => row.id === entry.id), entry, entry.id)
  }
  assert.deepEqual(result.filter(row => !standard.some(item => item.id === row.id)),
    prtsPreset.plugins.filter(row => !standard.some(item => item.id === row.id)))
})

test('new legacy CLI presets carry an upgrade marker and inherit the host standard at boot', async () => {
  const home = mkdtempSync(join(tmpdir(), 'prts-standard-cli-'))
  const path = join(home, '.agent-presets')
  try {
    const run = spawnSync(process.execPath, [join(root, 'bin/install.js'), 'web', '--preset-only'], {
      env: { ...process.env, DSH_HOME: home, PRTS_DSH_VERSION: '0.1.5-alpha.1' }, encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(JSON.parse(readFileSync(join(path, 'prts/.prts-terrarchive.json'), 'utf8')).format, 1)
    const warnings = []
    await registerPreset({
      agentPresets: { roots: [{ path, trust: 'user' }], async list() { return [] },
        async read() { return '- id: old-tool\n  name: fixture/old-tool\n' } },
      logger: { warn(...args) { warnings.push(args) } },
    })
    const entries = readPlugins(readFileSync(join(path, 'prts/agent.cordis.yml'), 'utf8'))
    assert.equal(entries[0].name, 'fixture/old-tool')
    assert.equal(entries.filter(row => row.id === 'prts-corpus').length, 1)
    assert.deepEqual(warnings, [])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('real Loader composes standard, PRTS and custom toolsets with scoped skills and tools', {
  skip: !host && 'Set PRTS_DSH_SOURCE_DIR for real composition check',
}, () => {
  const result = spawnSync(process.execPath, [
    '--expose-internals', '--import', join(host, 'node_modules/tsx/dist/esm/index.mjs'),
    join(root, 'test/fixtures/prts-tools-composition.mts'), root, host,
  ], {
    cwd: host, env: { ...process.env, TSX_TSCONFIG_PATH: join(host, 'tsconfig.json') },
    encoding: 'utf8', timeout: 30_000,
  })
  assert.equal(result.status, 0, [result.error || '', result.stdout, result.stderr].join('\n'))
  assert.match(result.stdout, /PRTS tool composition passed/)
})

test('legacy standard-read failure leaves no stub that prevents retry', async () => {
  const home = mkdtempSync(join(tmpdir(), 'prts-standard-retry-'))
  const path = join(home, 'presets')
  const warnings = []
  let available = false
  const ctx = {
    agentPresets: { roots: [{ path, trust: 'user' }], async list() { return [] },
      async read() { if (!available) throw new Error('standard unavailable'); return '[]\n' } },
    logger: { warn(...args) { warnings.push(args) } },
  }
  try {
    await registerPreset(ctx)
    assert.equal(warnings.length, 1)
    available = true
    await registerPreset(ctx)
    assert(readPlugins(readFileSync(join(path, 'prts/agent.cordis.yml'), 'utf8')).some(row => row.id === 'prts-corpus'))
    assert.equal(warnings.length, 1)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('legacy composition preserves its own providers and platform conditions', {
  skip: !process.env.PRTS_DSH_LEGACY_SOURCE_DIR && 'Set PRTS_DSH_LEGACY_SOURCE_DIR for legacy standard comparison',
}, async () => {
  const home = mkdtempSync(join(tmpdir(), 'prts-legacy-standard-'))
  const path = join(home, 'presets')
  const standard = readFileSync(join(process.env.PRTS_DSH_LEGACY_SOURCE_DIR,
    'apps/cli/config/agent-presets/standard/agent.cordis.yml'), 'utf8')
  try {
    await registerPreset({
      agentPresets: { roots: [{ path, trust: 'user' }], async list() { return [] },
        async read(id) { assert.equal(id, 'standard'); return standard } },
      logger: { warn(...args) { assert.fail(JSON.stringify(args)) } },
    })
    const result = readPlugins(readFileSync(join(path, 'prts/agent.cordis.yml'), 'utf8'))
    for (const entry of readPlugins(standard)) {
      const expected = entry.id === 'tool-web'
        ? { ...entry, config: { ...entry.config, fetch: true, searchTimeoutMs: 60000 } } : entry
      assert.deepEqual(result.find(row => row.id === entry.id), expected, entry.id)
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})
