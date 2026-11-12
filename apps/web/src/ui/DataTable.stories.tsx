import { createSignal } from "solid-js";
import { z } from "zod";

import { stories, story } from "@vibevalley/stories";

import { createQueryClient, defineQuery, QueryProvider, useQuery } from "#/infra/query.ts";
import { defineColumns, useTable, type Page, type Sort } from "#/infra/table.ts";

import { Button } from "./Button";
import { DataTable, tableCell } from "./DataTable";

const Row = z.object({ id: z.string(), name: z.string(), count: z.number() });
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
    <div class="flex flex-col gap-3 p-4">
      <Button data-testid="table-filter" onClick={() => setFiltered(!filtered())}>
        Toggle filter
      </Button>
      <output data-testid="table-selected">{table.selection().size}</output>
      <DataTable table={table} cells={cells} caption="Records" selection columnControls />
    </div>
  );
}
const Loaded = z.object({
  rows: z.array(Row),
  page: z.object({ index: z.int(), size: z.int() }),
  sort: z.object({ column: z.enum(["name", "count"]), direction: z.enum(["asc", "desc"]) }).or(z.undefined()),
  scope: z.string(),
});
type Loaded = z.output<typeof Loaded>;
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
    <div class="flex flex-col gap-3 p-4">
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
