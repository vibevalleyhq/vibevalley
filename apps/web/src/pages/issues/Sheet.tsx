import { type ReactNode, useState } from "react";
import type { Tone } from "../../rules/cards";
import { type Stage, stageLabel, stages } from "../../rules/issues";
import { Icon } from "../../ui/Icon";
import { toneVar } from "./Marks";

/** An issue laid out as a page: what it is and the talk about it on the left, its properties and actions on the right.
 * Too narrow for two, the properties come under the heading. */
export function IssueSheet({ heading, main, side }: { heading: ReactNode; main: ReactNode; side: ReactNode }) {
  return (
    <div className="@container">
      {heading}
      <div className="mt-4 flex flex-col gap-4 @min-[760px]:flex-row-reverse @min-[760px]:items-start @min-[760px]:gap-6">
        <aside className="flex flex-col rounded-lg bg-hover p-3 @min-[760px]:w-[260px] @min-[760px]:shrink-0 @min-[760px]:rounded-none @min-[760px]:border-l @min-[760px]:border-line @min-[760px]:bg-transparent @min-[760px]:py-0 @min-[760px]:pr-0 @min-[760px]:pl-5">
          {side}
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">{main}</div>
      </div>
    </div>
  );
}

/** A label and its value, the label in a narrow muted column. */
export function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-3 py-0.5 text-sm">
      <span className="w-16 shrink-0 text-muted">{label}</span>
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

/** A second-level part: folded until asked for, its summary beside the label. */
export function Fold({
  label,
  summary,
  open: initial = false,
  leading,
  children,
}: {
  label: string;
  summary?: string;
  open?: boolean;
  leading?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initial);
  return (
    <div className="border-b border-line last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center gap-2 py-2.5 text-left hover:bg-hover"
      >
        <Icon name="button-next" size={10} className={`transition-transform ${open ? "rotate-90" : ""}`} />
        {leading}
        <span className="shrink-0 text-sm font-semibold">{label}</span>
        {summary && <span className="min-w-0 truncate text-xs text-muted">{summary}</span>}
      </button>
      {open && <div className="pb-3 pl-5">{children}</div>}
    </div>
  );
}

/** The properties asked about less often, behind 更多. */
export function More({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button type="button" onClick={() => setOpen(!open)} className="flex cursor-pointer items-center gap-1.5 py-1 text-xs text-muted hover:text-ink">
        <Icon name="button-next" size={8} className={open ? "rotate-90" : ""} />
        {open ? "收起" : "更多"}
      </button>
      {open && <div className="mt-1">{children}</div>}
    </div>
  );
}

export const SheetLabel = ({ children }: { children: ReactNode }) => <div className="mt-6 mb-1.5 text-xs font-semibold text-muted">{children}</div>;

/** A tinted box: the status, a conflict, nothing to merge. */
export function Note({ tone, children, className = "" }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-lg px-3.5 py-3 text-sm ${className}`}
      style={{ background: tone ? `color-mix(in srgb, ${toneVar(tone)} 16%, transparent)` : "var(--color-hover)" }}
    >
      {children}
    </div>
  );
}

/** 聊清楚 → 安排活 → 完成, the one it is at marked. */
export function Stages({ at }: { at: Stage }) {
  const ati = stages.indexOf(at);
  return (
    <div className="flex items-center text-sm" aria-label={`在「${stageLabel[at]}」`}>
      {stages.map((s, i) => (
        <div key={s} className={`flex items-center ${i > 0 ? "flex-1" : ""}`}>
          {i > 0 && <div className={`mx-2 h-px flex-1 ${i <= ati ? "bg-leaf" : "bg-line"}`} />}
          <span className="flex items-center gap-1.5 whitespace-nowrap">
            {i < ati ? (
              <Icon name="mark-check" size={12} label={`${stageLabel[s]}做完了`} />
            ) : (
              <span className={`size-2 rounded-full ${s === at ? "bg-wheat" : "bg-line"}`} />
            )}
            <span className={s === at ? "font-semibold text-ink" : i < ati ? "text-accent" : "text-faint"}>{stageLabel[s]}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** A small menu-like pick in the side column. */
export function Pick({
  label,
  value,
  options,
  placeholder,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  placeholder?: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="-ml-2 h-7 w-[calc(100%+8px)] cursor-pointer rounded-md border border-transparent bg-transparent px-1.5 text-sm outline-none hover:border-line hover:bg-page focus:border-focus disabled:cursor-default disabled:opacity-60"
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
