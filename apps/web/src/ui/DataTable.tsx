import type { JSX } from "@solidjs/web";
import { For, Show, type Accessor } from "solid-js";

import { t } from "@vibevalley/i18n";

import type { Column, TableModel } from "#/infra/table.ts";

import { Button } from "./Button";
import { Checkbox } from "./Checkbox";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";

export type TableCells<T, K extends string> = {
  readonly [P in K]: { readonly id: P; readonly header: () => string; readonly render: (row: Accessor<T>) => JSX.Element };
};
export function tableCell<T, const K extends string, V>(
  column: Column<T, K, V>,
  header: () => string,
  render: (value: Accessor<V>, row: Accessor<T>) => JSX.Element,
) {
  return { id: column.id, header, render: (row: Accessor<T>) => render(() => column.value(row()), row) };
}
export function DataTable<T, K extends string>(props: {
  table: TableModel<T, K>;
  cells: TableCells<NoInfer<T>, NoInfer<K>>;
  caption: string;
  selection?: boolean;
  columnControls?: boolean;
  testid?: string;
}) {
  const table = () => props.table;
  const sort = (id: K) => {
    const current = table().sorting();
    table().setSort(current?.column === id ? (current.direction === "asc" ? { column: id, direction: "desc" } : undefined) : { column: id, direction: "asc" });
  };
  return (
    <div class="flex min-w-0 flex-col gap-2" data-testid={props.testid ?? "data-table"} data-stale={table().stale() ? "true" : "false"}>
      <Show when={props.columnControls}>
        <div class="flex flex-wrap items-center gap-3 text-xs text-muted" role="group" aria-label={t("web.base.table.columns")}>
          <For each={table().allColumns} keyed={(column) => column.id}>
            {(column) => (
              <Show when={column().hideable}>
                <span class="flex items-center gap-1.5">
                  <Checkbox
                    testid="table-column"
                    data-key={column().id}
                    label={props.cells[column().id].header()}
                    checked={table().visibility().get(column().id) !== false}
                    onChange={(show) => table().setVisible(column().id, show)}
                  />
                  {props.cells[column().id].header()}
                </span>
              </Show>
            )}
          </For>
        </div>
      </Show>
      <Show when={table().stale()}>
        <p role="status" class="text-sm text-muted">
          {t("web.base.table.stale")}
        </p>
      </Show>
      <div class="min-w-0 overflow-x-auto rounded-lg border border-line">
        <table class="min-w-full text-left text-sm">
          <caption class="sr-only">{props.caption}</caption>
          <thead class="bg-hover text-xs text-muted">
            <tr>
              <Show when={props.selection}>
                <th scope="col" class="px-3 py-2">
                  <Checkbox
                    testid="table-select-page"
                    label={t("web.base.table.selectPage")}
                    checked={table().pageSelection().all}
                    indeterminate={table().pageSelection().some}
                    disabled={table().stale() || table().rows().length === 0}
                    onChange={() => table().togglePage()}
                  />
                </th>
              </Show>
              <For each={table().columns()} keyed={(column) => column.id}>
                {(column) => (
                  <th
                    scope="col"
                    data-column={column().id}
                    class="px-3 py-2 font-medium"
                    aria-sort={table().sorting()?.column === column().id ? (table().sorting()?.direction === "asc" ? "ascending" : "descending") : "none"}
                  >
                    <Show when={column().compareRows} fallback={props.cells[column().id].header()}>
                      <Button data-testid="table-sort" data-key={column().id} onClick={() => sort(column().id)}>
                        {props.cells[column().id].header()}
                        <Icon name="choose" size={12} />
                      </Button>
                    </Show>
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody inert={table().stale()} class={table().stale() ? "opacity-60" : ""}>
            <For each={table().rows()} keyed={(row) => row.id}>
              {(row) => (
                <tr
                  data-testid="table-row"
                  data-key={row().id}
                  data-selected={table().selection().has(row().id) ? "true" : "false"}
                  class="border-t border-line"
                >
                  <Show when={props.selection}>
                    <td class="px-3 py-2">
                      <Checkbox
                        testid="table-select-row"
                        label={t("web.base.table.selectRow", { id: row().id })}
                        checked={table().selection().has(row().id)}
                        onChange={() => table().toggleRow(row().id)}
                      />
                    </td>
                  </Show>
                  <For each={table().columns()} keyed={(column) => column.id}>
                    {(column) => (
                      <td data-column={column().id} class="px-3 py-2">
                        {props.cells[column().id].render(() => row().original)}
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
            <Show when={table().rows().length === 0 && !table().stale()}>
              <tr>
                <td colspan={table().columns().length + (props.selection === true ? 1 : 0)} class="p-3 text-muted">
                  {t("web.base.table.empty")}
                </td>
              </tr>
            </Show>
          </tbody>
        </table>
      </div>
      <Show when={table().page().index > 0 || table().hasNext()}>
        <div class="flex items-center justify-end gap-2 text-xs text-muted">
          <IconButton
            testid="table-previous"
            icon="previous"
            label={t("web.base.table.previous")}
            disabled={table().page().index === 0}
            onClick={() => table().setPage({ ...table().page(), index: table().page().index - 1 })}
          />
          <span data-testid="table-page">{t("web.base.table.page", { n: table().page().index + 1 })}</span>
          <IconButton
            testid="table-next"
            icon="next"
            label={t("web.base.table.next")}
            disabled={!table().hasNext()}
            onClick={() => table().setPage({ ...table().page(), index: table().page().index + 1 })}
          />
        </div>
      </Show>
    </div>
  );
}
