import { abortError, anySignal, isAbort, reasonOf } from "./abort.ts";

/** A task started in a group: it can be stopped, and its end awaited. */
export interface Task<A> {
  /** What the task returned; rejects with what it threw (an abort too). */
  readonly result: Promise<A>;
  /** Settles once the task has ended, however it ended; never rejects. */
  readonly done: Promise<void>;
  readonly signal: AbortSignal;
  /** Aborts the task and waits for it to end. */
  readonly abort: (reason?: unknown) => Promise<void>;
}

export interface TaskGroupOptions {
  /** Said with a failure, so a log line names who owned the task. */
  readonly name: string;
  /** The group closes when this aborts: a service's group under the farm's. */
  readonly parent?: AbortSignal;
  /** A background task (run, keyed) that failed with anything but an abort. Default: console.error. */
  readonly onError?: (task: string, error: unknown) => void;
}

/**
 * Owns background work: every task started here gets a signal that aborts when the group closes (or the task is
 * replaced or stopped), and close() waits for all of them to end. Nothing it starts outlives it.
 */
export class TaskGroup implements AsyncDisposable {
  readonly #controller = new AbortController();
  readonly #tasks = new Set<Task<unknown>>();
  readonly #keyed = new Map<string, Task<unknown>>();
  readonly #options: TaskGroupOptions;
  readonly signal: AbortSignal;

  constructor(options: TaskGroupOptions) {
    this.#options = options;
    this.signal = anySignal(this.#controller.signal, options.parent);
  }

  get closed(): boolean {
    return this.signal.aborted;
  }

  get size(): number {
    return this.#tasks.size;
  }

  /** Starts task now; its result is the caller's to await (a failure is not reported). A closed group runs nothing: the result rejects with an abort. */
  spawn<A>(name: string, task: (signal: AbortSignal) => Promise<A>): Task<A> {
    const controller = new AbortController();
    const signal = anySignal(controller.signal, this.signal);
    // It starts a turn later: a group closed (or the task stopped) before then runs nothing, rather than handing the task a signal already aborted.
    const result = Promise.resolve().then(() => {
      if (signal.aborted) throw reasonOf(signal);
      return task(signal);
    });
    const done = result.then(
      () => undefined,
      () => undefined,
    );
    const handle: Task<A> = {
      result,
      done,
      signal,
      abort: (reason?: unknown) => {
        controller.abort(reason ?? abortError(`${name} was stopped`));
        return done;
      },
    };
    this.#tasks.add(handle);
    void done.then(() => this.#tasks.delete(handle));
    return handle;
  }

  /** Starts a background task; a failure other than an abort is reported, never thrown. */
  run(name: string, task: (signal: AbortSignal) => Promise<unknown>): Task<unknown> {
    const handle = this.spawn(name, task);
    handle.result.catch((e: unknown) => {
      if (!isAbort(e, handle.signal)) this.#report(name, e);
    });
    return handle;
  }

  /** Starts a background task under key; one already there is aborted first, and this one starts once it has ended. */
  keyed(key: string, task: (signal: AbortSignal) => Promise<unknown>): Task<unknown> {
    const before = this.#keyed.get(key);
    const handle = this.run(key, async (signal) => {
      if (before !== undefined) await before.abort();
      if (signal.aborted) return;
      return task(signal);
    });
    this.#keyed.set(key, handle);
    void handle.done.then(() => {
      if (this.#keyed.get(key) === handle) this.#keyed.delete(key);
    });
    return handle;
  }

  /** Whether a task runs under key. */
  has(key: string): boolean {
    return this.#keyed.has(key);
  }

  /** Aborts the task under key, if one runs, and waits for it to end. */
  async stop(key: string): Promise<void> {
    await this.#keyed.get(key)?.abort();
  }

  /** Aborts every task and waits for each to end. Closing twice waits again. */
  async close(reason?: unknown): Promise<void> {
    if (!this.#controller.signal.aborted) this.#controller.abort(reason ?? abortError(`${this.#options.name} closed`));
    while (this.#tasks.size > 0) await Promise.all([...this.#tasks].map((t) => t.done));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  #report(task: string, error: unknown) {
    if (this.#options.onError) this.#options.onError(task, error);
    else console.error(`${this.#options.name}: ${task} failed:`, error);
  }
}
