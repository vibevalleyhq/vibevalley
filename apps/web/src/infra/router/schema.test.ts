import { Effect, Schema, SchemaGetter } from "effect";
import { expect, expectTypeOf, test } from "vite-plus/test";

import { memoryHistory } from "./history";
import { route } from "./matching";
import { search, searchParam } from "./search";

const Positive = Schema.FiniteFromString.check(Schema.isGreaterThan(0));
const filters = search({
  page: Schema.optional(searchParam(Positive)),
  order: Schema.optional(searchParam(Schema.Literals(["asc", "desc"]))),
  tags: Schema.optional(Schema.Array(Schema.String)),
});
const item = route("/items/:id", { params: Schema.Struct({ id: Positive }), search: filters });

test("route codecs infer decoded params and encode links through the same schema", () => {
  expectTypeOf(item.build).parameter(0).toEqualTypeOf<{ readonly id: number }>();
  expectTypeOf(item.match("/items/4")?.id).toEqualTypeOf<number | undefined>();
  expect(item.match("/items/4")).toEqual({ id: 4 });
  expect(item.build({ id: 4 })).toBe("/items/4");
  expect(() => item.build({ id: -1 })).toThrow("Invalid route parameters");
  expect(item.resolve("/items/not-a-number", "")).toBe("invalid");
  expect(item.resolve("/other/4", "")).toBe("missing");
  expect(item.resolve("/items/4", "?page=0")).toBe("invalid");
  expect(item.resolve("/items/4", "?page=2")).toBe("matched");
});

test("asynchronous route codecs cannot admit a page before validation", () => {
  const waiting = Schema.String.pipe(
    Schema.decodeTo(Schema.String, { decode: SchemaGetter.transformEffect(() => Effect.never), encode: SchemaGetter.passthrough() }),
  );
  const path = route("/waiting/:id", { params: Schema.Struct({ id: waiting }) });
  expect(path.resolve("/waiting/value", "")).toBe("invalid");
  const waitingSearch = search({ value: searchParam(waiting) });
  expect(waitingSearch.valid("?value=one")).toBe(false);
});

test("search codecs distinguish one value from repeated values and preserve unrelated URL state", () => {
  const parsed = filters.read("?page=2&order=desc&tags=one&tags=two");
  expectTypeOf(parsed?.page).toEqualTypeOf<number | undefined>();
  expectTypeOf(parsed?.order).toEqualTypeOf<"asc" | "desc" | undefined>();
  expect(parsed).toEqual({ page: 2, order: "desc", tags: ["one", "two"] });
  expect(filters.read("?tags=one")?.tags).toEqual(["one"]);
  for (const text of ["?page=", "?page=no", "?page=1&page=2", "?order=other", "?tags=%C3%28"]) expect(filters.read(text)).toBeUndefined();
  const history = memoryHistory("/items/4?foreign=keep&page=1#anchor");
  history.navigate(filters.write(history.read(), { page: 3, tags: ["a b", "x/y"] }));
  expect(history.read().href).toBe("/items/4?foreign=keep&page=3&tags=a+b&tags=x%2Fy#anchor");
  expect(filters.read(history.read().search)).toEqual({ page: 3, tags: ["a b", "x/y"] });
  history.navigate(filters.write(history.read(), {}));
  expect(history.read().href).toBe("/items/4?foreign=keep#anchor");
  expect(() => filters.write(history.read(), { page: Number.NaN })).toThrow("Invalid search values");
});
