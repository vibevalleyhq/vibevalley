import { describe, expect, it } from "vite-plus/test";
import { sleep, waitFor } from "./wait.ts";
import { wallTime } from "../base/time.ts";

describe("connector waits", () => {
  it("removes listeners after timeouts, wakes and aborts", async () => {
    const ended = new AbortController();
    const signal = ended.signal;
    let active = 0;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args: Parameters<typeof signal.addEventListener>) => {
      if (args[0] === "abort") active++;
      add(...args);
    };
    signal.removeEventListener = (...args: Parameters<typeof signal.removeEventListener>) => {
      if (args[0] === "abort") active--;
      remove(...args);
    };
    for (let i = 0; i < 20; i++) {
      expect(await sleep(wallTime, 0, signal)).toBe(true);
      expect(active).toBe(0);
    }
    for (let i = 0; i < 20; i++) {
      let wake = () => {};
      const waiting = waitFor(wallTime, 10_000, signal, (f) => {
        wake = f;
      });
      wake();
      expect(await waiting).toBe("wake");
      expect(active).toBe(0);
    }
    const waiting = waitFor(wallTime, 10_000, signal, () => undefined);
    ended.abort();
    expect(await waiting).toBe("aborted");
    expect(active).toBe(0);
    expect(await sleep(wallTime, 0, signal)).toBe(false);
    expect(active).toBe(0);
  });
});
