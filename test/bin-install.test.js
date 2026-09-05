import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))

test('Host patch 与 PRTS preset 使用同一默认云端服务', async () => {
  const patch = await readFile(join(packageDir, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /registerTools: false[^]*cloud:\n\s+baseUrl: https:\/\/prts\.chat[^]*game: all/u)
})

test('插件交付不声明 npm registry 发布入口', async () => {
  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
  assert.equal(manifest.private, true)
  assert.equal(manifest.publishConfig, undefined)
  assert.equal(manifest.scripts?.prepublishOnly, undefined)
  for (const filename of ['README.md', 'README.en.md']) {
    const readme = await readFile(join(packageDir, filename), 'utf8')
    assert.doesNotMatch(readme, /npx\s+(?:--yes\s+)?prts-terrarchive\b/u)
  }
  const installer = await readFile(join(packageDir, 'bin/install.js'), 'utf8')
  assert.doesNotMatch(installer, /npx\b/u)
  assert.match(installer, /plugin --profile \$\{profile\} remove \$\{packageMetadata\.name\}/u)
})

test('安装器为新旧 PRTS preset 幂等挂载网页工具和 tool-skill', async () => {
  const dshHome = await mkdtemp(join(tmpdir(), 'prts-bin-install-'))
  const fakeDsh = join(dshHome, 'fake-dsh')
  const dshArgsPath = join(dshHome, 'dsh-args.txt')
  const presetDir = join(dshHome, '.agent-presets', 'prts')
  const compositionPath = join(presetDir, 'agent.cordis.yml')
  try {
    await writeFile(fakeDsh, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$PRTS_DSH_ARGS_FILE"\n')
    await chmod(fakeDsh, 0o755)
    await mkdir(presetDir, { recursive: true })
    await writeFile(compositionPath, [
      '- id: prts-corpus',
      '  name: prts-terrarchive',
      '  config:',
      '    registerTools: true',
      '    cloud:',
      '      baseUrl: https://prts.chat',
      '      game: arknights',
      '- id: tool-web',
      "  name: '@deepseek-ai/dsh-tool-web'",
      '  config:',
      '    fetch: false',
      '    searchTimeoutMs: 30000',
      '- id: prts-corpus-guidance',
      '  name: prts-terrarchive/guidance',
      '',
    ].join('\n'))

    const run = () => spawnSync(process.execPath, [join(packageDir, 'bin/install.js'), 'web', packageDir], {
      env: { ...process.env, DSH_HOME: dshHome, DSH: fakeDsh, PRTS_DSH_ARGS_FILE: dshArgsPath },
      encoding: 'utf8',
    })
    assert.equal(run().status, 0)
    assert.equal(run().status, 0, '重复安装必须幂等')

    const composition = await readFile(compositionPath, 'utf8')
    assert.doesNotMatch(composition, /prts-corpus-guidance/)
    assert.match(composition, /- id: tool-web\n  name: '@deepseek-ai\/dsh-tool-web'\n  config:\n    fetch: true\n    searchTimeoutMs: 30000/)
    assert.match(composition, /- id: tool-skill\n  name: '@deepseek-ai\/dsh-tool-skill'/)
    assert.match(composition, /- id: prts-retrieval-skill\n  name: prts-terrarchive\/skill/)
    assert.match(composition, /baseUrl: https:\/\/prts\.chat\n      game: all/)
    assert.match(composition, /enabledGames:\n      - arknights\n      - endfield/)
    assert.match(composition,
      /- id: prts-retrieval-skill\n  name: prts-terrarchive\/skill\n  config:\n    enabledGames:\n      - arknights\n      - endfield/)
    assert.doesNotMatch(composition, /game: arknights/)
    assert.ok(composition.indexOf('- id: tool-web') < composition.indexOf('- id: tool-skill'))
    assert.ok(composition.indexOf('- id: tool-skill') < composition.indexOf('- id: prts-retrieval-skill'))
    assert.equal(composition.match(/^- id: tool-web$/gm)?.length, 1)
    assert.equal(composition.match(/^- id: tool-skill$/gm)?.length, 1)

    const defaultInstall = spawnSync(process.execPath, [join(packageDir, 'bin/install.js'), 'web'], {
      env: { ...process.env, DSH_HOME: dshHome, DSH: fakeDsh, PRTS_DSH_ARGS_FILE: dshArgsPath },
      encoding: 'utf8',
    })
    assert.equal(defaultInstall.status, 0)
    assert.deepEqual((await readFile(dshArgsPath, 'utf8')).trim().split('\n'), [
      'plugin', '--profile', 'web', 'add', packageDir,
    ])
  } finally {
    await rm(dshHome, { recursive: true, force: true })
  }
})

test('--preset-only 不调用 dsh，仍生成可用预设', async () => {
  const dshHome = await mkdtemp(join(tmpdir(), 'prts-bin-preset-only-'))
  try {
    const result = spawnSync(process.execPath, [
      join(packageDir, 'bin/install.js'), 'desktop', '--preset-only',
    ], {
      env: { ...process.env, DSH_HOME: dshHome, DSH: join(dshHome, 'must-not-run') },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    const composition = await readFile(
      join(dshHome, '.agent-presets', 'prts', 'agent.cordis.yml'), 'utf8')
    assert.match(composition, /- id: prts-corpus/)
    assert.match(composition, /- id: tool-web/)
    assert.match(composition, /fetch: true/)
    assert.match(composition, /game: all/)
    assert.match(composition, /enabledGames:\n      - arknights\n      - endfield/)
    assert.match(composition,
      /name: prts-terrarchive\/skill\n  config:\n    enabledGames:\n      - arknights\n      - endfield/)
  } finally {
    await rm(dshHome, { recursive: true, force: true })
  }
})

test('安装器在调用 dsh 前拒绝危险 profile 名称与未知选项', async () => {
  const dshHome = await mkdtemp(join(tmpdir(), 'prts-bin-invalid-profile-'))
  try {
    for (const args of [['../web'], ['node_modules'], ['web', '--unknown'], ['web', '--uninstall'],
      ['web', 'prts-terrarchive@0.1.0']]) {
      const result = spawnSync(process.execPath, [join(packageDir, 'bin/install.js'), ...args], {
        env: { ...process.env, DSH_HOME: dshHome, DSH: join(dshHome, 'must-not-run') },
        encoding: 'utf8',
      })
      assert.notEqual(result.status, 0)
    }
  } finally {
    await rm(dshHome, { recursive: true, force: true })
  }
})
