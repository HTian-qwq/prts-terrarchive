export const version = 'a'.repeat(64)
export function snapshotWorkload() {
  const sources = Array.from({ length: 274 }, (_, i) => ({
    id: 'source-' + i, title: 'Fixture document ' + i, documentId: 'document-' + i,
    dataVersion: version, kind: 'story', origin: 'cloud', state: 'read',
    ranges: [{ start: 1, end: 30 }], readRanges: [{ start: 1, end: 30 }],
    sourceRef: 'client_data:fixture:' + i + ':L1', excerpt: 'Returned fixture material. '.repeat(24),
  }))
  const nodes = new Map()
  for (let i = 0; i < 40; i++) {
    if (i % 8 === 0) nodes.set('user-' + i, { kind: 'user', data: { content: [{ type: 'text', text: 'Question ' + i }] } })
    nodes.set('tool-' + i, { kind: 'tool-call', data: { root: { kind: 'tool-result',
      call: { name: 'corpus_search', argsRaw: '{"query":"fixture"}' },
      meta: { kind: 'prts-archive-sources-v1', sources: sources.slice(i * 7, i * 7 + 7) },
      content: [{ type: 'text', text: 'Returned tool content. '.repeat(200) }],
    } } })
    if (i % 8 === 7 && i < 39) nodes.set('answer-' + i, { kind: 'assistant-step', data: {
      status: 'settled', blocks: [{ kind: 'text', text: 'According to 《Fixture document ' + (i * 7) + '》第 1–3 行。' }],
    } })
  }
  nodes.set('answer', { kind: 'assistant-step', data: { status: 'running', blocks: [{ kind: 'text', text: 'Initial answer' }] } })
  return { order: [...nodes.keys()], nodes }
}
