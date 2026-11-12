import { reasonOf } from "./abort.ts";

/** n permits; a taker waits its turn (first come, first served). A lock is a semaphore of one. */
export class Semaphore {
  #free: number;
  readonly #waiting: { readonly n: number; readonly resolve: () => void; readonly reject: (e: unknown) => void }[] = [];

  constructor(permits: number) {
    this.#free = permits;
  }

  get available(): number {
    return this.#free;
  }

  /** Waits for n permits; they are the caller's to release. */
  take(n = 1, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(reasonOf(signal));
    if (this.#waiting.length === 0 && this.#free >= n) {
      this.#free -= n;
      return Promise.resolve();
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const waiter = { n, resolve, reject };
    this.#waiting.push(waiter);
    if (signal) {
      const onAbort = () => {
        const at = this.#waiting.indexOf(waiter);
        if (at < 0) return;
        this.#waiting.splice(at, 1);
        reject(reasonOf(signal));
        this.#drain();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void promise.then(
        () => signal.removeEventListener("abort", onAbort),
        () => signal.removeEventListener("abort", onAbort),
      );
    }
    return promise;
  }

  /** Takes n without waiting, or says it could not. */
  tryTake(n = 1): boolean {
    if (this.#waiting.length > 0 || this.#free < n) return false;
    this.#free -= n;
    return true;
  }

  release(n = 1): void {
    this.#free += n;
    this.#drain();
  }

  /** f holding n permits; they are given back however f ends. */
  async with<A>(f: () => Promise<A>, n = 1, signal?: AbortSignal): Promise<A> {
    await this.take(n, signal);
    try {
      return await f();
    } finally {
      this.release(n);
    }
  }

  #drain() {
    while (this.#waiting.length > 0 && this.#free >= this.#waiting[0]!.n) {
      const next = this.#waiting.shift()!;
      this.#free -= next.n;
      next.resolve();
    }
  }
}
