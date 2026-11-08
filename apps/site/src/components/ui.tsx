/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { animate, inView, steps } from "motion";
import { createSignal, omit, onSettled } from "solid-js";

import { createElementRef, reducedMotion } from "../animation/scroll";
import { colors, shadows } from "../styles/tokens.stylex";

const styles = stylex.create({
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

export const cx = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");
export const vars = (values: Record<`--${string}`, string | number>) => values;

export function PixelLink(props: { primary?: boolean; className?: string; children: JSX.Element } & JSX.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const rest = omit(props, "primary", "className", "children");
  return (
    <a
      class={cx(
        "shadow-hard inline-flex items-center gap-2.5 border-2 border-bark-900 px-5 py-2.5 font-pixel text-2xl/none active:translate-0.5 active:shadow-none",
        props.primary === true
          ? "inset-shadow-lit bg-leaf-500 text-cream-50 inset-shadow-leaf-hover hover:bg-leaf-hover"
          : "inset-shadow-lit bg-cream-50 text-bark-900 hover:bg-cream-hover",
        props.className,
      )}
      {...rest}
    >
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

export function Heading(props: { id?: string; className?: string; children: JSX.Element }) {
  return (
    <h2 id={props.id} data-reveal class={cx(stylex.attrs(styles.heading).class, props.className)}>
      {props.children}
    </h2>
  );
}

export function CountUp(props: { to: number; className?: string }) {
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
    <span ref={ref.set} class={cx("tabular-nums", props.className)}>
      {shown()}
    </span>
  );
}
