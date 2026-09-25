import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInvestigationStore } from '../src/investigation-store.js'
import { mountInvestigationTools } from '../src/investigation-tools.js'
import { buildApi } from '../src/ui.js'
import { createArchiveRack } from '../ui/rhine/archive-rack.ts'

function memoryFacility() {
  const values = new Map(); let fail = false
  return { failNext() { fail = true }, rewrite(fn) { for (const [key, value] of values) values.set(key, fn(structuredClone(value))) },
    async open(spec) {
      let tail = Promise.resolve()
      return { table: () => ({ get: () => values.get(spec.name), put: async (_key, value) => values.set(spec.name, structuredClone(value)),
        update(_key, operation) {
          const task = tail.then(() => {
            const next = spec.tables.portfolios.valueSchema.parse(operation(values.get(spec.name)))
            if (fail) { fail = false; throw new Error('disk unavailable') }
            values.set(spec.name, structuredClone(next)); return structuredClone(next)
          }); tail = task.catch(() => {}); return task
        } }), close: async () => {} }
    } }
}
const source = (id, text = `用户选择 ${id}`) => ({ id, title: `资料 ${id}`, documentId: id, kind: 'story', origin: 'local', state: 'found', excerpt: text, content: text })
function agentTools(store, session = 'session') {
  const hooks = {}, definitions = {}, contexts = [], agent = { session: { id: session }, inject() { assert.fail('must not wake or inject turns') }, steer() { assert.fail('must not wake') } }
  mountInvestigationTools({ on: (name, fn) => { hooks[name] = fn }, tools: { register(d) { definitions[d.name] = d } }, systemPrompt: { context(c) { contexts.push(c) } } }, store)
  let call = 0
  const execute = async args => {
    const exec = { agent, name: 'investigation_get', callId: `read-${++call}` }, value = await definitions.investigation_get.execute(args, exec)
    return { exec, value }
  }
  const deliver = async result => { hooks['tools/result'](result.exec, { value: result.value, isError: false }); await store.prepare(session) }
  return { hooks, definitions, agent, execute, deliver, async read(args) { const result = await execute(args); await deliver(result); return result.value },
    async context() { await hooks['agent/pre-step']({ agent }, async () => ({})); return contexts[0].text({ scope: agent }) } }
}

test('bookmarks persist, remain unverified, deduplicate and can be recalled by source ID', async () => {
  const facility = memoryFacility(), store = createInvestigationStore(facility)
  const input = { action: 'add', mutation_id: 'save', sources: [{ ...source('a'), state: 'read', agentRead: true }] }
  const saved = await store.saveRack('session', input)
  assert.deepEqual(await store.saveRack('session', input), saved)
  assert.equal((await store.inspect('session', { section: 'rack' })).sources[0].agentRead, false)
  assert.equal(store.reviewSummary('session').pending_count, 1)
  const full = await store.inspect('session', { section: 'source', source_id: saved.added_ids[0] })
  assert.equal(full.source.content, '用户选择 a')
  await store.close()
  const reopened = createInvestigationStore(facility), tools = agentTools(reopened)
  assert.match(await tools.context(), /"pending_count":1/)
  assert.match(await tools.context(), /资料 a/)
  // UI reads, overview, and notification directories do not acknowledge actual content.
  await reopened.read('session', { section: 'rack' }); await tools.read({}); await tools.read({ section: 'changes' })
  assert.equal(reopened.reviewSummary('session').pending_count, 1)
  await tools.read({ section: 'source', source_id: 'R0001' })
  assert.equal(reopened.reviewSummary('session').pending_count, 0)
  assert.equal((await reopened.inspect('session', { section: 'source', source_id: 'R0001' })).source.agentRead, false)
  await assert.rejects(reopened.inspect('other-session', { section: 'source', source_id: 'R0001' }), /来源不存在/)
  await reopened.close()
})

