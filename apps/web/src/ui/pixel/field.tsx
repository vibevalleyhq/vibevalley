import { farmWording } from "../../farm/words";
import { createEffect, createMemo, createSignal, createUniqueId, For, onSettled, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { cx, pxRing, pxText } from "./style";
import { aria } from "../../base/util";
import { PxWindow } from "./base";
import { SpriteIcon } from "./icons";

/** `label` with a dotted underline that shows `tip` on hover; the bare label without one. */
export function PxTip(props: { tip?: string; children: JSX.Element; class?: string }) {
  return (
    <Show when={props.tip} fallback={<span class={props.class}>{props.children}</span>}>
      <span title={props.tip} class={cx("cursor-help underline decoration-bark-600 decoration-dotted decoration-2", props.class)}>
        {props.children}
      </span>
    </Show>
  );
}

/**
 * A labelled field with a hint or an error under it. `children` may take the id the label points at, for a control
 * that is not the field's only focusable thing.
 */
export function PxField(props: {
  label: string;
  children: JSX.Element | ((id: string) => JSX.Element);
  id?: string;
  hint?: JSX.Element;
  /** What the field is for, shown when the label is hovered instead of a line under the field. */
  tip?: string;
  error?: string;
  aside?: JSX.Element;
  required?: boolean;
  optional?: boolean;
}) {
  const own = createUniqueId();
  const target = () => props.id ?? own;
  const bound = () => typeof props.children === "function" || props.id !== undefined;
  const note = () => (props.error ? props.error : props.hint);
  return (
    <div class="flex flex-col">
      <div class="mb-1.5 flex items-baseline gap-2">
        <label for={bound() ? target() : undefined} class={[pxText.xs, "min-w-0 flex-1 text-bark-600"]}>
          <PxTip tip={props.tip}>{props.label}</PxTip>
          <Show when={props.required}>
            <span class="text-leaf-300"> *</span>
          </Show>
          <Show when={props.optional}>
            <span class="text-bark-500">{farmWording().optional}</span>
          </Show>
        </label>
        <Show when={props.aside != null}>
          <div class={[pxText.xs, "text-bark-500"]}>{props.aside}</div>
        </Show>
      </div>
      {typeof props.children === "function" ? props.children(target()) : props.children}
      <Show when={note() != null && note() !== ""}>
        <div class={[pxText.xs, "mt-1.5 leading-[1.625]", props.error ? "text-berry" : "text-bark-500"]} role={props.error ? "alert" : undefined}>
          {note()}
        </div>
      </Show>
    </div>
  );
}

const inputBox = "border-2 border-bark-500 bg-cream-input focus-within:border-leaf-500";

/** Controlled. `suggestions` are offered while typing, those containing what is typed; Enter picks the one the arrows reached. */
export function PxTextInput(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
  /** The accessible name where no PxField labels it. */
  label?: string;
  suggestions?: readonly string[];
  onSubmit?: (value: string) => void;
  autoFocus?: boolean;
  type?: string;
  inputMode?: "text" | "numeric" | "decimal" | "email" | "url" | "search" | "tel" | "none";
  /** Sunken in a cream well with the inner line, not framed: inside a card or a toolbar. */
  well?: boolean;
  icon?: string;
  id?: string;
  ref?: (el: HTMLInputElement) => void;
  class?: string;
}) {
  const listId = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const [highlight, setHighlight] = createSignal(-1);
  const suggestions = () => props.suggestions ?? [];
  const shown = createMemo(() => {
    const q = props.value.toLowerCase();
    return open() ? suggestions().filter((s) => s.toLowerCase().includes(q) && s !== props.value) : [];
  });
  const pick = (s: string) => {
    props.onChange(s);
    setOpen(false);
    setHighlight(-1);
  };
  const font = () => (props.mono ? pxText.mono : pxText.sm);
  let input: HTMLInputElement | undefined;
  onSettled(() => {
    if (props.autoFocus) input?.focus();
  });
  return (
    <div
      class={[
        "relative flex h-9 items-center gap-2 px-3 text-bark-900",
        props.well ? cx("bg-cream-100", pxRing) : inputBox,
        { "opacity-50": !!props.disabled },
        props.class,
      ]}
    >
      <Show when={props.icon}>{(icon) => <SpriteIcon name={icon()} size={14} />}</Show>
      <input
        ref={(el) => {
          input = el;
          props.ref?.(el);
        }}
        id={props.id}
        type={props.type ?? "text"}
        inputmode={props.inputMode}
        value={props.value}
        disabled={props.disabled}
        placeholder={props.placeholder}
        aria-label={props.label}
        role={suggestions().length > 0 ? "combobox" : undefined}
        aria-autocomplete={suggestions().length > 0 ? "list" : undefined}
        aria-expanded={suggestions().length > 0 ? aria(shown().length > 0) : undefined}
        aria-controls={shown().length > 0 ? listId : undefined}
        aria-activedescendant={shown().length > 0 && highlight() >= 0 ? `${listId}-${highlight()}` : undefined}
        onInput={(e) => {
          props.onChange(e.currentTarget.value);
          setOpen(true);
          setHighlight(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          const n = shown().length;
          if (n > 0 && e.key === "ArrowDown") setHighlight((h) => (h + 1) % n);
          else if (n > 0 && e.key === "ArrowUp") setHighlight((h) => (h <= 0 ? n - 1 : h - 1));
          else if (n > 0 && e.key === "Escape") setOpen(false);
          else if (e.key === "Enter" && !e.isComposing) {
            const s = highlight() >= 0 ? shown()[highlight()] : undefined;
            if (s !== undefined) pick(s);
            else props.onSubmit?.(props.value);
          } else return;
          e.preventDefault();
        }}
        class={[font(), "min-w-0 flex-1 bg-transparent text-bark-900 caret-bark-900 outline-none placeholder:text-bark-500"]}
      />
      <Show when={shown().length > 0}>
        <PxWindow class="absolute top-full left-[-2px] z-20 mt-1.5 max-h-60 max-w-80 min-w-40 overflow-y-auto p-1">
          <ul id={listId} role="listbox" aria-label={props.label}>
            <For each={shown()}>
              {(s, i) => (
                <li
                  id={`${listId}-${i()}`}
                  role="option"
                  aria-selected={aria(i() === highlight())}
                  // Down, not click: the input keeps the focus, so the list is still there when the click lands.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(s);
                  }}
                  onMouseEnter={() => setHighlight(i())}
                  class={[font(), "cursor-pointer px-2.5 py-1.5 text-bark-800", { "bg-cream-200": i() === highlight() }]}
                >
                  {s}
                </li>
              )}
            </For>
          </ul>
        </PxWindow>
      </Show>
    </div>
  );
}

