import { createSignal, For, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { pxDrop, pxText } from "./style";
import { type ToastData, type ToastStore, toasts } from "./toasts";
import { createExternal } from "../../base/external";
import { SpriteIcon } from "./icons";

const tone: Record<string, string> = { warn: "bg-[#f3b07a4d]", error: "bg-berry/15" };

/**
 * The stack of toasts, top centre over the page. The pointer over it holds their timeouts; a drag right or down past
 * 40 px closes the front one. `leading` and `kicker` replace the bell and add a line above the title (a medal, 解锁成就).
 */
export function ToastViewport(props: {
  store?: ToastStore;
  leading?: (toast: ToastData) => JSX.Element;
  kicker?: (toast: ToastData) => string | undefined;
  top?: number;
}) {
  // Which store is fixed for the viewport's life.
  const store = untrack(() => props.store) ?? toasts;
  const list = createExternal(store.subscribe, store.snapshot);
  return (
    // Only the cards take the pointer: around them (and with none shown) clicks go through to the page below.
    <div class="pointer-events-none fixed inset-x-0 z-50 flex justify-center" style={{ top: `${props.top ?? 12}px` }}>
      <div
        role="status"
        aria-live="polite"
        class="grid w-[min(320px,calc(100vw-32px))] [&>*]:[grid-area:1/1]"
        onMouseEnter={() => store.pause()}
        onMouseLeave={() => store.resume()}
      >
        <For each={list()} keyed={(t) => t.id}>
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

function ToastCard(props: { toast: ToastData; index: number; hidden: boolean; leading?: JSX.Element; kicker?: string; onClose: () => void }) {
  const [drag, setDrag] = createSignal({ x: 0, y: 0 });
  let from: { x: number; y: number } | null = null;
  const front = () => props.index === 0 && !props.hidden;
  return (
    <div
      // The newest is drawn on top; those behind it shrink and step down.
      style={{
        "z-index": 100 - props.index,
        transform: `translate(${drag().x}px, ${props.index * 9.6 + drag().y}px) scale(${1 - props.index * 0.05})`,
      }}
      class={[
        "flex origin-center items-center gap-3 self-start bg-cream-50 p-3 text-bark-900 touch-none",
        pxDrop,
        "transition-[translate,transform,opacity] duration-300 ease-out starting:-translate-y-[120%] motion-reduce:transition-none",
        { "transition-none": drag().x > 0 || drag().y > 0 },
        props.hidden ? "opacity-0" : "opacity-100",
        front() ? "pointer-events-auto" : "pointer-events-none",
      ]}
      onPointerDown={(e) => {
        from = { x: e.clientX, y: e.clientY };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (from) setDrag({ x: Math.max(0, e.clientX - from.x), y: Math.max(0, e.clientY - from.y) });
      }}
      onPointerUp={() => {
        from = null;
        if (drag().x > 40 || drag().y > 40) props.onClose();
        else setDrag({ x: 0, y: 0 });
      }}
      onPointerCancel={() => {
        from = null;
        setDrag({ x: 0, y: 0 });
      }}
    >
      <Show
        when={props.leading}
        fallback={
          <span class={["grid size-10 shrink-0 place-items-center", tone[props.toast.type] ?? "bg-cream-200"]}>
            <SpriteIcon name="icon-bell" size={32} />
          </span>
        }
      >
        {props.leading}
      </Show>
      <div class="flex min-w-0 flex-1 flex-col">
        <Show when={props.kicker}>
          <span class={[pxText.xs, "text-leaf-700"]}>{props.kicker}</span>
        </Show>
        <span class={pxText.sm}>{props.toast.title}</span>
        <Show when={props.toast.description}>
          <span class={[pxText.xs, "text-bark-600"]}>{props.toast.description}</span>
        </Show>
      </div>
    </div>
  );
}
