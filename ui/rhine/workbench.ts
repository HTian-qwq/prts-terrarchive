import { manualSearchControls, mountManualSearch } from './manual-search';
import type { ReadingObject } from './reading-object';
import { WORKBENCH_QUALITY, createRhineScene } from './scene';
import { ArchiveNavigationLimiter } from './archive-navigation-limit';
import { brandHeading } from './original/brand';
import { captureReadingOrigin, restoreReadingOrigin, readingOriginLabel, type ReadingOrigin, type ReadingOriginKind } from './reading-origin';
import { ARCHIVE_LANES, SHELF_PAGE_SIZE, belongsOnShelf, archiveLane, mergeSourcesInOrder, sourceIdentity, sourceIndex } from './catalogue';
import { shelfSlot } from './shelf-layout';
import { viewportLayout } from './original/viewport-layout';
import { ModelViewer } from './original/model-viewer';
// TEMPORARY RHINE PROFILER
import { mountTemporaryPerformancePanel } from './temporary-performance-panel';
import { renderSourceMarkdown, renderReportMarkdown, type ReportHeading } from './report-markdown';
import type { EvidenceBoardTool } from './evidence-board-model';
import { mountEvidenceBoardPanel } from './evidence-board-panel';
import { mountInvestigationBoard, type InvestigationContext } from './investigation-board';
import { readerStartLine, resolveReadingSource } from './source-reading';
import { createArchiveRack } from './archive-rack';
import { boardPlaneTransform } from './board-plane-transform';
import { mountSceneEdgeNavigation } from './scene-edge-navigation';
import { SurfaceTransition } from './original/ui-transitions';
import { investigationActivity, latestReadFocus, ReadCardMotion } from './tool-activity';
import { SnapshotUpdateGate } from './snapshot-update-gate';
import { createRollingNumber, createRollingText } from '@kitlangton/rolling-number';
import '@kitlangton/rolling-number/styles.css';
import type { ArchiveSource, InvestigationSnapshot, RhineHostState, RhineLocation, RhineOptions, RhineScene, RhineWorkbench, BoardAnchorFrame } from './types';

type Location = RhineLocation;
type ReaderLine = { line_number: number; text: string; speaker_raw?: string; source_ref?: string };
type Extract = { id: string; source: ArchiveSource; text: string; start?: number; end?: number };
type Persisted = { sources: ArchiveSource[]; extracts: Extract[] };
const PAGE_SIZE = 6;
const MAX_SAVED = 150;
const MAX_EXTRACTS = 24;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function button(text: string, className: string, action: () => void, label?: string) {
  const element = node('button', className, text);
  element.type = 'button';
  if (label) element.setAttribute('aria-label', label);
  element.addEventListener('click', action);
  return element;
}
function origin(source: ArchiveSource) { return source.origin === 'cloud' ? '云端' : source.origin === 'web' ? '外部来源' : '本地资料'; }
function kind(source: ArchiveSource) {
  const labels: Record<string, string> = {
    story: '剧情原文', original_story: '剧情原文', character_profile: '角色档案',
    character_module: '模组文案', character_voice: '角色语音', character_bundle: '角色资料集',
    character_story: '角色故事', operator_record: '干员密录', character_wiki: '角色 Wiki',
    story_wiki: '剧情 Wiki', character_activity_wiki: '角色活动资料', reviewed_wiki: '审校 Wiki',
    knowledge: '审校资料', wiki: 'Wiki', archive: '官方档案库', timeline: '时间线',
    cloud: '云端资料', web: '外部资料', activity: '活动资料', character: '角色资料',
    character_skin: '时装文案', terra_journey: '大地巡旅', entity_profile: '实体资料', reference: '引用资料',
  };
  return labels[source.kind] || '资料';
}
function state(source: ArchiveSource) { return source.state === 'cited' ? 'Agent 已引用' : source.state === 'read' ? 'Agent 已读' : '已找到'; }
function matchesSource(source: ArchiveSource, query: string) {
  return !query || `${source.title} ${kind(source)} ${origin(source)} ${source.excerpt}`.toLocaleLowerCase().includes(query);
}
function updateSourceChoice(row: HTMLButtonElement, source: ArchiveSource, number: number, context: string) {
  if (!row.children.length) row.append(node('span', 'rhine-choice-number'), node('span', 'rhine-choice-copy'), node('span', 'rhine-choice-mark', '↗'));
  const copy = row.querySelector('.rhine-choice-copy')!;
  if (!copy.children.length) copy.append(node('strong'), node('small'));
  row.querySelector('.rhine-choice-number')!.textContent = String(number).padStart(3, '0');
  copy.querySelector('strong')!.textContent = source.title;
  copy.querySelector('small')!.textContent = `${context} · ${kind(source)} · ${state(source)}${source.saved ? ' · 已收藏' : ''}`;
  row.dataset.state = source.state;
  row.title = source.title;
  row.setAttribute('aria-label', `选择 ${source.title}，${context}，${state(source)}`);
}
function sourceKey(source: ArchiveSource) { return sourceIdentity(source); }
function sameSource(a: ArchiveSource, b: ArchiveSource) {
  return (a.dataVersion || '') === (b.dataVersion || '') && (a.id === b.id ||
    (['documentId', 'documentUid', 'sourceRef'] as const).some(key => a[key] && a[key] === b[key]));
}
function hasLocator(source: ArchiveSource) { return Boolean(source.documentId || source.sourceRef); }
function plainError(error: unknown) { return error instanceof Error ? error.message : String(error || '请求未完成'); }