test('paged recall acknowledges only delivered items and keeps concurrent user changes pending', async () => {
  const store = createInvestigationStore(memoryFacility()), tools = agentTools(store)
  const { board_id } = await store.createUserBoard('session', { mutation_id: 'board', title: '用户调查' })
  await store.edit('session', { board_id, mutation_id: 'clues', changes: [{ title: 'first', detail: 'first body' }, { title: 'second', detail: 'second body' }] })
  assert.equal(store.reviewSummary('session').pending_count, 3)
  await tools.read({ board_id }); assert.equal(store.reviewSummary('session').pending_count, 2)
  const first = await tools.execute({ board_id, section: 'clues', limit: 1 })
  assert.equal(first.value.clues[0].detail, 'first body'); assert.equal(first.value.nextCursor, 1)
  const rendered = tools.definitions.investigation_get.output.render({}, first.value)[0].text
  assert(!rendered.includes('_review'))
  tools.hooks['tools/result'](first.exec, { value: first.value, isError: true })
  assert.equal(store.reviewSummary('session').pending_count, 2)
  await store.edit('session', { board_id, mutation_id: 'race', changes: [{ id: 'C001', expected_content_revision: 1, detail: 'newer body' }] })
  await tools.deliver(first); assert.equal(store.reviewSummary('session').pending_count, 2)
  assert.equal((await tools.read({ board_id, section: 'clues', clue_id: 'C001' })).clues[0].detail, 'newer body')
  assert.equal(store.reviewSummary('session').pending_count, 1)
  await tools.read({ board_id, section: 'clues', cursor: 1, limit: 1 })
  assert.equal(store.reviewSummary('session').pending_count, 0)
  await store.edit('session', { board_id, mutation_id: 'move', changes: [{ id: 'C001', action: 'layout', expected_layout_revision: 0, scale: 1.2 }], relations: [] })
  assert.equal(store.reviewSummary('session').pending_count, 0)
  await store.edit('session', { board_id, mutation_id: 'delete', changes: [{ id: 'C001', action: 'retract', expected_content_revision: 2 }] })
  assert.equal((await tools.read({ board_id, section: 'clues', clue_id: 'C001' })).clues[0].status, 'retracted')
  assert.equal(store.reviewSummary('session').pending_count, 0)
  await store.close()
})

test('important evidence recalls notes; old reports and unrelated boards never consume changes', async () => {
  const store = createInvestigationStore(memoryFacility()), tools = agentTools(store)
  const exec = { callId: 'open', turnId: 1 }, board = await store.open('session', { mode: 'new', title: 'Agent 调查', objective: '核验', reason: '测试' }, exec)
  await store.recordSources('session', [{ ...source('a'), agentRead: true, state: 'read', lineStart: 1, lineEnd: 2 }], 'original')
  assert.equal(store.reviewSummary('session').pending_count, 0)
  await store.publish('session', { ...board, expected_revision: 0, title: 'old report', summary: 'saved', markdown: 'old conclusion', clue_ids: [] }, { ...exec, callId: 'report' })
  await store.editInbox('session', { board_id: board.board_id, mutation_id: 'inbox', action: 'add', expected_inbox_revision: 0, source_id: 'R0001', note: '请核对这里的矛盾' })
  await tools.read({ board_id: board.board_id, section: 'report' })
  assert.equal(store.reviewSummary('session').pending_count, 1)
  const inbox = await tools.read({ board_id: board.board_id, section: 'inbox' })
  assert.equal(inbox.items[0].note, '请核对这里的矛盾'); assert.equal(inbox.items[0].source.agentRead, true)
  assert.equal(store.reviewSummary('session').pending_count, 0)
  await store.editInbox('session', { board_id: board.board_id, mutation_id: 'remove', action: 'remove', expected_inbox_revision: 1, source_id: 'R0001' })
  const removed = await tools.read({ board_id: board.board_id, section: 'inbox' })
  assert.equal(removed.items[0].status, 'removed'); assert.equal(store.reviewSummary('session').pending_count, 0)
  await store.close()
})

