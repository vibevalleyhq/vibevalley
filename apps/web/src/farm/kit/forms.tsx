import { useState } from "react";
import { cx, pxRing, pxText } from "./base";
import { splitChips } from "./chips";
import { SpriteIcon } from "./icons";

const focusRing = "outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-leaf-500 focus-visible:outline-solid";

/** Enter or a comma adds what is typed, and so does leaving the box; Backspace in an empty box takes the last chip off. */
export function PxChipsInput({
  value,
  onChange,
  placeholder,
  disabled = false,
  label,
  id,
}: {
  value: readonly string[];
  onChange: (value: string[]) => void;
  placeholder: string;
  disabled?: boolean;
  label?: string;
  id?: string;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const parts = splitChips(draft, value);
    if (parts.length > 0) onChange([...value, ...parts]);
    setDraft("");
  };
  return (
    <div className={cx("flex min-h-9 flex-wrap items-center gap-1 bg-cream-100 p-1.5", pxRing, disabled && "opacity-50")}>
      {value.map((chip) => (
        <span key={chip} className={cx(pxText.xs, "inline-flex items-center gap-1 bg-cream-300 py-0.5 pr-1 pl-2 text-bark-800")}>
          {chip}
          <button
            type="button"
            aria-label={`去掉 ${chip}`}
            disabled={disabled}
            onClick={() => onChange(value.filter((c) => c !== chip))}
            className={cx(focusRing, "cursor-pointer px-1 py-0.5 opacity-70 enabled:hover:opacity-100 disabled:cursor-default")}
          >
            <SpriteIcon name="button-close" size={10} />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        disabled={disabled}
        aria-label={label}
        placeholder={value.length === 0 ? placeholder : ""}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "," || e.key === "Enter") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
            e.preventDefault();
            onChange(value.slice(0, -1));
          }
        }}
        // The box takes the whole row while there are no chips (room for the placeholder) and 96 px after them.
        className={cx(
          pxText.sm,
          "h-6 bg-transparent px-1 text-bark-900 caret-bark-900 outline-none placeholder:text-bark-500",
          value.length === 0 ? "min-w-0 flex-1" : "w-24 grow",
        )}
      />
    </div>
  );
}

function SlimInput({
  value,
  onChange,
  disabled,
  placeholder,
  label,
  onSubmit,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  placeholder?: string;
  label?: string;
  onSubmit?: () => void;
}) {
  return (
    <input
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && onSubmit?.()}
      className={cx(
        pxText.mono,
        pxRing,
        "h-8 w-full min-w-0 bg-cream-100 px-2.5 text-bark-900 caret-bark-900 outline-none placeholder:text-bark-500 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-leaf-500 focus-visible:outline-solid",
      )}
    />
  );
}

const keyColumn = "w-[min(40%,160px)] shrink-0";

/** One `KEY=value` a row; the last row adds one. */
export function PxKeyValueEditor({
  value,
  onChange,
  disabled = false,
  keyPlaceholder = "KEY",
  valuePlaceholder = "value",
}: {
  value: Readonly<Record<string, string>>;
  onChange: (value: Record<string, string>) => void;
  disabled?: boolean;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const [k, setK] = useState("");
  const [v, setV] = useState("");
  const submit = () => {
    const key = k.trim();
    if (!key) return;
    onChange({ ...value, [key]: v });
    setK("");
    setV("");
  };
  return (
    <div className={cx("flex flex-col gap-1.5", disabled && "opacity-50")}>
      {Object.entries(value).map(([key, val]) => (
        <div key={key} className="flex items-center gap-1.5">
          <div className={cx(keyColumn, pxText.mono, "truncate bg-cream-200 px-2.5 py-1.5 text-bark-800")} title={key}>
            {key}
          </div>
          <div className="min-w-0 flex-1">
            <SlimInput value={val} disabled={disabled} label={key} onChange={(nv) => onChange({ ...value, [key]: nv })} />
          </div>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(Object.fromEntries(Object.entries(value).filter(([kk]) => kk !== key)))}
            className={cx(
              pxText.xs,
              pxRing,
              focusRing,
              "h-8 shrink-0 cursor-pointer px-2 text-bark-600 enabled:hover:bg-cream-200 enabled:hover:text-berry enabled:active:translate-x-px enabled:active:translate-y-px disabled:cursor-default",
            )}
          >
            删除
          </button>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <div className={keyColumn}>
          <SlimInput value={k} disabled={disabled} placeholder={keyPlaceholder} label={keyPlaceholder} onChange={setK} onSubmit={submit} />
        </div>
        <div className="min-w-0 flex-1">
          <SlimInput value={v} disabled={disabled} placeholder={valuePlaceholder} label={valuePlaceholder} onChange={setV} onSubmit={submit} />
        </div>
        <button
          type="button"
          disabled={disabled || !k.trim()}
          onClick={submit}
          className={cx(
            pxText.xs,
            pxRing,
            focusRing,
            "h-8 shrink-0 cursor-pointer bg-cream-300 px-3 text-bark-800 enabled:hover:bg-cream-300/60 enabled:active:translate-x-px enabled:active:translate-y-px disabled:cursor-default disabled:opacity-40",
          )}
        >
          添加
        </button>
      </div>
    </div>
  );
}
