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

test('npm 交付不依赖安装钩子，附带预设并保留本地安装入口', async () => {
  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
  assert.notEqual(manifest.private, true)
  assert.deepEqual(manifest.publishConfig, { access: 'public' })
  assert.equal(manifest.exports['./presets'], './presets/register.js')
  assert.ok(manifest.files.includes('presets'))
  assert.equal(manifest.scripts?.postinstall, undefined)
  assert.equal(manifest.scripts?.install, undefined)
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

async function migratePreset(t, composition) {
  const dshHome = await mkdtemp(join(tmpdir(), 'prts-bin-custom-preset-'))
  t.after(() => rm(dshHome, { recursive: true, force: true }))
  const presetDir = join(dshHome, '.agent-presets', 'prts')
  const compositionPath = join(presetDir, 'agent.cordis.yml')
  await mkdir(presetDir, { recursive: true })
  await writeFile(compositionPath, composition)
  let migrated
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = spawnSync(process.execPath, [join(packageDir, 'bin/install.js'), '--preset-only'], {
      env: { ...process.env, DSH_HOME: dshHome }, encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    const current = await readFile(compositionPath, 'utf8')
    if (attempt) assert.equal(current, migrated, '迁移后的用户预设必须保持幂等')
    migrated = current
  }
  return migrated
}

const installedHelpers = '- id: tool-web\n  name: \'@deepseek-ai/dsh-tool-web\'\n'
  + '  config:\n    fetch: true\n- id: tool-skill\n  name: \'@deepseek-ai/dsh-tool-skill\'\n'

test('预设迁移保留 enabledGames 的行内数组、注释和引号键，不重复插入映射', async (t) => {
  for (const selection of ['enabledGames: [arknights]', "'enabledGames' : [arknights]",
    '"enabledGames": [arknights]', 'enabledGames: # 自定义范围\n      - arknights']) {
    const composition = '- id: prts-corpus\n  name: prts-terrarchive\n  config:\n'
      + `    registerTools: true\n    ${selection}\n`
      + '    cloud:\n      baseUrl: https://prts.chat\n      game: all\n'
      + installedHelpers
      + '- id: prts-retrieval-skill\n  name: prts-terrarchive/skill\n  config:\n'
      + `    ${selection}\n`
    assert.equal(await migratePreset(t, composition), composition)
  }
})

test('用户使用行内 config、anchor 或 alias 时保留原文，不追加第二个 config', async (t) => {
  for (const config of ['{ enabledGames: [arknights] }', '&scope\n    enabledGames: [arknights]',
    '*scope', '\n      enabledGames: [arknights]']) {
    const composition = (config === '*scope'
      ? '- id: scope-source\n  name: prts-terrarchive/skill\n  config: &scope\n    enabledGames: [arknights]\n'
      : '')
      + '- id: prts-retrieval-skill\n  name: prts-terrarchive/skill\n'
      + `  config: ${config}\n`
      + '- id: tool-web\n  name: \'@deepseek-ai/dsh-tool-web\'\n'
      + '  config: { fetch: false, searchTimeoutMs: 30000 }\n'
      + '- id: tool-skill\n  name: \'@deepseek-ai/dsh-tool-skill\'\n'
    assert.equal(await migratePreset(t, composition), composition)
  }
})

test('Skill 已有空的块 config 时在原映射内补齐范围并保留注释', async (t) => {
  const composition = installedHelpers
    + '- id: prts-retrieval-skill\n  name: prts-terrarchive/skill\n  config : # 用户注释\n'
  assert.equal(await migratePreset(t, composition), composition
    + '    enabledGames:\n      - arknights\n      - endfield\n')
})

test('迁移以任意顶层 sequence item 为边界，保留 name-first 相邻插件', async (t) => {
  const dualGames = '    enabledGames:\n      - arknights\n      - endfield\n'
  for (const nextEntry of ['- name: custom-plugin\n  id: custom\n',
    '-\n  name: custom-plugin\n  id: custom\n']) {
    const neighbor = nextEntry + '  config:\n    custom: true\n    fetch: false\n'
      + '    cloud:\n      baseUrl: https://prts.chat\n      game: arknights\n'
    const skill = '- id: prts-retrieval-skill\n  name: prts-terrarchive/skill\n'
    assert.equal(await migratePreset(t, skill + neighbor + installedHelpers),
      skill + '  config:\n' + dualGames + neighbor + installedHelpers,
      'Skill 缺少 config 时必须新建自己的映射，不得使用相邻插件的 config')

    const web = '- id: tool-web\n  name: \'@deepseek-ai/dsh-tool-web\'\n'
    const skillLoader = '- id: tool-skill\n  name: \'@deepseek-ai/dsh-tool-skill\'\n'
    assert.equal(await migratePreset(t, web + neighbor + skillLoader),
      web + '  config:\n    fetch: true\n' + neighbor + skillLoader,
      'web_fetch 的配置补齐不得修改相邻插件的 fetch 值')

    const corpus = '- id: prts-corpus\n  name: prts-terrarchive\n'
      + '  config:\n    registerTools: true\n'
    const composition = corpus + neighbor + installedHelpers
    assert.equal(await migratePreset(t, composition), composition,
      '相邻插件的云端地址和 game 不属于旧 PRTS 云端配置，不能迁移或用于推断双游戏范围')

    const cloud = '    cloud:\n      baseUrl: https://prts.chat\n      game: all\n'
    const scopedNeighbor = neighbor + '    enabledGames: [arknights]\n'
    assert.equal(await migratePreset(t, corpus + cloud + scopedNeighbor + installedHelpers),
      corpus + dualGames + cloud + scopedNeighbor + installedHelpers,
      '相邻插件的 enabledGames 不能阻止当前 PRTS entry 的标准迁移')
  }
})
