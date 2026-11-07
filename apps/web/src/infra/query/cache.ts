import { Predicate, type Schema } from "effect";

import { queryDecoder } from "./schema";

export type QueryKey = readonly (string | number | boolean | null)[];
export type QueryRecord<T> = { readonly value: T; readonly updatedAt: number };
export type QuerySnapshot<T> = {
  readonly status: "idle" | "pending" | "success" | "error";
  readonly record: QueryRecord<T> | undefined;
  readonly error: Error | undefined;
  readonly fetching: boolean;
  readonly stale: boolean;
};
export type QueryDemand = { readonly enabled: boolean; readonly interval: number | false };
type Policy = { readonly staleTime?: number; readonly gcTime?: number; readonly retry?: number; readonly retryWhen?: (error: unknown) => boolean };
type EntryBase = {
  readonly key: QueryKey;
  readonly definition: object;
  invalidate(): Promise<unknown>;
  clear(): void;
  dispose(): void;
};
type Scope = {
  readonly entries: Map<string, EntryBase>;
  readonly activity: Set<() => void>;
  closed: boolean;
  active: number;
};
export type QueryDescriptor<T> = { readonly key: QueryKey; readonly entry: (scope: Scope) => Entry<T> };
export type QueryClient = ReturnType<typeof createQueryClient>;

const hash = (key: QueryKey) => {
  if (
    !Array.isArray(key) ||
    key.some((part) => !(part === null || typeof part === "string" || typeof part === "boolean" || (typeof part === "number" && Number.isFinite(part))))
  ) {
    throw new Error("Query keys must contain only strings, finite numbers, booleans or null");
  }
  return JSON.stringify(key);
};
const canceled = () => new DOMException("Query demand ended", "AbortError");
const notifyActivity = (scope: Scope) => {
  for (const listener of scope.activity) listener();
};
const timed = (callback: () => void, delay: number) => (Number.isFinite(delay) ? setTimeout(callback, Math.min(delay, 2_147_483_647)) : undefined);

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(canceled());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function wait(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(canceled());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 250);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

