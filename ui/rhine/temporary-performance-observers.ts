// TEMPORARY RHINE PROFILER: observers exist only during an explicitly started capture.
import { RenderPerformanceCapture } from './temporary-performance.ts';
import type { DiagnosticChannel } from './temporary-performance.ts';

type Entry = Record<string, unknown>;
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const fields = (entry: Entry, keys: string[]) => Object.fromEntries(keys.map(key => [key, number(entry[key])]));
const relative = (value: unknown, origin: number) => typeof value === 'number' && value > 0 ? value - origin : null;
const allowed = (value: unknown, list: string[]) => typeof value === 'string' && list.includes(value) ? value : 'other';

/** Only authored public asset names; never export arbitrary URLs or document IDs. */
export function resourceIdentity(value: unknown) {
  if (typeof value !== 'string') return null;
  try {
    const name = new URL(value, 'https://local.invalid').pathname.split('/').pop() || '';
    return ['archive-cassette.glb', 'archive-assembly.glb', 'rhine.js', 'rhine.css', 'client.js', 'evidence-observatory.webp'].includes(name)
      ? name : /^MiSans-(Light|Regular|Medium|Demibold|Semibold|SemiBold|Bold)\.woff2?$/.test(name) ? name : null;
  } catch { return null; }
}
function surface(node: unknown) {
  if (typeof Element === 'undefined' || !(node instanceof Element)) return 'unknown';
  for (const [selector, name] of [['.rhine-perf-tools', 'profiler'], ['.rhine-reader', 'reader'],
    ['.rhine-report', 'report'], ['.model-viewer', 'viewer'], ['.rhine-case', 'status'], ['canvas', 'canvas']]) {
    if (node.closest(selector)) return name;
  }
  return 'other-ui';
}
export function resourceKind(value: unknown) {
  if (typeof value !== 'string') return 'unknown';
  try {
    const path = new URL(value, 'https://local.invalid').pathname;
    if (/\/rhine\.js$/.test(path)) return 'rhine-bundle';
    if (/\/client\.js$/.test(path)) return 'host-client';
    if (/\.(woff2?|ttf|otf)$/i.test(path)) return 'font';
    if (/\.(glb|gltf)$/i.test(path)) return 'model';
    if (/\.(png|jpg|jpeg|webp|avif|svg)$/i.test(path)) return 'image';
    if (/\.css$/i.test(path)) return 'stylesheet';
    if (/\.(m?js)$/i.test(path)) return 'other-script';
    return 'other';
  } catch { return 'unknown'; }
}
export function sanitizePerformanceEntry(type: string, entry: Entry, origin: number): Record<string, unknown> {
  if (type === 'long-animation-frame') {
    const scripts = Array.isArray(entry.scripts) ? entry.scripts : [];
    return { ...fields(entry, ['duration', 'blockingDuration']),
      renderStart: relative(entry.renderStart, origin), styleAndLayoutStart: relative(entry.styleAndLayoutStart, origin),
      firstUIEventTimestamp: relative(entry.firstUIEventTimestamp, origin),
      scriptsTotal: scripts.length, scriptsOmitted: Math.max(0, scripts.length - 16),
      scripts: scripts.slice(0, 16).map((value: Entry) => ({
        source: resourceKind(value.sourceURL), asset: resourceIdentity(value.sourceURL),
        invokerType: allowed(value.invokerType, ['event-listener', 'user-callback', 'resolve-promise', 'reject-promise', 'classic-script', 'module-script']),
        windowAttribution: allowed(value.windowAttribution, ['self', 'same-origin-ancestor', 'same-origin-descendant', 'same-origin', 'cross-origin-ancestor', 'cross-origin-descendant', 'cross-origin', 'other']),
        executionStart: relative(value.executionStart, origin),
        ...fields(value, ['duration', 'pauseDuration', 'forcedStyleAndLayoutDuration', 'sourceCharPosition']),
      })) };
  }
  if (type === 'event') return {
    event: allowed(entry.name, ['click', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'keydown', 'keyup', 'touchstart', 'touchend', 'input', 'change']),
    ...fields(entry, ['duration', 'interactionId']),
    inputDelayMs: typeof entry.processingStart === 'number' && typeof entry.startTime === 'number' ? entry.processingStart - entry.startTime : null,
    processingMs: typeof entry.processingStart === 'number' && typeof entry.processingEnd === 'number' ? entry.processingEnd - entry.processingStart : null,
  };
  if (type === 'resource') return {
    resource: resourceKind(entry.name), asset: resourceIdentity(entry.name),
    initiator: allowed(entry.initiatorType, ['fetch', 'xmlhttprequest', 'script', 'css', 'img', 'link', 'other']),
    ...fields(entry, ['duration', 'transferSize', 'encodedBodySize', 'decodedBodySize', 'responseStatus']),
    responseStart: relative(entry.responseStart, origin), responseEnd: relative(entry.responseEnd, origin),
  };
  if (type === 'layout-shift') return { value: number(entry.value), hadRecentInput: entry.hadRecentInput === true,
    surfaces: [...new Set((Array.isArray(entry.sources) ? entry.sources : []).map((source: Entry) => surface(source.node)))] };
  return { duration: number(entry.duration) };
}

