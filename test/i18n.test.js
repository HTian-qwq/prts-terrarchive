import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CorpusStore, documentUid, naturalDocumentTitle } from '../src/store.js'
import { executeI18n, normalizeI18nRequest, renderI18n } from '../src/i18n.js'
import { ensureCorpusRelease, validateLocalRelease } from '../src/installer.js'
import { localizationFixture, FIRST_ID, SECOND_ID, PROFILE_ID, DOC } from './fixtures/localization.js'

async function fixture(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'prts-i18n-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const releasesDir = join(root, 'releases'), data = localizationFixture(options)
  await data.write(releasesDir)
  const store = new CorpusStore({ releasesDir })
  await store.ready()
  return { ...data, releasesDir, store }
}

test('同文不同译保留全部候选，默认隐藏内部 ID，空译文和未安装语言分别返回', async (t) => {
  const { store } = await fixture(t)
  const result = await executeI18n(store, { query: '相同原文', languages: ['en', 'ja', 'ko'] })
  assert.equal(result.total_matches, 2)
  assert.deepEqual(result.matches.map((m) => m.translations.EN.text), ['First translation.', 'Different translation.'])
  assert.equal(result.matches[0].translations.JP.status, 'missing_localization')
  assert.equal(result.matches[0].translations.KR.status, 'unavailable')
  assert.equal(result.matches[0].references[0].document_uid, documentUid(DOC))
  assert.equal(result.matches[0].text_id, undefined)
  assert.equal(result.matches[0].source_fields, undefined)
  assert.ok(!renderI18n({}, result)[0].text.includes(FIRST_ID))
  const located = await executeI18n(store, { document_uid: documentUid(DOC), line: 1,
    source_language: 'JP', languages: ['CN'] })
  assert.equal(located.status, 'ok')
  assert.equal(located.matches[0].source.status, 'missing_localization')
  assert.equal(located.matches[0].translations.CN.text, '相同原文')
})

test('按标题或 document_uid 和行号直接定位，档案返回整条记录', async (t) => {
  const { store, document, profile } = await fixture(t)
  const first = await executeI18n(store, { title: naturalDocumentTitle(document), line: 2, languages: ['EN'] })
  assert.equal(first.matches.length, 1)
  assert.equal(first.matches[0].translations.EN.text, 'Different translation.')
  const record = await executeI18n(store, { document_uid: documentUid(profile.document_id), line: 2, languages: ['EN'] })
  assert.equal(record.matches[0].source.text.split('\n').length, 3)
  assert.equal(record.matches[0].translations.EN.text.split('\n').length, 2)
  assert.equal(record.matches[0].references[0].alignment, 'record')
  const unmapped = await executeI18n(store, { document_uid: documentUid(DOC), line: 3, languages: ['EN'] })
  assert.equal(unmapped.status, 'unmapped_source')
})

test('原文片段及外语反查，显式返回 ID 时保留 int64 精度', async (t) => {
  const { store } = await fixture(t)
  const result = await executeI18n(store, { query: 'TRANSLATION', source_language: 'en', match_mode: 'literal', languages: ['CN'], include_ids: true })
  assert.deepEqual(result.matches.map((m) => m.text_id), [FIRST_ID, SECOND_ID])
  const precise = await executeI18n(store, { text_ids: [SECOND_ID], languages: ['EN'], include_ids: true })
  assert.equal(precise.matches[0].text_id, SECOND_ID)
  assert.equal(precise.matches[0].translations.EN.text, 'Different translation.')
  assert.throws(() => normalizeI18nRequest({ text_ids: [Number(FIRST_ID)], languages: ['EN'] }), /字符串/)
})

