export interface PreparationScheduler {
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(handle: number): void;
}

export interface DeferredPreparationOptions {
  scheduler?: PreparationScheduler;
  onError?: (error: unknown, key: string) => void;
}

type PreparationTask = () => void | Promise<void>;
type PendingTask = { task: PreparationTask; priority: number };

/** Prepare at most one object after each animation-frame opportunity. */
export class DeferredPreparation {
  private readonly scheduler: PreparationScheduler;
  private readonly onError: (error: unknown, key: string) => void;
  private readonly pending = new Map<string, PendingTask>();
  private active = true;
  private disposed = false;
  private running = false;
  private completed = 0;
  private frame: number | undefined;
  private timer: number | undefined;
  private generation = 0;

  constructor(options: DeferredPreparationOptions = {}) {
    this.scheduler = options.scheduler ?? {
      requestAnimationFrame: callback => globalThis.requestAnimationFrame(callback),
      cancelAnimationFrame: handle => globalThis.cancelAnimationFrame(handle),
      setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
      clearTimeout: handle => globalThis.clearTimeout(handle),
    };
    this.onError = options.onError ?? ((error, key) => {
      console.error(`Archive preparation failed: ${key}`, error);
    });
  }

  /** Higher priority runs first. Replacing a pending key preserves FIFO order. */
  enqueue(key: string, task: PreparationTask, priority = 0) {
    if (this.disposed) return;
    this.pending.set(key, { task, priority: Number.isFinite(priority) ? priority : 0 });
    this.schedule();
  }

  /** Running work owns its cleanup; cancellation only removes pending work. */
  cancel(key: string) {
    this.pending.delete(key);
    if (this.pending.size === 0) this.cancelScheduled();
  }

  setActive(active: boolean) {
    if (this.disposed || this.active === active) return;
    this.active = active;
    if (active) this.schedule();
    else this.cancelScheduled();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.pending.clear();
    this.cancelScheduled();
  }

  stats() {
    return { pending: this.pending.size, running: this.running, completed: this.completed };
  }

  private cancelScheduled() {
    this.generation++;
    if (this.frame !== undefined) this.scheduler.cancelAnimationFrame(this.frame);
    if (this.timer !== undefined) this.scheduler.clearTimeout(this.timer);
    this.frame = undefined;
    this.timer = undefined;
  }

  private schedule() {
    if (this.disposed || !this.active || this.running || this.pending.size === 0 ||
      this.frame !== undefined || this.timer !== undefined) return;
    const generation = this.generation;
    this.frame = this.scheduler.requestAnimationFrame(() => {
      if (generation !== this.generation) return;
      this.frame = undefined;
      if (this.disposed || !this.active) return;
      // Work in a subsequent task, not inside the scene's animation callback.
      this.timer = this.scheduler.setTimeout(() => {
        if (generation !== this.generation) return;
        this.timer = undefined;
        this.runNext();
      }, 0);
    });
  }

  private runNext() {
    if (this.disposed || !this.active || this.running) return;
    let selectedKey: string | undefined;
    let selected: PendingTask | undefined;
    for (const [key, pending] of this.pending) {
      if (!selected || pending.priority > selected.priority) {
        selected = pending;
        selectedKey = key;
      }
    }
    if (!selected || selectedKey === undefined) return;
    const key = selectedKey;
    this.pending.delete(key);
    this.running = true;
    let result: void | Promise<void>;
    try {
      result = selected.task();
    } catch (error) {
      this.settle(key, false, error);
      return;
    }
    Promise.resolve(result).then(
      () => this.settle(key, true),
      error => this.settle(key, false, error),
    );
  }

  private settle(key: string, succeeded: boolean, error?: unknown) {
    this.running = false;
    if (succeeded) this.completed++;
    else {
      try { this.onError(error, key); }
      catch (handlerError) {
        // A reporting callback must not reject the task's settlement promise
        // or leave the remaining preparation queue stalled.
        console.error("Archive preparation error handler failed.", handlerError);
      }
    }
    this.schedule();
  }
}
