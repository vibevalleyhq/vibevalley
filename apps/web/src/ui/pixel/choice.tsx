import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, createUniqueId, For, Show } from "solid-js";

import { aria } from "#/base/dom.tsx";

import { PxWindow } from "./base";
import { type PickOption, pickItems } from "./cells";
import { PxTip } from "./field";
import { SpriteIcon } from "./icons";
import { pxStyle } from "./style";

const styles = stylex.create({
  pickChevron: { rotate: "90deg" },
  pxSegmentedButton: {
    height: "calc(var(--spacing) * 7)",
    cursor: {
      default: "pointer",
      ":disabled": "default",
    },
    paddingInline: "calc(var(--spacing) * 3)",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.3333",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    whiteSpace: "nowrap",
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
    translate: {
      default: null,
      ":enabled:active": "1px 1px",
    },
    opacity: {
      default: null,
      ":disabled": ".35",
    },
  },
  pxSegmentedButtonPrimary: {
    color: "var(--color-bark-800)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":enabled:hover": "var(--color-cream-300)",
      },
    },
  },
  pxSegmentedButtonSecondary: {
    color: "var(--color-bark-900)",
    backgroundColor: "var(--color-leaf-500)",
  },
  pxPickSpan: {
    flex: "1",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.4286",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    fontSynthesis: "none",
  },
  pxPickSpanState: {
    color: "var(--color-bark-800)",
  },
  pxPickSpanState2: {
    color: "var(--color-leaf-700)",
  },
  pxPickSpanState3: {
    color: "var(--color-bark-600)",
  },
  pxPickPxWindow: {
    position: "absolute",
    top: "100%",
    left: "0",
    zIndex: 30,
    marginTop: "calc(var(--spacing) * 1.5)",
    minWidth: "100%",
    transformOrigin: "top",
    padding: "var(--spacing)",
    transitionProperty: {
      default: "opacity,scale",
      "@media (prefers-reduced-motion:reduce)": "none",
    },
    transitionTimingFunction: "var(--default-transition-timing-function)",
    transitionDuration: ".1s",
    scale: {
      default: null,
      "@starting-style": "95% 95%",
    },
    opacity: {
      default: null,
      "@starting-style": "0",
    },
  },
  pxSegmented: {
    flexWrap: "wrap",
    gap: "var(--spacing)",
    backgroundColor: "var(--color-cream-200)",
    padding: "var(--spacing)",
  },
  pxSegmentedBlock: {
    display: "flex",
  },
  pxSegmentedInline: {
    display: "inline-flex",
  },
  pxPickDiv: {
    position: "relative",
    width: "100%",
  },
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
    opacity: {
      default: null,
      ":disabled": ".5",
    },
  },
  pxPickValue: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  pxPickPlaceholder: {
    color: "var(--color-bark-600)",
  },
  pxPickSelected: {
    color: "var(--color-bark-900)",
  },
  pxPickUl: {
    maxHeight: "50vh",
    overflowY: "auto",
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
  pxPickLiActive: {
    backgroundColor: "var(--color-cream-200)",
  },
  pxPickDetail: {
    color: "var(--color-bark-600)",
  },
  pxSwitchButton: {
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
    opacity: {
      default: null,
      ":disabled": ".5",
    },
  },
  pxSwitchTrack: {
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
  pxSwitchTrackOff: {
    backgroundColor: {
      default: "var(--color-px-choice-well)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-cream-300) 70%, transparent)",
    },
  },
  pxSwitchTrackOn: {
    backgroundColor: "var(--color-leaf-500)",
  },
  pxSwitchThumb: {
    width: "calc(var(--spacing) * 5)",
    height: "calc(var(--spacing) * 5)",
    backgroundColor: "var(--color-cream-50)",
    transitionProperty: {
      default: "transform,translate,scale,rotate",
      "@media (prefers-reduced-motion:reduce)": "none",
    },
    transitionTimingFunction: "var(--default-transition-timing-function)",
    transitionDuration: ".15s",
  },
  pxSwitchThumbOn: {
    translate: "calc(var(--spacing) * 4) 0",
  },
  pxSwitchText: {
    display: "flex",
    minWidth: "0",
    flexDirection: "column",
  },
  pxSwitchHint: {
    color: "var(--color-bark-500)",
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
      {...stylex.attrs(styles.pxSegmented, (props.block ?? true) ? styles.pxSegmentedBlock : styles.pxSegmentedInline)}
    >
      <For each={props.options}>
        {(o) => (
          <button
            type="button"
            title={o.title}
            aria-pressed={aria(o.value === props.value)}
            disabled={o.disabled}
            onClick={() => props.onChange(o.value)}
            {...stylex.attrs(
              styles.pxSegmentedButton,
              o.value === props.value ? styles.pxSegmentedButtonSecondary : styles.pxSegmentedButtonPrimary,
            )}
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
    <div ref={(el) => (wrap = el)} {...stylex.attrs(styles.pxPickDiv)}>
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
        {...stylex.attrs(pxStyle.sm, pxStyle.ring, pxStyle.focus, styles.pxPickButton)}
      >
        <span {...stylex.attrs(styles.pxPickValue, current().value === "" ? styles.pxPickPlaceholder : styles.pxPickSelected)}>
          {current().label}
        </span>
        <SpriteIcon name="button-next" size={12} styles={styles.pickChevron} />
      </button>
      <Show when={open()}>
        <PxWindow styles={[styles.pxPickPxWindow]}>
          <ul id={listId} role="listbox" aria-label={props.label} {...stylex.attrs(styles.pxPickUl)}>
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
                  {...stylex.attrs(styles.pxPickLi, i() === highlight() && styles.pxPickLiActive)}
                >
                  <span
                    {...stylex.attrs(
                      styles.pxPickSpan,
                      o.value === ""
                        ? styles.pxPickSpanState3
                        : o.value === props.value
                          ? styles.pxPickSpanState2
                          : styles.pxPickSpanState,
                    )}
                  >
                    {o.label}
                  </span>
                  <Show when={o.detail}>
                    <span {...stylex.attrs(pxStyle.xs, styles.pxPickDetail)}>{o.detail}</span>
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
      {...stylex.attrs(pxStyle.focus, styles.pxSwitchButton)}
    >
      {/* The inner line is the padding: the 20 px thumb travels 16 px. */}
      <span {...stylex.attrs(styles.pxSwitchTrack, props.checked ? styles.pxSwitchTrackOn : styles.pxSwitchTrackOff)}>
        <span {...stylex.attrs(pxStyle.drop, styles.pxSwitchThumb, props.checked && styles.pxSwitchThumbOn)} />
      </span>
      <span {...stylex.attrs(styles.pxSwitchText)}>
        <PxTip tip={props.tip} styles={pxStyle.sm}>
          {props.label}
        </PxTip>
        <Show when={props.hint}>
          <span {...stylex.attrs(pxStyle.fine, styles.pxSwitchHint)}>{props.hint}</span>
        </Show>
      </span>
    </button>
  );
}