test('可见原文的富文本标签与区域语言代码可规范化，返回值仍保留官方文本', async (t) => {
  const { store } = await fixture(t, { english: '<@ui>Visible</><br>text 😀' })
  const value = await executeI18n(store, { query: 'visible text 😀', source_language: 'en-US', languages: ['zh-CN'] })
  assert.equal(value.matches.length, 1)
  assert.equal(value.matches[0].source.text, '<@ui>Visible</><br>text 😀')
  assert.equal(value.matches[0].translations.CN.text, '相同原文')
  assert.throws(() => normalizeI18nRequest({ query: '<image>asset/path</image>', languages: ['EN'] }), /可查询/)
})

test('分页绑定查询和版本，长文本分块可以无损重组且不超过正文预算', async (t) => {
  const long = '😀译文\n'.repeat(1500)
  const { store } = await fixture(t, { english: long })
  let result = await executeI18n(store, { query: '相同原文', languages: ['EN'], max_chars: 1000, max_matches: 1 })
  const parts = []
  let calls = 0
  while (true) {
    assert.ok(calls++ < 30)
    const match = result.matches[0]
    assert.ok([...match.source.text, ...(match.translations.EN.text || '')].length <= 1000)
    if (match.references[0].line_start === 1) parts.push(match.translations.EN.text)
    if (!result.page.has_more) break
    const continuation = result.page.continuation
    await assert.rejects(executeI18n(store, { ...continuation, languages: ['JP'] }), /原查询/)
    await assert.rejects(executeI18n(store, { ...continuation, data_version: 'f'.repeat(64) }), { code: 'PACKAGE_VERSION_MISMATCH' })
    result = await executeI18n(store, continuation)
  }
  assert.equal(parts.join(''), long)
})

test('重置后不复用旧版本语言缓存，未带附件的旧包继续可读', async (t) => {
  const { store, releasesDir } = await fixture(t)
  const args = { text_ids: [FIRST_ID], languages: ['EN'] }
  assert.equal((await executeI18n(store, args)).matches[0].translations.EN.text, 'First translation.')
  const next = localizationFixture({ releaseId: 'test-i18n-new', english: 'New translation.' })
  await next.write(releasesDir); store.reset()
  assert.equal((await executeI18n(store, args)).matches[0].translations.EN.text, 'New translation.')
  await localizationFixture({ releaseId: 'legacy', legacy: true }).write(releasesDir); store.reset()
  assert.equal((await executeI18n(store, args)).status, 'unavailable')
  assert.ok(await store.getDocument(DOC))
})

test('读取附件期间切版会拒绝混合结果，取消和模块限制均生效', async (t) => {
  const { store } = await fixture(t)
  const args = { text_ids: [FIRST_ID], languages: ['EN'] }
  await assert.rejects(executeI18n(store, args, { enabledGames: ['arknights'] }), /未启用/)
  await assert.rejects(executeI18n(store, args, { signal: AbortSignal.abort() }), { code: 'CANCELLED' })
  const original = store._readPacked.bind(store)
  t.mock.method(store, '_readPacked', async (...params) => {
    const bytes = await original(...params)
    if (params[1].startsWith('localization/')) store.reset()
    return bytes
  })
  await assert.rejects(executeI18n(store, args), { code: 'PACKAGE_VERSION_MISMATCH' })
})

test('附件经真实安装器下载校验，修改语言元数据不能绕过 release 内容根', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prts-i18n-install-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const data = localizationFixture()
  await ensureCorpusRelease({ releasesDir: root, order: ['site'], fetchImpl: data.fetchImpl })
  const store = new CorpusStore({ releasesDir: root })
  assert.equal((await executeI18n(store, { text_ids: [FIRST_ID], languages: ['EN'] })).status, 'ok')
  const path = join(root, data.release.release_id, 'endfield_official_game', 'pack-manifest.json')
  const changed = JSON.parse(await readFile(path, 'utf8'))
  changed.localization.text_count += 1
  await writeFile(path, JSON.stringify(changed))
  await assert.rejects(validateLocalRelease(root, data.release.release_id), /逐文件哈希/)
})