/** Controlled, `rows` lines tall. */
export function PxTextArea(props: {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  mono?: boolean;
  /** A long text being written (an issue's description): in pxText.read, as it is read. */
  reading?: boolean;
  label?: string;
  autoFocus?: boolean;
  /** What is selected when `value` is replaced from outside (a blank to fill in), as [start, end]; the cursor goes to the end without it. */
  selection?: readonly [number, number];
  id?: string;
  ref?: (el: HTMLTextAreaElement) => void;
  class?: string;
}) {
  let area: HTMLTextAreaElement | undefined;
  let typed = untrack(() => props.value);
  createEffect(
    () => [props.value, props.selection] as const,
    ([value, selection]) => {
      if (!area || value === typed) return;
      typed = value;
      const [start, end] = selection ?? [value.length, value.length];
      area.setSelectionRange(start, end);
    },
  );
  onSettled(() => {
    if (props.autoFocus) area?.focus();
  });
  return (
    <div class={["flex px-3 py-2", inputBox, { "opacity-50": !!props.disabled }, props.class]}>
      <textarea
        ref={(t) => {
          area = t;
          props.ref?.(t);
        }}
        id={props.id}
        rows={props.rows ?? 6}
        value={props.value}
        disabled={props.disabled}
        readonly={props.readOnly}
        placeholder={props.placeholder}
        aria-label={props.label}
        onInput={(e) => {
          typed = e.currentTarget.value;
          props.onChange(e.currentTarget.value);
        }}
        class={[
          props.reading ? pxText.read : cx(props.mono ? pxText.mono : pxText.sm, "leading-[1.625]"),
          "min-w-0 flex-1 resize-none bg-transparent text-bark-900 caret-bark-900 outline-none placeholder:text-bark-500",
        ]}
      />
    </div>
  );
}
