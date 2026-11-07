import { createEffect, createMemo, onCleanup, untrack } from "solid-js";

import { createExternal } from "#/base/external.ts";

import { createTable, type TableOptions } from "./table/model";
export { defineColumns, type Column, type Page, type Sort, type TableOptions, type TableModel } from "./table/model";

export function useTable<T, const K extends string>(options: TableOptions<T, K>) {
  const model = untrack(() => createTable(options));
  const version = createExternal(model.subscribe, model.snapshot);
  onCleanup(model.dispose);
  const watch = <V>(get: () => V) =>
    createMemo(() => {
      version();
      return get();
    });
  createEffect(
    () => {
      version();
      options.rows();
      options.allIds?.();
      model.page();
      return {};
    },
    () => {
      untrack(model.reconcile);
    },
  );
  return {
    ...model,
    rows: watch(model.rows),
    columns: watch(model.columns),
    sorting: watch(model.sorting),
    page: watch(model.page),
    total: watch(model.total),
    stale: watch(model.stale),
    hasNext: watch(model.hasNext),
    selection: watch(model.selection),
    pageSelection: watch(model.pageSelection),
    visibility: watch(model.visibility),
  };
}
