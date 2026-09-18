// TEMPORARY RHINE PROFILER — isolated so it can be removed after hardware testing.
import type { Texture, WebGLRenderer } from 'three';
import { installRenderDiagnostics, type DiagnosticPass } from './temporary-render-diagnostics.ts';

type TimerExtension = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number; QUERY_COUNTER_BITS_EXT: number };
export type GpuStatus = 'pending' | 'valid' | 'unsupported' | 'busy' | 'disjoint' | 'context-lost' | 'timeout' | 'error' | 'disabled';
export interface GpuReading { gpuMs: number | null; gpuStatus: GpuStatus; gpuQueryLatencyMs: number | null }
export interface RenderSample {
  id: number; at: number; renderer: string; state: string;
  gpuMode?: 'whole' | 'segments'; detailReason?: 'periodic' | 'interaction';
  gpuStages?: Record<string, GpuReading>; passWork?: Record<string, { cpuMs: number; calls: number; triangles: number }>;
  glWork?: Record<string, { calls: number; cpuMs: number; sourceBytes: number; sourcePixels: number; allocationBytes: number }>;
  drawFamilies?: { family: string; part: string; material: string; phase: string; calls: number; triangles: number }[];
  detailProbeMs?: number;
  intervalMs: number | null; cpuMs: number; gpuMs: number | null; gpuStatus: GpuStatus;
  calls: number; triangles: number; geometries: number; textures: number; programs: number;
  width: number; height: number; failed: boolean;
  rafAt: number | null; callbackIntervalMs: number | null; rafLagMs: number | null; outsideFrameMs: number | null;
  submissions: Record<string, { calls: number; triangles: number }>;
  stages: Record<string, number>; counters: Record<string, number | boolean>;
  probeBeginMs: number; probeEndMs: number; gpuPending: number; gpuQueryLatencyMs: number | null;
}

/** Never read QUERY_RESULT until available; never finish/flush/readPixels to time a frame. */
export class AsyncGpuTimer {
  private ext: TimerExtension | null;
  private pending: { query: WebGLQuery; sample: GpuReading; submittedAt?: number }[] = [];
  private free: WebGLQuery[] = [];
  private active: { query: WebGLQuery; sample: GpuReading } | undefined;
  readonly supported: boolean;
  private gl: WebGL2RenderingContext;
  private now: () => number;
  private readonly capacity: number;
  constructor(gl: WebGL2RenderingContext, now: () => number = () => performance.now(), capacity = 12) {
    this.now = now; this.capacity = capacity;
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.supported = Boolean(this.ext && Number(gl.getQuery(this.ext.TIME_ELAPSED_EXT, this.ext.QUERY_COUNTER_BITS_EXT)) > 0);
    if (!this.supported) this.ext = null;
    if (this.ext) gl.getParameter(this.ext.GPU_DISJOINT_EXT); // Clear pre-capture disjoint state.
  }
  get waiting() { return this.pending.length; }
  begin(sample: GpuReading) {
    if (this.gl.isContextLost()) { sample.gpuStatus = 'context-lost'; return; }
    if (!this.ext) { sample.gpuStatus = 'unsupported'; return; }
    this.poll();
    if (this.active || this.pending.length >= this.capacity || this.gl.getQuery(this.ext.TIME_ELAPSED_EXT, this.gl.CURRENT_QUERY)) {
      sample.gpuStatus = 'busy'; return;
    }
    const query = this.free.pop() || this.gl.createQuery();
    if (!query) { sample.gpuStatus = 'error'; return; }
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    sample.gpuStatus = 'pending';
    this.active = { query, sample };
  }
  end(sample: GpuReading) {
    if (this.active?.sample !== sample || !this.ext) return;
    if (this.gl.isContextLost()) { this.dispose('context-lost'); return; }
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push({ ...this.active, submittedAt: this.now() });
    this.active = undefined;
  }
  poll() {
    if (!this.ext || !this.pending.length) return;
    if (this.gl.isContextLost()) { this.dispose('context-lost'); return; }
    if (this.gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
      for (const item of this.pending) {
        item.sample.gpuStatus = 'disjoint';
        this.free.push(item.query);
      }
      this.pending.length = 0;
      return;
    }
    // Commands on this context are ordered; an unavailable oldest query is enough.
    while (this.pending.length) {
      const item = this.pending[0];
      if (!this.gl.getQueryParameter(item.query, this.gl.QUERY_RESULT_AVAILABLE)) break;
      const ms = Number(this.gl.getQueryParameter(item.query, this.gl.QUERY_RESULT)) / 1e6;
      item.sample.gpuQueryLatencyMs = item.submittedAt === undefined ? null : this.now() - item.submittedAt;
      item.sample.gpuMs = Number.isFinite(ms) && ms >= 0 ? ms : null;
      item.sample.gpuStatus = item.sample.gpuMs === null ? 'error' : 'valid';
      this.pending.shift(); this.free.push(item.query);
    }
  }
  dispose(reason: GpuStatus = 'timeout') {
    if (this.active) {
      if (!this.gl.isContextLost() && this.ext) this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.pending.push(this.active); this.active = undefined;
    }
    for (const item of this.pending) {
      item.sample.gpuStatus = reason;
      this.gl.deleteQuery(item.query);
    }
    for (const query of this.free) this.gl.deleteQuery(query);
    this.pending.length = this.free.length = 0;
  }
}

