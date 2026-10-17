import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadEntityRelationCatalog } from '../src/entity-routing.js'

test('relation catalog invalidates on scope and installation changes at the same data version', async () => {
  let loads = 0
  let prototype = 'first prototype'
  const store = {
    dataVersion: 'a'.repeat(64), scopeFingerprint: 'arknights-only', installationId: 'install-one',
    async getDocumentByPath() {
      loads += 1
      return { record: { lines: [{ text: JSON.stringify({ retravelers: [{
        endfield_name: 'Scope test traveler', terra_memory_prototype: prototype,
      }] }) }] } }
    },
  }
  const relation = (catalog) => catalog.retravelers.find((row) => row.endfield_name === 'Scope test traveler')
  const first = await loadEntityRelationCatalog(store)
  assert.equal(relation(first).terra_memory_prototype, prototype)
  assert.equal(await loadEntityRelationCatalog(store), first)
  assert.equal(loads, 1)
  store.scopeFingerprint = 'both-games'
  prototype = 'second prototype'
  const expanded = await loadEntityRelationCatalog(store)
  assert.equal(relation(expanded).terra_memory_prototype, prototype)
  assert.notEqual(expanded, first)
  assert.equal(loads, 2)
  store.installationId = 'install-two'
  prototype = 'reinstalled prototype'
  const reinstalled = await loadEntityRelationCatalog(store)
  assert.equal(relation(reinstalled).terra_memory_prototype, prototype)
  assert.equal(await loadEntityRelationCatalog(store), reinstalled)
  assert.equal(loads, 3)
})
