import "./polyfill";
import { host } from "nsh";
import { afterEach, describe, expect, test } from "nsh/test";

import { useBridge } from "./bridged";
import { setTransport, transport } from "./transport";

const origAvailable = Object.getOwnPropertyDescriptor(host, "available");
const origOn = Object.getOwnPropertyDescriptor(host, "on");
const origPost = Object.getOwnPropertyDescriptor(host, "post");
const origConsoleError = console.error;
const origTransport = transport();

function installMockHost() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const posts: { name: string; data: unknown }[] = [];

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

  const emit = async (event: string, payload: unknown) => {
    await Promise.resolve();
    await Promise.resolve();
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) fn(payload);
  };

  return { emit, posts };
}

afterEach(() => {
  setTransport(origTransport);
  console.error = origConsoleError;
  if (origAvailable) Object.defineProperty(host, "available", origAvailable);
  if (origOn) Object.defineProperty(host, "on", origOn);
  if (origPost) Object.defineProperty(host, "post", origPost);
});

describe("infra/bridged", () => {
  test("reports structured diagnostics via console.error when slice or live frames fail Zod decoding", async () => {
    const fake = installMockHost();
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };

    useBridge();

    const receivedSlices: unknown[] = [];
    const stopSlice = transport().slice("board", (data) => {
      receivedSlices.push(data);
    });
    const receivedLive: unknown[] = [];
    const stopLive = transport().live((event) => {
      receivedLive.push(event);
    });

    try {
      // Valid frames pass through with zero errors.
      await fake.emit("frame:slice:board", { rev: 1, data: { seq: 1, issues: [] } });
      expect(receivedSlices).toHaveLength(1);
      expect(logged).toHaveLength(0);

      // Malformed slice frame is dropped but emits a structured diagnostic instead of failing silently.
      await fake.emit("frame:slice:board", { rev: 2, data: { seq: "bad-seq", issues: "not-an-array" } });
      expect(receivedSlices).toHaveLength(1);
      expect(logged).toHaveLength(1);
      expect(String(logged[0]?.[0])).toContain("slice frame (board)");
      expect(logged[0]?.[1]).toMatchObject({
        channel: "slice",
        target: "board",
      });
      const sliceMeta = logged[0]?.[1] as { payloadSummary?: string; issues?: string };
      expect(sliceMeta.payloadSummary).toContain("seq,issues");
      expect(sliceMeta.issues).toContain("seq");

      // Malformed live frame is dropped and emits a structured diagnostic with event summary.
      await fake.emit("frame:live", { rev: 1, data: { _tag: "bogusEvent", extra: 42 } });
      expect(receivedLive).toHaveLength(0);
      expect(logged).toHaveLength(2);
      expect(String(logged[1]?.[0])).toContain("live frame (live)");
      const liveMeta = logged[1]?.[1] as { channel?: string; target?: string; payloadSummary?: string; issues?: string };
      expect(liveMeta.channel).toBe("live");
      expect(liveMeta.payloadSummary).toContain("tag=bogusEvent");
      expect(liveMeta.issues && liveMeta.issues.length > 0).toBe(true);
    } finally {
      stopSlice();
      stopLive();
    }
  });
});
