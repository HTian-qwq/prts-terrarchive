// One bounded page spans both physical tiers; source order fills bottom first.
export const SHELF_LEVELS = 2;
export const SHELF_SLOTS_PER_LEVEL = 12;
export const SHELF_PAGE_SIZE = SHELF_LEVELS * SHELF_SLOTS_PER_LEVEL;
export const SHELF_SLOT_SPACING = 0.78;
export const SHELF_LEVEL_SPACING = 4.6;
export const SHELF_WIDTH = 5.35;
export const SHELF_DEPTH = (SHELF_SLOTS_PER_LEVEL - 1) * SHELF_SLOT_SPACING + 1.05;
export const SHELF_HEIGHT = (SHELF_LEVELS - 1) * SHELF_LEVEL_SPACING + 4.3;
// Clear the entire cassette width before turning or changing tiers.
export const SHELF_EXIT_DISTANCE = SHELF_WIDTH + 0.65;

// The reading station stays outside the rack's full rotation envelope and in
// front of its nearest row. Moving the camera cannot make an internal target safe.
export const SHELF_READING_POSITION = {
  x: -SHELF_EXIT_DISTANCE, y: SHELF_HEIGHT / 2 - 1.85, z: SHELF_DEPTH / 2 + 3.2,
};
export const SHELF_WITHDRAW_END = 0.38;
export function shelfReadingPath(index: number, progress: number, focus = 0) {
  const slot = shelfSlot(index);
  const smooth = (v: number) => { const t = Math.max(0, Math.min(1, v)); return t * t * t * (t * (t * 6 - 15) + 10); };
  const turn = smooth((progress - SHELF_WITHDRAW_END) / (1 - SHELF_WITHDRAW_END));
  if (progress < SHELF_WITHDRAW_END) return {
    x: -focus * 0.5 + (-SHELF_EXIT_DISTANCE + focus * 0.5) * smooth(progress / SHELF_WITHDRAW_END),
    y: slot.y, z: slot.z, turn: 0,
  };
  return { x: SHELF_READING_POSITION.x,
    y: slot.y + (SHELF_READING_POSITION.y - slot.y) * turn,
    z: slot.z + (SHELF_READING_POSITION.z - slot.z) * turn, turn };
}

export function shelfSlot(index: number) {
  const pageSlot = ((Math.trunc(index) % SHELF_PAGE_SIZE) + SHELF_PAGE_SIZE) % SHELF_PAGE_SIZE;
  const level = Math.floor(pageSlot / SHELF_SLOTS_PER_LEVEL);
  const slot = pageSlot % SHELF_SLOTS_PER_LEVEL;
  return { level, slot, x: 0, y: 0.28 + level * SHELF_LEVEL_SPACING,
    z: (slot - (SHELF_SLOTS_PER_LEVEL - 1) / 2) * SHELF_SLOT_SPACING };
}
