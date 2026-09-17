// TEMPORARY RHINE PROFILER — isolated so it can be removed after hardware testing.
import type { WebGLRenderer } from 'three';

type TimerExtension = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number; QUERY_COUNTER_BITS_EXT: number };
export type GpuStatus = 'pending' | 'valid' | 'unsupported' | 'busy' | 'disjoint' | 'context-lost' | 'timeout' | 'error';
export interface RenderSample {
  id: number; at: number; renderer: string; state: string;
  intervalMs: number | null; cpuMs: number; gpuMs: number | null; gpuStatus: GpuStatus;
  calls: number; triangles: number; geometries: number; textures: number; programs: number;
  width: number; height: number; failed: boolean;
}

/** Never read QUERY_RESULT until available; never finish/flush/readPixels to time a frame. */
export class AsyncGpuTimer {
  private ext: TimerExtension | null;
  private pending: { query: WebGLQuery; sample: RenderSample }[] = [];
  private free: WebGLQuery[] = [];
  private active: { query: WebGLQuery; sample: RenderSample } | undefined;
  readonly supported: boolean;
  private gl: WebGL2RenderingContext;
  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.supported = Boolean(this.ext && Number(gl.getQuery(this.ext.TIME_ELAPSED_EXT, this.ext.QUERY_COUNTER_BITS_EXT)) > 0);
    if (!this.supported) this.ext = null;
    if (this.ext) gl.getParameter(this.ext.GPU_DISJOINT_EXT); // Clear pre-capture disjoint state.
  }
  get waiting() { return this.pending.length; }
  begin(sample: RenderSample) {
    if (this.gl.isContextLost()) { sample.gpuStatus = 'context-lost'; return; }
    if (!this.ext) { sample.gpuStatus = 'unsupported'; return; }
    this.poll();
    if (this.active || this.pending.length >= 12 || this.gl.getQuery(this.ext.TIME_ELAPSED_EXT, this.gl.CURRENT_QUERY)) {
      sample.gpuStatus = 'busy'; return;
    }
    const query = this.free.pop() || this.gl.createQuery();
    if (!query) { sample.gpuStatus = 'error'; return; }
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    sample.gpuStatus = 'pending';
    this.active = { query, sample };
  }
  end(sample: RenderSample) {
    if (this.active?.sample !== sample || !this.ext) return;
    if (this.gl.isContextLost()) { this.dispose('context-lost'); return; }
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
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
    cpuMs: distribution(samples.map(s => s.cpuMs)),
    gpuMs: distribution(samples.flatMap(s => s.gpuStatus === 'valid' && s.gpuMs !== null ? [s.gpuMs] : [])),
    gpuStatuses, over33ms: intervals.filter(n => n > 33.34).length, over50ms: intervals.filter(n => n > 50).length,
    calls: distribution(samples.map(s => s.calls)), triangles: distribution(samples.map(s => s.triangles)),
    failedFrames: samples.filter(s => s.failed).length };
}

