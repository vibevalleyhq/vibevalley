import { Queue, type QueueOptions } from "./queue.ts";

/** One reader of a hub: what was published after it subscribed, in order. Closing it (or `using`) stops it. */
export interface Subscription<A> extends AsyncIterable<A>, Disposable {
  readonly next: (signal?: AbortSignal) => Promise<IteratorResult<A>>;
  /** Everything waiting now, without waiting. */
  readonly drain: () => A[];
  /** How many are waiting. */
  readonly size: () => number;
  readonly close: () => void;
}

/** News for many readers: each subscription gets every value published after it subscribed (none before). */
export class Hub<A> {
  readonly #subscribers = new Set<Queue<A>>();
  #ended = false;

  get subscribers(): number {
    return this.#subscribers.size;
  }

  publish(a: A): void {
    for (const q of this.#subscribers) q.offer(a);
  }

  /** A reader from now on; options bound how far behind it may fall (default: keeps all). */
  subscribe(options?: QueueOptions): Subscription<A> {
    const queue = new Queue<A>(options);
    if (this.#ended) queue.end();
    else this.#subscribers.add(queue);
    const close = () => {
      this.#subscribers.delete(queue);
      queue.end();
    };
    return {
      next: (signal) => queue.next(signal),
      drain: () => queue.takeAll(),
      size: () => queue.size,
      close,
      [Symbol.dispose]: close,
      [Symbol.asyncIterator]: () => ({
        next: () => queue.next(),
        return: () => {
          close();
          return Promise.resolve({ value: undefined, done: true });
        },
      }),
    };
  }

  /** Every reader gets what is left, then the end; later subscriptions end at once. */
  end(): void {
    this.#ended = true;
    for (const q of this.#subscribers) q.end();
    this.#subscribers.clear();
  }
}
