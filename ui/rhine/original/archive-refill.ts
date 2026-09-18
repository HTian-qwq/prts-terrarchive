import type { ArchiveCell } from './archive-loop';

type LaneRefill = { holes: number[]; elapsed: number; duration: number };
const ease = (value: number) => value ** 3 * (value * (value * 6 - 15) + 10);

/** Close physical vacancies with the existing rear row, without adding any meshes. */
export class ArchiveRefill {
  private pending = new Map<number, Set<number>>();
  private moving = new Map<number, LaneRefill>();

  remove({ lane, row }: ArchiveCell) {
    const holes = this.pending.get(lane) ?? new Set<number>();
    holes.add(row);
    this.pending.set(lane, holes);
  }

  get active() { return this.pending.size > 0 || this.moving.size > 0; }
  blocks(lane: number) { return this.pending.has(lane) || this.moving.has(lane); }
  vacant({ lane, row }: ArchiveCell) { return this.pending.get(lane)?.has(row) ?? false; }

  update(dt: number, occupied: Iterable<ArchiveCell>, reduced = false) {
    for (const [lane, motion] of this.moving) {
      motion.elapsed += Math.max(0, dt);
      if (reduced || motion.elapsed >= motion.duration) this.moving.delete(lane);
    }
    const blocked = new Set(Array.from(occupied, cell => cell.lane));
    for (const [lane, holes] of this.pending) {
      // Parallel readers keep their physical slot until they depart or return.
      // Begin one continuous refill for the lane once every actor has cleared it.
      if (blocked.has(lane) || this.moving.has(lane)) continue;
      this.pending.delete(lane);
      if (!reduced) this.moving.set(lane, {
        holes: [...holes].sort((a, b) => b - a), elapsed: 0,
        duration: 0.86 + Math.min(0.36, (holes.size - 1) * 0.18),
      });
    }
  }

  row({ lane, row }: ArchiveCell) {
    const motion = this.moving.get(lane);
    if (!motion) return row;
    // The camera looks toward -Z: smaller row numbers are behind the vacancy.
    // Reuse destination instance IDs for the surviving rear cassettes. At t=0
    // the occupied positions are identical; at t=1 the normal grid takes over.
    let source = row;
    for (const hole of motion.holes) if (hole >= source) source--;
    return source + (row - source) * ease(Math.min(1, motion.elapsed / motion.duration));
  }

  rebase(shift: ArchiveCell) {
    this.pending = new Map([...this.pending].map(([lane, holes]) =>
      [lane - shift.lane, new Set([...holes].map(row => row - shift.row))]));
    this.moving = new Map([...this.moving].map(([lane, motion]) =>
      [lane - shift.lane, { ...motion, holes: motion.holes.map(row => row - shift.row) }]));
  }

  clear() { this.pending.clear(); this.moving.clear(); }
  stats() {
    return [
      ...[...this.pending].map(([lane, holes]) => ({ lane, holes: [...holes], phase: 'waiting', progress: 0 })),
      ...[...this.moving].map(([lane, motion]) => ({ lane, holes: [...motion.holes], phase: 'moving', progress: motion.elapsed / motion.duration })),
    ];
  }
}
