import { expect, test } from "vite-plus/test";

import { typedName } from "./mentions";

test("an @ right after Chinese opens the names; one in a Latin word or an address does not", () => {
  expect(typedName("问@", 2)).toEqual({ start: 1, query: "" });
  expect(typedName("问@w", 3)).toEqual({ start: 1, query: "w" });
  expect(typedName("look @", 6)).toEqual({ start: 5, query: "" });
  expect(typedName("a@b", 3)).toBeUndefined();
});
