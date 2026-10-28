// Renders a component into the page for one test, and settles Solid's queued updates after each step.

import { render } from "@solidjs/web";
import type { JSX } from "@solidjs/web";
import { flush } from "solid-js";
import { afterEach, expect } from "vite-plus/test";

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

/** No axe violation in the page as it is now (the open popup included). */
export async function expectAccessible() {
  const axe = (await import("axe-core")).default;
  // region (all content in landmarks) is the page's to keep: a popup portaled to the body is outside any by design.
  const { violations } = await axe.run(document.body, { rules: { region: { enabled: false } } });
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`)).toEqual([]);
}
