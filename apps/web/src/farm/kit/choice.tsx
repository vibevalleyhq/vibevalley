import { useEffect, useId, useRef, useState } from "react";
import { cx, pxDrop, pxRing, pxText, PxWindow } from "./base";
import { PxTip } from "./field";
import { SpriteIcon } from "./icons";

const focusRing = "outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-leaf-500 focus-visible:outline-solid";

export interface SegmentOption<T> {
  value: T;
  label: string;
  disabled?: boolean;
  /** The tooltip. */
  title?: string;
}

/** As wide as it is given; `block={false}` where it sits as a flex item beside others, as wide as its buttons. */
export function PxSegmented<T extends string | number | boolean>({
  value,
  options,
  onChange,
  block = true,
  label,
}: {
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (value: T) => void;
  block?: boolean;
  label?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cx(block ? "flex" : "inline-flex", "flex-wrap gap-1 bg-cream-200 p-1")}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            title={o.title}
            aria-pressed={on}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cx(
              pxText.xs,
              pxRing,
              focusRing,
              "h-7 cursor-pointer px-3 whitespace-nowrap enabled:active:translate-x-px enabled:active:translate-y-px disabled:cursor-default disabled:opacity-35",
              on ? "bg-leaf-500 text-cream-50" : "text-bark-800 enabled:hover:bg-cream-300",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export interface PickOption {
  value: string;
  label: string;
  detail?: string;
}

/**
 * What a pick lists: with `clearable`, no value is a choice of its own, listed first as the placeholder ("所有项目",
 * "按规则挑"). Without it the list is only the options: a pick that always has a value must not offer a second entry
 * that means the same as one of them. '' is the placeholder's own value, so an option for it is dropped.
 */
export function pickItems(options: readonly PickOption[], placeholder: string, clearable: boolean): PickOption[] {
  return [...(clearable ? [{ value: "", label: placeholder }] : []), ...options.filter((o) => o.value !== "")];
}

/** A dropdown as wide as it is given, so it needs a bounded width. */
export function PxPick({
  value,
  options,
  onChange,
  placeholder,
  disabled = false,
  label,
  clearable = false,
  id,
}: {
  value: string;
  options: readonly PickOption[];
  onChange: (value: string) => void;
  /** What the trigger says while nothing is chosen. */
  placeholder: string;
  disabled?: boolean;
  label?: string;
  clearable?: boolean;
  id?: string;
}) {
  const listId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const items = pickItems(options, placeholder, clearable);
  const current = items.find((o) => o.value === value) ?? { value: "", label: placeholder };
  const empty = current.value === "";

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const show = () => {
    const at = items.findIndex((o) => o.value === value);
    setHighlight(at < 0 ? 0 : at);
    setOpen(true);
  };
  const pick = (v: string) => {
    setOpen(false);
    if (v !== value) onChange(v);
  };

  return (
    <div ref={wrap} className="relative w-full">
      <button
        id={id}
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${highlight}` : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onBlur={(e) => !wrap.current?.contains(e.relatedTarget) && setOpen(false)}
        onKeyDown={(e) => {
          const n = items.length;
          if (!open) {
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
            const o = items[highlight];
            if (o) pick(o.value);
          } else if (e.key === "Escape") setOpen(false);
          else return;
          e.preventDefault();
        }}
        className={cx(
          pxText.sm,
          pxRing,
          focusRing,
          "flex h-9 w-full cursor-pointer items-center gap-2 bg-cream-100 px-3 text-left disabled:cursor-default disabled:opacity-50",
        )}
      >
        <span className={cx("min-w-0 flex-1 truncate", empty ? "text-bark-500" : "text-bark-900")}>{current.label}</span>
        <SpriteIcon name="button-next" size={12} className="rotate-90" />
      </button>
      {open && (
        <PxWindow className="absolute top-full left-0 z-30 mt-1.5 min-w-full origin-top p-1 transition-[opacity,scale] duration-100 starting:scale-95 starting:opacity-0 motion-reduce:transition-none">
          <ul id={listId} role="listbox" aria-label={label} className="max-h-[50vh] overflow-y-auto">
            {items.map((o, i) => (
              <li
                key={o.value}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={o.value === value}
                onMouseEnter={() => setHighlight(i)}
                // Down, not click: the trigger keeps the focus.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(o.value);
                }}
                className={cx("flex cursor-pointer items-baseline gap-3 px-2.5 py-1.5 whitespace-nowrap", i === highlight && "bg-cream-200")}
              >
                <span className={cx(pxText.sm, "flex-1", o.value === "" ? "text-bark-500" : o.value === value ? "text-leaf-700" : "text-bark-800")}>
                  {o.label}
                </span>
                {o.detail && <span className={cx(pxText.xs, "text-bark-500")}>{o.detail}</span>}
              </li>
            ))}
          </ul>
        </PxWindow>
      )}
    </div>
  );
}

export function PxSwitchField({
  label,
  checked,
  onChange,
  hint,
  tip,
  disabled = false,
}: {
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
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(focusRing, "inline-flex max-w-full cursor-pointer items-center gap-3 text-left text-bark-900 disabled:cursor-default disabled:opacity-50")}
    >
      {/* The inner line is the padding: the 20 px thumb travels 16 px. */}
      <span
        className={cx(
          "flex h-6 w-10 shrink-0 border-2 border-cream-300 transition-colors duration-150 motion-reduce:transition-none",
          checked ? "bg-leaf-500" : "bg-cream-300/70",
        )}
      >
        <span className={cx("size-5 bg-cream-50 transition-transform duration-150 motion-reduce:transition-none", pxDrop, checked && "translate-x-4")} />
      </span>
      <span className="flex min-w-0 flex-col">
        <PxTip tip={tip} className={pxText.sm}>
          {label}
        </PxTip>
        {hint && <span className={cx(pxText.fine, "text-bark-500")}>{hint}</span>}
      </span>
    </button>
  );
}
