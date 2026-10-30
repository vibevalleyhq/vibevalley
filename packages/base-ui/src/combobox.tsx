// Combobox (Base UI's; shadcn's Combobox and Command): an input with a list of options under it. The focus stays in the
// input: the arrow keys move a highlight along the options (aria-activedescendant), Enter picks the highlighted one,
// Escape and Tab close the list. Typing opens it and highlights the first option. Which options show for the text is
// the caller's: it renders the ones that match inputValue; Empty shows when none do.

import type { JSX } from "@solidjs/web";
import { createContext, createSignal, createUniqueId, omit, onSettled, Show, useContext } from "solid-js";
import { createDismiss } from "./internal/dismiss";
import { createFloating, type Floating, type FloatingRootProps, makePortal, makePositioner } from "./internal/floating";
import { itemsIn } from "./internal/roving";
import { call, type DivProps, flag, refs } from "./internal/element";
import { createControllable } from "./internal/controllable";

export type ComboboxOpenChangeReason = "input" | "item" | "escape" | "outside" | "tab";

const option = "[role=option]:not([data-disabled])";

interface Ctx extends Floating<ComboboxOpenChangeReason> {
  readonly value: () => string | undefined;
  readonly pick: (value: string, label: string) => void;
  readonly inputValue: () => string;
  readonly setInputValue: (text: string) => void;
  readonly highlighted: () => HTMLElement | undefined;
  readonly highlight: (el: HTMLElement | undefined) => void;
  readonly list: () => HTMLElement | undefined;
  readonly setList: (el: HTMLElement | undefined) => void;
  readonly count: () => number;
  readonly counted: () => () => void;
}

const Context = createContext<Ctx>();
const use = () => useContext(Context);

export interface ComboboxRootProps extends FloatingRootProps<ComboboxOpenChangeReason> {
  value?: string | undefined;
  defaultValue?: string | undefined;
  onValueChange?: ((value: string) => void) | undefined;
  inputValue?: string | undefined;
  defaultInputValue?: string | undefined;
  onInputValueChange?: ((text: string) => void) | undefined;
  /** The list is always shown in place, as in a command palette: no Portal, nothing closes it. */
  inline?: boolean | undefined;
  /** An option is always highlighted: the first, whenever the highlighted one goes away. */
  autoHighlight?: boolean | undefined;
}

function Root(props: ComboboxRootProps) {
  const f = createFloating<ComboboxOpenChangeReason>(
    {
      get open() {
        return props.inline === true ? true : props.open;
      },
      get defaultOpen() {
        return props.defaultOpen;
      },
      get onOpenChange() {
        return props.onOpenChange;
      },
    },
    "input",
  );
  const [value, setValue] = createControllable<string | undefined>({
    value: () => props.value,
    initial: props.defaultValue,
    onChange: (v) => v !== undefined && props.onValueChange?.(v),
  });
  const [inputValue, setInputValue] = createControllable({
    value: () => props.inputValue,
    initial: props.defaultInputValue ?? "",
    onChange: (v) => props.onInputValueChange?.(v),
  });
  const [highlighted, setHighlighted] = createSignal<HTMLElement>();
  const [list, setList] = createSignal<HTMLElement>();
  const [count, setCount] = createSignal(0);
  const ctx: Ctx = {
    ...f,
    setOpen: (open, why) => {
      f.setOpen(open, why);
      if (!open) setHighlighted(undefined);
    },
    value,
    pick: (v, label) => {
      setValue(v);
      setInputValue(label);
      ctx.setOpen(false, "item");
    },
    inputValue,
    setInputValue,
    highlighted,
    highlight: (el) => {
      setHighlighted(el);
      el?.scrollIntoView({ block: "nearest" });
    },
    list,
    setList,
    count,
    counted: () => {
      setCount((n) => n + 1);
      keepHighlight();
      return () => {
        setCount((n) => n - 1);
        keepHighlight();
      };
    },
  };
  // After the options have changed: the first, if the highlighted one is gone.
  const keepHighlight = () => {
    if (props.autoHighlight !== true) return;
    queueMicrotask(() => {
      const h = highlighted();
      const l = list();
      if (h?.isConnected === true && l?.contains(h) === true) return;
      ctx.highlight(l ? itemsIn(l, option)[0] : undefined);
    });
  };
  createDismiss({ open: () => props.inline !== true && f.open(), elements: () => [f.trigger(), f.positioner()], dismiss: (why) => ctx.setOpen(false, why) });
  return <Context value={ctx}>{props.children}</Context>;
}

