import type { RhineLocation } from './types';

export type ReadingOriginKind = 'search' | 'rack' | 'report' | 'basket' | 'log' | 'investigation' | 'archive' | 'desk' | 'board';
export interface ReadingOrigin {
  kind: ReadingOriginKind;
  location: RhineLocation;
  sessionId: string;
  sourceId: string;
  focus: HTMLElement | null;
  scroll: { element: HTMLElement; top: number; left: number }[];
  arrayExpanded: boolean;
}
export const readingOriginLabel = (kind: ReadingOriginKind, boardKind?: 'report' | 'clue' | 'inbox') =>
  kind === 'investigation' ? boardKind === 'inbox' ? '返回证据盒' : boardKind === 'clue' ? '返回线索' : '返回报告'
    : ({ search: '返回搜索结果', rack: '返回档案目录', report: '返回报告', basket: '返回摘录', log: '返回调查记录', archive: '返回检索阵列', desk: '返回档案架', board: '返回调查板' } as const)[kind];

export function captureReadingOrigin(root: HTMLElement, value: Omit<ReadingOrigin, 'focus' | 'scroll'>): ReadingOrigin {
  return { ...value, focus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    scroll: [...root.querySelectorAll<HTMLElement>('*')].filter(element => element.scrollTop || element.scrollLeft)
      .map(element => ({ element, top: element.scrollTop, left: element.scrollLeft })) };
}
export function restoreReadingOrigin(root: HTMLElement, origin: ReadingOrigin) {
  const target = origin.focus?.isConnected && origin.focus.getClientRects().length && !origin.focus.closest('[hidden],[inert]')
    ? origin.focus : [...root.querySelectorAll<HTMLElement>('[data-source-id]')].find(element =>
      element.dataset.sourceId === origin.sourceId && element.getClientRects().length && !element.closest('[hidden],[inert]'));
  target?.focus({ preventScroll: true });
  for (const { element, top, left } of origin.scroll) if (element.isConnected) { element.scrollTop = top; element.scrollLeft = left; }
}
