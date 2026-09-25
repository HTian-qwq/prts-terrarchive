import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { build } from 'esbuild';
import { chromium, rhineBrowserOptions } from './helpers/rhine-browser-env.mjs';
import { createInvestigationStore } from '../src/investigation-store.js';

// Real editor + controller + durable-store contract, without WebGL or screenshot artifacts.
const root = fileURLToPath(new URL('../', import.meta.url));
const code = await build({ stdin: { contents: `
  import { mountInvestigationBoard } from './ui/rhine/investigation-board.ts';
  import { mountEvidenceBoardPanel } from './ui/rhine/evidence-board-panel.ts';
  window.setup = sessionId => {
    const host = document.getElementById('app'), notices = [], opened = [];
    let controller;
    const panel = mountEvidenceBoardPanel(host, { sessionId, managed: true,
      onChange(cards) { controller?.userChange(cards); }, onSelect() {}, onBrowse() {}, onToolChange() {} });
    controller = mountInvestigationBoard(host, { sessionId, panel,
      api: (endpoint, payload, signal) => {
        if (endpoint === 'investigation.watch') return new Promise((resolve, reject) =>
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
        return window.callApi(endpoint, payload);
      }, onInbox() {}, onReading() {}, onCards() {},
      openSource(source) { opened.push(source); }, notify(message) { notices.push(message); } });
    controller.setActive(true); panel.setActive(true);
    window.test = { controller, panel, notices, opened,
      change(cards) { panel.replaceCards(cards); controller.userChange(cards); },
      switchBoard(id) { const picker = document.querySelector('.rhine-investigation-picker');
        picker.value = id; picker.dispatchEvent(new Event('change')); },
      async session(id) { panel.closeTools(); const loaded = controller.setSession(id); panel.setSession(id); await loaded; },
      dispose() { panel.closeTools(); controller.dispose(); panel.dispose(); } };
  };`, loader: 'js', resolveDir: root }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' } });

function memoryFacility() {
  const values = new Map();
  return { async open(spec) {
    let tail = Promise.resolve();
    return { table() { return {
      get() { return values.get(spec.name); },
      async put(_key, value) { values.set(spec.name, structuredClone(value)); },
      update(_key, operation) {
        const task = tail.then(() => {
          const next = spec.tables.portfolios.valueSchema.parse(operation(values.get(spec.name)));
          values.set(spec.name, structuredClone(next)); return structuredClone(next);
        }); tail = task.catch(() => {}); return task;
      },
    }; }, async close() {} };
  } };
}
const service = createInvestigationStore(memoryFacility()), errors = [], requests = [];
let delay = 0;
const browser = await chromium.launch(rhineBrowserOptions);
async function pageFor(session) {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://investigation.test/**', route => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><style>[hidden]{display:none!important}</style><div id="app" style="width:1200px;height:900px"></div>' }));
  await page.exposeFunction('callApi', async (endpoint, payload) => {
    requests.push({ endpoint, payload: structuredClone(payload) });
    if (endpoint === 'investigation.edit' && delay) await new Promise(resolve => setTimeout(resolve, delay));
    const { session_id, ...args } = payload;
    const action = { 'investigation.get': 'read', 'investigation.edit': 'edit', 'investigation.create': 'createUserBoard',
      'investigation.import': 'importLegacy', 'investigation.inbox': 'editInbox' }[endpoint];
    return service[action](session_id, args);
  });
  await page.goto('https://investigation.test/'); await page.addScriptTag({ content: code.outputFiles[0].text });
  await page.evaluate(s => window.setup(s), session);
  await page.waitForFunction(() => window.test.controller.getContext().ready);
  return page;
}
async function board(session, key) {
  const b = await service.createUserBoard(session, { mutation_id: key, title: key });
  await service.edit(session, { board_id: b.board_id, mutation_id: key + '-clue',
    changes: [{ client_key: 'first', title: key + ' original', kind: 'question', detail: 'body' }] });
  return b.board_id;
}
async function saved(page) {
  await page.waitForFunction(() => window.test.controller.stats().saving === 0 &&
    !document.querySelector('.rhine-investigation-status').textContent.includes('正在同步'));
}
async function close(page) { await page.evaluate(() => window.test.dispose()); await page.close(); }
const read = async (session, board_id) => (await service.read(session, { board_id })).board;
async function verifyReader(session) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  // Exercise the shipped DOM reader in its supported reading-only mode.
  // Software WebGL scene construction can block unrelated DOM assertions on CI.
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      return /webgl/i.test(type) ? null : getContext.call(this, type, ...args);
    };
  });
  const reads = [], assetRoot = resolve(root, 'lib/rhine');
  await page.route('https://reader.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/rhine/')) {
      const path = resolve(assetRoot, decodeURIComponent(pathname.slice(7)));
      assert(path.startsWith(assetRoot + sep));
      const contentType = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.webp': 'image/webp' }[extname(path)] || 'application/octet-stream';
      return route.fulfill({ body: await readFile(path), contentType });
    }
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/rhine/rhine.css"><style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden}</style><div id="app"></div><script src="/rhine/rhine.js"></script>' });
  });
  await page.exposeFunction('readerApi', async (endpoint, payload) => {
    if (endpoint === 'read') {
      reads.push(payload); const start = payload.selection.start_line || 1;
      return { data_version: 'test', content: { lines: Array.from({ length: 150 }, (_, i) => ({ line_number: start + i, text: `# Line ${start + i}` })) }, page: { has_more: false } };
    }
    const { session_id, ...args } = payload;
    if (endpoint === 'investigation.get') return service.read(session_id, args);
    if (endpoint === 'investigation.rack') return service.saveRack(session_id, args);
    if (endpoint === 'investigation.inbox') return service.editInbox(session_id, args);
    if (endpoint === 'investigation.import') return service.importLegacy(session_id, args);
    if (endpoint === 'archive.options') return {};
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  });
  await page.goto('https://reader.test/?rhineView=board');
  const mountReader = () => page.evaluate(sessionId => {
    // The cumulative source intentionally starts at L1. It must not replace
    // the citation focus as the source is enriched and annotations refresh.
    const source = { id: 'doc', documentId: 'doc', title: 'source', kind: 'story', origin: 'local', state: 'read',
      agentRead: true, excerpt: 'citation', lineStart: 1, lineEnd: 500, readRanges: [{ start: 1, end: 500 }] };
    window.readerSnapshot = { sessionId, running: false, searching: false, query: '', tool: '', sources: [source], answer: '', records: [] };
    window.workbench = __PRTS_RHINE__.mountRhineWorkbench(document.getElementById('app'), {
      assetBase: '/rhine/', snapshot: window.readerSnapshot, agentAvailable: false,
      api(endpoint, payload, signal) {
        if (endpoint === 'investigation.watch') return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
        return window.readerApi(endpoint, payload);
      }, askAgent: async () => {}, close() {},
    });
  }, session);
  await mountReader();
  await page.waitForFunction(() => window.workbench.stats().investigations.clues === 1);
  await page.evaluate(() => {
    document.querySelector('.rhine-investigation-directory').click();
    document.querySelector('.rhine-investigation-drawer-body .rhine-investigation-source').click();
    document.querySelector('.rhine-investigation-drawer-body .rhine-investigation-source').click();
  });
  try { await page.locator('.rhine-reader-line[data-line="400"]').waitFor(); }
  catch (error) {
    console.error('Reader diagnostics', JSON.stringify({ reads, errors, ui: await page.evaluate(() => ({
      status: document.querySelector('.rhine-reader-status').textContent,
      lines: [...document.querySelectorAll('.rhine-reader-line')].slice(0, 5).map(row => row.outerHTML),
      readerOpen: window.workbench.stats().readerOpen,
      body: document.querySelector('.rhine-investigation-drawer-body').textContent,
    })) })); throw error;
  }
  assert.equal(reads[0].selection.start_line, 397);
  assert.equal(await page.locator('.rhine-reader-line.is-hit').count(), 2);
  assert(await page.locator('.rhine-reader-ranges').innerText().then(text => text.includes('引用位置 L400–401')));
  await page.evaluate(() => window.workbench.update({ ...window.readerSnapshot, sources: window.readerSnapshot.sources.map(s => ({ ...s, title: 'new title' })) }));
  assert.equal(await page.locator('.rhine-reader-line.is-hit').count(), 2);
  console.log('PASS shipped workbench requests L397 and highlights L400–401 across source refreshes');
  await page.locator('.rhine-read-save').click();
  await page.waitForFunction(() => document.querySelector('.rhine-read-save').textContent.includes('已收藏'));
  const rack = await service.inspect(session, { section: 'rack', saved_only: true });
  assert.equal(rack.sources.length, 1); assert.equal(rack.sources[0].sourceId, 'doc');
  assert(service.reviewSummary(session).changes.some(item => item.area === 'rack'));
  await page.locator('.rhine-read-pin').click();
  await page.waitForFunction(() => document.querySelector('.rhine-toast').textContent.includes('已放入'));
  const directory = await service.inspect(session, {}), boardId = directory.boards[0].id;
  const inbox = await service.inspect(session, { board_id: boardId, section: 'inbox' });
  assert.equal(inbox.items.length, 1); assert.equal(inbox.items[0].addedBy, 'user');
  assert(service.reviewSummary(session).changes.some(item => item.area === 'inbox'));
  // A fresh browser cache still restores the server rack and leaves Agent reminders pending.
  await page.evaluate(() => { window.workbench.dispose(); localStorage.clear(); });
  await page.reload(); await mountReader();
  await page.waitForFunction(() => window.workbench.stats().manualSourceCount === 1);
  assert.equal(service.reviewSummary(session).pending_count, 2);
  await page.evaluate(() => window.workbench.dispose()); await page.close();
  console.log('PASS user bookmarks and important evidence are Agent-readable, survive reload and retain unread reminders');
}
try {
  {
    const session = 'rapid', id = await board(session, 'A'), page = await pageFor(session); delay = 120;
    await page.evaluate(() => {
      const { panel } = window.test; panel.select('C001', true);
      const title = document.querySelector('.rhine-evidence-title-input');
      title.value = 'first save'; document.querySelector('.rhine-evidence-save').click();
      title.value = 'second save'; document.querySelector('.rhine-evidence-save').click();
      for (const scale of [1.1, 1.2, 1.3]) panel.resizeCard('C001', scale, -5, 2);
    });
    await saved(page);
    const current = await read(session, id);
    assert.equal(current.clues[0].title, 'second save'); assert.equal(current.clues[0].scale, 1.3);
    assert.deepEqual(await page.evaluate(() => window.test.notices), []);
    console.log('PASS rapid text and layout edits'); await close(page);
  }
  {
    const session = 'cross-board', a = await board(session, 'A'), b = await board(session, 'B'), page = await pageFor(session); delay = 120;
    await page.evaluate(id => window.test.switchBoard(id), a);
    await page.waitForFunction(() => window.test.panel.getCards()[0]?.title === 'A original');
    await page.evaluate(id => {
      const t = window.test, cards = t.panel.getCards(); cards[0].title = 'A first edit'; t.change(cards);
      // Simulate a selection queued just before the saving state disabled the picker.
      t.switchBoard(id); cards[0].title = 'A second edit'; t.change(cards);
    }, b);
    await saved(page);
    assert.equal((await read(session, a)).clues[0].title, 'A second edit');
    assert.equal((await read(session, b)).clues[0].title, 'B original');
    await page.waitForFunction(() => window.test.panel.getCards()[0]?.title === 'B original');
    // A switch also flushes an editor draft before its debounce timer fires.
    await page.evaluate(id => {
      window.test.panel.select('C001', true);
      const title = document.querySelector('.rhine-evidence-title-input'); title.value = 'B draft';
      title.dispatchEvent(new Event('input')); window.test.switchBoard(id);
    }, a);
    await page.waitForFunction(() => window.test.panel.getCards()[0]?.title === 'A second edit');
    assert.equal((await read(session, b)).clues[0].title, 'B draft');
    assert.equal(await page.evaluate(() => window.test.panel.stats().toolsOpen), false);
    assert.deepEqual(await page.evaluate(() => window.test.notices), []);
    console.log('PASS pending saves and drafts stay on their original board'); await close(page);
  }
  {
    const session = 'undo-delete', id = await board(session, 'A'); delay = 0;
    await service.recordSources(session, [{ id: 'doc', title: 'source', content: 'citation', agentRead: true, lineStart: 3, lineEnd: 4 }], 'read');
    await service.edit(session, { board_id: id, mutation_id: 'relations', changes: [
      { id: 'C001', expected_content_revision: 1, kind: 'finding', interpretation: 'inference', sources: [{ source_id: 'R0001', quote: 'citation', line_start: 3, line_end: 4 }] },
      { title: 'B clue', kind: 'question' }], relations: [
      { from: 'C001', to: 'C002', type: 'supports', label: 'outgoing' },
      { from: 'C002', to: 'C001', type: 'contradicts', label: 'incoming' }] });
    const before = await read(session, id), page = await pageFor(session);
    await page.evaluate(() => { window.test.panel.select('C001', true); document.querySelector('.rhine-evidence-remove').click(); });
    await saved(page); assert.equal((await read(session, id)).clues[0].status, 'retracted');
    await page.evaluate(() => document.querySelector('.rhine-evidence-undo').click()); await saved(page);
    const restored = await read(session, id);
    assert.equal(restored.clues.length, 2); assert.equal(restored.clues[0].status, 'active');
    assert.equal(restored.clues[0].id, 'C001'); assert.equal(restored.clues[0].interpretation, 'inference');
    assert.deepEqual(restored.clues[0].sources, before.clues[0].sources); assert.deepEqual(restored.relations, before.relations);
    await page.evaluate(() => document.querySelector('.rhine-evidence-redo').click()); await saved(page);
    assert.equal((await read(session, id)).clues[0].status, 'retracted');
    await page.evaluate(() => document.querySelector('.rhine-evidence-undo').click()); await saved(page);
    assert.equal((await read(session, id)).clues[0].status, 'active');
    assert.deepEqual(await page.evaluate(() => window.test.notices), []);
    console.log('PASS delete / undo / redo preserve clue ID, references, and typed relations'); await close(page);
  }
  {
    const session = 'create-queued', page = await pageFor(session); delay = 120;
    await page.evaluate(() => {
      const t = window.test, card = { id: 'temporary', title: 'new', body: 'body', kind: 'note', stage: 1, position: { x: -5, y: 2 }, scale: 1 };
      t.change([card]); card.title = 'edited before creation finishes'; t.change([card]);
      t.change([]); t.change([card]);
    }); await saved(page);
    const catalog = await service.read(session); assert.equal(catalog.boards.length, 1);
    const current = await read(session, catalog.boards[0].id);
    assert.equal(current.clues.length, 1); assert.equal(current.clues[0].status, 'active');
    assert.equal(current.clues[0].title, 'edited before creation finishes');
    assert.deepEqual(await page.evaluate(() => window.test.notices), []);
    console.log('PASS creation, editing, deletion and undo share one persisted ID'); await close(page);
  }
  {
    const session = 'duplicate-draft', id = await board(session, 'A'); delay = 120;
    await service.edit(session, { board_id: id, mutation_id: 'revision-two', changes: [{ id: 'C001', expected_content_revision: 1, title: 'original revised' }] });
    const page = await pageFor(session);
    await page.evaluate(() => { window.test.panel.select('C001', true); document.querySelector('.rhine-evidence-duplicate').click(); });
    await page.locator('.rhine-evidence-title-input').fill('copy draft');
    await page.waitForFunction(() => window.test.panel.getCards().some(c => c.id === 'C002' && c.title === 'copy draft'));
    await saved(page);
    const current = await read(session, id);
    assert.equal(current.clues.length, 2); assert.equal(current.clues[0].title, 'original revised');
    assert.equal(current.clues[1].title, 'copy draft');
    assert.deepEqual(await page.evaluate(() => window.test.notices), []);
    console.log('PASS duplicate drafts use the new clue revision after ID assignment'); await close(page);
  }
  {
    const session = 'external-conflict', id = await board(session, 'A'), page = await pageFor(session); delay = 0;
    await page.evaluate(() => { window.stale = window.test.panel.getCards(); const c = structuredClone(window.stale); c[0].title = 'local'; window.test.change(c); });
    await saved(page);
    await service.edit(session, { board_id: id, mutation_id: 'external', changes: [{ id: 'C001', title: 'external', expected_content_revision: 2 }] });
    await page.evaluate(() => { window.stale[0].title = 'stale draft'; window.test.change(window.stale); }); await saved(page);
    assert.equal((await read(session, id)).clues[0].title, 'external');
    assert((await page.evaluate(() => window.test.notices)).some(message => message.includes('已经更新')));
    assert((await page.evaluate(() => Object.values(localStorage))).some(value => value.includes('stale draft')));
    console.log('PASS external concurrent edits still conflict and preserve the local draft'); await close(page);
  }
  {
    const a = 'session-a', b = 'session-b', old = await board(a, 'A'), next = await board(b, 'B'), page = await pageFor(a); delay = 180;
    await page.evaluate(() => { const t = window.test, c = t.panel.getCards(); c[0].title = 'old pending'; t.change(c); });
    await page.evaluate(s => window.test.session(s), b);
    await page.evaluate(() => { const t = window.test, c = t.panel.getCards(); c[0].title = 'new session edit'; t.change(c); }); await saved(page);
    assert.equal((await read(b, next)).clues[0].title, 'new session edit');
    assert.notEqual((await read(a, old)).clues[0].title, 'new session edit');
    assert.equal(await page.evaluate(() => window.test.controller.stats().saving), 0);
    assert.deepEqual(await page.evaluate(() => window.test.notices), []);
    console.log('PASS session switch isolates in-flight callbacks and saving state'); await close(page);
  }
  {
    const session = 'report-citation', binding = await service.open(session, { mode: 'new', title: 'report', objective: 'test', reason: 'test' }, { callId: 'open', turnId: 1 }); delay = 0;
    await service.recordSources(session, [{ id: 'doc', documentId: 'doc', title: 'source', agentRead: true, state: 'read', content: 'citation', lineStart: 1, lineEnd: 500 }], 'read');
    await service.update(session, { board_id: binding.board_id, run_id: binding.run_id, expected_revision: 0,
      clues: [{ title: 'clue', kind: 'excerpt', sources: [{ source_id: 'R0001', line_start: 400, line_end: 401, quote: 'citation' }] }] }, { callId: 'update', turnId: 1 });
    await service.publish(session, { board_id: binding.board_id, run_id: binding.run_id, expected_revision: 1,
      title: 'report', summary: 'report', markdown: '[C001]', clue_ids: ['C001'] }, { callId: 'publish', turnId: 1 });
    const page = await pageFor(session);
    await page.evaluate(() => window.test.controller.select('investigation-report'));
    await page.locator('.rhine-investigation-report-evidence summary').click();
    await page.locator('.rhine-investigation-report-evidence button').click();
    const opened = await page.evaluate(() => window.test.opened.at(-1));
    assert.deepEqual(opened.readingRange, { start: 400, end: 401 });
    assert.equal(opened.lineStart, 400); assert.equal(opened.lineEnd, 401);
    console.log('PASS report links carry the cited line range'); await close(page);
    await verifyReader(session);
  }
  assert.deepEqual(errors, []);
  console.log(`Investigation editing regressions passed (${requests.filter(r => r.endpoint === 'investigation.edit').length} editor writes).`);
} finally { await browser.close(); await service.close(); }
