import type { z } from "zod";

export type Column<T, K extends string, V = unknown> = {
  readonly schema: z.ZodType<T>;
  readonly id: K;
  readonly value: (row: T) => V;
  readonly compareRows: ((a: T, b: T) => number) | undefined;
  readonly hideable: boolean;
};
export const defineColumns =
  <T>(schema: z.ZodType<T>) =>
  <const K extends string, V>(
    id: K,
    definition: { value: (row: T) => V; compare?: (a: NoInfer<V>, b: NoInfer<V>) => number; hideable?: boolean },
  ): Column<T, K, V> => {
    const compare = definition.compare;
    return {
      schema,
      id,
      value: definition.value,
      compareRows: compare ? (a, b) => compare(definition.value(a), definition.value(b)) : undefined,
      hideable: definition.hideable ?? true,
    };
  };
export type Page = { readonly index: number; readonly size: number };
export type Sort<K extends string> = { readonly column: K; readonly direction: "asc" | "desc" } | undefined;
export type Owned<T> =
  | { readonly initial?: T; readonly value?: never; readonly onChange?: never }
  | { readonly initial?: never; readonly value: () => T; readonly onChange: (next: T) => void };
export type TableOptions<T, K extends string> = {
  readonly rows: () => readonly T[];
  readonly columns: readonly Column<NoInfer<T>, K>[];
  readonly rowId: (row: T) => string;
  readonly sort?: Owned<Sort<K>>;
  readonly page?: Owned<Page>;
  readonly selection?: Owned<ReadonlySet<string>>;
  readonly visibility?: Owned<ReadonlyMap<K, boolean>>;
  readonly allIds?: () => ReadonlySet<string>;
} & (
  | { readonly mode: "local"; readonly total?: never; readonly loaded?: never; readonly scope?: never }
  | {
      readonly mode: "remote";
      readonly total: () => { kind: "known"; rows: number } | { kind: "unknown"; hasNext: boolean };
      readonly loaded: () => { page: Page; sort: Sort<K>; scope: string } | undefined;
      readonly scope: () => string;
    }
);
export type TableRow<T> = { readonly id: string; readonly original: T };
export type TableModel<T, K extends string> = ReturnType<typeof createTable<T, K>>;
const validPage = (page: Page) => {
  if (!Number.isSafeInteger(page.index) || page.index < 0 || !Number.isSafeInteger(page.size) || page.size < 1)
    throw new Error("Table page requires a nonnegative index and positive size");
  return page;
};
export function createTable<T, const K extends string>(options: TableOptions<T, K>) {
  const definitions = new Map(options.columns.map((column) => [column.id, column]));
  if (options.columns.some((column) => column.schema !== options.columns[0]?.schema)) throw new Error("Table columns must share one row schema");
  if (definitions.size !== options.columns.length || options.columns.some((column) => !column.id)) throw new Error("Table columns require unique nonempty IDs");
  const listeners = new Set<() => void>();
  let version = 0;
  let disposed = false;
  const notify = () => {
    version++;
    for (const listener of listeners) listener();
  };
  const own = <V>(config: Owned<V> | undefined, initial: V) => {
    let value = config?.initial ?? initial;
    return {
      get: () => (config?.value ? config.value() : value),
      controlled: !!config?.value,
      set: (next: V) => {
        if (disposed) return;
        if (config?.onChange) config.onChange(next);
        else {
          value = next;
          notify();
        }
      },
    };
  };
  const sorting = own(options.sort, undefined);
  const paging = own(options.page, { index: 0, size: 25 });
  const selected = own(options.selection, new Set<string>());
  const visible = own(options.visibility, new Map<K, boolean>());
  let cached: { source: readonly T[]; sortKey: string; rows: readonly TableRow<T>[] } | undefined;
  const ordered = () => {
    const source = options.rows();
    const sort = sorting.get();
    const sortKey = JSON.stringify(sort) ?? "";
    if (cached?.source === source && cached.sortKey === sortKey) return cached.rows;
    const ids = new Set<string>();
    const rows = source.map((original) => {
      const id = options.rowId(original);
      if (!id || ids.has(id)) throw new Error("Table rows require unique nonempty IDs");
      ids.add(id);
      return { id, original };
    });
    const compare = sort ? definitions.get(sort.column)?.compareRows : undefined;
    if (sort && !compare) throw new Error("Table sort requires a sortable column");
    const sorted =
      options.mode === "local" && compare && sort
        ? rows.toSorted((a, b) => {
            const result = compare(a.original, b.original);
            if (!Number.isFinite(result)) throw new Error("Table comparator must return a finite number");
            return sort.direction === "asc" ? result : -result;
          })
        : rows;
    cached = { source, sortKey, rows: sorted };
    return sorted;
  };
  const total = () => {
    const result = options.mode === "local" ? { kind: "known" as const, rows: ordered().length } : options.total();
    if (result.kind === "known" && (!Number.isSafeInteger(result.rows) || result.rows < 0)) throw new Error("Table total must be a nonnegative integer");
    return result;
  };
  const bounded = (page: Page): Page => {
    validPage(page);
    const count = total();
    return count.kind === "known" ? { ...page, index: Math.min(page.index, Math.max(0, Math.ceil(count.rows / page.size) - 1)) } : page;
  };
  const page = () => (paging.controlled ? validPage(paging.get()) : bounded(paging.get()));
  const stale = () => {
    if (options.mode === "local") return false;
    const loaded = options.loaded();
    const requested = page();
    return (
      !loaded ||
      loaded.scope !== options.scope() ||
      loaded.page.index !== requested.index ||
      loaded.page.size !== requested.size ||
      JSON.stringify(loaded.sort) !== JSON.stringify(sorting.get())
    );
  };
  const rows = () => {
    const all = ordered();
    const at = page();
    return options.mode === "local" ? all.slice(at.index * at.size, (at.index + 1) * at.size) : all;
  };
  const setSort = (sort: Sort<K>) => {
    if (sort && !definitions.get(sort.column)?.compareRows) throw new Error("Table sort requires a sortable column");
    sorting.set(sort);
  };
  const setPage = (next: Page) => paging.set(validPage(next));
  let adjustment = "";
  const reconcile = () => {
    const requested = paging.get();
    const next = bounded(requested);
    const key = JSON.stringify([requested, next]);
    if (requested.index !== next.index && key !== adjustment) {
      adjustment = key;
      paging.set(next);
    }
    if (requested.index === next.index) adjustment = "";
    const all = options.allIds?.();
    if (all) {
      const before = selected.get();
      const nextSelection = new Set([...before].filter((id) => all.has(id)));
      if (nextSelection.size !== before.size) selected.set(nextSelection);
    }
  };
  return {
    snapshot: () => version,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    allColumns: options.columns,
    rows,
    columns: () => options.columns.filter((column) => !column.hideable || visible.get().get(column.id) !== false),
    sorting: sorting.get,
    setSort,
    page,
    setPage,
    total,
    stale,
    hasNext: () => {
      const count = total();
      const at = page();
      return count.kind === "known" ? (at.index + 1) * at.size < count.rows : count.hasNext;
    },
    selection: selected.get,
    toggleRow: (id: string) => {
      if (stale() || !rows().some((row) => row.id === id)) return;
      const next = new Set(selected.get());
      if (next.has(id)) next.delete(id);
      else next.add(id);
      selected.set(next);
    },
    togglePage: () => {
      if (stale()) return;
      const ids = rows().map((row) => row.id);
      const next = new Set(selected.get());
      const remove = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (remove) next.delete(id);
        else next.add(id);
      }
      selected.set(next);
    },
    pageSelection: () => {
      const shown = rows();
      const count = shown.filter((row) => selected.get().has(row.id)).length;
      return { all: shown.length > 0 && count === shown.length, some: count > 0 && count < shown.length };
    },
    visibility: visible.get,
    setVisible: (id: K, show: boolean) => {
      const column = definitions.get(id);
      if (!column) throw new Error("Unknown table column");
      if (!column.hideable && !show) return;
      visible.set(new Map(visible.get()).set(id, show));
    },
    reconcile,
    dispose: () => {
      disposed = true;
      cached = undefined;
      listeners.clear();
    },
  };
}
