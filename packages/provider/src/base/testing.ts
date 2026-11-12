/** A fetch answered by handler, which sees the Request the call would send: method, URL, headers, body, redirect and signal. */
export const answering =
  (handler: (request: Request) => Response | Promise<Response>): typeof fetch =>
  async (input, init) =>
    handler(new Request(input, init));

/** A fetch that never answers: `started` once it is called, `stopped` once the caller aborts it. */
export function hanging() {
  const started = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const seen = { calls: 0, stopped: false };
  const fetcher: typeof fetch = (_input, init) => {
    seen.calls++;
    started.resolve();
    init?.signal?.addEventListener(
      "abort",
      () => {
        seen.stopped = true;
        stopped.resolve();
      },
      { once: true },
    );
    return new Promise<Response>(() => undefined);
  };
  return { fetch: fetcher, started: started.promise, stopped: stopped.promise, seen };
}

/** A fetch that must not be called. */
export const unreachable: typeof fetch = () => {
  throw new Error("Unexpected network request");
};

/** The JSON text of value, as a test writes a body. */
export const json = (value: unknown): string => JSON.stringify(value);

/** What p failed with; fails itself when p succeeded. */
export const failure = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => {
      throw new Error("Expected a failure");
    },
    (e: unknown) => e,
  );

/** Everything an error shows when logged or serialized: to check that nothing secret is in it. */
export const shown = (e: unknown): string => `${String(e)} ${JSON.stringify(e)} ${e instanceof Error ? (e.stack ?? "") : ""}`;
