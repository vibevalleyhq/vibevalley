import { expect, test } from "vite-plus/test";

import { pinyinLoaded } from "@/base/search";

import { offeredFor, typedName } from "./mentions";

test("an @ right after Chinese opens the names; one in a Latin word or an address does not", () => {
  expect(typedName("问@", 2)).toEqual({ start: 1, query: "" });
  expect(typedName("问@w", 3)).toEqual({ start: 1, query: "w" });
  expect(typedName("look @", 6)).toEqual({ start: 5, query: "" });
  expect(typedName("a@b", 3)).toBeUndefined();
});

test("the @ menu finds a Chinese name by its pinyin", async () => {
  await pinyinLoaded;
  const all = [
    { token: "@orchestrator", name: "管家", note: "" },
    { token: "@w3", name: "老周", note: "" },
  ];
  expect(offeredFor(all, "gj").map((n) => n.token)).toEqual(["@orchestrator"]);
  expect(offeredFor(all, "laozhou").map((n) => n.token)).toEqual(["@w3"]);
});
