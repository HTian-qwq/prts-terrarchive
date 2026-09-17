import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampEvidencePosition, createEvidenceId, createEvidenceTemplate, createPreviewCards, evidenceCardLayout,
  evidenceCardScale, evidenceStorageKey, isPreviewCard, normalizeEvidenceScale, parseEvidenceCards,
  EVIDENCE_BODY_LIMIT, EVIDENCE_CARD_CAPACITY, EVIDENCE_STORAGE_LIMIT, EVIDENCE_TITLE_LIMIT,
  EVIDENCE_SCALE_MIN, EVIDENCE_SCALE_MAX,
} from '../ui/rhine/evidence-board-model.ts';

const card = (id = 'card:user', extra = {}) => ({
  id, title: '一条用户线索', body: '保留原始观察，稍后核验。', stage: 0, kind: 'note', ...extra,
});

test('damaged browser storage does not prevent later valid cards from loading', () => {
  for (const value of [undefined, null, false, 0, '[]', { cards: [] }]) {
    assert.deepEqual(parseEvidenceCards(value), []);
  }
  const damaged = [null, [], 1, 'card', {},
    card('', {}), card('x'.repeat(129)), card('blank-title', { title: ' \n ' }),
    card('wrong-body', { body: { text: '不是字符串' } }),
    card('string-stage', { stage: '0' }), card('negative-stage', { stage: -1 }),
    card('large-stage', { stage: 3 }), card('nan-stage', { stage: NaN }),
    card('wrong-kind', { kind: 'agent-read' }),
  ];
  const valid = card('card:after-corruption', { kind: 'question', stage: 2 });
  assert.deepEqual(parseEvidenceCards([...damaged, valid]), [valid]);
});

