import { expect, expectTypeOf, test } from "vite-plus/test";

import { ambiguousRoutes, compareRoutes, pathSegments, route } from "./matching";

test("parameters round trip Unicode and encoded delimiters as one segment", () => {
  const farm = route("/farm/:repo");
  const params = { repo: "a/b %?" };
  expect(farm.build(params)).toBe("/farm/a%2Fb%20%25%3F");
  expect(farm.match(farm.build(params))).toEqual(params);
  expect(farm.match("/farm/")).toBeUndefined();
  expect(farm.match("/farm/a/b")).toBeUndefined();
  expect(() => farm.build({ repo: ".." })).toThrow("relative segment");
  expect(() => farm.build({ repo: "." })).toThrow("relative segment");
  expectTypeOf(farm.build).parameter(0).toEqualTypeOf<Readonly<{ repo: string }>>();
  expectTypeOf(farm.match).returns.toEqualTypeOf<Readonly<{ repo: string }> | undefined>();
  expectTypeOf(route("/issues/:id/:tab").build).parameter(0).toEqualTypeOf<Readonly<{ id: string; tab: string }>>();
});

test("regression: farm home and the no-repo farm have different trailing slash matches", () => {
  expect(route("/farm").match("/farm/")).toBeUndefined();
  expect(route("/farm/").match("/farm")).toBeUndefined();
  expect(route("/farm").match("/farm")).toEqual({});
  expect(route("/farm/").match("/farm/")).toEqual({});
});

test("rest remains encoded for the page that owns the nested route", () => {
  const page = route("/pkm/*");
  expect(page.match("/pkm")).toEqual({ rest: "" });
  expect(page.match("/pkm/")).toEqual({ rest: "" });
  expect(page.match("/pkm/a%2Fb/100%25")).toEqual({ rest: "a%2Fb/100%25" });
  expect(page.build({ rest: "a%2Fb/100%25" })).toBe("/pkm/a%2Fb/100%25");
  expect(page.build.bind(null, { rest: "x?y" })).toThrow("Invalid encoded");
});

test("invalid percent encodings cannot escape the matcher", () => {
  for (const path of ["/farm/%", "/farm/%E0%A4", "/farm/%GG"]) {
    expect(pathSegments(path)).toBeUndefined();
    expect(route("/farm/:repo").match(path)).toBeUndefined();
  }
});

test("static beats a parameter, which beats a rest, regardless of definition order", () => {
  const paths = [route("*"), route("/issues/*"), route("/issues/:id"), route("/issues/new"), route("/issues")];
  const sorted = paths.toSorted(compareRoutes);
  expect(sorted.find((p) => p.match("/issues/new"))?.path).toBe("/issues/new");
  expect(sorted.find((p) => p.match("/issues/42"))?.path).toBe("/issues/:id");
  expect(sorted.find((p) => p.match("/issues"))?.path).toBe("/issues");
  expect(sorted.find((p) => p.match("/issues/42/changes"))?.path).toBe("/issues/*");
  expect(sorted.find((p) => p.match("/other"))?.path).toBe("*");
});

test("ambiguous shapes and invalid definitions are rejected without rejecting distinct static routes", () => {
  expect(ambiguousRoutes(route("/issues/:id"), route("/issues/:name"))).toBe(true);
  expect(ambiguousRoutes(route("/issues/new"), route("/issues/old"))).toBe(false);
  expect(ambiguousRoutes(route("/issues/new"), route("/issues/:id"))).toBe(false);
  for (const path of ["relative", "/:id/:id", "/:id?", "/x/*/y", "/:rest/*", "/:", "/x?y", "/x#y"]) expect(() => route(path)).toThrow();
});

test("parameter names cannot change the result prototype", () => {
  const params = route("/:constructor/:toString").match("/one/two");
  expect(params).toEqual({ constructor: "one", toString: "two" });
  expect(Object.getPrototypeOf(params)).toBe(Object.prototype);
});
