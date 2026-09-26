/** Historical boards never borrow mutable clues or relations from the working board. */
export function investigationVersion(board: any, sources: any[], version: number) {
  if (!board || !version) return { board, sources, complete: true };
  const report = board.reports.find((item: any) => item.version === version);
  if (!report) throw new Error('该调查版本不存在，请重新选择版本。');
  const saved = report.boardSnapshot;
  const historical = saved || {
    id: board.id, title: report.title, objective: report.summary,
    createdAt: report.publishedAt, updatedAt: report.publishedAt,
    knowledgeRevision: report.basisKnowledgeRevision, layoutRevision: 0,
    clues: report.clues, relations: [], openQuestions: [], evidenceInbox: [], inboxRevision: 0,
  };
  return { board: structuredClone({ ...historical, reports: [report] }),
    sources: structuredClone(saved?.sources || report.sources), complete: Boolean(saved) };
}
