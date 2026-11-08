import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { For, Show, type Accessor } from "solid-js";

import { t } from "@vibevalley/i18n";

import type { Column, TableModel } from "#/infra/table.ts";

import { Button } from "./Button";
import { Checkbox } from "./Checkbox";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";

const viewStyles = stylex.create({
  dataTableDiv: {
    display: "flex",
    minWidth: "0",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2)",
  },
  dataTableDiv2: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 3)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  dataTableSpan: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
  },
  dataTableP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-muted)",
  },
  dataTableDiv3: {
    minWidth: "0",
    overflowX: "auto",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
  },
  dataTableTable: {
    minWidth: "100%",
    textAlign: "left",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  dataTableCaption: {
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
    borderWidth: "0",
    width: "1px",
    height: "1px",
    margin: "-1px",
    padding: "0",
    position: "absolute",
    overflow: "hidden",
  },
  dataTableThead: {
    backgroundColor: "var(--wb-hover)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  dataTableTh: {
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 2)",
  },
  dataTableTh2: {
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 2)",
    fontWeight: "var(--font-weight-medium)",
  },
  tableRow: {
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--wb-line)",
  },
  dataTableTd: {
    padding: "calc(var(--spacing) * 3)",
    color: "var(--wb-muted)",
  },
  dataTableDiv4: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
});

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
    <div {...stylex.attrs(viewStyles.dataTableDiv)} data-testid={props.testid ?? "data-table"} data-stale={table().stale() ? "true" : "false"}>
      <Show when={props.columnControls}>
        <div {...stylex.attrs(viewStyles.dataTableDiv2)} role="group" aria-label={t("web.base.table.columns")}>
          <For each={table().allColumns} keyed={(column) => column.id}>
            {(column) => (
              <Show when={column().hideable}>
                <span {...stylex.attrs(viewStyles.dataTableSpan)}>
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
        <p role="status" {...stylex.attrs(viewStyles.dataTableP)}>
          {t("web.base.table.stale")}
        </p>
      </Show>
      <div {...stylex.attrs(viewStyles.dataTableDiv3)}>
        <table {...stylex.attrs(viewStyles.dataTableTable)}>
          <caption {...stylex.attrs(viewStyles.dataTableCaption)}>{props.caption}</caption>
          <thead {...stylex.attrs(viewStyles.dataTableThead)}>
            <tr>
              <Show when={props.selection}>
                <th scope="col" {...stylex.attrs(viewStyles.dataTableTh)}>
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
                    {...stylex.attrs(viewStyles.dataTableTh2)}
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
                  {...stylex.attrs(viewStyles.tableRow)}
                >
                  <Show when={props.selection}>
                    <td {...stylex.attrs(viewStyles.dataTableTh)}>
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
                      <td data-column={column().id} {...stylex.attrs(viewStyles.dataTableTh)}>
                        {props.cells[column().id].render(() => row().original)}
                      </td>
                    )}
                  </For>
                </tr>
              )}
            </For>
            <Show when={table().rows().length === 0 && !table().stale()}>
              <tr>
                <td colspan={table().columns().length + (props.selection === true ? 1 : 0)} {...stylex.attrs(viewStyles.dataTableTd)}>
                  {t("web.base.table.empty")}
                </td>
              </tr>
            </Show>
          </tbody>
        </table>
      </div>
      <Show when={table().page().index > 0 || table().hasNext()}>
        <div {...stylex.attrs(viewStyles.dataTableDiv4)}>
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
