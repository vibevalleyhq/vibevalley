import type { ReactNode } from "react";
import { cx } from "./base";

// A light rim inside, a 4 px cream-300 band at the foot, a 2 px ink outline with the corners left out, and a drop 2 px
// right and 4 px down that shows past the corner.
const frame =
  "shadow-[inset_0_0_0_2px_var(--color-rim),inset_0_-4px_0_0_var(--color-cream-300),0_-2px_0_0_var(--color-px-ink),0_2px_0_0_var(--color-px-ink),-2px_0_0_0_var(--color-px-ink),2px_0_0_0_var(--color-px-ink),2px_4px_0_0_var(--color-px-drop)]";

/** `paper` is a bg-* class; the content sits 2 px in, clear of the rim. */
export function PxFrame({ children, paper = "bg-cream-50", className }: { children?: ReactNode; paper?: string; className?: string }) {
  return <div className={cx(paper, frame, "p-0.5 text-bark-900", className)}>{children}</div>;
}

/** A sunken well: `fill` a bg-* class, `line` a border-* class. */
export const pxInset = ({ fill = "bg-cream-200", line = "border-cream-300" }: { fill?: string; line?: string } = {}) => cx(fill, "border-2", line);
