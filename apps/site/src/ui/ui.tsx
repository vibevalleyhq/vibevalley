/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";
import { animate, inView, steps } from "motion";
import { createSignal, omit, onSettled } from "solid-js";

import { createElementRef, reducedMotion } from "./scroll";

export function PixelLink(props: { primary?: boolean; children: JSX.Element } & Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "class" | "style">) {
  const rest = omit(props, "primary", "children");
  return (
    <a
      class={[
        "inline-flex items-center gap-2.5 border-2 border-bark-900 px-5 py-2.5 font-pixel text-2xl leading-none active:[translate:0.125rem_0.125rem]",
        props.primary === true
          ? "bg-leaf-500 hover:bg-leaf-hover text-cream-50 [box-shadow:inset_2px_2px_0_var(--color-leaf-hover),_var(--shadow-hard)] active:[box-shadow:inset_2px_2px_0_var(--color-leaf-hover)]"
          : "bg-cream-50 hover:bg-cream-hover text-bark-900 [box-shadow:var(--inset-shadow-lit),_var(--shadow-hard)] active:[box-shadow:var(--inset-shadow-lit)]",
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
      class={["relative px-[clamp(16px,_5vw,_64px)] py-[clamp(64px,_9vw,_120px)]", props.alt === true && "border-y-2 border-y-bark-900 bg-cream-100"]}
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
        "mb-9 flex items-center gap-3.5 text-[length:clamp(30px,_3.6vw,_42px)] before:content-[''] before:w-3.5 before:h-3.5 before:shrink-0 before:border-2 before:border-solid before:border-bark-900 before:bg-wheat before:shadow-hard-sm",
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
    <span ref={ref.set} class="tabular-nums">
      {shown()}
    </span>
  );
}
