// Each closes after its timeout (5 s by default), held while the pointer is over the stack; past `limit` they hide.

export const ToastType = { info: "info", warn: "warn", error: "error", achievement: "achievement" } as const;
export type ToastType = (typeof ToastType)[keyof typeof ToastType];

export const noticeTitle: Partial<Record<ToastType, string>> = { info: "提示", warn: "没派成", error: "出错了" };

export interface ToastData {
  readonly id: number;
  readonly type: ToastType;
  readonly title: string;
  readonly description?: string;
  /** Milliseconds; 0 or less stays until closed. */
  readonly timeout: number;
  readonly data?: unknown;
}

export interface ToastInput {
  type?: ToastType;
  title: string;
  description?: string;
  timeout?: number;
  data?: unknown;
}

export class ToastStore {
  private list: readonly ToastData[] = [];
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly left = new Map<number, number>();
  private readonly started = new Map<number, number>();
  private readonly listeners = new Set<() => void>();
  private next = 0;
  private paused = false;

  /** The rest wait hidden behind. */
  constructor(readonly limit = 3) {}

  /** Newest first. */
  get toasts(): readonly ToastData[] {
    return this.list;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  readonly snapshot = () => this.list;

  add({ type = "info", title, description, timeout = 5000, data }: ToastInput): number {
    const t: ToastData = { id: ++this.next, type, title, description, timeout, data };
    this.list = [t, ...this.list];
    this.left.set(t.id, timeout);
    if (!this.paused) this.start(t.id);
    this.emit();
    return t.id;
  }

  close(id: number) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.left.delete(id);
    this.started.delete(id);
    const before = this.list.length;
    this.list = this.list.filter((t) => t.id !== id);
    if (this.list.length !== before) this.emit();
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    const now = Date.now();
    for (const [id, timer] of this.timers) {
      clearTimeout(timer);
      const started = this.started.get(id);
      const left = this.left.get(id);
      if (started !== undefined && left !== undefined) this.left.set(id, left - (now - started));
    }
    this.timers.clear();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    for (const t of this.list) this.start(t.id);
  }

  private start(id: number) {
    const left = this.left.get(id);
    if (left === undefined || left <= 0) return;
    this.started.set(id, Date.now());
    this.timers.set(
      id,
      setTimeout(() => this.close(id), left),
    );
  }

  private emit() {
    for (const l of this.listeners) l();
  }
}

export const toasts = new ToastStore();
