import { type HTMLInputTypeAttribute, type ReactNode, type Ref, useId, useLayoutEffect, useRef, useState } from "react";
import { cx, pxRing, pxText, PxWindow } from "./base";
import { SpriteIcon } from "./icons";

/** `label` with a dotted underline that shows `tip` on hover; the bare label without one. */
export function PxTip({ tip, children, className }: { tip?: string; children: ReactNode; className?: string }) {
  if (!tip) return <span className={className}>{children}</span>;
  return (
    <span title={tip} className={cx("cursor-help underline decoration-bark-600 decoration-dotted decoration-2", className)}>
      {children}
    </span>
  );
}

/**
 * A labelled field with a hint or an error under it. `children` may take the id the label points at, for a control
 * that is not the field's only focusable thing.
 */
export function PxField({
  label,
  children,
  id,
  hint,
  tip,
  error,
  aside,
  required = false,
  optional = false,
}: {
  label: string;
  children: ReactNode | ((id: string) => ReactNode);
  id?: string;
  hint?: ReactNode;
  /** What the field is for, shown when the label is hovered instead of a line under the field. */
  tip?: string;
  error?: string;
  aside?: ReactNode;
  required?: boolean;
  optional?: boolean;
}) {
  const own = useId();
  const target = id ?? own;
  const bound = typeof children === "function" || id !== undefined;
  const note = error ? error : hint;
  return (
    <div className="flex flex-col">
      <div className="mb-1.5 flex items-baseline gap-2">
        <label htmlFor={bound ? target : undefined} className={cx(pxText.xs, "min-w-0 flex-1 text-bark-600")}>
          <PxTip tip={tip}>{label}</PxTip>
          {required && <span className="text-leaf-300"> *</span>}
          {optional && <span className="text-bark-500">{"  可选"}</span>}
        </label>
        {aside != null && <div className={cx(pxText.xs, "text-bark-500")}>{aside}</div>}
      </div>
      {typeof children === "function" ? children(target) : children}
      {note != null && note !== "" && (
        <div className={cx(pxText.xs, "mt-1.5 leading-[1.625]", error ? "text-berry" : "text-bark-500")} role={error ? "alert" : undefined}>
          {note}
        </div>
      )}
    </div>
  );
}

const inputBox = "border-2 border-bark-500 bg-cream-input focus-within:border-leaf-500";

/** Controlled. `suggestions` are offered while typing, those containing what is typed; Enter picks the one the arrows reached. */
export function PxTextInput({
  value,
  onChange,
  placeholder,
  mono = false,
  disabled = false,
  label,
  suggestions = [],
  onSubmit,
  autoFocus,
  type = "text",
  inputMode,
  well = false,
  icon,
  id,
  ref,
  className,
}: {
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
  type?: HTMLInputTypeAttribute;
  inputMode?: "text" | "numeric" | "decimal" | "email" | "url" | "search" | "tel" | "none";
  /** Sunken in a cream well with the inner line, not framed: inside a card or a toolbar. */
  well?: boolean;
  icon?: string;
  id?: string;
  ref?: Ref<HTMLInputElement>;
  className?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const q = value.toLowerCase();
  const shown = open ? suggestions.filter((s) => s.toLowerCase().includes(q) && s !== value) : [];
  const pick = (s: string) => {
    onChange(s);
    setOpen(false);
    setHighlight(-1);
  };
  const font = mono ? pxText.mono : pxText.sm;
  return (
    <div
      className={cx(
        "relative flex h-9 items-center gap-2 px-3 text-bark-900",
        well ? cx("bg-cream-100", pxRing) : inputBox,
        disabled && "opacity-50",
        className,
      )}
    >
      {icon && <SpriteIcon name={icon} size={14} />}
      <input
        ref={ref}
        id={id}
        type={type}
        inputMode={inputMode}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={label}
        role={suggestions.length > 0 ? "combobox" : undefined}
        aria-autocomplete={suggestions.length > 0 ? "list" : undefined}
        aria-expanded={suggestions.length > 0 ? shown.length > 0 : undefined}
        aria-controls={shown.length > 0 ? listId : undefined}
        aria-activedescendant={shown.length > 0 && highlight >= 0 ? `${listId}-${highlight}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHighlight(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          const n = shown.length;
          if (n > 0 && e.key === "ArrowDown") setHighlight((h) => (h + 1) % n);
          else if (n > 0 && e.key === "ArrowUp") setHighlight((h) => (h <= 0 ? n - 1 : h - 1));
          else if (n > 0 && e.key === "Escape") setOpen(false);
          else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            const s = highlight >= 0 ? shown[highlight] : undefined;
            if (s !== undefined) pick(s);
            else onSubmit?.(value);
          } else return;
          e.preventDefault();
        }}
        className={cx(font, "min-w-0 flex-1 bg-transparent text-bark-900 caret-bark-900 outline-none placeholder:text-bark-500")}
      />
      {shown.length > 0 && (
        <PxWindow className="absolute top-full left-[-2px] z-20 mt-1.5 max-h-60 max-w-80 min-w-40 overflow-y-auto p-1">
          <ul id={listId} role="listbox" aria-label={label}>
            {shown.map((s, i) => (
              <li
                key={s}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === highlight}
                // Down, not click: the input keeps the focus, so the list is still there when the click lands.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={cx(font, "cursor-pointer px-2.5 py-1.5 text-bark-800", i === highlight && "bg-cream-200")}
              >
                {s}
              </li>
            ))}
          </ul>
        </PxWindow>
      )}
    </div>
  );
}

/** Controlled, `rows` lines tall. */
export function PxTextArea({
  value,
  onChange,
  rows = 6,
  placeholder,
  disabled = false,
  readOnly = false,
  mono = false,
  reading = false,
  label,
  autoFocus,
  selection,
  id,
  ref,
  className,
}: {
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
  ref?: Ref<HTMLTextAreaElement>;
  className?: string;
}) {
  const own = useRef<HTMLTextAreaElement>(null);
  const typed = useRef(value);
  useLayoutEffect(() => {
    const t = own.current;
    if (!t || value === typed.current) return;
    typed.current = value;
    const [start, end] = selection ?? [value.length, value.length];
    t.setSelectionRange(start, end);
  }, [value, selection]);
  return (
    <div className={cx("flex px-3 py-2", inputBox, disabled && "opacity-50", className)}>
      <textarea
        ref={(t) => {
          own.current = t;
          if (typeof ref === "function") ref(t);
          else if (ref) ref.current = t;
        }}
        id={id}
        rows={rows}
        value={value}
        disabled={disabled}
        readOnly={readOnly}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => {
          typed.current = e.target.value;
          onChange(e.target.value);
        }}
        className={cx(
          reading ? pxText.read : cx(mono ? pxText.mono : pxText.sm, "leading-[1.625]"),
          "min-w-0 flex-1 resize-none bg-transparent text-bark-900 caret-bark-900 outline-none placeholder:text-bark-500",
        )}
      />
    </div>
  );
}
