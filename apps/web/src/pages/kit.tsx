// What the workbench's list-and-detail pages share: a list card of rows on the left, the open
// one's card on the right, and the few controls their forms use.

import { type InputHTMLAttributes, type ReactNode, useState } from "react";
import { Link } from "react-router";
import { TextInput } from "../ui/Field";

/** A list beside its detail; under md the list stacks over it. */
export function Split({ list, children }: { list: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto md:flex-row md:overflow-hidden">
      <div className="shrink-0 md:w-70 md:overflow-y-auto">{list}</div>
      <div className="min-w-0 flex-1 md:overflow-y-auto">{children}</div>
    </div>
  );
}

/** A titled list of rows; aria-label names it for the reader. */
export function ListCard({ title, label, action, children }: { title: string; label?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={label ?? title} className="flex flex-col rounded-lg border border-line bg-page">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <h2 className="flex-1 truncate text-sm font-semibold">{title}</h2>
        {action}
      </header>
      <ul className="flex flex-col p-1">{children}</ul>
    </section>
  );
}

/** A row: a link to its detail, marked when it is the open one. */
export function ListRow({
  to,
  active,
  title,
  line,
  leading,
  trailing,
}: {
  to: string;
  active?: boolean;
  title: string;
  line?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <li>
      <Link
        to={to}
        aria-current={active ? "page" : undefined}
        className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus ${active ? "bg-selected" : ""}`}
      >
        {leading}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{title}</span>
          {line && <span className="truncate text-xs text-muted">{line}</span>}
        </span>
        {trailing}
      </Link>
    </li>
  );
}

/** The open thing's card: a title, what sits beside it, and its body. */
export function Card({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`flex flex-col rounded-lg border border-line bg-page ${className}`}>
      {title !== undefined && (
        <header className="flex min-h-12 items-center gap-2 border-b border-line px-4 py-2">
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h2>
          {action}
        </header>
      )}
      <div className="flex flex-col gap-4 p-4">{children}</div>
    </section>
  );
}

/** Nothing to show yet, in words. */
export const Quiet = ({ children }: { children: ReactNode }) => <p className="text-sm text-muted">{children}</p>;

/** An on/off with its label and a hint under it. */
export function Switch({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-start gap-2 ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors ${checked ? "bg-accent" : "bg-selected"}`}
      >
        <span className={`block size-3 rounded-full bg-page shadow transition-transform ${checked ? "translate-x-3" : ""}`} />
      </button>
      <span className="flex flex-col">
        <span className="text-sm">{label}</span>
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
}

/** A key: hidden until 看 is pressed. */
export function SecretInput({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  const [shown, setShown] = useState(false);
  return (
    <span className="relative flex">
      <TextInput type={shown ? "text" : "password"} autoComplete="off" spellCheck={false} className={`pr-10 font-mono ${className}`} {...rest} />
      <button
        type="button"
        className="absolute inset-y-0 right-1 my-auto h-6 cursor-pointer rounded px-1.5 text-xs text-muted hover:bg-hover"
        aria-label={shown ? "藏起来" : "看一眼"}
        onClick={() => setShown(!shown)}
      >
        {shown ? "藏" : "看"}
      </button>
    </span>
  );
}

/** A quiet underlined word: a page to open in the browser, or onClick. */
export function TextLink({ children, href, onClick, danger }: { children: ReactNode; href?: string; onClick?: () => void; danger?: boolean }) {
  const look = `cursor-pointer text-xs underline decoration-current/50 hover:text-ink ${danger ? "text-berry" : "text-muted"}`;
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className={look}>
      {children}
    </a>
  ) : (
    <button type="button" className={look} onClick={onClick}>
      {children}
    </button>
  );
}
