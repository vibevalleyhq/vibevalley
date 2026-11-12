import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { abortable, isAbort } from "./abort.ts";
import { sleep } from "./clock.ts";
import { Hub } from "./hub.ts";
import { Queue } from "./queue.ts";
import { exponential, retry, withTimeout } from "./retry.ts";
import { Semaphore } from "./semaphore.ts";
import { collect, lines, mapConcurrent, merge } from "./streams.ts";
import { TaskGroup } from "./tasks.ts";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("a task group", () => {
  test("closing aborts every task and waits for each to end", async () => {
    const group = new TaskGroup({ name: "test" });
    const ended: string[] = [];
    for (const name of ["a", "b"])
      group.run(name, async (signal) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        await turn();
        ended.push(name);
      });
    expect(group.size).toBe(2);
    await turn();
    await group.close();
    expect(ended.toSorted()).toEqual(["a", "b"]);
    expect(group.size).toBe(0);
  });

  test("a task stopped before its turn to start does not run", async () => {
    const group = new TaskGroup({ name: "test" });
    let ran = false;
    const task = group.spawn("t", async () => {
      ran = true;
    });
    await task.abort();
    expect(ran).toBe(false);
    await group.close();
  });

  test("a closed group starts nothing", async () => {
    const group = new TaskGroup({ name: "test" });
    await group.close();
    let ran = false;
    const task = group.spawn("late", async () => {
      ran = true;
    });
    await expect(task.result).rejects.toSatisfy((e: unknown) => isAbort(e));
    expect(ran).toBe(false);
  });

  test("a failed background task is reported, an aborted one is not", async () => {
    const errors: string[] = [];
    const group = new TaskGroup({ name: "test", onError: (task, e) => errors.push(`${task}: ${String(e)}`) });
    group.run("bad", async () => {
      throw new Error("boom");
    });
    group.run("stopped", (signal) => sleep(10_000, signal));
    await turn();
    await group.close();
    expect(errors).toEqual(["bad: Error: boom"]);
  });

  test("a keyed task replaces the one under its key once that one has ended", async () => {
    const group = new TaskGroup({ name: "test" });
    const said: string[] = [];
    group.keyed("k", async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      said.push("first ended");
    });
    const second = group.keyed("k", async () => {
      said.push("second started");
    });
    await second.done;
    expect(said).toEqual(["first ended", "second started"]);
    expect(group.has("k")).toBe(false);
    await group.close();
  });

  test("the parent's abort closes the group", async () => {
    const parent = new AbortController();
    const group = new TaskGroup({ name: "test", parent: parent.signal });
    const task = group.spawn("t", (signal) => sleep(10_000, signal));
    parent.abort();
    await expect(task.result).rejects.toSatisfy((e: unknown) => isAbort(e, task.signal));
  });
});

describe("a queue", () => {
  test("a taker waits for a value, and the end ends it", async () => {
    const q = new Queue<number>();
    const first = q.take();
    q.offer(1);
    expect(await first).toBe(1);
    q.offer(2);
    q.end();
    expect(await collect(q)).toEqual([2]);
    expect(q.offer(3)).toBe(false);
  });

  test("sliding keeps the newest, dropping the oldest", () => {
    const sliding = new Queue<number>({ capacity: 1, overflow: "sliding" });
    sliding.offer(1);
    sliding.offer(2);
    expect(sliding.takeAll()).toEqual([2]);
    const dropping = new Queue<number>({ capacity: 1, overflow: "dropping" });
    dropping.offer(1);
    expect(dropping.offer(2)).toBe(false);
    expect(dropping.takeAll()).toEqual([1]);
  });

  test("an aborted take leaves the next value for the next taker", async () => {
    const q = new Queue<number>();
    const controller = new AbortController();
    const waiting = q.take(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toSatisfy((e: unknown) => isAbort(e, controller.signal));
    q.offer(7);
    expect(await q.take()).toBe(7);
  });
});

describe("a hub", () => {
  test("each subscription hears what is published after it, and closing stops it", async () => {
    const hub = new Hub<string>();
    hub.publish("before");
    const a = hub.subscribe();
    const b = hub.subscribe();
    hub.publish("one");
    b.close();
    hub.publish("two");
    hub.end();
    expect(await collect(a)).toEqual(["one", "two"]);
    expect(await collect(b)).toEqual(["one"]);
    expect(hub.subscribers).toBe(0);
  });
});

describe("a semaphore", () => {
  test("takers wait their turn, first come first served", async () => {
    const s = new Semaphore(1);
    const order: string[] = [];
    const a = s.with(async () => {
      await turn();
      order.push("a");
    });
    const b = s.with(async () => {
      order.push("b");
    });
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
    expect(s.available).toBe(1);
  });

  test("an aborted taker gives up its place", async () => {
    const s = new Semaphore(1);
    await s.take();
    const controller = new AbortController();
    const waiting = s.take(1, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toSatisfy((e: unknown) => isAbort(e, controller.signal));
    s.release();
    expect(s.tryTake()).toBe(true);
  });
});

describe("time", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  test("retry waits its backoff between tries and gives up with the last failure", async () => {
    let tries = 0;
    const done = retry(
      async () => {
        tries++;
        throw new Error(`try ${tries}`);
      },
      { retries: 2, delay: exponential(100) },
    );
    const caught = done.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    expect(tries).toBe(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(tries).toBe(3);
    expect(String(await caught)).toBe("Error: try 3");
  });

  test("withTimeout aborts the task's signal and rejects with a TimeoutError", async () => {
    let seen: AbortSignal | undefined;
    const done = withTimeout((signal) => {
      seen = signal;
      return sleep(10_000, signal);
    }, 50).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(50);
    const e = await done;
    expect(e).toBeInstanceOf(DOMException);
    expect((e as DOMException).name).toBe("TimeoutError");
    expect(seen?.aborted).toBe(true);
  });

  test("abortable stops waiting once the signal aborts", async () => {
    const controller = new AbortController();
    const waiting = abortable(new Promise(() => undefined), controller.signal).catch((e: unknown) => e);
    controller.abort();
    expect(isAbort(await waiting, controller.signal)).toBe(true);
  });
});

describe("streams", () => {
  test("lines splits across chunks and keeps an unfinished last line", async () => {
    async function* chunks() {
      yield "a\r\nb";
      yield new TextEncoder().encode("c\nd");
    }
    expect(await collect(lines(chunks()))).toEqual(["a", "bc", "d"]);
  });

  test("merge gives every source's values and ends when all have", async () => {
    async function* from(...xs: number[]) {
      for (const x of xs) {
        await turn();
        yield x;
      }
    }
    expect((await collect(merge(from(1, 3), from(2)))).toSorted((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});

test("mapConcurrent keeps the order and at most n running", async () => {
  let running = 0;
  let most = 0;
  const out = await mapConcurrent([3, 1, 2, 4], 2, async (x) => {
    running++;
    most = Math.max(most, running);
    await turn();
    running--;
    return x * 10;
  });
  expect(out).toEqual([30, 10, 20, 40]);
  expect(most).toBe(2);
});
