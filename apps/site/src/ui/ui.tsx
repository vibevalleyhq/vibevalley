/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";
import { animate, inView } from "motion";
import { createSignal, omit, onSettled } from "solid-js";

import { createElementRef, reducedMotion } from "./scroll";

export function PaperLink(props: { primary?: boolean; children: JSX.Element } & Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "class" | "style">) {
  const rest = omit(props, "primary", "children");
  return (
    <a
      class={[
        "inline-flex items-center gap-2.5 rounded-md border px-5 py-2.5 font-sans text-base font-semibold leading-none transition-[transform,background-color,box-shadow] ease-out duration-200 hover:-translate-y-0.5 active:translate-y-0",
        props.primary === true
          ? "border-leaf-700/80 bg-leaf-500 hover:bg-leaf-hover text-paper-core [box-shadow:inset_0_1px_0_rgb(255_250_240_/_0.35),_var(--shadow-card)]"
          : "border-border-soft/60 bg-card hover:bg-cream-hover text-bark-900 [box-shadow:var(--inset-shadow-rim),_var(--shadow-card)]",
      ]}
      {...rest}
    >
      {props.children}
    </a>
  );
}

export function Section(props: { id: string; title: string; alt?: boolean; ref?: JSX.IntrinsicElements["section"]["ref"]; children: JSX.Element }) {
  return (
    <section
      ref={props.ref}
      id={props.id}
      aria-labelledby={`${props.id}-title`}
      class={["relative px-[clamp(16px,_5vw,_64px)] py-[clamp(64px,_9vw,_120px)]", props.alt === true && "border-y border-y-border-soft/30 bg-cream-100"]}
    >
      <div class="mx-auto max-w-280">
        <Heading id={`${props.id}-title`}>{props.title}</Heading>
        {props.children}
      </div>
    </section>
  );
}

export function Heading(props: { id?: string; class?: JSX.ClassValue | undefined; children: JSX.Element }) {
  return (
    <h2
      id={props.id}
      data-reveal
      class={[
        "mb-9 flex items-center gap-3.5 text-[length:clamp(28px,_3.4vw,_40px)] text-bark-900 before:content-[''] before:w-3.5 before:h-3.5 before:shrink-0 before:rounded-[4px] before:border before:border-solid before:border-bark-800/70 before:bg-wheat before:shadow-card-sm",
        props.class,
      ]}
    >
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
        const run = animate(0, props.to, { duration: 0.9, ease: [0.22, 1, 0.36, 1], onUpdate: (value) => setShown(Math.round(value)) });
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
    <span ref={ref.set} class="tabular-nums">
      {shown()}
    </span>
  );
}
