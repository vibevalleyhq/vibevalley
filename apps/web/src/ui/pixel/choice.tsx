import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, createUniqueId, For, Show } from "solid-js";

import { aria } from "#/base/dom.tsx";

import { PxWindow } from "./base";
import { type PickOption, pickItems } from "./cells";
import { PxTip } from "./field";
import { SpriteIcon } from "./icons";
import { pxFocus, pxRing, pxText } from "./style";

const recipeStyles2 = stylex.create({
  pxSwitchFieldSpan: {
    display: "flex",
    height: "calc(var(--spacing) * 6)",
    width: "calc(var(--spacing) * 10)",
    flexShrink: "0",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-cream-300)",
    transitionProperty: {
      default: "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke",
      "@media (prefers-reduced-motion:reduce)": "none",
    },
    transitionTimingFunction: "var(--default-transition-timing-function)",
    transitionDuration: ".15s",
  },
  pxSwitchFieldSpanVariant1Case1: {
    backgroundColor: {
      default: "var(--color-cream-300)b3",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-cream-300) 70%, transparent)",
    },
  },
  pxSwitchFieldSpanVariant1Case2: {
    backgroundColor: "var(--color-leaf-500)",
  },
});

const recipeStyles = stylex.create({
  pxPickButton: {
    display: "flex",
    height: "calc(var(--spacing) * 9)",
    width: "100%",
    cursor: {
      default: "pointer",
      ":disabled": "default",
    },
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    backgroundColor: "var(--color-cream-100)",
    paddingInline: "calc(var(--spacing) * 3)",
    textAlign: "left",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.4286",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    boxShadow: "0 0 transparent, 0 0 transparent, 0 0 transparent, 0 0 transparent, inset 0 0 0 2px var(--color-cream-300)",
    outlineStyle: {
      default: "none",
      ":focus-visible": "solid",
    },
    fontSynthesis: "none",
    outlineWidth: {
      default: null,
      ":focus-visible": "2px",
    },
    outlineOffset: {
      default: null,
      ":focus-visible": "1px",
    },
    outlineColor: {
      default: null,
      ":focus-visible": "var(--color-leaf-500)",
    },
    opacity: {
      default: null,
      ":disabled": ".5",
    },
  },
  pxPickSpan: {
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.3333",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    color: "var(--color-bark-600)",
    fontSynthesis: "none",
  },
  pxSwitchFieldButton: {
    display: "inline-flex",
    maxWidth: "100%",
    cursor: {
      default: "pointer",
      ":disabled": "default",
    },
    alignItems: "center",
    gap: "calc(var(--spacing) * 3)",
    textAlign: "left",
    color: "var(--color-bark-900)",
    outlineStyle: {
      default: "none",
      ":focus-visible": "solid",
    },
    outlineWidth: {
      default: null,
      ":focus-visible": "2px",
    },
    outlineOffset: {
      default: null,
      ":focus-visible": "1px",
    },
    outlineColor: {
      default: null,
      ":focus-visible": "var(--color-leaf-500)",
    },
    opacity: {
      default: null,
      ":disabled": ".5",
    },
  },
  pxSwitchFieldSpan: {
    width: "calc(var(--spacing) * 5)",
    height: "calc(var(--spacing) * 5)",
    backgroundColor: "var(--color-cream-50)",
    boxShadow: "0 0 transparent, 0 0 transparent, 0 0 transparent, 0 0 transparent, 2px 2px 0 0 var(--color-px-drop)",
    transitionProperty: {
      default: "transform,translate,scale,rotate",
      "@media (prefers-reduced-motion:reduce)": "none",
    },
    transitionTimingFunction: "var(--default-transition-timing-function)",
    transitionDuration: ".15s",
  },
  pxSwitchFieldSpanVariant1Case1: {
    translate: null,
  },
  pxSwitchFieldSpanVariant1Case2: {
    translate: "calc(var(--spacing) * 4) 0",
  },
  pxSwitchFieldSpan2: {
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.5",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    color: "var(--color-bark-500)",
    fontSynthesis: "none",
  },
});

