export const ARCHIVE_NAVIGATION_INTERVAL_MS = 350;
export const MAX_RETURNING_ARCHIVE_FILES = 3;

/** One shared budget for manual row/lane/point navigation; rejected input is not queued. */
export class ArchiveNavigationLimiter {
  private lastAccepted = -Infinity;
  private accepted = 0;
  private rateLimited = 0;
  private busyLimited = 0;

  tryAccept(now: number, returningFiles = 0): boolean {
    if (now - this.lastAccepted < ARCHIVE_NAVIGATION_INTERVAL_MS) {
      this.rateLimited++;
      return false;
    }
    // Wall-clock throttling alone cannot bound copies when rendering/animation
    // slows down. Wait for existing returns to settle instead of adding more.
    if (returningFiles >= MAX_RETURNING_ARCHIVE_FILES) {
      this.busyLimited++;
      return false;
    }
    this.lastAccepted = now;
    this.accepted++;
    return true;
  }

  stats() {
    return { intervalMs: ARCHIVE_NAVIGATION_INTERVAL_MS, maxReturningFiles: MAX_RETURNING_ARCHIVE_FILES,
      accepted: this.accepted, rateLimited: this.rateLimited, busyLimited: this.busyLimited, queued: 0 };
  }
}