test('the freeform board accepts twelve cards from one stage and rejects duplicate identities', () => {
  const input = [card('a'), card('b'), card('c'),
    card('a', { stage: 2, title: '冲突副本' }),
    ...['d', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'overflow'].map(id => card(id))];
  const restored = parseEvidenceCards(input);
  assert.equal(EVIDENCE_CARD_CAPACITY, 12);
  assert.equal(restored.length, EVIDENCE_CARD_CAPACITY);
  assert.deepEqual(restored.map(value => value.id), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']);
  assert.equal(restored[0].title, input[0].title, 'the first accepted card survives a conflicting duplicate');
  assert(restored.every(value => value.stage === 0), 'stage metadata never limits freeform placement');
  assert.deepEqual(parseEvidenceCards([...Array(64).fill(null), card('beyond-load-budget')]), [],
    'a malformed oversized payload cannot force an unbounded scan');
});

function assertPaperInside(layout, label) {
  const angle = layout.rotation * Math.PI / 180;
  for (const dx of [-layout.width / 2, layout.width / 2]) {
    for (const dy of [-layout.height / 2, layout.height / 2]) {
      const x = layout.x + dx * Math.cos(angle) - dy * Math.sin(angle);
      const y = layout.y + dx * Math.sin(angle) + dy * Math.cos(angle);
      assert(x >= -7.55 - 1e-9 && x <= 7.55 + 1e-9, `${label}: corner x=${x} leaves the board`);
      assert(y >= -3.82 - 1e-9 && y <= 3.9 + 1e-9, `${label}: corner y=${y} leaves the board`);
    }
  }
}

test('nonfinite and malformed positions are discarded instead of poisoning the scene', () => {
  const invalidPositions = [null, false, '0,0', {}, { x: 0 }, { y: 0 },
    { x: '0', y: 0 }, { x: 0, y: '0' },
    ...[NaN, Infinity, -Infinity].flatMap(value => [{ x: value, y: 0 }, { x: 0, y: value }])];
  for (const position of invalidPositions) {
    const [restored] = parseEvidenceCards([card('invalid-position', { position })]);
    assert.deepEqual(restored, card('invalid-position'));
  }
  const valid = card('origin', { position: { x: 0, y: 0 }, rotation: 0 });
  assert.deepEqual(parseEvidenceCards([valid]), [valid], 'zero remains an intentional position and angle');
});

test('rotation is bounded to fifteen degrees and every rotated corner stays on the writing surface', () => {
  for (const rotation of [NaN, Infinity, -Infinity, '15', null]) {
    assert.deepEqual(parseEvidenceCards([card('invalid-rotation', { rotation })]), [card('invalid-rotation')]);
  }
  for (const kind of ['note', 'question', 'source']) {
    for (const rotation of [-360, -15, 0, 15, 360]) {
      for (const position of [{ x: -1e9, y: -1e9 }, { x: 1e9, y: -1e9 },
        { x: -1e9, y: 1e9 }, { x: 1e9, y: 1e9 }]) {
        const input = card('edge', { kind, rotation, position });
        const original = structuredClone(input);
        const [restored] = parseEvidenceCards([input]);
        assert.equal(restored.rotation, Math.max(-15, Math.min(15, rotation)));
        assertPaperInside(evidenceCardLayout(restored, 0), `${kind}, ${rotation} degrees`);
        assert.deepEqual(input, original, 'clamping does not mutate browser storage input');
        assert.deepEqual(clampEvidencePosition(restored, 0, restored.position.x, restored.position.y), restored.position,
          'a second clamp preserves an already safe position');
      }
    }
  }
});

test('legacy cards without coordinates restore unchanged and receive safe default paper positions', () => {
  for (const kind of ['note', 'question', 'source']) {
    for (const rotation of [undefined, -15, 15]) {
      const legacy = Array.from({ length: EVIDENCE_CARD_CAPACITY }, (_, index) => card(`legacy:${index}`, {
        kind, stage: index % 3, ...(rotation === undefined ? {} : { rotation }),
      }));
      assert.deepEqual(parseEvidenceCards(JSON.parse(JSON.stringify(legacy))), legacy);
      legacy.forEach((value, index) => assertPaperInside(evidenceCardLayout(value, index),
        `${kind}, default ${index}, rotation ${rotation}`));
    }
  }
});

test('paper size accepts finite proportions without coercing malformed storage values', () => {
  const invalid = [undefined, null, false, true, '', '1.5', [], {}, NaN, Infinity, -Infinity,
    { valueOf() { throw Error('Do not coerce size'); } }];
  for (const scale of invalid) {
    assert.equal(normalizeEvidenceScale(scale), 1);
    assert.equal(evidenceCardScale(card('bad-scale', { scale })), 1);
    assert.deepEqual(parseEvidenceCards([card('bad-scale', { scale })]), [card('bad-scale')]);
  }
  assert.equal(EVIDENCE_SCALE_MIN, 0.5);
  assert.equal(EVIDENCE_SCALE_MAX, 2);
  for (const [scale, expected] of [[-1e9, 0.5], [0, 0.5], [0.49, 0.5], [0.5, 0.5],
    [0.87, 0.87], [1, 1], [1.4, 1.4], [2, 2], [2.01, 2], [Number.MAX_VALUE, 2]]) {
    assert.equal(normalizeEvidenceScale(scale), expected);
    assert.equal(parseEvidenceCards([card('finite-scale', { scale })])[0].scale, expected);
  }
});

test('scaling a paper preserves its aspect, center, contents and relationships across saving', () => {
  const source = card('scaled-source', { kind: 'source', rotation: -5, position: { x: 0.5, y: 0 },
    title: '原文摘记', body: '第一行保留上下文。\n第二行保留原始证据。',
    sourceId: 'story:lone-trail/CW-8#after', sourceTitle: '《孤星》CW-8 行动后', links: ['related'] });
  const original = structuredClone(source), normal = evidenceCardLayout(source, 0);
  assert.equal(normal.scale, 1);
  for (const scale of [0.5, 0.75, 1, 1.35, 1.75, 2]) {
    const resized = { ...source, scale }, layout = evidenceCardLayout(resized, 0);
    assert.equal(layout.x, normal.x); assert.equal(layout.y, normal.y);
    assert.equal(layout.rotation, normal.rotation); assert.equal(layout.scale, scale);
    assert(Math.abs(layout.width - normal.width * scale) < 1e-9);
    assert(Math.abs(layout.height - normal.height * scale) < 1e-9);
    const values = [resized, card('related', { links: [source.id] })];
    assert.deepEqual(parseEvidenceCards(JSON.parse(JSON.stringify(values))), values);
    assertPaperInside(layout, `source at ${scale}`);
  }
  assert.deepEqual(source, original, 'resizing never mutates the original evidence record');
});

test('scaled papers, including rotated illustrations, remain fully within every board edge', () => {
  const variants = [{}, { kind: 'question' }, { kind: 'source' },
    { presentation: 'compact' }, { presentation: 'compact', kind: 'question' }, { presentation: 'tag' },
    { visual: 'observatory' }, { visual: 'schematic' }, { visual: 'signal' }];
  for (const variant of variants) for (const rotation of [-15, -7, 0, 7, 15]) {
    for (const scale of [0.5, 1, 1.67, 2, 1e9]) {
      for (const x of [-1e6, 1e6]) for (const y of [-1e6, 1e6]) {
        const input = card('scaled-edge', { ...variant, rotation, scale, position: { x, y } });
        const original = structuredClone(input), [restored] = parseEvidenceCards([input]);
        const layout = evidenceCardLayout(restored, 0);
        assert(layout.scale >= EVIDENCE_SCALE_MIN && layout.scale <= EVIDENCE_SCALE_MAX);
        assertPaperInside(layout, `${JSON.stringify(variant)}, angle ${rotation}, size ${scale}`);
        assert.deepEqual(clampEvidencePosition(restored, 0, restored.position.x, restored.position.y), restored.position);
        assert.deepEqual(parseEvidenceCards(JSON.parse(JSON.stringify([restored]))), [restored]);
        assert.deepEqual(input, original);
      }
    }
  }
  const largest = card('large-plan', { visual: 'schematic', rotation: 15, scale: 2,
    position: { x: 1e6, y: 1e6 } });
  assert(evidenceCardScale(largest) < 2, 'a rotated large plan must stop before its corners leave the board');
  assertPaperInside(evidenceCardLayout(largest, 0), 'largest rotated plan');
});

test('connections preserve real targets while removing duplicate, self, missing and oversized identities', () => {
  const input = [card('a', { links: ['b', 'b', 'a', 'missing', '', null, 12, {}, 'x'.repeat(129), 'c'] }),
    card('b', { links: ['a'] }), card('c', { links: 'a' })];
  const original = structuredClone(input);
  const restored = parseEvidenceCards(input);
  assert.deepEqual(restored[0].links, ['b', 'c']);
  assert.deepEqual(restored[1].links, ['a']);
  assert.equal(Object.hasOwn(restored[2], 'links'), false);
  assert.deepEqual(input, original);
  assert.deepEqual(parseEvidenceCards([card('a', { links: ['late'] }),
    ...Array.from({ length: EVIDENCE_CARD_CAPACITY - 1 }, (_, index) => card(`kept:${index}`)), card('late')])[0].links, [],
  'connections cannot point to cards discarded by the board capacity');
  assert.deepEqual(parseEvidenceCards([card('a', {
    links: [...Array.from({ length: 12 }, (_, index) => `missing:${index}`), 'b'],
  }), card('b')])[0].links, ['b'], 'discarded targets must not crowd out a valid connection');
});

test('oversized text is bounded while restoration leaves the stored input untouched', () => {
  const input = card('card:long', {
    title: `  ${'题'.repeat(EVIDENCE_TITLE_LIMIT + 25)}  `,
    body: '文'.repeat(EVIDENCE_BODY_LIMIT + 100),
    sourceTitle: `  ${'源'.repeat(600)}  `,
    sourceId: 's'.repeat(1200),
    agentRead: true,
  });
  const original = structuredClone(input);
  const [restored] = parseEvidenceCards([input]);
  assert.equal(restored.title.length, EVIDENCE_TITLE_LIMIT);
  assert.equal(restored.body.length, EVIDENCE_BODY_LIMIT);
  assert.equal(restored.sourceTitle.length, 512);
  assert.equal(restored.sourceId.length, 1024);
  assert.equal(Object.hasOwn(restored, 'agentRead'), false, 'board data cannot establish Agent reading evidence');
  assert.deepEqual(input, original);
  assert.deepEqual(parseEvidenceCards([card('invalid-optional', { sourceTitle: 42, sourceId: [] })]),
    [card('invalid-optional')]);
});

test('a valid source card retains its source identity and exact excerpt across JSON restoration', () => {
  const source = card('card:source', {
    kind: 'source', stage: 1, title: '需要核对的原文',
    body: '第一行：先保留上下文。\n第二行：不要因为置入板卡就宣称 Agent 已读。',
    sourceId: 'v20260912:story:chapter/part#L12-L18', sourceTitle: '某段剧情 · 原文',
  });
  assert.deepEqual(parseEvidenceCards(JSON.parse(JSON.stringify([source]))), [source]);
});

test('compact presentation survives storage without shortening content or losing provenance and connections', () => {
  for (const presentation of ['compact', 'tag']) {
    const source = card(`card:${presentation}`, {
      presentation, kind: 'source', stage: 2,
      title: '题'.repeat(EVIDENCE_TITLE_LIMIT),
      body: `原文第一行\n${'内容与上下文。'.repeat(400)}`,
      sourceId: 'v20260916:story:lone-trail/CW-10#before', sourceTitle: '《孤星》CW-10 行动前',
      links: ['card:related'], position: { x: 0, y: 0 }, rotation: -12,
    });
    const cards = [source, card('card:related', { links: [source.id] })];
    assert.deepEqual(parseEvidenceCards(JSON.parse(JSON.stringify(cards))), cards,
      `${presentation} changes the paper presentation, never the stored excerpt or source`);
  }
  const invalid = [undefined, null, false, 12, '', 'note', 'COMPACT', 'source', [],
    { toString() { throw Error('Do not coerce objects'); } }];
  for (const presentation of invalid) {
    assert.deepEqual(parseEvidenceCards([card('invalid-presentation', { presentation })]),
      [card('invalid-presentation')], 'unknown presentation is discarded without losing an otherwise valid card');
  }
});

test('a full board with maximum supported text and relationships fits the storage restore budget', () => {
  const ids = Array.from({ length: EVIDENCE_CARD_CAPACITY }, (_, index) => `card:${index}:`.padEnd(128, 'x'));
  const values = ids.map((id, index) => card(id, {
    title: '题'.repeat(EVIDENCE_TITLE_LIMIT), body: '文'.repeat(EVIDENCE_BODY_LIMIT),
    sourceTitle: '源'.repeat(512), sourceId: 's'.repeat(1024),
    kind: 'source', presentation: index % 2 ? 'tag' : 'compact',
    position: { x: 0, y: 0 }, rotation: 0,
    links: ids.filter(other => other !== id),
  }));
  const serialized = JSON.stringify({ version: 1, previewLayout: 3, cards: values });
  assert(serialized.length <= EVIDENCE_STORAGE_LIMIT,
    'saving twelve valid cards must not create a record that loading rejects as oversized');
  assert.deepEqual(parseEvidenceCards(JSON.parse(serialized).cards), values);
});

test('new templates create independent valid user cards with distinct presentation and content semantics', () => {
  const specifications = [
    ['note', 'note', 'compact'], ['question', 'question', 'compact'],
    ['source', 'source', undefined], ['tag', 'note', 'tag'],
  ];
  const created = [];
  for (const [template, kind, presentation] of specifications) {
    const value = createEvidenceTemplate(template);
    const another = createEvidenceTemplate(template);
    assert.equal(value.kind, kind);
    assert.equal(value.presentation, presentation);
    assert.equal(value.stage, 0);
    assert.equal(value.body, '');
    assert.equal(isPreviewCard(value), false, 'a user-created card must never be cleared as an example');
    assert.deepEqual(parseEvidenceCards([value]), [value]);
    assert.notEqual(value.id, another.id, 'each template invocation gets its own persistent identity');
    value.body = '这份草稿只属于第一张纸。';
    assert.equal(another.body, '');
    created.push(value, another);
  }
  assert.equal(new Set(created.map(value => value.id)).size, created.length);
});

test('small labels and compact papers retain all rotated corners on the board after placement and restoration', () => {
  for (const presentation of ['compact', 'tag']) for (const kind of ['note', 'question', 'source']) {
    for (const rotation of [-360, -15, 0, 15, 360]) {
      for (const x of [-1e6, 1e6]) for (const y of [-1e6, 1e6]) {
        const input = card('small-paper', { presentation, kind, rotation, position: { x, y } });
        const original = structuredClone(input);
        const [restored] = parseEvidenceCards([input]);
        assertPaperInside(evidenceCardLayout(restored, 11), `${presentation}/${kind}, ${rotation} degrees`);
        assert.deepEqual(clampEvidencePosition(restored, 11, restored.position.x, restored.position.y),
          restored.position, 'an already clamped compact paper does not drift on save');
        assert.deepEqual(parseEvidenceCards(JSON.parse(JSON.stringify([restored]))), [restored]);
        assert.deepEqual(input, original);
      }
    }
    Array.from({ length: EVIDENCE_CARD_CAPACITY }, (_, index) => {
      const value = card(`small:${index}`, { presentation, kind, rotation: index % 2 ? -15 : 15 });
      assertPaperInside(evidenceCardLayout(value, index), `${presentation}/${kind}, default slot ${index}`);
    });
  }
});

test('introducing compact templates preserves the six established example paper sizes and positions', () => {
  const expected = [
    { x: -0.35, y: 2.65, rotation: -3, width: 3.04, height: 1.36 },
    { x: -4.7, y: 1, rotation: 4, width: 3.68, height: 2.6 },
    { x: 4.65, y: 0.95, rotation: -3, width: 2.72, height: 3.04 },
    { x: -0.05, y: -0.25, rotation: -2.2, width: 4.28, height: 2.92 },
    { x: -4.1, y: -2.05, rotation: -5, width: 3.36, height: 1.56 },
    { x: 4.05, y: -2.15, rotation: 5, width: 3.04, height: 1.36 },
  ];
  const examples = createPreviewCards();
  assert.equal(examples.length, expected.length);
  examples.forEach((value, index) => {
    assert.equal(value.presentation, undefined, 'loading the old examples does not opt them into a smaller template');
    const actual = evidenceCardLayout(value, index);
    for (const key of Object.keys(expected[index])) {
      assert(Math.abs(actual[key] - expected[index][key]) < 1e-9,
        `${value.id}: ${key} changed from ${expected[index][key]} to ${actual[key]}`);
    }
  });
});

test('illustrated paper layouts survive restoration and stay within the board at every corner', () => {
  for (const visual of ['observatory', 'schematic', 'signal']) {
    for (const rotation of [-15, 0, 15]) {
      for (const x of [-1e6, 1e6]) for (const y of [-1e6, 1e6]) {
        const [restored] = parseEvidenceCards([card('illustration', { visual, rotation, position: { x, y } })]);
        assert.equal(restored.visual, visual);
        assertPaperInside(evidenceCardLayout(restored, 0), `${visual}, ${rotation}`);
        assert.deepEqual(parseEvidenceCards(JSON.parse(JSON.stringify([restored]))), [restored]);
      }
    }
  }
  for (const visual of [null, 42, 'https://example.com/photo.jpg', { toString() { throw Error('Do not coerce objects'); } }]) {
    assert.deepEqual(parseEvidenceCards([card('plain', { visual })]), [card('plain')]);
  }
});

test('layout examples stay separate from user notes, including edited examples and source names', () => {
  const examples = createPreviewCards();
  assert.equal(examples.length, 6);
  assert.deepEqual(parseEvidenceCards(examples), examples);
  assert(examples.every(value => isPreviewCard(value)));
  assert(examples.every(value => !value.sourceId && value.sourceTitle?.startsWith('《孤星》')),
    'reviewed plot references do not bind examples to an invented corpus/Agent source identity');
  const exampleIds = new Set(examples.map(value => value.id));
  assert.equal(exampleIds.size, examples.length);
  assert(examples.some(value => value.links?.length), 'the preview demonstrates relationships between clues');
  examples.forEach((value, index) => {
    assertPaperInside(evidenceCardLayout(value, index), `preview ${value.id}`);
    assert.equal(new Set(value.links).size, value.links?.length || 0);
    assert((value.links || []).every(id => id !== value.id && exampleIds.has(id)));
  });
  const edited = { ...examples[0], id: createEvidenceId(), body: '用户已经替换为自己的内容。' };
  const user = card('card:my-preview', { title: '布局示例的个人笔记', sourceId: 'preview:source-name' });
  const retained = [...examples, edited, user].filter(value => !isPreviewCard(value));
  assert.deepEqual(retained, [edited, user], 'clearing examples uses card identity, never its title or source');
  examples[0].body = '修改本次页面的示例';
  assert.notEqual(createPreviewCards()[0].body, examples[0].body, 'fresh sessions receive independent examples');
  assert.notEqual(evidenceStorageKey('session/a'), evidenceStorageKey('session%2Fa'));
  assert.notEqual(evidenceStorageKey('session/a'), evidenceStorageKey('session/b'));
});
