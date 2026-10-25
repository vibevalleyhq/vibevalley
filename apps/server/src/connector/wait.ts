export type WaitResult = "timeout" | "wake" | "aborted";

export const waitFor = (ms: number, signal: AbortSignal, register: (wake: () => void) => void): Promise<WaitResult> =>
  new Promise<WaitResult>((resolve, reject) => {
    if (signal.aborted) {
      resolve("aborted");
      return;
    }
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const finish = (result: WaitResult) => {
      if (settled) return;
      cleanup();
      resolve(result);
    };
    const timer = setTimeout(() => finish("timeout"), Math.max(0, ms));
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

export const sleep = async (ms: number, signal: AbortSignal): Promise<boolean> => (await waitFor(ms, signal, () => undefined)) === "timeout";
