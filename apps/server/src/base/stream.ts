/** Raised when a stream exceeds its byte limit while reading. */
export class StreamTooLargeError extends Error {
  override readonly name = "StreamTooLargeError";
  readonly max: number;
  constructor(max: number) {
    super(`Stream exceeded ${max} bytes`);
    this.max = max;
  }
}

/** Options controlling bounded reads from a web ReadableStream. */
export interface StreamReadOptions {
  readonly signal?: AbortSignal;
}

/** Yields chunks from body up to maxBytes, throwing StreamTooLargeError if exceeded and canceling on early stop. */
export async function* streamBytesUpTo(body: ReadableStream<Uint8Array> | null, maxBytes: number, options: StreamReadOptions = {}): AsyncGenerator<Uint8Array> {
  if (body === null) return;
  const { signal } = options;
  const reader = body.getReader();
  const cancel = () => void Promise.allSettled([reader.cancel(signal?.reason)]);
  signal?.addEventListener("abort", cancel, { once: true });
  let size = 0;
  let finished = false;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) {
        finished = true;
        return;
      }
      if (!(value instanceof Uint8Array)) throw new TypeError("a response body gave something other than bytes");
      size += value.byteLength;
      if (size > maxBytes) throw new StreamTooLargeError(maxBytes);
      yield value;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!finished) await Promise.allSettled([reader.cancel(signal?.reason)]);
    reader.releaseLock();
  }
}

/** Reads body into a Buffer up to maxBytes, returning undefined once exceeded. */
export async function readBytesUpTo(body: ReadableStream<Uint8Array> | null, maxBytes: number, options: StreamReadOptions = {}): Promise<Buffer | undefined> {
  if (body === null) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of streamBytesUpTo(body, maxBytes, options)) chunks.push(chunk);
  } catch (e) {
    if (e instanceof StreamTooLargeError) return undefined;
    throw e;
  }
  return Buffer.concat(chunks);
}

/** Reads body as UTF-8 text up to maxBytes, returning undefined once exceeded. */
export async function readTextUpTo(body: ReadableStream<Uint8Array> | null, maxBytes: number, options: StreamReadOptions = {}): Promise<string | undefined> {
  const bytes = await readBytesUpTo(body, maxBytes, options);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}
