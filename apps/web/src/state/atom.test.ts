import { children, createRenderEffect, createRoot, flush } from "solid-js";
import type * as solid from "solid-js";
import { expect, test, vi } from "vite-plus/test";

import { createRegistry, defineAtom, pageRegistry, RegistryContext, usePageAtom } from "./atom";

vi.mock("solid-js", () => vi.importActual<typeof solid>("../../node_modules/solid-js/dist/solid.js"));

test("defineAtom stays idle at module definition and isolates state per registry", () => {
  const count = defineAtom(0);
  const first = count.inRegistry(createRegistry());
  const second = count.inRegistry(createRegistry());

  const seenFirst = vi.fn();
  const off = first.subscribe(seenFirst);
  first.set(3);
  second.update((n) => n + 10);

  expect(first.get()).toBe(3);
  expect(second.get()).toBe(10);
  expect(count.get()).toBe(0);
  expect(seenFirst).toHaveBeenCalledTimes(1);
  expect(count.inRegistry(pageRegistry)).toBe(count);
  off();
});

test("usePageAtom and get() follow an enclosing RegistryContext without touching pageRegistry", () => {
  const shared = defineAtom("page");
  const custom = createRegistry();
  let dispose = () => {};
  let observed = "";
  let scopedValue = "";

  createRoot((stop) => {
    dispose = stop;
    const content = RegistryContext({
      value: custom,
      get children() {
        const scoped = usePageAtom(shared);
        scoped.set("isolated");
        scopedValue = scoped.get();
        observed = shared.get();
        return undefined;
      },
    });
    const rendered = children(() => content);
    createRenderEffect(rendered, () => {});
  });
  flush();
  dispose();

  expect(scopedValue).toBe("isolated");
  expect(observed).toBe("isolated");
  expect(shared.get()).toBe("page");
});
