import type { RenderQuality } from './original/render-quality';
import type { EvidenceCard, EvidenceBoardTool, EvidenceTemplate } from './evidence-board-model';

export interface BoardAnchorPoint { x: number; y: number; visible: boolean }
export interface BoardAnchorFrame {
  corner: BoardAnchorPoint;
  chalk: BoardAnchorPoint;
  /** Clockwise corners of the view label on the board plane, in stage pixels. */
  controls: [BoardAnchorPoint, BoardAnchorPoint, BoardAnchorPoint, BoardAnchorPoint];
  width: number;
  height: number;
  zoom: number;
  visible: boolean;
}

export type RhineLocation = 'board' | 'archive' | 'desk';

export type ArchiveOrigin = 'local' | 'cloud' | 'web';
export type ArchiveState = 'found' | 'read' | 'cited';
export interface ArchiveSource {
  id: string;
  title: string;
  kind: string;
  origin: ArchiveOrigin;
  state: ArchiveState;
  agentRead?: boolean;
  excerpt: string;
  documentId?: string;
  documentUid?: string;
  sourceRef?: string;
  dataVersion?: string;
  lineStart?: number;
  lineEnd?: number;
  url?: string;
  callId?: string;
  ranges?: { start: number; end: number }[];
  readRanges?: { start: number; end: number }[];
  saved?: boolean;
}
/** One actual tool invocation, retained after completion for visual playback. */
export interface ArchiveOperation {
  id: string;
  tool: string;
  kind: 'search' | 'read';
  state: 'active' | 'complete' | 'error';
  /** Final merged source IDs delivered by this invocation; reads exclude unread pointers. */
  sourceIds: string[];
  documentId?: string;
  documentUid?: string;
  sourceRef?: string;
  dataVersion?: string;
  query?: string;
  /** Actual Host event times, absent when the loaded history lacks that boundary. */
  startedAt?: number;
  completedAt?: number;
}
export interface InvestigationSnapshot {
  sessionId: string;
  running: boolean;
  searching: boolean;
  query: string;
  tool: string;
  sources: ArchiveSource[];
  answer: string;
  /** Stable identity of the current durable turn, or its pending user message. */
  investigationId?: string;
  /** Only a durable successful turn/end confirms completed. */
  outcome?: 'running' | 'completed' | 'interrupted' | 'error' | 'unknown';
  /** Sources received in this turn; the main sources array remains cumulative. */
  turnSources?: ArchiveSource[];
  /** Sources explicitly cited by the current answer, including reused older sources. */
  reportSources?: ArchiveSource[];
  /** Host event time for a confirmed successful turn/end. */
  completedAt?: number;
  question?: string;
  phase?: 'idle' | 'searching' | 'reading' | 'synthesizing' | 'complete' | 'error';
  activeDocumentId?: string;
  activeSourceRef?: string;
  activeDataVersion?: string;
  error?: string;
  hasMoreHistory?: boolean;
  loadingHistory?: boolean;
  records?: { id: string; tool: string; state: 'active' | 'complete' | 'error'; query: string; text: string }[];
  /** Current-turn tool activities; parallel and already completed calls remain distinct. */
  operations?: ArchiveOperation[];
}
export interface RhineScene {
  setLocation(location: RhineLocation): void;
  setBoardFullscreen(fullscreen: boolean): void;
  setBoardEditorInset(bottomFraction: number): void;
  cancelBoardGesture(): boolean;
  resetBoardView(): void;
  zoomBoard(direction: -1 | 1): void;
  setBoardTool(tool: EvidenceBoardTool): void;
  setBoardCards(cards: EvidenceCard[]): void;
  selectBoardCard(id: string | null): void;
  setSearching(searching: boolean): void;
  setSources(sources: ArchiveSource[], animate?: boolean): void;
  setArchiveSources(sources: ArchiveSource[]): void;
  selectArchiveSource(id: string, userInitiated?: boolean): void;
  browseArchiveSource(id: string): boolean;
  setInvestigation(snapshot: InvestigationSnapshot): void;
  setShelfPage(page: number): void;
  browseShelf(direction: number): void;
  select(id: string | null): void;
  navigate(axis: 'row' | 'lane', direction: number): boolean;
  selectArchive(index: number): void;
  setDetail(open: boolean): void;
  createAssemblyModel(): Promise<{ model: import('three').Group; dispose: () => void; setClarity?: (value: number) => void }>;
  finishDecryption(): void;
  setActive(active: boolean): void;
  setReducedMotion(reduced: boolean): void;
  setQuality(quality: RenderQuality): void;
  resize(): void;
  stats(): Record<string, unknown>;
  dispose(): void;
}
export interface RhineSceneOptions {
  assetBase: string;
  navigationLimiter?: import('./archive-navigation-limit').ArchiveNavigationLimiter;
  /** TEMPORARY RHINE PROFILER */
  performanceProbe?: import('./temporary-performance').RenderPerformanceCapture;
  /** Opening boundary used to distinguish late history from live tool receipts. */
  activitySince?: number;
  reducedMotion?: boolean;
  onSelect?: (id: string) => void;
  onArchiveSelect?: (index: number) => void;
  onArchiveOpen?: (index: number) => void;
  onArchiveSourceSelect?: (id: string | null, lane: number) => void;
  onArchiveSourceOpen?: (id: string) => void;
  onShelfSelect?: (id: string | null, page: number) => void;
  onBoardSelect?: (id: string | null, openEditor?: boolean) => void;
  onBoardMove?: (id: string, x: number, y: number) => void;
  onBoardResize?: (id: string, scale: number, x: number, y: number) => void;
  onBoardAnchors?: (frame: BoardAnchorFrame) => void;
  onBoardToolRequest?: () => void;
  onBoardToolChange?: (tool: EvidenceBoardTool) => void;
  onBoardPlace?: (template: EvidenceTemplate, position: { x: number; y: number }) => void;
  onBoardConnect?: (fromId: string, toId: string) => void;
  onDetailFrame?: (visibility: number) => void;
  onError?: (message: string) => void;
}
export interface RhineOptions {
  assetBase: string;
  snapshot: InvestigationSnapshot;
  agentAvailable?: boolean;
  api: (endpoint: string, payload?: unknown, signal?: AbortSignal) => Promise<any>;
  askAgent: (text: string) => Promise<void>;
  loadHistory?: () => Promise<void>;
  host?: RhineHostControls;
  close: () => void;
}
export interface RhineHostState {
  sessionId: string;
  title: string;
  workspace: string;
  blank: boolean;
  running: boolean;
  busy: boolean;
  loading: boolean;
  canSubmit: boolean;
  error: string;
  mode: string;
  modes: { id: string; name: string; description: string }[];
  sessions: { id: string; title: string; workspace: string; running: boolean; updatedAt: number }[];
  model: string;
  models: { id: string; name: string }[];
}
export interface RhineHostControls {
  getState(): RhineHostState;
  subscribe(listener: (state: RhineHostState) => void): () => void;
  refresh(): Promise<void>;
  createSession(mode?: string): Promise<void>;
  openSession(id: string): Promise<void>;
  selectMode(id: string): Promise<void>;
  selectModel(id: string): Promise<void>;
  cancel(): Promise<void>;
}
export interface RhineWorkbench {
  update(snapshot: InvestigationSnapshot): void;
  setActive(active: boolean): void;
  dispose(): void;
  stats(): Record<string, unknown>;
}
