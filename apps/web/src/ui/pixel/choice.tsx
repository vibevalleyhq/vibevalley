import { createEffect, createSignal, createUniqueId, For, Show } from "solid-js";

import { aria } from "#/base/dom.tsx";

import { PxWindow } from "./base";
import { type PickOption, pickItems } from "./cells";
import { PxTip } from "./field";
import { SpriteIcon } from "./icons";

interface SegmentOption<T> {
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
    <div role="group" aria-label={props.label} class={["flex-wrap gap-1 bg-cream-200 p-1", (props.block ?? true) ? "flex" : "inline-flex"]}>
      <For each={props.options}>
        {(o) => (
          <button
            type="button"
            title={o.title}
            aria-pressed={aria(o.value === props.value)}
            disabled={o.disabled}
            onClick={() => props.onChange(o.value)}
            class={[
              "h-7 cursor-pointer px-3 whitespace-nowrap pixel-ring pixel-xs pixel-focus enabled:active:translate-px disabled:cursor-default disabled:opacity-35",
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
      if (!(e.target instanceof Node && wrap.contains(e.target))) setOpen(false);
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
        onBlur={(e) => !wrap.contains(e.relatedTarget instanceof Node ? e.relatedTarget : null) && setOpen(false)}
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
        class="flex h-9 w-full cursor-pointer items-center gap-2 bg-cream-100 px-3 text-left pixel-sm pixel-ring pixel-focus disabled:cursor-default disabled:opacity-50"
      >
        <span class={["min-w-0 flex-1 truncate", current().value === "" ? "text-bark-600" : "text-bark-900"]}>{current().label}</span>
        <SpriteIcon name="button-next" size={12} class="rotate-90" />
      </button>
      <Show when={open()}>
        <PxWindow class="absolute top-full left-0 z-30 mt-1.5 min-w-full origin-top p-1 transition-[opacity,scale] duration-100 ease-out starting:scale-95 starting:opacity-0 motion-reduce:transition-none">
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
                  class={["flex cursor-pointer items-baseline gap-3 px-2.5 py-1.5 whitespace-nowrap", i() === highlight() && "bg-cream-200"]}
                >
                  <span class={["flex-1 pixel-sm", o.value === "" ? "text-bark-600" : o.value === props.value ? "text-leaf-700" : "text-bark-800"]}>
                    {o.label}
                  </span>
                  <Show when={o.detail}>
                    <span class="text-bark-600 pixel-xs">{o.detail}</span>
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
      class="inline-flex max-w-full cursor-pointer items-center gap-3 text-left text-bark-900 pixel-focus disabled:cursor-default disabled:opacity-50"
    >
      {/* The inner line is the padding: the 20 px thumb travels 16 px. */}
      <span
        class={[
          "flex h-6 w-10 shrink-0 border-2 border-cream-300 transition-[color,background-color,border-color] duration-150 ease-out motion-reduce:transition-none",
          props.checked ? "bg-leaf-500" : "bg-cream-300/70",
        ]}
      >
        <span
          class={["size-5 bg-cream-50 pixel-drop transition-[translate] duration-150 ease-out motion-reduce:transition-none", props.checked && "translate-x-4"]}
        />
      </span>
      <span class="flex min-w-0 flex-col">
        <PxTip tip={props.tip} class="pixel-sm">
          {props.label}
        </PxTip>
        <Show when={props.hint}>
          <span class="text-bark-500 pixel-fine">{props.hint}</span>
        </Show>
      </span>
    </button>
  );
}
