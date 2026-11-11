import { abortError, reasonOf } from "./abort.ts";

/**
 * What a full queue does with one more: `unbounded` keeps all; `sliding` drops the oldest (a wake that only says
 * "look again" never needs more than one); `dropping` drops the new one.
 */
export type Overflow = "unbounded" | "sliding" | "dropping";

export interface QueueOptions {
  readonly capacity?: number;
  readonly overflow?: Overflow;
}

/** A queue of values for one reader at a time: offer never waits; take waits for a value, the queue's end, or the signal. */
export class Queue<A> implements AsyncIterable<A> {
  readonly #items: A[] = [];
  readonly #takers: { resolve: (a: IteratorResult<A>) => void; reject: (e: unknown) => void }[] = [];
  readonly #capacity: number;
  readonly #overflow: Overflow;
  #ended = false;

  constructor(options: QueueOptions = {}) {
    this.#overflow = options.overflow ?? "unbounded";
    this.#capacity = this.#overflow === "unbounded" ? Number.POSITIVE_INFINITY : Math.max(1, options.capacity ?? 1);
  }

  get size(): number {
    return this.#items.length;
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** Whether a was kept: false once the queue ended, or when `dropping` and full. */
  offer(a: A): boolean {
    if (this.#ended) return false;
    const taker = this.#takers.shift();
    if (taker) {
      taker.resolve({ value: a, done: false });
      return true;
    }
    if (this.#items.length >= this.#capacity) {
      if (this.#overflow === "dropping") return false;
      this.#items.shift();
    }
    this.#items.push(a);
    return true;
  }

  /** The next value, or done once the queue ended and is empty. */
  next(signal?: AbortSignal): Promise<IteratorResult<A>> {
    if (this.#items.length > 0) return Promise.resolve({ value: this.#items.shift()!, done: false });
    if (this.#ended) return Promise.resolve({ value: undefined, done: true });
    if (signal?.aborted === true) return Promise.reject(reasonOf(signal));
    const { promise, resolve, reject } = Promise.withResolvers<IteratorResult<A>>();
    const taker = { resolve, reject };
    this.#takers.push(taker);
    if (signal) {
      const onAbort = () => {
        const at = this.#takers.indexOf(taker);
        if (at >= 0) this.#takers.splice(at, 1);
        reject(reasonOf(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void promise.then(
        () => signal.removeEventListener("abort", onAbort),
        () => signal.removeEventListener("abort", onAbort),
      );
    }
    return promise;
  }

  /** The next value; rejects once the queue ended and is empty. */
  async take(signal?: AbortSignal): Promise<A> {
    const r = await this.next(signal);
    if (r.done === true) throw abortError("the queue ended");
    return r.value;
  }

  /** Everything waiting now, without waiting. */
  takeAll(): A[] {
    return this.#items.splice(0);
  }

  /** No more offers; readers get what is left, then the end. */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const t of this.#takers.splice(0)) t.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<A> {
    return { next: () => this.next(), return: () => Promise.resolve({ value: undefined, done: true }) };
  }
}
