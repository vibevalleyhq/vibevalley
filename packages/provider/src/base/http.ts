import { abortable, anySignal, type Clock, systemClock, timeoutError } from "@vibevalley/async";

/** What a vendor call goes out through: the caller's fetch (so a test can answer it), an optional signal to stop it, and the
 * clock its deadline is measured on (the system clock by default). */
export interface ProviderHttp {
  readonly fetch: typeof fetch;
  readonly signal?: AbortSignal;
  readonly clock?: Clock;
}

/** The connection or the reading of its body failed, as opposed to an answer coming back. */
export class ProviderTransportError extends Error {
  override readonly name = "ProviderTransportError";
  constructor(cause: unknown) {
    super("The vendor could not be reached", { cause });
  }
}

/** A signal that aborts at ms on the clock, or when the caller's signal does; `expired` tells the two apart. */
export class Deadline {
  readonly signal: AbortSignal;
  #expired = false;
  readonly #stop = new AbortController();

  constructor(ms: number, http: { readonly signal?: AbortSignal; readonly clock?: Clock }) {
    const timer = new AbortController();
    this.signal = anySignal(http.signal, timer.signal);
    void (http.clock ?? systemClock).sleep(ms, this.#stop.signal).then(
      () => {
        this.#expired = true;
        timer.abort(timeoutError(ms));
      },
      // Stopped by `stop`: the call ended first.
      () => undefined,
    );
  }

  get expired(): boolean {
    return this.#expired;
  }

  stop(): void {
    this.#stop.abort();
  }
}

/** work under a deadline of ms: a timeout and a transport failure become the caller's own errors; the caller's abort and
 * every other failure go through as they are. */
export async function bounded<A>(
  ms: number,
  http: ProviderHttp,
  work: (signal: AbortSignal) => Promise<A>,
  fail: { readonly timeout: () => Error; readonly network: () => Error },
): Promise<A> {
  const deadline = new Deadline(ms, http);
  try {
    return await work(deadline.signal);
  } catch (e) {
    if (deadline.expired) throw fail.timeout();
    if (e instanceof ProviderTransportError) throw fail.network();
    throw e;
  } finally {
    deadline.stop();
  }
}

/** fetch, its failure a ProviderTransportError unless signal aborted it; a fetch that ignores the signal still stops being
 * waited on. */
export async function send(http: ProviderHttp, url: string | URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
  try {
    return await abortable(http.fetch(url, { ...init, signal }), signal);
  } catch (e) {
    if (signal.aborted) throw e;
    throw new ProviderTransportError(e);
  }
}

/** The body's chunks as they come; leaving early, failing or aborting cancels the body. */
export async function* bodyChunks(response: Response, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  if (response.body === null) return;
  const reader = response.body.getReader();
  let done = false;
  try {
    for (;;) {
      let read: Awaited<ReturnType<typeof reader.read>>;
      try {
        read = await abortable(reader.read(), signal);
      } catch (e) {
        if (signal.aborted) throw e;
        throw new ProviderTransportError(e);
      }
      if (read.done) {
        done = true;
        return;
      }
      yield read.value;
    }
  } finally {
    if (!done)
      await reader.cancel().catch(
        // The body is given up either way; a source that fails to cancel changes nothing for the caller.
        () => undefined,
      );
    reader.releaseLock();
  }
}

/** Bytes cut into slices of at most size, so a limit checked per slice is not overshot by one huge chunk. */
function* slices(bytes: Uint8Array, size = 65536): Generator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += size) yield bytes.subarray(offset, offset + size);
}

/** Text from bytes, decoded across chunk boundaries. */
export async function* decodeText(source: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  for await (const chunk of source) {
    const text = decoder.decode(chunk, { stream: true });
    if (text !== "") yield text;
  }
  const rest = decoder.decode();
  if (rest !== "") yield rest;
}

/** The value of a header without its parameters, lower-cased: "text/event-stream; charset=utf-8" is "text/event-stream". */
export const mediaType = (headers: Headers, name = "content-type"): string | undefined => headers.get(name)?.split(";")[0]?.trim().toLowerCase();

/** The bytes of a body, each chunk cut to at most 64 KiB, failing with tooLarge() once more than maxBytes came. */
export async function* boundedBody(response: Response, signal: AbortSignal, maxBytes: number, tooLarge: () => Error): AsyncGenerator<Uint8Array> {
  let bytes = 0;
  for await (const chunk of bodyChunks(response, signal)) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw tooLarge();
    yield* slices(chunk);
  }
}
