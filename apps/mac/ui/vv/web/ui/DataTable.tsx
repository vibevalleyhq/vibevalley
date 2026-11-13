// Ported from VibeValley apps/web/src/ui/DataTable.tsx on its table model
// (infra/table.ts, vendored): the same column controls, sorting, selection
// and pages. There is no <table>: a row of cells per row, each column an
// equal share of the width; the caption is the table's accessibility label.
import { Text, View, type Accessor, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";

import type { Column, TableModel } from "../infra/table";
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
  const header = (id: K) => props.cells[id].header();
  return (
    <View class="min-w-0 gap-2" testID={props.testid ?? "data-table"} accessibilityLabel={props.caption}>
      <If when={props.columnControls}>
        <View role="group" accessibilityLabel={t("web.base.table.columns")} class="flex-row flex-wrap items-center gap-3">
          <Each of={table().allColumns.filter((c) => c.hideable)} key={(column) => column.id}>
            {(column) => (
              <View class="flex-row items-center gap-1.5">
                <Checkbox
                  testid={`table-column-${column().id}`}
                  label={header(column().id)}
                  checked={table().visibility().get(column().id) !== false}
                  onChange={(show) => table().setVisible(column().id, show)}
                />
                <Text class="text-xs text-muted">{header(column().id)}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>
      <If when={table().stale()}>
        <Text role="alert" class="text-sm text-muted">
          {t("web.base.table.stale")}
        </Text>
      </If>
      <View role="table" class="min-w-0 overflow-hidden rounded-lg border border-line">
        <View role="row" class="flex-row bg-hover">
          <If when={props.selection}>
            <View class="px-3 py-2">
              <Checkbox
                testid="table-select-page"
                label={t("web.base.table.selectPage")}
                checked={table().pageSelection().all}
                indeterminate={table().pageSelection().some}
                disabled={table().stale() || table().rows().length === 0}
                onChange={() => table().togglePage()}
              />
            </View>
          </If>
          <Each of={table().columns()} key={(column) => column.id}>
            {(column) => (
              <View role="columnheader" class="min-w-0 flex-1 justify-center px-3 py-2">
                <If when={column().compareRows} else={<Text class="text-xs font-medium text-muted">{header(column().id)}</Text>}>
                  <View
                    role="button"
                    testID={`table-sort-${column().id}`}
                    onPress={() => sort(column().id)}
                    class="h-6 flex-row items-center gap-1 self-start rounded-md px-1.5 hover:bg-selected"
                  >
                    <Text class="text-xs font-medium text-muted">{header(column().id)}</Text>
                    <Icon name="choose" size={12} tone="muted" />
                  </View>
                </If>
              </View>
            )}
          </Each>
        </View>
        <View class={table().stale() ? "opacity-60" : ""}>
          <Each of={table().rows()} key={(row) => row.id}>
            {(row) => (
              <View
                role="row"
                testID="table-row"
                accessibilityState={{ selected: table().selection().has(row().id) }}
                class="flex-row items-center border-t border-line"
              >
                <If when={props.selection}>
                  <View class="px-3 py-2">
                    <Checkbox
                      testid="table-select-row"
                      label={t("web.base.table.selectRow", { id: row().id })}
                      checked={table().selection().has(row().id)}
                      onChange={() => table().toggleRow(row().id)}
                    />
                  </View>
                </If>
                <Each of={table().columns()} key={(column) => column.id}>
                  {(column) => (
                    <View role="cell" class="min-w-0 flex-1 flex-row flex-wrap items-center px-3 py-2">
                      {props.cells[column().id].render(() => row().original)}
                    </View>
                  )}
                </Each>
              </View>
            )}
          </Each>
          <If when={table().rows().length === 0 && !table().stale()}>
            <View class="border-t border-line p-3">
              <Text class="text-sm text-muted">{t("web.base.table.empty")}</Text>
            </View>
          </If>
        </View>
      </View>
      <If when={table().page().index > 0 || table().hasNext()}>
        <View class="flex-row items-center justify-end gap-2">
          <IconButton
            testid="table-previous"
            icon="previous"
            label={t("web.base.table.previous")}
            disabled={table().page().index === 0}
            onClick={() => table().setPage({ ...table().page(), index: table().page().index - 1 })}
          />
          <Text testID="table-page" class="text-xs text-muted">
            {t("web.base.table.page", { n: table().page().index + 1 })}
          </Text>
          <IconButton
            testid="table-next"
            icon="next"
            label={t("web.base.table.next")}
            disabled={!table().hasNext()}
            onClick={() => table().setPage({ ...table().page(), index: table().page().index + 1 })}
          />
        </View>
      </If>
    </View>
  );
}
