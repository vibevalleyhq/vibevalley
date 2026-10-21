import type { CSSProperties, ReactNode } from "react";

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

// One weight and no synthesised bold or italics: the pixel font has neither. Line heights are Tailwind's for each size;
// the skin changes the size, not the line height. Sharp at 12 and 24 px only.
const pixel = "font-pixel font-normal [font-synthesis:none] tracking-normal";

export const pxText = {
  xs: `${pixel} text-[12px] leading-[1.3333]`,
  fine: `${pixel} text-[12px] leading-[1.5]`,
  sm: `${pixel} text-[12px] leading-[1.4286]`,
  base: `${pixel} text-[12px] leading-[1.5]`,
  lg: `${pixel} text-[24px] leading-[1.5556]`,
  xl: `${pixel} text-[24px] leading-[1.4]`,
  x2l: `${pixel} text-[24px] leading-[1.3333]`,
  mono: "font-mono font-normal text-[12px] leading-[1.3333]",
  /** What is read rather than said: a report, an issue's description. Labels and chat stay pixel. */
  read: "font-sans font-normal text-[14px] leading-[1.7]",
} as const;

/** A line of pxText.read is at most this many of its characters wide. */
export const readMeasure = 40;

export const pxDrop = "shadow-[2px_2px_0_0_var(--color-px-drop)]";

/** The 2 px cream-300 line inside a box: an inset shadow, so it takes no room from what is inside. */
export const pxRing = "shadow-[inset_0_0_0_2px_var(--color-cream-300)]";

// One edge with the corners left out and a soft drop that shows only past the corner: an inner rim and a thick
// bottom band on top of them read as a double, heavy frame.
export const pxWindow =
  "shadow-[0_-2px_0_0_var(--color-bark-500),0_2px_0_0_var(--color-bark-500),-2px_0_0_0_var(--color-bark-500),2px_0_0_0_var(--color-bark-500),2px_2px_0_0_var(--color-px-drop)]";

/** `border` draws a second edge inside the frame. `paper` is a bg-* class. */
export function PxWindow({
  children,
  paper = "bg-cream-50",
  border = false,
  className,
  style,
}: {
  children?: ReactNode;
  paper?: string;
  border?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={cx(paper, pxWindow, border && "border-2 border-bark-500", "text-bark-900", className)} style={style}>
      {children}
    </div>
  );
}

export function PxCard({ title, aside, children, className }: { title?: ReactNode; aside?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <PxWindow className={cx("flex flex-col p-4", className)}>
      {title != null && (
        // The aside wraps under the title when both do not fit, instead of squeezing the title to a letter a line.
        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <div className={pxText.sm}>{title}</div>
          {aside != null && <div className={cx(pxText.xs, "text-bark-500")}>{aside}</div>}
        </div>
      )}
      {children}
    </PxWindow>
  );
}

/** `color` is a CSS colour; dashes are twice the thickness, with gaps as long. */
export function DashedLine({
  color = "var(--color-cream-200)",
  thickness = 2,
  vertical = false,
  className,
}: {
  color?: string;
  thickness?: number;
  vertical?: boolean;
  className?: string;
}) {
  const dash = thickness * 2;
  return (
    <div
      aria-hidden
      className={cx("shrink-0", className)}
      style={{
        [vertical ? "width" : "height"]: thickness,
        [vertical ? "height" : "width"]: "100%",
        background: `repeating-linear-gradient(${vertical ? "to bottom" : "to right"}, ${color} 0 ${dash}px, transparent ${dash}px ${dash * 2}px)`,
      }}
    />
  );
}