export function distribution(values: number[]) {
  if (!values.length) return { count: 0, mean: null, p50: null, p95: null, p99: null, max: null };
  values.sort((a, b) => a - b);
  const percentile = (p: number) => values[Math.max(0, Math.ceil(values.length * p) - 1)];
  return { count: values.length, mean: values.reduce((sum, n) => sum + n, 0) / values.length,
    p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: values[values.length - 1] };
}
export function summarizeFrames(samples: RenderSample[]) {
  const intervals = samples.flatMap(s => s.intervalMs === null ? [] : [s.intervalMs]);
  const frame = distribution(intervals);
  const gpuStatuses: Record<string, number> = {};
  for (const sample of samples) gpuStatuses[sample.gpuStatus] = (gpuStatuses[sample.gpuStatus] || 0) + 1;
  return { frames: samples.length, fps: frame.mean ? 1000 / frame.mean : null, frameMs: frame,
    callbackMs: distribution(samples.flatMap(s => s.callbackIntervalMs == null ? [] : [s.callbackIntervalMs])),
    rafLagMs: distribution(samples.flatMap(s => s.rafLagMs == null ? [] : [s.rafLagMs])),
    outsideFrameMs: distribution(samples.flatMap(s => s.outsideFrameMs == null ? [] : [s.outsideFrameMs])),
    stages: Object.fromEntries([...new Set(samples.flatMap(s => Object.keys(s.stages || {})))].map(name =>
      [name, distribution(samples.flatMap(s => s.stages?.[name] == null ? [] : [s.stages[name]]))])),
    probeMs: distribution(samples.map(s => (s.probeBeginMs || 0) + (s.probeEndMs || 0) + (s.detailProbeMs || 0))),
    gpuQueryLatencyMs: distribution(samples.flatMap(s => s.gpuQueryLatencyMs == null ? [] : [s.gpuQueryLatencyMs])),
    callbackOver50ms: samples.filter(s => (s.callbackIntervalMs || 0) > 50).length,
    cpuMs: distribution(samples.map(s => s.cpuMs)),
    gpuMs: distribution(samples.flatMap(s => s.gpuStatus === 'valid' && s.gpuMs !== null ? [s.gpuMs] : [])),
    gpuModes: Object.fromEntries(['whole', 'segments'].map(mode => [mode, samples.filter(s => (s.gpuMode || 'whole') === mode).length])),
    gpuStages: Object.fromEntries([...new Set(samples.flatMap(s => Object.keys(s.gpuStages || {})))].map(name => [name,
      distribution(samples.flatMap(s => s.gpuStages?.[name]?.gpuStatus === 'valid' ? [s.gpuStages[name].gpuMs!] : []))])),
    gpuStatuses, over33ms: intervals.filter(n => n > 33.34).length, over50ms: intervals.filter(n => n > 50).length,
    calls: distribution(samples.map(s => s.calls)), triangles: distribution(samples.map(s => s.triangles)),
    failedFrames: samples.filter(s => s.failed).length };
}

/** Bounded live display: never walk/sort the entire capture in the 1Hz panel. */
export function liveFrameSummary(samples: RenderSample[], end: number, windowMs = 2000, limit = 512) {
  const recent: RenderSample[] = [];
  for (let i = samples.length - 1; i >= 0 && recent.length < limit; i--) {
    const sample = samples[i];
    if (sample.at < end - windowMs) break;
    recent.push(sample);
  }
  const values = (read: (s: RenderSample) => number | null) =>
    distribution(recent.flatMap(s => { const value = read(s); return value == null ? [] : [value]; }));
  return { frames: recent.length, windowMs, limit, truncated: recent.length === limit && samples.length > limit
      && samples[samples.length - limit - 1].at >= end - windowMs,
    callbackMs: values(s => s.callbackIntervalMs), rafLagMs: values(s => s.rafLagMs),
    outsideFrameMs: values(s => s.outsideFrameMs), cpuMs: values(s => s.cpuMs),
    gpuMs: values(s => s.gpuStatus === 'valid' ? s.gpuMs : null),
    probeMs: values(s => s.probeBeginMs + s.probeEndMs + (s.detailProbeMs || 0)),
    callbackOver50ms: recent.filter(s => (s.callbackIntervalMs || 0) > 50).length,
    over50ms: recent.filter(s => (s.intervalMs || 0) > 50).length };
}

