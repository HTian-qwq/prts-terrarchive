import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvestigationEditRevisions } from '../ui/rhine/investigation-edits.ts';
import { referenceSource, resolveReadingSource, readerStartLine } from '../ui/rhine/source-reading.ts';

test('queued edits advance through local acknowledgments but stop at an external edit', () => {
  const revisions = new InvestigationEditRevisions();
  revisions.observe([{ id: 'C001', contentRevision: 1, layoutRevision: 0 }]);
  revisions.acknowledge([{ id: 'C001', expected_content_revision: 1 }], {
    created_ids: {}, clue_revisions: { C001: { content_revision: 2, layout_revision: 0 } },
  });
  assert.equal(revisions.revision('C001', 1, 'content_revision'), 2);
  revisions.observe([{ id: 'C001', contentRevision: 3, layoutRevision: 0 }]);
  assert.equal(revisions.revision('C001', 1, 'content_revision'), 2);
  assert.equal(revisions.revision('C001', 3, 'content_revision'), 3);
  assert.equal(revisions.revision('C001', 0, 'layout_revision'), 0);
});

test('temporary duplicates use their own creation revision, including queued layout changes', () => {
  const revisions = new InvestigationEditRevisions();
  revisions.acknowledge([{ client_key: 'copy' }], {
    created_ids: { copy: 'C002' }, clue_revisions: { C002: { content_revision: 1, layout_revision: 0 } },
  });
  assert.equal(revisions.id('copy'), 'C002');
  assert.equal(revisions.revision('copy', 12, 'content_revision'), 1);
  revisions.acknowledge([{ id: 'C002', expected_layout_revision: 0 }], {
    created_ids: {}, clue_revisions: { C002: { content_revision: 1, layout_revision: 1 } },
  });
  assert.equal(revisions.revision('copy', 7, 'layout_revision'), 1);
});

test('citation focus survives catalogue enrichment without changing Agent read receipts', () => {
  const source = { id: 'doc', lineStart: 1, lineEnd: 500, readRanges: [{ start: 1, end: 500 }] };
  const citation = referenceSource(source, { line_start: 400, line_end: 401 });
  const resolved = resolveReadingSource(citation, { ...source, title: 'updated' });
  assert.equal(resolved.title, 'updated');
  assert.equal(readerStartLine(resolved), 397);
  assert.deepEqual(resolved.readingRange, { start: 400, end: 401 });
  assert.deepEqual(resolved.readRanges, source.readRanges);
  assert.equal(readerStartLine(source), 1);
  assert.equal(readerStartLine({ lineStart: 30 }), 27);
});
