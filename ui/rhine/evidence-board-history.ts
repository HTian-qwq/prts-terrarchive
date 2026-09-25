import type { EvidenceCard } from './evidence-board-model';

export type EvidenceSnapshot = {
  cards: EvidenceCard[];
  selected: string | null;
  promotions: [string, string][];
};
type Entry = { before: EvidenceSnapshot; after: EvidenceSnapshot; label: string; group?: string; time: number };
const copy = (state: EvidenceSnapshot): EvidenceSnapshot => ({
  cards: state.cards.map(card => ({ ...card, ...(card.position ? { position: { ...card.position } } : {}),
    ...(card.links ? { links: [...card.links] } : {}) })),
  selected: state.selected, promotions: state.promotions.map(([from, to]) => [from, to]),
});
const sameCards = (a: EvidenceSnapshot, b: EvidenceSnapshot) => JSON.stringify(a.cards) === JSON.stringify(b.cards);

/** Session-local history. Selection-only changes never occupy an undo step. */
export function createEvidenceHistory(limit = 40) {
  const past: Entry[] = [], future: Entry[] = [];
  let mergeOpen = false;
  return {
    record(before: EvidenceSnapshot, after: EvidenceSnapshot, label: string, group?: string, time = Date.now()) {
      if (sameCards(before, after)) return false;
      const last = past.at(-1);
      if (mergeOpen && group && last?.group === group && time - last.time < 1500 && sameCards(last.after, before)) {
        last.after = copy(after); last.time = time;
        if (sameCards(last.before, last.after)) past.pop();
      } else {
        past.push({ before: copy(before), after: copy(after), label, group, time });
        if (past.length > limit) past.shift();
      }
      future.length = 0; mergeOpen = Boolean(group); return true;
    },
    undo() {
      mergeOpen = false;
      const entry = past.pop(); if (!entry) return null;
      future.push(entry); return { state: copy(entry.before), from: copy(entry.after), label: entry.label };
    },
    redo() {
      mergeOpen = false;
      const entry = future.pop(); if (!entry) return null;
      past.push(entry); return { state: copy(entry.after), from: copy(entry.before), label: entry.label };
    },
    remapIds(mapping: Record<string, string>, revisions: Record<string, { content_revision: number; layout_revision: number }> = {}) {
      for (const entry of [...past, ...future]) for (const state of [entry.before, entry.after]) {
        state.cards = state.cards.map(card => {
          const id = mapping[card.id] || card.id, revision = id !== card.id ? revisions[id] : undefined;
          return { ...card, id, ...(revision ? { contentRevision: revision.content_revision, layoutRevision: revision.layout_revision } : {}), links: card.links?.map(id => mapping[id] || id) };
        });
        if (state.selected) state.selected = mapping[state.selected] || state.selected;
      }
    },
    seal() { mergeOpen = false; },
    clear() { past.length = 0; future.length = 0; mergeOpen = false; },
    stats() { return { undoCount: past.length, redoCount: future.length, undoLabel: past.at(-1)?.label,
      redoLabel: future.at(-1)?.label }; },
  };
}

/** Apply only this user's inverse fields; retain later agent additions and edits. */
export function rebaseEvidenceHistory(current: EvidenceCard[], from: EvidenceCard[], to: EvidenceCard[]) {
  const result = structuredClone(current);
  const keys = ['title','body','summary','kind','stage','position','rotation','scale','links'] as const;
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const old of from) {
    const desired = to.find(card => card.id === old.id), index = result.findIndex(card => card.id === old.id);
    if (index < 0) continue;
    if (!desired) { if (keys.every(key => equal(result[index][key], old[key]))) result.splice(index, 1); continue; }
    const next = result[index] as Record<string, unknown>;
    for (const key of keys) if (!equal(old[key], desired[key]) && equal(next[key], old[key])) next[key] = structuredClone(desired[key]);
  }
  for (const desired of to) if (!from.some(card => card.id === desired.id) && !result.some(card => card.id === desired.id)) result.push(structuredClone(desired));
  return result;
}
