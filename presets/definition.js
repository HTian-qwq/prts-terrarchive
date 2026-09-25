/** PRTS mode for DSH releases with the declarative preset registry. */
export const prtsPreset = {
  id: 'prts',
  name: 'PRTS 模式',
  description: '加载 PRTS.chat 本地与云端资料检索、DSH 网页搜索及对应检索策略。',
  order: 30,
  plugins: [
    {
      id: 'prts-corpus', name: 'prts-terrarchive',
      config: {
        registerTools: true, registerUi: false,
        enabledGames: ['arknights', 'endfield'],
        cloud: { baseUrl: 'https://prts.chat', game: 'all' },
      },
    },
    {
      id: 'tool-web', name: '@deepseek-ai/dsh-tool-web',
      config: { fetch: true, searchTimeoutMs: 60000 },
    },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    {
      id: 'prts-retrieval-skill', name: 'prts-terrarchive/skill',
      config: { enabledGames: ['arknights', 'endfield'] },
    },
  ],
}
