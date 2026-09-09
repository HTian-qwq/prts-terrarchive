import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createSharedState, redactConfig } from '../src/state.js'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'prts-token-state-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const configPath = join(dir, 'config.json')
  return {
    configPath,
    create: (cloud = {}) => createSharedState({
      configPath, releasesDir: dir, patchConfig: { cloud },
    }),
  }
}

test('静态 token 持久绑定保存时的 origin，跨重启保留且不能随 base 切换', async (t) => {
  const { create, configPath } = await fixture(t)
  const original = create({ baseUrl: 'https://prts.chat' })
  await original.saveConfig({ cloudToken: 'prts-test-token' })
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
    cloudToken: 'prts-test-token', cloudTokenOrigin: 'https://prts.chat',
  })

  const restarted = create({ baseUrl: 'https://prts.chat/v2' })
  assert.equal((await restarted.loadConfig()).cloudToken, 'prts-test-token')
  const otherInstance = create({ baseUrl: 'https://other.example' })
  assert.equal((await otherInstance.loadConfig()).cloudToken, '')
  await otherInstance.saveConfig({ uiSkin: 'prts-agent' })
  assert.equal(otherInstance.effective().cloudToken, '', '无关设置不能把旧 token 改绑到新源')
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).cloudTokenOrigin, 'https://prts.chat')

  // 对源的声明留在磁盘内部，不成为 UI 读取后可能整体回传的可编辑字段。
  for (const snapshot of [restarted.effective(), restarted.userLayer(),
    redactConfig(restarted.effective(), restarted.userLayer())]) {
    assert.equal(Object.hasOwn(snapshot, 'cloudTokenOrigin'), false)
  }
  await assert.rejects(() => restarted.saveConfig({ cloudTokenOrigin: 'https://other.example' }),
    (error) => error.code === 'INVALID_CONFIG')
})

test('base 层 token 不跟随用户 URL 覆盖，磁盘 URL 改动也须核对保存的 origin', async (t) => {
  const { create, configPath } = await fixture(t)
  const state = create({ baseUrl: 'https://prts.chat', token: 'base-test-token' })
  assert.equal(state.effective().cloudToken, 'base-test-token')
  await writeFile(configPath, JSON.stringify({ cloudBaseUrl: 'https://other.example' }))
  assert.equal((await state.loadConfig()).cloudToken, '')
  await writeFile(configPath, JSON.stringify({ cloudBaseUrl: 'https://prts.chat/v2' }))
  assert.equal((await state.loadConfig()).cloudToken, 'base-test-token')

  await state.saveConfig({ cloudToken: 'user-test-token' })
  const stored = JSON.parse(await readFile(configPath, 'utf8'))
  await writeFile(configPath, JSON.stringify({ ...stored, cloudBaseUrl: 'https://other.example' }))
  assert.equal((await state.loadConfig()).cloudToken, '')
  await state.saveConfig({ cloudToken: 'other-test-token' })
  assert.equal(state.effective().cloudToken, 'other-test-token')
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).cloudTokenOrigin, 'https://other.example')
})

test('旧版无 origin 的 token 保留但不发送，显式重新保存后恢复跨重启使用', async (t) => {
  const { create, configPath } = await fixture(t)
  for (const legacy of [{ cloudToken: 'legacy-test-token' },
    { cloudToken: 'legacy-test-token', cloudBaseUrl: 'https://legacy.example' }]) {
    await writeFile(configPath, JSON.stringify(legacy))
    const state = create({ baseUrl: 'https://new-base.example' })
    assert.equal((await state.loadConfig()).cloudToken, '')
    assert.equal(state.userLayer().cloudToken, 'legacy-test-token')
    await state.saveConfig({ uiSkin: 'prts-agent' })
    const stored = JSON.parse(await readFile(configPath, 'utf8'))
    assert.equal(stored.cloudToken, 'legacy-test-token')
    assert.equal(Object.hasOwn(stored, 'cloudTokenOrigin'), false)
    await state.saveConfig({ cloudToken: 'confirmed-test-token' })
    const restarted = create({ baseUrl: 'https://new-base.example' })
    assert.equal((await restarted.loadConfig()).cloudToken, 'confirmed-test-token')
  }
})

