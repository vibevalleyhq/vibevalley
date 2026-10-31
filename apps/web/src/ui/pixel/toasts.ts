// Each closes after its timeout (5 s by default), held while the pointer is over the stack; past `limit` they hide.

import { t } from "@vibevalley/i18n";
import { omitUndefined } from "@vibevalley/protocol/rules";

import { defineAtom } from "@/state/atom";

export const ToastType = { info: "info", warn: "warn", error: "error", achievement: "achievement" } as const;
export type ToastType = (typeof ToastType)[keyof typeof ToastType];

export const noticeTitle: Partial<Record<ToastType, string>> = {
  info: t("web.ui.pixel.noticeTitle.info"),
  warn: t("web.ui.pixel.noticeTitle.warn"),
  error: t("web.ui.pixel.noticeTitle.error"),
};

export interface ToastData {
  readonly id: number;
  readonly type: ToastType;
  readonly title: string;
  readonly description?: string;
  /** Milliseconds; 0 or less stays until closed. */
  readonly timeout: number;
}

export interface ToastInput {
  type?: ToastType;
  title: string;
  description?: string;
  timeout?: number;
}

/** The list is a value of the page's (state/atom.ts); the timers, held while the pointer is over the stack, are the store's. */
export class ToastStore {
  private readonly list = defineAtom<readonly ToastData[]>([]);
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly left = new Map<number, number>();
  private readonly started = new Map<number, number>();
  private next = 0;
  private paused = false;

  /** The rest wait hidden behind. */
  readonly limit: number;
  constructor(limit: number = 3) {
    this.limit = limit;
  }

  /** Newest first; read in a computation or a component, it follows them. */
  get toasts(): readonly ToastData[] {
    return this.list.get();
  }

  add({ type = "info", title, description, timeout = 5000 }: ToastInput): number {
    const t: ToastData = omitUndefined({ id: ++this.next, type, title, description, timeout });
    this.left.set(t.id, timeout);
    if (!this.paused) this.start(t.id);
    this.list.update((list) => [t, ...list]);
    return t.id;
  }

  close(id: number) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.left.delete(id);
    this.started.delete(id);
    if (this.list.get().some((t) => t.id === id)) this.list.update((list) => list.filter((t) => t.id !== id));
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
    for (const t of this.list.get()) this.start(t.id);
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
}

export const toasts = new ToastStore();
