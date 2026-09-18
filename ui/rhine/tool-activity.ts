import type { ArchiveOperation, ArchiveSource, InvestigationSnapshot, InvestigationToolCall } from './types';

/** Tool receipts drive the HUD; an earlier assistant paragraph is not completion. */
export function investigationActivity(snapshot: InvestigationSnapshot) {
  const calls: InvestigationToolCall[] = snapshot.toolCalls ?? snapshot.operations ?? [];
  const active = snapshot.running ? calls.filter(call => call.state === 'active'
    && !calls.some(child => child.state === 'active' && child.id.startsWith(`${call.id}:`))) : [];
  const current = active.at(-1);
  const latest = calls.at(-1);
  return {
    calls, active, current, recent: calls.slice(-3),
    label: current ? `正在调用 ${current.tool}` : snapshot.running ? '等待下一步'
      : snapshot.outcome === 'completed' ? '本轮调查已完成'
      : snapshot.outcome === 'interrupted' ? '调查已停止' : snapshot.error ? '调查未完成'
      : snapshot.answer ? '已返回内容' : '等待开始调查',
    detail: current ? [current.query, active.length > 1 ? `另有 ${active.length - 1} 个调用进行中` : ''].filter(Boolean).join(' · ')
      : snapshot.running ? latest ? `${latest.tool} ${latest.state === 'error' ? '调用失败' : '已返回'} · 等待 Agent 继续`
        : '等待首次工具调用' : snapshot.error || '',
    showReport: Boolean(snapshot.answer) && !snapshot.running && !active.length,
  };
}

function webUrl(value?: string) {
  try { const url = new URL(value || ''); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return ''; url.hash = ''; return url.href; } catch { return ''; }
}

export function operationSource(operation: ArchiveOperation, sources: ArchiveSource[]) {
  const candidates = sources.filter(source => !operation.dataVersion || source.dataVersion === operation.dataVersion);
  const returned = candidates.find(source => operation.sourceIds.includes(source.id));
  if (returned) return returned;
  if (operation.tool === 'web_fetch' && operation.url) {
    const url = webUrl(operation.url);
    if (!url) return undefined;
    const source = candidates.find(item => item.id === `web:${url}` || item.origin === 'web' && webUrl(item.url) === url);
    if (source) return source;
    // A live URL is a reading target, not a returned source: keep this card out
    // of the material rack and counters until an actual receipt arrives.
    if (operation.state !== 'complete') return { id: `web:${url}`, url, title: url, kind: 'web_page',
      origin: 'web' as const, state: 'found' as const, excerpt: operation.state === 'active' ? '正在获取网页内容，返回后可阅读。' : '网页读取未完成。' };
    return undefined;
  }
  const matches = candidates.filter(source => operation.documentUid ? source.documentUid === operation.documentUid
    : operation.documentId ? source.documentId === operation.documentId
    : Boolean(operation.sourceRef && source.sourceRef === operation.sourceRef));
  return matches.length === 1 ? matches[0] : undefined;
}

/** One card per real read call, including a repeat read of the same document. */
export function latestReadFocus(snapshot: InvestigationSnapshot, sources: ArchiveSource[]) {
  const reads = (snapshot.operations || []).filter(call => call.kind === 'read');
  const operation = reads.at(-1);
  if (!operation) return undefined;
  const source = operationSource(operation, sources);
  if (!source) return undefined;
  return { key: `${snapshot.sessionId}:${snapshot.investigationId || ''}:${operation.id}`, source, operation };
}

/** New calls move the whole card downward once; streamed snapshots stay still. */
export class ReadCardMotion {
  private animation?: Animation;
  reveal(element: HTMLElement, reduced: boolean) {
    this.dispose();
    if (!reduced) this.animation = element.animate([
      { opacity: 0, transform: 'translateY(-20px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: 340, easing: 'cubic-bezier(.22,1,.36,1)' });
  }
  dispose() { this.animation?.cancel(); this.animation = undefined; }
}
