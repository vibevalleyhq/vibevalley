import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import { omitUndefined } from "@vibevalley/protocol/rules";

import { defineAtom } from "#/state/atom.ts";
import { styleProps } from "#/ui/positioner.ts";

import { SpriteIcon } from "./icons";
import { pxStyle } from "./style";

const styles = stylex.create({
  toastCardDiv: {
    gridArea: "1 / 1",
    display: "flex",
    transformOrigin: "50%",
    touchAction: "none",
    alignItems: "center",
    gap: "0.75rem",
    alignSelf: "flex-start",
    backgroundColor: "var(--color-cream-50)",
    padding: "0.75rem",
    color: "var(--color-bark-900)",
    boxShadow: "2px 2px 0 0 var(--color-px-drop)",
    transitionTimingFunction: "var(--ease-out)",
    transitionDuration: ".3s",
    translate: {
      default: null,
      "@starting-style": "0 -120%",
    },
  },
  toastCardDivPrimary: {
    transitionProperty: {
      default: "translate,transform,opacity",
      "@media (prefers-reduced-motion:reduce)": "none",
    },
  },
  toastCardDivSecondary: {
    transitionProperty: {
      default: "none",
      "@media (prefers-reduced-motion:reduce)": "none",
    },
  },
  toastCardDivStateA: {
    opacity: "1",
  },
  toastCardDivStateB: {
    opacity: "0",
  },
  toastCardDivModeA: {
    pointerEvents: "none",
  },
  toastCardDivModeB: {
    pointerEvents: "auto",
  },
  stack: { display: "grid", width: "min(320px,100vw - 32px)" },
  icon: {
    display: "grid",
    width: "2.5rem",
    height: "2.5rem",
    flexShrink: 0,
    placeItems: "center",
  },
  neutral: { backgroundColor: "var(--color-cream-200)" },
  warning: {
    backgroundColor: {
      default: "var(--color-px-toast-warn)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-peach) 30%, transparent)",
    },
  },
  error: {
    backgroundColor: {
      default: "var(--color-berry)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-berry) 15%, transparent)",
    },
  },
  toastViewportDiv: (top: number) => ({
    pointerEvents: "none",
    position: "fixed",
    insetInline: "0",
    top,
    zIndex: 50,
    display: "flex",
    justifyContent: "center",
  }),
  toastCardBody: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
  },
  toastKicker: {
    color: "var(--color-leaf-700)",
  },
  toastDescription: {
    color: "var(--color-bark-600)",
  },
});

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

interface ToastInput {
  type?: ToastType;
  title: string;
  description?: string;
  timeout?: number;
}

/** The list of toasts. Each closes after its timeout (5 s by default), held while the pointer is over the stack. */
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

const tone: Partial<Record<ToastType, stylex.StyleXStyles>> = { warn: styles.warning, error: styles.error };

/** The stack of toasts, top centre over the page. The pointer over it holds their timeouts. */
export function ToastViewport(props: {
  store?: ToastStore;
  leading?: (toast: ToastData) => JSX.Element;
  kicker?: (toast: ToastData) => string | undefined;
  top?: number;
}) {
  // Which store is fixed for the viewport's life.
  const store = untrack(() => props.store) ?? toasts;
  return (
    // Only the cards take the pointer: around them (and with none shown) clicks go through to the page below.
    <div {...styleProps(styles.toastViewportDiv(props.top ?? 12))}>
      <div role="status" aria-live="polite" {...stylex.attrs(styles.stack)} onMouseEnter={() => store.pause()} onMouseLeave={() => store.resume()}>
        <For each={store.toasts} keyed={(t) => t.id}>
          {(t, i) => (
            <ToastCard
              toast={t()}
              index={i()}
              hidden={i() >= store.limit}
              leading={props.leading?.(t())}
              kicker={props.kicker?.(t())}
              onClose={() => store.close(t().id)}
            />
          )}
        </For>
      </div>
    </div>
  );
}

function ToastCard(props: { toast: ToastData; index: number; hidden: boolean; leading?: JSX.Element; kicker?: string | undefined; onClose: () => void }) {
  const [drag, setDrag] = createSignal({ x: 0, y: 0 });
  let from: { x: number; y: number } | undefined = undefined;
  const front = () => props.index === 0 && !props.hidden;
  return (
    <div
      // The newest is drawn on top; those behind it shrink and step down.
      {...styleProps(
        [
          styles.toastCardDiv,
          drag().x > 0 || drag().y > 0 ? styles.toastCardDivSecondary : styles.toastCardDivPrimary,
          props.hidden ? styles.toastCardDivStateB : styles.toastCardDivStateA,
          front() ? styles.toastCardDivModeB : styles.toastCardDivModeA,
        ],
        {
          "z-index": 100 - props.index,
          transform: `translate(${drag().x}px, ${props.index * 9.6 + drag().y}px) scale(${1 - props.index * 0.05})`,
        },
      )}
      onPointerDown={(e) => {
        from = { x: e.clientX, y: e.clientY };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (from) setDrag({ x: Math.max(0, e.clientX - from.x), y: Math.max(0, e.clientY - from.y) });
      }}
      onPointerUp={() => {
        from = undefined;
        if (drag().x > 40 || drag().y > 40) props.onClose();
        else setDrag({ x: 0, y: 0 });
      }}
      onPointerCancel={() => {
        from = undefined;
        setDrag({ x: 0, y: 0 });
      }}
    >
      <Show
        when={props.leading}
        fallback={
          <span {...stylex.attrs(styles.icon, tone[props.toast.type] ?? styles.neutral)}>
            <SpriteIcon name="icon-bell" size={32} />
          </span>
        }
      >
        {props.leading}
      </Show>
      <div {...stylex.attrs(styles.toastCardBody)}>
        <Show when={props.kicker}>
          <span {...stylex.attrs(pxStyle.xs, styles.toastKicker)}>{props.kicker}</span>
        </Show>
        <span {...stylex.attrs(pxStyle.sm)}>{props.toast.title}</span>
        <Show when={props.toast.description}>
          <span {...stylex.attrs(pxStyle.xs, styles.toastDescription)}>{props.toast.description}</span>
        </Show>
      </div>
    </div>
  );
}
