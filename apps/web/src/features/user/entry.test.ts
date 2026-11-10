import { expect, test } from "vite-plus/test";

import { entryFor } from "./entry";

const device = { id: "d1", name: "iPhone", came: "login" as const, addedAt: 1 };

test("a page from outside signs in when it can, pairs when it cannot, and goes on once it holds a key", () => {
  expect(entryFor({ name: "", password: true, here: false })).toBe("/login");
  expect(entryFor({ name: "", password: false, here: false })).toBe("/pair");
  expect(entryFor(undefined)).toBe("/pair");
  expect(entryFor({ name: "小明", password: true, here: false, device })).toBe("");
  expect(entryFor({ name: "小明", password: false, here: false, device: { ...device, came: "paired" } })).toBe("");
});
