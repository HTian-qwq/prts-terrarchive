import * as THREE from "three";
import { ARCHIVE_LABEL_WIDTH, ARCHIVE_LABEL_HEIGHT, archiveLabelKey, paintArchiveLabel, type ArchiveLabel } from "./archive-label";
import type { RenderPerformanceCapture } from "../temporary-performance";

type Family = "hero-label" | "moving-label" | "shelf-label";
type Entry = { id: number; texture: THREE.CanvasTexture; refs: number; used: number; prepared: boolean };
export type LabelPrefetchContext = { plan: number; slot: number; intent?: 'row' | 'lane' | 'pointer' | 'activity' };

/** Immutable prints; active owners and the bounded next-navigation working set share storage. */
export class ArchiveLabelTextures {
  private readonly entries = new Map<string, Entry>();
  private readonly bindings = new Map<THREE.MeshBasicMaterial, Entry>();
  private candidates = new Set<string>();
  private readonly evicted = new Map<string, number>();
  private sequence = 0;
  private clock = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private disposed = false;
  constructor(private readonly mark: HTMLImageElement, private readonly anisotropy: number,
    private readonly probe: () => RenderPerformanceCapture | undefined, private readonly idleLimit = 6) {}
  private key(content: ArchiveLabel) { return `${archiveLabelKey(content)}:${document.fonts?.status || "loaded"}`; }
  private get(content: ArchiveLabel, family: Family, use: 'bind' | 'prefetch', context?: LabelPrefetchContext) {
    if (this.disposed) throw new Error("Archive label cache is disposed");
    const key = this.key(content);
    let entry = this.entries.get(key);
    const hit = Boolean(entry), previousEntry = this.evicted.get(key);
    if (entry) this.hits++;
    else {
      this.misses++;
      const id = ++this.sequence;
      const canvas = document.createElement("canvas"); canvas.width = ARCHIVE_LABEL_WIDTH; canvas.height = ARCHIVE_LABEL_HEIGHT;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = this.anisotropy;
      texture.userData.archivePrint = true; texture.userData.sharedArchiveLabel = true;
      const created: Entry = { id, texture, refs: 0, used: 0, prepared: false };
      // Natural draws and explicit preloads both submit the texture. The probe
      // chains this callback; submission does not imply GPU completion.
      texture.onUpdate = () => { created.prepared = true; };
      const paint = () => { paintArchiveLabel(canvas, this.mark, content); texture.needsUpdate = true; };
      try { const probe = this.probe(); if (probe) probe.texturePaint(texture, family, paint, id); else paint(); }
      catch (error) { texture.dispose(); throw error; }
      entry = created; this.entries.set(key, entry);
    }
    this.probe()?.observeTexture(entry.texture, family, entry.id);
    entry.used = ++this.clock;
    this.probe()?.diagnostic('resourceUpdates', { kind: 'label-cache', family, use, hit, cacheEntry: entry.id,
      prepared: entry.prepared, candidate: this.candidates.has(key), fontStatus: document.fonts?.status || 'loaded',
      missReason: hit ? undefined : previousEntry ? 'evicted' : 'not-resident', previousEntry: hit ? undefined : previousEntry,
      ...context, ...this.stats() });
    return entry;
  }
  /** Protect at most idleLimit candidates; never increase the idle texture budget. */
  setPrefetchCandidates(contents: readonly ArchiveLabel[]) {
    if (this.disposed) return;
    this.candidates = new Set(contents.map(content => this.key(content)).slice(0, this.idleLimit));
    this.trim();
  }
  bind(material: THREE.MeshBasicMaterial, content: ArchiveLabel, family: Family) {
    const current = this.bindings.get(material);
    if (current && this.entries.get(this.key(content)) === current) return current.texture;
    const next = this.get(content, family, 'bind');
    next.refs++;
    if (current) { current.refs--; current.used = ++this.clock; }
    this.bindings.set(material, next); material.map = next.texture; this.trim();
    return next.texture;
  }
  /** Keep the exact visible print when returning, including across font readiness changes. */
  share(source: THREE.MeshBasicMaterial, target: THREE.MeshBasicMaterial) {
    const next = this.bindings.get(source); if (!next) return undefined;
    const current = this.bindings.get(target);
    this.probe()?.observeTexture(next.texture, 'moving-label', next.id);
    if (current !== next) {
      next.refs++; if (current) { current.refs--; current.used = ++this.clock; }
      next.used = ++this.clock; this.bindings.set(target, next); target.map = next.texture;
      this.hits++; this.trim();
      this.probe()?.diagnostic('resourceUpdates', { kind: 'label-cache', family: 'moving-label', use: 'share', hit: true,
        cacheEntry: next.id, prepared: next.prepared, reason: 'retain-visible-print', ...this.stats() });
    }
    return next.texture;
  }
  prepare(content: ArchiveLabel, renderer: THREE.WebGLRenderer, context?: LabelPrefetchContext) {
    const entry = this.get(content, 'hero-label', 'prefetch', context);
    renderer.initTexture(entry.texture); entry.prepared = true; this.trim();
    this.probe()?.diagnostic('resourceUpdates', { kind: 'label-prefetch-submitted', cacheEntry: entry.id, ...context });
  }
  invalidateResidency() { for (const entry of this.entries.values()) entry.prepared = false; }
  isPrepared(content: ArchiveLabel) { return this.entries.get(this.key(content))?.prepared === true; }
  release(material: THREE.MeshBasicMaterial) {
    const entry = this.bindings.get(material); if (!entry) return;
    this.bindings.delete(material); entry.refs--; entry.used = ++this.clock; this.trim();
  }
  private trim() {
    const idle = [...this.entries.entries()].filter(([, entry]) => entry.refs === 0).sort((a, b) =>
      Number(this.candidates.has(a[0])) - Number(this.candidates.has(b[0])) || a[1].used - b[1].used);
    for (const [key, entry] of idle.slice(0, Math.max(0, idle.length - this.idleLimit))) {
      this.entries.delete(key); entry.texture.dispose(); this.evictions++;
      this.evicted.delete(key); this.evicted.set(key, entry.id);
      if (this.evicted.size > 32) this.evicted.delete(this.evicted.keys().next().value!);
      this.probe()?.diagnostic('resourceUpdates', { kind: 'label-cache-evict', cacheEntry: entry.id,
        reason: this.candidates.has(key) ? 'candidate-budget' : 'idle-budget', prepared: entry.prepared, ...this.stats() });
    }
  }
  stats() {
    let active = 0, protectedIdle = 0;
    for (const [key, entry] of this.entries) { if (entry.refs) active++; else if (this.candidates.has(key)) protectedIdle++; }
    return { textures: this.entries.size, active, idle: this.entries.size - active, references: this.bindings.size,
      idleLimit: this.idleLimit, protectedIdle, candidates: this.candidates.size, hits: this.hits, misses: this.misses, evictions: this.evictions,
      rgba8BaseBytes: this.entries.size * ARCHIVE_LABEL_WIDTH * ARCHIVE_LABEL_HEIGHT * 4 };
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    for (const entry of this.entries.values()) entry.texture.dispose();
    this.entries.clear(); this.bindings.clear(); this.candidates.clear(); this.evicted.clear();
  }
}
