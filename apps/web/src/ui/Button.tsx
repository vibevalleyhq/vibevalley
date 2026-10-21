import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon } from "./Icon";

type Tone = "plain" | "primary" | "quiet" | "danger";

const tones: Record<Tone, string> = {
  plain: "border border-line bg-page hover:bg-hover",
  primary: "border border-accent bg-accent text-page hover:bg-leaf",
  quiet: "border border-transparent hover:bg-hover",
  danger: "border border-line bg-page text-berry hover:bg-hover",
};

export function Button({
  tone = "plain",
  icon,
  children,
  className = "",
  ...rest
}: { tone?: Tone; icon?: string; children?: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-sm whitespace-nowrap disabled:cursor-default disabled:opacity-50 ${tones[tone]} ${className}`}
      {...rest}
    >
      {icon && <Icon name={icon} size={14} />}
      {children}
    </button>
  );
}
