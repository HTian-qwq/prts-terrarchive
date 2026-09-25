import type { ArchiveSource } from './types';

/** A citation's reading position is independent of cumulative search/read receipts. */
export function referenceSource(source: ArchiveSource, ref: { line_start?: number; line_end?: number }): ArchiveSource {
  return ref.line_start ? { ...source, lineStart: ref.line_start, lineEnd: ref.line_end ?? ref.line_start,
    readingRange: { start: ref.line_start, end: ref.line_end ?? ref.line_start } } : source;
}

export function resolveReadingSource(source: ArchiveSource, latest?: ArchiveSource): ArchiveSource {
  return latest ? { ...latest, ...(source.readingRange ? { readingRange: source.readingRange } : {}) } : source;
}

export function readerStartLine(source: ArchiveSource) {
  return Math.max(1, (source.readingRange?.start || source.readRanges?.[0]?.start || source.lineStart || 1) - 3);
}
