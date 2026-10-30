// Select (Base UI's): one value picked from a list under a button. The trigger shows the chosen item's label (from
// `items`, or what Value's children make of the value). Opening puts the focus on the chosen option (else the first);
// the arrows, Home, End and letters move along the options, Enter or Space or a click picks one and closes the list.
// Escape, picking and Tab give the focus back to the trigger; a press outside leaves it where the press put it.

import { dynamic, type JSX } from "@solidjs/web";
import { createContext, createSignal, omit, Show, useContext } from "solid-js";
import { createDismiss } from "./internal/dismiss";
import { createFloating, type Floating, type FloatingRootProps, focusWhenPlaced, makePortal, makePositioner } from "./internal/floating";
import { createTypeahead, disabled, itemsIn, roveFocus } from "./internal/roving";
import { type ButtonProps, buttonType, call, type DivProps, flag, refs, type SpanProps, type Renderable } from "./internal/element";
import { createControllable } from "./internal/controllable";

export type SelectOpenChangeReason = "trigger" | "item" | "escape" | "outside" | "tab";

const option = "[role=option]";

interface Ctx extends Floating<SelectOpenChangeReason> {
  readonly value: () => string | undefined;
  readonly select: (value: string) => void;
  readonly labelOf: (value: string) => string | undefined;
  readonly disabled: () => boolean;
  /** Where the focus goes once the list is placed: the chosen option, or the last on ArrowUp. */
  readonly start: () => "chosen" | "last";
  readonly setStart: (start: "chosen" | "last") => void;
}

const Context = createContext<Ctx>();
const use = () => useContext(Context);

export interface SelectRootProps extends FloatingRootProps<SelectOpenChangeReason> {
  value?: string | undefined;
  defaultValue?: string | undefined;
  onValueChange?: ((value: string) => void) | undefined;
  /** The options' labels, for Value to show before the list has ever opened. */
  items?: Readonly<Record<string, string>> | readonly { readonly value: string; readonly label: string }[] | undefined;
  disabled?: boolean | undefined;
  /** Sent with a form under this name. */
  name?: string | undefined;
}

function Root(props: SelectRootProps) {
  const f = createFloating<SelectOpenChangeReason>(props, "trigger");
  const [value, setValue] = createControllable<string | undefined>({
    value: () => props.value,
    initial: props.defaultValue,
    onChange: (v) => v !== undefined && props.onValueChange?.(v),
  });
  const [start, setStart] = createSignal<"chosen" | "last">("chosen");
  const ctx: Ctx = {
    ...f,
    setOpen: (open, why) => {
      if (open && props.disabled === true) return;
      f.setOpen(open, why);
      if (!open && why !== "outside") f.trigger()?.focus();
    },
    value,
    select: setValue,
    labelOf: (v) => {
      const items = props.items;
      if (!items) return undefined;
      if (Array.isArray(items)) return (items as readonly { value: string; label: string }[]).find((i) => i.value === v)?.label;
      return (items as Readonly<Record<string, string>>)[v];
    },
    disabled: () => props.disabled ?? false,
    start,
    setStart,
  };
  createDismiss({ open: f.open, elements: () => [f.trigger(), f.positioner()], dismiss: (why) => ctx.setOpen(false, why) });
  return (
    <Context value={ctx}>
      {props.children}
      <Show when={props.name}>{(name) => <input type="hidden" name={name()} value={value() ?? ""} />}</Show>
    </Context>
  );
}