class Entry<T> implements EntryBase {
  readonly watchers = new Map<{ notify: () => void }, QueryDemand>();
  private record: QueryRecord<T> | undefined;
  private error: Error | undefined;
  private failed = false;
  private dirty = true;
  private generation = 0;
  private invalidation = 0;
  private leases = 0;
  private closed = false;
  private running: { controller: AbortController; promise: Promise<T> } | undefined;
  private gc: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setTimeout> | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  readonly key: QueryKey;
  readonly definition: object;
  private readonly scope: Scope;
  private readonly read: (signal: AbortSignal) => Promise<T>;
  private readonly policy: Policy;
  private readonly check: (value: T) => T;
  private readonly same: (left: T, right: T) => boolean;
  private readonly remove: () => void;
  constructor(
    key: QueryKey,
    definition: object,
    scope: Scope,
    read: (signal: AbortSignal) => Promise<T>,
    check: (value: T) => T,
    same: (left: T, right: T) => boolean,
    policy: Policy,
    remove: () => void,
  ) {
    this.key = key;
    this.definition = definition;
    this.scope = scope;
    this.read = read;
    this.check = check;
    this.same = same;
    this.policy = policy;
    this.remove = remove;
    this.schedule();
  }
  snapshot = (): QuerySnapshot<T> => ({
    status: this.failed ? "error" : this.record ? "success" : this.running ? "pending" : "idle",
    record: this.record,
    error: this.error,
    fetching: !!this.running,
    stale: this.dirty || !this.record || Date.now() - this.record.updatedAt >= (this.policy.staleTime ?? 0),
  });
  private keep = (value: T): T => (this.record && this.same(this.record.value, value) ? this.record.value : value);
  private active = () => [...this.watchers.values()].some((d) => d.enabled);
  private notify = () => {
    for (const observer of this.watchers.keys()) observer.notify();
  };
  private schedule() {
    clearTimeout(this.gc);
    clearTimeout(this.poll);
    clearTimeout(this.expiry);
    if (this.closed) return;
    if (this.watchers.size === 0 && this.leases === 0) this.gc = timed(() => this.dispose(), this.policy.gcTime ?? 300_000);
    this.expire();
    const intervals = [...this.watchers.values()].flatMap((d) => (d.enabled && d.interval !== false ? [d.interval] : []));
    if (!this.running && intervals.length > 0) this.poll = timed(() => this.background(), Math.min(...intervals));
  }
  private expire() {
    clearTimeout(this.expiry);
    if (this.closed || !this.record || this.snapshot().stale || this.watchers.size === 0) return;
    this.expiry = timed(
      () => {
        this.notify();
        this.expire();
      },
      this.record.updatedAt + (this.policy.staleTime ?? 0) - Date.now(),
    );
  }
  private cancel() {
    this.generation++;
    this.running?.controller.abort();
    if (this.running) {
      this.running = undefined;
      this.scope.active--;
      notifyActivity(this.scope);
    }
  }
  private settled(work: Promise<T>): Promise<QuerySnapshot<T>> {
    return work.then(this.snapshot, this.snapshot);
  }
  private background() {
    void this.settled(this.fetch(true));
  }
  refetch = () => this.settled(this.acquire(true));
  subscribe(listener: () => void, demand: QueryDemand) {
    if (this.closed) throw new Error("Query entry is disposed");
    const observer = { notify: listener };
    const update = (next: QueryDemand) => {
      if (this.closed) throw new Error("Query entry is disposed");
      if (next.interval !== false && (!Number.isFinite(next.interval) || next.interval <= 0)) throw new Error("Query interval must be positive and finite");
      const before = this.watchers.get(observer)?.enabled;
      this.watchers.set(observer, next);
      if (next.enabled && before !== true && this.snapshot().stale) this.background();
      if (!this.active() && this.leases === 0) this.cancel();
      this.schedule();
      this.notify();
    };
    update(demand);
    return {
      update,
      stop: () => {
        if (this.closed) return;
        this.watchers.delete(observer);
        if (!this.active() && this.leases === 0) this.cancel();
        this.schedule();
        this.notify();
      },
    };
  }
  async acquire(force = false): Promise<T> {
    this.leases++;
    this.schedule();
    try {
      return await this.fetch(force);
    } finally {
      this.leases--;
      if (!this.active() && this.leases === 0) this.cancel();
      this.schedule();
    }
  }
  fetch(force = false): Promise<T> {
    if (this.closed || this.scope.closed) return Promise.reject(canceled());
    if (this.running) return this.running.promise;
    if (!force && !this.snapshot().stale && this.record) return Promise.resolve(this.record.value);
    const generation = ++this.generation;
    const controller = new AbortController();
    const signal = controller.signal;
    const current = () => generation === this.generation && !signal.aborted && !this.closed;
    const run = async (attempt = 0): Promise<T> => {
      if (!current()) throw canceled();
      const invalidation = this.invalidation;
      let value: T;
      try {
        value = await abortable(
          Promise.resolve().then(() => this.read(signal)),
          signal,
        );
      } catch (error) {
        if (!current()) throw canceled();
        if (invalidation !== this.invalidation) return run();
        if (!Predicate.isTagged(error, "QueryDecodeError") && attempt < (this.policy.retry ?? 0) && this.policy.retryWhen?.(error) === true) {
          await wait(signal);
          return run(attempt + 1);
        }
        this.failed = true;
        this.error = error instanceof Error ? error : new Error("Query failed", { cause: error });
        throw this.error;
      }
      if (!current()) throw canceled();
      if (invalidation !== this.invalidation) return run();
      this.record = { value: this.keep(value), updatedAt: Date.now() };
      this.dirty = false;
      this.failed = false;
      this.error = undefined;
      return this.record.value;
    };
    const promise = Promise.resolve()
      .then(() => run())
      .finally(() => {
        if (generation !== this.generation) return;
        this.running = undefined;
        this.scope.active--;
        notifyActivity(this.scope);
        this.schedule();
        this.notify();
      });
    this.running = { controller, promise };
    this.scope.active++;
    notifyActivity(this.scope);
    this.schedule();
    this.notify();
    return promise;
  }
  invalidate = (): Promise<unknown> => {
    this.invalidation++;
    this.dirty = true;
    this.notify();
    return this.active() || this.leases > 0 ? this.fetch(true) : Promise.resolve();
  };
  setData(update: (old: QueryRecord<T> | undefined) => { value: T } | undefined) {
    const next = update(this.record);
    if (!next) return;
    const value = this.check(next.value);
    this.cancel();
    this.record = { value: this.keep(value), updatedAt: Date.now() };
    this.failed = false;
    this.error = undefined;
    this.dirty = false;
    this.schedule();
    this.notify();
  }
  clear = () => {
    this.cancel();
    this.record = undefined;
    this.error = undefined;
    this.failed = false;
    this.dirty = true;
    this.schedule();
    this.notify();
  };
  dispose = () => {
    if (this.closed) return;
    this.closed = true;
    this.watchers.clear();
    this.clear();
    this.remove();
  };
}

