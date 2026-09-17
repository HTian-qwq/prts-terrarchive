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
      future.push(entry); return { state: copy(entry.before), label: entry.label };
    },
    redo() {
      mergeOpen = false;
      const entry = future.pop(); if (!entry) return null;
      past.push(entry); return { state: copy(entry.after), label: entry.label };
    },
    seal() { mergeOpen = false; },
    clear() { past.length = 0; future.length = 0; mergeOpen = false; },
    stats() { return { undoCount: past.length, redoCount: future.length, undoLabel: past.at(-1)?.label,
      redoLabel: future.at(-1)?.label }; },
  };
}