test('legacy bookmark import cannot replace newer content and old portfolio schemas remain readable', async () => {
  const facility = memoryFacility(), store = createInvestigationStore(facility)
  await store.saveRack('session', { action: 'add', mutation_id: 'current', sources: [source('a', 'newest')] })
  await store.saveRack('session', { action: 'import', sources: [source('a', 'stale cached text'), source('b')] })
  await store.saveRack('session', { action: 'import', sources: [source('a', 'stale cached text'), source('b')] })
  assert.equal((await store.inspect('session', { section: 'source', source_id: 'R0001' })).source.content, 'newest')
  assert.equal(store.reviewSummary('session').pending_count, 2)
  await store.close()
  facility.rewrite(p => { delete p.rack; delete p.rackRevision; delete p.attention; return p })
  const reopened = createInvestigationStore(facility)
  assert.equal((await reopened.inspect('session', { section: 'rack' })).sources.length, 0)
  assert.equal((await reopened.inspect('session', { section: 'sources' })).sources.length, 2)
  await reopened.saveRack('session', { action: 'add', mutation_id: 'new-schema', sources: [source('a')] })
  assert.equal(reopened.reviewSummary('session').pending_count, 1)
  await reopened.close()
})

test('shared UI routes publish reminders only after a successful durable write', async () => {
  const facility = memoryFacility(), store = createInvestigationStore(facility), api = buildApi({ investigations: store })
  await store.prepare('session'); facility.failNext()
  await assert.rejects(api.call('POST', '/api/prts-corpus/investigation/rack', { session_id: 'session', action: 'add', mutation_id: 'save', sources: [source('a')] }), /disk unavailable/)
  assert.equal(store.reviewSummary('session').pending_count, 0)
  const result = await api.call('POST', '/api/prts-corpus/investigation/rack', { session_id: 'session', action: 'add', mutation_id: 'save', sources: [source('a')] })
  assert.equal(result.status, 200)
  const ui = await api.call('POST', '/api/prts-corpus/investigation/get', { session_id: 'session', section: 'rack', saved_only: true })
  assert.equal(ui.json.sources[0].content, '用户选择 a'); assert.equal(ui.json._review, undefined)
  assert.equal(store.reviewSummary('session').pending_count, 1)
  await store.close()
})

test('rack client migrates browser saves, retries failure and restores server bookmarks', async () => {
  const store = createInvestigationStore(memoryFacility()), failures = []; let current = [], fail = false
  const api = async (endpoint, { session_id, ...args }) => {
    if (fail && endpoint === 'investigation.rack') throw new Error('offline')
    return endpoint === 'investigation.rack' ? store.saveRack(session_id, args) : store.read(session_id, args)
  }
  const rack = createArchiveRack({ api, changed: sources => { current = sources }, failed: text => failures.push(text) })
  await rack.setSession('session', [source('old')]); assert.equal(store.reviewSummary('session').user_saved_count, 1)
  fail = true; await assert.rejects(rack.save(source('new')), /offline/)
  assert(current.some(s => s.id === 'new')); assert(rack.isPending(source('new'))); assert.equal(failures.length, 1)
  fail = false; await rack.save(source('new')); assert.equal(rack.isPending(source('new')), false)
  await rack.setSession('session', []); assert.deepEqual(current.map(s => s.id).sort(), ['new', 'old'])
  assert.equal(store.reviewSummary('session').pending_count, 2)
  rack.dispose(); await store.close()
})

test('rack client keeps in-flight saves bound to the original session', async () => {
  const store = createInvestigationStore(memoryFacility()), requests = []; let current = [], release, entered
  const ready = new Promise(resolve => { entered = resolve })
  const delayed = new Promise(resolve => { release = resolve })
  const rack = createArchiveRack({ changed: value => { current = value }, failed() {},
    api: async (endpoint, { session_id, ...args }) => {
      requests.push({ endpoint, session_id })
      if (endpoint === 'investigation.rack') { entered(); await delayed; return store.saveRack(session_id, args) }
      return store.read(session_id, args)
    } })
  await rack.setSession('old', [])
  const saving = rack.save(source('old-source')); const rejected = assert.rejects(saving, e => e.name === 'AbortError')
  await ready; await rack.setSession('new', []); release(); await rejected
  assert.deepEqual(current, []); assert.equal(store.reviewSummary('new').user_saved_count, 0)
  assert.equal(requests.find(r => r.endpoint === 'investigation.rack').session_id, 'old')
  rack.dispose(); await store.close()
})
