/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";
import { animate, type DOMKeyframesDefinition, type AnimationOptions } from "motion";
import { createEffect, createMemo, createSignal, onCleanup, onSettled, Show, untrack } from "solid-js";

import { reducedMotion } from "./scroll";

interface Options {
  enter: DOMKeyframesDefinition;
  exit: DOMKeyframesDefinition;
  transition?: AnimationOptions;
  initial?: boolean;
}

export function createPresence<T>(source: () => T | undefined, options: Options) {
  const [current, setCurrent] = createSignal<T | undefined>(() => untrack(source));
  let element: HTMLElement | undefined;
  let cancel = () => {};
  let generation = 0;
  let first = true;
  const enter = (target: HTMLElement) => {
    if (first && options.initial === false) {
      first = false;
      return;
    }
    first = false;
    const animation = animate(target, options.enter, { ...options.transition, ...(reducedMotion() ? { duration: 0 } : {}) });
    cancel = () => animation.stop();
  };
  createEffect(source, (next) => {
    const ticket = ++generation;
    cancel();
    if (Object.is(next, untrack(current))) {
      if (element && next !== undefined) enter(element);
      return;
    }
    if (!element || reducedMotion() || Object.keys(options.exit).length === 0) {
      setCurrent(() => next);
      return;
    }
    const animation = animate(element, options.exit, options.transition);
    cancel = () => animation.stop();
    void animation.then(() => {
      if (ticket !== generation) return;
      element = undefined;
      setCurrent(() => next);
    });
  });
  onCleanup(() => {
    generation++;
    cancel();
  });
  return {
    current,
    ref: (next: HTMLElement) => {
      onSettled(() => {
        element = next;
        enter(next);
      });
    },
  };
}

export function Presence<T>(props: Options & { value: T | undefined; children: (value: T, ref: (element: HTMLElement) => void) => JSX.Element }) {
  const presence = createPresence(() => props.value, props);
  const shown = createMemo(() => {
    const value = presence.current();
    return value === undefined ? undefined : { value };
  });
  return (
    <Show when={shown()} keyed>
      {(entry) => props.children(entry.value, presence.ref)}
    </Show>
  );
}
