// The farm skin's classes and pixel sizes, framework-free: the kit's components and the rules draw with them.

export const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" ");

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

/** The pixel skin's one focus ring: a leaf line a pixel off the edge, only when the keyboard got there. */
export const pxFocus = "outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-leaf-500 focus-visible:outline-solid";

/** The 2 px cream-300 line inside a box: an inset shadow, so it takes no room from what is inside. */
export const pxRing = "shadow-[inset_0_0_0_2px_var(--color-cream-300)]";

// One edge with the corners left out and a soft drop that shows only past the corner: an inner rim and a thick
// bottom band on top of them read as a double, heavy frame.
export const pxWindow =
  "shadow-[0_-2px_0_0_var(--color-bark-500),0_2px_0_0_var(--color-bark-500),-2px_0_0_0_var(--color-bark-500),2px_0_0_0_var(--color-bark-500),2px_2px_0_0_var(--color-px-drop)]";

// A light rim inside, a 4 px cream-300 band at the foot, a 2 px ink outline with the corners left out, and a drop 2 px
// right and 4 px down that shows past the corner.
export const pxFrame =
  "shadow-[inset_0_0_0_2px_var(--color-rim),inset_0_-4px_0_0_var(--color-cream-300),0_-2px_0_0_var(--color-px-ink),0_2px_0_0_var(--color-px-ink),-2px_0_0_0_var(--color-px-ink),2px_0_0_0_var(--color-px-ink),2px_4px_0_0_var(--color-px-drop)]";

/** A sunken well: `fill` a bg-* class, `line` a border-* class. */
export const pxInset = ({ fill = "bg-cream-200", line = "border-cream-300" }: { fill?: string; line?: string } = {}) => cx(fill, "border-2", line);
