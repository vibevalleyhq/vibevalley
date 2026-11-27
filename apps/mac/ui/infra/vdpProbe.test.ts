import "./polyfill";
import { host, type ViewRef } from "nsh";
import { afterEach, describe, expect, open, test } from "nsh/test";

import { installVdpProbe, isVdpEnabled, registerVdpNode } from "./vdpProbe";

const origParams = Object.getOwnPropertyDescriptor(host, "params");
const origAvailable = Object.getOwnPropertyDescriptor(host, "available");
const origOn = Object.getOwnPropertyDescriptor(host, "on");
const origPost = Object.getOwnPropertyDescriptor(host, "post");

const NOW = 1_764_000_000_000;

interface VdpUiResMsg {
  readonly type: "vdp_ui_res";
  readonly reqId: string;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

interface VdpUiLogMsg {
  readonly type: "vdp_ui_log";
  readonly view: string;
  readonly level: string;
  readonly message: string;
  readonly time: number;
}

function createFakeHost(params: Record<string, unknown>) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const posts: { name: string; data: unknown }[] = [];

  Object.defineProperty(host, "params", { configurable: true, enumerable: true, writable: true, value: params });
  Object.defineProperty(host, "available", { configurable: true, enumerable: true, writable: true, value: () => true });
  Object.defineProperty(host, "on", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: (event: string, listener: (payload: unknown) => void) => {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
      return () => {
        set?.delete(listener);
      };
    },
  });
  Object.defineProperty(host, "post", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: (name: string, data: unknown) => {
      posts.push({ name, data });
    },
  });

  const drainMicrotasks = async (rounds = 8) => {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
    }
  };

  const emit = async (event: string, payload: unknown) => {
    await drainMicrotasks(2);
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) fn(payload);
    await drainMicrotasks(10);
  };

  const responses = (): VdpUiResMsg[] =>
    posts
      .filter((p) => p.name === "action" && typeof p.data === "object" && p.data !== null && (p.data as { type?: unknown }).type === "vdp_ui_res")
      .map((p) => p.data as VdpUiResMsg);

  const logs = (): VdpUiLogMsg[] =>
    posts
      .filter((p) => p.name === "action" && typeof p.data === "object" && p.data !== null && (p.data as { type?: unknown }).type === "vdp_ui_log")
      .map((p) => p.data as VdpUiLogMsg);

  return { listeners, posts, emit, drainMicrotasks, responses, logs };
}

let activeDispose: (() => void) | undefined;

afterEach(() => {
  activeDispose?.();
  activeDispose = undefined;
  if (origParams) Object.defineProperty(host, "params", origParams);
  if (origAvailable) Object.defineProperty(host, "available", origAvailable);
  if (origOn) Object.defineProperty(host, "on", origOn);
  if (origPost) Object.defineProperty(host, "post", origPost);
});

