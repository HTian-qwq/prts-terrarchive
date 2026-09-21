import type { EvidenceCard } from './evidence-board-model';

const accents: Record<string, string> = { excerpt: '#7d887e', finding: '#647356', time: '#99815f', relation: '#6b8588', question: '#92774e', contrast: '#90756c', report: '#69765b', note: '#96806c' };
const stocks: Record<string, string[]> = {
  excerpt: ['#f6f3eb', '#f8f5ed', '#f1eee5'], finding: ['#e8eddf', '#e4e9dc', '#edf0e4'],
  time: ['#eee6d7', '#e9e2d4', '#f0eadd'], relation: ['#e6ecea', '#e1e9e7', '#e9eeec'],
  question: ['#e9dfc7', '#eee3c9', '#e4d9bd'], contrast: ['#f4eee5', '#eee9df', '#f6f1e7'],
  report: ['#f2f1e6'], note: ['#f0e7df'],
};
const names: Record<string, string> = { excerpt: '原文摘录', finding: '研究发现', time: '时间节点', relation: '关键关联', question: '待解问题', contrast: '交叉对照', report: '调查报告', note: '观察笔记' };

/** The printed card and its editor share the same paper stock and category accents. */
export function evidenceCardAppearance(card: EvidenceCard) {
  const kind = card.clueKind || (card.kind === 'source' ? 'excerpt' : card.kind);
  const variant = Math.abs(Math.trunc(card.variant || 0));
  return { kind, name: names[kind], accent: accents[kind], paper: stocks[kind][variant % stocks[kind].length] };
}
