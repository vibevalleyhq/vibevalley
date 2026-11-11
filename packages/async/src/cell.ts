import { Hub, type Subscription } from "./hub.ts";

/** A value read now and followed as it changes: the current one first, then each change (a reader that falls behind
 * skips to the latest). */
export class Cell<A> {
  #value: A;
  readonly #changes = new Hub<A>();
  readonly #same: (a: A, b: A) => boolean;

  constructor(initial: A, same: (a: A, b: A) => boolean = Object.is) {
    this.#value = initial;
    this.#same = same;
  }

  get(): A {
    return this.#value;
  }

  /** Sets it; a value the same as the current one is no change and is not said. */
  set(a: A): void {
    if (this.#same(this.#value, a)) return;
    this.#value = a;
    this.#changes.publish(a);
  }

  update(f: (a: A) => A): A {
    this.set(f(this.#value));
    return this.#value;
  }

  /** The current value, then each change. */
  follow(): Subscription<A> {
    const sub = this.#changes.subscribe({ capacity: 1, overflow: "sliding" });
    const current = this.#value;
    let first = true;
    const next = (signal?: AbortSignal): Promise<IteratorResult<A>> => {
      if (first) {
        first = false;
        return Promise.resolve({ value: current, done: false });
      }
      return sub.next(signal);
    };
    return {
      next,
      drain: () => {
        const waiting = sub.drain();
        if (first) {
          first = false;
          return [current, ...waiting];
        }
        return waiting;
      },
      size: () => sub.size() + (first ? 1 : 0),
      close: sub.close,
      [Symbol.dispose]: sub.close,
      [Symbol.asyncIterator]: () => ({
        next: () => next(),
        return: () => {
          sub.close();
          return Promise.resolve({ value: undefined, done: true });
        },
      }),
    };
  }

  end(): void {
    this.#changes.end();
  }
}
