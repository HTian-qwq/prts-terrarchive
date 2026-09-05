import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CorpusStore, computeLinesIntegrity } from '../src/store.js'
import { validateLocalRelease } from '../src/installer.js'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const canonicalJson = (value) => Array.isArray(value)
  ? `[${value.map(canonicalJson).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
    : JSON.stringify(value)

test('ngram 能力按查询涉及的 pack 判定，不被无关旧包拖回全库扫描', () => {
  const store = new CorpusStore({ releasesDir: '/tmp/prts-ngram-scope-test' })
  store.packs = new Map([
    ['official_game', { search_index: {
      algorithm: 'prts-browser-trigram-postings-v1', shards: [{}],
    } }],
    ['reviewed_wiki', { search_index: {
      algorithm: 'prts-browser-ngram-postings-v2', gram_sizes: [1, 2, 3], shards: [{}],
    } }],
  ])
  assert.equal(store.supportsNgramSize(2), false)
  assert.equal(store.supportsNgramSize(2, ['reviewed_wiki']), true)
  assert.equal(store.supportsNgramSize(2, ['official_game']), false)
  assert.equal(store.supportsNgramSize(3, ['official_game', 'reviewed_wiki']), true)
  assert.equal(store.supportsNgramSize(2, []), false)
  assert.equal(store.supportsNgramSize(2, ['missing_pack']), false)
})

async function makeRelease(releasesDir, { declaredUncompressed = null, withCatalog = false } = {}) {
  const releaseId = 'secure-release'
  const packId = 'references'
  const lines = [{ line_number: 1, line_type: 'narration', speaker_raw: '', text: '可信正文' }]
  const record = {
    search_index_id: 1,
    document: { document_id: 'client:references:secure',
      source_ref_prefix: `client_data:references:${'a'.repeat(24)}`,
      display_title: '可信资料', document_type: 'reference', document_kind: 'reference',
      line_count: 1 },
    lines, speakers: [], local_integrity: { algorithm: 'sha256:joined-lines-v1',
      sha256: computeLinesIntegrity(lines) },
  }
  const plain = Buffer.from(`${JSON.stringify(record)}\n`)
  const shard = gzipSync(plain)
  const catalogPlain = Buffer.from(`${JSON.stringify({
    document: record.document, speakers: record.speakers, search_index_id: 1,
    shard_path: 'shards/00000.jsonl.gz', record_index: 0,
  })}\n`)
  const catalogBytes = gzipSync(catalogPlain)
  const uncompressedSize = declaredUncompressed ?? plain.length
  const packDir = join(releasesDir, releaseId, packId)
  await mkdir(join(packDir, 'shards'), { recursive: true })
  await writeFile(join(packDir, 'shards', '00000.jsonl.gz'), shard)
  if (withCatalog) {
    await mkdir(join(packDir, 'catalog'))
    await writeFile(join(packDir, 'catalog', 'documents.jsonl.gz'), catalogBytes)
  }
  const catalog = withCatalog ? {
    algorithm: 'prts-browser-document-catalog-v1', schema_version: 1,
    path: 'catalog/documents.jsonl.gz', document_count: 1,
    compressed_size: catalogBytes.length, uncompressed_size: catalogPlain.length,
    sha256: sha256(catalogBytes),
  } : null
  const packCompressed = shard.length + (catalog?.compressed_size ?? 0)
  const packUncompressed = uncompressedSize + (catalog?.uncompressed_size ?? 0)
  const pack = {
    algorithm: 'prts-browser-corpus-pack-v1', schema_version: 1, pack_id: packId,
    data_version: 'b'.repeat(64), document_count: 1, line_count: 1,
    compressed_size: packCompressed, uncompressed_size: packUncompressed,
    shards: [{ path: 'shards/00000.jsonl.gz', compressed_size: shard.length,
      uncompressed_size: uncompressedSize, sha256: sha256(shard), document_count: 1 }],
    search_index: { shards: [] },
    ...(catalog ? { document_catalog: catalog } : {}),
  }
  await writeFile(join(packDir, 'pack-manifest.json'), JSON.stringify(pack))
  const descriptor = { pack_id: packId, manifest_path: `${packId}/pack-manifest.json`,
    data_version: pack.data_version, document_count: 1, line_count: 1,
    compressed_size: packCompressed, uncompressed_size: packUncompressed,
    shard_count: 1 + (catalog ? 1 : 0) }
  const compilerVersion = 'prts-browser-corpus-compiler-test-v1'
  const sourceSnapshot = 'store-security-snapshot-v1'
  const dataVersion = sha256(Buffer.from(canonicalJson({
    compiler_version: compilerVersion,
    source_snapshot: sourceSnapshot,
    packs: [{
      pack_id: packId,
      data_version: pack.data_version,
      authority: pack.authority ?? 'official',
      shards: pack.shards.map((asset) => ({ path: asset.path, sha256: asset.sha256 })),
      search_index_shards: [],
      ...(catalog ? { document_catalog: { path: catalog.path, sha256: catalog.sha256 } } : {}),
    }],
  })))
  await writeFile(join(releasesDir, releaseId, 'release-manifest.json'), JSON.stringify({
    algorithm: 'prts-browser-corpus-release-v1', schema_version: 1,
    release_id: releaseId, data_version: dataVersion, corpus_version: dataVersion,
    content_tree_sha256: dataVersion, compiler_version: compilerVersion,
    minimum_agent_version: '0.1.0',
    source_update_id: `local-snapshot:${sourceSnapshot}`, required_packs: [packId],
    packs: [descriptor], document_count: 1, line_count: 1,
    compressed_size: packCompressed, uncompressed_size: packUncompressed,
  }))
  await writeFile(join(releasesDir, 'current.json'), JSON.stringify({
    release_id: releaseId, data_version: dataVersion,
  }))
  return { releaseId, packDir, plain, shard, dataVersion, catalog }
}

test('v1 文档目录使 ready 只解压轻量目录，正文延迟到首次读取', async () => {
  const releasesDir = await mkdtemp(join(tmpdir(), 'prts-store-catalog-'))
  try {
    await makeRelease(releasesDir, { withCatalog: true })
    const store = new CorpusStore({ releasesDir })
    const reads = []
    const original = store._readPacked.bind(store)
    store._readPacked = async (packId, path, ...rest) => {
      reads.push(`${packId}/${path}`)
      return original(packId, path, ...rest)
    }
    await store.ready()
    assert.deepEqual(reads, ['references/catalog/documents.jsonl.gz'])
    assert.equal(store.documents.size, 1)
    const result = await store.getDocument('client:references:secure')
    assert.equal(result.record.lines[0].text, '可信正文')
    assert.deepEqual(reads, [
      'references/catalog/documents.jsonl.gz',
      'references/shards/00000.jsonl.gz',
    ])
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})

test('Store 只加载 release-manifest 声明的 pack，忽略残留目录', async () => {
  const releasesDir = await mkdtemp(join(tmpdir(), 'prts-store-secure-'))
  try {
    const { releaseId } = await makeRelease(releasesDir)
    const extra = join(releasesDir, releaseId, 'official_game')
    await mkdir(extra)
    await writeFile(join(extra, 'pack-manifest.json'), JSON.stringify({
      pack_id: 'official_game', shards: [{ path: '../../../../outside.jsonl.gz' }],
    }))
    const store = new CorpusStore({ releasesDir })
    await store.ready()
    assert.deepEqual([...store.packs.keys()], ['references'])
    assert.equal(store.documents.size, 1)
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})

test('本地 release 拒绝经符号链接逃逸的 shard 目录', async () => {
  const releasesDir = await mkdtemp(join(tmpdir(), 'prts-store-symlink-'))
  const outside = await mkdtemp(join(tmpdir(), 'prts-store-outside-'))
  try {
    const { releaseId, packDir, shard } = await makeRelease(releasesDir)
    await writeFile(join(outside, '00000.jsonl.gz'), shard)
    await rm(join(packDir, 'shards'), { recursive: true })
    await symlink(outside, join(packDir, 'shards'), 'dir')
    await assert.rejects(
      () => validateLocalRelease(releasesDir, releaseId, { verifyHashes: true }),
      (error) => error?.code === 'INVALID_RELEASE' && /受管目录/.test(error.message),
    )
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('gunzip 在声明的 uncompressed_size 处强制停止', async () => {
  const releasesDir = await mkdtemp(join(tmpdir(), 'prts-store-gzip-'))
  try {
    const provisional = await makeRelease(releasesDir)
    await rm(releasesDir, { recursive: true })
    await mkdir(releasesDir)
    await makeRelease(releasesDir, { declaredUncompressed: provisional.plain.length - 1 })
    const store = new CorpusStore({ releasesDir })
    await assert.rejects(() => store.ready(), (error) =>
      error?.code === 'ERR_BUFFER_TOO_LARGE' || /decompress|Buffer larger/i.test(error?.message ?? ''))
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})

test('current.json 必须是受管普通小文件，不能用符号链接代替', async () => {
  const releasesDir = await mkdtemp(join(tmpdir(), 'prts-store-pointer-'))
  const outside = await mkdtemp(join(tmpdir(), 'prts-store-pointer-outside-'))
  try {
    await makeRelease(releasesDir)
    const external = join(outside, 'pointer.json')
    await writeFile(external, JSON.stringify({
      release_id: 'secure-release', data_version: 'c'.repeat(64),
    }))
    await rm(join(releasesDir, 'current.json'))
    await symlink(external, join(releasesDir, 'current.json'))
    const store = new CorpusStore({ releasesDir })
    await assert.rejects(() => store.ready(), (error) =>
      error?.code === 'INVALID_RELEASE' && /current\.json/.test(error.message))
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('本地 release 的旧 data_version 不能认可被替换且重新汇总的分片', async () => {
  const releasesDir = await mkdtemp(join(tmpdir(), 'prts-store-root-'))
  try {
    const { releaseId, packDir, dataVersion } = await makeRelease(releasesDir)
    const lines = [{ line_number: 1, line_type: 'narration', speaker_raw: '', text: '已替换正文' }]
    const replacement = gzipSync(Buffer.from(`${JSON.stringify({
      search_index_id: 1,
      document: { document_id: 'client:references:secure',
        source_ref_prefix: `client_data:references:${'a'.repeat(24)}`,
        display_title: '可信资料', document_type: 'reference', document_kind: 'reference',
        line_count: 1 },
      lines, speakers: [], local_integrity: { algorithm: 'sha256:joined-lines-v1',
        sha256: computeLinesIntegrity(lines) },
    })}\n`))
    const replacementPlain = gunzipSync(replacement)
    await writeFile(join(packDir, 'shards', '00000.jsonl.gz'), replacement)

    const packPath = join(packDir, 'pack-manifest.json')
    const pack = JSON.parse(await readFile(packPath, 'utf8'))
    Object.assign(pack, { compressed_size: replacement.length,
      uncompressed_size: replacementPlain.length })
    Object.assign(pack.shards[0], { sha256: sha256(replacement),
      compressed_size: replacement.length, uncompressed_size: replacementPlain.length })
    await writeFile(packPath, JSON.stringify(pack))

    const releasePath = join(releasesDir, releaseId, 'release-manifest.json')
    const release = JSON.parse(await readFile(releasePath, 'utf8'))
    Object.assign(release, { compressed_size: replacement.length,
      uncompressed_size: replacementPlain.length })
    Object.assign(release.packs[0], { compressed_size: replacement.length,
      uncompressed_size: replacementPlain.length })
    assert.equal(release.data_version, dataVersion, '攻击者沿用旧内容根')
    await writeFile(releasePath, JSON.stringify(release))

    await assert.rejects(
      () => validateLocalRelease(releasesDir, releaseId, { verifyHashes: true }),
      (error) => error?.code === 'INVALID_RELEASE' && /data_version/.test(error.message),
    )
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})

test('Store 装载后重新读取分片时再次核对可信哈希', async () => {
  const releasesDir = await mkdtemp(join(tmpdir(), 'prts-store-swap-'))
  try {
    const { packDir } = await makeRelease(releasesDir)
    const store = new CorpusStore({ releasesDir })
    await store.ready()
    const shardPath = join(packDir, 'shards', '00000.jsonl.gz')
    const original = await readFile(shardPath)
    const changed = Buffer.from(original)
    changed[changed.length - 1] ^= 1
    await writeFile(shardPath, changed)
    await assert.rejects(() => store.getDocument('client:references:secure'),
      /checksum changed after release validation/)
  } finally {
    await rm(releasesDir, { recursive: true, force: true })
  }
})

function makeShortLiteralScanStore({ shardCount = 1 } = {}) {
  const store = new CorpusStore({ releasesDir: '/unused-short-literal-test' })
  const record = {
    document: { document_id: 'short-literal-document', display_title: '甲乙丙丁' },
    lines: [{ line_number: 1, text: '甲乙丙丁' }],
  }
  store.releaseId = 'short-literal-release'
  store.unstableChars = new Map()
  store.documents = new Map([[record.document.document_id, {
    document: record.document, ordinal: 0,
  }]])
  store.packs = new Map([['official_game', { shards: Array.from({ length: shardCount }, (_, index) => ({
    path: `shards/${index}.jsonl.gz`, compressed_size: 1, uncompressed_size: 1,
    sha256: 'a'.repeat(64),
  })) }]])
  store._decodeShard = (_bytes, checkpoint) => {
    checkpoint?.()
    return [record]
  }
  return store
}

const waitTurn = () => new Promise((resolve) => { setImmediate(resolve) })

test('短字面量全库扫描跨查询串行，排队等待可独立取消或超时', async () => {
  const store = makeShortLiteralScanStore()
  let unblockFirst
  const firstGate = new Promise((resolve) => { unblockFirst = resolve })
  let reads = 0
  let activeReads = 0
  let maximumActiveReads = 0
  store._readPacked = async () => {
    reads += 1
    activeReads += 1
    maximumActiveReads = Math.max(maximumActiveReads, activeReads)
    if (reads === 1) await firstGate
    activeReads -= 1
    return Buffer.from('甲乙丙丁')
  }

  const first = store.findDocumentsByShortLiteral('甲', { deadline: Date.now() + 1000 })
  await waitTurn()
  const controller = new AbortController()
  const cancelled = store.findDocumentsByShortLiteral('乙', {
    signal: controller.signal, deadline: Date.now() + 1000,
  })
  const timedOut = store.findDocumentsByShortLiteral('丙', { deadline: Date.now() + 20 })
  const final = store.findDocumentsByShortLiteral('丁', { deadline: Date.now() + 1000 })
  controller.abort()

  const cancellation = await Promise.race([
    cancelled.then(() => null, (error) => error),
    new Promise((resolve) => setTimeout(() => resolve('late'), 100)),
  ])
  assert.notEqual(cancellation, 'late', '排队请求必须在前一轮扫描完成前响应取消')
  assert.equal(cancellation?.code, 'CANCELLED')
  const timeout = await Promise.race([
    timedOut.then(() => null, (error) => error),
    new Promise((resolve) => setTimeout(() => resolve('late'), 100)),
  ])
  assert.notEqual(timeout, 'late', '排队请求必须在前一轮扫描完成前响应 deadline')
  assert.equal(timeout?.code, 'TIMEOUT')

  unblockFirst()
  assert.deepEqual(await first, ['short-literal-document'])
  assert.deepEqual(await final, ['short-literal-document'])
  await store._shortLiteralScanTail
  assert.equal(maximumActiveReads, 1, '不同短词的全库扫描不得并发')
})

test('短字面量全库扫描队列有固定上限', async () => {
  const store = makeShortLiteralScanStore()
  let unblock
  const gate = new Promise((resolve) => { unblock = resolve })
  let reads = 0
  store._readPacked = async () => {
    reads += 1
    if (reads === 1) await gate
    return Buffer.from('甲乙丙丁')
  }
  const queries = [...'甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳']
  const accepted = queries.map((query) => store.findDocumentsByShortLiteral(query,
    { deadline: Date.now() + 1000 }))
  await waitTurn()
  await assert.rejects(
    () => store.findDocumentsByShortLiteral('午', { deadline: Date.now() + 1000 }),
    (error) => error?.code === 'BUDGET_EXCEEDED' && error.retryable === true,
  )
  unblock()
  await Promise.all(accepted)
  await store._shortLiteralScanTail
  assert.equal(store._shortLiteralScanPending, 0)
})

test('短字面量扫描在分片循环内响应取消，并限制单轮解压并发', async () => {
  const store = makeShortLiteralScanStore({ shardCount: 20 })
  const controller = new AbortController()
  let reads = 0
  store._readPacked = async () => {
    reads += 1
    controller.abort()
    return Buffer.from('甲')
  }
  await assert.rejects(
    () => store.findDocumentsByShortLiteral('甲', {
      signal: controller.signal, deadline: Date.now() + 1000,
    }),
    (error) => error?.code === 'CANCELLED',
  )
  await store._shortLiteralScanTail
  assert.ok(reads <= 4, `取消后不应继续领取分片任务，实际读取 ${reads} 个`)
})

test('短字面量扫描 deadline 到期后不再领取后续分片', async () => {
  const store = makeShortLiteralScanStore({ shardCount: 20 })
  let reads = 0
  store._readPacked = async () => {
    reads += 1
    await new Promise((resolve) => setTimeout(resolve, 20))
    return Buffer.from('甲')
  }
  await assert.rejects(
    () => store.findDocumentsByShortLiteral('甲', { deadline: Date.now() + 5 }),
    (error) => error?.code === 'TIMEOUT' && error.retryable === true,
  )
  await store._shortLiteralScanTail
  assert.ok(reads <= 4, `deadline 后不应领取下一批分片，实际读取 ${reads} 个`)
})

test('短字面量候选缓存按总候选 ID 数淘汰，而非只限制查询个数', () => {
  const store = makeShortLiteralScanStore()
  const candidates = Array.from({ length: 5000 }, (_, index) => `document-${index}`)
  for (let index = 0; index < 32; index += 1) {
    store._rememberShortLiteralCandidates(`query-${index}`, candidates)
  }
  assert.ok(store._shortLiteralCacheCandidateCount <= 65_536)
  assert.ok(store._shortLiteralCache.size < 32,
    '32 个大候选数组必须因总候选预算提前淘汰')
  store.reset()
  assert.equal(store._shortLiteralCacheCandidateCount, 0)
})

test('完全相同的重复角色投影保留可续读的自然资料定位器', () => {
  const store = new CorpusStore({ releasesDir: '/unused-character-material-test' })
  const makeDocument = (documentId) => ({
    game: 'endfield', document_id: documentId, document_type: 'character',
    document_category: '角色档案', character_name: '管理员',
    text_sha256: 'a'.repeat(64),
  })
  store.documents = new Map([
    ['endfield:character:admin-f', { document: makeDocument('endfield:character:admin-f') }],
    ['endfield:character:admin-m', { document: makeDocument('endfield:character:admin-m') }],
  ])
  store.characterMaterialIndex.set('endfield\0管理员\0profile', [
    'endfield:character:admin-m', 'endfield:character:admin-f',
  ])
  assert.equal(store.hasUniqueCharacterMaterial('endfield:character:admin-f'), true)
  assert.equal(store.hasUniqueCharacterMaterial('endfield:character:admin-m'), false)
})
