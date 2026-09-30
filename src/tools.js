/** Reusable Agent-plane entry: corpus and investigation tools, without Host UI. */
import { apply as applyCorpus } from './index.js'

export const name = 'prts-tools'

export async function apply(ctx, config = {}) {
  return applyCorpus(ctx, {
    cloud: { baseUrl: 'https://prts.chat', game: 'all' },
    ...config,
    registerTools: true,
    registerUi: false,
  })
}
