import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceHistory, rebaseEvidenceHistory } from '../ui/rhine/evidence-board-history.ts';

const snapshot = (title = '原始线索', extras = {}) => ({
  cards: [{ id: 'card:a', title, body: '完整摘录', stage: 1, kind: 'source',
    sourceId: 'archive:a', sourceTitle: '原始档案', links: ['card:b'],
    position: { x: 1, y: 2 }, scale: 1.25, ...extras },
  { id: 'card:b', title: '关联线索', body: '', stage: 0, kind: 'note' }],
  selected: 'card:a', promotions: [['preview:source', 'card:a']],
});

test('undo/redo preserves card size, source metadata, links, selection and preview promotion mapping', () => {
  const history = createEvidenceHistory();
  const before = snapshot(), after = snapshot('修改后的线索', { scale: 1.7, position: { x: 3, y: -2 }, links: [] });
  history.record(before, after, '编辑线索');
  assert.deepEqual(history.undo(), { state: before, from: after, label: '编辑线索' });
  assert.deepEqual(history.redo(), { state: after, from: before, label: '编辑线索' });
});

test('recorded and returned snapshots never share editable card arrays or metadata', () => {
  const history = createEvidenceHistory(), before = snapshot(), after = snapshot('编辑');
  const expected = structuredClone(before);
  history.record(before, after, '编辑线索');
  before.cards[0].links.push('corruption'); before.cards[0].position.x = 100;
  before.promotions[0][1] = 'wrong-id';
  const restored = history.undo(); assert.deepEqual(restored.state, expected);
  restored.state.cards[0].title = '外部修改'; restored.state.promotions.length = 0;
  history.redo(); assert.deepEqual(history.undo().state, expected);
});

test('selection-only and no-op changes do not consume history or discard redo', () => {
  const history = createEvidenceHistory(), initial = snapshot(), edited = snapshot('编辑');
  history.record(initial, edited, '编辑线索'); history.undo();
  assert.equal(history.record(initial, { ...initial, selected: null }, '选择'), false);
  assert.equal(history.stats().undoCount, 0); assert.equal(history.stats().redoCount, 1);
  assert.deepEqual(history.redo().state, edited);
});

test('successive text autosaves merge, while pauses and explicit boundaries create separate steps', () => {
  const history = createEvidenceHistory(), a = snapshot('a'), b = snapshot('ab'), c = snapshot('abc'), d = snapshot('abcd');
  history.record(a, b, '编辑线索', 'text:card:a', 1000);
  history.record(b, c, '编辑线索', 'text:card:a', 1400);
  assert.equal(history.stats().undoCount, 1);
  history.record(c, d, '编辑线索', 'text:card:a', 3000);
  assert.equal(history.stats().undoCount, 2);
  assert.deepEqual(history.undo().state, c);
  assert.deepEqual(history.undo().state, a);
  history.clear(); history.record(a, b, '编辑线索', 'text:card:a', 1000); history.seal();
  history.record(b, c, '编辑线索', 'text:card:a', 1100);
  assert.equal(history.stats().undoCount, 2);
});

test('an edit after undo branches history, and session clear forgets both directions', () => {
  const history = createEvidenceHistory(), a = snapshot('a'), b = snapshot('b'), c = snapshot('c');
  history.record(a, b, '编辑线索'); history.undo();
  history.record(a, c, '编辑线索');
  assert.equal(history.redo(), null); assert.deepEqual(history.undo().state, a);
  history.clear(); assert.equal(history.undo(), null); assert.equal(history.redo(), null);
});

test('bounded history evicts only the oldest actions and returning to a group origin removes a redundant step', () => {
  const history = createEvidenceHistory(2), a = snapshot('a'), b = snapshot('b'), c = snapshot('c'), d = snapshot('d');
  history.record(a, b, '第一次'); history.record(b, c, '第二次'); history.record(c, d, '第三次');
  assert.equal(history.stats().undoCount, 2);
  assert.deepEqual(history.undo().state, c); assert.deepEqual(history.undo().state, b); assert.equal(history.undo(), null);
  history.clear(); history.record(a, b, '编辑线索', 'text:a', 1000);
  history.record(b, a, '编辑线索', 'text:a', 1100);
  assert.equal(history.stats().undoCount, 0);
});

test('undo rebases changed fields and preserves concurrent agent edits and additions', () => {
  const before = snapshot(), after = snapshot('用户新标题');
  const current = structuredClone(after.cards);
  current[0].body = 'Agent 新补充的事实'; current.push({id:'C003',title:'新线索',body:'',kind:'note',stage:0});
  const restored = rebaseEvidenceHistory(current, after.cards, before.cards);
  assert.equal(restored[0].title,'原始线索'); assert.equal(restored[0].body,'Agent 新补充的事实');
  assert.equal(restored.length,3);
  current[0].title = '另一次修订';
  assert.equal(rebaseEvidenceHistory(current, after.cards, before.cards)[0].title,'另一次修订');
});
