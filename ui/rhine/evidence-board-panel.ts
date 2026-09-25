import { evidenceCardAppearance } from './evidence-card-style';
import { createEvidenceId, createEvidenceTemplate, createPreviewCards, EVIDENCE_BODY_LIMIT, EVIDENCE_CARD_CAPACITY,
  EVIDENCE_STAGES, EVIDENCE_STORAGE_LIMIT, EVIDENCE_TITLE_LIMIT, EVIDENCE_SCALE_MIN, EVIDENCE_SCALE_MAX, clampEvidencePosition,
  evidenceCardLayout, evidenceCardScale, evidenceStorageKey, isPreviewCard, parseEvidenceCards,
  type EvidenceBoardTool, type EvidenceCard, type EvidenceTemplate } from './evidence-board-model';
import { rebaseEvidenceHistory, createEvidenceHistory, type EvidenceSnapshot } from './evidence-board-history';

type Point = { x: number; y: number };
type Options = {
  sessionId: string;
  managed?: boolean;
  onChange: (cards: EvidenceCard[]) => void;
  onSelect: (id: string | null) => void;
  onBrowse: () => void;
  onToolChange: (tool: EvidenceBoardTool) => void;
  onToolsOpen?: (open: boolean) => void;
  onViewportInset?: (bottomFraction: number) => void;
  getCardBounds?: (id: string) => { left: number; right: number; top: number; bottom: number } | null;
};
const PREVIEW_LAYOUT_VERSION = 3;
const TEMPLATE_NAMES: Record<EvidenceTemplate, string> = { note: '短便签', question: '疑问签', source: '资料卡', tag: '关键词标签' };

function element<K extends keyof HTMLElementTagNameMap>(tag: K, name: string, text?: string) {
  const result = document.createElement(tag);
  result.className = `rhine-evidence-${name}`;
  if (text !== undefined) result.textContent = text;
  return result;
}