type RendererRecord = { passes?: () => DiagnosticPass[]; restoreHooks?: () => void; frame?: FrameToken; name: string; renderer: WebGLRenderer; timer?: AsyncGpuTimer; events: AbortController; adapter?: Record<string, unknown>; snapshot?: () => unknown };
export type FrameToken = { gpuPart?: GpuReading; gpuStage?: string; detailed?: boolean; sample: RenderSample; record: RendererRecord; cpuStart: number; checkpointAt: number; lastCalls: number; lastTriangles: number; autoReset: boolean };
export type DiagnosticChannel = 'heartbeat' | 'longAnimationFrames' | 'interactionSummary' | 'interactions' | 'resources' | 'layoutShifts' | 'backgroundWork' | 'overhead' | 'uiWork' | 'loads' | 'slowWork' | 'resourceUpdates';
export type CaptureOptions = { gpuTiming?: boolean; detailed?: boolean };
const channelLimits: Record<DiagnosticChannel, number> = { heartbeat: 240, longAnimationFrames: 2000, interactions: 2000, interactionSummary: 2000, resources: 2000, layoutShifts: 1000, backgroundWork: 4000, overhead: 2000, uiWork: 6000, loads: 2000, slowWork: 2000, resourceUpdates: 4000 };

export class RenderPerformanceCapture {
  running = false;
  samples: RenderSample[] = [];
  events: { at: number; kind: string; detail?: unknown }[] = [];
  longTasks: { at: number; durationMs: number }[] = [];
  longTasksSupported = false;
  startedAt = 0;
  stoppedAt = 0;
  startedISO = '';
  metadata: unknown;
  endMetadata: unknown;
  diagnostics: Record<DiagnosticChannel, { at: number; [key: string]: unknown }[]> = this.emptyDiagnostics();
  capabilities: Record<string, { supported: boolean; active: boolean; reason?: string }> = {};
  dropped: Record<string, number> = {};
  options = { gpuTiming: true, detailed: true };
  private burstRemaining = 0;
  private detailFrames = 0;
  private segmentSamples = new Set<RenderSample>();
  private textures = new Map<Texture, { id: number; restore: () => void }>();
  private textureSequence = 0;
  longTaskMaxMs = 0;
  private buckets = new Map<string, { at: number; [key: string]: unknown }>();
  private pendingLoads = new Map<number, { id: number; kind: string; start: number; detail: Record<string, unknown> }>();
  private loadRecords = new Map<number, { at: number; [key: string]: unknown }>();
  private loadSequence = 0;
  private loadHistory: Record<string, unknown>[] = [];
  private initialLoading: unknown;
  private lastCallback: { renderer: WebGLRenderer; start: number; end: number | null } | undefined;
  private session = 0;
  private emptyDiagnostics() { return Object.fromEntries(Object.keys(channelLimits).map(key => [key, []])) as unknown as typeof this.diagnostics; }
  private records = new Map<WebGLRenderer, RendererRecord>();
  private lastRaf: number | null = null;
  private lastRenderer: WebGLRenderer | undefined;
  private lastState = '';
  private lastSize = '';
  private limitMs = 60_000;
  private stopReason = '';
  private now: () => number;
  constructor(now: () => number = () => performance.now()) { this.now = now; }

