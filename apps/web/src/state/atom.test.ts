import { children, createRenderEffect, createRoot, flush, untrack } from "solid-js";
import type * as solid from "solid-js";
import { expect, test, vi } from "vite-plus/test";

import { createFrames, type Frames, frames, FramesContext, type FramesSource, useCore, useFrames } from "#/infra/frame.ts";
import { createQueryClient, refetchOnRelink } from "#/infra/query.ts";
import { frameAt, testFrames } from "#/infra/testing.ts";

import {
  createRegistry,
  defineAtom,
  framesIn,
  framesSource,
  pageRegistry,
  type Registry,
  RegistryContext,
  subscribeFrames,
  usePageAtom,
  useRegistry,
} from "./atom";

vi.mock("solid-js", () => vi.importActual<typeof solid>("../../node_modules/solid-js/dist/solid.js"));

function registryFramesSource(registry: Registry): FramesSource {
  return {
    get: () => framesIn(registry),
    subscribe: (listener) => subscribeFrames(registry, () => listener()),
  };
}

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

test("a custom FramesSource in RegistryContext drives createFrames and refetchOnRelink without opening the global stream", () => {
  const globalSubscribe = vi.spyOn(frames, "subscribe");
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const first = testFrames({ frame: frameAt(1), link: "open", count: 1 });
  const second = testFrames({ frame: frameAt(10), link: "open", count: 10 });
  const registry = createRegistry();
  registry.set(framesSource, first.source);

  const client = createQueryClient();
  const invalidate = vi.spyOn(client, "invalidate");
  let stopRelink = () => {};
  let dispose = () => {};
  let direct: Frames | undefined;
  let scoped: Frames | undefined;
  let core: ReturnType<typeof useCore> = () => undefined;

  try {
    createRoot((stop) => {
      dispose = stop;
      const content = RegistryContext({
        value: registry,
        get children() {
          const source = registryFramesSource(useRegistry());
          const store = untrack(() => createFrames(source));
          direct = untrack(() => createFrames(first.source));
          stopRelink = refetchOnRelink(source, client);
          return FramesContext({
            value: store,
            get children() {
              scoped = useFrames();
              core = useCore();
              return undefined;
            },
          });
        },
      });
      const rendered = children(() => content);
      createRenderEffect(rendered, () => {});
    });
    flush();

    expect(scoped?.frame?.seq).toBe(1);
    expect(scoped?.link).toBe("open");
    expect(scoped?.count).toBe(1);
    expect(core()?.call).toBe("idle");
    expect(direct?.frame?.seq).toBe(1);

    first.set({ frame: frameAt(2), link: "lost", count: 2 });
    flush();
    expect(scoped?.frame?.seq).toBe(2);
    expect(scoped?.link).toBe("lost");
    expect(direct?.frame?.seq).toBe(2);
    expect(invalidate).not.toHaveBeenCalled();

    registry.set(framesSource, second.source);
    flush();
    expect(scoped?.frame?.seq).toBe(10);
    expect(scoped?.link).toBe("open");
    expect(scoped?.count).toBe(10);
    expect(invalidate).toHaveBeenCalledOnce();

    first.set({ frame: frameAt(99), link: "lost", count: 99 });
    flush();
    expect(scoped?.frame?.seq).toBe(10);
    expect(direct?.frame?.seq).toBe(99);

    second.set({ link: "lost" });
    second.set({ frame: frameAt(11), link: "open", count: 11 });
    flush();
    expect(scoped?.frame?.seq).toBe(11);
    expect(invalidate).toHaveBeenCalledTimes(2);

    expect(globalSubscribe).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(pageRegistry.get(framesSource)).toBe(frames);
  } finally {
    stopRelink();
    dispose();
    client.dispose();
    fetchSpy.mockRestore();
    globalSubscribe.mockRestore();
  }
});