describe("infra/vdpProbe", () => {
  test("stays completely inert with zero listeners when vdpEnabled is not set", async () => {
    const fake = createFakeHost({ view: "vibevalley" });
    activeDispose = installVdpProbe();
    await fake.drainMicrotasks();

    expect(isVdpEnabled()).toBe(false);
    expect(fake.listeners.size).toBe(0);

    const unregister = registerVdpNode({ testId: "ignored-node", role: "button", onPress: () => {} });
    unregister();

    await fake.emit("vdp_ui_req", { type: "vdp_ui_req", reqId: "r-0", method: "UI.query", params: {} });
    expect(fake.responses()).toHaveLength(0);
  });

  test("answers UI.getTree, UI.query (with bounds), and UI.press cleanly when enabled", async () => {
    const fake = createFakeHost({ view: "vibevalley", vdpEnabled: true });
    activeDispose = installVdpProbe();
    await fake.drainMicrotasks();

    expect(isVdpEnabled()).toBe(true);
    let pressedCount = 0;

    const fakeRef = {
      measure: async () => ({ bounds: { origin: { x: 0, y: 0 }, size: { width: 64, height: 48 } }, pagePosition: { x: 8, y: 120 } }),
    } as unknown as ViewRef;

    const offPage = registerVdpNode({
      testId: "workbench-page",
      role: "main",
      route: "/issues",
      source: "apps/mac/ui/app/Workbench.tsx",
    });
    const offPlace = registerVdpNode({
      testId: "place-library",
      role: "link",
      text: "Library",
      route: "/library",
      source: "apps/mac/ui/app/Shell.tsx",
      parentId: "workbench-page",
      getRef: () => fakeRef,
      onPress: () => {
        pressedCount += 1;
      },
    });

    await fake.emit("vdp_ui_req", { type: "vdp_ui_req", reqId: "tree-1", method: "UI.getTree", params: { maxDepth: 4 } });
    const treeRes = fake.responses().find((r) => r.reqId === "tree-1");
    expect(treeRes?.error).toBeUndefined();
    const treeData = treeRes?.result as {
      view: string;
      nodes: { testId: string; source?: string; children?: { testId: string; source?: string; children?: { testId: string; source?: string }[] }[] }[];
    };
    expect(treeData.view).toBe("vibevalley");
    expect(treeData.nodes[0]?.testId).toBe("view:vibevalley");
    const pageNode = treeData.nodes[0]?.children?.find((c) => c.testId === "workbench-page");
    expect(pageNode?.source).toBe("apps/mac/ui/app/Workbench.tsx");
    expect(pageNode?.children?.map((c) => c.testId)).toContain("place-library");
    expect(pageNode?.children?.find((c) => c.testId === "place-library")?.source).toBe("apps/mac/ui/app/Shell.tsx");

    await fake.emit("vdp_ui_req", { type: "vdp_ui_req", reqId: "q-1", method: "UI.query", params: { text: "lib" } });
    const queryRes = fake.responses().find((r) => r.reqId === "q-1");
    const queryData = queryRes?.result as {
      count: number;
      nodes: { testId: string; source?: string; bounds?: { x: number; y: number; width: number; height: number } }[];
    };
    expect(queryData.count).toBe(1);
    expect(queryData.nodes[0]?.testId).toBe("place-library");
    expect(queryData.nodes[0]?.source).toBe("apps/mac/ui/app/Shell.tsx");
    expect(queryData.nodes[0]?.bounds).toEqual({ x: 8, y: 120, width: 64, height: 48 });

    await fake.emit("vdp_ui_req", { type: "vdp_ui_req", reqId: "p-1", method: "UI.press", params: { testId: "place-library" } });
    const pressRes = fake.responses().find((r) => r.reqId === "p-1");
    expect(pressRes?.error).toBeUndefined();
    expect(pressRes?.result).toMatchObject({ pressed: true, testId: "place-library", bounds: { x: 8, y: 120, width: 64, height: 48 } });
    expect(pressedCount).toBe(1);

    await fake.emit("vdp_ui_req", { type: "vdp_ui_req", reqId: "p-missing", method: "UI.press", params: { testId: "does-not-exist" } });
    const missingRes = fake.responses().find((r) => r.reqId === "p-missing");
    expect(missingRes?.error?.code).toBe(-32000);

    await fake.emit("vdp_ui_req", { type: "vdp_ui_req", reqId: "p-nonpress", method: "UI.press", params: { testId: "workbench-page" } });
    const nonPressRes = fake.responses().find((r) => r.reqId === "p-nonpress");
    expect(nonPressRes?.error?.code).toBe(-32000);

    offPlace();
    offPage();
  });

  test("UI.waitFor resolves immediately when present and times out cleanly under virtual clock", async () => {
    const app = await open("../ShellApp.story.tsx", {
      width: 960,
      height: 640,
      colorScheme: "light",
      platform: "macos",
      clock: { time: NOW },
      host: { params: { view: "devtools", locale: "en", vdpEnabled: true }, handlers: { action: null, ready: null } },
    });
    const clock = app.clock;
    if (!clock) throw new Error("virtual clock required");

    const responses = () =>
      app.host
        .posts()
        .filter((p) => p.name === "action" && typeof p.data === "object" && p.data !== null && (p.data as { type?: unknown }).type === "vdp_ui_res")
        .map((p) => p.data as VdpUiResMsg);

    await app.host.send("vdp_ui_req", { type: "vdp_ui_req", reqId: "w-root", method: "UI.waitFor", params: { testId: "view:devtools", timeoutMs: 1_000 } });
    await app.waitUntil(() => responses().some((r) => r.reqId === "w-root"));
    const rootRes = responses().find((r) => r.reqId === "w-root");
    expect(rootRes?.error).toBeUndefined();
    expect(rootRes?.result).toMatchObject({ matched: true, view: "devtools" });

    await app.host.send("vdp_ui_req", { type: "vdp_ui_req", reqId: "w-timeout", method: "UI.waitFor", params: { testId: "never-arrives", timeoutMs: 120 } });
    await clock.fastForward(200);
    await app.waitUntil(() => responses().some((r) => r.reqId === "w-timeout"));
    const timeoutRes = responses().find((r) => r.reqId === "w-timeout");
    expect(timeoutRes?.error?.code).toBe(-32001);
  });

  test("vdp_ui_config toggles opt-in console forwarding and restores console when disabled", async () => {
    const fake = createFakeHost({ view: "devtools", vdpEnabled: true });
    const origWarn = console.warn;
    activeDispose = installVdpProbe();
    await fake.drainMicrotasks();

    expect(console.warn === origWarn).toBe(true);

    await fake.emit("vdp_ui_config", { type: "vdp_ui_config", logEnabled: true });
    expect(console.warn === origWarn).toBe(false);
    console.warn("vdp probe warning", { code: 7 });
    expect(fake.logs().some((entry) => entry.level === "warn" && entry.view === "devtools" && entry.message.includes("vdp probe warning"))).toBe(true);

    await fake.emit("vdp_ui_config", { type: "vdp_ui_config", logEnabled: false });
    expect(console.warn === origWarn).toBe(true);
  });
});