const variantStyles = stylex.create({
  pxSegmentedDiv: {
    flexWrap: "wrap",
    gap: "var(--spacing)",
    backgroundColor: "var(--color-cream-200)",
    padding: "var(--spacing)",
  },
  pxSegmentedDivVariant: {
    display: "flex",
  },
  pxSegmentedDivVariant2: {
    display: "inline-flex",
  },
  pxPickSpan: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  pxPickSpanVariant: {
    color: "var(--color-bark-600)",
  },
  pxPickSpanVariant2: {
    color: "var(--color-bark-900)",
  },
  pxPickLi: {
    display: "flex",
    cursor: "pointer",
    alignItems: "baseline",
    gap: "calc(var(--spacing) * 3)",
    paddingInline: "calc(var(--spacing) * 2.5)",
    paddingBlock: "calc(var(--spacing) * 1.5)",
    whiteSpace: "nowrap",
  },
  pxPickLiVariant: {
    backgroundColor: "var(--color-cream-200)",
  },
  pxPickLiVariant2: {},
});

const viewStyles = stylex.create({
  pxPickDiv: {
    position: "relative",
    width: "100%",
  },
  pxPickUl: {
    maxHeight: "50vh",
    overflowY: "auto",
  },
  pxSwitchFieldSpan: {
    display: "flex",
    minWidth: "0",
    flexDirection: "column",
  },
});

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
    <div
      role="group"
      aria-label={props.label}
      {...stylex.attrs(variantStyles.pxSegmentedDiv, (props.block ?? true) ? variantStyles.pxSegmentedDivVariant : variantStyles.pxSegmentedDivVariant2)}
    >
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
    <div ref={(el) => (wrap = el)} {...stylex.attrs(viewStyles.pxPickDiv)}>
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
        {...stylex.attrs(recipeStyles.pxPickButton)}
      >
        <span {...stylex.attrs(variantStyles.pxPickSpan, current().value === "" ? variantStyles.pxPickSpanVariant : variantStyles.pxPickSpanVariant2)}>
          {current().label}
        </span>
        <SpriteIcon name="button-next" size={12} class="rotate-90" />
      </button>
      <Show when={open()}>
        <PxWindow class="absolute top-full left-0 z-30 mt-1.5 min-w-full origin-top p-1 transition-[opacity,scale] duration-100 motion-reduce:transition-none starting:scale-95 starting:opacity-0">
          <ul id={listId} role="listbox" aria-label={props.label} {...stylex.attrs(viewStyles.pxPickUl)}>
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
                  {...stylex.attrs(variantStyles.pxPickLi, i() === highlight() ? variantStyles.pxPickLiVariant : variantStyles.pxPickLiVariant2)}
                >
                  <span class={[pxText.sm, "flex-1", o.value === "" ? "text-bark-600" : o.value === props.value ? "text-leaf-700" : "text-bark-800"]}>
                    {o.label}
                  </span>
                  <Show when={o.detail}>
                    <span {...stylex.attrs(recipeStyles.pxPickSpan)}>{o.detail}</span>
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
      {...stylex.attrs(recipeStyles.pxSwitchFieldButton)}
    >
      {/* The inner line is the padding: the 20 px thumb travels 16 px. */}
      <span
        {...stylex.attrs(
          recipeStyles2.pxSwitchFieldSpan,
          props.checked ? recipeStyles2.pxSwitchFieldSpanVariant1Case2 : recipeStyles2.pxSwitchFieldSpanVariant1Case1,
        )}
      >
        <span
          {...stylex.attrs(
            recipeStyles.pxSwitchFieldSpan,
            props.checked ? recipeStyles.pxSwitchFieldSpanVariant1Case2 : recipeStyles.pxSwitchFieldSpanVariant1Case1,
          )}
        />
      </span>
      <span {...stylex.attrs(viewStyles.pxSwitchFieldSpan)}>
        <PxTip tip={props.tip} class={pxText.sm}>
          {props.label}
        </PxTip>
        <Show when={props.hint}>
          <span {...stylex.attrs(recipeStyles.pxSwitchFieldSpan2)}>{props.hint}</span>
        </Show>
      </span>
    </button>
  );
}
