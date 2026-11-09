import * as stylex from "@stylexjs/stylex";

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