function Input(props: JSX.InputHTMLAttributes<HTMLInputElement>) {
  const c = use();
  const rest = omit(props, "ref", "onInput", "onKeyDown", "value");
  const options = () => {
    const l = c.list();
    return l ? itemsIn(l, option) : [];
  };
  const step = (by: 1 | -1) => {
    const all = options();
    if (all.length === 0) return;
    const at = all.indexOf(c.highlighted()!);
    c.highlight(all[at < 0 ? (by === 1 ? 0 : all.length - 1) : Math.min(all.length - 1, Math.max(0, at + by))]);
  };
  return (
    <input
      type="text"
      autocomplete="off"
      {...rest}
      ref={refs(props.ref, c.setTrigger)}
      role="combobox"
      value={c.inputValue()}
      aria-autocomplete="list"
      aria-expanded={c.open() ? "true" : "false"}
      aria-controls={c.open() ? c.popupId : undefined}
      aria-activedescendant={c.open() ? c.highlighted()?.id : undefined}
      data-popup-open={flag(c.open())}
      onInput={(e) => {
        call(props.onInput, e);
        c.setInputValue(e.currentTarget.value);
        if (!c.open()) c.setOpen(true, "input");
        // After the caller has rendered the options for the new text.
        queueMicrotask(() => c.highlight(options()[0]));
      }}
      onKeyDown={(e) => {
        call(props.onKeyDown, e);
        if (e.defaultPrevented || e.isComposing) return;
        switch (e.key) {
          case "ArrowDown":
          case "ArrowUp": {
            e.preventDefault();
            const by = e.key === "ArrowDown" ? 1 : -1;
            if (c.open()) return step(by);
            c.setOpen(true, "input");
            queueMicrotask(() => step(by));
            return;
          }
          case "Enter": {
            const h = c.highlighted();
            if (!c.open() || !h) return;
            e.preventDefault();
            h.click();
            return;
          }
          case "Tab":
            if (c.open()) c.setOpen(false, "tab");
            return;
          default:
            return;
        }
      }}
    />
  );
}

function Popup(props: DivProps) {
  const c = use();
  const rest = omit(props, "ref", "onPointerDown");
  return (
    <div
      role="listbox"
      {...rest}
      ref={refs(props.ref, c.setList)}
      id={c.popupId}
      data-open={flag(c.open())}
      data-closed={flag(!c.open())}
      data-empty={flag(c.count() === 0)}
      onPointerDown={(e) => {
        call(props.onPointerDown, e);
        // A press on the list keeps the focus in the input.
        e.preventDefault();
      }}
    />
  );
}

export interface ComboboxItemProps extends DivProps {
  value: string;
  disabled?: boolean | undefined;
  /** What the input shows once it is picked; its text by default. */
  label?: string | undefined;
}

function Item(props: ComboboxItemProps) {
  const c = use();
  const rest = omit(props, "value", "disabled", "label", "onClick", "onPointerMove", "ref");
  const id = createUniqueId();
  const [el, setEl] = createSignal<HTMLElement>();
  onSettled(c.counted);
  const highlighted = () => el() !== undefined && c.highlighted() === el();
  const selected = () => c.value() === props.value;
  return (
    <div
      role="option"
      {...rest}
      ref={refs(props.ref, setEl)}
      id={id}
      aria-selected={selected() ? "true" : "false"}
      aria-disabled={props.disabled === true ? "true" : undefined}
      data-value={props.value}
      data-selected={flag(selected())}
      data-highlighted={flag(highlighted())}
      data-disabled={flag(props.disabled)}
      onPointerMove={(e) => {
        call(props.onPointerMove, e);
        if (props.disabled !== true && !highlighted()) c.highlight(e.currentTarget);
      }}
      onClick={(e) => {
        if (props.disabled === true) return;
        call(props.onClick, e);
        if (!e.defaultPrevented) c.pick(props.value, props.label ?? e.currentTarget.textContent);
      }}
    />
  );
}

/** Shown in the list while no option is. */
function Empty(props: DivProps) {
  const c = use();
  return (
    <Show when={c.count() === 0}>
      <div role="status" {...props} />
    </Show>
  );
}

export const Combobox = {
  Root,
  Input,
  Portal: makePortal(use),
  Positioner: makePositioner(use, { side: "bottom", align: "start" }),
  Popup,
  Item,
  Empty,
};
