import * as stylex from "@stylexjs/stylex";
import { Schema } from "effect";
import { createSignal } from "solid-js";

import { stories, story } from "@vibevalley/stories";

import { createQueryClient, defineQuery, QueryProvider, useQuery } from "#/infra/query.ts";
import { defineColumns, useTable, type Page, type Sort } from "#/infra/table.ts";

import { Button } from "./Button";
import { DataTable, tableCell } from "./DataTable";

const viewStyles = stylex.create({
  localDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
    padding: "1rem",
  },
});

const Row = Schema.Struct({ id: Schema.String, name: Schema.String, count: Schema.Finite });
const column = defineColumns(Row);
const name = column("name", { value: (row) => row.name, compare: (a, b) => a.localeCompare(b), hideable: false });
const count = column("count", { value: (row) => row.count, compare: (a, b) => a - b });
const columns = [name, count];
const cells = {
  name: tableCell(
    name,
    () => "Name",
    (value) => value(),
  ),
  count: tableCell(
    count,
    () => "Count",
    (value) => value(),
  ),
};
const records = Array.from({ length: 1000 }, (_, index) => ({ id: String(index), name: `Record ${String(index).padStart(4, "0")}`, count: 1000 - index }));
function Local() {
  const [filtered, setFiltered] = createSignal(false);
  const table = useTable({ mode: "local", rows: () => (filtered() ? records.slice(0, 3) : records), rowId: (row) => row.id, columns });
  return (
    <div {...stylex.attrs(viewStyles.localDiv)}>
      <Button data-testid="table-filter" onClick={() => setFiltered(!filtered())}>
        Toggle filter
      </Button>
      <output data-testid="table-selected">{table.selection().size}</output>
      <DataTable table={table} cells={cells} caption="Records" selection columnControls />
    </div>
  );
}
const Loaded = Schema.Struct({
  rows: Schema.Array(Row),
  page: Schema.Struct({ index: Schema.Int, size: Schema.Int }),
  sort: Schema.UndefinedOr(Schema.Struct({ column: Schema.Literals(["name", "count"]), direction: Schema.Literals(["asc", "desc"]) })),
  scope: Schema.String,
});
type Loaded = typeof Loaded.Type;
function Remote() {
  const [page, setPage] = createSignal<Page>({ index: 0, size: 2 });
  const [sort, setSort] = createSignal<Sort<"name" | "count">>();
  let finish: (() => void) | undefined;
  const read = defineQuery({
    schema: Loaded,
    key: (input: { page: Page; sort: Sort<"name" | "count"> }) => ["remote-story", input.page.index, input.sort?.column ?? "", input.sort?.direction ?? ""],
    fetch: (input) =>
      new Promise<Loaded>((resolve) => {
        finish = () => resolve({ rows: records.slice(input.page.index * 2, input.page.index * 2 + 2), ...input, scope: "demo" });
      }),
  });
  const query = useQuery(() => read({ page: page(), sort: sort() }), { keepPrevious: true });
  const loaded = () => query.data() ?? query.previous()?.value;
  const table = useTable({
    mode: "remote",
    rows: () => loaded()?.rows ?? [],
    columns,
    rowId: (row) => row.id,
    loaded,
    scope: () => "demo",
    total: () => ({ kind: "unknown", hasNext: true }),
    page: { value: page, onChange: setPage },
    sort: { value: sort, onChange: setSort },
  });
  return (
    <div {...stylex.attrs(viewStyles.localDiv)}>
      <Button data-testid="table-deliver" onClick={() => finish?.()}>
        Deliver requested page
      </Button>
      <output data-testid="table-selected">{table.selection().size}</output>
      <DataTable table={table} cells={cells} caption="Remote records" selection columnControls />
    </div>
  );
}
export default stories({
  title: "组件/工作台/DataTable",
  stories: {
    Local: story({ render: Local }),
    Remote: story({
      render: () => (
        <QueryProvider client={createQueryClient()}>
          <Remote />
        </QueryProvider>
      ),
    }),
  },
});