type RendererRecord = { name: string; renderer: WebGLRenderer; timer?: AsyncGpuTimer; events: AbortController; adapter?: Record<string, unknown> };
export type FrameToken = { sample: RenderSample; record: RendererRecord; cpuStart: number; autoReset: boolean };

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
  private records = new Map<WebGLRenderer, RendererRecord>();
  private lastRaf: number | null = null;
  private lastRenderer: WebGLRenderer | undefined;
  private lastState = '';
  private lastSize = '';
  private limitMs = 60_000;
  private stopReason = '';
  private now: () => number;
  constructor(now: () => number = () => performance.now()) { this.now = now; }

  register(name: string, renderer: WebGLRenderer) {
    const record: RendererRecord = { name, renderer, events: new AbortController() };
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
    return () => { record.timer?.dispose('context-lost'); record.events.abort(); this.records.delete(renderer); };
  }
  private prepare(record: RendererRecord) {
    record.timer?.dispose();
    const gl = record.renderer.getContext() as WebGL2RenderingContext;
    record.timer = new AsyncGpuTimer(gl);
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || 'unknown');
    record.adapter = { name: record.name, renderer,
      vendor: gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR),
      software: /swiftshader|llvmpipe|softpipe|software/i.test(renderer),
      identityUnmasked: Boolean(debug), gpuTimerSupported: record.timer.supported };
  }
  start(metadata: unknown, seconds = 60) {
    for (const record of this.records.values()) record.timer?.dispose();
    this.samples = []; this.events = []; this.longTasks = [];
    this.metadata = metadata; this.endMetadata = undefined;
    this.startedISO = new Date().toISOString(); this.stoppedAt = 0;
    this.limitMs = Math.max(1, Math.min(120, seconds)) * 1000;
    this.stopReason = ''; this.lastState = ''; this.lastSize = '';
    // Extension discovery happens before the measured interval.
    for (const record of this.records.values()) this.prepare(record);
    this.startedAt = this.now(); this.running = true;
    this.lastRaf = null; this.lastRenderer = undefined;
    this.mark('start', { limitSeconds: this.limitMs / 1000 });
  }
  stop(reason = 'manual') {
    if (!this.running) return;
    this.mark('stop', reason); this.running = false;
    this.stopReason = reason; this.stoppedAt = this.now(); this.lastRaf = null;
  }
  mark(kind: string, detail?: unknown) {
    if (this.running && this.events.length < 4000) this.events.push({ at: this.now() - this.startedAt, kind, detail });
  }
  breakTimeline(reason: string) { this.lastRaf = null; this.mark('pause-boundary', reason); }
  addLongTask(startTime: number, duration: number) {
    const end = this.running ? this.now() : this.stoppedAt;
    if (startTime >= this.startedAt && startTime <= end && this.longTasks.length < 4000)
      this.longTasks.push({ at: startTime - this.startedAt, durationMs: duration });
  }
  begin(rafTime: number | null, renderer: WebGLRenderer, state: string): FrameToken | undefined {
    if (!this.running) return;
    if (this.now() - this.startedAt >= this.limitMs || this.samples.length >= 24_000) { this.stop('limit'); return; }
    const record = this.records.get(renderer);
    if (!record) return;
    const size = `${record.name}:${renderer.domElement.width}x${renderer.domElement.height}`;
    if (state !== this.lastState) { this.mark('state', state); this.lastState = state; }
    if (size !== this.lastSize) { this.mark('render-surface', size); this.lastSize = size; }
    const intervalMs = rafTime !== null && this.lastRaf !== null && this.lastRenderer === renderer && rafTime > this.lastRaf
      ? rafTime - this.lastRaf : null;
    if (rafTime !== null) { this.lastRaf = rafTime; this.lastRenderer = renderer; }
    const sample: RenderSample = { id: this.samples.length, at: this.now() - this.startedAt, renderer: record.name, state,
      intervalMs, cpuMs: 0, gpuMs: null, gpuStatus: 'unsupported', calls: 0, triangles: 0,
      geometries: 0, textures: 0, programs: 0, width: renderer.domElement.width, height: renderer.domElement.height, failed: false };
    this.samples.push(sample);
    record.timer?.begin(sample);
    // Include every pass, especially transmission, shadows and SMAA in the viewer.
    const autoReset = renderer.info.autoReset;
    renderer.info.autoReset = false; renderer.info.reset();
    return { sample, record, autoReset, cpuStart: this.now() };
  }
  end(token: FrameToken | undefined, failed = false) {
    if (!token) return;
    const { record, sample } = token;
    sample.cpuMs = this.now() - token.cpuStart;
    sample.failed = failed;
    record.timer?.end(sample);
    const info = record.renderer.info;
    sample.calls = info.render.calls; sample.triangles = info.render.triangles;
    sample.geometries = info.memory.geometries; sample.textures = info.memory.textures; sample.programs = info.programs?.length || 0;
    record.renderer.info.autoReset = token.autoReset;
  }
  poll() {
    if (this.running && this.now() - this.startedAt >= this.limitMs) this.stop('limit');
    for (const record of this.records.values()) {
      record.timer?.poll();
      if (!this.running && this.stoppedAt && (!record.timer?.waiting || this.now() - this.stoppedAt > 5000)) record.timer?.dispose();
    }
  }
  get pendingGpu() { return [...this.records.values()].reduce((n, r) => n + (r.timer?.waiting || 0), 0); }
  get adapters() { return [...this.records.values()].flatMap(r => r.adapter ? [r.adapter] : []); }
  get elapsedMs() { return this.startedISO ? (this.running ? this.now() : this.stoppedAt) - this.startedAt : 0; }
  report() {
    const byState: Record<string, ReturnType<typeof summarizeFrames>> = {};
    for (const state of new Set(this.samples.map(s => s.state))) byState[state] = summarizeFrames(this.samples.filter(s => s.state === state));
    return { schema: 'rhine-render-capture/v1', startedAt: this.startedISO, elapsedMs: this.elapsedMs, running: this.running,
      stopReason: this.stopReason, pendingGpu: this.pendingGpu, adapters: this.adapters, metadata: this.metadata, endMetadata: this.endMetadata,
      scope: { frame: 'Actual RAF cadence; excludes boundaries across hidden/inactive contexts. Not presentation FPS.',
        cpu: 'Synchronous scene update + WebGL submission wall time; excludes probe bookkeeping and tasks outside the render callback.',
        gpu: 'Elapsed WebGL commands, including shadow/transmission/postprocessing passes. Excludes browser composition and other GPU clients.',
        resources: 'Renderer resource COUNTS, not bytes or VRAM usage.',
        longTasks: 'Page-wide main-thread tasks >= 50ms; may overlap CPU samples. Do not add CPU and GPU time.',
        warmup: 'No automatic exclusions: first-use hitches after Start are retained.',
        limits: '120 seconds / 24000 frames maximum; 12 asynchronous GPU queries per context; UI refresh at 2Hz.' },
      summary: summarizeFrames(this.samples), byState,
      longTasksSupported: this.longTasksSupported, longTaskMs: distribution(this.longTasks.map(t => t.durationMs)),
      longTasks: this.longTasks, events: this.events, frames: this.samples };
  }
  dispose() {
    this.stop('dispose');
    for (const record of this.records.values()) { record.timer?.dispose(); record.events.abort(); }
    this.records.clear();
  }
}
