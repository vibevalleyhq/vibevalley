import * as stylex from "@stylexjs/stylex";

export const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" ");

// One weight and no synthesised bold or italics: the pixel font has neither. Line heights are Tailwind's for each size.
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

export const pxDrop = "shadow-[2px_2px_0_0_var(--color-px-drop)]";

/** The pixel skin's one focus ring: a leaf line a pixel off the edge, only when the keyboard got there. */
export const pxFocus = "outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-leaf-500 focus-visible:outline-solid";

/** The 2 px cream-300 line inside a box: an inset shadow, so it takes no room from what is inside. */
export const pxRing = "shadow-[inset_0_0_0_2px_var(--color-cream-300)]";

/** Shared StyleX primitives for the pixel skin's type ladder, focus ring, inset lines, and window chrome. */
export const pxStyle = stylex.create({
  window: {
    boxShadow:
      "0 -2px 0 0 var(--color-bark-500), 0 2px 0 0 var(--color-bark-500), -2px 0 0 0 var(--color-bark-500), 2px 0 0 0 var(--color-bark-500), 2px 2px 0 0 var(--color-px-drop)",
  },
  frame: {
    boxShadow:
      "inset 0 0 0 2px var(--color-rim), inset 0 -4px 0 0 var(--color-cream-300), 0 -2px 0 0 var(--color-px-ink), 0 2px 0 0 var(--color-px-ink), -2px 0 0 0 var(--color-px-ink), 2px 0 0 0 var(--color-px-ink), 2px 4px 0 0 var(--color-px-drop)",
  },
  xs: {
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.3333",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    fontSynthesis: "none",
  },
  fine: {
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.5",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    fontSynthesis: "none",
  },
  sm: {
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.4286",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    fontSynthesis: "none",
  },
  base: {
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.5",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    fontSynthesis: "none",
  },
  lg: {
    fontFamily: "var(--font-pixel)",
    fontSize: "24px",
    lineHeight: "1.5556",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    fontSynthesis: "none",
  },
  xl: {
    fontFamily: "var(--font-pixel)",
    fontSize: "24px",
    lineHeight: "1.4",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    fontSynthesis: "none",
  },
  x2l: {
    fontFamily: "var(--font-pixel)",
    fontSize: "24px",
    lineHeight: "1.3333",
    fontWeight: "var(--font-weight-normal)",
    letterSpacing: "var(--tracking-normal)",
    fontSynthesis: "none",
  },
  mono: {
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    lineHeight: "1.3333",
    fontWeight: "var(--font-weight-normal)",
  },
  read: {
    fontFamily: "var(--font-sans)",
    fontSize: "14px",
    lineHeight: "1.7",
    fontWeight: "var(--font-weight-normal)",
  },
  focus: {
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineOffset: { default: null, ":focus-visible": "1px" },
    outlineColor: { default: null, ":focus-visible": "var(--color-leaf-500)" },
  },
  ring: {
    boxShadow: "inset 0 0 0 2px var(--color-cream-300)",
  },
  drop: {
    boxShadow: "2px 2px 0 0 var(--color-px-drop)",
  },
  shade: {
    boxShadow: "2px 2px 0 0 var(--color-px-shade)",
  },
});
