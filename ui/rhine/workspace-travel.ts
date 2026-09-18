import type { RhineLocation } from './types';

export interface WorkspaceBlend { board: number; desk: number }
export interface WorkspaceTravel {
  from: WorkspaceBlend;
  to: WorkspaceBlend;
  elapsed: number;
  duration: number;
}

const stops: Record<RhineLocation, WorkspaceBlend> = {
  archive: { board: 0, desk: 0 }, board: { board: 1, desk: 0 }, desk: { board: 0, desk: 1 },
};

/** Start at the current blend, including when a user redirects a moving camera. */
export function beginWorkspaceTravel(from: WorkspaceBlend, destination: RhineLocation): WorkspaceTravel {
  const to = stops[destination];
  const distance = Math.abs(to.board + 2 * to.desk - from.board - 2 * from.desk);
  return { from: { ...from }, to: { ...to }, elapsed: 0, duration: 0.35 + distance * 0.95 };
}

/** One easing across the requested endpoints; unused stations keep zero weight. */
export function advanceWorkspaceTravel(travel: WorkspaceTravel, dt: number, reduced = false) {
  travel.elapsed = Math.min(travel.duration, travel.elapsed + Math.max(0, dt));
  const progress = reduced ? 1 : travel.elapsed / travel.duration;
  const t = progress ** 3 * (progress * (progress * 6 - 15) + 10);
  return {
    board: travel.from.board + (travel.to.board - travel.from.board) * t,
    desk: travel.from.desk + (travel.to.desk - travel.from.desk) * t,
    complete: progress === 1,
  };
}