/** A DOM reading workspace over a separately scheduled Three.js archive scene. */
export function mountRhineWorkbench(host: HTMLElement, options: RhineOptions): RhineWorkbench {
  let snapshot = options.snapshot;
  const snapshotGate = new SnapshotUpdateGate(snapshot);
  let activitySources: ArchiveSource[] | undefined;
  let logSourcesSignature = '';
  let logRecordsSignature = '';
  let disposed = false;
  let active = true;
  let location: Location = new URLSearchParams(window.location.search).get('rhineView') === 'board' ? 'board' : 'archive';
  let boardFullscreen = false;
  let scene: RhineScene | undefined;
  let synchronizingScene = false;
  let viewer: ModelViewer | undefined;
  let viewerFrame = 0;
  let edgeNavigation: ReturnType<typeof mountSceneEdgeNavigation> | undefined;
  // A single rendering profile; legacy per-browser quality choices no longer apply.
  const quality = { ...WORKBENCH_QUALITY };
  const navigationLimiter = new ArchiveNavigationLimiter();
  let manualSources: ArchiveSource[] = [];
  let extracts: Extract[] = [];
  let sources: ArchiveSource[] = [];
  let discoveredSources: ArchiveSource[] = [];
  let results: ArchiveSource[] = [];
  let resultsPage = 0;
  let deskPage = 0;
  let searchCursor: unknown;
  let searchDataVersion: string | undefined;
  let searchQuery = '';
  let searchBusy = false;
  let searchError = '';
  let searchWarning = '';
  let searchRequest: Record<string, unknown> = {};
  let searchMode: 'local' | 'cloud' = 'local';
  let searchController: AbortController | undefined;
  let readController: AbortController | undefined;
  let readerAnnotationSignature = '', readerChipsSignature = '';
  let readerPositionFrame = 0;
  let readerPosition: { row?: HTMLElement; source: ArchiveSource; controller?: AbortController; finish?: (succeeded: boolean, asynchronous?: boolean) => void } | undefined;
  const readerMeasure = <T>(part: string, task: () => T, detail: Record<string, unknown> = {}) => {
    const finish = performancePanel.capture.beginUiWork(`reader-${part}`, detail);
    try { return task(); } finally { finish?.(); }
  };
  function cancelReaderPosition() {
    cancelAnimationFrame(readerPositionFrame); readerPositionFrame = 0;
    readerPosition?.finish?.(false, true); readerPosition = undefined;
  }
  function scheduleReaderPosition() {
    if (!readerPosition || readerPositionFrame || disposed || !active || root.hidden || reader.hidden) return;
    readerPositionFrame = requestAnimationFrame(() => {
      readerPositionFrame = 0;
      const pending = readerPosition;
      if (!pending || disposed || pending.source !== selectedSource || pending.controller && (pending.controller !== readController || pending.controller.signal.aborted) || pending.row && !pending.row.isConnected) {
        cancelReaderPosition(); return;
      }
      if (!active || root.hidden || reader.hidden) return;
      // Read the complete geometry first. Correct for the panel's visual scale.
      const top = readerMeasure('position-read', () => {
        if (!pending.row) return 0;
        const bodyRect = readerBody.getBoundingClientRect(), rowRect = pending.row.getBoundingClientRect();
        const scale = bodyRect.height / (readerBody.offsetHeight || bodyRect.height || 1);
        return Math.max(0, readerBody.scrollTop + (rowRect.top - bodyRect.top) / (scale || 1)
          - readerBody.clientTop - Math.min(50, readerBody.clientHeight * 0.2));
      });
      readerMeasure('position-write', () => { readerBody.scrollTop = top; });
      pending.finish?.(true, true); readerPosition = undefined;
    });
  }

  let selectedSource: ArchiveSource | undefined;
  let readerCursor: string | undefined;
  let readerVersion: string | undefined;
  let readerBusy = false;
  let sourceSignature = '';
  let toastTimeout: number | undefined;
  let lastFocus: HTMLElement | null = null;
  let extracting = false;
  let readerReturn: ReadingOriginKind | null = null;
  let readerOrigin: ReadingOrigin | null = null;
  let originRestoreFrame = 0;
  let reportTrigger: HTMLElement | null = null;
  let reportText = '';
  let reportSourceSignature = '';
  let reportTocSignature = '';
  let reportHeadings: ReportHeading[] = [];
  let reportRenderTimer: number | undefined;
  let reportPositionFrame = 0;
  let reportScrollTop = 0;
  let reportScrollPending: number | 'end' | undefined;
  let reportHeadingNodes: { heading: ReportHeading; element: HTMLElement; link: HTMLButtonElement }[] = [];
  let reportViewedKey = '';
  let reportInvestigationKey = '';
  let lastCompletedKey = '';
  let hasRenderedStatus = false;
  let completionTimer: number | undefined;
  let visibleRecordCount = 20;
  let archiveSources: ArchiveSource[] = [];
  let archiveSelected: string | null = null;
  let archiveLaneIndex = 0;
  let shelfSelected: string | null = null;
  let catalogueLoaded = false;
  let resultFilter = -1;
  let detailWasOpen = false;
  let pendingDetailFocus: HTMLElement | null = null;
  let detailVisibility = 0;
  let navigationHint: { axis: 'row' | 'lane'; direction: number } | undefined;
  let hostState: RhineHostState | undefined = options.host?.getState();
  let hostActionBusy = false;
  let hostActionError = '';
  let hostRetry: (() => Promise<void>) | undefined;
  let hostTrigger: HTMLElement | null = null;
  let hostSessionId = hostState?.sessionId;
  let hostMode = hostState?.mode;
  let hostModel = hostState?.model;
  let modeSignature = '';
  let modelSignature = '';
  let sessionsSignature = '';
  let unsubscribeHost: (() => void) | undefined;
  const uiUpdates = { status: 0, host: 0, selectionSkipped: 0, ticksCreated: 0, sourceMerges: 0, sourceMergeSkipped: 0, statusSkipped: 0 };
  const archiveTickNodes = new Map<string, HTMLButtonElement>();
  const shelfChoiceNodes = new Map<string, HTMLButtonElement>();
  let archiveSelectionSignature = '';
  let hostPaintSignature = '';
  const columnMemory: (string | null)[] = ARCHIVE_LANES.map(() => null);
  const recordNodes = new Map<string, HTMLDetailsElement>();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const root = node('div', 'rhine-workbench');
  root.setAttribute('aria-label', '莱茵生命资料浏览器');
  root.innerHTML = `
    <div class="rhine-original-stage" data-mode="archive" data-boot="done">
      <div id="three-scene" class="three-scene rhine-scene"></div>
      <div class="scene-atmosphere archive-atmosphere"></div>
      <header class="brand">${brandHeading}</header>
      <nav class="system-nav" aria-label="系统导航">
        <div class="rhine-session-controls" aria-label="对话操作" hidden><button type="button" class="rhine-session-new">＋ 新建对话</button><button type="button" class="rhine-session-history" aria-label="切换历史会话" aria-haspopup="dialog">会话 ⌄</button></div>
        <button type="button" class="rhine-nav-board" aria-label="前往证据板">EVIDENCE BOARD <span class="rhine-board-count">00</span></button>
        <button class="rhine-nav-index" data-action="search" aria-label="档案索引"><span class="nav-glyph">⌕</span> ARCHIVE INDEX <span class="key">/</span></button>
        <button class="rhine-nav-rack" aria-label="查看调查档案架">EVIDENCE RACK <span class="rhine-rack-count">00</span></button>
        <button class="rhine-nav-extracts" data-action="saved" aria-label="查看收藏与摘录">＋ 摘录 <span id="saved-count">00</span></button>
        <button class="settings-button rhine-nav-log" data-action="settings" aria-label="调查记录"><span class="settings-glyph" aria-hidden="true">◷</span><span class="settings-label">调查记录</span></button>
      </nav>
      <div class="rhine-board-toolbar" role="group" aria-label="白板视图标签" hidden>
        <span class="rhine-board-view-caption" aria-hidden="true">VIEW</span>
        <div class="rhine-board-magnet"><button type="button" class="rhine-board-zoom-out" aria-label="缩小线索板">−</button><button type="button" class="rhine-board-reset" aria-label="复位线索板视图" title="点击恢复全貌">100%</button><button type="button" class="rhine-board-zoom-in" aria-label="放大线索板">＋</button></div>
        <div class="rhine-board-magnet"><button type="button" class="rhine-board-tools-fallback" hidden>工具</button><button type="button" class="rhine-board-fullscreen-toggle" aria-pressed="false" aria-label="全屏线索板" aria-controls="three-scene"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4"/></svg><span class="rhine-board-fullscreen-label">全屏</span></button></div>
      </div>
      <button type="button" class="rhine-board-chalk-hit" aria-label="粉笔盒：打开整理工具" title="点击粉笔盒，整理线索" aria-expanded="false" hidden></button>
      <div class="rhine-board-tool-status" hidden><span role="status" aria-live="polite"></span><button type="button" class="rhine-board-tool-cancel">取消 ×</button></div>
      <section id="archive-ui" class="archive-ui" aria-label="档案选择">
        <div class="archive-callout rhine-investigation-brief">
          <div class="eyebrow"><span class="rhine-case-label">INVESTIGATION / READY</span><span>／</span><span class="rhine-case-phase">等待调查</span></div>
          <h1 class="rhine-case-question">从一个问题，开始调查。</h1>
          <button type="button" class="rhine-case-operation" aria-label="查看 Agent 工作详情" aria-haspopup="dialog"><span class="rhine-operation-meter" aria-hidden="true"><i></i><i></i><i></i></span><span class="rhine-operation-copy"><strong class="rhine-case-tool" role="status" aria-live="polite">等待开始调查</strong><span class="rhine-case-operation-text">输入问题，或自由检索和翻阅原文</span></span><span class="rhine-operation-more">查看过程 <b>↗</b></span></button>
          <div class="callout-rule"><i></i></div>
          <div class="rhine-case-counts" aria-label="Agent 资料状态"><span>已查得 <b class="rhine-found-count">00</b></span><span>已读 <b class="rhine-read-count">00</b></span><span>已引用 <b class="rhine-cited-count">00</b></span></div>
          <section class="rhine-tool-feed" aria-label="实时工具调用" hidden><div class="rhine-tool-feed-heading"><span>TOOL ACTIVITY / 调用记录</span><span class="rhine-tool-total"></span></div><div class="rhine-tool-feed-list"></div></section>
          <button type="button" class="rhine-report-open" hidden><span class="rhine-report-open-copy"><small class="rhine-report-open-kicker">RESEARCH REPORT</small><strong>阅读调查报告</strong><span class="rhine-report-open-meta"></span></span><b aria-hidden="true">↗</b></button>
          <div class="rhine-follow-controls"><span class="rhine-follow-status" role="status">跟随 Agent 查阅</span><button type="button" class="rhine-follow-toggle" aria-pressed="true">暂停跟随</button></div>
          <div class="rhine-current-source"><div class="rhine-source-kicker"><span id="selected-id">S-<span id="selected-code">000</span></span><span id="archive-category">角色档案</span><span id="selected-clearance">SOURCE / READY</span></div><button class="file-title" data-action="open"><span id="selected-title">浏览资料库</span><span class="file-open">↗</span></button><p class="rhine-selected-excerpt">搜索原文，收藏线索，或把问题交给 Agent。</p><label class="rhine-evidence-target"><span>证据盒归属</span><select aria-label="证据盒归属" disabled><option>正在读取调查板…</option></select></label><div class="rhine-priority-actions"><button class="read-file" data-action="open">OPEN SOURCE <span>→</span></button><button type="button" class="rhine-array-stage">＋ 放入重点证据盒</button></div></div>
        </div>
        <div class="archive-counter"><span class="tiny-label">SOURCE / SELECT</span><div><span id="selected-number">00</span><i>/</i><span class="count-total">00</span></div></div>
        <button type="button" class="rhine-array-toggle" aria-controls="rhine-array-list" aria-expanded="false"><span aria-hidden="true">＋</span> 展开资料列表 <small class="rhine-array-toggle-count"></small></button>
        <div id="rhine-array-list" class="archive-navigation" aria-label="检索阵列资料选择" hidden inert>
          <div class="rhine-choice-heading"><span>SOURCE DIRECTORY / 资料选择</span><button type="button" class="rhine-array-directory">资料索引 ↗</button><button type="button" class="rhine-array-read" data-action="open">读取所选 ↗</button><button type="button" class="rhine-array-collapse" aria-label="收起资料列表">收起 ×</button></div>
          <div class="column-navigation"><button data-action="column-prev" aria-label="上一列">←</button><div><span id="column-number">COLLECTION <span id="column-index">01</span> / 05</span><strong id="column-name">角色档案</strong></div><button data-action="column-next" aria-label="下一列">→</button></div>
          <div id="file-ticks" class="file-ticks" role="group" aria-label="当前分类的资料标题"></div>
          <div class="rhine-choice-footer"><button data-action="prev" aria-label="上一页档案">← 上一页</button><span class="rhine-array-range"></span><button data-action="next" aria-label="下一页档案">下一页 →</button></div>
        </div>
        <div class="archive-hint"><kbd>←</kbd> <kbd>→</kbd> 切换列 <span>／</span> <kbd>↑</kbd> <kbd>↓</kbd> 前后档案 <span>／</span> <kbd>ENTER</kbd> 读取</div>
      </section>
      <section id="detail-ui" class="detail-ui" aria-label="档案内容" hidden>
        <button class="back-button" data-action="back">← <span>ARCHIVE OVERVIEW</span><small>ESC</small></button>
        <div class="object-caption"><span id="object-id">S-001</span><div>RESEARCH ARCHIVE</div><small>DOCUMENT / OPEN <span>↔</span></small><button class="viewer-open" data-action="inspect">360° 查看文档模型 <span>↗</span></button></div>
        <article class="rhine-reader detail-content" aria-label="资料阅读器" hidden>
          <div class="detail-kicker"><span>DOCUMENT / READING ROOM</span><button type="button" class="rhine-reader-back-report" hidden>← 返回报告</button><button type="button" class="rhine-close-reader" aria-label="关闭资料">CLOSE ×</button></div>
          <h2 class="rhine-reader-title" tabindex="-1"></h2>
          <div class="rhine-reader-meta detail-title-cn"></div><div class="detail-rule"></div>
          <div class="rhine-reader-provenance"></div>
          <label class="rhine-evidence-target"><span>证据盒归属</span><select aria-label="证据盒归属" disabled><option>正在读取调查板…</option></select></label><div class="rhine-reader-actions"><button type="button" class="rhine-read-save">＋ 收藏到档案架</button><button type="button" class="rhine-read-pin">＋ 放入重点证据盒</button><button type="button" class="rhine-extract-selection">摘录选中文字 ↗</button></div>
          <div class="rhine-reader-ranges" aria-label="原文相关位置"></div>
          <div class="rhine-reader-body" tabindex="0" aria-label="资料正文"></div>
          <div class="rhine-reader-footer"><span class="rhine-reader-status" role="status"></span><button type="button" class="rhine-reader-more" hidden>继续读取 ↓</button></div>
        </article>
      </section>
      <section class="rhine-desk-panel" aria-label="本次调查档案架" hidden>
        <div class="tiny-label">EVIDENCE RACK / <span class="rhine-desk-count">00</span></div><h2>调查档案架</h2><p class="rhine-rack-intro">选择标题定位档案，抽取后阅读原文。</p><label class="rhine-shelf-search"><span aria-hidden="true">⌕</span><input class="rhine-shelf-filter" type="search" placeholder="在全部档案中筛选标题、内容…" aria-label="筛选全部档案"/><button type="button" class="rhine-shelf-clear" hidden aria-label="清除档案筛选">×</button></label><div class="rhine-rack-range" role="status"></div>
        <div class="rhine-shelf-current"><span class="rhine-shelf-number">S-000</span><h3 class="rhine-shelf-title">等待第一份资料</h3><div class="rhine-shelf-meta"></div><p class="rhine-shelf-excerpt">Agent 实际读过或你主动收藏的资料，留在这里供回查。</p><label class="rhine-evidence-target"><span>证据盒归属</span><select aria-label="证据盒归属" disabled><option>正在读取调查板…</option></select></label><div class="rhine-priority-actions"><button type="button" class="rhine-shelf-open">抽取阅读 <span>↗</span></button><button type="button" class="rhine-shelf-stage">＋ 放入重点证据盒</button></div></div>
        <div class="rhine-shelf-navigation"><button type="button" class="rhine-shelf-prev" aria-label="翻阅上一份资料">←</button><div class="rhine-desk-list" role="group" aria-label="档案标题选择列表"></div><button type="button" class="rhine-shelf-next" aria-label="翻阅下一份资料">→</button></div><div class="rhine-desk-pagination"></div><button type="button" class="rhine-rack-directory">全部资料目录 <span>↗</span></button>
        <div class="rhine-rack-legend"><span data-state="found">查得</span><span data-state="read">Agent 已读</span><span data-state="cited">已引用</span><span data-state="saved">手动收藏</span></div><button type="button" class="rhine-shelf-report" hidden>调查报告 <span>↗</span></button>
      </section>
      <button type="button" class="rhine-location-button"><span class="rhine-location-title">调查档案架 <b>→</b></span><span class="rhine-location-count">00</span></button>
      <nav class="rhine-zone-nav" aria-label="资料馆场景区域">
        <button type="button" data-zone="archive"><small>01</small><span>检索阵列</span></button>
        <i aria-hidden="true"></i><button type="button" data-zone="board"><small>02</small><span>证据板</span></button>
        <i aria-hidden="true"></i><button type="button" data-zone="desk"><small>03</small><span>档案收录架</span></button>
      </nav>
      <form class="rhine-agent-form" aria-label="向 Agent 提问">
        <div class="rhine-agent-heading"><label for="rhine-agent-question">ASK THE ARCHIVE</label><div class="rhine-agent-settings" aria-label="调查配置" hidden><button type="button" class="rhine-session-mode" aria-haspopup="dialog"><small>MODE</small><span>选择模式</span><i aria-hidden="true">⌄</i></button><button type="button" class="rhine-session-model" aria-haspopup="dialog"><small>MODEL</small><span>选择模型</span><i aria-hidden="true">⌄</i></button></div><span class="rhine-agent-availability">AGENT / READY</span></div>
        <div class="rhine-agent-field"><span aria-hidden="true">⌕</span><input id="rhine-agent-question" type="text" autocomplete="off" placeholder="输入问题，交给 Agent 调查…" maxlength="3000" aria-label="调查问题"/><button type="button" class="rhine-agent-cancel" hidden aria-label="停止当前任务">■ 停止</button><button type="submit" class="rhine-agent-submit" aria-label="提交调查问题">SEND <span>↗</span></button></div>
        <div class="rhine-agent-board-context" title="查看或切换调查板不会改变 Agent 的工作板"></div><div class="rhine-agent-footer"><span class="rhine-agent-hint">候选资料在检索阵列；已读与收藏资料入架。</span><button type="button" class="rhine-manual-search">检索资料 <span>→</span></button></div>
        <button type="button" class="rhine-session-alert" hidden aria-haspopup="dialog"><span>会话设置暂不可用</span><b>查看详情 ↗</b></button>
      </form>
      <section class="rhine-activity" aria-label="Agent 检索状态" hidden><span class="rhine-status-dot"></span><span class="rhine-status-title" role="status"></span><span class="rhine-activity-query"></span><span class="rhine-activity-detail"></span></section>
      <div class="powered">POWERED BY <b>RHINE LAB</b><i></i></div>
      <footer class="system-footer"><span><i class="status-light"></i> RESEARCH SESSION <span class="rhine-session-id"></span></span><span>PRTS / CORPUS CONNECTION <i>／</i> <span id="clock">00:00:00</span></span><button class="rhine-nav-close">返回对话 ↗</button><span class="rhine-performance" hidden></span></footer>
      <section class="rhine-results modal-backdrop" aria-label="搜索结果" hidden>
        <div class="terminal-modal rhine-index-modal"><div class="modal-top"><span>RHINE LAB / ARCHIVE DIRECTORY</span><button type="button" class="rhine-close-results" aria-label="关闭档案索引">CLOSE <span>×</span></button></div><h2>资料库检索<small>ARCHIVE INDEX</small></h2>
          <form class="rhine-query-form">${manualSearchControls}<div class="search-field"><span>⌕</span><input id="rhine-query" type="search" autocomplete="off" placeholder="搜索人物、剧情、机构或一句原文" maxlength="3000" aria-label="搜索资料"/><button type="button" class="rhine-search-cancel" hidden>取消</button><button type="submit" class="rhine-search-submit">检索资料 ↵</button></div><div class="rhine-query-actions"><span class="rhine-query-hint">候选资料可直接阅读、收藏，或放入指定调查的证据盒。</span><button type="button" class="rhine-ask-agent">交给 Agent ↗</button></div></form>
          <div class="category-filters"></div><label class="rhine-evidence-target"><span>证据盒归属</span><select aria-label="证据盒归属" disabled><option>正在读取调查板…</option></select></label><div class="result-header"><span>资料标题 / 内容预览</span><span>来源与操作</span></div><div class="rhine-result-summary" role="status"></div><div class="rhine-result-list search-results"></div><div class="rhine-result-pagination"></div><div class="modal-bottom"><span class="rhine-index-provenance">PRTS / CORPUS SEARCH</span><span class="rhine-search-connection">LOCAL / 本地资料</span></div>
        </div>
      </section>
      <section class="rhine-basket modal-backdrop" aria-label="收藏与摘录" hidden><div class="terminal-modal rhine-basket-modal"><div class="modal-top"><span>RHINE LAB / RESEARCH EXTRACTS</span><button type="button" class="rhine-close-basket" aria-label="关闭收藏">CLOSE <span>×</span></button></div><h2>RESEARCH EXTRACTS<small>收藏与摘录 <span class="rhine-extract-count">00</span></small></h2><p class="rhine-panel-description">选取原文，保存线索和来源。摘录随你提交的调查问题一起发送。</p><div class="rhine-basket-list"></div><button type="button" class="rhine-send-extracts solid-button">将摘录交给 Agent ↗</button></div></section>
      <section class="rhine-log modal-backdrop" aria-label="Agent 调查记录" hidden><div class="terminal-modal rhine-log-modal"><div class="modal-top"><span>RHINE LAB / INVESTIGATION RECORDS</span><button type="button" class="rhine-close-log" aria-label="关闭调查记录">CLOSE <span>×</span></button></div><h2>RESEARCH LOG<small>调查记录</small></h2><div class="rhine-log-status"></div><div class="rhine-log-content"><div class="rhine-log-sources"></div><div class="rhine-log-records-heading tiny-label">TOOL RECEIPTS / 工具调用记录</div><div class="rhine-log-records"></div><div class="rhine-log-answer"></div></div></div></section>
      <section class="rhine-rack-index modal-backdrop" aria-label="调查资料目录" hidden><div class="terminal-modal rhine-rack-index-modal"><div class="modal-top"><span>RHINE LAB / EVIDENCE INDEX</span><button type="button" class="rhine-close-rack-index" aria-label="关闭调查资料目录">CLOSE <span>×</span></button></div><h2>档案架目录<small>Agent 已读与手动收藏</small></h2><label class="search-field"><span>⌕</span><input class="rhine-rack-filter" type="search" autocomplete="off" placeholder="筛选资料标题、来源或内容" aria-label="筛选档案架资料"/></label><label class="rhine-evidence-target"><span>证据盒归属</span><select aria-label="证据盒归属" disabled><option>正在读取调查板…</option></select></label><div class="rhine-rack-index-list"></div><div class="rhine-rack-index-count" role="status"></div></div></section>
      <section class="rhine-report modal-backdrop" aria-label="Agent 调查报告" hidden><div class="terminal-modal rhine-report-modal"><div class="modal-top"><span>RHINE LAB / RESEARCH REPORT</span><button type="button" class="rhine-close-report" aria-label="关闭调查报告">返回调查 <span>×</span></button></div><header class="rhine-report-header"><div class="rhine-report-kicker tiny-label">RESEARCH REPORT</div><h2 class="rhine-report-title">调查报告</h2><div class="rhine-report-status" role="status"></div></header><div class="rhine-report-layout"><aside class="rhine-report-outline" aria-label="报告目录"><div class="tiny-label">CONTENTS / 目录</div><nav class="rhine-report-toc"></nav></aside><article class="rhine-report-body" tabindex="0" aria-label="Agent 回答"></article><aside class="rhine-report-references" aria-label="报告引用"><div class="rhine-report-sources"></div></aside></div><footer class="rhine-report-footer"><button type="button" class="rhine-report-rack">翻阅调查资料 <span>↗</span></button><span class="rhine-report-position"></span></footer></div></section>
      <section class="rhine-session-panel modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="rhine-session-heading" hidden><div class="terminal-modal rhine-session-modal"><div class="modal-top"><span>RHINE LAB / SESSION CONTROL</span><button type="button" class="rhine-close-session" aria-label="关闭对话管理">CLOSE <span>×</span></button></div><h2 id="rhine-session-heading">RESEARCH SESSIONS<small>对话与模式</small></h2><p class="rhine-session-workspace"></p><div class="rhine-session-error" role="alert" hidden><p></p><button type="button" class="rhine-session-retry">重试 ↗</button></div><div class="rhine-session-content"><section class="rhine-session-config" aria-label="对话设置"><div class="rhine-session-mode-field"><label for="rhine-mode-select">AGENT MODE <span>调查模式</span></label><div class="rhine-session-select-row"><select id="rhine-mode-select" aria-describedby="rhine-mode-description rhine-mode-hint"></select><button type="button" class="rhine-mode-apply">使用此模式</button></div><p id="rhine-mode-description"></p><p id="rhine-mode-hint"></p></div><div class="rhine-session-model-field" hidden><label for="rhine-model-select">MODEL <span>当前对话模型</span></label><div class="rhine-session-select-row"><select id="rhine-model-select"></select><button type="button" class="rhine-model-apply">切换模型</button></div></div></section><section class="rhine-session-history-section" aria-label="历史会话"><div class="rhine-session-list-heading"><span>SESSION ARCHIVE / 历史会话</span><button type="button" class="rhine-session-refresh">刷新 ↻</button></div><div class="rhine-session-list" tabindex="-1"></div></section></div><div class="rhine-session-modal-footer"><span class="rhine-session-notice" role="status"></span><button type="button" class="rhine-session-create solid-button">＋ 新建对话</button></div></div></section>
      <button type="button" class="rhine-completion-notice" aria-label="调查已完成，阅读报告" hidden><span>✓ 调查完成</span><strong>阅读调查报告</strong><b aria-hidden="true">↗</b></button><div class="rhine-completion-announcement" role="status" aria-live="polite"></div><div class="rhine-toast toast" role="status" hidden></div>
    </div>
  `;
  host.append(root);
  function $<T extends HTMLElement = HTMLElement>(selector: string) { return root.querySelector<T>(selector)!; }
  const input = $<HTMLInputElement>('#rhine-query');
  const agentInput = $<HTMLInputElement>('#rhine-agent-question');
  const reader = $('.rhine-reader');
  const readerBody = $('.rhine-reader-body');
  const resultsPanel = $('.rhine-results');
  const basket = $('.rhine-basket');
  const log = $('.rhine-log');
  const report = $('.rhine-report');
  const rackIndex = $('.rhine-rack-index');
  const sessionPanel = $('.rhine-session-panel');
  const modeSelect = $<HTMLSelectElement>('#rhine-mode-select');
  const modelSelect = $<HTMLSelectElement>('#rhine-model-select');
  const panels = [resultsPanel, basket, log, report, sessionPanel, rackIndex];
  const stage = $('.rhine-original-stage');
  const arrayList = $('.archive-navigation');
  const arrayToggle = $('.rhine-array-toggle');
  const arrayListTransition = new SurfaceTransition(arrayList, undefined, 220, 160);
  let arrayListExpanded = false;
  stage.dataset.arrayList = 'closed';
  const boardToolbar = $('.rhine-board-toolbar');
  const boardFullscreenButton = $<HTMLButtonElement>('.rhine-board-fullscreen-toggle');
  const boardResetButton = $<HTMLButtonElement>('.rhine-board-reset');
  const boardZoomOut = $<HTMLButtonElement>('.rhine-board-zoom-out');
  const boardZoomIn = $<HTMLButtonElement>('.rhine-board-zoom-in');
  const boardChalk = $<HTMLButtonElement>('.rhine-board-chalk-hit');
  const boardToolsFallback = $<HTMLButtonElement>('.rhine-board-tools-fallback');
  const boardToolStatus = $('.rhine-board-tool-status');
  let boardFrame: BoardAnchorFrame | null = null;
  let boardUiScale = 1;
  let boardToolState: EvidenceBoardTool = { mode: 'select' };
  let boardToolsOpen = false;
  let boardEditorInset = 0;
  let investigationReading: ReadingObject | null = null;
  let investigationReturn = { fullscreen: false, kind: 'report' as 'report' | 'clue' | 'inbox' };
  let evidenceTarget = 'auto';
  let investigationContext: InvestigationContext = { sessionId: snapshot.sessionId, boards: [], selectedId: '', workingId: '', ready: false };
  let contextSignature = '';
  let investigation: ReturnType<typeof mountInvestigationBoard> | undefined;
  const archiveRack = createArchiveRack({ api: options.api,
    changed(value) { manualSources=value;persist();mergeSources();updateReaderSave(); }, failed: toast });
  const boardPanel = mountEvidenceBoardPanel(stage, {
    getCardBounds: id => scene?.getBoardCardBounds(id) || null,
    managed: true,
    sessionId: snapshot.sessionId,
    onChange(cards) {
      investigation?.userChange(cards);
      $('.rhine-board-count').textContent = String(cards.length).padStart(2, '0');
    },
    onSelect(id) { scene?.selectBoardCard(id); },
    onToolChange(tool) {
      if (scene) scene.setBoardTool(tool);
      else {
        syncBoardToolState({ mode: 'select' });
        if (tool.mode !== 'select') toast('白板正在载入，请稍候再选择工具。');
      }
    },
    onToolsOpen(open) {
      boardToolsOpen = open;
      boardChalk.setAttribute('aria-expanded', String(open)); boardChalk.classList.toggle('is-open', open);
      boardToolStatus.hidden = open || boardToolState.mode === 'select' || location !== 'board' || Boolean(selectedSource);
    },
    onViewportInset(fraction) {
      boardEditorInset = fraction;
      scene?.setBoardEditorInset(fraction);
    },
    onBrowse() { setLocation('archive'); openIndex(); },
  });
  investigation = mountInvestigationBoard(stage, {
    sessionId: snapshot.sessionId, api: options.api, panel: boardPanel,
    onRackRevision(revision) { void archiveRack.refresh(revision).catch(()=>{}); },
    onCards(cards) { scene?.setBoardCards(cards); $('.rhine-board-count').textContent = String(Math.max(0, cards.length - 1)).padStart(2, '0'); },
    openSource(source,inbox=false) { investigation?.holdReadingContext();investigationReturn={fullscreen:boardFullscreen,kind:inbox?'inbox':investigationReading?.kind||'report'};openSource(source,'investigation'); }, notify: toast,
    onContext(value){investigationContext=value;renderInvestigationContext();},
    onInbox(value,open){if(open)boardPanel.closeTools();scene?.setEvidenceInbox(value,open);},
    askInbox:options.agentAvailable===false?undefined:async(boardId,title)=>{await options.askAgent(`请继续整理调查板「${title}」（board_id: ${boardId}）的重点证据盒。先读取这块板和 inbox，resume 同一调查；核对待整理资料，尤其是我手动选入的材料，将有依据的内容整理为线索。不要仅为清空盒子而生成线索。`);},
    onReading(value) { investigationReading=value;syncReadingObject(); },
  });
  edgeNavigation = mountSceneEdgeNavigation(stage, {
    location: () => location,
    available: () => active && !disposed && !selectedSource && !viewer?.isOpen && !boardFullscreen
      && !panels.some(panel => !panel.hidden) && (location !== 'board' || boardToolState.mode === 'select'),
    navigate: setLocation,
    returnFocus: () => root.querySelector<HTMLElement>(`[data-zone="${location}"]`)?.focus({ preventScroll: true }),
  });
  // TEMPORARY RHINE PROFILER: no document text or queries are included in exports.
  const performancePanel = mountTemporaryPerformancePanel(root, () => {
    const stats = scene?.stats();
    const switches = new URLSearchParams(window.location.search);
    return { diagnosticRevision: 'pointer-reader-1', uiUpdates: { ...uiUpdates }, hostBridge: options.host?.performanceStats?.() ?? null, snapshotBridge: options.snapshotDiagnostics?.performanceStats?.() ?? null, userAgent: navigator.userAgent, viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
      quality: { ...quality }, renderQuality: stats?.renderQuality, renderSurface: stats?.renderSurface,
      location, viewerOpen: Boolean(viewer?.isOpen), sourceCount: sources.length, archiveSourceCount: archiveSources.length,
      heroLoaded: stats?.heroLoaded, preparation: stats?.preparation,
      programPreparation: stats?.programPreparation, shelfInterior: stats?.shelfInterior, camera: stats?.camera,
      navigation: stats?.navigation ?? navigationLimiter.stats(),
      comparison: Object.fromEntries(['rhineArray', 'rhineCull', 'rhineLod', 'rhineOcclusion', 'rhineShell', 'rhineDetails', 'rhineShelf'].map(key => { const value = switches.get(key); return [key, value === null ? null : ['geometry', 'baked', 'off', 'on'].includes(value) ? value : 'other']; })),
    };
  }, () => ({ location, viewerOpen: Boolean(viewer?.isOpen), sourceCount: sources.length, archiveSourceCount: archiveSources.length,
    detailOpen: Boolean(selectedSource), modalOpen: panels.some(panel => !panel.hidden), boardFullscreen,
    searchBusy, readerBusy, resultCount: results.length, answerCharacters: snapshot.answer?.length || 0,
    recordCount: snapshot.records?.length || 0, investigationRunning: Boolean(snapshot.running),
    investigationSearching: Boolean(snapshot.searching), reportRenderPending: reportRenderTimer !== undefined,
    uiUpdates: { ...uiUpdates }, hostBridge: options.host?.performanceStats?.() ?? null, snapshotBridge: options.snapshotDiagnostics?.performanceStats?.() ?? null }));
  options.host?.setPerformanceMonitor?.(kind => performancePanel.capture.beginUiWork(kind));
  options.snapshotDiagnostics?.setPerformanceMonitor?.(kind => performancePanel.capture.beginUiWork(kind));
  const monitoredApi: typeof options.api = async (endpoint, payload, signal) => {
    const done = performancePanel.capture.beginLoad(endpoint === 'archive.search' ? 'api:archive.search' : endpoint === 'read' ? 'api:read' : 'api:other');
    try {
      const result = await options.api(endpoint, payload, signal);
      done(signal?.aborted ? 'aborted' : result?.ok === false || result?.error ? 'error' : 'complete');
      return result;
    } catch (error) { done(signal?.aborted ? 'aborted' : 'error'); throw error; }
  };
  const manualSearch = mountManualSearch($<HTMLFormElement>('.rhine-query-form'), monitoredApi, () => {
    searchController?.abort(); searchController = undefined; searchBusy = false;
    searchMode = manualSearch.mode; results = []; resultsPage = 0; resultFilter = -1;
    searchCursor = undefined; searchDataVersion = undefined; searchQuery = ''; searchError = ''; searchWarning = '';
    catalogueLoaded = false; renderResults(); renderStatus();
  });
  const detailTransition = new SurfaceTransition($('#detail-ui'), undefined, 180, 180);
  const modalTransitions = new Map(panels.map(panel => [panel, new SurfaceTransition(panel, panel.querySelector<HTMLElement>('.terminal-modal')!, 300, 200)]));
  const coarse = window.matchMedia('(pointer: coarse)');
  const motion = { duration: 460, motionBlur: true, animated: !reducedMotion.matches };
  const counters = {
    file: createRollingNumber($('#selected-number'), { ...motion, locales: 'en-US', value: 0, format: { minimumIntegerDigits: 2, useGrouping: false } }),
    column: createRollingNumber($('#column-index'), { ...motion, locales: 'en-US', value: 1, format: { minimumIntegerDigits: 2, useGrouping: false } }),
    code: createRollingNumber($('#selected-code'), { ...motion, locales: 'en-US', value: 0, format: { minimumIntegerDigits: 3, useGrouping: false } }),
  };
  const titles = {
    column: createRollingText($('#column-name'), { ...motion, text: ARCHIVE_LANES[0], transition: 'direct', stagger: 'none' }),
    category: createRollingText($('#archive-category'), { ...motion, text: ARCHIVE_LANES[0], transition: 'direct', stagger: 'none' }),
    clearance: createRollingText($('#selected-clearance'), { ...motion, text: 'SOURCE / READY', transition: 'direct', stagger: 'none' }),
  };
  const sourceMotion = new ReadCardMotion();
  let agentReadFocus: ReturnType<typeof latestReadFocus>;
  let followAgent = true;
  const unseenReads = new Set<string>();
  const observedReads = new Set<string>();
  let activityTurn = '';
  let activityInitialized = false;
  let displayedArchiveSource: ArchiveSource | undefined;
  let toolFeedSignature = '';
  let previousLayout = '';
  function fit() {
    if (disposed) return;
    const { width, height, scale, kind } = viewportLayout(root.clientWidth, root.clientHeight, coarse.matches, false);
    stage.style.width = `${width}px`;
    stage.style.height = `${height}px`;
    stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
    stage.dataset.layout = kind;
    stage.dataset.touch = String(coarse.matches);
    stage.style.setProperty('--stage-scale', String(scale));
    boardUiScale = scale;
    scheduleReportPosition();
    stage.style.setProperty('--board-ui-scale', String(1 / scale));
    positionBoardControls();
    root.style.setProperty('--scale', String(scale));
    const visual = window.visualViewport;
    const stageTop = (root.clientHeight - height * scale) / 2;
    stage.style.setProperty('--modal-top', `${Math.max(0, (visual?.offsetTop || 0) - stageTop) / scale}px`);
    stage.style.setProperty('--modal-height', `${Math.min(height, (visual?.height || root.clientHeight) / scale)}px`);
    // CSS scaling and DPR changes do not resize the scene's layout box, so its
    // ResizeObserver alone cannot keep the drawing buffer at display resolution.
    const layoutKey = JSON.stringify([width, height, scale, kind, devicePixelRatio]);
    if (layoutKey !== previousLayout) {
      previousLayout = layoutKey;
      scene?.resize();
      viewer?.resize();
    }
  }
  const resizeObserver = new ResizeObserver(fit);
  resizeObserver.observe(root);
  // Moving to a display with another pixel density need not fire window resize.
  // Re-arm the query against the new density after each change.
  let densityQuery = window.matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
  function densityChanged() {
    if (disposed) return;
    densityQuery.removeEventListener('change', densityChanged);
    densityQuery = window.matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    densityQuery.addEventListener('change', densityChanged);
    fit();
  }
  densityQuery.addEventListener('change', densityChanged);
  window.addEventListener('resize', fit);
  window.visualViewport?.addEventListener('resize', fit);
  window.visualViewport?.addEventListener('scroll', fit);
  coarse.addEventListener('change', fit);
  fit();
  function syncBoardToolState(tool: EvidenceBoardTool) {
    boardToolState = tool;
    boardPanel.setToolState(tool);
    const text = tool.mode === 'place' ? `点击白板空白处放下${{ note: '短便签', source: '资料卡', question: '疑问签', tag: '关键词标签' }[tool.template]} · Esc 取消`
      : tool.mode === 'connect' ? tool.fromId ? '再点一条线索，连起红绳 · Esc 取消' : '点选第一条线索 · Esc 取消' : '';
    boardToolStatus.querySelector('span')!.textContent = text;
    boardToolStatus.hidden = boardToolsOpen || !text || location !== 'board' || Boolean(selectedSource);
    edgeNavigation?.sync();
  }
  function positionBoardControls() {
    if (!boardFrame || disposed) return;
    const frame = boardFrame, unit = 1 / boardUiScale, margin = 16 * unit;
    const attachedTransform = frame.controls.every(point => point.visible)
      ? boardPlaneTransform(frame.controls, 320, 45) : null;
    boardToolbar.classList.toggle('is-docked', !attachedTransform);
    if (attachedTransform) {
      boardToolbar.style.left = '0'; boardToolbar.style.top = '0';
      boardToolbar.style.transform = attachedTransform;
    } else {
      // Only an offscreen board needs a screen-facing recovery control.
      const x = Math.max(margin, Math.min(frame.width - 240 * unit - margin, frame.corner.x - 240 * unit));
      const y = Math.max(margin, Math.min(frame.height - 40 * unit - margin, frame.corner.y));
      boardToolbar.style.left = `${x}px`; boardToolbar.style.top = `${y}px`;
      boardToolbar.style.transform = `scale(${unit})`;
    }
    const chalkVisible = frame.chalk.visible && frame.chalk.x > 24 * unit && frame.chalk.x < frame.width - 24 * unit
      && frame.chalk.y > 24 * unit && frame.chalk.y < frame.height - 24 * unit;
    boardChalk.style.left = `${frame.chalk.x - 24 * unit}px`; boardChalk.style.top = `${frame.chalk.y - 24 * unit}px`;
    boardChalk.hidden = boardToolbar.hidden || !chalkVisible;
    boardToolsFallback.hidden = chalkVisible;
    boardResetButton.textContent = `${Math.round(frame.zoom * 100)}%`;
    boardZoomOut.disabled = !scene || frame.zoom <= 1.0001;
    boardZoomIn.disabled = !scene || frame.zoom >= 2.9999;
  }
  function boardToolPosition() {
    return boardFrame ? { x: boardFrame.chalk.x, y: boardFrame.chalk.y } : undefined;
  }
  function syncBoardToolbar() {
    const unavailable = root.classList.contains('rhine-scene-unavailable');
    boardToolbar.hidden = location !== 'board' || Boolean(selectedSource) || unavailable || !boardFrame?.visible;
    boardChalk.hidden = boardToolbar.hidden;
    boardToolStatus.hidden = boardToolsOpen || boardToolbar.hidden || boardToolState.mode === 'select';
    if (boardToolbar.hidden && document.activeElement instanceof HTMLElement && (boardToolbar.contains(document.activeElement) || boardChalk === document.activeElement)) document.activeElement.blur();
    boardFullscreenButton.disabled = boardResetButton.disabled = !scene || unavailable;
    boardFullscreenButton.setAttribute('aria-pressed', String(boardFullscreen));
    boardFullscreenButton.setAttribute('aria-label', boardFullscreen ? '退出全屏线索板' : '全屏线索板');
    boardFullscreenButton.title = boardFullscreen ? '退出全屏 · Esc' : '全屏线索板';
    $('.rhine-board-fullscreen-label').textContent = boardFullscreen ? '退出' : '全屏';
    positionBoardControls();
  }
  function setBoardFullscreen(value: boolean) {
    const next = value && location === 'board' && Boolean(scene) && !root.classList.contains('rhine-scene-unavailable');
    if (boardFullscreen === next) { syncBoardToolbar(); return; }
    boardFullscreen = next;
    root.classList.toggle('rhine-board-fullscreen', next);
    fit();
    scene?.setBoardFullscreen(next);
    syncBoardToolbar();
    edgeNavigation?.sync();
  }
  boardFullscreenButton.addEventListener('click', () => setBoardFullscreen(!boardFullscreen));
  boardResetButton.addEventListener('click', () => scene?.resetBoardView());
  boardZoomOut.addEventListener('click', () => scene?.zoomBoard(-1));
  boardZoomIn.addEventListener('click', () => scene?.zoomBoard(1));
  const toggleBoardTools = () => boardPanel.toggleTools(boardToolPosition());
  boardChalk.addEventListener('click', toggleBoardTools);
  boardToolsFallback.addEventListener('click', toggleBoardTools);
  $('.rhine-board-tool-cancel').addEventListener('click', () => { scene?.setBoardTool({ mode: 'select' }); syncBoardToolState({ mode: 'select' }); });
  function clockTick() { if (active && !document.hidden) $('#clock').textContent = new Date().toLocaleTimeString('en-GB', { hour12: false }); }
  const clockTimer = window.setInterval(clockTick, 1000);
  clockTick();
  function setArrayListExpanded(expanded: boolean, immediate = false, restoreFocus = false) {
    arrayListExpanded = expanded;
    arrayList.inert = !expanded;
    stage.dataset.arrayList = expanded ? 'open' : 'closed';
    arrayToggle.hidden = expanded;
    arrayToggle.setAttribute('aria-expanded', String(expanded));
    if (expanded) {
      arrayListTransition.show(immediate || reducedMotion.matches);
      const chosen = archiveSelected && archiveTickNodes.get(archiveSelected);
      if (chosen) revealChoice($('#file-ticks'), chosen);
      $('.rhine-array-collapse').focus({ preventScroll: true });
    } else {
      arrayListTransition.hide(immediate || reducedMotion.matches);
      if (restoreFocus) arrayToggle.focus({ preventScroll: true });
    }
  }
  function syncMode() {
    const detail = Boolean(selectedSource);
    if (detail && arrayListExpanded) setArrayListExpanded(false, true);
    stage.dataset.mode = detail ? 'detail' : 'archive';
    if (detail && !detailWasOpen) { detailTransition.show(reducedMotion.matches); paintDetail(detailVisibility); }
    else if (!detail && detailWasOpen) detailTransition.hide(reducedMotion.matches, () => {
      if (selectedSource) return;
      reader.hidden = true;
    });
    detailWasOpen = detail;
    $('#archive-ui').hidden = detail || location !== 'archive';
    $('#archive-ui').inert = detail || location !== 'archive';
    if (detail) reader.hidden = false;
    $('.rhine-agent-form').hidden = detail || location === 'board';
    $('.rhine-location-button').hidden = detail || location === 'board';
    $('.rhine-zone-nav').hidden = detail;
    boardPanel.setActive(!detail && location === 'board');
    investigation?.setActive(!detail && location === 'board');
    syncBoardToolbar();
    for (const tab of root.querySelectorAll<HTMLElement>('[data-zone]')) tab.setAttribute('aria-pressed', String(tab.dataset.zone === location));
    $('.rhine-nav-board').setAttribute('aria-pressed', String(location === 'board'));
    $('.rhine-desk-panel').hidden = detail || location !== 'desk';
    scene?.setDetail(detail);
    if (reducedMotion.matches || !scene) paintDetail(detail ? 1 : 0);
    syncModalState();
  }
  function paintDetail(visibility: number) {
    detailVisibility = visibility;
    stage.style.setProperty('--detail-shade', String(visibility));
    if (selectedSource) {
      const content = reader;
      content.style.opacity = String(visibility);
      content.style.transform = `translateY(${(1 - visibility) * 18}px)`;
      content.inert = visibility < 0.1;
      if (pendingDetailFocus && visibility >= 0.1 && !panels.some(panel => !panel.hidden) && !viewer?.isOpen) {
        readerMeasure('focus', () => pendingDetailFocus!.focus({ preventScroll: true })); pendingDetailFocus = null;
      }
    }
  }
  function syncReadingObject() {
    const value=investigationReading||(!report.hidden?{title:$('.rhine-report-title').textContent||'调查报告',code:'RESEARCH / LIVE',kind:'report' as const}:null);
    root.classList.toggle('has-reading-object',!!value);scene?.setReadingObject(value);
  }
  function syncModalState() {
    syncReadingObject();
    const modal = panels.find(panel => !panel.hidden);
    if (modal) scene?.setBoardTool({ mode: 'select' });
    for (const child of [...stage.children]) {
      if (child instanceof HTMLElement) child.inert = Boolean(modal && child !== modal && !child.classList.contains('rhine-toast'));
    }
    if (!modal) $('#archive-ui').inert = stage.dataset.mode !== 'archive' || location !== 'archive';
    syncCompletionNotice();
    edgeNavigation?.sync();
  }
  function updateArchiveSelection(id: string | null = archiveSelected, lane = archiveLaneIndex, animate = true) {
    return performancePanel.capture.measureWork('archive-selection', () => updateArchiveSelectionBody(id, lane, animate));
  }
  function updateArchiveSelectionBody(id: string | null, lane: number, animate: boolean) {
    const selected = archiveSources.find(item => item.id === id);
    archiveSelected = selected?.id || null;
    archiveLaneIndex = selected ? archiveLane(selected) : lane;
    const files = archiveSources.filter(item => archiveLane(item) === archiveLaneIndex);
    const index = selected ? files.findIndex(item => item.id === selected.id) : -1;
    if (selected) columnMemory[archiveLaneIndex] = selected.id;
    const following = followAgent ? agentReadFocus : undefined;
    const source = following ? following.source : selected;
    displayedArchiveSource = source; // Keep the current source object even when its visible fields are unchanged.
    const animated = animate && !reducedMotion.matches && !selectedSource;
    const direction = navigationHint ? navigationHint.direction > 0 ? 'up' : 'down' : 'auto';
    const rowDirection = navigationHint?.axis === 'row' ? direction : 'auto';
    const laneDirection = navigationHint?.axis === 'lane' ? direction : 'auto';
    navigationHint = undefined;
    const title = source?.title || (files.length ? '选择一份资料' : '等待新的线索');
    const category = source ? kind(source) : ARCHIVE_LANES[archiveLaneIndex];
    const clearance = following ? following.operation.state === 'active' ? 'Agent 正在查阅' : following.operation.state === 'error' ? '查阅未完成' : 'Agent 已查阅' : source ? source.saved ? '已收藏 · ' + state(source) : state(source) : 'COLLECTION / EMPTY';
    const code = source ? sourceNumber(source) : 0;
    const excerpt = following ? `${following.operation.tool} · ${following.operation.state === 'active' ? '正在读取这份原文' : following.operation.state === 'error' ? '本次查阅未完成' : '本次查阅已返回'}，点击可核对内容。` : source?.excerpt || (source ? '打开原文，继续阅读完整内容。' : '可从索引检索这一类资料，或交给 Agent 寻找线索。');
    const first = Math.floor(Math.max(0, index) / 8) * 8;
    const visible = files.slice(first, first + 8);
    const signature = JSON.stringify([archiveSelected, archiveLaneIndex, index, title, category, clearance, code,
      excerpt, Boolean(source), files.length, visible.map(item => [item.id, item.title, item.state, item.saved])]);
    if (signature === archiveSelectionSignature) { uiUpdates.selectionSkipped++; return; }
    archiveSelectionSignature = signature;
    $('#selected-title').textContent = title;
    titles.column.update({ text: ARCHIVE_LANES[archiveLaneIndex], animated });
    titles.category.update({ text: category, animated });
    titles.clearance.update({ text: clearance, animated });
    counters.code.update({ value: code, animated, direction });
    counters.file.update({ value: index + 1, animated, direction: rowDirection });
    counters.column.update({ value: archiveLaneIndex + 1, animated, direction: laneDirection });
    $('.count-total').textContent = String(files.length).padStart(2, '0');
    $('.rhine-selected-excerpt').textContent = excerpt;
    $('.rhine-current-source').dataset.empty = String(!source);
    $<HTMLButtonElement>('.rhine-array-stage').disabled=!source;
    const read = $('.read-file'), label = source ? 'OPEN SOURCE ' : 'ARCHIVE INDEX ';
    if (read.firstChild?.textContent !== label) {
      read.replaceChildren(document.createTextNode(label), node('span', '', '→'));
    }
    const ticks = $('#file-ticks'), ids = new Set(visible.map(item => item.id));
    const retainFocus = ticks.contains(document.activeElement);
    const priorSelected = ticks.dataset.selected;
    ticks.dataset.selected = archiveSelected || '';
    for (const [key, tick] of archiveTickNodes) if (!ids.has(key)) { tick.remove(); archiveTickNodes.delete(key); }
    visible.forEach((item, position) => {
      let tick = archiveTickNodes.get(item.id);
      if (!tick) {
        tick = button('', 'rhine-source-choice', () => selectArchiveSource(item.id), item.title);
        tick.dataset.sourceId = item.id; archiveTickNodes.set(item.id, tick); uiUpdates.ticksCreated++;
      }
      tick.classList.toggle('selected', item.id === archiveSelected);
      tick.setAttribute('aria-pressed', String(item.id === archiveSelected));
      updateSourceChoice(tick, item, sourceNumber(item), origin(item));
      if (ticks.children[position] !== tick) ticks.insertBefore(tick, ticks.children[position] || null);
    });
    ticks.querySelector('.rhine-empty')?.remove();
    if (!files.length) ticks.append(node('p', 'rhine-empty', '此分类还没有资料，可打开资料索引检索。'));
    $('.rhine-array-toggle-count').textContent = `${ARCHIVE_LANES[archiveLaneIndex]} · ${files.length}`;
    $('.rhine-array-range').textContent = files.length ? `${first + 1}–${Math.min(first + 8, files.length)} / ${files.length} 份` : '暂无资料';
    const chosen = archiveSelected && archiveTickNodes.get(archiveSelected);
    if (chosen && location === 'archive') {
      revealChoice(ticks, chosen);
      if (retainFocus && priorSelected !== archiveSelected) chosen.focus({ preventScroll: true });
    }
    $<HTMLButtonElement>('[data-action="prev"]').disabled = first === 0;
    $<HTMLButtonElement>('[data-action="next"]').disabled = first + 8 >= files.length;
    $<HTMLButtonElement>('.rhine-array-read').disabled = !source;
  }
  function syncArchiveSources() {
    activitySources = undefined;
    archiveSources = mergeSourcesInOrder(archiveSources, [...results, ...discoveredSources]);
    scene?.setArchiveSources(archiveSources);
    const current = archiveSources.find(item => item.id === archiveSelected);
    const next = current || archiveSources.find(item => archiveLane(item) === archiveLaneIndex) || archiveSources[0];
    if (next && !current && location === 'archive' && !selectedSource) scene?.selectArchiveSource(next.id, false);
    updateArchiveSelection(next?.id || null, next ? archiveLane(next) : archiveLaneIndex, false);
  }
  function renderFollowMode() {
    $('.rhine-follow-status').textContent = followAgent ? '跟随 Agent 查阅' : `手动浏览${unseenReads.size ? ` · 新查阅 ${unseenReads.size} 次` : ' · 自动跟随已暂停'}`;
    $('.rhine-follow-toggle').textContent = followAgent ? '暂停跟随' : '恢复跟随 ↗';
    $('.rhine-follow-toggle').setAttribute('aria-pressed', String(followAgent));
  }
  function setFollowAgent(value: boolean) {
    followAgent = value; scene?.setFollowAgent(value);
    if (value) { unseenReads.clear(); if (agentReadFocus && !selectedSource) scene?.selectArchiveSource(agentReadFocus.source.id, false); }
    renderFollowMode();
  }
  function selectArchiveSource(id: string) {
    if (selectedSource) return;
    setFollowAgent(false);
    updateArchiveSelection();
    if (scene) { scene.browseArchiveSource(id); return; }
    if (id === archiveSelected || !navigationLimiter.tryAccept(performance.now())) return;
    updateArchiveSelection(id);
  }
  function sourceNumber(source: ArchiveSource) {
    const index = sourceIndex(archiveSources, source);
    return (index >= 0 ? index : sourceIndex(sources, source)) + 1;
  }
  function navigateArchivePage(direction: number) {
    const files = archiveSources.filter(item => archiveLane(item) === archiveLaneIndex);
    const index = files.findIndex(item => item.id === archiveSelected);
    const target = (Math.floor(Math.max(0, index) / 8) + direction) * 8;
    if (files[target]) selectArchiveSource(files[target].id);
  }
  function navigateArchive(axis: 'row' | 'lane', direction: number) {
    if (selectedSource) return;
    setFollowAgent(false);
    updateArchiveSelection();
    navigationHint = { axis, direction };
    if (scene) { scene.navigate(axis, direction); navigationHint = undefined; return; }
    if (!navigationLimiter.tryAccept(performance.now())) { navigationHint = undefined; return; }
    const lane = axis === 'lane' ? (archiveLaneIndex + direction + ARCHIVE_LANES.length) % ARCHIVE_LANES.length : archiveLaneIndex;
    const files = archiveSources.filter(item => archiveLane(item) === lane);
    const index = files.findIndex(item => item.id === archiveSelected);
    const id = axis === 'row' ? files[(index + direction + files.length) % files.length]?.id
      : files.find(item => item.id === columnMemory[lane])?.id || files[0]?.id;
    updateArchiveSelection(id || null, lane);
  }
  function openCurrentArchive() {
    const source = displayedArchiveSource || archiveSources.find(item => item.id === archiveSelected);
    if (source) void openSource(source); else openIndex();
  }
  function closeModals(finished?: () => void, immediate = false) {
    const visible = panels.filter(panel => !panel.hidden);
    if (!visible.length) { syncModalState(); finished?.(); return; }
    let remaining = visible.length;
    for (const panel of visible) modalTransitions.get(panel)!.hide(immediate || reducedMotion.matches, () => {
      syncModalState();
      if (--remaining === 0) finished?.();
    });
  }
  function openIndex() {
    showPanel(resultsPanel); renderResults(); input.focus(); void manualSearch.refresh();
    if (!catalogueLoaded && !searchBusy && manualSearch.mode === 'local') void search(false, true);
  }
  function renderViewer(time: number) {
    viewerFrame = 0;
    if (disposed || !active || document.hidden || !viewer?.isOpen) return;
    viewer.update(time / 1000, time);
    viewerFrame = requestAnimationFrame(renderViewer);
  }
  const viewerVisibility = () => {
    if (document.hidden) { cancelAnimationFrame(viewerFrame); viewerFrame = 0; }
    else if (!disposed && active && viewer?.isOpen && !viewerFrame) viewerFrame = requestAnimationFrame(renderViewer);
  };
  document.addEventListener('visibilitychange', viewerVisibility);
  function openModelViewer() {
    if (!scene) { toast('档案模型正在载入，请稍后再试。'); return; }
    try {
      if (!viewer) viewer = new ModelViewer(stage, () => {
        if (disposed) return;
        cancelAnimationFrame(viewerFrame); viewerFrame = 0;
        scene?.setActive(active && !document.hidden);
        edgeNavigation?.sync();
      }, undefined, performancePanel.capture);
      viewer.setQuality(quality);
      scene.finishDecryption();
      if (!selectedSource) return;
      const provider = scene;
      viewer.open(selectedSource.id, selectedSource.title, () => provider.createAssemblyModel(), reducedMotion.matches);
      edgeNavigation?.sync();
      scene.setActive(false);
      if (!viewerFrame) viewerFrame = requestAnimationFrame(renderViewer);
    } catch (error) { toast(`模型查看器暂时无法打开：${plainError(error)}`); }
  }

  function toast(message: string) {
    if (disposed) return;
    const element = $('.rhine-toast');
    element.textContent = message;
    element.hidden = false;
    clearTimeout(toastTimeout);
    toastTimeout = window.setTimeout(() => { element.hidden = true; }, 4500);
  }
  function storageKey() { return `prts-rhine-desk:v1:${encodeURIComponent(snapshot.sessionId || 'default')}`; }
  function loadSaved() {
    manualSources = [];
    extracts = [];
    try {
      const saved: Persisted = JSON.parse(localStorage.getItem(storageKey()) || '{}');
      manualSources = Array.isArray(saved.sources) ? saved.sources.filter(s => s && typeof s.id === 'string' && typeof s.title === 'string').slice(-MAX_SAVED).map(source => ({ ...source, saved: true })) : [];
      extracts = Array.isArray(saved.extracts) ? saved.extracts.filter(e => e && typeof e.text === 'string' && e.source && typeof e.source.id === 'string').slice(-MAX_EXTRACTS) : [];
    } catch { /* The workspace remains fully usable without browser persistence. */ }
    void archiveRack.setSession(snapshot.sessionId,manualSources).catch(()=>{});
  }
  function persist() {
    try { localStorage.setItem(storageKey(), JSON.stringify({ sources: manualSources.slice(-MAX_SAVED), extracts: extracts.slice(-MAX_EXTRACTS) })); }
    catch { toast('浏览器存储不可用，本次打开期间仍可翻阅资料。'); }
  }
  function closeReader(restoreFocus = true) {
    const origin = restoreFocus ? readerOrigin : null;
    readerOrigin = null; readerReturn = null;
    cancelAnimationFrame(originRestoreFrame);
    $('.rhine-reader-back-report').hidden = true;
    const wasOpen = Boolean(selectedSource);
    if (!wasOpen) reader.hidden = true;
    cancelReaderPosition(); readController?.abort(); readController = undefined;
    readerBusy = false; selectedSource = undefined; pendingDetailFocus = null;
    scene?.select(null); root.classList.remove('has-reader'); syncMode();
    if (origin && origin.sessionId === snapshot.sessionId) {
      if (location !== origin.location) setLocation(origin.location);
      if (origin.kind === 'investigation') {
        setBoardFullscreen(investigationReturn.fullscreen);
        investigation?.resumeReading(investigationReturn.kind);
      } else if (origin.kind === 'report') openReport(true);
      else {
        const panel = {search: resultsPanel, rack: rackIndex, basket, log}[origin.kind as 'search'|'rack'|'basket'|'log'];
        if (panel) showPanel(panel);
      }
      if (origin.arrayExpanded && origin.location === 'archive') setArrayListExpanded(true, true);
      originRestoreFrame = requestAnimationFrame(() => {
        originRestoreFrame = 0;
        if (!disposed && !selectedSource && origin.sessionId === snapshot.sessionId) restoreReadingOrigin(root, origin);
      });
    } else if (restoreFocus && lastFocus?.isConnected && !lastFocus.closest('[hidden],[inert]')) lastFocus.focus({preventScroll:true});
  }
  function showPanel(panel: HTMLElement) {
    for (const other of panels) if (other !== panel && !other.hidden) modalTransitions.get(other)!.hide(true);
    closeReader(false);
    modalTransitions.get(panel)!.show(reducedMotion.matches);
    syncModalState();
  }
  function hostBlocked() { return hostActionBusy || Boolean(hostState?.busy || hostState?.loading); }
  function submissionBlocked() { return options.agentAvailable === false || extracting || hostBlocked() || hostState?.canSubmit === false; }
  function renderHostChoice() {
    if (!hostState) return;
    const canChangeMode = hostState.blank && !hostState.running;
    const mode = hostState.modes.find(item => item.id === modeSelect.value);
    $('#rhine-mode-description').textContent = mode?.description || (hostState.loading ? '正在读取可用模式…' : hostState.modes.length ? '' : '暂未读取到可用模式，请刷新后重试。');
    $('#rhine-mode-hint').textContent = canChangeMode ? '当前是空白对话，可在提问前选择模式。' : '当前对话已开始。选择其他模式会新建对话，已有调查记录保留在历史会话中。';
    const apply = $<HTMLButtonElement>('.rhine-mode-apply');
    apply.textContent = canChangeMode ? modeSelect.value === hostState.mode ? '当前模式' : '使用此模式' : '用此模式新建对话';
    apply.disabled = hostBlocked() || extracting || !mode || Boolean(canChangeMode && modeSelect.value === hostState.mode);
    $<HTMLButtonElement>('.rhine-model-apply').disabled = hostBlocked() || extracting || !hostState.models.some(item => item.id === modelSelect.value) || modelSelect.value === hostState.model;
    const modeName = mode?.name || '';
    $('.rhine-session-create').textContent = hostState.blank ? '＋ 另开新对话' : '＋ 新建对话';
    $('.rhine-session-create').title = modeName ? `用“${modeName}”新建对话` : '新建对话';
  }
  const hostSessionNodes = new Map<string, HTMLButtonElement>();
  function renderHostControls() { return performancePanel.capture.measureWork('host-controls', renderHostControlsBody); }
  function renderHostControlsBody() {
    const signature = JSON.stringify([hostState, hostActionBusy, hostActionError, extracting]);
    if (signature === hostPaintSignature) return;
    hostPaintSignature = signature;
    $('.rhine-session-controls').hidden = !options.host;
    $('.rhine-agent-settings').hidden = !options.host;
    root.classList.toggle('has-host-controls', Boolean(options.host));
    if (!hostState) return;
    const busy = hostBlocked() || extracting;
    const modeChanged = hostMode !== hostState.mode;
    const modelChanged = hostModel !== hostState.model;
    const sessionChanged = hostSessionId !== hostState.sessionId;
    if (sessionChanged) { hostActionError = ''; hostRetry = undefined; }
    $('.rhine-session-history').title = `当前会话：${hostState.title || '新对话'} · 切换历史会话`;
    const currentMode = hostState.modes.find(item => item.id === hostState!.mode)?.name || hostState.mode || '选择模式';
    const currentModel = hostState.models.find(item => item.id === hostState!.model)?.name || '选择模型';
    $('.rhine-session-mode span').textContent = currentMode;
    $('.rhine-session-mode').title = `调查模式：${currentMode}`;
    $('.rhine-session-mode').setAttribute('aria-label', `选择调查模式，当前：${currentMode}`);
    $('.rhine-session-model span').textContent = currentModel;
    $('.rhine-session-model').title = `当前模型：${currentModel}`;
    $('.rhine-session-model').setAttribute('aria-label', `选择模型，当前：${currentModel}`);
    $('.rhine-session-workspace').textContent = hostState.workspace ? `当前工作区 · ${hostState.workspace}` : '当前工作区尚未选择';
    $('.rhine-session-notice').textContent = busy ? hostState.loading && !hostActionBusy ? '正在读取对话设置…' : '正在更新对话，请稍候…' : hostState.blank ? '空白对话 · 设置模式后即可开始调查' : '切换会话后，可继续该会话的调查。';
    const error = hostActionError || hostState.error || '';
    $('.rhine-session-error').hidden = !error;
    $('.rhine-session-error p').textContent = error;
    $('.rhine-session-alert').hidden = !error;
    $('.rhine-session-alert').title = error;
    $('.rhine-session-controls').setAttribute('aria-busy', String(busy));
    $('.rhine-agent-settings').setAttribute('aria-busy', String(busy));
    sessionPanel.setAttribute('aria-busy', String(busy));
    const nextModeSignature = JSON.stringify(hostState.modes);
    if (nextModeSignature !== modeSignature) {
      const draft = modeSelect.value;
      modeSelect.replaceChildren(...hostState.modes.map(item => { const option = node('option', '', item.name); option.value = item.id; return option; }));
      modeSelect.value = !sessionChanged && !modeChanged && hostState.modes.some(item => item.id === draft) ? draft : hostState.mode;
      modeSignature = nextModeSignature;
    } else if (sessionChanged || modeChanged) modeSelect.value = hostState.mode;
    const nextModelSignature = JSON.stringify(hostState.models);
    if (nextModelSignature !== modelSignature) {
      const draft = modelSelect.value;
      modelSelect.replaceChildren(...hostState.models.map(item => { const option = node('option', '', item.name); option.value = item.id; return option; }));
      modelSelect.value = !sessionChanged && !modelChanged && hostState.models.some(item => item.id === draft) ? draft : hostState.model;
      modelSignature = nextModelSignature;
    } else if (sessionChanged || modelChanged) modelSelect.value = hostState.model;
    hostSessionId = hostState.sessionId; hostMode = hostState.mode; hostModel = hostState.model;
    $('.rhine-session-model-field').hidden = !hostState.models.length;
    modeSelect.disabled = busy || !hostState.modes.length;
    modelSelect.disabled = busy || !hostState.models.length;
    for (const control of root.querySelectorAll<HTMLButtonElement>('.rhine-session-mode,.rhine-session-model,.rhine-session-new,.rhine-session-history,.rhine-session-create,.rhine-session-refresh,.rhine-session-retry')) control.disabled = busy;
    const nextSessionsSignature = JSON.stringify([hostState.sessionId, hostState.loading, hostState.sessions]);
    if (nextSessionsSignature !== sessionsSignature) {
      const list = $('.rhine-session-list');
      const ids = new Set(hostState.sessions.map(item => item.id));
      for (const [id, entry] of hostSessionNodes) if (!ids.has(id)) { entry.remove(); hostSessionNodes.delete(id); }
      list.querySelector('.rhine-session-empty')?.remove();
      hostState.sessions.forEach((item, index) => {
        let entry = hostSessionNodes.get(item.id);
        if (!entry) {
          entry = button('', 'rhine-session-item', () => { if (options.host) void runHostAction(() => options.host!.openSession(item.id), true); });
          entry.append(node('strong'), node('span', 'rhine-session-item-meta'));
          hostSessionNodes.set(item.id, entry);
        }
        entry.querySelector('strong')!.textContent = item.title || '未命名对话';
        const date = new Date(item.updatedAt);
        entry.querySelector('span')!.textContent = [item.id === hostState!.sessionId ? '当前会话' : '', item.running ? '调查进行中' : '', item.workspace, Number.isFinite(date.getTime()) && item.updatedAt > 0 ? date.toLocaleDateString('zh-CN') : ''].filter(Boolean).join(' · ');
        entry.setAttribute('aria-current', item.id === hostState!.sessionId ? 'true' : 'false');
        entry.title = [item.title, item.workspace].filter(Boolean).join(' · ');
        if (list.children[index] !== entry) list.insertBefore(entry, list.children[index] || null);
      });
      if (!hostState.sessions.length) list.append(node('p', 'rhine-session-empty', hostState.loading ? '正在读取历史会话…' : '暂无历史会话。可以新建对话开始调查。'));
      sessionsSignature = nextSessionsSignature;
    }
    for (const [id, entry] of hostSessionNodes) entry.disabled = busy || id === hostState.sessionId;
    const cancel = $<HTMLButtonElement>('.rhine-agent-cancel');
    cancel.hidden = !hostState.running;
    cancel.disabled = busy;
    renderHostChoice();
  }
  async function runHostAction(action: () => Promise<void>, closeOnSuccess = false) {
    if (!options.host || hostBlocked() || extracting) return;
    hostActionBusy = true; hostActionError = ''; hostRetry = undefined;
    renderAgentControls();
    try {
      await action();
      if (disposed) return;
      if (closeOnSuccess) closeModals(() => agentInput.focus());
    } catch (error) {
      if (disposed) return;
      hostActionError = plainError(error);
      hostRetry = () => runHostAction(action, closeOnSuccess);
      toast(hostActionError);
    } finally {
      if (!disposed) {
        hostActionBusy = false;
        hostState = options.host.getState();
        renderAgentControls();
      }
    }
  }
  function openHostPanel(trigger: HTMLElement, focus: 'mode' | 'model' | 'history' = 'mode') {
    if (!options.host) return;
    hostTrigger = trigger;
    showPanel(sessionPanel); renderHostControls();
    const focusChoice = () => {
      const choice = focus === 'history' ? $('.rhine-session-list') : focus === 'model' ? modelSelect : modeSelect;
      const target = choice.matches(':disabled') || choice.closest('[hidden]') ? $('.rhine-close-session') : choice;
      target.focus();
      target.scrollIntoView({ block: 'nearest' });
    };
    if (!hostBlocked() && !hostActionError && !hostState?.error) {
      $('.rhine-close-session').focus();
      void runHostAction(() => options.host!.refresh()).then(() => {
        if (!disposed && !sessionPanel.hidden && hostTrigger === trigger && document.activeElement === $('.rhine-close-session')) focusChoice();
      });
    } else focusChoice();
  }
  function setLocation(next: Location) {
    if (next !== location) setArrayListExpanded(false, true);
    if (next !== 'board') setBoardFullscreen(false);
    location = next;
    root.dataset.location = next;
    $('.rhine-location-title').replaceChildren(document.createTextNode(next === 'desk' ? '检索阵列 ' : '调查档案架 '), node('b', '', next === 'desk' ? '←' : '→'));
    $('.rhine-location-button').setAttribute('aria-label', next === 'desk' ? '镜头移回检索阵列' : `镜头右移到调查档案架，已有 ${sources.length} 份资料`);
    closeModals(undefined, true);
    closeReader(false);
    scene?.setLocation(next);
    syncMode(); renderStatus();
  }
  function renderInvestigationContext() {
    const context=investigationContext;
    const signature=JSON.stringify([context,evidenceTarget]);
    if(signature===contextSignature)return;
    contextSignature=signature;
    const working=context.boards.find(board=>board.id===context.workingId);
    const fallback=context.boards.find(board=>board.id===context.selectedId);
    const autoTitle=working ? `工作板 · ${working.title}` : fallback ? `当前板 · ${fallback.title}` : '首次放入时新建调查板';
    for(const select of root.querySelectorAll<HTMLSelectElement>('.rhine-evidence-target select')){
      select.replaceChildren();
      const addOption=(value:string,label:string)=>{const option=node('option','',label) as HTMLOptionElement;option.value=value;select.append(option);};
      addOption('auto',context.ready?autoTitle:'正在读取调查板…');
      for(const board of context.boards)addOption(board.id,board.title);
      if(evidenceTarget!=='auto'&&!context.boards.some(board=>board.id===evidenceTarget))addOption(evidenceTarget,'目标调查板不可用 · 请重新选择');
      select.value=evidenceTarget;select.disabled=!context.ready;
      select.title=select.selectedOptions[0]?.textContent||'';
    }
    $('.rhine-agent-board-context').textContent=working?`Agent 工作板：${working.title}`:'新建或延续调查，由 Agent 判断';
  }
  function pinToBoard(source: ArchiveSource) {
    if(!investigationContext.ready){toast('正在读取调查板，请稍候再放入证据盒。');return;}
    const target=evidenceTarget==='auto'?(investigationContext.workingId||investigationContext.selectedId):evidenceTarget;
    if(target&&!investigationContext.boards.some(board=>board.id===target)){toast('目标调查板已不可用，请重新选择证据盒归属。');return;}
    void investigation?.stageSource(source,target).catch(error => toast(error?.message || '资料尚未放入证据盒'));
  }
  function mergeSources(animate = true) { return performancePanel.capture.measureWork('mergeSources', () => mergeSourcesBody(animate)); }
  function mergeSourcesBody(animate: boolean) {
    uiUpdates.sourceMerges++;
    activitySources = undefined;
    discoveredSources = mergeSourcesInOrder(discoveredSources, [...snapshot.sources || [], ...manualSources]);
    sources = mergeSourcesInOrder(sources, discoveredSources.filter(belongsOnShelf));
    const signature = JSON.stringify(sources);
    scene?.setInvestigation(snapshot);
    syncArchiveSources();
    if (signature !== sourceSignature) {
      sourceSignature = signature;
      scene?.setSources(sources, animate);
      renderDesk();
      if (selectedSource) { updateReaderAnnotations(); updateReaderSave(); }
      if (!log.hidden) renderLog();
      if (!rackIndex.hidden) renderRackIndex();
    }
    for (const selector of ['.rhine-desk-count', '.rhine-location-count', '.rhine-rack-count']) $(selector).textContent = String(sources.length).padStart(2, '0');
    $('.rhine-location-button').setAttribute('aria-label', location === 'desk' ? '镜头移回检索阵列' : `镜头右移到调查档案架，已有 ${sources.length} 份资料`);
  }
  function addToDesk(source: ArchiveSource, notify = true) {
    const session=snapshot.sessionId;
    void archiveRack.save(source).then(()=>{
      if(!disposed&&session===snapshot.sessionId&&notify)toast('资料已收入档案架，Agent 下次推理时会收到查看提醒。');
    }).catch(()=>{});
  }
  function updateReaderSave() {
    const saved = selectedSource && sources.some(s => sameSource(s, selectedSource!) && s.saved);
    const saveButton = $<HTMLButtonElement>('.rhine-read-save');
    const pending = selectedSource && archiveRack.isPending(selectedSource);
    saveButton.textContent = pending ? '↻ 重试同步到档案架' : saved ? '✓ 已收藏到档案架' : '＋ 收藏到档案架';
    saveButton.disabled = Boolean(saved && !pending);
  }
  function pagination(target: HTMLElement, page: number, count: number, change: (page: number) => void) {
    target.replaceChildren();
    const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
    if (pages <= 1) return;
    const previous = button('←', 'rhine-page-button', () => change(page - 1), '上一页');
    const next = button('→', 'rhine-page-button', () => change(page + 1), '下一页');
    previous.disabled = page <= 0;
    next.disabled = page >= pages - 1;
    target.append(previous, node('span', '', `${String(page + 1).padStart(2, '0')} / ${String(pages).padStart(2, '0')}`), next);
  }
  function focusShelf(id: string | null, page = deskPage) {
    shelfSelected = id;
    deskPage = page;
    renderDesk();
  }
  function setShelfPage(page: number) {
    setFollowAgent(false);
    closeReader(false);
    deskPage = Math.max(0, Math.min(page, Math.max(0, Math.ceil(sources.length / SHELF_PAGE_SIZE) - 1)));
    shelfSelected = sources[deskPage * SHELF_PAGE_SIZE]?.id || null;
    scene?.setShelfPage(deskPage);
    renderDesk();
  }
  function shelfQuery() { return $<HTMLInputElement>('.rhine-shelf-filter').value.trim().toLocaleLowerCase(); }
  function chooseShelfSource(id: string) {
    setFollowAgent(false);
    const target = sources.findIndex(source => source.id === id);
    if (target < 0) return;
    const current = sources.findIndex(source => source.id === shelfSelected);
    if (scene) scene.browseShelf(target - Math.max(0, current));
    else focusShelf(id, Math.floor(target / SHELF_PAGE_SIZE));
  }
  function revealChoice(list: HTMLElement, row: HTMLElement) {
    if (!list.getClientRects().length) return;
    const bounds = list.getBoundingClientRect(), selected = row.getBoundingClientRect();
    // Scroll only this list; scrollIntoView can move the scaled scene and modal ancestors.
    const scale = bounds.height / list.clientHeight || 1;
    if (selected.top < bounds.top) list.scrollTop -= (bounds.top - selected.top) / scale;
    else if (selected.bottom > bounds.bottom) list.scrollTop += (selected.bottom - bounds.bottom) / scale;
  }
  function browseShelf(direction: number) {
    const query = shelfQuery();
    const choices = query ? sources.filter(source => matchesSource(source, query)) : sources;
    if (!choices.length) return;
    const index = choices.findIndex(source => source.id === shelfSelected);
    const next = index < 0 ? direction < 0 ? choices.length - 1 : 0 : (index + direction + choices.length) % choices.length;
    chooseShelfSource(choices[next].id);
  }
  function renderDesk() { return performancePanel.capture.measureWork('renderDesk', renderDeskBody); }
  function renderDeskBody() {
    const list = $('.rhine-desk-list');
    const query = shelfQuery();
    const previousSelected = list.dataset.selected;
    const retainFocus = list.contains(document.activeElement);
    deskPage = Math.min(deskPage, Math.max(0, Math.ceil(sources.length / SHELF_PAGE_SIZE) - 1));
    const pageSources = sources.slice(deskPage * SHELF_PAGE_SIZE, (deskPage + 1) * SHELF_PAGE_SIZE);
    const visible = query ? sources.filter(source => matchesSource(source, query)) : pageSources;
    $('.rhine-rack-range').textContent = query ? `全部档案 · 匹配 ${visible.length} / ${sources.length} 份` : sources.length ? `本架 ${deskPage * SHELF_PAGE_SIZE + 1}–${Math.min(sources.length, (deskPage + 1) * SHELF_PAGE_SIZE)} / 共 ${sources.length} 份资料` : 'Agent 读过或手动收藏后入架';
    $('.rhine-shelf-clear').hidden = !query;
    $('.rhine-rack-directory').firstChild!.textContent = `全部资料目录 · ${sources.length} `;
    if (!pageSources.some(source => source.id === shelfSelected)) shelfSelected = pageSources[0]?.id || null;
    const focused = sources.find(source => source.id === shelfSelected);
    $('.rhine-shelf-number').textContent = focused ? `已选 S-${String(sourceNumber(focused)).padStart(3, '0')} / ${shelfSlot(sources.indexOf(focused)).level === 0 ? '下层' : '上层'}` : 'NO SOURCES YET';
    $('.rhine-shelf-title').textContent = focused?.title || '留一个位置，给下一条线索。';
    $('.rhine-shelf-meta').textContent = focused ? `${kind(focused)} / ${origin(focused)} / ${state(focused)}${focused.saved ? ' / 已收藏' : ''}` : '';
    $('.rhine-shelf-excerpt').textContent = focused?.excerpt || (focused ? '抽取档案，查看完整原文和 Agent 实际读过的段落。' : 'Agent 实际读过或你主动收藏的资料，留在这里供回查。');
    $<HTMLButtonElement>('.rhine-shelf-open').disabled = !focused;
    $<HTMLButtonElement>('.rhine-shelf-stage').disabled = !focused;
    for (const selector of ['.rhine-shelf-prev', '.rhine-shelf-next']) $<HTMLButtonElement>(selector).disabled = visible.length < 2;
    const ids = new Set(visible.map(source => source.id));
    for (const [id, row] of shelfChoiceNodes) if (!ids.has(id)) { row.remove(); shelfChoiceNodes.delete(id); }
    list.querySelector('.rhine-empty')?.remove();
    visible.forEach((source, position) => {
      const index = sources.indexOf(source), level = shelfSlot(index).level === 0 ? '下层' : '上层';
      let slot = shelfChoiceNodes.get(source.id);
      if (!slot) {
        slot = button('', 'rhine-desk-item rhine-source-choice', () => chooseShelfSource(source.id));
        slot.dataset.sourceId = source.id;
        shelfChoiceNodes.set(source.id, slot);
      }
      updateSourceChoice(slot, source, sourceNumber(source), `${query ? `第 ${Math.floor(index / SHELF_PAGE_SIZE) + 1} 架 · ` : ''}${level}`);
      slot.dataset.level = String(shelfSlot(index).level);
      slot.dataset.saved = String(Boolean(source.saved));
      slot.classList.toggle('is-selected', source.id === shelfSelected);
      slot.setAttribute('aria-pressed', String(source.id === shelfSelected));
      if (list.children[position] !== slot) list.insertBefore(slot, list.children[position] || null);
    });
    if (!visible.length) list.append(node('p', 'rhine-empty', query ? '没有匹配的档案，试试更短的标题或清除筛选。' : 'Agent 实际读过或你主动收藏的资料，会按入架顺序显示在这里。'));
    list.dataset.selected = shelfSelected || '';
    if (previousSelected !== list.dataset.selected && location === 'desk') {
      const chosen = shelfSelected && shelfChoiceNodes.get(shelfSelected);
      if (chosen) { revealChoice(list, chosen); if (retainFocus) chosen.focus({ preventScroll: true }); }
    }
    const controls = $('.rhine-desk-pagination');
    controls.hidden = Boolean(query);
    const pages = Math.max(1, Math.ceil(sources.length / SHELF_PAGE_SIZE));
    if (!controls.children.length) controls.append(
      button('← 上一架', 'rhine-page-button', () => setShelfPage(deskPage - 1), '上一架资料'),
      node('span'), button('下一架 →', 'rhine-page-button', () => setShelfPage(deskPage + 1), '下一架资料'));
    (controls.firstElementChild as HTMLButtonElement).disabled = deskPage === 0;
    (controls.lastElementChild as HTMLButtonElement).disabled = deskPage === pages - 1;
    controls.querySelector('span')!.textContent = `${String(deskPage + 1).padStart(2, '0')} / ${String(pages).padStart(2, '0')}`;
    $('.rhine-shelf-report').hidden = !snapshot.answer;
  }
  const rackNodes = new Map<string, HTMLButtonElement>();
  function renderRackIndex() { return performancePanel.capture.measureWork('renderRackIndex', renderRackIndexBody); }
  function renderRackIndexBody() {
    const query = $<HTMLInputElement>('.rhine-rack-filter').value.trim().toLocaleLowerCase();
    const matches = sources.filter(source => matchesSource(source, query));
    const list = $('.rhine-rack-index-list');
    const visibleIds = new Set(matches.map(source => source.id));
    for (const [id, row] of rackNodes) if (!visibleIds.has(id)) { row.remove(); rackNodes.delete(id); }
    list.querySelector('.rhine-empty')?.remove();
    matches.forEach((source, index) => {
      let row = rackNodes.get(source.id);
      if (!row) {
        row = button('', 'rhine-rack-index-item', () => { void openSource(sources.find(item => item.id === source.id) || source, 'rack'); });
        row.append(node('small'), node('strong'), node('span'));
        row.dataset.sourceId = source.id;
        rackNodes.set(source.id, row);
      }
      row.querySelector('small')!.textContent = `S-${String(sourceNumber(source)).padStart(3, '0')}`;
      row.querySelector('strong')!.textContent = source.title;
      row.querySelector('span')!.textContent = `${kind(source)} · ${origin(source)} · ${state(source)} ↗`;
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    });
    if (!matches.length) list.append(node('p', 'rhine-empty', sources.length ? '没有匹配的资料，换一个关键词试试。' : 'Agent 已读或你手动收藏的资料，会在这里按入架顺序显示。'));
    $('.rhine-rack-index-count').textContent = `显示 ${matches.length} / ${sources.length} 份资料 · 点击标题打开原文`;
  }
  function openRackIndex() {
    showPanel(rackIndex); renderRackIndex(); $('.rhine-rack-filter').focus();
  }
  function renderResults() { return performancePanel.capture.measureWork('renderResults', renderResultsBody); }
  function renderResultsBody() {
    $('.rhine-index-provenance').textContent = searchMode === 'cloud' ? 'PRTS / CLOUD RETRIEVAL' : 'PRTS / LOCAL CORPUS';
    $('.rhine-search-connection').textContent = searchBusy ? 'RETRIEVING / 检索中' : searchMode === 'cloud' ? 'CLOUD / 云端资料' : 'LOCAL / 本地资料';
    $('.rhine-search-cancel').hidden = !searchBusy;
    $<HTMLButtonElement>('.rhine-search-submit').disabled = searchBusy;
    $<HTMLButtonElement>('.rhine-search-submit').textContent = searchBusy ? '正在检索…' : '检索资料 ↵';
    const filters = $('.category-filters');
    filters.replaceChildren();
    ['全部资料', ...ARCHIVE_LANES].forEach((label, index) => filters.append(button(label, resultFilter === index - 1 ? 'active' : '', () => { resultFilter = index - 1; resultsPage = 0; renderResults(); })));
    const matching = resultFilter < 0 ? results : results.filter(source => archiveLane(source) === resultFilter);
    resultsPage = Math.min(resultsPage, Math.max(0, Math.ceil(matching.length / PAGE_SIZE) - 1));
    const list = $('.rhine-result-list');
    list.replaceChildren();
    const queryLabel = searchQuery ? `「${searchQuery}」` : '资料目录';
    $('.rhine-result-summary').textContent = searchBusy ? `正在检索${queryLabel}…` : searchError || `${searchMode === 'cloud' ? '云端' : '本地'} · ${queryLabel} · 已载入 ${results.length} 份资料${searchWarning ? ` · ${searchWarning}` : ''}`;
    if (!matching.length && !searchBusy) list.append(node('p', 'rhine-empty', searchError ? '调整设置后可重新检索。' : searchMode === 'cloud' && !searchQuery ? '输入问题，再点击检索资料。云端检索由你手动开始。' : '没有找到匹配资料。试试人物名称、活动名称，或更短的关键词。'));
    matching.slice(resultsPage * PAGE_SIZE, (resultsPage + 1) * PAGE_SIZE).forEach((source, index) => {
      const row = node('article', 'rhine-result-item');
      const open = button('', 'rhine-result-open', () => { void openSource(source); });
      open.dataset.sourceId = source.id;
      open.append(node('span', 'rhine-result-number', `${String(resultsPage * PAGE_SIZE + index + 1).padStart(3, '0')} / ${kind(source)}`), node('strong', '', source.title), node('p', '', (source.excerpt || '打开查看原文').slice(0, 200)));
      const details = node('div', 'rhine-result-meta');
      details.append(node('span', '', `${origin(source)}${hasLocator(source) ? ' · 可读取原文' : ' · 返回片段'}`));
      details.append(button('＋ 收入档案架', '', () => addToDesk(source)));
      details.append(button('＋ 放入重点证据盒', 'rhine-result-pin', () => pinToBoard(source)));
      row.append(open, details);
      list.append(row);
    });
    const controls = $('.rhine-result-pagination');
    pagination(controls, resultsPage, matching.length, page => { resultsPage = page; renderResults(); });
    if (searchCursor) {
      const more = button(searchBusy ? '正在载入…' : '载入更多资料 ↓', 'rhine-load-more', () => { void search(true); });
      more.disabled = searchBusy;
      controls.append(more);
    }
  }
  async function search(more = false, reveal = true) {
    if(reveal)setFollowAgent(false);
    const query = more ? searchQuery : input.value.trim();
    let request: Record<string, unknown>;
    try { request = more ? searchRequest : manualSearch.request(query); }
    catch (error) { searchError = plainError(error); renderResults(); input.focus(); return; }
    searchController?.abort();
    const controller = new AbortController();
    searchController = controller;
    searchBusy = true;
    searchError = ''; searchWarning = '';
    searchMode = manualSearch.mode; searchRequest = request;
    searchQuery = query;
    if (!more) { results = []; resultsPage = 0; resultFilter = -1; searchCursor = undefined; searchDataVersion = undefined; }
    if (reveal) showPanel(resultsPanel);
    syncModalState();
    renderResults();
    renderStatus();
    try {
      const response = await monitoredApi(searchMode === 'cloud' ? 'archive.cloud-search' : 'archive.search', { ...request, ...(more && searchCursor ? { after: searchCursor, data_version: searchDataVersion } : {}) }, controller.signal);
      if (disposed || controller !== searchController || controller.signal.aborted) return;
      if (response?.ok === false || response?.error) throw new Error(response?.error?.message || response?.error || '资料检索未完成');
      const data = response?.sources ? response : response?.response?.sources ? response.response : response?.data || response;
      searchWarning = (data?.warnings || []).map((item: any) => typeof item === 'string' ? item : item.message || '').filter(Boolean).join('；');
      const incoming: ArchiveSource[] = Array.isArray(data?.sources) ? data.sources : [];
      const previousCount = results.length;
      const unique = new Map((more ? results : []).map(s => [sourceKey(s), s]));
      for (const source of incoming) unique.set(sourceKey(source), { ...source, dataVersion: source.dataVersion || data.data_version });
      results = [...unique.values()];
      catalogueLoaded = true;
      if (!more && reveal) $<HTMLDetailsElement>('.rhine-search-advanced').open = false;
      syncArchiveSources();
      if (more) resultsPage = Math.floor(previousCount / PAGE_SIZE);
      searchCursor = data?.page?.has_more ? data.page.next_after || data.page.next_cursor || data.page.after : undefined;
      searchDataVersion = data?.data_version || searchDataVersion;
    } catch (error) {
      if (!disposed && controller === searchController && !controller.signal.aborted) {
        searchError = `检索未完成：${plainError(error)}`;
        toast(`检索未完成：${plainError(error)}`);
      }
    } finally {
      if (!disposed && controller === searchController) {
        searchBusy = false;
        renderResults();
        renderStatus();
      }
    }
  }
  let readerLines: ReaderLine[] = [];
  let returnedReader: { text: string; status: string; label: string } | undefined;
  function renderReturnedSource(source: ArchiveSource) {
    const page = source.origin === 'web' && typeof source.content === 'string';
    const text = page ? source.content! : source.excerpt || '本条来源未返回文本片段。';
    const label = page ? '网页返回内容' : source.origin === 'web' ? '联网检索摘要' : source.origin === 'cloud' ? '云端返回片段' : '来源返回片段';
    const status = page ? source.contentTruncated ? '网页内容已被工具截断，以下为本次实际返回的部分。' : '以下为 Agent 本次收到的网页内容。'
      : source.origin === 'web' ? '当前显示返回摘要；网页正文将在抓取成功后提供。' : '当前提供检索返回的片段。';
    if (returnedReader?.text === text && returnedReader.status === status && returnedReader.label === label) return;
    returnedReader = { text, status, label };
    const body=node('div','rhine-excerpt-text rhine-markdown');renderReportMarkdown(body,text);
    readerBody.replaceChildren(node('div', 'rhine-excerpt-label', label), body);
    $('.rhine-reader-status').textContent = status;
  }
  function openSource(source: ArchiveSource, returnTo: ReadingOriginKind | null = null) {
    cancelAnimationFrame(originRestoreFrame); setFollowAgent(false);
    const kind = returnTo || (!resultsPanel.hidden ? 'search' : !rackIndex.hidden ? 'rack' : !report.hidden ? 'report' : !basket.hidden ? 'basket' : !log.hidden ? 'log' : location);
    const origin = readerOrigin || captureReadingOrigin(root, { kind, location, sessionId: snapshot.sessionId, sourceId: source.id, arrayExpanded: arrayListExpanded });
    return readerMeasure('open', () => openSourceBody(source, origin));
  }
  async function openSourceBody(source: ArchiveSource, returnOrigin: ReadingOrigin) {
    if (disposed || returnOrigin.sessionId !== snapshot.sessionId) return;
    if (panels.some(panel => !panel.hidden)) { closeModals(() => { void openSourceBody(source, returnOrigin); }); return; }
    if (location === 'board') setLocation('archive');
    source = resolveReadingSource(source, sources.find(item => sameSource(item, source)) || archiveSources.find(item => sameSource(item, source)));
    lastFocus = returnOrigin.focus;
    cancelReaderPosition(); readerAnnotationSignature = ''; readerChipsSignature = '';
    readController?.abort(); selectedSource = source;
    readerOrigin = returnOrigin; readerReturn = returnOrigin.kind;
    const label = readingOriginLabel(returnOrigin.kind, investigationReturn.kind);
    $('.rhine-reader-back-report').hidden = false;
    $('.rhine-reader-back-report').textContent = `${label} ↗`;
    $('.rhine-close-reader').setAttribute('aria-label', label);
    $('[data-action="back"] span').textContent = label;
    $('[data-action="back"]').setAttribute('aria-label', `${label}（Esc）`);
    readerCursor = undefined;
    readerVersion = source.dataVersion;
    readerBusy = false;
    for (const panel of panels) panel.hidden = true;
    reader.hidden = false;
    $('#object-id').textContent = `S-${String(Math.max(1, sourceNumber(source))).padStart(3, '0')}`;
    root.classList.add('has-reader');
    if (location === 'archive') scene?.selectArchiveSource(archiveSources.find(item => sameSource(item, source))?.id || source.id);
    syncMode();
    $('.rhine-reader-title').textContent = source.title;
    $('.rhine-reader-meta').textContent = `${kind(source)} / ${origin(source)} / ${state(source)}`;
    const provenance = $('.rhine-reader-provenance');
    provenance.replaceChildren();
    const identity = source.documentId || source.sourceRef || source.documentUid;
    if (identity) provenance.append(node('span', '', identity));
    if (source.dataVersion) provenance.append(node('span', '', `版本 ${source.dataVersion}`));
    if (source.url) {
      try {
        const url = new URL(source.url);
        if (url.protocol === 'https:' || url.protocol === 'http:') {
          const link = node('a', '', '访问原始来源 ↗');
          link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; provenance.append(link);
        }
      } catch { /* A malformed source URL does not affect reading its returned text. */ }
    }
    updateReaderSave();
    readerBody.replaceChildren();
    returnedReader = undefined; readerLines = [];
    // The emptied scroll container resets naturally; avoid forcing its layout here.
    $('.rhine-reader-status').textContent = '';
    $('.rhine-reader-more').hidden = true;
    scene?.select(source.id);
    renderDesk();
    updateReaderAnnotations();
    pendingDetailFocus = $('.rhine-reader-title');
    if (reducedMotion.matches || !scene) { pendingDetailFocus.focus({ preventScroll: true }); pendingDetailFocus = null; }
    if (!hasLocator(source)) {
      renderReturnedSource(source);
      readerPosition = { source }; scheduleReaderPosition();
      return;
    }
    await loadReader(false, readerStartLine(source));
  }
  function updateReaderAnnotations(addedRows?: readonly HTMLElement[]) {
    const selected = selectedSource;
    if (!selected) return;
    readerMeasure('annotations', () => {
      const source = resolveReadingSource(selected, sources.find(s => sameSource(s, selected)));
      if (!hasLocator(source)) renderReturnedSource(source);
      const meta = $('.rhine-reader-meta'), label = `${kind(source)} / ${origin(source)} / ${state(source)}`;
      if (meta.textContent !== label) meta.textContent = label;
      const chips = $('.rhine-reader-ranges');
      const ranges = source.readRanges || [];
      const hits = source.readingRange ? [source.readingRange] : source.ranges || (source.lineStart ? [{ start: source.lineStart, end: source.lineEnd || source.lineStart }] : []);
      const signature = JSON.stringify([ranges, hits]);
      const chipsSignature = `${hasLocator(source)}:${signature}`;
      if (chipsSignature !== readerChipsSignature) {
        const fragment = document.createDocumentFragment();
        const jump = (start: number) => {
          cancelReaderPosition();
          const row = [...readerBody.querySelectorAll<HTMLElement>('.rhine-reader-line')].find(row=>Number(row.dataset.line)<=start&&Number(row.dataset.lineEnd||row.dataset.line)>=start);
          if (row) { row.scrollIntoView({ block: 'center', behavior: reducedMotion.matches ? 'instant' : 'smooth' }); return; }
          readController?.abort(); readerBusy = false; readerCursor = undefined;
          void loadReader(false, Math.max(1, start - 3));
        };
        if (hasLocator(source)) fragment.append(button('从头阅读', '', () => jump(1)));
        if (source.readingRange) fragment.append(button(`引用位置 L${source.readingRange.start}–${source.readingRange.end}`, '', () => jump(source.readingRange!.start)));
        ranges.slice(0, 12).forEach(range => fragment.append(button(`Agent 已读 L${range.start}–${range.end}`, 'rhine-read-range', () => jump(range.start))));
        if (!ranges.length && !source.readingRange) hits.slice(0, 8).forEach(range => fragment.append(button(`相关位置 L${range.start}–${range.end}`, '', () => jump(range.start))));
        chips.replaceChildren(fragment); readerChipsSignature = chipsSignature;
      }
      // Unchanged receipts only annotate new rows; preserve existing DOM and selection.
      const rows = signature === readerAnnotationSignature ? addedRows || []
        : [...readerBody.querySelectorAll<HTMLElement>('.rhine-reader-line'), ...(addedRows?.filter(row => !row.isConnected) || [])];
      for (const row of rows) {
        const line = Number(row.dataset.line), end = Number(row.dataset.lineEnd || row.dataset.line);
        row.classList.toggle('is-agent-read', ranges.some(range => end >= range.start && line <= range.end));
        row.classList.toggle('is-hit', hits.some(range => end >= range.start && line <= range.end));
      }
      readerAnnotationSignature = signature;
    });
  }
  async function loadReader(more: boolean, startLine = 1) {
    const source = selectedSource;
    if (!source || readerBusy || !hasLocator(source)) return;
    if (!more) cancelReaderPosition();
    readController?.abort();
    const controller = new AbortController();
    readController = controller;
    readerBusy = true;
    const moreButton = $<HTMLButtonElement>('.rhine-reader-more');
    moreButton.disabled = true;
    $('.rhine-reader-status').textContent = more ? '正在读取下一段…' : '正在读取原文…';
    try {
      const payload = {
        locator: source.documentId ? { document_id: source.documentId } : { source_ref: source.sourceRef },
        ...(readerVersion ? { data_version: readerVersion } : {}),
        selection: { mode: 'document', ...(more && readerCursor ? { cursor: readerCursor } : startLine > 1 ? { start_line: startLine } : {}) },
        max_lines: 150, max_chars: 24000,
      };
      const result = await monitoredApi('read', payload, controller.signal);
      if (disposed || controller !== readController || source !== selectedSource || controller.signal.aborted) return;
      if (result?.ok === false || result?.error) throw new Error(result?.error?.message || result?.error || '资料暂时无法读取');
      const data = result?.response || result;
      const lines: ReaderLine[] = data?.content?.lines || [];
      if (!Array.isArray(lines)) throw new Error('资料响应格式不正确');
      readerVersion = data?.data_version || readerVersion;
      const finishPresent = performancePanel.capture.beginWork('reader-present');
      try {
        readerMeasure('dom', () => {
          readerLines = more ? [...readerLines,...lines] : lines;
          const built = readerMeasure('build', () => renderSourceMarkdown(readerLines));
          updateReaderAnnotations(built);
          const rows = readerMeasure('body-patch', () => {
            // Preserve settled blocks and selections when another page is appended.
            built.forEach((row,index)=>{
              const previous=readerBody.children[index];
              if(!previous)readerBody.append(row);
              else if(!previous.isEqualNode(row))readerBody.replaceChild(row,previous);
            });
            while(readerBody.children.length>built.length)readerBody.lastElementChild!.remove();
            return [...readerBody.querySelectorAll<HTMLElement>('.rhine-reader-line')];
          });
          readerCursor = data?.page?.has_more ? data.page.next_cursor : undefined;
          moreButton.hidden = !readerCursor;
          const firstLine = readerBody.querySelector<HTMLElement>('.rhine-reader-line')?.dataset.line || '1';
          $('.rhine-reader-status').textContent = lines.length ? `L${firstLine}–${lines[lines.length - 1].line_number}${readerCursor ? ' · 下方继续读取' : ' · 已至文末'}` : '此范围没有可显示的正文。';
          const hit = !more && rows.find(row => row.classList.contains('is-hit'));
          if (!more) {
            readerPosition = { row: hit || undefined, source, controller, finish: finishPresent };
            scheduleReaderPosition();
          } else finishPresent?.(true, true);
        }, { lines: lines.length, append: more });
      } catch (error) { finishPresent?.(false, true); throw error; }
    } catch (error) {
      if (!disposed && controller === readController && !controller.signal.aborted) {
        $('.rhine-reader-status').textContent = `读取未完成：${plainError(error)}`;
        if (!more && source.excerpt) { const body=node('div','rhine-excerpt-text rhine-markdown');renderReportMarkdown(body,source.excerpt);readerBody.replaceChildren(node('div', 'rhine-excerpt-label', '原文读取失败 · 以下为检索返回片段'),body); }
        const retry = button('重试读取 ↻', 'rhine-retry', () => { retry.remove(); void loadReader(more, startLine); });
        readerBody.append(retry);
      }
    } finally {
      if (!disposed && controller === readController) { readerBusy = false; moreButton.disabled = false; }
    }
  }
  function extractSelection() {
    const selection = window.getSelection();
    const source = selectedSource;
    if (!selection || !selection.rangeCount || !source || !readerBody.contains(selection.anchorNode) || !readerBody.contains(selection.focusNode)) { toast('先在资料正文中选中一段文字，再点击摘录。'); return; }
    const range = selection.getRangeAt(0);
    const text = selection.toString().trim();
    if (!text) { toast('先在资料正文中选中一段文字。'); return; }
    if (text.length > 12000) { toast('单条摘录最多 12,000 字，请缩小选取范围。'); return; }
    const rows = [...readerBody.querySelectorAll<HTMLElement>('.rhine-reader-line')].filter(row => range.intersectsNode(row));
    if (extracts.some(item => sameSource(item.source, source) && item.text === text)) { toast('这段文字已经保存在摘录中。'); return; }
    if (extracts.length >= MAX_EXTRACTS) { toast(`最多保存 ${MAX_EXTRACTS} 条摘录，请先移除一些。`); return; }
    extracts.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, source: { ...source, dataVersion: readerVersion || source.dataVersion }, text, ...(rows.length ? { start: Number(rows[0].dataset.line), end: Number(rows[rows.length - 1].dataset.lineEnd || rows[rows.length - 1].dataset.line) } : {}) });
    addToDesk(source, false);
    persist(); renderBasket(); renderStatus();
    toast('摘录已保存，包含资料来源和可用的行号。');
  }
  function renderBasket() {
    $('.rhine-extract-count').textContent = String(extracts.length).padStart(2, '0');
    $('#saved-count').textContent = String(extracts.length).padStart(2, '0');
    $('.rhine-nav-extracts').setAttribute('aria-label', `查看收藏与 ${extracts.length} 条摘录`);
    $('.rhine-query-hint').textContent = extracts.length ? `本次提问将附上 ${extracts.length} 条摘录。` : '候选资料可直接阅读、收藏，或放入指定调查的证据盒。';
    const list = $('.rhine-basket-list');
    list.replaceChildren();
    if (!extracts.length) list.append(node('p', 'rhine-empty', '还没有摘录。打开一份资料，选中文字后点击“摘录选中文字”。'));
    extracts.forEach(extract => {
      const card = node('article', 'rhine-extract-card');
      const heading = node('div', 'rhine-extract-heading');
      const sourceLink=button(extract.source.title, 'rhine-extract-title', () => { void openSource(extract.source); });
      sourceLink.dataset.sourceId=extract.source.id;heading.append(sourceLink);
      heading.append(button('×', 'rhine-icon-button', () => { extracts = extracts.filter(e => e.id !== extract.id); persist(); renderBasket(); }, `移除摘录：${extract.source.title}`));
      card.append(heading, node('small', '', `${origin(extract.source)}${extract.start ? ` · L${extract.start}–${extract.end}` : ' · 返回片段'}`), node('blockquote', '', extract.text));
      list.append(card);
    });
    $<HTMLButtonElement>('.rhine-send-extracts').disabled = submissionBlocked() || !extracts.length;
  }
  function evidenceContext() {
    if (!extracts.length) return '';
    const blocks: string[] = [];
    for (const extract of extracts) {
      blocks.push(`[资料：${extract.source.title}]\n来源：${extract.source.documentId || extract.source.sourceRef || extract.source.url || extract.source.id}${extract.source.dataVersion ? `\n版本：${extract.source.dataVersion}` : ''}${extract.start ? `\n行号：${extract.start}–${extract.end}` : '\n范围：检索返回片段'}\n${extract.text}`);
    }
    return `\n\n以下是我从调查档案架选取的参考摘录。请将摘录作为资料，保留引用来源：\n\n${blocks.join('\n\n---\n\n')}`;
  }
  async function askAgent(extractsOnly = false) {
    if (options.agentAvailable === false) { toast('请在 Harness 会话中使用 Agent；本地预览可以直接检索和翻阅资料。'); return; }
    if (hostBlocked()) { toast('对话设置正在更新，请稍候再提问。'); return; }
    if (hostState?.canSubmit === false) { toast(hostState.error || '请先在对话设置中选择可用模型。'); return; }
    const query = agentInput.value.trim() || (extractsOnly && extracts.length ? '请根据这些摘录继续调查，整理其中的重要事实与联系，并列出引用来源。' : '');
    if (!query) { agentInput.focus(); toast('输入想调查的问题。'); return; }
    if (extracts.reduce((sum, extract) => sum + extract.text.length, 0) > 22000) { toast('摘录总量超过 22,000 字，请移除部分摘录后再发送。已保存的摘录会完整保留。'); return; }
    if (extracting) return;
    const submissionSession = snapshot.sessionId;
    extracting = true;
    $<HTMLButtonElement>('.rhine-agent-submit').disabled = true;
    $<HTMLButtonElement>('.rhine-ask-agent').disabled = true;
    renderBasket();
    renderStatus();
    try {
      await options.askAgent(query + evidenceContext());
      if (disposed || snapshot.sessionId !== submissionSession) return;
      agentInput.value = '';
      basket.hidden = true;
      resultsPanel.hidden = true;
      syncModalState();
      toast('调查已交给 Agent，候选资料进入检索阵列，Agent 读过后入架。');
    } catch (error) { if (!disposed && snapshot.sessionId === submissionSession) toast(`未能开始调查：${plainError(error)}`); }
    finally { if (!disposed && snapshot.sessionId === submissionSession) { extracting = false; $<HTMLButtonElement>('.rhine-agent-submit').disabled = false; $<HTMLButtonElement>('.rhine-ask-agent').disabled = false; renderBasket(); renderStatus(); } }
  }
  function renderLog() { return performancePanel.capture.measureWork('renderLog', renderLogBody); }
  function renderLogBody() {
    $('.rhine-log-status').textContent = snapshot.error || (snapshot.running ? '调查进行中。新资料进入检索阵列，Agent 读过后归入档案架。' : snapshot.query ? `本次调查：${snapshot.query}` : '尚未开始 Agent 调查。');
    const agentSources = snapshot.sources || [];
    const signature = JSON.stringify([snapshot.sessionId, agentSources]);
    if (signature !== logSourcesSignature) {
    logSourcesSignature = signature;
    const list = $('.rhine-log-sources');
    list.replaceChildren();
    agentSources.slice(-40).forEach(source => {
      const row = button('', 'rhine-log-source', () => { void openSource(source); });
      row.dataset.sourceId=source.id;
      row.append(node('span', '', state(source)), node('strong', '', source.title));
      list.append(row);
    });
    if (agentSources.length > 40) list.prepend(node('p', 'rhine-panel-description', `显示最近 40 份资料；完整的 ${agentSources.length} 份候选资料可在检索阵列翻阅。`));
    }
    renderRecords();
    const answer = $('.rhine-log-answer');
    if (answer.textContent !== (snapshot.answer || '')) answer.textContent = snapshot.answer || '';
  }
  function renderRecords() {
    const signature = JSON.stringify([snapshot.sessionId, snapshot.records, snapshot.hasMoreHistory, snapshot.loadingHistory, visibleRecordCount]);
    if (signature === logRecordsSignature) return;
    logRecordsSignature = signature;
    const container = $('.rhine-log-records');
    const records = snapshot.records || [];
    $('.rhine-log-records-heading').hidden = !records.length && !snapshot.hasMoreHistory;
    container.querySelector('.rhine-load-history')?.remove();
    if (!records.length) container.replaceChildren();
    const shown = records.slice(-visibleRecordCount);
    const activeIds = new Set(shown.map(record => record.id));
    for (const [id, element] of recordNodes) {
      if (!activeIds.has(id)) { element.remove(); recordNodes.delete(id); }
    }
    container.querySelector('.rhine-more-records')?.remove();
    if (shown.length < records.length) {
      container.prepend(button(`展开更早记录（共 ${records.length} 次） ↑`, 'rhine-more-records', () => { visibleRecordCount += 20; renderRecords(); }));
    }
    shown.forEach(record => {
      let details = recordNodes.get(record.id);
      if (!details) {
        details = node('details', 'rhine-log-record');
        const summary = node('summary', '');
        summary.append(node('span', 'rhine-record-state'), node('strong', 'rhine-record-tool'), node('span', 'rhine-record-query'));
        details.append(summary);
        details.addEventListener('toggle', () => {
          const current = (snapshot.records || []).find(item => item.id === record.id);
          if (!details!.open) { details!.querySelector('pre')?.remove(); return; }
          if (!details!.querySelector('pre')) details!.append(node('pre', 'rhine-record-text', current?.text || '等待工具返回内容…'));
        });
        recordNodes.set(record.id, details);
        container.append(details);
      }
      details.querySelector('.rhine-record-state')!.textContent = record.state === 'active' ? '进行中' : record.state === 'error' ? '未完成' : '已返回';
      details.querySelector('.rhine-record-tool')!.textContent = record.tool;
      details.querySelector('.rhine-record-query')!.textContent = record.query || '';
      const text = details.querySelector('pre');
      if (text && text.textContent !== record.text) text.textContent = record.text || '等待工具返回内容…';
    });
    if (snapshot.hasMoreHistory && options.loadHistory) {
      const history = button(snapshot.loadingHistory ? '正在载入更早的会话…' : '载入更早的会话记录 ↑', 'rhine-load-history', async () => {
        history.disabled = true;
        try { await options.loadHistory?.(); }
        catch (error) { if (!disposed) toast(`历史记录读取未完成：${plainError(error)}`); }
        finally { if (!disposed && history.isConnected) history.disabled = false; }
      });
      history.disabled = Boolean(snapshot.loadingHistory);
      container.prepend(history);
    }
  }
  function investigationKey() { return `${snapshot.sessionId}:${snapshot.investigationId || snapshot.question || ''}`; }
  function investigationTitle() { return (snapshot.question || '').split('\n\n以下是我从调查档案架选取的参考摘录。')[0].trim(); }
  function investigationComplete() { return !snapshot.running && snapshot.outcome === 'completed'; }
  function currentInvestigationSources() { return snapshot.turnSources || snapshot.sources || []; }
  function syncCompletionNotice() {
    $('.rhine-completion-notice').hidden = !investigationComplete() || !snapshot.answer || reportViewedKey === investigationKey()
      || panels.some(panel => !panel.hidden) || location !== 'desk' && !selectedSource;
  }
  function reportMeasure<T>(kind: string, work: () => T): T { return performancePanel.capture.measureWork(kind, work); }
  function reportTextContent(element: HTMLElement, text: string) { if (element.textContent !== text) element.textContent = text; }
  function scheduleReportPosition() {
    if (reportPositionFrame || disposed || !active || report.hidden) return;
    reportPositionFrame = requestAnimationFrame(() => { reportPositionFrame = 0; updateReportPosition(); });
  }
  function updateReportPosition() {
    if (disposed || !active || report.hidden) return;
    const body = $('.rhine-report-body');
    if (reportScrollPending !== undefined) {
      const next = reportScrollPending === 'end' ? reportMeasure('report-scroll-read', () => body.scrollHeight) : reportScrollPending;
      reportScrollPending = undefined;
      reportMeasure('report-scroll-write', () => { body.scrollTop = next; });
    }
    // Read the complete geometry snapshot before changing any text/attributes.
    const state = reportMeasure('report-position-read', () => {
      const rect = body.getBoundingClientRect(), scale = rect.width / body.offsetWidth || 1;
      const scrollable = body.scrollHeight - body.clientHeight, top = rect.top;
      reportScrollTop = body.scrollTop;
      const percent = scrollable > 2 ? Math.min(100, Math.round(reportScrollTop / scrollable * 100)) : 100;
      let activeHeading = reportHeadings[0]?.id || '';
      for (const item of reportHeadingNodes) if (item.element.getBoundingClientRect().top <= top + 100 * scale) activeHeading = item.heading.id;
      return { percent, activeHeading };
    });
    reportMeasure('report-position-write', () => {
      reportTextContent($('.rhine-report-position'), snapshot.running ? '回答仍在更新 · 可先阅读已生成内容' : state.percent >= 99 ? '已至文末' : `阅读位置 ${state.percent}%`);
      for (const { heading, link } of reportHeadingNodes) {
        const value = String(heading.id === state.activeHeading);
        if (link.getAttribute('aria-current') !== value) link.setAttribute('aria-current', value);
      }
    });
  }
  function renderReport() { return reportMeasure('renderReport', renderReportBody); }
  function renderReportBody() {
    clearTimeout(reportRenderTimer); reportRenderTimer = undefined;
    const changedInvestigation = reportInvestigationKey !== investigationKey(), body = $('.rhine-report-body');
    // A hidden report is prepared without layout reads. Visible updates read once before all DOM writes.
    const previous = reportMeasure('report-scroll-read', () => {
      if (changedInvestigation) return { top: 0, following: false };
      if (!active || report.hidden) return { top: reportScrollTop, following: false };
      const top = body.scrollTop;
      return { top, following: Boolean(reportText) && snapshot.running && body.scrollHeight - body.clientHeight - top < 56 };
    });
    if (changedInvestigation) {
      reportInvestigationKey = investigationKey(); reportScrollTop = 0;
      reportText = ''; reportSourceSignature = ''; reportTocSignature = '';
    }
    reportMeasure('report-header', () => {
      reportTextContent($('.rhine-report-title'), investigationTitle() || '调查报告');
      const completed = investigationComplete();
      reportTextContent($('.rhine-report-kicker'), completed ? 'INVESTIGATION COMPLETE / 调查完成' : snapshot.running ? 'LIVE REPORT / 正在生成' : 'RESEARCH RECORD / 调查记录');
      reportTextContent($('.rhine-report-status'), snapshot.error || (snapshot.running ? '内容随回答更新。你可以先阅读，或点右侧引用核对原文。' : completed ? '本轮调查已完成 · 点击目录跳转章节，点击引用查阅原文。' : snapshot.outcome === 'interrupted' ? '本轮调查已停止 · 以下保留停止前已返回的内容。' : '已返回的回答 · 来源可在右侧逐份查阅。'));
    });
    const text = snapshot.answer || '等待 Agent 返回调查内容…';
    if (reportText !== text) {
      reportHeadings = renderReportMarkdown(body, text, reportMeasure); reportText = text;
      reportScrollPending = previous.following ? 'end' : previous.top;
      reportMeasure('report-toc', () => {
        const signature = JSON.stringify(reportHeadings);
        if (signature !== reportTocSignature) {
          reportTocSignature = signature;
          const fragment = document.createDocumentFragment();
          reportHeadings.forEach((heading, index) => {
            const link = button('', 'rhine-report-toc-link', () => {
              const target = body.querySelector<HTMLElement>(`#${heading.id}`);
              if (target) {
                const bodyRect = body.getBoundingClientRect(), scale = bodyRect.width / body.offsetWidth || 1;
                const top = body.scrollTop + (target.getBoundingClientRect().top - bodyRect.top) / scale - 16;
                body.scrollTo({ top, behavior: reducedMotion.matches ? 'instant' : 'smooth' });
                target.tabIndex = -1; target.focus({ preventScroll: true });
              }
            });
            link.dataset.heading = heading.id; link.dataset.level = String(heading.level);
            link.append(node('small', '', String(index + 1).padStart(2, '0')), node('span', '', heading.label));
            fragment.append(link);
          });
          if (!reportHeadings.length) fragment.append(node('span', 'rhine-report-toc-empty', '正文'));
          $('.rhine-report-toc').replaceChildren(fragment);
        }
        // A streamed heading can replace its node without changing the TOC signature.
        reportHeadingNodes = reportHeadings.flatMap(heading => {
          const element = body.querySelector<HTMLElement>(`#${heading.id}`);
          const link = root.querySelector<HTMLButtonElement>(`.rhine-report-toc-link[data-heading="${heading.id}"]`);
          return element && link ? [{ heading, element, link }] : [];
        });
      });
    }
    reportMeasure('report-references', () => {
      const references = $('.rhine-report-sources');
      const cited = snapshot.reportSources || currentInvestigationSources().filter(source => source.state === 'cited');
      const signature = JSON.stringify(cited.map(source => [source.id, source.title, source.origin, source.state]));
      if (signature === reportSourceSignature) return;
      reportSourceSignature = signature;
      const fragment = document.createDocumentFragment();
      fragment.append(node('div', 'tiny-label', `REFERENCES / 引用 ${String(cited.length).padStart(2, '0')}`));
      cited.forEach((source, index) => {
        const reference = button('', 'rhine-report-source', () => { void openSource(source, 'report'); });
        reference.dataset.sourceId=source.id;
        reference.append(node('small', '', String(index + 1).padStart(2, '0')), node('strong', '', source.title), node('span', '', `${origin(source)} · 查看原文 ↗`));
        fragment.append(reference);
      });
      if (!cited.length) fragment.append(node('p', 'rhine-panel-description', snapshot.running ? '回答生成后，已引用的原文会列在这里。' : '本轮回答没有附带可定位的资料引用。'));
      references.replaceChildren(fragment);
    });
    // Preparing a hidden completed answer does not mark it as read.
    if (active && !report.hidden && investigationComplete()) reportViewedKey = investigationKey();
    scheduleReportPosition(); syncCompletionNotice();
  }
  function scheduleReport() {
    if (reportRenderTimer !== undefined) return;
    if (report.hidden && (snapshot.running || !snapshot.answer || reportText === snapshot.answer && reportInvestigationKey === investigationKey())) return;
    reportRenderTimer = window.setTimeout(() => { reportRenderTimer = undefined; if (!disposed) renderReport(); }, report.hidden || snapshot.running ? 180 : 0);
  }
  function openReport(returning = false) { return reportMeasure('report-open', () => openReportBody(returning)); }
  function openReportBody(returning: boolean) {
    if (!returning && document.activeElement instanceof HTMLElement && !report.contains(document.activeElement) && !readerReturn && !reader.contains(document.activeElement)) reportTrigger = document.activeElement;
    // Populate while hidden so parsing/patching cannot repeatedly flush visible report layout.
    renderReport(); reportMeasure('report-show', () => showPanel(report));
    if (investigationComplete()) reportViewedKey = investigationKey();
    syncCompletionNotice(); scheduleReportPosition(); reportMeasure('report-focus', () => $('.rhine-close-report').focus({ preventScroll: true }));
  }
  function panelReturnFocus(panel: HTMLElement) {
    if (panel === sessionPanel) return hostTrigger?.isConnected ? hostTrigger : $('.rhine-session-history');
    if (panel === rackIndex) return $('.rhine-rack-directory');
    if (panel === report) return reportTrigger?.isConnected && !reportTrigger.closest('[hidden]') ? reportTrigger : location === 'desk' ? $('.rhine-shelf-report') : $('.rhine-report-open');
    return $('.rhine-nav-index');
  }
  let logTrigger: HTMLElement | null = null;
  function openLog(trigger: HTMLElement, callId?: string) {
    logTrigger = trigger;
    showPanel(log); renderLog(); $('.rhine-close-log').focus();
    if (callId) {
      const index = (snapshot.records || []).findIndex(record => record.id === callId);
      if (index >= 0) {
        visibleRecordCount = Math.max(visibleRecordCount, snapshot.records!.length - index);
        renderRecords();
        const entry = recordNodes.get(callId);
        if (entry) { entry.open = true; entry.scrollIntoView({ block: 'nearest' }); }
      }
    }
  }
  function syncToolActivity() { return performancePanel.capture.measureWork('tool-activity', syncToolActivityBody); }
  function syncToolActivityBody() {
    const turn = `${snapshot.sessionId}:${snapshot.investigationId || ''}`;
    if (activityTurn !== turn) {
      activityTurn = turn; agentReadFocus = undefined;
      sourceMotion.dispose();
    }
    const next = latestReadFocus(snapshot, activitySources ??= mergeSourcesInOrder(snapshot.sources || [], archiveSources));
    const changed = Boolean(next && next.key !== agentReadFocus?.key);
    for(const operation of snapshot.operations||[]){
      if(operation.kind!=='read')continue;
      const key=`${turn}:${operation.id}`;
      if(!observedReads.has(key)&&!followAgent&&activityInitialized)unseenReads.add(key);
      observedReads.add(key);
    }
    if (next) agentReadFocus = next;
    else if (agentReadFocus) {
      const operation = snapshot.operations?.find(call => call.id === agentReadFocus?.operation.id);
      if (operation) agentReadFocus = { ...agentReadFocus, operation };
    }
    updateArchiveSelection(archiveSelected, archiveLaneIndex, false);
    renderFollowMode();
    if (followAgent && changed && next?.operation.state !== 'error' && activityInitialized && snapshot.running && active && !document.hidden && !selectedSource)
      sourceMotion.reveal($('.rhine-current-source'), reducedMotion.matches);
    activityInitialized = true;
    const activity = investigationActivity(snapshot);
    $('.rhine-tool-feed').hidden = !snapshot.running;
    $('.rhine-tool-total').textContent = activity.active.length ? `${activity.active.length} 项进行中` : `${activity.calls.length} 次调用`;
    const signature = JSON.stringify(activity.recent.map(call => [call.id, call.tool, call.state, call.query]));
    if (signature !== toolFeedSignature) {
      toolFeedSignature = signature;
      const list = $('.rhine-tool-feed-list');
      list.replaceChildren();
      if (!activity.recent.length) list.append(node('p', 'rhine-tool-wait', '等待 Agent 发起工具调用…'));
      for (const call of activity.recent) {
        const row = button('', 'rhine-tool-row', () => openLog(row, call.id));
        row.dataset.state = call.state;
        row.append(node('span', 'rhine-tool-state', call.state === 'active' ? '调用中' : call.state === 'error' ? '失败' : '已返回'),
          node('strong', 'rhine-tool-name', call.tool), node('span', 'rhine-tool-query', call.query || '查看调用详情'), node('span', 'rhine-tool-arrow', '↗'));
        list.append(row);
      }
    }
    return activity;
  }
  function renderStatus() { return performancePanel.capture.measureWork('renderStatus', renderStatusBody); }
  function renderStatusBody() {
    uiUpdates.status++;
    const activity = syncToolActivity();
    const searching = searchBusy || snapshot.searching;
    const running = searching || snapshot.running || extracting;
    const phase = snapshot.phase || (snapshot.searching ? ['corpus_read', 'cloud_inspect', 'web_fetch'].includes(snapshot.tool) ? 'reading' : 'searching' : snapshot.running ? 'synthesizing' : snapshot.error ? 'error' : snapshot.answer ? 'complete' : 'idle');
    const phases = { idle: '等待调查', searching: '检索资料', reading: '阅读原文', synthesizing: '整理线索', complete: '调查完成', error: '调查未完成' };
    const received = mergeSourcesInOrder([], currentInvestigationSources());
    const reads = received.filter(source => source.agentRead === true || source.state === 'read' || Boolean(source.readRanges?.length)).length;
    const citations = (snapshot.reportSources || received.filter(source => source.state === 'cited')).length;
    const completed = investigationComplete();
    const current = [...received, ...archiveSources].find(source => (!snapshot.activeDataVersion || source.dataVersion === snapshot.activeDataVersion) && (snapshot.activeDocumentId && source.documentId === snapshot.activeDocumentId || snapshot.activeSourceRef && source.sourceRef === snapshot.activeSourceRef));
    const manualSearch = searchBusy && !snapshot.running;
    const submitting = extracting && !snapshot.running;
    const operation = $('.rhine-case-operation');
    const operationLabel = submitting ? '正在提交问题' : manualSearch ? '正在检索资料库' : activity.label;
    const operationDetail = submitting ? '问题正在交给 Agent' : manualSearch ? searchQuery || '正在载入资料目录'
      : snapshot.running ? activity.detail
      : phase === 'reading' ? current?.title || '正在读取原文，完整返回内容可在过程记录中查看'
      : phase === 'searching' ? snapshot.query || '正在查找相关资料，结果会持续送入档案架'
      : phase === 'synthesizing' ? received.length ? `已收集 ${received.length} 份资料，正在整理回答` : '正在处理你的问题，回答生成后可直接阅读'
      : phase === 'complete' ? received.length ? `已查得 ${received.length} 份 · 已读 ${reads} 份 · 引用 ${citations} 份` : '回答已生成，可阅读下方回复或查看过程'
      : phase === 'error' ? snapshot.error || '本轮调查已停止，点此查看记录'
      : '输入问题，或自由检索和翻阅原文';
    root.classList.toggle('is-searching', searching);
    root.classList.toggle('is-running', running);
    root.dataset.phase = phase;
    scene?.setSearching(searchBusy);
    $('.rhine-case-label').textContent = completed ? 'INVESTIGATION COMPLETE' : snapshot.question || snapshot.query ? 'ACTIVE INVESTIGATION' : 'INVESTIGATION / READY';
    $('.rhine-case-phase').textContent = submitting ? '正在提交' : manualSearch ? '检索资料库' : phase === 'complete' && !completed ? '回答已返回' : snapshot.outcome === 'interrupted' ? '调查已停止' : snapshot.running ? activity.current ? '工具调用中' : '等待下一步' : phases[phase];
    $('.rhine-case-question').textContent = investigationTitle() || (snapshot.running ? snapshot.query : '') || (snapshot.answer ? '本次调查已归档。' : '从一个问题，开始调查。');
    $('.rhine-case-tool').textContent = operationLabel;
    $('.rhine-case-operation-text').textContent = operationDetail;
    const calling = Boolean(activity.current) || manualSearch;
    operation.classList.toggle('is-active', calling);
    operation.classList.toggle('is-waiting', !calling && (snapshot.running || submitting));
    operation.dataset.state = submitting ? 'submitting' : manualSearch ? 'searching' : phase;
    operation.title = `${operationLabel} · ${operationDetail}`;
    $('.rhine-found-count').textContent = String(received.length).padStart(2, '0');
    $('.rhine-read-count').textContent = String(reads).padStart(2, '0');
    $('.rhine-cited-count').textContent = String(citations).padStart(2, '0');
    $('.rhine-report-open').hidden = !activity.showReport;
    $('.rhine-shelf-report').hidden = !activity.showReport;
    const reportEntry = $('.rhine-report-open');
    reportEntry.dataset.state = completed ? 'complete' : snapshot.running ? 'running' : snapshot.outcome === 'interrupted' || snapshot.error ? 'error' : 'returned';
    $('.rhine-report-open-kicker').textContent = completed ? '✓ 调查完成 / REPORT READY' : snapshot.running ? 'LIVE REPORT / 正在生成' : snapshot.outcome === 'interrupted' ? '调查已停止 / 已返回内容' : 'RESEARCH REPORT / 已返回回答';
    $('.rhine-report-open strong').textContent = completed ? '阅读调查报告' : '查看已返回的回答';
    $('.rhine-report-open-meta').textContent = `本轮查得 ${received.length} 份资料 · ${citations} 份引用${completed ? ' · 随时核对原文' : ''}`;
    if (completed && snapshot.answer && lastCompletedKey !== investigationKey()) {
      lastCompletedKey = investigationKey();
      if (hasRenderedStatus) {
        for (const selector of ['.rhine-report-open', '.rhine-completion-notice']) $(selector).classList.add('is-new');
        $('.rhine-completion-announcement').textContent = '本轮调查已完成。调查报告已就绪，可以打开阅读并查阅引用原文。';
        clearTimeout(completionTimer);
        completionTimer = window.setTimeout(() => { if (!disposed) for (const selector of ['.rhine-report-open', '.rhine-completion-notice']) $(selector).classList.remove('is-new'); }, 6000);
      }
    }
    if (!completed) for (const selector of ['.rhine-report-open', '.rhine-completion-notice']) $(selector).classList.remove('is-new');
    hasRenderedStatus = true;
    syncCompletionNotice();
    $('.rhine-activity').hidden = location !== 'desk' || !running && !snapshot.error;
    $('.rhine-status-title').textContent = searching ? 'RETRIEVING ARCHIVES' : snapshot.running ? 'INVESTIGATION IN PROGRESS' : 'INVESTIGATION / PAUSED';
    $('.rhine-activity-query').textContent = snapshot.question || snapshot.query || '';
    $('.rhine-activity-detail').textContent = snapshot.error || `新资料持续入架 · 已收到 ${received.length} 份`;
    $('.rhine-session-id').textContent = (snapshot.sessionId || '').slice(0, 8).toUpperCase();
    renderAgentControls();
    refreshSnapshotPanels();
  }
  function refreshSnapshotPanels() {
    if (!log.hidden) renderLog();
    scheduleReport();
  }

  function renderAgentControls() { return performancePanel.capture.measureWork('agent-controls', () => {
    uiUpdates.host++;
    const available = options.agentAvailable !== false;
    $('.rhine-agent-availability').textContent = !available ? '在会话中启用' : hostBlocked() ? 'SESSION / UPDATING' : hostState?.canSubmit === false ? '请选择可用模型' : snapshot.running ? 'AGENT / WORKING' : 'AGENT / READY';
    $('.rhine-agent-hint').textContent = !available ? '本地预览可检索与翻阅；在 Harness 会话中向 Agent 提问。' : hostBlocked() ? '对话设置正在更新，输入的问题会保留。' : hostState?.canSubmit === false ? hostState.error || '打开上方对话设置，选择可用模型后开始调查。' : extracts.length ? `提问时会附上 ${extracts.length} 条摘录。` : snapshot.running ? '可以继续提问，问题会排队交给 Agent。' : '资料归入右侧档案架，可边查边读。';
    $<HTMLButtonElement>('.rhine-agent-submit').disabled = submissionBlocked();
    $<HTMLButtonElement>('.rhine-ask-agent').disabled = submissionBlocked();
    $<HTMLButtonElement>('.rhine-send-extracts').disabled = submissionBlocked() || !extracts.length;
    renderHostControls();
  }); }

  $('.rhine-nav-index').addEventListener('click', openIndex);
  $('.rhine-nav-board').addEventListener('click', () => setLocation('board'));
  for (const tab of root.querySelectorAll<HTMLButtonElement>('[data-zone]')) tab.addEventListener('click', () => setLocation(tab.dataset.zone as Location));
  $('.rhine-nav-rack').addEventListener('click', () => setLocation(location === 'desk' ? 'archive' : 'desk'));
  $('.rhine-manual-search').addEventListener('click', () => { if (agentInput.value.trim()) input.value = agentInput.value.trim(); openIndex(); if (input.value.trim() !== searchQuery) void search(); });
  $('.rhine-report-open').addEventListener('click', () => openReport());
  $('.rhine-completion-notice').addEventListener('click', () => openReport());
  $('.rhine-report-rack').addEventListener('click', () => setLocation('desk'));
  $('.rhine-rack-directory').addEventListener('click', openRackIndex);
  $('.rhine-rack-filter').addEventListener('input', renderRackIndex);
  $('.rhine-shelf-filter').addEventListener('input', () => { $('.rhine-desk-list').scrollTop = 0; renderDesk(); });
  $('.rhine-shelf-clear').addEventListener('click', () => { $<HTMLInputElement>('.rhine-shelf-filter').value = ''; renderDesk(); $('.rhine-shelf-filter').focus(); });
  $('.rhine-array-directory').addEventListener('click', openIndex);
  arrayToggle.addEventListener('click', () => setArrayListExpanded(true));
  $('.rhine-array-collapse').addEventListener('click', () => setArrayListExpanded(false, false, true));
  $('.rhine-close-rack-index').addEventListener('click', () => closeModals(() => $('.rhine-rack-directory').focus()));
  $('.rhine-reader-back-report').addEventListener('click', () => closeReader());
  $('.rhine-report-body').addEventListener('scroll', scheduleReportPosition, { passive: true });
  for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) readerBody.addEventListener(event, cancelReaderPosition, { passive: true });
  $('.rhine-report-body').addEventListener('click', event => {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a');
    if (!link) return;
    const href = link.getAttribute('href') || '';
    if (href.startsWith('#')) {
      event.preventDefault();
      let label = href.slice(1);
      try { label = decodeURIComponent(label); } catch { /* An incomplete streamed anchor remains plain navigation. */ }
      const heading = reportHeadings.find(item => `#${item.id}` === href || item.label === label);
      if (heading) root.querySelector<HTMLButtonElement>(`.rhine-report-toc-link[data-heading="${heading.id}"]`)?.click();
      return;
    }
    const source = archiveSources.find(item => item.url === href || item.sourceRef === href || item.documentId === href);
    if (source) { event.preventDefault(); void openSource(source, 'report'); }
  });
  $('.rhine-case-operation').addEventListener('click', () => openLog($('.rhine-case-operation')));
  $('.rhine-shelf-report').addEventListener('click', () => openReport());
  $('.rhine-close-report').addEventListener('click', () => closeModals(() => panelReturnFocus(report).focus()));
  $('.rhine-shelf-prev').addEventListener('click', () => browseShelf(-1));
  $('.rhine-shelf-next').addEventListener('click', () => browseShelf(1));
  for(const select of root.querySelectorAll<HTMLSelectElement>('.rhine-evidence-target select'))select.addEventListener('change',()=>{
    evidenceTarget=select.value;renderInvestigationContext();
  });
  $('.rhine-array-stage').addEventListener('click',()=>{const source=displayedArchiveSource;if(source)pinToBoard(source);});
  $('.rhine-follow-toggle').addEventListener('click',()=>{setFollowAgent(!followAgent);updateArchiveSelection(archiveSelected,archiveLaneIndex,false);});
  $('.rhine-shelf-stage').addEventListener('click',()=>{const source=sources.find(item=>item.id===shelfSelected);if(source)pinToBoard(source);});
  $('.rhine-shelf-open').addEventListener('click', () => { const source = sources.find(item => item.id === shelfSelected); if (source) void openSource(source); });
  $('.rhine-agent-form').addEventListener('submit', event => { event.preventDefault(); void askAgent(); });
  $('.rhine-session-mode').addEventListener('click', () => openHostPanel($('.rhine-session-mode')));
  $('.rhine-session-model').addEventListener('click', () => openHostPanel($('.rhine-session-model'), 'model'));
  $('.rhine-session-history').addEventListener('click', () => openHostPanel($('.rhine-session-history'), 'history'));
  $('.rhine-session-alert').addEventListener('click', () => openHostPanel($('.rhine-session-alert')));
  $('.rhine-session-new').addEventListener('click', () => { if (options.host) void runHostAction(() => options.host!.createSession(), true); });
  $('.rhine-close-session').addEventListener('click', () => closeModals(() => (hostTrigger?.isConnected ? hostTrigger : $('.rhine-session-history')).focus()));
  $('.rhine-session-refresh').addEventListener('click', () => { if (options.host) void runHostAction(() => options.host!.refresh()); });
  $('.rhine-session-retry').addEventListener('click', () => { if (hostRetry) void hostRetry(); else if (options.host) void runHostAction(() => options.host!.refresh()); });
  $('.rhine-session-create').addEventListener('click', () => { const mode = modeSelect.value || undefined; if (options.host) void runHostAction(() => options.host!.createSession(mode), true); });
  $('.rhine-mode-apply').addEventListener('click', () => {
    const mode = modeSelect.value;
    if (options.host && hostState?.modes.some(item => item.id === mode)) {
      const blank = hostState.blank && !hostState.running;
      void runHostAction(() => blank ? options.host!.selectMode(mode) : options.host!.createSession(mode), !blank);
    }
  });
  $('.rhine-model-apply').addEventListener('click', () => { const model = modelSelect.value; if (options.host && hostState?.models.some(item => item.id === model)) void runHostAction(() => options.host!.selectModel(model)); });
  $('.rhine-agent-cancel').addEventListener('click', () => { if (options.host && hostState?.running) void runHostAction(() => options.host!.cancel()); });
  modeSelect.addEventListener('change', renderHostChoice);
  modelSelect.addEventListener('change', renderHostChoice);
  $('.rhine-nav-close').addEventListener('click', options.close);
  $('.rhine-nav-extracts').addEventListener('click', () => { const open = basket.hidden; if (open) { showPanel(basket); renderBasket(); $('.rhine-close-basket').focus(); } else closeModals(); });
  $('.rhine-nav-log').addEventListener('click', () => { if (log.hidden) openLog($('.rhine-nav-log')); else closeModals(); });
  $('.rhine-location-button').addEventListener('click', () => setLocation(location === 'archive' ? 'desk' : 'archive'));
  $('.rhine-close-results').addEventListener('click', () => closeModals(() => $('.rhine-nav-index').focus()));
  $('.rhine-close-reader').addEventListener('click', () => closeReader());
  $('.rhine-close-basket').addEventListener('click', () => closeModals(() => $('.rhine-nav-extracts').focus()));
  $('.rhine-close-log').addEventListener('click', () => closeModals(() => (logTrigger || $('.rhine-nav-log')).focus()));
  $('[data-action="prev"]').addEventListener('click', () => navigateArchivePage(-1));
  $('[data-action="next"]').addEventListener('click', () => navigateArchivePage(1));
  $('[data-action="column-prev"]').addEventListener('click', () => navigateArchive('lane', -1));
  $('[data-action="column-next"]').addEventListener('click', () => navigateArchive('lane', 1));
  for (const open of root.querySelectorAll<HTMLElement>('[data-action="open"]')) open.addEventListener('click', openCurrentArchive);
  $('[data-action="back"]').addEventListener('click', () => closeReader());
  $('[data-action="inspect"]').addEventListener('click', openModelViewer);
  for (const panel of panels) panel.addEventListener('click', event => { if (event.target === panel) closeModals(() => panelReturnFocus(panel).focus()); });
  $('.rhine-read-save').addEventListener('click', () => { if (selectedSource) addToDesk(selectedSource); });
  $('.rhine-read-pin').addEventListener('click', () => { if (selectedSource) pinToBoard(selectedSource); });
  $('.rhine-extract-selection').addEventListener('mousedown', event => event.preventDefault());
  $('.rhine-extract-selection').addEventListener('click', extractSelection);
  $('.rhine-reader-more').addEventListener('click', () => { void loadReader(true); });
  $('.rhine-search-cancel').addEventListener('click', () => { searchController?.abort(); searchController = undefined; searchBusy = false; searchError = '检索已取消，可修改条件后重试。'; renderResults(); renderStatus(); });
  $('.rhine-query-form').addEventListener('submit', event => { event.preventDefault(); void search(); });
  $('.rhine-ask-agent').addEventListener('click', () => { agentInput.value = input.value; void askAgent(); });
  $('.rhine-send-extracts').addEventListener('click', () => { void askAgent(true); });
  const keydown = (event: KeyboardEvent) => {
    if (!active || disposed || viewer?.isOpen || event.defaultPrevented) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const editing = target && (target.matches('input, textarea, select') || target.isContentEditable);
    const modal = panels.find(panel => !panel.hidden);
    if (event.key === 'Tab' && modal) {
      const focusable = [...modal.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],summary,[tabindex="0"]')].filter(element => element.getClientRects().length && !element.closest('[hidden],[inert]'));
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (first && (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement)) || !event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement)))) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
      return;
    }
    if (event.key === '/' && !editing && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); openIndex(); return; }
    if (event.key === 'Escape') {
      if (event.isComposing) return;
      if (modal) { event.preventDefault(); closeModals(() => panelReturnFocus(modal).focus()); }
      else if (selectedSource) { event.preventDefault(); closeReader(); }
      else if (arrayListExpanded) { event.preventDefault(); setArrayListExpanded(false, false, true); }
      else if (location === 'board' && scene?.cancelBoardGesture()) { event.preventDefault(); }
      else if (location === 'board' && target?.closest('.rhine-evidence-tools') && boardPanel.handleEscape()) { event.preventDefault(); }
      else if (editing) { event.preventDefault(); target?.blur(); }
      else if (location === 'board' && boardPanel.handleEscape()) { event.preventDefault(); }
      else if (boardFullscreen) { event.preventDefault(); setBoardFullscreen(false); boardFullscreenButton.focus({ preventScroll: true }); }
      else if (location !== 'archive') { event.preventDefault(); setLocation('archive'); }
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && event.target === input) { event.preventDefault(); agentInput.value = input.value; void askAgent(); return; }
    if (editing || modal || selectedSource || event.isComposing) return;
    if (location === 'board') {
      if (boardPanel.handleShortcut(event)) event.preventDefault();
      return;
    }
    if (location === 'desk') {
      if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) { event.preventDefault(); browseShelf(event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1); }
      if (event.key === 'Enter' && (!target?.matches('button,a,summary') || target.classList.contains('rhine-desk-item'))) {
        const id = target?.dataset.sourceId;
        if (id && id !== shelfSelected) { event.preventDefault(); chooseShelfSource(id); return; }
        const source = sources.find(item => item.id === shelfSelected);
        if (source) { event.preventDefault(); void openSource(source); }
      }
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); navigateArchive('lane', event.key === 'ArrowLeft' ? -1 : 1); }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); navigateArchive('row', event.key === 'ArrowUp' ? -1 : 1); }
    if (event.key === 'Enter' && (!target?.matches('button,input,a,summary') || target?.dataset.sourceId)) { event.preventDefault(); const id = target?.dataset.sourceId; if (id && id !== archiveSelected) selectArchiveSource(id); else openCurrentArchive(); }
  };
  const readingKeydown = (event:KeyboardEvent) => {
    if(!active||disposed||root.hidden||viewer?.isOpen||event.defaultPrevented)return;
    if(investigation?.handleKeydown(event))event.stopImmediatePropagation();
  };
  document.addEventListener('keydown', readingKeydown, true);
  document.addEventListener('keydown', keydown);
  const motionChange = () => { scene?.setReducedMotion(reducedMotion.matches); stage.classList.toggle('reduce-motion', reducedMotion.matches); for (const control of [...Object.values(counters), ...Object.values(titles)]) { control.update({ animated: !reducedMotion.matches }); if (reducedMotion.matches) control.finish(); } if (reducedMotion.matches) { arrayListTransition.finish(); detailTransition.finish(); for (const transition of modalTransitions.values()) transition.finish(); } };
  reducedMotion.addEventListener('change', motionChange);
  loadSaved();
  mergeSources(false);
  renderBasket();
  renderDesk();
  renderStatus();
  unsubscribeHost = options.host?.subscribe(next => { if (!disposed) { hostState = next; renderAgentControls(); } });
  if (options.host) void runHostAction(() => options.host!.refresh());
  updateArchiveSelection(null, 0, false);
  syncMode();
  stage.classList.toggle('reduce-motion', reducedMotion.matches);
  root.dataset.location = location;
  void search(false, false);

  // Keep the moment loading began as the history baseline. Fast reads that
  // finish while the GLB loads are new activity, not historical playback.
  const sceneInitialSnapshot = snapshot;
  const sceneInitialSources = [...sources];
  void createRhineScene($('.rhine-scene'), {
    assetBase: options.assetBase,
    navigationLimiter,
    performanceProbe: performancePanel.capture,
    activitySince: Date.now(),
    reducedMotion: reducedMotion.matches,
    onSelect: id => { const source = sources.find(s => s.id === id); if (source) void openSource(source); },
    onArchiveSourceSelect: (id, lane, userInitiated) => {
      if (disposed || synchronizingScene) return;
      if (userInitiated) setFollowAgent(false);
      updateArchiveSelection(id, lane);
    },
    onArchiveSourceOpen: id => { const source = archiveSources.find(item => item.id === id); if (!disposed && source) void openSource(source); },
    onShelfSelect: (id, page) => { if (!disposed) focusShelf(id, page); },
    onInboxAnchor:value=>investigation?.setInboxAnchor(value),
    onLocationRequest: next => { setFollowAgent(false); setLocation(next); },
    onInboxOpen:()=>investigation?.openInbox(),
    onBoardSelect: (id, openEditor) => { if (!disposed) investigation?.select(id, openEditor); },
    onBoardMove: (id, x, y) => { if (!disposed) boardPanel.moveCard(id, x, y); },
    onBoardResize: (id, scale, x, y) => { if (!disposed) boardPanel.resizeCard(id, scale, x, y); },
    onBoardAnchors: frame => { if (!disposed) { boardFrame = frame; investigation?.setBoardFrame(frame); syncBoardToolbar(); } },
    onBoardToolRequest: () => { if (!disposed) boardPanel.toggleTools(boardToolPosition()); },
    onBoardToolChange: tool => { if (!disposed) syncBoardToolState(tool); },
    onBoardPlace: (template, position) => { if (!disposed) boardPanel.placeCard(template, position); },
    onBoardConnect: (from, to) => { if (!disposed) boardPanel.connectCards(from, to); },
    onDetailFrame: visibility => { if (!disposed) paintDetail(visibility); },
    onError: message => { if (!disposed) { root.classList.add('rhine-scene-unavailable'); setBoardFullscreen(false); $('.rhine-performance').textContent = 'ARCHIVE READING MODE'; toast(message); } },
  }).then(value => {
    if (disposed) { value.dispose(); return; }
    scene = value;
    scene.setFollowAgent(followAgent);
    syncReadingObject();
    scene.setBoardEditorInset(boardEditorInset);
    scene.setBoardCards(investigation?.getCards() || []);
    scene.setEvidenceInbox(investigation?.getInboxState()||{boardId:'',title:'',count:0,titles:[]},false);
    scene.selectBoardCard(boardPanel.stats().selected);
    synchronizingScene = true;
    try {
      const sameSession = sceneInitialSnapshot.sessionId === snapshot.sessionId;
      scene.setActive(active);
      scene.setInvestigation(sameSession ? sceneInitialSnapshot : snapshot);
      scene.setSources(sameSession ? sceneInitialSources : sources, false);
      scene.setArchiveSources(archiveSources);
      scene.setInvestigation(snapshot);
      if (sameSession) scene.setSources(sources, true);
      scene.setLocation(location);
      scene.setBoardFullscreen(boardFullscreen);
      scene.setSearching(searchBusy);
      if (archiveSelected) scene.selectArchiveSource(archiveSelected, false);
      scene.setShelfPage(deskPage);
      scene.setDetail(Boolean(selectedSource));
      if (selectedSource) scene.select(selectedSource.id);
      scene.setQuality(quality);
    } finally { synchronizingScene = false; syncBoardToolbar(); }
  }).catch(() => {
    if (!disposed) {
      root.classList.add('rhine-scene-unavailable');
      setBoardFullscreen(false);
      $('.rhine-performance').textContent = 'ARCHIVE READING MODE';
      toast('此浏览器暂时无法显示 3D 场景，仍可搜索、阅读与摘录资料。');
    }
  });

  return {
    update(next: InvestigationSnapshot) {
      if (disposed) return;
      const finishWork = performancePanel.capture.beginUiWork('snapshot-update', {
        sourceCount: next.sources?.length || 0, answerCharacters: next.answer?.length || 0,
        recordCount: next.records?.length || 0, running: Boolean(next.running), searching: Boolean(next.searching) });
      try {
      const changes = performancePanel.capture.measureWork('snapshot-classify', () => snapshotGate.read(next));
      const changedSession = changes.sessionChanged;
      snapshot = next;
      if (changedSession) {
        setBoardFullscreen(false);
        evidenceTarget='auto';contextSignature='';
        boardPanel.closeTools();
        void investigation?.setSession(next.sessionId);
        boardPanel.setSession(next.sessionId);
        searchController?.abort();
        searchController = undefined;
        searchBusy = false;
        for (const [panel, transition] of modalTransitions) {
          transition.dispose();
          panel.hidden = true;
          panel.dataset.transition = 'closed';
        }
        closeReader(false);
        setArrayListExpanded(false, true);
        results = []; resultsPage = 0; deskPage = 0; searchCursor = undefined; searchDataVersion = undefined;
        sources = []; discoveredSources = []; archiveSources = []; archiveSelected = null; shelfSelected = null;
        followAgent = true; unseenReads.clear(); observedReads.clear(); scene?.setFollowAgent(true);
        archiveLaneIndex = 0; columnMemory.fill(null); catalogueLoaded = false;
        sourceSignature = ''; input.value = ''; agentInput.value = ''; extracting = false;
        readerBody.replaceChildren(); $('.rhine-reader-title').textContent = '';
        $('.rhine-reader-provenance').replaceChildren(); $('.rhine-reader-ranges').replaceChildren();
        $('.rhine-report-body').textContent = ''; $('.rhine-report-sources').replaceChildren();
        $('.rhine-report-toc').replaceChildren();
        reportText = ''; reportSourceSignature = ''; reportTocSignature = ''; reportHeadings = [];
        reportHeadingNodes = []; reportScrollTop = 0; reportScrollPending = undefined;
        cancelAnimationFrame(reportPositionFrame); reportPositionFrame = 0;
        reportInvestigationKey = ''; reportViewedKey = ''; lastCompletedKey = ''; hasRenderedStatus = false; reportTrigger = null;
        clearTimeout(reportRenderTimer); reportRenderTimer = undefined;
        clearTimeout(completionTimer);
        $('.rhine-completion-announcement').textContent = '';
        shelfChoiceNodes.clear(); $('.rhine-desk-list').replaceChildren(); $<HTMLInputElement>('.rhine-shelf-filter').value = '';
        rackNodes.clear(); $('.rhine-rack-index-list').replaceChildren(); $<HTMLInputElement>('.rhine-rack-filter').value = '';
        $('.rhine-log-answer').textContent = ''; $('.rhine-log-sources').replaceChildren();
        searchQuery = ''; searchError = ''; searchWarning = ''; manualSearch.resetMode(); searchMode = 'local';
        scene?.setInvestigation(snapshot); scene?.setSources([], false); scene?.setArchiveSources([]);
        setLocation('archive'); updateArchiveSelection(null, 0, false); renderDesk();
        void search(false, false);
        visibleRecordCount = 20; recordNodes.clear(); $('.rhine-log-records').replaceChildren();
        logSourcesSignature = logRecordsSignature = ''; activitySources = undefined;
        loadSaved(); renderBasket();
        syncModalState();
      }
      if (changes.sourcesChanged || changedSession) mergeSources(!changedSession);
      else {
        uiUpdates.sourceMergeSkipped++;
        if (changes.statusChanged) scene?.setInvestigation(snapshot);
      }
      if (changes.statusChanged || changedSession) renderStatus();
      else { uiUpdates.statusSkipped++; refreshSnapshotPanels(); }
      } finally { finishWork?.(); }
    },
    setActive(next: boolean) { active = next; if (!next) { cancelAnimationFrame(readerPositionFrame); readerPositionFrame = 0; } edgeNavigation?.sync(); performancePanel.setActive(next); scene?.setActive(next && !viewer?.isOpen); root.hidden = !next; if (next) { scheduleReportPosition(); scheduleReaderPosition(); } else { cancelAnimationFrame(reportPositionFrame); reportPositionFrame = 0; } if (next && viewer?.isOpen && !viewerFrame) viewerFrame = requestAnimationFrame(renderViewer); else if (!next) { cancelAnimationFrame(viewerFrame); viewerFrame = 0; } },
    stats() { return { uiUpdates: { ...uiUpdates }, hostBridge: options.host?.performanceStats?.() ?? null, snapshotBridge: options.snapshotDiagnostics?.performanceStats?.() ?? null, ...scene?.stats(), board: boardPanel.stats(), investigations: investigation?.stats(), boardFullscreen, navigation: navigationLimiter.stats(), quality: { ...quality }, sourceCount: sources.length, candidateCount: archiveSources.length, followAgent, unseenReads: unseenReads.size, displayedSourceId: displayedArchiveSource?.id, manualSourceCount: manualSources.length, extractCount: extracts.length, location, readerOpen: !reader.hidden, searchBusy, resultCount: results.length, reportOpen: !report.hidden, shelfSelected, deskPage, viewerOpen: Boolean(viewer?.isOpen), archiveIndex: archiveSelected }; },
    dispose() {
      manualSearch.dispose();
      if (disposed) return;
      disposed = true;
      archiveRack.dispose();
      edgeNavigation?.dispose();
      options.host?.setPerformanceMonitor?.();
      options.snapshotDiagnostics?.setPerformanceMonitor?.();
      performancePanel.dispose();
      investigation?.dispose();
      boardPanel.dispose();
      unsubscribeHost?.();
      cancelReaderPosition();
      cancelAnimationFrame(originRestoreFrame);
      searchController?.abort(); readController?.abort();
      clearTimeout(toastTimeout);
      clearTimeout(reportRenderTimer); clearTimeout(completionTimer); cancelAnimationFrame(reportPositionFrame);
      clearInterval(clockTimer);
      cancelAnimationFrame(viewerFrame);
      document.removeEventListener('visibilitychange', viewerVisibility);
      viewer?.dispose();
      resizeObserver.disconnect();
      densityQuery.removeEventListener('change', densityChanged);
      window.removeEventListener('resize', fit);
      window.visualViewport?.removeEventListener('resize', fit);
      window.visualViewport?.removeEventListener('scroll', fit);
      coarse.removeEventListener('change', fit);
      for (const control of [...Object.values(counters), ...Object.values(titles)]) control.destroy();
      sourceMotion.dispose();
      arrayListTransition.dispose();
      detailTransition.dispose(); for (const transition of modalTransitions.values()) transition.dispose();
      document.removeEventListener('keydown', readingKeydown, true);
      document.removeEventListener('keydown', keydown);
      reducedMotion.removeEventListener('change', motionChange);
      scene?.dispose(); root.remove();
    },
  };
}
