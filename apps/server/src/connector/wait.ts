import type { Time } from "../base/time.ts";

export type WaitResult = "timeout" | "wake" | "aborted";

/** On time: the service's for the farm's own waits, the wall clock for a protocol's (a login's polling interval). */
export const waitFor = (time: Time, ms: number, signal: AbortSignal, register: (wake: () => void) => void): Promise<WaitResult> =>
  new Promise<WaitResult>((resolve, reject) => {
    if (signal.aborted) {
      resolve("aborted");
      return;
    }
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      cancel();
      signal.removeEventListener("abort", abort);
    };
    const finish = (result: WaitResult) => {
      if (settled) return;
      cleanup();
      resolve(result);
    };
    const cancel = time.after(ms, () => finish("timeout"));
    const abort = () => finish("aborted");
    const wake = () => finish("wake");
    signal.addEventListener("abort", abort, { once: true });
    try {
      register(wake);
    } catch (e) {
      cleanup();
      reject(e);
      return;
    }
    if (signal.aborted) finish("aborted");
  });

export const sleep = async (time: Time, ms: number, signal: AbortSignal): Promise<boolean> => (await waitFor(time, ms, signal, () => undefined)) === "timeout";
