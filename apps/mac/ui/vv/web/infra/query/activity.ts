import type { QueryClient } from "./cache";

export function waitForReads(client: Pick<QueryClient, "fetching" | "subscribeActivity">, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let stop = () => {};
    const done = () => {
      stop();
      signal.removeEventListener("abort", done);
      resolve();
    };
    const check = () => {
      if (client.fetching() === 0 || signal.aborted) done();
    };
    stop = client.subscribeActivity(check);
    signal.addEventListener("abort", done, { once: true });
    check();
  });
}
