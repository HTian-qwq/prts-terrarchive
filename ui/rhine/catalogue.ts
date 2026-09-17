import type { ArchiveSource } from './types';

export const ARCHIVE_LANES = ['角色档案', '剧情记录', '世界资料', '时间线', '云端资料'] as const;
export { SHELF_PAGE_SIZE } from './shelf-layout.ts';

export function archiveLane(source: ArchiveSource): number {
  if (source.origin === 'cloud' || source.origin === 'web') return 4;
  if (/timeline/.test(source.kind)) return 3;
  if (/character|operator|voice|module|skin/.test(source.kind)) return 0;
  if (/story|activity/.test(source.kind)) return 1;
  return 2;
}

export function sourceIdentity(source: ArchiveSource): string {
  // `id` survives enrichment with a local locator. Merging below resolves
  // alternate IDs before the scene uses this stable, version-bound identity.
  return `${source.dataVersion || ''}:${source.id}`;
}

/** Preserve shelf order and explicit read/citation evidence when results recur. */
export function mergeSourcesInOrder(previous: ArchiveSource[], incoming: ArchiveSource[]): ArchiveSource[] {
  const rank = { found: 0, read: 1, cited: 2 };
  const sources: (ArchiveSource | null)[] = [];
  const aliases = new Map<string, number>();
  const keys = (source: ArchiveSource) => [
    ['id', source.id], ['document', source.documentId],
    ['uid', source.documentUid], ['ref', source.sourceRef],
  ].flatMap(([type, value]) => value ? [JSON.stringify([source.dataVersion || '', type, value])] : []);
  const combine = (old: ArchiveSource, source: ArchiveSource): ArchiveSource => ({ ...old, ...source,
      id: old.id,
      kind: ['corpus_read', 'reference', 'source'].includes(source.kind) ? old.kind : source.kind,
      state: rank[old.state] > rank[source.state] ? old.state : source.state,
      agentRead: Boolean(old.agentRead || source.agentRead || old.state === 'read' || source.state === 'read'
        || old.readRanges?.length || source.readRanges?.length),
      saved: old.saved || source.saved,
      origin: old.origin === 'cloud' ? 'cloud' : source.origin,
      excerpt: source.excerpt || old.excerpt,
      documentId: source.documentId || old.documentId,
      documentUid: source.documentUid || old.documentUid,
      sourceRef: source.sourceRef || old.sourceRef,
      ranges: [...new Map([...(old.ranges || []), ...(source.ranges || [])].map(r => [`${r.start}:${r.end}`, r])).values()],
      readRanges: [...new Map([...(old.readRanges || []), ...(source.readRanges || [])].map(r => [`${r.start}:${r.end}`, r])).values()],
    });
  for (const source of [...previous, ...incoming]) {
    const matches = [...new Set(keys(source).flatMap(key => aliases.has(key) ? [aliases.get(key)!] : []))].sort((a, b) => a - b);
    const index = matches[0] ?? sources.length;
    let merged = sources[index] || null;
    // A newly delivered locator can join two earlier aliases. Keep the first
    // shelf position and retain every range before updating it with new data.
    for (const duplicate of matches.slice(1)) {
      if (sources[duplicate]) merged = merged ? combine(merged, sources[duplicate]!) : sources[duplicate];
      sources[duplicate] = null;
      for (const [key, value] of aliases) if (value === duplicate) aliases.set(key, index);
    }
    merged = merged ? combine(merged, source) : { ...source,
      agentRead: Boolean(source.agentRead || source.state === 'read' || source.readRanges?.length) };
    sources[index] = merged;
    for (const key of [...keys(source), ...keys(merged)]) aliases.set(key, index);
  }
  return sources.filter((source): source is ArchiveSource => source !== null);
}
