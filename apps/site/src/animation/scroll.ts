import { animate, inView, motionValue, resize, scroll, steps, type DOMKeyframesDefinition, type MotionValue } from "motion";
import { createSignal, onCleanup, onSettled } from "solid-js";

export interface ElementRef<T extends HTMLElement> {
  get: () => T | undefined;
  set: (element: T) => void;
}

export function createElementRef<T extends HTMLElement>(): ElementRef<T> {
  let element: T | undefined;
  return {
    get: () => element,
    set: (next) => {
      element = next;
    },
  };
}

export const reducedMotion = () => typeof window !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export type ElementSource = Pick<ElementRef<HTMLElement>, "get">;

type ScrollOffset = NonNullable<NonNullable<Parameters<typeof scroll>[1]>["offset"]>;
export interface ScrollPart {
  keyframes: DOMKeyframesDefinition;
  times?: number[];
}

export function createScrollAnimation<T extends HTMLElement>(
  target: ElementSource | "self",
  offset: ScrollOffset,
  parts: (target: HTMLElement) => ScrollPart[],
  { still = false }: { still?: boolean } = {},
) {
  const ref = createElementRef<T>();
  onSettled(() => {
    const element = ref.get();
    const over = target === "self" ? element : target.get();
    if (!element || !over || (reducedMotion() && !still)) return;
    let stops: (() => void)[] = [];
    const stop = () => {
      stops.forEach((cancel) => cancel());
      stops = [];
    };
    const start = () => {
      stop();
      for (const part of parts(over)) {
        const animation = animate(element, part.keyframes, { ease: "linear", duration: 1, ...(part.times ? { times: part.times } : {}) });
        stops.push(scroll(animation, { target: over, offset }), () => animation.cancel());
      }
    };
    start();
    const watching = resize(over, start);
    return () => {
      watching();
      stop();
    };
  });
  return ref;
}

export function observeVisibility(ref: ElementSource) {
  onSettled(() => {
    const element = ref.get();
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => element.toggleAttribute("data-off", !entry!.isIntersecting));
    observer.observe(element);
    return () => observer.disconnect();
  });
}

export function createReveal<T extends HTMLElement>() {
  const ref = createElementRef<T>();
  onSettled(() => {
    const root = ref.get();
    if (!root || reducedMotion()) return;
    const stops: (() => void)[] = [];
    for (const element of root.querySelectorAll<HTMLElement>("[data-reveal]")) {
      if (element.getBoundingClientRect().top < innerHeight) continue;
      element.style.opacity = "0";
      element.style.transform = "translateY(24px)";
      const stop = inView(
        element,
        () => {
          const delay = Number(element.dataset.reveal);
          const animation = animate(
            element,
            { opacity: 1, transform: "translateY(0px)" },
            { duration: 0.4, ease: steps(4), delay: (Number.isNaN(delay) ? 0 : delay) / 1000 },
          );
          stops.push(() => animation.cancel());
          stop();
        },
        { margin: "0px 0px -8% 0px" },
      );
      stops.push(stop);
    }
    return () => stops.forEach((stop) => stop());
  });
  return ref;
}

export function createScrollPosition(listener: (value: number) => void, target?: ElementSource) {
  onSettled(() => {
    if (target) {
      const element = target.get();
      if (!element) return;
      return scroll(listener, { target: element, offset: ["start start", "end end"] });
    }
    const update = () => listener(window.scrollY);
    update();
    addEventListener("scroll", update, { passive: true });
    return () => removeEventListener("scroll", update);
  });
}

export function createMotionValue(initial: number) {
  const value = motionValue(initial);
  onCleanup(() => value.destroy());
  return value;
}

export function readMotion(value: MotionValue<number>) {
  const [current, setCurrent] = createSignal(value.get());
  onSettled(() => value.on("change", setCurrent));
  return current;
}
