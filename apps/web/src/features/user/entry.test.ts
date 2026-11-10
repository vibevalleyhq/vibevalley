import { expect, test } from "vite-plus/test";

import { afterSignIn, entryFor } from "./entry";

const device = { id: "d1", name: "iPhone", came: "login" as const, addedAt: 1 };

test("a page from outside signs in when it can, pairs when it cannot, and goes on once it holds a key", () => {
  expect(entryFor({ status: { name: "", password: true, here: false } })).toBe("/login");
  expect(entryFor({ status: { name: "", password: true, here: false }, at: "/approve?code=WDJB-MJHT" })).toBe("/login?next=%2Fapprove%3Fcode%3DWDJB-MJHT");
  expect(entryFor({ status: { name: "", password: false, here: false } })).toBe("/pair");
  expect(entryFor({ status: undefined })).toBe("/pair");
  expect(entryFor({ status: { name: "小明", password: true, here: false, device } })).toBe("");
  expect(entryFor({ status: { name: "小明", password: false, here: false, device: { ...device, came: "paired" } } })).toBe("");
});

test("signing in goes back to a page of this farm, never to another site", () => {
  expect(afterSignIn("?next=%2Fapprove%3Fcode%3DWDJB-MJHT")).toBe("/approve?code=WDJB-MJHT");
  expect(afterSignIn("")).toBe("/");
  for (const away of ["https://evil.example", "//evil.example", "/\\evil.example"]) expect(afterSignIn("?next=" + encodeURIComponent(away))).toBe("/");
});