function Trigger(props: ButtonProps & Renderable) {
  const c = use();
  const rest = omit(props, "render", "onClick", "onKeyDown", "ref");
  const El = dynamic(() => props.render ?? "button");
  return (
    <El
      type={buttonType(props.render)}
      {...rest}
      ref={refs(props.ref, c.setTrigger)}
      id={c.triggerId}
      role="combobox"
      disabled={c.disabled()}
      aria-haspopup="listbox"
      aria-expanded={c.open() ? "true" : "false"}
      aria-controls={c.open() ? c.popupId : undefined}
      data-popup-open={flag(c.open())}
      data-disabled={flag(c.disabled())}
      onKeyDown={(e: KeyboardEvent) => {
        call(props.onKeyDown, e);
        if (e.defaultPrevented || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
        e.preventDefault();
        c.setStart(e.key === "ArrowUp" ? "last" : "chosen");
        c.setOpen(true, "trigger");
      }}
      onClick={(e: MouseEvent) => {
        call(props.onClick, e);
        if (e.defaultPrevented) return;
        c.setStart("chosen");
        c.setOpen(!c.open(), "trigger");
      }}
    />
  );
}

export interface SelectValueProps extends Omit<SpanProps, "children"> {
  /** Shown while nothing is chosen. */
  placeholder?: JSX.Element;
  /** What to show for the value; the item's label from `items`, else the value itself, by default. */
  children?: ((value: string) => JSX.Element) | undefined;
}

function Value(props: SelectValueProps) {
  const c = use();
  const rest = omit(props, "placeholder", "children");
  return (
    <span {...rest} data-placeholder={flag(c.value() === undefined)}>
      <Show when={c.value()} fallback={props.placeholder}>
        {(v) => <>{props.children ? props.children(v()) : (c.labelOf(v()) ?? v())}</>}
      </Show>
    </span>
  );
}

function Popup(props: DivProps) {
  const c = use();
  const rest = omit(props, "ref", "onKeyDown");
  const [el, setEl] = createSignal<HTMLElement>();
  const typeahead = createTypeahead();
  focusWhenPlaced(c, el, (list) => {
    const options = itemsIn(list, option).filter((o) => !disabled(o));
    if (c.start() === "last") return options.at(-1) ?? list;
    return options.find((o) => o.dataset.value === c.value()) ?? options[0] ?? list;
  });
  return (
    <div
      role="listbox"
      tabindex={-1}
      {...rest}
      ref={refs(props.ref, setEl)}
      id={c.popupId}
      aria-labelledby={c.triggerId}
      data-open={flag(c.open())}
      data-closed={flag(!c.open())}
      onKeyDown={(e) => {
        call(props.onKeyDown, e);
        const list = el();
        if (!list || e.defaultPrevented) return;
        if (e.key === "Tab") return c.setOpen(false, "tab");
        if (roveFocus(e, list, option, { orientation: "vertical", loop: false })) return;
        typeahead(e, list, option);
      }}
    />
  );
}

export interface SelectItemProps extends DivProps {
  value: string;
  disabled?: boolean | undefined;
  /** What typing matches, when its text is not it. */
  label?: string | undefined;
}

const ItemContext = createContext<() => boolean>(() => false);

function Item(props: SelectItemProps) {
  const c = use();
  const rest = omit(props, "value", "disabled", "label", "onClick", "onKeyDown", "onPointerMove", "onFocus", "onBlur", "children");
  const [highlighted, setHighlighted] = createSignal(false);
  const selected = () => c.value() === props.value;
  return (
    <div
      role="option"
      tabindex={-1}
      {...rest}
      aria-selected={selected() ? "true" : "false"}
      aria-disabled={props.disabled === true ? "true" : undefined}
      data-value={props.value}
      data-label={props.label}
      data-selected={flag(selected())}
      data-highlighted={flag(highlighted())}
      data-disabled={flag(props.disabled)}
      onFocus={(e) => {
        call(props.onFocus, e);
        setHighlighted(true);
      }}
      onBlur={(e) => {
        call(props.onBlur, e);
        setHighlighted(false);
      }}
      onPointerMove={(e) => {
        call(props.onPointerMove, e);
        if (props.disabled !== true && document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true });
      }}
      onKeyDown={(e) => {
        call(props.onKeyDown, e);
        if (e.defaultPrevented || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        e.currentTarget.click();
      }}
      onClick={(e) => {
        if (props.disabled === true) return;
        call(props.onClick, e);
        if (e.defaultPrevented) return;
        c.select(props.value);
        c.setOpen(false, "item");
      }}
    >
      <ItemContext value={selected}>{props.children}</ItemContext>
    </div>
  );
}

/** Shown only on the chosen option: a check mark, say. */
function ItemIndicator(props: SpanProps) {
  const selected = useContext(ItemContext);
  return (
    <Show when={selected()}>
      <span aria-hidden="true" {...props} />
    </Show>
  );
}

export const Select = {
  Root,
  Trigger,
  Value,
  Portal: makePortal(use),
  Positioner: makePositioner(use, { side: "bottom", align: "start" }),
  Popup,
  Item,
  ItemIndicator,
};
