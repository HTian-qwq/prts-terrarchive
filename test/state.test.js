import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