/** A single movable tool window; cards and placement previews belong to the shared scene. */
export function mountEvidenceBoardPanel(host: HTMLElement, options: Options) {
  let sessionId = options.sessionId, cards: EvidenceCard[] = [], selected: string | null = null;
  let active = false, disposed = false, directoryOpen = false, toolsOpen = false, editorCollapsed = false;
  let tool: EvidenceBoardTool = { mode: 'select' };
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let scaleTimer: ReturnType<typeof setTimeout> | undefined, scaleDirty = false, scalePointerActive = false;
  let scaleBefore: EvidenceSnapshot | null = null;
  let editorRevision: number | undefined;
  let storageAvailable = true, toolPosition: Point | null = null;
  let viewportInset = 0, positionedCard: string | null = null;
  let windowDrag: { id: number; x: number; y: number; start: Point; scale: number } | null = null;
  const history = createEvidenceHistory();
  const promotedIds = new Map<string, string>();
  const events = new AbortController();
  const root = host.closest('.rhine-workbench');
  const panel = element('section', 'panel');
  panel.hidden = true;
  panel.setAttribute('aria-label', '证据板');
  panel.append(element('p', 'kicker', 'EVIDENCE BOARD'), element('h2', 'heading', '证据板'));
  const countLabel = element('p', 'count');
  const makeButton = (text: string, name: string, action: () => void) => {
    const button = element('button', name, text);
    button.type = 'button';
    button.addEventListener('click', action, { signal: events.signal });
    return button;
  };
  const newButton = makeButton('整理线索 ↗', 'new', () => {
    if (sceneUnavailable()) placeCard('note');
    else openTools();
  });
  const directoryButton = makeButton('线索目录', 'directory-toggle', () => {
    directoryOpen = !directoryOpen; renderDirectoryVisibility();
  });
  const directory = element('div', 'directory');
  directory.id = `rhine-evidence-directory-${createEvidenceId().replace(/[^a-zA-Z0-9-]/g, '')}`;
  directoryButton.setAttribute('aria-controls', directory.id);
  const list = element('ul', 'card-list'); directory.append(list);
  const actions = element('div', 'actions'); actions.append(newButton, directoryButton);
  panel.append(countLabel, actions, directory);

  const floating = element('section', 'tools');
  floating.hidden = true; floating.setAttribute('role', 'dialog');
  floating.setAttribute('aria-label', '整理线索');
  const heading = element('div', 'tools-heading');
  const headingText = element('div', 'tools-heading-text');
  headingText.append(element('span', 'tools-kicker', 'FIELD TOOLS'), element('strong', 'tools-title', '整理线索'));
  const closeButton = makeButton('×', 'close-tools', closeTools);
  closeButton.setAttribute('aria-label', '关闭整理工具');
  const collapseButton = makeButton('收起', 'collapse-tools', () => {
    if (editorCollapsed) expandTools(); else minimizeTools();
  });
  collapseButton.setAttribute('aria-label', '收起工具，保留线索选中');
  collapseButton.setAttribute('aria-expanded', 'true');
  const headingActions = element('div', 'heading-actions'); headingActions.append(collapseButton, closeButton);
  heading.append(headingText, headingActions);
  const backButton = makeButton('‹ 全部工具', 'back-tools', () => { select(null); openTools(); });
  const modeRow = element('div', 'mode-row');
  const modeText = element('p', 'mode-text');
  const cancelToolButton = makeButton('取消', 'cancel-tool', () => setTool({ mode: 'select' }));
  modeRow.append(modeText, cancelToolButton); modeRow.hidden = true;
  const home = element('div', 'tools-home');
  home.append(element('p', 'tools-intro', '把发现钉在这里，让线索彼此相连。'));
  const templates = element('div', 'templates');
  const templateButtons: HTMLButtonElement[] = [];
  for (const [template, description, marker] of [
    ['note', '记录一条发现', '▱'], ['question', '留住未解之处', '?'], ['source', '原文、来源与摘录', '≡'],
  ] as const) {
    const button = makeButton('', 'template', () => beginPlacement(template));
    button.dataset.template = template;
    button.append(element('span', `template-mark is-${template}`, marker), element('strong', 'template-name', TEMPLATE_NAMES[template]),
      element('span', 'template-description', description));
    templates.append(button); templateButtons.push(button);
  }
  const connectButton = makeButton('', 'template', () => {
    flushEditor(); selected = null; renderEditor(); options.onSelect(null);
    setTool({ mode: 'connect' });
  });
  connectButton.dataset.tool = 'connect';
  connectButton.append(element('span', 'template-mark is-connect', '●—●'), element('strong', 'template-name', '红绳连线'),
    element('span', 'template-description', '依次点选两条线索'));
  templates.append(connectButton);
  const tagButton = makeButton('＋ 关键词标签', 'tag-template', () => beginPlacement('tag'));
  tagButton.dataset.template = 'tag'; templateButtons.push(tagButton);
  const browseButton = makeButton('检索资料 ↗', 'browse', () => { flushEditor(); setTool({ mode: 'select' }); options.onBrowse(); });
  const homeMore = element('details', 'tools-more');
  const sampleButton = makeButton('清空未编辑的示例', 'clear-examples', () => {
    flushEditor(); const before = snapshot(); setTool({ mode: 'select' });
    cards = cards.filter(card => !isPreviewCard(card));
    if (!cards.some(card => card.id === selected)) selected = null;
    publish(before, '清空示例'); renderEditor(); options.onSelect(selected);
    announce('未编辑的示例已清空。');
  });
  homeMore.append(element('summary', 'attributes-summary', '更多操作'), sampleButton);
  const shortcuts = element('details', 'shortcuts');
  shortcuts.append(element('summary', 'attributes-summary', '键盘快捷操作'),
    element('p', 'tools-help', 'N 新便签 · L 红绳连线 · V 选择\n⌘ / Ctrl D 复制 · Delete 移除\n⌘ / Ctrl Z 撤销 · 加 Shift 重做\nEsc 取消当前操作'));
  home.append(templates, tagButton, browseButton, element('p', 'tools-help', '空白拖动平移 · 滚轮缩放\n空格或中键可从纸片上拖动画面'), shortcuts, homeMore);

  const editor = element('form', 'editor'); editor.hidden = true;
  const editorBody = element('div', 'editor-body');
  const title = element('textarea', 'title-input');
  title.rows = 1; title.required = true; title.maxLength = EVIDENCE_TITLE_LIMIT;
  title.setAttribute('aria-label', '线索标题'); title.placeholder = '给这条线索起个标题';
  const body = element('textarea', 'body-input'); body.rows = 4; body.maxLength = EVIDENCE_BODY_LIMIT;
  body.setAttribute('aria-label', '线索内容'); body.placeholder = '记录发现、依据，以及仍需核对的地方…';
  const stage = element('select', 'stage-input');
  EVIDENCE_STAGES.forEach((name, index) => {
    const option = document.createElement('option'); option.value = String(index); option.textContent = `0${index + 1} ${name}`; stage.append(option);
  });
  const kind = element('select', 'kind-input');
  for (const [value, label] of [['note', '观察笔记'], ['source', '资料摘录'], ['question', '待查问题']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; kind.append(option);
  }
  const field = (label: string, control: HTMLElement) => {
    const wrapper = element('label', 'field'); wrapper.append(element('span', 'field-label', label), control); return wrapper;
  };
  const selects = element('div', 'selects'); selects.append(field('研究阶段', stage), field('线索类型', kind));
  const attributes = element('details', 'attributes');
  const deleteButton = makeButton('移除这条线索', 'remove', removeSelected);
  attributes.append(element('summary', 'attributes-summary', '更多属性与操作'), selects, deleteButton);
  const sourceLabel = element('p', 'source-label');
  const sizeControl = element('div', 'size-control');
  const sizeHeader = element('div', 'size-heading');
  const sizeRange = element('input', 'size-range'); sizeRange.type = 'range';
  sizeRange.min = String(EVIDENCE_SCALE_MIN); sizeRange.max = String(EVIDENCE_SCALE_MAX); sizeRange.step = 'any';
  sizeRange.setAttribute('aria-label', '线索纸片大小');
  const sizeValue = element('output', 'size-value', '100%');
  const sizeReset = makeButton('原大小', 'size-reset', () => { resizeCurrent(1); commitScale(); });
  sizeReset.setAttribute('aria-label', '恢复这条线索的原大小');
  sizeHeader.append(element('span', 'field-label', '纸片大小'), sizeValue, sizeReset);
  const sizeTrack = element('div', 'size-track');
  const sizeDown = makeButton('−', 'size-down', () => { nudgeSize(-0.1); });
  const sizeUp = makeButton('＋', 'size-up', () => { nudgeSize(0.1); });
  sizeDown.setAttribute('aria-label', '缩小这条线索'); sizeUp.setAttribute('aria-label', '放大这条线索');
  sizeTrack.append(sizeDown, sizeRange, sizeUp); sizeControl.append(sizeHeader, sizeTrack);
  sizeControl.append(element('p', 'size-help', '也可拖动选中纸片右下角，直接调整大小。'));
  const selectedActions = element('div', 'selected-actions');
  const connectSelectedButton = makeButton('●—● 从此处连线', 'connect-selected', startConnection);
  connectSelectedButton.title = '从选中的线索拉一条红绳（L）';
  const duplicateButton = makeButton('＋ 复制', 'duplicate', duplicateSelected);
  duplicateButton.title = '复制选中的纸片（Ctrl / ⌘ D）';
  selectedActions.append(connectSelectedButton, duplicateButton);
  const editorActions = element('div', 'editor-actions');
  const saveButton = element('button', 'save', '保存线索'); saveButton.type = 'submit';
  editorActions.append(saveButton, element('span', 'autosave', '输入自动保存'));
  const connections = element('details', 'connections');
  const linkTarget = element('select', 'link-target');
  const linkAdd = makeButton('连线 ＋', 'link-add', () => { if (selected) connectCards(selected, linkTarget.value); });
  const linkControls = element('div', 'link-controls'); linkControls.append(linkTarget, linkAdd);
  const linkList = element('ul', 'link-list');
  const connectionsSummary = element('summary', 'attributes-summary', '关联线索');
  connections.append(connectionsSummary, field('连到另一条线索', linkControls), linkList);
  linkTarget.setAttribute('aria-label', '连到另一条线索');
  linkTarget.addEventListener('change', () => { linkAdd.disabled = !linkTarget.value; }, { signal: events.signal });
  const paper = element('article', 'edit-paper');
  const paperMeta = element('div', 'paper-meta');
  const paperKind = element('span', 'paper-kind'), paperId = element('span', 'paper-id');
  paperMeta.append(paperKind, paperId);
  const titleField = field('标题', title), bodyField = field('内容', body);
  titleField.classList.add('is-paper-title'); bodyField.classList.add('is-paper-body');
  const paperFoot = element('div', 'paper-foot');
  const paperSource = element('span', 'paper-source'), paperEvidence = element('span', 'paper-evidence');
  paperFoot.append(paperSource, paperEvidence);
  paper.append(paperMeta, titleField, bodyField, sourceLabel, paperFoot);
  const adjustments = element('details', 'adjustments');
  adjustments.append(element('summary', 'attributes-summary', '纸片大小与连线'), sizeControl, connections, attributes);
  editorBody.append(paper, selectedActions, adjustments);
  editor.append(editorBody, editorActions);
  const status = element('p', 'status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const footer = element('div', 'tools-footer');
  const undoButton = makeButton('↶ 撤销', 'undo', undoLast);
  const redoButton = makeButton('↷ 重做', 'redo', redoLast);
  const historyActions = element('div', 'history-actions'); historyActions.append(undoButton, redoButton);
  footer.append(status, historyActions);
  floating.append(heading, backButton, modeRow, home, editor, footer);
  host.append(panel, floating);

  function sceneUnavailable() { return Boolean(root?.classList.contains('rhine-scene-unavailable')); }
  function announce(message: string) { status.textContent = message; }
  function cloneCards(values: EvidenceCard[]) { return values.map(card => ({ ...card,
    ...(card.position ? { position: { ...card.position } } : {}), ...(card.links ? { links: [...card.links] } : {}),
  })); }
  function copyCards() { return cloneCards(cards); }
  function cancelSave() { clearTimeout(saveTimer); saveTimer = undefined; }
  function resolveId(id: string) { return promotedIds.get(id) || id; }
  function promoteCard(id: string) {
    const card = cards.find(value => value.id === id);
    if (!card || !isPreviewCard(card)) return id;
    const nextId = createEvidenceId(); card.id = nextId;
    for (const other of cards) if (other.links) other.links = other.links.map(value => value === id ? nextId : value);
    promotedIds.set(id, nextId); if (selected === id) selected = nextId;
    return nextId;
  }
  function cleanLinks() {
    const ids = new Set(cards.map(card => card.id)), edges = new Set<string>();
    for (const card of cards) if (card.links) card.links = card.links.filter(id => {
      if (id === card.id || !ids.has(id)) return false;
      const edge = JSON.stringify([card.id, id].sort());
      if (edges.has(edge)) return false;
      edges.add(edge); return true;
    });
  }
  function connectedIds(card: EvidenceCard) {
    return new Set([...(card.links || []), ...cards.filter(other => other.links?.includes(card.id)).map(other => other.id)]);
  }
  function freezeLayout() {
    cards = cards.map((card, index) => {
      const layout = evidenceCardLayout(card, index); return { ...card, position: { x: layout.x, y: layout.y }, rotation: layout.rotation };
    });
  }
  function positionNewCard(card: EvidenceCard) {
    let best = evidenceCardLayout(card, 0), distance = -Infinity;
    for (let index = 0; index < EVIDENCE_CARD_CAPACITY; index++) {
      const candidate = evidenceCardLayout(card, index);
      const nearest = cards.length ? Math.min(...cards.map((other, otherIndex) => {
        const placed = evidenceCardLayout(other, otherIndex); return (placed.x - candidate.x) ** 2 + (placed.y - candidate.y) ** 2;
      })) : Infinity;
      if (nearest > distance) { best = candidate; distance = nearest; }
    }
    return { ...card, position: { x: best.x, y: best.y }, rotation: best.rotation };
  }
  function snapshot(): EvidenceSnapshot { return { cards: copyCards(), selected, promotions: [...promotedIds] }; }
  function restoreHistory(direction: 'undo' | 'redo') {
    if (disposed) return false;
    // The newest visible draft is an operation too; undo must recover it on redo.
    flushEditor(); setTool({ mode: 'select' });
    const entry = history[direction](); if (!entry) return false;
    cards = options.managed ? rebaseEvidenceHistory(cards, entry.from.cards, entry.state.cards) : cloneCards(entry.state.cards); selected = entry.state.selected;
    promotedIds.clear(); entry.state.promotions.forEach(([from, to]) => promotedIds.set(from, to));
    publish(); renderEditor(); options.onSelect(selected);
    announce(`已${direction === 'undo' ? '撤销' : '重做'}${entry.label}。`); return true;
  }
  function undoLast() { return restoreHistory('undo'); }
  function redoLast() { return restoreHistory('redo'); }
  function persist() {
    if (options.managed) return;
    try {
      localStorage.setItem(evidenceStorageKey(sessionId), JSON.stringify({ version: 1, previewLayout: PREVIEW_LAYOUT_VERSION, cards }));
      storageAvailable = true;
    } catch {
      storageAvailable = false; announce('浏览器存储不可用；本次打开期间仍可编辑，关闭前请保留重要内容。');
    }
  }
  function publish(before?: EvidenceSnapshot, label = '编辑线索', group?: string) {
    cleanLinks();
    if (before) history.record(before, snapshot(), label, group);
    persist(); renderOverview(); renderLinks(); renderUndo(); options.onChange(copyCards());
  }
  function load() {
    cards = [];
    if (options.managed) { renderOverview(); renderLinks(); renderUndo(); options.onChange([]); return; }
    try {
      const raw = localStorage.getItem(evidenceStorageKey(sessionId));
      if (raw === null) { cards = createPreviewCards(); announce('孤星 · 六则剧情研究示例，可编辑或清空。'); }
      else if (raw.length <= EVIDENCE_STORAGE_LIMIT) {
        const saved: unknown = JSON.parse(raw);
        cards = saved && typeof saved === 'object' && !Array.isArray(saved) && (saved as { version?: unknown }).version === 1
          ? parseEvidenceCards((saved as { cards?: unknown }).cards) : [];
        if (saved && typeof saved === 'object' && (saved as { previewLayout?: unknown }).previewLayout !== PREVIEW_LAYOUT_VERSION) {
          const previews = new Map(createPreviewCards().map(card => [card.id, card]));
          const preserveLayout = (saved as { previewLayout?: unknown }).previewLayout === 2;
          cards = cards.map(card => {
            const preview = isPreviewCard(card) ? previews.get(card.id) : undefined;
            if (!preview) return card;
            return preserveLayout ? { ...preview, ...(card.position ? { position: { ...card.position } } : {}),
              ...(card.rotation !== undefined ? { rotation: card.rotation } : {}) } : preview;
          });
        }
        announce('当前会话 · 手动线索已载入');
      } else announce('已跳过超出容量的证据板记录，可以重新添加线索。');
      storageAvailable = true;
    } catch { storageAvailable = false; announce('未能载入浏览器中的证据板；本次打开期间仍可编辑。'); }
    freezeLayout(); cleanLinks(); renderOverview(); renderEditor(); renderUndo(); options.onChange(copyCards()); options.onSelect(null);
  }
  function renderDirectoryVisibility() {
    const fallback = sceneUnavailable();
    directory.classList.toggle('is-open', directoryOpen || fallback);
    directoryButton.hidden = fallback;
    directoryButton.setAttribute('aria-expanded', String(directoryOpen || fallback));
    directoryButton.textContent = `${directoryOpen ? '收起' : ''}线索目录 · ${String(cards.length).padStart(2, '0')}`;
    newButton.textContent = fallback ? '＋ 新建线索' : '整理线索 ↗';
    newButton.disabled = fallback && cards.length >= EVIDENCE_CARD_CAPACITY;
    connectButton.disabled = !fallback && cards.length < 2;
    connectButton.hidden = fallback;
  }
  function renderOverview() {
    countLabel.textContent = `已钉 ${String(cards.length).padStart(2, '0')} / ${EVIDENCE_CARD_CAPACITY} 条线索`;
    for (const button of templateButtons) {
      button.disabled = cards.length >= EVIDENCE_CARD_CAPACITY;
      button.title = button.disabled ? `${EVIDENCE_CARD_CAPACITY} 张纸片已满，移除一条后可继续添加` : '选择后在板面点击放置';
    }
    sampleButton.hidden = !cards.some(isPreviewCard); homeMore.hidden = sampleButton.hidden; list.replaceChildren();
    duplicateButton.disabled = !selected || cards.length >= EVIDENCE_CARD_CAPACITY;
    if (!cards.length) list.append(element('li', 'empty', '证据板还是空的，试着记录第一条线索。'));
    for (const card of cards) {
      const row = element('li', 'card-row'), button = element('button', 'card-button');
      button.type = 'button'; button.setAttribute('aria-pressed', String(card.id === selected));
      button.append(element('span', 'card-marker', card.kind === 'question' ? '?' : card.kind === 'source' ? '↗' : '·'), element('span', 'card-title', card.title));
      button.addEventListener('click', () => { setTool({ mode: 'select' }); select(card.id); });
      row.append(button); list.append(row);
    }
    renderDirectoryVisibility();
  }
  function renderEditor() {
    const card = cards.find(value => value.id === selected);
    editor.hidden = !card; home.hidden = Boolean(card); backButton.hidden = !card;
    floating.classList.toggle('has-selection', Boolean(card));
    renderCollapsed();
    if (card) {
      renderPaper(card);
      editorRevision = card.contentRevision;
      title.value = card.title; body.value = card.body; stage.value = String(card.stage); kind.value = card.kind;
      sourceLabel.hidden = !card.sourceTitle; sourceLabel.textContent = card.sourceTitle ? `资料来源：${card.sourceTitle}` : '';
      renderSize(card);
    }
    renderLinks(); if (toolsOpen) positionTools();
  }
  function fitPaperText() {
    if (floating.hidden || editor.hidden || editorCollapsed) return;
    for (const input of [title, body]) {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input === title ? 230 : 320, Math.max(input === title ? 40 : 150, input.scrollHeight))}px`;
    }
  }
  function renderPaper(card: EvidenceCard) {
    const appearance = evidenceCardAppearance(card);
    paper.dataset.kind = appearance.kind;
    paper.style.setProperty('--paper-stock', appearance.paper);
    paper.style.setProperty('--paper-accent', appearance.accent);
    paperKind.textContent = appearance.name;
    paperId.textContent = card.clueKind ? card.id : `NOTE / ${String(cards.indexOf(card) + 1).padStart(2, '0')}`;
    paperSource.textContent = card.sourceLabel || (card.sourceTitle ? '保留原文来源' : '手动线索');
    paperEvidence.textContent = card.evidenceLabel || '待核验';
    fitPaperText();
  }
  function renderSize(card: EvidenceCard) {
    const scale = evidenceCardScale(card), maximum = evidenceCardScale({ ...card, scale: EVIDENCE_SCALE_MAX });
    const label = `${Math.round(scale * 100)}%`;
    sizeRange.max = String(maximum); sizeRange.value = String(scale);
    sizeRange.setAttribute('aria-valuetext', label); sizeValue.value = label;
    sizeDown.disabled = scale <= EVIDENCE_SCALE_MIN + 1e-6; sizeUp.disabled = scale >= maximum - 1e-6;
    sizeReset.disabled = Math.abs(scale - 1) < 1e-6;
  }
  function commitScale() {
    clearTimeout(scaleTimer); scaleTimer = undefined;
    if (!scaleDirty || disposed) return;
    const before = scaleBefore; scaleDirty = false; scaleBefore = null;
    publish(before || undefined, '调整纸片大小');
    if (storageAvailable) announce('纸片大小已保存。');
  }
  function resizeCurrent(value: number) {
    if (disposed || !Number.isFinite(value)) return;
    // Flush the text draft once before a resize gesture. Intermediate slider
    // values update the scene; persistence and directory work wait for release.
    if (!scaleDirty) flushEditor();
    const index = cards.findIndex(card => card.id === selected); if (index < 0) return;
    const previous = cards[index], scale = evidenceCardScale({ ...previous, scale: value });
    if (Math.abs(evidenceCardScale(previous) - scale) < 1e-6) { renderSize(previous); return; }
    if (!scaleDirty) scaleBefore = snapshot();
    promoteCard(previous.id);
    const updated = { ...cards[index], scale }, layout = evidenceCardLayout(updated, index);
    updated.position = { x: layout.x, y: layout.y }; cards[index] = updated; selected = updated.id;
    scaleDirty = true; renderUndo(); renderSize(updated);
    options.onChange(copyCards()); options.onSelect(selected);
    clearTimeout(scaleTimer);
    if (!scalePointerActive) scaleTimer = setTimeout(commitScale, 250);
  }
  function nudgeSize(delta: number) {
    const card = cards.find(value => value.id === selected); if (!card) return;
    resizeCurrent(Math.round((evidenceCardScale(card) + delta) * 100) / 100); commitScale();
  }
  function renderUndo() {
    const state = history.stats();
    undoButton.disabled = !state.undoCount && !scaleDirty; redoButton.disabled = !state.redoCount || scaleDirty;
    undoButton.title = state.undoLabel ? `撤销${state.undoLabel}（Ctrl / ⌘ Z）` : '暂无可撤销的操作';
    redoButton.title = state.redoLabel ? `重做${state.redoLabel}（Ctrl / ⌘ Shift Z）` : '暂无可重做的操作';
  }
  function renderLinks() {
    const card = cards.find(value => value.id === selected), previousTarget = linkTarget.value;
    linkTarget.replaceChildren(); linkList.replaceChildren();
    const linked = card ? connectedIds(card) : new Set<string>();
    connectionsSummary.textContent = `关联线索${linked.size ? ` · ${linked.size}` : ''}`;
    const candidates = cards.filter(value => card && value.id !== card.id && !linked.has(value.id));
    connectSelectedButton.disabled = !candidates.length;
    connectSelectedButton.hidden = sceneUnavailable();
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = candidates.length ? '选择一条线索' : '暂无可连接的线索';
    linkTarget.append(placeholder);
    for (const target of candidates) { const option = document.createElement('option'); option.value = target.id; option.textContent = target.title; linkTarget.append(option); }
    if (candidates.some(value => value.id === previousTarget)) linkTarget.value = previousTarget;
    linkTarget.disabled = !candidates.length; linkAdd.disabled = !linkTarget.value;
    for (const id of linked) {
      const target = cards.find(value => value.id === id); if (!target) continue;
      const row = element('li', 'link-row');
      const remove = element('button', 'link-remove', '断开'); remove.type = 'button'; remove.dataset.linkId = id;
      remove.setAttribute('aria-label', `断开与${target.title}的连线`);
      remove.addEventListener('click', () => {
        flushEditor(); const current = cards.find(value => value.id === selected), other = cards.find(value => value.id === resolveId(id));
        if (!current || !other) return;
        const before = snapshot(); setTool({ mode: 'select' });
        const currentId = promoteCard(current.id), targetId = promoteCard(resolveId(id));
        for (const value of cards) if (value.links) value.links = value.links.filter(link =>
          !(value.id === currentId && link === targetId || value.id === targetId && link === currentId));
        publish(before, '断开连线'); options.onSelect(selected); if (storageAvailable) announce('连线已断开，两条线索仍保留。');
      });
      row.append(element('span', 'link-title', target.title), remove); linkList.append(row);
    }
  }
  function flushEditor() {
    commitScale();
    cancelSave(); const index = cards.findIndex(card => card.id === selected); if (index < 0) return;
    const previous = cards[index], nextStage = Number(stage.value) as EvidenceCard['stage'];
    const changed = title.value.trim().slice(0, EVIDENCE_TITLE_LIMIT) || previous.title;
    const nextBody = body.value.slice(0, EVIDENCE_BODY_LIMIT), nextKind = kind.value as EvidenceCard['kind'];
    if (previous.title === changed && previous.body === nextBody && previous.stage === nextStage && previous.kind === nextKind) return;
    const before = snapshot(); promoteCard(previous.id);
    const updated: EvidenceCard = { ...cards[index], contentRevision: editorRevision, title: changed, body: nextBody, stage: nextStage, kind: nextKind };
    const layout = evidenceCardLayout(updated, index); updated.position = { x: layout.x, y: layout.y };
    cards[index] = updated; selected = updated.id; publish(before, '编辑线索', `text:${updated.id}`); options.onSelect(selected); renderSize(updated); renderPaper(updated);
    if (storageAvailable) announce(title.value.trim() ? '线索已保存到当前会话。' : '内容已保存，标题暂时保留原题。');
  }
  function select(id: string | null, openEditor = true) {
    if (disposed) return;
    const selectingCurrent = id !== null && id === selected; flushEditor();
    if (selectingCurrent) id = selected; else if (id) id = resolveId(id);
    selected = cards.some(card => card.id === id) ? id : null; history.seal();
    renderOverview(); renderEditor(); options.onSelect(selected);
    if (selected && openEditor) openTools(undefined, toolsOpen);
  }
  function addCard(card: EvidenceCard, position?: Point) {
    if (disposed) return false;
    flushEditor();
    if (cards.length >= EVIDENCE_CARD_CAPACITY) { announce(`${EVIDENCE_CARD_CAPACITY} 张纸片已满，请先移除一条线索。`); return false; }
    const before = snapshot();
    const placed = position ? { ...card, position: clampEvidencePosition(card, cards.length, position.x, position.y) } : positionNewCard(card);
    cards.push(placed); selected = card.id; setTool({ mode: 'select' });
    publish(before, '添加线索'); renderEditor(); options.onSelect(selected); openTools();
    if (active) title.focus({ preventScroll: true });
    if (storageAvailable) announce('线索已钉上白板，可继续填写内容。'); return true;
  }
  function beginPlacement(template: EvidenceTemplate) {
    if (cards.length >= EVIDENCE_CARD_CAPACITY) return;
    flushEditor(); selected = null; renderEditor(); options.onSelect(null);
    if (sceneUnavailable()) placeCard(template); else setTool({ mode: 'place', template });
  }
  function placeCard(template: EvidenceTemplate, position?: Point) {
    if (position && (!Number.isFinite(position.x) || !Number.isFinite(position.y))) return false;
    return addCard(createEvidenceTemplate(template), position);
  }
  function connectCards(fromId: string, toId: string) {
    if (disposed) return false;
    flushEditor(); fromId = resolveId(fromId); toId = resolveId(toId);
    const from = cards.find(card => card.id === fromId), to = cards.find(card => card.id === toId);
    if (!from || !to) { announce('线索已变化，请重新选择。'); return false; }
    if (fromId === toId || connectedIds(from).has(toId)) {
      announce(fromId === toId ? '请选择另一条线索。' : '这两条线索已经相连。'); return false;
    }
    const before = snapshot();
    setTool({ mode: 'select' });
    fromId = promoteCard(fromId); toId = promoteCard(resolveId(toId));
    const current = cards.find(card => card.id === fromId)!;
    current.links = [...(current.links || []), toId]; selected = toId;
    publish(before, '连接线索'); renderEditor(); options.onSelect(selected); openTools(undefined, true);
    if (storageAvailable) announce('两条线索已用红绳相连。'); return true;
  }
  function startConnection() {
    flushEditor();
    const card = cards.find(value => value.id === selected);
    if (sceneUnavailable()) { connections.open = true; linkTarget.focus(); return false; }
    if (cards.length < 2 || card && connectedIds(card).size >= cards.length - 1) {
      announce('当前没有可连接的另一条线索。'); return false;
    }
    openTools(undefined, true);
    setTool({ mode: 'connect', ...(card ? { fromId: card.id } : {}) }); return true;
  }
  function removeSelected() {
    flushEditor(); if (!selected) return false;
    setTool({ mode: 'select' }); const before = snapshot();
    cards = cards.filter(card => card.id !== selected); selected = null;
    publish(before, '移除线索'); renderEditor(); options.onSelect(null);
    announce('线索已移除，可撤销本次操作。'); return true;
  }
  function duplicateSelected() {
    flushEditor();
    const index = cards.findIndex(value => value.id === selected); if (index < 0) return false;
    if (cards.length >= EVIDENCE_CARD_CAPACITY) {
      announce(`${EVIDENCE_CARD_CAPACITY} 张纸片已满，请先移除一条线索。`); return false;
    }
    setTool({ mode: 'select' });
    const before = snapshot(), original = cards[index], layout = evidenceCardLayout(original, index);
    const duplicate: EvidenceCard = { ...original, id: createEvidenceId(), links: [],
      title: `${original.title.slice(0, EVIDENCE_TITLE_LIMIT - 3)} 副本` };
    // Place a small offset toward the center so a copy is reachable even at a board edge.
    duplicate.position = clampEvidencePosition(duplicate, cards.length,
      layout.x + (layout.x > 0 ? -.4 : .4), layout.y + (layout.y > 0 ? -.35 : .35));
    cards.push(duplicate); selected = duplicate.id;
    publish(before, '复制线索'); renderEditor(); options.onSelect(selected); openTools(undefined, true);
    announce('已复制纸片；原线索的连线保持原位。'); return true;
  }
  function resizeCard(id: string, value: number, x: number, y: number) {
    if (disposed || ![value, x, y].every(Number.isFinite)) return;
    flushEditor();
    const index = cards.findIndex(card => card.id === resolveId(id)); if (index < 0) return;
    const current = cards[index], scale = evidenceCardScale({ ...current, scale: value });
    const position = clampEvidencePosition({ ...current, scale }, index, x, y);
    if (Math.abs(evidenceCardScale(current) - scale) < 1e-6 &&
      Math.abs((current.position?.x ?? evidenceCardLayout(current, index).x) - position.x) < 1e-6 &&
      Math.abs((current.position?.y ?? evidenceCardLayout(current, index).y) - position.y) < 1e-6) return;
    const before = snapshot(); promoteCard(current.id);
    cards[index] = { ...cards[index], scale, position };
    publish(before, '调整纸片大小'); renderEditor(); options.onSelect(selected);
    if (storageAvailable) announce('纸片大小已保存。');
  }
  function handleShortcut(event: KeyboardEvent) {
    if (disposed || !active || event.defaultPrevented || event.isComposing || event.altKey) return false;
    const target = event.target;
    if (target instanceof HTMLElement && (target.matches('input,textarea,select') || target.isContentEditable)) return false;
    const key = event.key.toLowerCase(), command = event.ctrlKey || event.metaKey;
    if (command) {
      if (key === 'z') { if (event.shiftKey) redoLast(); else undoLast(); return true; }
      if (key === 'y' && event.ctrlKey && !event.shiftKey) { redoLast(); return true; }
      if (key === 'd' && !event.shiftKey && selected) { duplicateSelected(); return true; }
      return false;
    }
    if (event.shiftKey || event.repeat) return false;
    if ((key === 'delete' || key === 'backspace') && selected) return removeSelected();
    if (key === 'l') { startConnection(); return true; }
    if (key === 'n') { openTools(); beginPlacement('note'); return true; }
    if (key === 'v') { setTool({ mode: 'select' }); return true; }
    return false;
  }
  function setToolState(next: EvidenceBoardTool) {
    if (disposed) return;
    tool = next.mode === 'connect' && next.fromId ? { ...next, fromId: resolveId(next.fromId) } : { ...next };
    modeRow.hidden = tool.mode === 'select';
    modeText.textContent = tool.mode === 'place' ? `在板面点击，放下一张${TEMPLATE_NAMES[tool.template]}`
      : tool.mode === 'connect' && tool.fromId ? '再点一条线索，完成连线' : '先点选一条线索，作为连线起点';
    floating.dataset.tool = tool.mode;
    if (tool.mode !== 'select') { editorCollapsed = false; renderCollapsed(); }
    for (const button of templateButtons) button.setAttribute('aria-pressed', String(tool.mode === 'place' && tool.template === button.dataset.template));
    connectButton.setAttribute('aria-pressed', String(tool.mode === 'connect'));
    if (toolsOpen) positionTools();
  }
  function setTool(next: EvidenceBoardTool) { setToolState(next); options.onToolChange({ ...tool }); }
  function layoutBounds() {
    const rect = host.getBoundingClientRect(), rootRect = root?.getBoundingClientRect() || rect;
    const scale = rect.width / (host.clientWidth || rect.width) || 1;
    const visual = window.visualViewport;
    const left = Math.max(rect.left, rootRect.left, visual?.offsetLeft || 0), top = Math.max(rect.top, rootRect.top, visual?.offsetTop || 0);
    const right = Math.min(rect.right, rootRect.right, (visual?.offsetLeft || 0) + (visual?.width || innerWidth));
    const bottom = Math.min(rect.bottom, rootRect.bottom, (visual?.offsetTop || 0) + (visual?.height || innerHeight));
    return { rect, scale, left: (left - rect.left) / scale, top: (top - rect.top) / scale,
      right: (right - rect.left) / scale, bottom: (bottom - rect.top) / scale,
      width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  }
  function positionTools(anchor?: Point) {
    if (!toolsOpen || disposed) return;
    const bounds = layoutBounds(), narrow = host.dataset.layout === 'portrait' || bounds.width < 620;
    const safe = narrow ? 12 : 16, width = Math.min(selected && !editorCollapsed ? 404 : 316, Math.max(160, bounds.width - safe * 2));
    floating.classList.toggle('is-drawer', narrow);
    floating.style.width = `${narrow ? Math.max(160, bounds.width - 24) : width}px`;
    floating.style.maxHeight = `${Math.max(120, Math.min(narrow ? bounds.height * .68 : 740, bounds.height - safe * 2))}px`;
    floating.style.transform = `scale(${1 / bounds.scale})`;
    fitPaperText();
    const height = floating.offsetHeight / bounds.scale, actualWidth = floating.offsetWidth / bounds.scale;
    if (narrow) {
      floating.style.left = `${bounds.left + safe / bounds.scale}px`;
      floating.style.top = `${Math.max(bounds.top + safe / bounds.scale, bounds.bottom - height - safe / bounds.scale)}px`;
      reportViewportInset(Math.min(1, (floating.offsetHeight + safe) / bounds.height));
      return;
    }
    reportViewportInset(0);
    if (selected && selected !== positionedCard) {
      const cardBounds = options.getCardBounds?.(selected);
      if (cardBounds) {
        const gap = 22 / bounds.scale;
        const right = cardBounds.right + gap, left = cardBounds.left - actualWidth - gap;
        toolPosition = { x: right + actualWidth <= bounds.right ? right : left >= bounds.left ? left : bounds.right - actualWidth - gap,
          y: cardBounds.top - 50 / bounds.scale };
      }
      positionedCard = selected;
    }
    if (!toolPosition) toolPosition = anchor ? { x: anchor.x + 20 / bounds.scale, y: anchor.y - height - 20 / bounds.scale }
      : { x: bounds.right - actualWidth - 24 / bounds.scale, y: bounds.top + 96 / bounds.scale };
    toolPosition.x = Math.max(bounds.left + safe / bounds.scale, Math.min(bounds.right - actualWidth - safe / bounds.scale, toolPosition.x));
    toolPosition.y = Math.max(bounds.top + safe / bounds.scale, Math.min(bounds.bottom - height - safe / bounds.scale, toolPosition.y));
    floating.style.left = `${toolPosition.x}px`; floating.style.top = `${toolPosition.y}px`;
  }
  function reportViewportInset(value: number) {
    if (Math.abs(viewportInset - value) < .0001) return;
    viewportInset = value; options.onViewportInset?.(value);
  }
  function renderCollapsed() {
    const card = cards.find(value => value.id === selected);
    floating.classList.toggle('is-collapsed', editorCollapsed);
    headingText.querySelector('span')!.textContent = card ? 'EVIDENCE / 线索纸片' : 'BOARD / 调查板';
    headingText.querySelector('strong')!.textContent = editorCollapsed && card ? card.title : card ? '在纸片上编辑' : '整理线索';
    headingText.querySelector('strong')!.title = editorCollapsed && card ? card.title : '';
    collapseButton.textContent = editorCollapsed ? '展开' : '收起';
    collapseButton.setAttribute('aria-label', editorCollapsed ? '展开整理工具' : '收起工具，保留线索选中');
    collapseButton.setAttribute('aria-expanded', String(!editorCollapsed));
  }
  function minimizeTools() {
    if (!toolsOpen || disposed) return;
    flushEditor(); setTool({ mode: 'select' }); stopWindowDrag();
    if (floating.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    editorCollapsed = true; renderCollapsed(); positionTools();
  }
  function expandTools() { editorCollapsed = false; renderCollapsed(); positionTools(); }
  function openTools(position?: Point, preserveCollapsed = false) {
    if (disposed || !active) return;
    const wasOpen = toolsOpen;
    if (!preserveCollapsed) { editorCollapsed = false; renderCollapsed(); }
    toolsOpen = true; floating.hidden = false; directoryOpen = false; renderDirectoryVisibility();
    positionTools(position); if (!wasOpen) options.onToolsOpen?.(true);
  }
  function stopWindowDrag() {
    const previous = windowDrag; windowDrag = null; floating.classList.remove('is-dragging');
    if (previous && heading.hasPointerCapture(previous.id)) heading.releasePointerCapture(previous.id);
  }
  function closeTools() {
    if (disposed) return;
    flushEditor(); stopWindowDrag(); setTool({ mode: 'select' });
    positionedCard = null;
    const wasOpen = toolsOpen; toolsOpen = false; editorCollapsed = false; floating.hidden = true;
    reportViewportInset(0);
    if (floating.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    selected = null; renderOverview(); renderEditor(); options.onSelect(null);
    if (wasOpen) options.onToolsOpen?.(false);
  }
  function handleEscape() {
    if (!active || disposed) return false;
    if (tool.mode !== 'select') { setTool({ mode: 'select' }); return true; }
    if (toolsOpen) { closeTools(); return true; }
    return false;
  }
  heading.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target instanceof Element && event.target.closest('button') || floating.classList.contains('is-drawer')) return;
    const bounds = layoutBounds(); event.preventDefault();
    windowDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, start: { ...(toolPosition || { x: floating.offsetLeft, y: floating.offsetTop }) }, scale: bounds.scale };
    heading.setPointerCapture(event.pointerId); floating.classList.add('is-dragging');
  }, { signal: events.signal });
  heading.addEventListener('pointermove', event => {
    if (!windowDrag || event.pointerId !== windowDrag.id) return;
    toolPosition = { x: windowDrag.start.x + (event.clientX - windowDrag.x) / windowDrag.scale,
      y: windowDrag.start.y + (event.clientY - windowDrag.y) / windowDrag.scale }; positionTools();
  }, { signal: events.signal });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) heading.addEventListener(name, stopWindowDrag, { signal: events.signal });
  window.addEventListener('blur', stopWindowDrag, { signal: events.signal });
  editor.addEventListener('submit', event => { event.preventDefault(); flushEditor(); if (storageAvailable && title.value.trim()) announce('线索已保存到当前会话。'); }, { signal: events.signal });
  for (const input of [title, body]) input.addEventListener('input', () => { fitPaperText(); cancelSave(); saveTimer = setTimeout(flushEditor, 300); }, { signal: events.signal });
  for (const input of [stage, kind]) input.addEventListener('change', flushEditor, { signal: events.signal });
  title.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); body.focus(); } }, { signal: events.signal });
  sizeRange.addEventListener('pointerdown', () => { scalePointerActive = true; }, { signal: events.signal });
  const releaseSize = () => { scalePointerActive = false; commitScale(); };
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    sizeRange.addEventListener(name, releaseSize, { signal: events.signal });
  }
  window.addEventListener('blur', releaseSize, { signal: events.signal });
  sizeRange.addEventListener('input', () => resizeCurrent(Number(sizeRange.value)), { signal: events.signal });
  sizeRange.addEventListener('change', commitScale, { signal: events.signal });
  sizeRange.addEventListener('blur', releaseSize, { signal: events.signal });
  window.addEventListener('pagehide', flushEditor, { signal: events.signal });
  const sceneObserver = new MutationObserver(() => { renderDirectoryVisibility(); positionTools(); });
  if (root) sceneObserver.observe(root, { attributes: true, attributeFilter: ['class'] });
  sceneObserver.observe(host, { attributes: true, attributeFilter: ['style', 'data-layout'] });
  const resizeObserver = new ResizeObserver(() => { if (windowDrag) stopWindowDrag(); positionTools(); });
  resizeObserver.observe(host); resizeObserver.observe(floating);
  window.visualViewport?.addEventListener('resize', () => positionTools(), { signal: events.signal });
  window.visualViewport?.addEventListener('scroll', () => positionTools(), { signal: events.signal });
  load(); setToolState({ mode: 'select' });
  return {
    setActive(value: boolean) {
      if (disposed || active === value) return;
      if (!value) closeTools(); active = value; panel.hidden = !value;
      if (value && selected) openTools();
    },
    setSession(id: string) {
      if (disposed || sessionId === id) return;
      closeTools(); sessionId = id; selected = null; directoryOpen = false; history.clear(); promotedIds.clear(); load();
    },
    select, openTools, closeTools, handleEscape, handleShortcut, minimizeTools, setToolState, placeCard, connectCards, resizeCard,
    toggleTools(position?: Point) {
      if (toolsOpen && editorCollapsed) expandTools();
      else if (toolsOpen) closeTools(); else openTools(position);
    },
    addSource(source: { id: string; title: string; excerpt: string }) {
      if (disposed) return;
      const previous = cards.find(card => card.sourceId === source.id);
      if (previous) { select(previous.id); announce('这份资料已经在证据板上。'); return; }
      addCard({ ...createEvidenceTemplate('source'), title: source.title.trim().slice(0, EVIDENCE_TITLE_LIMIT) || '资料摘录',
        body: source.excerpt.slice(0, EVIDENCE_BODY_LIMIT), sourceId: source.id.slice(0, 1024), sourceTitle: source.title.slice(0, 512) });
    },
    moveCard(id: string, x: number, y: number) {
      if (disposed || !Number.isFinite(x) || !Number.isFinite(y)) return;
      flushEditor(); const index = cards.findIndex(card => card.id === resolveId(id)); if (index < 0) return;
      const card = cards[index], position = clampEvidencePosition(card, index, x, y);
      if (card.position?.x === position.x && card.position?.y === position.y) return;
      const before = snapshot(); promoteCard(card.id); card.position = position;
      publish(before, '移动线索'); options.onSelect(selected); if (storageAvailable) announce('纸片位置已保存。');
    },
    replaceCards(next: EvidenceCard[], reset = false) {
      cards = cloneCards(next);
      const editing = cards.find(card => card.id === selected);
      if (editing && title.value === editing.title && body.value === editing.body) editorRevision = editing.contentRevision;
      if (reset) { history.clear(); selected = null; closeTools(); }
      if (selected && !cards.some(c => c.id === selected)) selected = null;
      renderOverview(); renderLinks(); renderUndo();
      // Preserve an in-progress form draft when a background receipt arrives.
      if (!floating.contains(document.activeElement)) renderEditor();
    },
    remapIds(mapping: Record<string,string>, revisions: Record<string, { content_revision: number; layout_revision: number }> = {}) {
      history.remapIds(mapping, revisions); cards = cards.map(card => {
        const id = mapping[card.id] || card.id, revision = id !== card.id ? revisions[id] : undefined;
        // A copied card inherits the original revision until its own creation is
        // acknowledged. Its open draft and undo history now belong to the new ID.
        if (revision && selected === card.id) editorRevision = revision.content_revision;
        return { ...card, id, ...(revision ? { contentRevision: revision.content_revision, layoutRevision: revision.layout_revision } : {}), links: card.links?.map(id => mapping[id] || id) };
      });
      if (selected) selected = mapping[selected] || selected;
    },
    getCards: copyCards,
    dispose() {
      if (disposed) return;
      flushEditor(); stopWindowDrag(); disposed = true; cancelSave(); events.abort(); sceneObserver.disconnect(); resizeObserver.disconnect(); panel.remove(); floating.remove();
    },
    stats() { return { cards: cards.length, byStage: EVIDENCE_STAGES.map((_, index) => cards.filter(card => card.stage === index).length),
      selected, active, links: cards.reduce((sum, card) => sum + (card.links?.length || 0), 0),
      examples: cards.filter(isPreviewCard).length, storageAvailable, toolsOpen, editorCollapsed, viewportInset, tool: { ...tool },
      canUndo: Boolean(history.stats().undoCount) || scaleDirty, canRedo: Boolean(history.stats().redoCount),
      undoCount: history.stats().undoCount, redoCount: history.stats().redoCount }; },
  };
}
