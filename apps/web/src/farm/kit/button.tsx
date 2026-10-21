import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx, pxDrop, pxText } from "./base";
import { SpriteIcon } from "./icons";

export type PxTone = "plain" | "primary" | "danger" | "accent";
export type PxSize = "md" | "sm" | "icon" | "custom";

const tones: Record<PxTone, string> = {
  plain: "bg-cream-50 enabled:hover:bg-cream-hover text-bark-900",
  primary: "bg-leaf-500 enabled:hover:bg-leaf-hover text-cream-50",
  // berry at 95 %.
  danger: "bg-berry enabled:hover:bg-[#be4637] text-cream-50",
  accent: "bg-wheat enabled:hover:bg-wheat-hover text-bark-900",
};

const sizes: Record<PxSize, string> = {
  md: "h-9 px-4",
  sm: "h-7 px-2",
  icon: "size-9",
  custom: "",
};

/** Disabled without `onClick`. `label` names an icon button; `title` is its tooltip. `icon` goes before the words at 14 px. */
export function PxButton({
  children,
  onClick,
  tone = "plain",
  size = "md",
  icon,
  label,
  disabled,
  className,
  type = "button",
  ...rest
}: {
  children?: ReactNode;
  tone?: PxTone;
  size?: PxSize;
  icon?: string;
  label?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label">) {
  // An icon alone is not framed: it sits inside a frame already (a window, a field, a card), and a ring per icon is a box
  // in a box. Hover and press show it can be tapped; the focus outline stays.
  const bare = size === "icon" && tone === "plain";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || !onClick}
      aria-label={label}
      className={cx(
        pxText.sm,
        "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap select-none",
        "outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-leaf-500 focus-visible:outline-solid",
        "disabled:cursor-default disabled:opacity-45",
        sizes[size],
        bare
          ? "text-bark-900 enabled:hover:bg-cream-200 enabled:active:bg-cream-300"
          : cx(tones[tone], "border-2 border-bark-500", pxDrop, "enabled:active:translate-x-[2px] enabled:active:translate-y-[2px] enabled:active:shadow-none"),
        className,
      )}
      {...rest}
    >
      {icon && <SpriteIcon name={icon} size={14} />}
      {children}
    </button>
  );
}
