// Renders a component into the page for one test, and settles Solid's queued updates after each step.

import { render } from "@solidjs/web";
import type { JSX } from "@solidjs/web";
import { flush } from "solid-js";
import { afterEach } from "vite-plus/test";

const mounted: (() => void)[] = [];

afterEach(() => {
  for (const dispose of mounted.splice(0)) dispose();
  document.body.innerHTML = "";
});

export function mount(view: () => JSX.Element) {
  const host = document.createElement("div");
  document.body.append(host);
  mounted.push(render(view, host));
  flush();
  return host;
}

/** Lets queued updates and effects run (after a click, a key, a timer). */
export const settle = async () => {
  flush();
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  flush();
};

export const $ = <T extends Element = HTMLElement>(selector: string) => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`nothing matches ${selector}`);
  return el;
};
