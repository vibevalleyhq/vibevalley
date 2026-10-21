import { useState } from "react";

const box = "flex min-h-8 w-full flex-wrap items-center gap-1 rounded-md border border-line bg-page px-1.5 py-1 focus-within:border-focus";

/** Words as chips: enter (or a comma) adds the typed one, backspace on an empty box takes the last off. */
export function ChipsInput({
  value,
  onChange,
  placeholder,
  label,
  disabled = false,
}: {
  value: readonly string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  label: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const add = () => {
    const t = text.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setText("");
  };
  return (
    <div className={`${box} ${disabled ? "opacity-50" : ""}`}>
      {value.map((v) => (
        <span key={v} className="flex items-center gap-0.5 rounded bg-hover py-px pr-0.5 pl-1.5 text-xs">
          {v}
          <button
            type="button"
            disabled={disabled}
            aria-label={`去掉 ${v}`}
            onClick={() => onChange(value.filter((x) => x !== v))}
            className="cursor-pointer rounded px-1 text-muted hover:bg-selected hover:text-berry"
          >
            ×
          </button>
        </span>
      ))}
      <input
        aria-label={label}
        disabled={disabled}
        value={text}
        placeholder={value.length === 0 ? placeholder : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && text === "" && value.length > 0) onChange(value.slice(0, -1));
        }}
        className="h-6 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-faint"
      />
    </div>
  );
}

/** Names and their values, a row each, and an empty row to add one. */
export function KeyValueEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: Readonly<Record<string, string>>;
  onChange: (v: Record<string, string>) => void;
  disabled?: boolean;
}) {
  const [key, setKey] = useState("");
  const [val, setVal] = useState("");
  const rows = Object.entries(value);
  const field = "h-8 min-w-0 rounded-md border border-line bg-page px-2 font-mono text-sm outline-none placeholder:text-faint focus:border-focus";
  return (
    <div className={`flex flex-col gap-1.5 ${disabled ? "opacity-50" : ""}`}>
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center gap-1.5">
          <span className="w-40 truncate font-mono text-sm">{k}</span>
          <input
            aria-label={`${k} 的值`}
            disabled={disabled}
            className={`${field} flex-1`}
            value={v}
            onChange={(e) => onChange({ ...value, [k]: e.target.value })}
          />
          <button
            type="button"
            disabled={disabled}
            aria-label={`删除 ${k}`}
            onClick={() => onChange(Object.fromEntries(rows.filter(([x]) => x !== k)))}
            className="cursor-pointer rounded px-1.5 text-xs text-muted hover:text-berry"
          >
            删除
          </button>
        </div>
      ))}
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!key.trim()) return;
          onChange({ ...value, [key.trim()]: val });
          setKey("");
          setVal("");
        }}
      >
        <input aria-label="变量名" disabled={disabled} placeholder="NAME" className={`${field} w-40`} value={key} onChange={(e) => setKey(e.target.value)} />
        <input aria-label="变量的值" disabled={disabled} placeholder="值" className={`${field} flex-1`} value={val} onChange={(e) => setVal(e.target.value)} />
        <button
          type="submit"
          disabled={disabled || !key.trim()}
          className="h-7 cursor-pointer rounded-md border border-line px-2.5 text-sm hover:bg-hover disabled:opacity-50"
        >
          添加
        </button>
      </form>
    </div>
  );
}
