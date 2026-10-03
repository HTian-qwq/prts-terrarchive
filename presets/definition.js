/** PRTS additions; registration composes these with the host's standard mode. */
export const prtsPreset = {
  id: 'prts',
  name: 'PRTS 模式',
  description: '标准模式的完整能力，加上 PRTS.chat 本地与云端检索；莱茵生命皮肤下启用证据板和调查报告。',
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
