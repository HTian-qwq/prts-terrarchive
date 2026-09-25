import { mergeSourcesInOrder, sourceIdentity } from './catalogue.ts';
import type { ArchiveSource } from './types';

type Options = {
  api(endpoint: string, payload: any, signal?: AbortSignal): Promise<any>;
  changed(sources: ArchiveSource[]): void;
  failed(message: string): void;
};

/** Session-owned bookmarks, with a browser copy retained until synchronization succeeds. */
export function createArchiveRack(options: Options) {
  let sessionId = '', generation = new AbortController(), queue = Promise.resolve();
  let sources: ArchiveSource[] = [], pending = new Map<string, ArchiveSource>(), revision = -1;
  let requestedRevision = -1, disposed = false;
  const publish = () => options.changed(structuredClone(sources));
  const current = (g: AbortController) => !disposed && g === generation;
  function run(operation: (send: (endpoint: string, payload: any) => Promise<any>, g: AbortController) => Promise<void>) {
    const g = generation, session = sessionId;
    const send = async (endpoint: string, payload: any) => {
      if (!current(g)) throw new DOMException('会话已切换', 'AbortError');
      const result = await options.api(endpoint, { session_id: session, ...payload }, g.signal);
      if (result?.ok === false || result?.error) throw new Error(result?.error?.message || result?.error || '档案架同步失败');
      return result;
    };
    const task = queue.then(async () => {
      if (!current(g)) throw new DOMException('会话已切换', 'AbortError');
      await operation(send, g);
      if (!current(g)) throw new DOMException('会话已切换', 'AbortError');
    });
    queue = task.catch(error => {
      if (current(g) && error?.name !== 'AbortError') options.failed('档案架尚未同步给 Agent，资料已保留在此浏览器；可再次点击收藏重试。');
    });
    return task;
  }
  async function load(send: (endpoint: string, payload: any) => Promise<any>, g: AbortController) {
    const remote: ArchiveSource[] = []; let cursor: number | null = 0, seen = revision;
    while (cursor !== null && current(g)) {
      const result = await send('investigation.get', { section: 'rack', saved_only: true, limit: 128, cursor });
      for (const source of result.sources || []) remote.push({ ...source, id: source.sourceId || source.id, saved: true,
        ...(source.agentRead ? { readRanges: source.ranges } : {}) });
      cursor = result.nextCursor ?? null; seen = result.rack_revision;
    }
    if (!current(g)) return;
    sources = mergeSourcesInOrder(sources, [...remote, ...pending.values()]);
    revision = seen; publish();
  }
  return {
    setSession(id: string, cached: ArchiveSource[]) {
      generation.abort(); generation = new AbortController(); sessionId = id; queue = Promise.resolve();
      sources = structuredClone(cached); pending = new Map(cached.map(s => [sourceIdentity(s), s])); revision = -1; requestedRevision = -1;
      const initial = [...pending.values()];
      return run(async (send, g) => {
        if (initial.length) {
          await send('investigation.rack', { action: 'import', sources: initial });
          if (!current(g)) return;
          for (const source of initial) if (pending.get(sourceIdentity(source)) === source) pending.delete(sourceIdentity(source));
        }
        await load(send, g);
      });
    },
    refresh(nextRevision: number) {
      if (!sessionId || disposed || nextRevision <= revision || nextRevision === requestedRevision) return Promise.resolve();
      requestedRevision = nextRevision;
      const g = generation;
      return run(load).catch(error => { if (current(g)) requestedRevision = -1; throw error; });
    },
    save(source: ArchiveSource) {
      const item = { ...structuredClone(source), saved: true }, key = sourceIdentity(item);
      pending.set(key, item); sources = mergeSourcesInOrder(sources, [item]); publish();
      return run(async (send, g) => {
        const result = await send('investigation.rack', { action: 'add', mutation_id: crypto.randomUUID(), sources: [item] });
        if (!current(g)) return;
        if (pending.get(key) === item) pending.delete(key);
        // A receipt can race a bookmark created elsewhere. Read the complete rack
        // before treating this revision as locally synchronized.
        if (result.rack_revision !== revision) await load(send, g);
        else publish();
      });
    },
    isPending(source: ArchiveSource) { return pending.has(sourceIdentity(source)); },
    dispose() { disposed = true; generation.abort(); },
  };
}
