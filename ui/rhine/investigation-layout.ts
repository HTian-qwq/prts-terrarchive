type Clue = { id: string; kind: string };
// A report-sized clearing, three side sheets per side, and smaller upper/lower groups.
// Slots are allocated in immutable clue-ID order, including withdrawn clues, so new arrivals do not reshuffle a board.
export const INVESTIGATION_SLOTS = [
  [-5.65, 2.35], [-5.65, .10], [-5.55, -2.20],
  [5.55, 2.30], [5.65, .05], [5.60, -2.20],
  [-2.78, 2.65], [0, 2.65], [2.78, 2.65],
  [-2.78, -2.65], [0, -2.65], [2.78, -2.65],
] as const;
const preferences: Record<string, number[]> = {
  excerpt: [0,1,2,6,9,7,10,8,11,3,4,5],
  finding: [3,4,5,8,11,7,10,6,9,0,1,2],
  relation: [7,10,6,8,9,11,4,1,3,0,5,2],
  time: [10,9,11,2,5,1,4,6,8,0,3,7],
  question: [9,11,10,2,5,6,8,1,4,0,3,7],
  contrast: [4,8,11,3,5,6,9,7,10,1,0,2],
};
export const investigationClueIndex = (clue: Clue) => Math.max(0, Number(clue.id.replace(/^C/, '')) - 1 || 0);
export function investigationPositions(clues: readonly Clue[]) {
  const occupied = new Map<number, Set<number>>(), result = new Map<string, {x:number;y:number}>();
  for (const clue of [...clues].sort((a,b) => investigationClueIndex(a) - investigationClueIndex(b))) {
    const page = Math.floor(investigationClueIndex(clue) / 12), used = occupied.get(page) || new Set<number>();
    const slot = (preferences[clue.kind] || preferences.finding).find(value => !used.has(value));
    if (slot === undefined) continue;
    used.add(slot); occupied.set(page,used);
    const [x,y] = INVESTIGATION_SLOTS[slot]; result.set(clue.id,{x,y});
  }
  return result;
}
