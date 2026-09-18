import type { InvestigationSnapshot } from './types';

/** Keep value signatures: snapshots may mutate in place or contain equal new objects. */
export class SnapshotUpdateGate {
  private session = '';
  private sources = '';
  private status = '';
  constructor(snapshot: InvestigationSnapshot) { this.read(snapshot); }
  read(snapshot: InvestigationSnapshot) {
    // Records and answer text belong to the reading panels. Answer presence still
    // affects the status/report entry; every other field remains significant.
    const { sources, answer, records: _records, ...status } = snapshot;
    const nextSources = JSON.stringify([snapshot.sessionId, sources]);
    const nextStatus = JSON.stringify({ ...status, hasAnswer: Boolean(answer) });
    const sessionChanged = snapshot.sessionId !== this.session;
    this.session = snapshot.sessionId;
    const sourcesChanged = nextSources !== this.sources;
    const statusChanged = sourcesChanged || nextStatus !== this.status;
    this.sources = nextSources; this.status = nextStatus;
    return { sessionChanged, sourcesChanged, statusChanged };
  }
}
