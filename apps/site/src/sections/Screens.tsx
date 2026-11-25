import type { JSX } from "@solidjs/web";
import { createSignal, onCleanup, onSettled } from "solid-js";

import type { Copy } from "../i18n/zh";
import { Icon } from "../ui/icons";
import { createImageTransition } from "../ui/image";
import { Presence } from "../ui/Presence";
import { createElementRef, createReveal, createScrollAnimation } from "../ui/scroll";
import { Section } from "../ui/ui";

interface Shot {
  src: string;
  srcset: string;
  width: number;
  height: number;
  caption: string;
}
interface Props {
  copy: Copy["screens"];
  shots: Shot[];
}
const SIZES = [
  "(min-width: 1024px) 640px, calc(100vw - 48px)",
  "(min-width: 1024px) 460px, calc(100vw - 48px)",
  "(min-width: 1024px) 460px, calc(100vw - 48px)",
];
const DRIFT = [0.04, -0.05, -0.09];

export default function Screens(props: Props) {
  const root = createReveal<HTMLElement>();
  const [open, setOpen] = createSignal<{ shot: Shot; source: HTMLImageElement } | undefined>(undefined);
  return (
    <>
      <Section ref={root.set} id="screens" title={props.copy.title}>
        <div class="grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] items-start gap-7">
          {props.shots.map((shot, i) => (
            <Drift rate={DRIFT[i] ?? 0} class={[i === 0 && "lg:row-span-2", i === 1 && "lg:mt-15"]}>
              <figure data-reveal class="m-0 rounded-lg border border-border-soft/45 bg-card [box-shadow:var(--inset-shadow-rim),_var(--shadow-card)] p-2.5">
                <button
                  type="button"
                  data-testid={`screenshot-${i}`}
                  title={props.copy.open}
                  class="block w-full cursor-zoom-in overflow-hidden rounded-sm"
                  onClick={(event) => {
                    const source = event.currentTarget.querySelector("img");
                    if (source) setOpen({ shot, source });
                  }}
                >
                  <img
                    src={shot.src}
                    srcset={shot.srcset}
                    sizes={SIZES[i]}
                    alt={shot.caption}
                    loading="lazy"
                    decoding="async"
                    width={shot.width}
                    height={shot.height}
                    class="block h-auto w-full rounded-sm border border-border-soft/35"
                  />
                </button>
                <figcaption class="px-1 pt-2.5 pb-0.5 text-[length:15px] text-bark-800">{shot.caption}</figcaption>
              </figure>
            </Drift>
          ))}
        </div>
      </Section>
      <Presence value={open()} enter={{ opacity: [0, 1] }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
        {(value, ref) => <Large shot={value.shot} source={value.source} label={props.copy.close} onClose={() => setOpen(undefined)} ref={ref} />}
      </Presence>
    </>
  );
}

function Drift(props: { rate: number; class?: JSX.ClassValue | undefined; children: JSX.Element }) {
  const ref = createScrollAnimation<HTMLDivElement>("self", ["start end", "end start"], () => [
    { keyframes: { transform: [`translateY(${600 * props.rate}px)`, `translateY(${-600 * props.rate}px)`] } },
  ]);
  return (
    <div ref={ref.set} class={[props.class]}>
      {props.children}
    </div>
  );
}

function Large(props: { shot: Shot; source: HTMLImageElement; label: string; onClose: () => void; ref: (element: HTMLElement) => void }) {
  const button = createElementRef<HTMLButtonElement>();
  const image = createElementRef<HTMLImageElement>();
  let cancel = () => {};
  const close = () => {
    cancel();
    const element = image.get();
    if (element) cancel = createImageTransition(element, props.source, true);
    props.onClose();
  };
  onCleanup(() => cancel());
  onSettled(() => {
    const before = document.activeElement;
    button.get()?.focus();
    const element = image.get();
    if (element) cancel = createImageTransition(element, props.source);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key === "Tab") {
        event.preventDefault();
        button.get()?.focus();
      }
    };
    addEventListener("keydown", key);
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => {
      removeEventListener("keydown", key);
      document.documentElement.style.overflow = overflow;
      if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true });
    };
  });
  return (
    <div
      ref={props.ref}
      role="dialog"
      aria-modal="true"
      aria-label={props.shot.caption}
      data-testid="screenshot-dialog"
      onClick={close}
      class="fixed inset-0 z-50 grid place-items-center bg-[color-mix(in_oklab,_var(--color-shade)_78%,_transparent)] backdrop-blur-xs p-4 sm:p-8"
    >
      <figure
        onClick={(event) => event.stopPropagation()}
        class="relative m-0 rounded-lg border border-border-soft/55 bg-card [box-shadow:var(--inset-shadow-rim),_var(--shadow-card-lg)] p-2.5"
      >
        <img
          ref={image.set}
          src={props.shot.src}
          alt={props.shot.caption}
          class="block h-auto max-h-[80svh] w-auto max-w-full rounded-sm border border-border-soft/35"
        />
        <figcaption class="px-1 pt-2.5 pb-0.5 text-[length:15px] text-bark-800">{props.shot.caption}</figcaption>
        <button
          ref={button.set}
          type="button"
          data-testid="screenshot-close"
          onClick={close}
          aria-label={props.label}
          class="absolute -top-4 -right-4 grid w-10 h-10 cursor-pointer place-items-center rounded-full border border-border-soft/65 bg-card hover:bg-cream-hover text-bark-900 shadow-card"
        >
          <Icon name="close" class="w-5 h-5" />
        </button>
      </figure>
    </div>
  );
}
