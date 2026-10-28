import { createEffect, createSignal, createUniqueId, For, Show } from "solid-js";
import { type PickOption, pickItems } from "./pick";
import { pxDrop, pxFocus, pxRing, pxText } from "./style";
import { aria } from "../../base/util";
import { PxWindow } from "./base";
import { PxTip } from "./field";
import { SpriteIcon } from "./icons";

export interface SegmentOption<T> {
  value: T;
  label: string;
  disabled?: boolean;
  /** The tooltip. */
  title?: string;
}

/** As wide as it is given; `block={false}` where it sits as a flex item beside others, as wide as its buttons. */
export function PxSegmented<T extends string | number | boolean>(props: {
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (value: T) => void;
  block?: boolean;
  label?: string;
}) {
  return (
    <div role="group" aria-label={props.label} class={[(props.block ?? true) ? "flex" : "inline-flex", "flex-wrap gap-1 bg-cream-200 p-1"]}>
      <For each={props.options}>
        {(o) => (
          <button
            type="button"
            title={o.title}
            aria-pressed={aria(o.value === props.value)}
            disabled={o.disabled}
            onClick={() => props.onChange(o.value)}
            class={[
              pxText.xs,
              pxRing,
              pxFocus,
              "h-7 cursor-pointer px-3 whitespace-nowrap enabled:active:translate-x-px enabled:active:translate-y-px disabled:cursor-default disabled:opacity-35",
              o.value === props.value ? "bg-leaf-500 text-bark-900" : "text-bark-800 enabled:hover:bg-cream-300",
            ]}
          >
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}

/** A dropdown as wide as it is given, so it needs a bounded width. */
export function PxPick(props: {
  value: string;
  options: readonly PickOption[];
  onChange: (value: string) => void;
  /** What the trigger says while nothing is chosen. */
  placeholder: string;
  disabled?: boolean;
  label?: string;
  clearable?: boolean;
  id?: string;
  testid?: string;
}) {
  const listId = createUniqueId();
  let wrap!: HTMLDivElement;
  const [open, setOpen] = createSignal(false);
  const [highlight, setHighlight] = createSignal(0);
  const items = () => pickItems(props.options, props.placeholder, props.clearable ?? false);
  const current = () => items().find((o) => o.value === props.value) ?? { value: "", label: props.placeholder };

  createEffect(open, (on) => {
    if (!on) return;
    const away = (e: PointerEvent) => {
      if (!wrap.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  });

  const show = () => {
    const at = items().findIndex((o) => o.value === props.value);
    setHighlight(at < 0 ? 0 : at);
    setOpen(true);
  };
  const pick = (v: string) => {
    setOpen(false);
    if (v !== props.value) props.onChange(v);
  };

  return (
    <div ref={(el) => (wrap = el)} class="relative w-full">
      <button
        id={props.id}
        data-testid={props.testid}
        type="button"
        disabled={props.disabled}
        aria-label={props.label}
        aria-haspopup="listbox"
        aria-expanded={aria(open())}
        aria-controls={open() ? listId : undefined}
        aria-activedescendant={open() ? `${listId}-${highlight()}` : undefined}
        onClick={() => (open() ? setOpen(false) : show())}
        onBlur={(e) => !wrap.contains(e.relatedTarget as Node | null) && setOpen(false)}
        onKeyDown={(e) => {
          const n = items().length;
          if (!open()) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              show();
            }
            return;
          }
          if (n === 0) return;
          if (e.key === "ArrowDown") setHighlight((h) => (h + 1) % n);
          else if (e.key === "ArrowUp") setHighlight((h) => (h - 1 + n) % n);
          else if (e.key === "Enter" || e.key === " ") {
            const o = items()[highlight()];
            if (o) pick(o.value);
          } else if (e.key === "Escape") setOpen(false);
          else return;
          e.preventDefault();
        }}
        class={[
          pxText.sm,
          pxRing,
          pxFocus,
          "flex h-9 w-full cursor-pointer items-center gap-2 bg-cream-100 px-3 text-left disabled:cursor-default disabled:opacity-50",
        ]}
      >
        <span class={["min-w-0 flex-1 truncate", current().value === "" ? "text-bark-500" : "text-bark-900"]}>{current().label}</span>
        <SpriteIcon name="button-next" size={12} class="rotate-90" />
      </button>
      <Show when={open()}>
        <PxWindow class="absolute top-full left-0 z-30 mt-1.5 min-w-full origin-top p-1 transition-[opacity,scale] duration-100 starting:scale-95 starting:opacity-0 motion-reduce:transition-none">
          <ul id={listId} role="listbox" aria-label={props.label} class="max-h-[50vh] overflow-y-auto">
            <For each={items()}>
              {(o, i) => (
                <li
                  id={`${listId}-${i()}`}
                  role="option"
                  data-key={o.value}
                  aria-selected={aria(o.value === props.value)}
                  onMouseEnter={() => setHighlight(i())}
                  // Down, not click: the trigger keeps the focus.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(o.value);
                  }}
                  class={["flex cursor-pointer items-baseline gap-3 px-2.5 py-1.5 whitespace-nowrap", { "bg-cream-200": i() === highlight() }]}
                >
                  <span class={[pxText.sm, "flex-1", o.value === "" ? "text-bark-500" : o.value === props.value ? "text-leaf-700" : "text-bark-800"]}>
                    {o.label}
                  </span>
                  <Show when={o.detail}>
                    <span class={[pxText.xs, "text-bark-500"]}>{o.detail}</span>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </PxWindow>
      </Show>
    </div>
  );
}

export function PxSwitchField(props: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
  tip?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={aria(props.checked)}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      class={[pxFocus, "inline-flex max-w-full cursor-pointer items-center gap-3 text-left text-bark-900 disabled:cursor-default disabled:opacity-50"]}
    >
      {/* The inner line is the padding: the 20 px thumb travels 16 px. */}
      <span
        class={[
          "flex h-6 w-10 shrink-0 border-2 border-cream-300 transition-colors duration-150 motion-reduce:transition-none",
          props.checked ? "bg-leaf-500" : "bg-cream-300/70",
        ]}
      >
        <span class={["size-5 bg-cream-50 transition-transform duration-150 motion-reduce:transition-none", pxDrop, { "translate-x-4": props.checked }]} />
      </span>
      <span class="flex min-w-0 flex-col">
        <PxTip tip={props.tip} class={pxText.sm}>
          {props.label}
        </PxTip>
        <Show when={props.hint}>
          <span class={[pxText.fine, "text-bark-500"]}>{props.hint}</span>
        </Show>
      </span>
    </button>
  );
}