export function defineQuery<A = void, T = never, E = T>(
  options: Policy & { schema: Schema.Codec<T, E>; key: (input: A) => QueryKey; fetch: (input: A, context: { signal: AbortSignal }) => Promise<unknown> },
): (input: A) => QueryDescriptor<T> {
  for (const n of [options.staleTime ?? 0, options.gcTime ?? 300_000]) if (n < 0 || Number.isNaN(n)) throw new Error("Query durations must be nonnegative");
  if (!Number.isInteger(options.retry ?? 0) || (options.retry ?? 0) < 0) throw new Error("Query retry must be a nonnegative integer");
  const decoder = queryDecoder(options.schema);
  const stores = new WeakMap<Scope, Map<string, Entry<T>>>();
  return (input) => {
    const key = Object.freeze([...options.key(input)]);
    const id = hash(key);
    return {
      key,
      entry(scope) {
        if (scope.closed) throw new Error("Query client is disposed");
        if (scope.entries.has(id) && scope.entries.get(id)?.definition !== options) throw new Error(`Conflicting query definition: ${id}`);
        let store = stores.get(scope);
        if (!store) {
          store = new Map();
          stores.set(scope, store);
        }
        const found = store.get(id);
        if (found) return found;
        const entries = store;
        const entry = new Entry(
          key,
          options,
          scope,
          async (signal) => decoder.decode(await options.fetch(input, { signal }), signal),
          decoder.check,
          decoder.same,
          options,
          () => {
            entries.delete(id);
            scope.entries.delete(id);
          },
        );
        entries.set(id, entry);
        scope.entries.set(id, entry);
        return entry;
      },
    };
  };
}

export function createQueryClient() {
  const scope: Scope = { entries: new Map(), activity: new Set(), closed: false, active: 0 };
  return {
    read: <T>(query: QueryDescriptor<T>) => query.entry(scope).snapshot(),
    fetch: <T>(query: QueryDescriptor<T>, force = false) => query.entry(scope).acquire(force),
    refetch: <T>(query: QueryDescriptor<T>) => query.entry(scope).refetch(),
    prefetch: <T>(query: QueryDescriptor<T>) => query.entry(scope).acquire(),
    subscribe: <T>(query: QueryDescriptor<T>, listener: () => void, demand: QueryDemand) => query.entry(scope).subscribe(listener, demand),
    setData: <T>(query: QueryDescriptor<T>, update: (old: QueryRecord<T> | undefined) => { value: T } | undefined) => query.entry(scope).setData(update),
    invalidate: (filter?: { key: QueryKey; prefix?: never } | { prefix: QueryKey; key?: never }) => {
      const key = filter?.key ?? filter?.prefix;
      if (key) hash(key);
      return Promise.allSettled(
        [...scope.entries.values()]
          .filter((entry) => !key || (key.every((part, i) => entry.key[i] === part) && (!filter?.key || entry.key.length === key.length)))
          .map((entry) => entry.invalidate()),
      );
    },
    fetching: () => scope.active,
    subscribeActivity: (listener: () => void) => {
      scope.activity.add(listener);
      return () => {
        scope.activity.delete(listener);
      };
    },
    clear: () => {
      for (const entry of scope.entries.values()) entry.clear();
    },
    dispose: () => {
      scope.closed = true;
      scope.activity.clear();
      for (const entry of scope.entries.values()) entry.dispose();
      scope.entries.clear();
    },
  };
}
