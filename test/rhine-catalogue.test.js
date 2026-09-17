import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveLane, mergeSourcesInOrder, sourceIdentity, SHELF_PAGE_SIZE } from '../ui/rhine/catalogue.ts';
import { shelfSlot, SHELF_LEVEL_SPACING } from '../ui/rhine/shelf-layout.ts';

const source = (id, extra = {}) => ({ id, documentId: id, dataVersion: 'v1', title: id,
  kind: 'character_profile', origin: 'local', state: 'found', excerpt: '', ...extra });

test('档案架重读不重排，不丢收藏、实际读取行或原资料分类', () => {
  const before = [source('a', { saved: true }), source('b', { state: 'cited' })];
  const after = mergeSourcesInOrder(before, [source('b'), source('a', {
    kind: 'corpus_read', state: 'read', readRanges: [{ start: 7, end: 11 }],
  }), source('c')]);
  assert.deepEqual(after.map(s => s.id), ['a', 'b', 'c']);
  assert.equal(after[0].state, 'read');
  assert.equal(after[0].saved, true);
  assert.equal(after[0].kind, 'character_profile');
  assert.deepEqual(after[0].readRanges, [{ start: 7, end: 11 }]);
  assert.equal(after[1].state, 'cited');
  assert.equal(archiveLane(after[0]), 0);
});

test('双层二十四槽分页不丢下一页资料，同名不同版本保留独立来源', () => {
  const incoming = Array.from({ length: 25 }, (_, i) => source(`d${i}`));
  incoming.push(source('d0', { dataVersion: 'v2' }));
  const combined = mergeSourcesInOrder([], incoming);
  assert.equal(SHELF_PAGE_SIZE, 24);
  assert.equal(combined.length, 26);
  assert.deepEqual(combined.slice(0, SHELF_PAGE_SIZE).map(s => s.id), incoming.slice(0, 24).map(s => s.id));
  assert.deepEqual(combined.slice(SHELF_PAGE_SIZE).map(s => s.id), ['d24', 'd0']);
  assert.equal(combined.at(-1).dataVersion, 'v2');
  assert.equal(archiveLane(source('cloud', { origin: 'cloud' })), 4);
  assert.equal(archiveLane(source('timeline', { kind: 'timeline' })), 3);
});

test('来源补充原文定位后仍留在原槽位，别名合并保留实际读取证据', () => {
  const first = source('arrival', { documentId: undefined, documentUid: 'uid-a' });
  const enriched = source('canonical', { documentId: 'local-a', documentUid: 'uid-a',
    state: 'read', readRanges: [{ start: 3, end: 8 }] });
  const combined = mergeSourcesInOrder([first, source('b')], [enriched]);
  assert.equal(combined.length, 2);
  assert.equal(combined[0].id, 'arrival');
  assert.equal(sourceIdentity(combined[0]), sourceIdentity(first));
  assert.equal(combined[0].documentId, 'local-a');
  assert.deepEqual(combined[0].readRanges, [{ start: 3, end: 8 }]);
  assert.equal(mergeSourcesInOrder(combined, [enriched]).length, 2);
  assert.equal(mergeSourcesInOrder(combined, [{ ...enriched, dataVersion: 'v2' }]).length, 3);
});

test('两层槽位一一对应，翻页复用相同位置且盒顶留出托盘间隙', () => {
  const positions = Array.from({ length: SHELF_PAGE_SIZE }, (_, index) => shelfSlot(index));
  assert.equal(new Set(positions.map(({ x, y, z }) => `${x}/${y}/${z}`)).size, 24);
  assert.equal(positions.filter(item => item.level === 0).length, 12);
  assert.equal(positions.filter(item => item.level === 1).length, 12);
  assert.equal(positions[12].z, positions[0].z);
  assert.equal(positions[12].y - positions[0].y, SHELF_LEVEL_SPACING);
  assert(positions[0].y + 3.76 < SHELF_LEVEL_SPACING, 'the lower cassette fits below the upper tray');
  for (let index = 0; index < 24; index++) assert.deepEqual(shelfSlot(index + 24), positions[index]);
});