test('同源路径调整保留 token，跨源切换或清空 token 清除旧绑定', async (t) => {
  const { create, configPath } = await fixture(t)
  const state = create({ baseUrl: 'http://127.0.0.1:5565' })
  await state.saveConfig({ cloudToken: 'loopback-test-token' })
  assert.equal((await state.saveConfig({ cloudBaseUrl: 'http://127.0.0.1:5565/v2' })).cloudToken,
    'loopback-test-token')
  assert.equal((await state.saveConfig({ cloudBaseUrl: 'http://127.0.0.1:5566' })).cloudToken, '')
  assert.equal(Object.hasOwn(JSON.parse(await readFile(configPath, 'utf8')), 'cloudTokenOrigin'), false)
  await state.saveConfig({ cloudToken: 'replacement-test-token' })
  await state.saveConfig({ cloudToken: '' })
  assert.equal(Object.hasOwn(JSON.parse(await readFile(configPath, 'utf8')), 'cloudTokenOrigin'), false)
})

test('配置原生监听配额耗尽时轮询真实文件，支持原子替换、删除重建和关闭清理', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'prts-config-watch-'))
  const configPath = join(dir, 'config.json')
  const state = createSharedState({ configPath, releasesDir: dir })
  let close
  t.after(async () => { close?.(); await rm(dir, { recursive: true, force: true }) })
  t.mock.method(fs, 'watch', () => { throw Object.assign(new Error('quota exhausted'), { code: 'ENOSPC' }) })
  const originalWatchFile = fs.watchFile
  const originalUnwatchFile = fs.unwatchFile
  const polling = t.mock.method(fs, 'watchFile', (...args) => originalWatchFile(...args))
  const unpolling = t.mock.method(fs, 'unwatchFile', (...args) => originalUnwatchFile(...args))
  const warnings = []
  const changes = []
  state.subscribe(config => changes.push(config.uiSkin))
  close = await state.watchConfig({ warn(message) { warnings.push(message) } })
  assert.equal(polling.mock.callCount(), 1)
  assert.equal(polling.mock.calls[0].arguments[1].persistent, false)
  assert.equal(warnings.filter(message => message.includes('ENOSPC')).length, 1)

  const waitFor = async (check, label) => {
    const deadline = Date.now() + 5000
    while (!check()) {
      assert.ok(Date.now() < deadline, label)
      await delay(25)
    }
  }
  const replaceConfig = async (contents) => {
    const temporary = join(dir, 'config.next.json')
    await writeFile(temporary, contents)
    await rename(temporary, configPath)
  }
  await replaceConfig(JSON.stringify({ uiSkin: 'prts-agent' }))
  await waitFor(() => state.effective().uiSkin === 'prts-agent', '必须观察首次创建的配置')
  await replaceConfig('{invalid json')
  await waitFor(() => warnings.some(message => message.includes('忽略无效配置更新')), '无效更新必须记录警告')
  assert.equal(state.effective().uiSkin, 'prts-agent', '无效文件必须保留最后的有效配置')
  await replaceConfig(JSON.stringify({ uiSkin: 'endfield-aic' }))
  await waitFor(() => state.effective().uiSkin === 'endfield-aic', '必须观察原子替换的有效配置')
  await rm(configPath)
  await waitFor(() => state.effective().uiSkin === 'harness', '删除配置必须恢复默认值')
  await replaceConfig(JSON.stringify({ uiSkin: 'prts-agent' }))
  await waitFor(() => state.effective().uiSkin === 'prts-agent', '删除后重建必须继续热加载')
  assert.deepEqual(changes, ['prts-agent', 'endfield-aic', 'harness', 'prts-agent'])

  close()
  close()
  assert.equal(unpolling.mock.callCount(), 1)
  assert.equal(unpolling.mock.calls[0].arguments[0], configPath)
  assert.equal(unpolling.mock.calls[0].arguments[1], polling.mock.calls[0].arguments[2])
  await replaceConfig(JSON.stringify({ uiSkin: 'endfield-aic' }))
  await delay(1200)
  assert.equal(state.effective().uiSkin, 'prts-agent', '关闭后不能继续加载文件变更')
  assert.equal(changes.length, 4)
})

test('配置监听不把权限错误当作配额问题掩盖', async (t) => {
  const { create } = await fixture(t)
  const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  t.mock.method(fs, 'watch', () => { throw failure })
  const polling = t.mock.method(fs, 'watchFile', () => { throw new Error('不应轮询') })
  await assert.rejects(() => create().watchConfig(), error => error === failure)
  assert.equal(polling.mock.callCount(), 0)
})
