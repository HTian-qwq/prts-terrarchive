export type LabelCandidate<T> = { item: T; lane: number; row: number; axis: 'row' | 'lane' | 'pointer' | 'activity'; offset: number };

/** Shared by prediction and selection, including unbounded loop cells. */
export function archivePointerTarget(counts: readonly number[], rows: readonly number[], slots: readonly number[],
  current: number, selected: { lane: number; row: number }, index: number, cell?: { lane: number; row: number }) {
  if (cell && cell.row === selected.row && cell.lane === selected.lane) return null;
  const lane = Math.floor(index / 8), count = counts[lane] || 0;
  const delta = cell && lane === current ? cell.row - selected.row : index % 8 - slots[lane];
  const row = count ? ((rows[lane] + delta) % count + count) % count : 0;
  return { lane, row, delta };
}

/** Explicit intent shares the same bounded working set with ordinary neighbours. */
export function archiveLabelCandidates<T>(lanes: readonly (readonly T[])[], rows: readonly number[], current: number, limit = 6,
  preferred: readonly LabelCandidate<T>[] = []) {
  const wrap = (n: number, count: number) => (n % count + count) % count;
  const result: LabelCandidate<T>[] = [];
  if (!lanes.length) return result;
  const seen = new Set<T>();
  for (const candidate of preferred) {
    if (seen.has(candidate.item) || result.length >= limit) continue;
    seen.add(candidate.item); result.push(candidate);
  }
  const add = (lane: number, offset: number, axis: 'row' | 'lane') => {
    lane = wrap(lane, lanes.length); const items = lanes[lane]; if (!items.length) return;
    const row = wrap((rows[lane] || 0) + (axis === 'row' ? offset : 0), items.length), item = items[row];
    if (lane === current && row === wrap(rows[current] || 0, items.length) || seen.has(item) || result.length >= limit) return;
    seen.add(item); result.push({ item, lane, row, axis, offset });
  };
  add(current, -1, 'row'); add(current, 1, 'row');
  add(current - 1, -1, 'lane'); add(current + 1, 1, 'lane');
  add(current, -2, 'row'); add(current, 2, 'row');
  return result;
}
