import { ARCHIVE_LANES } from '../catalogue.ts';

// Reusable positions in the authored animation, never document records.
// Source identities, labels and per-category lengths live in the adapter.
export const archiveColumns = [...ARCHIVE_LANES];
export const archiveSlots = Array.from({ length: 40 }, (_, index) => ({
  lane: Math.floor(index / 8),
  row: 12 + index % 8,
}));

export function columnFiles(lane: number): number[] {
  return Array.from({ length: 8 }, (_, index) => lane * 8 + index);
}
export function fileLocation(index: number) {
  const { lane, row } = archiveSlots[((index % 40) + 40) % 40];
  return { lane, row, slot: lane * 32 + row };
}
export function fileAtSlot(slot: number) {
  const lane = Math.max(0, Math.min(4, Math.floor(slot / 32)));
  return lane * 8 + Math.max(0, Math.min(7, slot % 32 - 12));
}
