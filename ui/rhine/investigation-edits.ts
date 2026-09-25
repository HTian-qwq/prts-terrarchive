type Revision = { content_revision: number; layout_revision: number };
type Axis = keyof Revision;

/** Advance only revisions acknowledged by this editor, never remote edits. */
export class InvestigationEditRevisions {
  private aliases = new Map<string, string>();
  private current = new Map<string, Revision>();
  private created = new Map<string, Revision>();
  private successors = new Map<string, Map<number, number>>();

  id(value: string) { return this.aliases.get(value) || value; }
  has(value: string) { return this.current.has(this.id(value)); }
  observe(clues: { id: string; contentRevision: number; layoutRevision: number }[]) {
    for (const clue of clues) this.current.set(clue.id, {
      content_revision: clue.contentRevision, layout_revision: clue.layoutRevision,
    });
  }
  revision(value: string, expected: number | undefined, axis: Axis) {
    const id = this.id(value);
    // A temporary card can inherit another card's revision when duplicated.
    let revision = id !== value ? this.created.get(id)?.[axis] : expected;
    revision ??= this.current.get(id)?.[axis];
    const next = this.successors.get(`${id}:${axis}`);
    while (revision !== undefined && next?.has(revision)) revision = next.get(revision);
    return revision;
  }
  acknowledge(changes: { id?: string; expected_content_revision?: number; expected_layout_revision?: number }[],
    result: { created_ids: Record<string, string>; clue_revisions: Record<string, Revision> }) {
    for (const [from, to] of Object.entries(result.created_ids)) if (from !== to) {
      this.aliases.set(from, to);
      if (!this.created.has(to)) this.created.set(to, result.clue_revisions[to]);
    }
    for (const [id, revision] of Object.entries(result.clue_revisions)) this.current.set(id, revision);
    for (const change of changes) {
      if (!change.id) continue;
      const revision = result.clue_revisions[change.id];
      if (!revision) continue;
      for (const axis of ['content_revision', 'layout_revision'] as const) {
        const before = change[`expected_${axis}`], after = revision[axis];
        if (before === undefined || after <= before) continue;
        const key = `${change.id}:${axis}`, chain = this.successors.get(key) || new Map();
        chain.set(before, after); this.successors.set(key, chain);
      }
    }
  }
}