  register(name: string, renderer: WebGLRenderer, snapshot?: () => unknown, passes?: () => DiagnosticPass[]) {
    const record: RendererRecord = { name, renderer, snapshot, passes, events: new AbortController() };
    this.records.set(renderer, record);
    renderer.domElement.addEventListener('webglcontextlost', () => {
      record.timer?.dispose('context-lost'); record.timer = undefined;
      this.breakTimeline('context-lost');
    }, { signal: record.events.signal });
    renderer.domElement.addEventListener('webglcontextrestored', () => {
      if (this.running) this.prepare(record);
      this.breakTimeline('context-restored');
    }, { signal: record.events.signal });
    if (this.running) this.prepare(record);
    return () => { record.restoreHooks?.(); record.timer?.dispose('context-lost'); record.events.abort(); this.records.delete(renderer); };
  }
  private prepare(record: RendererRecord) {
    record.timer?.dispose(); record.restoreHooks?.();
    const gl = record.renderer.getContext() as WebGL2RenderingContext;
    record.timer = this.options.gpuTiming ? new AsyncGpuTimer(gl, this.now, this.options.detailed ? 96 : 12) : undefined;
    if (this.options.detailed) record.restoreHooks = installRenderDiagnostics(record.renderer, () => record.frame,
      stage => this.gpuStage(record.renderer, stage), record.passes?.() || [], this.now,
      detail => this.diagnostic('resourceUpdates', { renderer: record.name, ...detail }));
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || 'unknown');
    record.adapter = { name: record.name, renderer,
      vendor: gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR),
      software: /swiftshader|llvmpipe|softpipe|software/i.test(renderer),
      identityUnmasked: Boolean(debug), gpuTimerSupported: record.timer?.supported ?? null, gpuTimingEnabled: this.options.gpuTiming };
  }
  start(metadata: unknown, seconds = 60, options: CaptureOptions = {}) {
    for (const record of this.records.values()) { record.timer?.dispose(); record.restoreHooks?.(); record.frame = undefined; }
    this.restoreTextureHooks(); this.segmentSamples.clear(); this.burstRemaining = 0; this.detailFrames = 0;
    this.samples = []; this.events = []; this.longTasks = [];
    this.workStack = []; this.workSequence = 0;
    this.diagnostics = this.emptyDiagnostics(); this.capabilities = {}; this.dropped = {};
    this.buckets.clear(); this.loadRecords.clear(); this.longTaskMaxMs = 0;
    this.options = { gpuTiming: options.gpuTiming !== false, detailed: options.detailed !== false }; this.lastCallback = undefined; this.session++;
    this.metadata = metadata; this.endMetadata = undefined;
    this.startedISO = new Date().toISOString(); this.stoppedAt = 0;
    this.limitMs = Math.max(1, Math.min(120, seconds)) * 1000;
    this.stopReason = ''; this.lastState = ''; this.lastSize = '';
    // Extension discovery happens before the measured interval.
    for (const record of this.records.values()) this.prepare(record);
    this.startedAt = this.now(); this.running = true;
    this.lastRaf = null; this.lastRenderer = undefined;
    this.mark('start', { limitSeconds: this.limitMs / 1000 });
    this.initialLoading = this.loadingState();
    for (const load of this.pendingLoads.values()) this.recordLoad(load);
  }
  stop(reason = 'manual') {
    if (!this.running) return;
    this.mark('stop', reason); this.running = false;
    this.stopReason = reason; this.stoppedAt = this.now();
    for (const record of this.records.values()) { record.restoreHooks?.(); record.restoreHooks = undefined; }
    this.restoreTextureHooks(); this.lastRaf = null; this.lastCallback = undefined;
  }
  mark(kind: string, detail?: unknown) {
    if (!this.running) return;
    if (['archive-navigation', 'location', 'detail', 'board-fullscreen', 'user-hitch-marker', 'automatic-scan-step'].includes(kind)) this.burstRemaining = 6;
    if (this.events.length < 4000) this.events.push({ at: this.now() - this.startedAt, kind, detail });
    else this.dropped.events = (this.dropped.events || 0) + 1;
  }
  breakTimeline(reason: string) { this.lastRaf = null; this.lastCallback = undefined; this.mark('pause-boundary', reason); }
  diagnostic(channel: DiagnosticChannel, detail: Record<string, unknown>, startTime = this.now()) {
    if (!this.startedISO || startTime < this.startedAt || startTime > (this.running ? this.now() : this.stoppedAt)) return;
    const at = startTime - this.startedAt;
    const list = this.diagnostics[channel];
    // Separate 1s buckets by kind: observer traffic cannot consume panel/heartbeat capacity.
    if (channel === 'overhead' || channel === 'layoutShifts' || channel === 'uiWork' || channel === 'interactionSummary') {
      const key = [channel, Math.floor(at / 1000), detail.kind, detail.entryType, detail.visible, detail.hadRecentInput].join(':');
      const value = Number(channel === 'layoutShifts' ? detail.value : detail.durationMs) || 0;
      if (channel !== 'layoutShifts' && channel !== 'interactionSummary' && value >= 8)
        this.diagnostic('slowWork', { ...detail, channel }, startTime);
      const bucket = this.buckets.get(key);
      if (bucket) {
        bucket.count = Number(bucket.count) + 1; bucket.lastAt = Math.max(Number(bucket.lastAt), at);
        bucket.firstAt = Math.min(Number(bucket.firstAt), at);
        bucket.total = Number(bucket.total) + value;
        bucket.entries = Number(bucket.entries) + (Number(detail.entries) || 0);
        if (value > Number(bucket.max)) { bucket.max = value; bucket.worstAt = at; bucket.worst = detail; }
        return bucket;
      }
      if (list.length >= channelLimits[channel]) { this.dropped[channel] = (this.dropped[channel] || 0) + 1; return; }
      const next = { at: Math.floor(at / 1000) * 1000, firstAt: at, lastAt: at, count: 1,
        kind: detail.kind, entryType: detail.entryType, visible: detail.visible, hadRecentInput: detail.hadRecentInput,
        unit: channel === 'layoutShifts' ? 'layout-shift-value' : 'ms', total: value, max: value,
        entries: Number(detail.entries) || 0, worstAt: at, worst: detail };
      list.push(next); this.buckets.set(key, next); return next;
    }
    if (list.length < channelLimits[channel]) {
      const entry = { ...detail, at }; list.push(entry); return entry;
    }
    this.dropped[channel] = (this.dropped[channel] || 0) + 1;
  }
  private recordLoad(load: { id: number; kind: string; start: number; detail: Record<string, unknown> }) {
    const row = this.diagnostic('loads', { id: load.id, kind: load.kind, ...load.detail, status: 'pending',
      startedBeforeCapture: load.start < this.startedAt, elapsedBeforeCaptureMs: Math.max(0, this.startedAt - load.start) },
      Math.max(load.start, this.startedAt));
    if (row) this.loadRecords.set(load.id, row);
  }
  /** Small lifecycle inventory survives Start; never retain request payloads. */
  beginLoad(kind: string, detail: Record<string, unknown> = {}) {
    const load = { id: ++this.loadSequence, kind, start: this.now(), detail };
    this.pendingLoads.set(load.id, load);
    if (this.running) this.recordLoad(load);
    let finished = false;
    return (status: 'complete' | 'error' | 'aborted' = 'complete') => {
      if (finished) return; finished = true;
      this.pendingLoads.delete(load.id);
      const end = this.now(), durationMs = end - load.start;
      this.loadHistory.push({ id: load.id, kind, ...detail, status, durationMs });
      if (this.loadHistory.length > 64) this.loadHistory.shift();
      const row = this.loadRecords.get(load.id);
      if (row) Object.assign(row, { status, endAt: end - this.startedAt, durationMs, finishedAfterCapture: !this.running });
      this.loadRecords.delete(load.id);
    };
  }
  async trackLoad<T>(kind: string, task: () => Promise<T>, detail: Record<string, unknown> = {}): Promise<T> {
    const done = this.beginLoad(kind, detail);
    try { const result = await task(); done(); return result; }
    catch (error) { done(error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'error'); throw error; }
  }
  loadingState() { return { active: [...this.pendingLoads.values()].map(load => ({
    id: load.id, kind: load.kind, ...load.detail, elapsedMs: this.now() - load.start })),
    recent: this.loadHistory.slice() }; }
  private workSequence = 0;
  private workStack: { id: number; session: number }[] = [];
  private traceSpan(kind: string, start: number, end: number) {
    // Public operation categories only. Clearing the entry bounds the User Timing
    // buffer; an attached browser trace still receives the timing measure.
    if (!this.options.detailed || typeof performance === 'undefined' || typeof performance.measure !== 'function') return;
    const name = `rhine:${kind}`;
    try { performance.measure(name, { start, end }); performance.clearMeasures(name); } catch { /* optional trace correlation */ }
  }
  beginUiWork(kind: string, detail: Record<string, unknown> = {}) {
    if (!this.running) return undefined;
    const start = this.now(), session = this.session;
    const parent = this.workStack.at(-1), span = { id: ++this.workSequence, session };
    const parentId = parent?.session === session ? parent.id : null;
    this.workStack.push(span);
    let finished = false;
    return () => {
      if (finished) return; finished = true;
      const index = this.workStack.indexOf(span); if (index >= 0) this.workStack.splice(index, 1);
      if (this.session !== session) return;
      const end = this.now(), durationMs = end - start;
      this.diagnostic('uiWork', { kind, ...detail, spanId: span.id, parentId, durationMs }, start);
      if (durationMs >= 8) this.traceSpan(kind, start, end);
    };
  }
  measureWork<T>(kind: string, task: () => T): T {
    const done = this.beginUiWork(kind);
    try { return task(); } finally { done?.(); }
  }
  rendererStates() { return Object.fromEntries([...this.records.values()].map(r => [r.name, r.snapshot?.() ?? null])); }
  beginWork(kind: string) {
    if (!this.running) return undefined;
    const start = this.now(), session = this.session;
    // A task crossing into another capture must never contaminate that run.
    return (succeeded: boolean, asynchronous = false) => {
      if (session !== this.session) return;
      this.diagnostic('backgroundWork', { kind, durationMs: this.now() - start, succeeded, asynchronous, finishedAfterCapture: !this.running }, start);
    };
  }
  private restoreTextureHooks() {
    for (const item of this.textures.values()) item.restore();
    this.textures.clear(); this.textureSequence = 0;
  }
  /** Observe cached prints too: context restoration may upload without another paint. */
  observeTexture(texture: Texture, family: 'hero-label' | 'moving-label' | 'shelf-label', cacheEntry?: number) {
    if (!this.running || !this.options.detailed) return;
    const session = this.session;
    let item = this.textures.get(texture);
    if (!item) {
      if (this.textures.size >= 256) { this.dropped.textureHooks = (this.dropped.textureHooks || 0) + 1; return; }
      const id = ++this.textureSequence, original = texture.onUpdate, capture = this;
      const wrapped = function(this: Texture, ...args: Parameters<NonNullable<Texture['onUpdate']>>) {
        original?.apply(this, args);
        if (!capture.running || capture.session !== session) return;
        const frame = [...capture.records.values()].find(r => r.frame)?.frame;
        capture.diagnostic('resourceUpdates', { kind: 'texture-upload-complete', texture: id, family, cacheEntry, version: texture.version,
          frame: frame?.sample.id ?? null, stage: frame?.gpuStage ?? (frame ? 'whole-frame' : 'outside-frame') });
      };
      texture.onUpdate = wrapped;
      const release = () => { item?.restore(); this.textures.delete(texture); };
      texture.addEventListener('dispose', release);
      item = { id, restore: () => {
        texture.removeEventListener('dispose', release);
        if (texture.onUpdate === wrapped) texture.onUpdate = original;
      } };
      this.textures.set(texture, item);
    }
    return item;
  }
  /** Records dimensions/version only; never retains canvas pixels or document identifiers. */
  texturePaint(texture: Texture, family: 'hero-label' | 'moving-label' | 'shelf-label', paint: () => void, cacheEntry?: number) {
    if (!this.running || !this.options.detailed) { paint(); return; }
    const start = this.now(); this.burstRemaining = Math.max(this.burstRemaining, 6);
    const item = this.observeTexture(texture, family, cacheEntry);
    if (!item) { paint(); return; }
    try { paint(); } finally {
      const image = texture.image as { width?: number; height?: number } | undefined;
      this.diagnostic('resourceUpdates', { kind: 'texture-dirty', texture: item.id, family, cacheEntry, version: texture.version,
        width: image?.width ?? 0, height: image?.height ?? 0, rgba8BaseBytes: (image?.width || 0) * (image?.height || 0) * 4,
        generateMipmaps: texture.generateMipmaps, anisotropy: texture.anisotropy, minFilter: texture.minFilter, magFilter: texture.magFilter, cpuMs: this.now() - start }, start);
    }
  }
  gpuStage(renderer: WebGLRenderer, name: string) {
    const token = this.records.get(renderer)?.frame;
    if (!token?.detailed || token.gpuStage === name) return;
    const begin = this.now();
    token.gpuStage = name;
    if (!token.sample.gpuStages) return;
    if (token.gpuPart) token.record.timer?.end(token.gpuPart);
    const part: GpuReading = { gpuMs: null, gpuStatus: 'unsupported', gpuQueryLatencyMs: null };
    // Repeated pass names remain separate intervals, with no nested queries.
    let key = name, suffix = 2;
    while (token.sample.gpuStages[key]) key = name + ':' + suffix++;
    token.sample.gpuStages[key] = part; token.gpuPart = part;
    token.record.timer?.begin(part);
    token.sample.detailProbeMs! += this.now() - begin;
  }
  private settleSegments() {
    for (const sample of this.segmentSamples) {
      const parts = Object.values(sample.gpuStages || {});
      if (parts.some(p => p.gpuStatus === 'pending')) continue;
      const invalid = parts.find(p => p.gpuStatus !== 'valid');
      sample.gpuStatus = invalid?.gpuStatus || 'valid';
      sample.gpuMs = invalid ? null : parts.reduce((sum, p) => sum + (p.gpuMs || 0), 0);
      sample.gpuQueryLatencyMs = Math.max(0, ...parts.map(p => p.gpuQueryLatencyMs || 0));
      this.segmentSamples.delete(sample);
    }
  }
  checkpoint(token: FrameToken | undefined, name: string) {
    if (!token) return;
    const now = this.now(); token.sample.stages[name] = (token.sample.stages[name] || 0) + now - token.checkpointAt;
    token.checkpointAt = now;
    const render = token.record.renderer.info.render;
    const calls = render.calls - token.lastCalls, triangles = render.triangles - token.lastTriangles;
    if (calls || triangles) token.sample.submissions[name] = { calls, triangles };
    token.lastCalls = render.calls; token.lastTriangles = render.triangles;
  }
  addLongTask(startTime: number, duration: number) {
    const end = this.running ? this.now() : this.stoppedAt;
    if (startTime < this.startedAt || startTime > end) return;
    this.traceSpan("longtask", startTime, startTime + duration);
    this.longTaskMaxMs = Math.max(this.longTaskMaxMs, duration);
    if (this.longTasks.length < 4000) this.longTasks.push({ at: startTime - this.startedAt, durationMs: duration });
    else this.dropped.longTasks = (this.dropped.longTasks || 0) + 1;
  }
  begin(rafTime: number | null, renderer: WebGLRenderer, state: string): FrameToken | undefined {
    if (!this.running) return;
    const callbackStart = this.now();
    if (callbackStart - this.startedAt >= this.limitMs || this.samples.length >= 24_000) { this.stop('limit'); return; }
    const record = this.records.get(renderer);
    if (!record) return;
    const size = `${record.name}:${renderer.domElement.width}x${renderer.domElement.height}`;
    if (state !== this.lastState) { this.mark('state', state); this.lastState = state; }
    if (size !== this.lastSize) { this.mark('render-surface', size); this.lastSize = size; }
    const intervalMs = rafTime !== null && this.lastRaf !== null && this.lastRenderer === renderer && rafTime > this.lastRaf
      ? rafTime - this.lastRaf : null;
    if (rafTime !== null) { this.lastRaf = rafTime; this.lastRenderer = renderer; }
    const sample: RenderSample = { id: this.samples.length, at: callbackStart - this.startedAt, renderer: record.name, state,
      rafAt: rafTime === null ? null : rafTime - this.startedAt,
      rafLagMs: rafTime === null ? null : callbackStart - rafTime,
      callbackIntervalMs: rafTime !== null && this.lastCallback?.renderer === renderer ? callbackStart - this.lastCallback.start : null,
      outsideFrameMs: rafTime !== null && this.lastCallback?.renderer === renderer && this.lastCallback.end !== null ? callbackStart - this.lastCallback.end : null,
      stages: {}, submissions: {}, counters: {}, probeBeginMs: 0, probeEndMs: 0, gpuPending: record.timer?.waiting || 0, gpuQueryLatencyMs: null,
      intervalMs, cpuMs: 0, gpuMs: null, gpuStatus: this.options.gpuTiming ? 'unsupported' : 'disabled', calls: 0, triangles: 0,
      geometries: 0, textures: 0, programs: 0, width: renderer.domElement.width, height: renderer.domElement.height, failed: false };
    this.samples.push(sample);
    const requestedDetail = this.options.detailed && (sample.id % 30 === 0 || this.burstRemaining > 0);
    const detailed = requestedDetail && this.detailFrames < 1200;
    if (requestedDetail && !detailed) this.dropped.detailFrames = (this.dropped.detailFrames || 0) + 1;
    if (detailed) {
      sample.detailReason = this.burstRemaining > 0 ? 'interaction' : 'periodic';
      sample.detailProbeMs = 0; sample.passWork = {}; sample.drawFamilies = []; this.detailFrames++;
    }
    if (this.burstRemaining > 0) this.burstRemaining--;
    sample.gpuMode = detailed && this.options.gpuTiming ? 'segments' : 'whole';
    if (sample.gpuMode === 'segments') { sample.gpuStatus = 'pending'; sample.gpuStages = {}; this.segmentSamples.add(sample); }
    else record.timer?.begin(sample);
    // Include every pass, especially transmission, shadows and SMAA in the viewer.
    const autoReset = renderer.info.autoReset;
    renderer.info.autoReset = false; renderer.info.reset();
    const cpuStart = this.now(); sample.probeBeginMs = cpuStart - callbackStart;
    if (rafTime !== null) this.lastCallback = { renderer, start: callbackStart, end: null };
    else this.lastCallback = undefined; // Synchronous renders interrupt callback/outside-frame continuity.
    const token: FrameToken = { sample, record, detailed, autoReset, cpuStart, checkpointAt: cpuStart, lastCalls: 0, lastTriangles: 0 };
    record.frame = token;
    if (detailed) this.gpuStage(renderer, 'update');
    return token;
  }
  end(token: FrameToken | undefined, failed = false) {
    if (!token) return;
    const { record, sample } = token;
    const cpuEnd = this.now();
    sample.cpuMs = cpuEnd - token.cpuStart;
    sample.stages.tail = cpuEnd - token.checkpointAt;
    sample.failed = failed;
    record.timer?.end(token.gpuPart || sample); record.frame = undefined;
    const info = record.renderer.info;
    if (info.render.calls !== token.lastCalls || info.render.triangles !== token.lastTriangles)
      sample.submissions.tail = { calls: info.render.calls - token.lastCalls, triangles: info.render.triangles - token.lastTriangles };
    sample.calls = info.render.calls; sample.triangles = info.render.triangles;
    sample.geometries = info.memory.geometries; sample.textures = info.memory.textures; sample.programs = info.programs?.length || 0;
    record.renderer.info.autoReset = token.autoReset;
    const end = this.now(); sample.probeEndMs = end - cpuEnd;
    if (this.lastCallback?.renderer === record.renderer) this.lastCallback.end = end;
  }
  poll() {
    if (this.running && this.now() - this.startedAt >= this.limitMs) this.stop('limit');
    for (const record of this.records.values()) {
      record.timer?.poll();
      if (!this.running && this.stoppedAt && (!record.timer?.waiting || this.now() - this.stoppedAt > 5000)) record.timer?.dispose();
    }
    this.settleSegments();
  }
  get pendingGpu() { return [...this.records.values()].reduce((n, r) => n + (r.timer?.waiting || 0), 0); }
  get adapters() { return [...this.records.values()].flatMap(r => r.adapter ? [r.adapter] : []); }
  get elapsedMs() { return this.startedISO ? (this.running ? this.now() : this.stoppedAt) - this.startedAt : 0; }
  report() {
    this.settleSegments();
    const byState: Record<string, ReturnType<typeof summarizeFrames>> = {};
    for (const state of new Set(this.samples.map(s => s.state))) byState[state] = summarizeFrames(this.samples.filter(s => s.state === state));
    return { schema: 'rhine-render-capture/v3', startedAt: this.startedISO, elapsedMs: this.elapsedMs, running: this.running,
      initialLoading: this.initialLoading, detailSampling: { everyFrames: 30, burstFrames: 6, sampledFrames: this.detailFrames, maxFrames: 1200 },
      options: this.options, capabilities: this.capabilities, dropped: this.dropped, diagnostics: this.diagnostics,
      timeOrigin: typeof performance === 'undefined' ? null : performance.timeOrigin, captureStartTime: this.startedAt,
      stopReason: this.stopReason, pendingGpu: this.pendingGpu, adapters: this.adapters, metadata: this.metadata, endMetadata: this.endMetadata,
      scope: { frame: 'intervalMs is the RAF timestamp delta, NOT actual callback cadence or presentation FPS. callbackIntervalMs is the actual performance.now() callback-entry gap; rafAt and at share capture origin. Known visibility/active/context boundaries reset both.',
        cpu: 'Synchronous scene update + WebGL submission wall time; excludes begin/end bookkeeping and tasks outside the render callback; includes small checkpoint/counter instrumentation.',
        gpu: 'Elapsed GPU query interval around WebGL commands, including shadow/transmission/postprocessing. Not exclusive shader execution or utilization; driver synchronization and scheduling can affect it. Browser composition and other clients are not separately attributed.',
        detailed: 'gpuMode=segments replaces the whole-frame query with the SUM of sequential query intervals, not an independently measured whole-frame duration; driver/query overhead and boundary gaps differ. Inspect gpuMode when comparing. Draw families/passWork are sampled; GL texture upload counters cover every captured frame, buffer counters only detailed frames. GL call CPU time is submission wall time, not GPU duration. payload bytes/pixels are source estimates, not bus traffic. texture-upload-complete is the Three onUpdate callback, not proof of GPU completion.',
        resources: 'Renderer resource COUNTS, not bytes or VRAM usage. Heartbeats include actual composer, label-depth and shadow target sizes.',
        scheduling: 'rafLagMs = callback entry - RAF timestamp. outsideFrameMs starts at prior probe end; it includes other page work, browser scheduling and waiting, not a CPU attribution.',
        stages: 'Synchronous wall time per stage; composer includes all its passes. Tail and stages sum to cpuMs; passWork CPU intervals are nested inside composer, never add them again. Sampled gpuStages are sequential non-overlapping queries; scene-color still includes its shadow/transmission work.',
        gpuQueryLatency: 'Time from query submission until availability is observed; depends on polling cadence. NOT GPU execution or queue time.',
        diagnostics: 'Browser-supported LoAF, Event Timing, Resource Timing, layout shifts, JS heap and 1Hz heartbeat. No OS-wide utilization, VRAM, GC attribution or compositor trace.',
        overhead: 'Probe begin/end, observer, heartbeat and panel work wall time is measured approximately. JS allocations/GC and driver perturbation cannot be fully isolated; use GPU timing off for comparison.',
        submissions: 'Per-stage deltas of renderer.info calls/triangles, not GPU timings. Composer includes shadow/transmission/postprocess. Counters describe submitted scene families; heartbeat batches are inventory/culling state, not pixel visibility.',
        loads: 'Explicit asset/setup/API lifecycles include native IPC requests absent from Resource Timing. In-flight loads at Start are retained. Setup spans can include decode/clone/upload; do not add nested spans. Recent pre-capture history is limited to 64.',
        aggregates: 'slowWork additionally retains exact overhead/UI intervals >=8ms. overhead/layoutShifts/uiWork use 1s buckets by kind. count/total/max/worstAt/worst preserve frequency, sum and the exact slowest event. at is bucket origin. UI spans may nest. Layout totals are NOT CLS. Other entries remain raw; dropped counts are explicit.',
        privacy: 'No document content, input text, source IDs, error messages/stacks, full URLs, DOM nodes or element selectors.',
        longTasks: 'Page-wide main-thread tasks >= 50ms; may overlap CPU samples. Do not add CPU and GPU time.',
        warmup: 'No automatic exclusions: first-use hitches after Start are retained.',
        limits: '120 seconds / 24000 frames maximum; 12 whole-mode or 96 detail-mode asynchronous queries per context; at most 1200 detailed frames; UI refresh at 1Hz over at most 512 frames in the last 2s; exact cumulative distributions are export-only; bounded diagnostics with dropped counters.' },
      summary: summarizeFrames(this.samples), byState,
      longTasksSupported: this.longTasksSupported, longTaskMs: distribution(this.longTasks.map(t => t.durationMs)),
      longTasks: this.longTasks, events: this.events, frames: this.samples };
  }
  dispose() {
    this.stop('dispose');
    for (const record of this.records.values()) { record.restoreHooks?.(); record.timer?.dispose(); record.events.abort(); }
    this.settleSegments(); this.restoreTextureHooks();
    this.records.clear();
  }
}
