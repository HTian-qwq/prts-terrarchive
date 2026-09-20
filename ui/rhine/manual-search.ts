import type { RhineOptions } from './types';

export const manualSearchControls = `
<div class="rhine-search-controls">
  <div class="rhine-search-modes" role="group" aria-label="检索来源"><button type="button" data-search-mode="local" aria-pressed="true">本地检索</button><button type="button" data-search-mode="cloud" aria-pressed="false">云端检索</button></div>
  <label class="rhine-search-game">资料范围 <select name="games" aria-label="检索游戏范围"><option value="">已启用的资料库</option><option value="arknights">明日方舟</option><option value="endfield">终末地</option></select></label>
</div>
<details class="rhine-search-advanced"><summary>高级设置 <span>按需限定检索范围</span></summary>
  <div class="rhine-search-fields">
    <label data-search-for="local">资料类型<select name="resource_types"><option value="">全部类型</option><option value="original_story">剧情原文</option><option value="character_bundle">角色档案与模组</option><option value="reviewed_wiki">审校 Wiki</option><option value="entity_profile">实体资料</option><option value="timeline">时间线</option></select></label>
    <label data-search-for="local">匹配方式<select name="match_mode"><option value="literal">原文关键词</option><option value="regex">正则表达式（线性子集）</option></select></label>
    <label data-search-for="cloud" hidden>检索深度<select name="depth"><option value="">服务默认</option><option value="fast">快速</option><option value="standard">标准</option><option value="deep">深入</option></select></label>
    <label data-search-for="cloud" hidden>来源范围<select name="evidence_policy"><option value="">服务默认</option><option value="mixed">综合资料</option><option value="original_only">仅原文</option></select></label>
    <label data-search-for="cloud" hidden>检索方式<select name="search_intent"><option value="">自动判断</option><option value="quote_search">台词与引文</option><option value="scene_search">事件与场景</option><option value="single_sentence_search">模糊寻找一句原文</option></select></label>
    <label data-search-for="cloud" hidden>候选审核<select name="validation"><option value="">服务默认</option><option value="none">跳过审核</option><option value="record_only">记录审核结果</option><option value="llm">启用模型审核</option></select></label>
    <label>人物／实体<input name="entity_names" placeholder="如：塔露拉、科西切" maxlength="2000"/></label>
    <label>说话人<input name="speakers" placeholder="填写原文说话人名称" maxlength="2000"/></label>
    <label>活动／篇章<input name="activities" placeholder="如：怒号光明" maxlength="2000"/></label>
    <label data-search-for="cloud" hidden>最多返回来源<input name="final_limit" type="number" min="1" max="100" step="1" placeholder="服务默认（可设 1–100）"/></label>
    <label data-search-for="cloud" hidden class="rhine-search-wide">补充检索词<input name="query_variants" placeholder="等义表述，用分号分隔；最多 8 项" maxlength="4000"/></label>
  </div><div class="rhine-search-settings-footer"><span>多项用逗号分隔；留空沿用默认。设置只用于本次手动检索。</span><button type="button" class="rhine-search-reset">恢复默认</button></div>
</details>`;

export function mountManualSearch(form: HTMLFormElement, api: RhineOptions['api'], changed: () => void) {
  let mode: 'local' | 'cloud' = 'local', enabled: boolean | undefined;
  let controller: AbortController | undefined;
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
  const value = (name: string) => field(name).value.trim();
  const list = (name: string) => [...new Set(value(name).split(/[,，、;；\n]+/u).map(v => v.trim()).filter(Boolean))];
  const render = () => {
    form.querySelectorAll<HTMLButtonElement>('[data-search-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.searchMode === mode)));
    form.querySelectorAll<HTMLElement>('[data-search-for]').forEach(element => element.hidden = element.dataset.searchFor !== mode);
    const input = form.querySelector<HTMLInputElement>('#rhine-query')!;
    input.maxLength = mode === 'cloud' ? 20000 : 512;
    input.placeholder = mode === 'cloud' ? '描述你想寻找的资料、事件，或一句记不清的原文' : '搜索人物、剧情、机构或一句原文';
    form.querySelector('.rhine-query-hint')!.textContent = mode === 'local' ? '检索已安装的本地资料；留空可浏览目录。'
      : enabled === false ? '云端服务尚未启用，请在 PRTS 资料设置中开启。' : '向云端检索资料；返回后可阅读原文、收入档案架或证据盒。';
  };
  form.querySelectorAll<HTMLButtonElement>('[data-search-mode]').forEach(button => button.addEventListener('click', () => {
    const next = button.dataset.searchMode as typeof mode;
    if (next === mode) return;
    mode = next; render(); changed();
  }));
  form.querySelector('.rhine-search-reset')!.addEventListener('click', () => {
    form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('.rhine-search-fields input,.rhine-search-fields select').forEach(element => element.value = element.name === 'match_mode' ? 'literal' : '');
    field('games').value = ''; render();
  });
  render();
  return {
    get mode() { return mode; },
    resetMode() { mode = 'local'; render(); },
    async refresh() {
      controller?.abort(); const current = new AbortController(); controller = current;
      try {
        const response = await api('archive.options', {}, current.signal);
        if (current.signal.aborted || response?.error || response?.ok === false) return;
        const data = response?.games ? response : response?.data;
        if (!data?.games) return;
        enabled = data.cloud_enabled;
        for (const option of (field('games') as HTMLSelectElement).options) option.disabled = !!option.value && !data.games.includes(option.value);
        if (value('games') && !data.games.includes(value('games'))) field('games').value = '';
        render();
      } catch { /* Search itself supplies actionable errors; an options refresh is optional. */ }
    },
    request(query: string): Record<string, unknown> {
      const request: Record<string, unknown> = { query };
      if (value('games')) request.games = [value('games')];
      if (mode === 'local') {
        if (value('resource_types')) request.resource_types = [value('resource_types')];
        request.match_mode = value('match_mode');
        for (const [input, key] of [['entity_names','entity_names'],['speakers','speakers'],['activities','activity_names']]) if (list(input).length) request[key] = list(input);
      } else {
        if (!query) throw new Error('请先输入想查找的问题或资料。');
        if (enabled === false) throw new Error('云端检索尚未启用，请在 PRTS 资料设置中开启。');
        for (const key of ['depth','evidence_policy']) if (value(key)) request[key] = value(key);
        const options: Record<string, unknown> = {}, filters: Record<string, unknown> = {};
        for (const key of ['search_intent','validation']) if (value(key)) options[key] = value(key);
        for (const key of ['entity_names','speakers','activities']) if (list(key).length) filters[key] = list(key);
        if (Object.keys(filters).length) options.filters = filters;
        if (value('final_limit')) options.limits = { final_limit: Number(value('final_limit')) };
        const variants = value('query_variants').split(/[;；\n]+/u).map(v => v.trim()).filter(Boolean);
        if (variants.length) options.query_variants = [...new Set(variants)];
        if (Object.keys(options).length) request.options = options;
      }
      return request;
    },
    dispose() { controller?.abort(); },
  };
}
