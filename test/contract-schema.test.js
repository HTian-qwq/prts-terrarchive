import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const schema = JSON.parse(readFileSync(
  new URL('../contracts/corpus_tools_v1.schema.json', import.meta.url), 'utf8'))

function resolveLocalRef(root, ref) {
  if (!ref.startsWith('#/')) return undefined
  return ref.slice(2).split('/').reduce((value, rawPart) => {
    const part = rawPart.replaceAll('~1', '/').replaceAll('~0', '~')
    return value?.[part]
  }, root)
}

test('正式工具 contract 的所有本地 $ref 均可解析', () => {
  const pending = [schema]
  while (pending.length) {
    const value = pending.pop()
    if (!value || typeof value !== 'object') continue
    if (typeof value.$ref === 'string' && value.$ref.startsWith('#/')) {
      assert.notEqual(resolveLocalRef(schema, value.$ref), undefined,
        `无法解析本地 schema 引用 ${value.$ref}`)
    }
    pending.push(...Object.values(value))
  }
})

test('自然搜索锚点在请求与响应 contract 中完整绑定 data_version', () => {
  const anchor = schema.$defs.searchPageAnchor
  assert.deepEqual(anchor.required, ['data_version', 'resource_type', 'title', 'position'])
  assert.equal(anchor.additionalProperties, false)
  assert.equal(anchor.properties.data_version.$ref, '#/$defs/sha256')
  assert.equal(anchor.properties.position.minimum, 0)
  assert.equal(anchor.properties.position.maximum, 10_000_000)
  assert.equal(schema.$defs.corpusSearchRequest.properties.after.$ref,
    '#/$defs/searchPageAnchor')
  assert.equal(schema.$defs.searchPageInfo.properties.next_after.oneOf[0].$ref,
    '#/$defs/searchPageAnchor')
  assert.ok(schema.$defs.toolError.properties.code.enum.includes('PAGE_ANCHOR_VERSION_MISMATCH'))
})

test('联合读取 contract 覆盖终末地引用、资料摘要与合集位置', () => {
  const sourcePattern = new RegExp(schema.$defs.sourceRef.pattern, 'u')
  assert.equal(sourcePattern.test('prts:endfield:story/dialogue%2Ftest:L12'), true)
  assert.equal(sourcePattern.test('prts:arknights:story/test:L1'), true)
  assert.ok(schema.$defs.lineEntry.properties.line_type.enum.includes('archive'))
  assert.ok(schema.$defs.lineEntry.properties.line_type.enum.includes('voice'))
  for (const field of ['document_uid', 'game', 'resource_type', 'content_type',
    'collection_name', 'collection_type', 'entity_id']) {
    assert.ok(schema.$defs.documentSummary.required.includes(field), field)
    assert.ok(schema.$defs.documentSummary.properties[field], field)
  }
  assert.ok(schema.$defs.readSelection.oneOf.some((selection) =>
    selection.properties?.mode?.const === 'collection'
      && selection.properties?.start_position?.minimum === 1))
  assert.ok(schema.$defs.corpusReadOkResponse.properties.stream)
})
