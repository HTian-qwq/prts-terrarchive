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

export function shelfSlot(index: number) {
  const pageSlot = ((Math.trunc(index) % SHELF_PAGE_SIZE) + SHELF_PAGE_SIZE) % SHELF_PAGE_SIZE;
  const level = Math.floor(pageSlot / SHELF_SLOTS_PER_LEVEL);
  const slot = pageSlot % SHELF_SLOTS_PER_LEVEL;
  return { level, slot, x: 0, y: 0.28 + level * SHELF_LEVEL_SPACING,
    z: (slot - (SHELF_SLOTS_PER_LEVEL - 1) / 2) * SHELF_SLOT_SPACING };
}
