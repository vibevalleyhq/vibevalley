/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { animate, inView, steps } from "motion";
import { createSignal, omit, onSettled } from "solid-js";

import { createElementRef, reducedMotion } from "../animation/scroll";
import { colors, shadows } from "../styles/tokens.stylex";

const styles = stylex.create({
  link: {
    display: "inline-flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2.5)",
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: "var(--color-bark-900)",
    paddingInline: "calc(var(--spacing) * 5)",
    paddingBlock: "calc(var(--spacing) * 2.5)",
    fontFamily: "var(--font-pixel)",
    fontSize: "var(--text-2xl)",
    lineHeight: "1",
    translate: { default: null, ":active": "calc(var(--spacing) * 0.5) calc(var(--spacing) * 0.5)" },
  },
  primary: {
    backgroundColor: { default: "var(--color-leaf-500)", "@media (hover: hover)": { default: null, ":hover": "var(--color-leaf-hover)" } },
    color: "var(--color-cream-50)",
    boxShadow: { default: "inset 2px 2px 0 var(--color-leaf-hover), var(--shadow-hard)", ":active": "inset 2px 2px 0 var(--color-leaf-hover)" },
  },
  secondary: {
    backgroundColor: { default: "var(--color-cream-50)", "@media (hover: hover)": { default: null, ":hover": "var(--color-cream-hover)" } },
    color: "var(--color-bark-900)",
    boxShadow: { default: "var(--inset-shadow-lit), var(--shadow-hard)", ":active": "var(--inset-shadow-lit)" },
  },
  count: { fontVariantNumeric: "tabular-nums" },
  section: {
    position: "relative",
    paddingInline: "clamp(16px, 5vw, 64px)",
    paddingBlock: "clamp(64px, 9vw, 120px)",
  },
  alternate: {
    borderBlockWidth: "2px",
    borderBlockStyle: "solid",
    borderBlockColor: colors.bark,
    backgroundColor: colors.cream,
  },
  content: { marginInline: "auto", maxWidth: "1120px" },
  heading: {
    marginBottom: "2.25rem",
    display: "flex",
    alignItems: "center",
    gap: "0.875rem",
    fontSize: "clamp(30px, 3.6vw, 42px)",
    "::before": {
      content: "''",
      width: "0.875rem",
      height: "0.875rem",
      flexShrink: 0,
      borderWidth: "2px",
      borderStyle: "solid",
      borderColor: colors.bark,
      backgroundColor: colors.wheat,
      boxShadow: shadows.small,
    },
  },
});

export function domAttrs(...values: readonly stylex.StyleXStyles[]) {
  const { className, ...attributes } = stylex.props(values);
  return { ...attributes, class: className };
}

export function PixelLink(props: { primary?: boolean; children: JSX.Element } & Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "class" | "style">) {
  const rest = omit(props, "primary", "children");
  return (
    <a {...stylex.attrs(styles.link, props.primary === true ? styles.primary : styles.secondary)} {...rest}>
      {props.children}
    </a>
  );
}

export function Section(props: { id: string; title: string; alt?: boolean; ref?: JSX.IntrinsicElements["section"]["ref"]; children: JSX.Element }) {
  return (
    <section ref={props.ref} id={props.id} aria-labelledby={`${props.id}-title`} {...stylex.attrs(styles.section, props.alt === true && styles.alternate)}>
      <div {...stylex.attrs(styles.content)}>
        <Heading id={`${props.id}-title`}>{props.title}</Heading>
        {props.children}
      </div>
    </section>
  );
}

export function Heading(props: { id?: string; styles?: stylex.StyleXStyles; children: JSX.Element }) {
  return (
    <h2 id={props.id} data-reveal {...domAttrs(styles.heading, props.styles)}>
      {props.children}
    </h2>
  );
}

export function CountUp(props: { to: number }) {
  const ref = createElementRef<HTMLSpanElement>();
  const [shown, setShown] = createSignal(() => props.to);
  onSettled(() => {
    const element = ref.get();
    if (!element || reducedMotion()) return;
    let cancel = () => {};
    const stop = inView(
      element,
      () => {
        const run = animate(0, props.to, { duration: 1.1, ease: steps(Math.min(12, props.to)), onUpdate: (value) => setShown(Math.round(value)) });
        cancel = () => run.stop();
        return undefined;
      },
      { margin: "0px 0px -10% 0px" },
    );
    return () => {
      stop();
      cancel();
    };
  });
  return (
    <span ref={ref.set} {...stylex.attrs(styles.count)}>
      {shown()}
    </span>
  );
}
