import { Schema } from "effect";
import { expect, expectTypeOf, test, vi } from "vite-plus/test";

import { createTable, defineColumns, type Owned, type Page, type Sort } from "./model";

const Row = Schema.Struct({ id: Schema.String, name: Schema.String, rank: Schema.Finite });
type Row = typeof Row.Type;
const column = defineColumns(Row);
const name = column("name", { value: (row) => row.name, compare: (a, b) => a.localeCompare(b), hideable: false });
const rank = column("rank", { value: (row) => row.rank, compare: (a, b) => a - b });
const columns = [name, rank];
const source: readonly Row[] = [
  { id: "a", name: "A", rank: 2 },
  { id: "b", name: "B", rank: 1 },
  { id: "c", name: "C", rank: 1 },
];

test("columns preserve their value types and local stable sort precedes pagination", () => {
  expectTypeOf(name.value).returns.toEqualTypeOf<string>();
  expectTypeOf(rank.value).returns.toEqualTypeOf<number>();
  expectTypeOf<{ initial: Page; value: () => Page; onChange: (page: Page) => void }>().not.toExtend<Owned<Page>>();
  const table = createTable({ mode: "local", rows: () => source, columns, rowId: (row) => row.id, page: { initial: { index: 0, size: 2 } } });
  table.setSort({ column: "rank", direction: "asc" });
  expect(table.rows().map((row) => row.id)).toEqual(["b", "c"]);
  table.setPage({ index: 1, size: 2 });
  expect(table.rows().map((row) => row.id)).toEqual(["a"]);
  table.setSort({ column: "rank", direction: "desc" });
  expect(table.page().index).toBe(1);
  expect(table.rows().map((row) => row.id)).toEqual(["c"]);
  expect(source.map((row) => row.id)).toEqual(["a", "b", "c"]);
  table.dispose();
});

test("schema-derived columns never decode already checked rows during table work", () => {
  let decoded = 0;
  const Checked = Row.check(
    Schema.makeFilter(() => {
      decoded++;
      return true;
    }),
  );
  const checkedColumn = defineColumns(Checked)("rank", { value: (row) => row.rank, compare: (a, b) => a - b });
  const row = Schema.decodeUnknownSync(Checked)(source[0]);
  expect(decoded).toBe(1);
  const table = createTable({ mode: "local", rows: () => [row], columns: [checkedColumn], rowId: (value) => value.id });
  table.setSort({ column: "rank", direction: "desc" });
  table.togglePage();
  expect(table.rows()).toHaveLength(1);
  expect(decoded).toBe(1);
  expect(() => createTable({ mode: "local", rows: () => [row], columns: [name, checkedColumn], rowId: (value) => value.id })).toThrow("share one row schema");
  table.dispose();
});

test("page-only selection survives sorting, filtering and paging until explicit pruning", () => {
  let rows = source;
  let allIds = new Set(source.map((row) => row.id));
  const table = createTable({
    mode: "local",
    rows: () => rows,
    columns,
    rowId: (row) => row.id,
    allIds: () => allIds,
    page: { initial: { index: 0, size: 2 } },
  });
  table.toggleRow("a");
  expect(table.pageSelection()).toEqual({ all: false, some: true });
  table.togglePage();
  table.setPage({ index: 1, size: 2 });
  table.togglePage();
  expect([...table.selection()]).toEqual(["a", "b", "c"]);
  rows = source.filter((row) => row.id === "a");
  table.reconcile();
  expect(table.page().index).toBe(0);
  expect([...table.selection()]).toEqual(["a", "b", "c"]);
  allIds = new Set(["a", "c"]);
  table.reconcile();
  expect([...table.selection()]).toEqual(["a", "c"]);
  table.setVisible("rank", false);
  table.setVisible("name", false);
  expect(table.columns().map((item) => item.id)).toEqual(["name"]);
  table.dispose();
});

test("controlled state asks the caller and never mirrors its own copy", () => {
  let requested: Page = { index: 8, size: 2 };
  const change = vi.fn();
  const table = createTable({ mode: "local", rows: () => source, columns, rowId: (row) => row.id, page: { value: () => requested, onChange: change } });
  table.reconcile();
  table.reconcile();
  expect(change).toHaveBeenCalledExactlyOnceWith({ index: 1, size: 2 });
  expect(table.page().index).toBe(8);
  requested = { index: 1, size: 2 };
  expect(table.rows().map((row) => row.id)).toEqual(["c"]);
  table.setPage({ index: 0, size: 2 });
  expect(table.page().index).toBe(1);
  table.dispose();
});

test("remote pages are not sorted or sliced locally and previous identity disables row actions", () => {
  let loaded: { page: Page; sort: Sort<"name" | "rank">; scope: string } = { page: { index: 0, size: 2 }, sort: undefined, scope: "one" };
  const table = createTable({
    mode: "remote",
    rows: () => source,
    columns,
    rowId: (row) => row.id,
    scope: () => "one",
    loaded: () => loaded,
    total: () => ({ kind: "unknown", hasNext: true }),
    page: { initial: { index: 0, size: 2 } },
  });
  expect(table.rows().map((row) => row.id)).toEqual(["a", "b", "c"]);
  table.setPage({ index: 1, size: 2 });
  expect(table.stale()).toBe(true);
  table.togglePage();
  table.toggleRow("a");
  expect(table.selection().size).toBe(0);
  loaded = { ...loaded, page: { index: 1, size: 2 } };
  expect(table.stale()).toBe(false);
  table.setSort({ column: "rank", direction: "asc" });
  expect(table.stale()).toBe(true);
  expect(table.rows().map((row) => row.id)).toEqual(["a", "b", "c"]);
  loaded = { page: { index: 1, size: 2 }, sort: { column: "rank", direction: "asc" }, scope: "one" };
  expect(table.stale()).toBe(false);
  table.toggleRow("a");
  expect(table.selection().has("a")).toBe(true);
  expect(table.hasNext()).toBe(true);
  table.dispose();
});

test("duplicate IDs and invalid pages fail before rendering; disposal releases callbacks", () => {
  expect(() => createTable({ mode: "local", rows: () => source, columns: [name, name], rowId: (row) => row.id })).toThrow("unique");
  const duplicate = createTable({ mode: "local", rows: () => source, columns, rowId: () => "same" });
  expect(duplicate.rows).toThrow("unique");
  duplicate.dispose();
  const table = createTable({ mode: "local", rows: () => source, columns, rowId: (row) => row.id });
  expect(() => table.setPage({ index: -1, size: 1 })).toThrow("nonnegative");
  const changed = vi.fn();
  table.subscribe(changed);
  table.dispose();
  table.togglePage();
  expect(changed).not.toHaveBeenCalled();
});

test("one thousand rows share ordered work across reads and selection", () => {
  const compare = vi.fn((a: number, b: number) => a - b);
  const rankColumn = column("rank", { value: (row) => row.rank, compare: (a, b) => compare(a, b) });
  const rows = Array.from({ length: 1000 }, (_, n) => ({ id: String(n), name: `row-${n}`, rank: 1000 - n }));
  const table = createTable({
    mode: "local",
    rows: () => rows,
    rowId: (row) => row.id,
    columns: [rankColumn],
    sort: { initial: { column: "rank", direction: "asc" } },
  });
  expect(table.rows()).toHaveLength(25);
  const count = compare.mock.calls.length;
  table.rows();
  table.togglePage();
  table.rows();
  expect(compare).toHaveBeenCalledTimes(count);
  expect(table.rows()[0]?.id).toBe("999");
  table.dispose();
});