export function observePerformance(capture: RenderPerformanceCapture, root: HTMLElement, state: () => unknown = () => null) {
  const observers: { observer: PerformanceObserver; consume: (entries: PerformanceEntry[]) => void }[] = [];
  const events = new AbortController();
  const types: [string, DiagnosticChannel | 'longtask'][] = [
    ['longtask', 'longtask'], ['long-animation-frame', 'longAnimationFrames'],
    ['event', 'interactions'], ['resource', 'resources'], ['layout-shift', 'layoutShifts'],
  ];
  for (const [type, channel] of types) {
    const supported = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes(type) === true;
    const capability: { supported: boolean; active: boolean; reason: string } = capture.capabilities[type] = { supported, active: false, reason: supported ? '' : 'unsupported' };
    if (type === 'longtask') capture.longTasksSupported = supported;
    if (!supported) continue;
    const consume = (entries: PerformanceEntry[]) => {
      if (!entries.length) return;
      const start = performance.now();
      for (const entry of entries) {
        if (channel === 'longtask') capture.addLongTask(entry.startTime, entry.duration);
        else {
          const detail = sanitizePerformanceEntry(type, entry as unknown as Entry, capture.startedAt);
          if (type === 'event') {
            capture.diagnostic('interactionSummary', { kind: detail.event, durationMs: detail.duration,
              inputDelayMs: detail.inputDelayMs, processingMs: detail.processingMs }, entry.startTime);
            // Hover/movement entries have interactionId=0 and formerly exhausted
            // the raw channel. Keep real interactions and slow anonymous events.
            if (!(Number(detail.interactionId) > 0 || Number(detail.duration) >= 48)) continue;
          }
          capture.diagnostic(channel, detail, entry.startTime);
        }
      }
      capture.diagnostic('overhead', { kind: 'observer', entryType: type, entries: entries.length, durationMs: performance.now() - start }, start);
    };
    let observer: PerformanceObserver | undefined;
    try {
      observer = new PerformanceObserver(list => consume(list.getEntries()));
      // Event Timing has a browser minimum threshold (16ms), and rounds durations.
      observer.observe({ type, buffered: false, ...(type === 'event' ? { durationThreshold: 16 } : {}) } as PerformanceObserverInit);
      observers.push({ observer, consume }); capability.active = true; capability.reason = '';
    } catch {
      observer?.disconnect(); capability.reason = 'observe-failed';
      if (type === 'longtask') capture.longTasksSupported = false;
    }
  }
  const memory = () => {
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    return heap ? { usedJSHeapSize: heap.usedJSHeapSize, totalJSHeapSize: heap.totalJSHeapSize, jsHeapSizeLimit: heap.jsHeapSizeLimit } : null;
  };
  capture.capabilities['js-heap'] = { supported: memory() !== null, active: memory() !== null, reason: 'Chromium estimate; may be shared/rounded; no GC attribution' };
  let expected = performance.now() + 1000;
  const heartbeat = (initial = false) => {
    const start = performance.now();
    if (!capture.running) return;
    capture.diagnostic('heartbeat', {
      timerDelayMs: initial ? null : Math.max(0, start - expected),
      hidden: document.hidden, focused: document.hasFocus(), visibility: document.visibilityState,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
        visualWidth: visualViewport?.width ?? null, visualHeight: visualViewport?.height ?? null, visualScale: visualViewport?.scale ?? null },
      fonts: document.fonts?.status ?? null, heap: memory(), pendingGpu: capture.pendingGpu,
      renderers: capture.rendererStates(), workbench: state(), loading: capture.loadingState(),
    }, start);
    expected = start + 1000;
    capture.diagnostic('overhead', { kind: 'heartbeat', durationMs: performance.now() - start }, start);
  };
  heartbeat(true);
  const interval = window.setInterval(heartbeat, 1000);
  const lifecycle = (kind: string, detail?: unknown) => capture.mark(kind, detail);
  for (const name of ['focus', 'blur']) window.addEventListener(name, () => lifecycle('window-' + name), { signal: events.signal });
  for (const name of ['pagehide', 'pageshow']) window.addEventListener(name, event => {
    capture.breakTimeline(name); lifecycle(name, { persisted: (event as PageTransitionEvent).persisted });
  }, { signal: events.signal });
  for (const name of ['freeze', 'resume']) document.addEventListener(name, () => capture.breakTimeline(name), { signal: events.signal });
  window.addEventListener('resize', () => lifecycle('viewport-resize', { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }), { signal: events.signal });
  let lastWheel = -Infinity;
  for (const name of ['pointerdown', 'wheel', 'keydown']) root.addEventListener(name, event => {
    if (!capture.running) return;
    if (name === 'wheel') { if (performance.now() - lastWheel < 150) return; lastWheel = performance.now(); }
    const target = event.target instanceof Element ? event.target : null;
    const surface = target?.closest('.rhine-perf-tools') ? 'profiler' : target?.closest('.model-viewer') ? 'viewer' : target?.tagName === 'CANVAS' ? 'scene' : 'ui';
    capture.mark('input', { type: name, surface, trusted: event.isTrusted,
      ...(name === 'keydown' ? { key: allowed((event as KeyboardEvent).key, ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape', 'Tab', 'Home', 'End', 'PageUp', 'PageDown', ' ']) } : {}) });
  }, { signal: events.signal, capture: true, passive: true });
  window.addEventListener('error', event => lifecycle('runtime-error', {
    kind: event instanceof ErrorEvent ? 'script' : 'resource',
    ...(event instanceof ErrorEvent ? { source: resourceKind(event.filename), line: event.lineno, column: event.colno } : {}),
  }), { signal: events.signal, capture: true });
  window.addEventListener('unhandledrejection', () => lifecycle('unhandled-rejection'), { signal: events.signal });
  return () => {
    clearInterval(interval); events.abort();
    for (const { observer, consume } of observers) { consume(observer.takeRecords()); observer.disconnect(); }
  };
}
