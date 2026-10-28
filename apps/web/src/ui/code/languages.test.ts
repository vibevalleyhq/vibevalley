import { expect, test } from "vite-plus/test";
import { languageOf } from "./languages";

test("a file is coloured by its extension, a fence by its tag, and the rest stay plain", () => {
  expect([languageOf("src/clock.ts"), languageOf("App.TSX"), languageOf("scripts/run.sh"), languageOf("a.yml")]).toEqual([
    "typescript",
    "tsx",
    "shellscript",
    "yaml",
  ]);
  expect([languageOf("typescript"), languageOf("json")]).toEqual(["typescript", "json"]);
  expect([languageOf("notes.txt"), languageOf("Makefile"), languageOf("")]).toEqual([undefined, undefined, undefined]);
});
