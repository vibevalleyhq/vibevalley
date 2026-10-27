import { expect, test } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { framesOf, groupsOf, naturalCompare, pictureMatches, picturesOf, remakeOf, shelfOf } from "./rules";

const pictures = picturesOf(JSON.parse(readFileSync(join(import.meta.dirname, "../../../public/pixel/sprites.json"), "utf8")));
const byName = new Map(pictures.map((p) => [p.name, p]));

test("the manifest in art pixels, with heads and sheets", () => {
  const bear = byName.get("bear-farmer-down")!;
  expect(bear.hx).toBeDefined();
  expect(bear.sheet).toBe("design/pixel/raw/char-bear.png");
  expect(remakeOf(bear)).toEqual({ draw: "design/pixel/gen.sh char-bear", cut: "python3 design/pixel/process.py char-bear" });
});

test("shelves", () => {
  expect(shelfOf("bear-farmer-down")).toBe("helpers");
  expect(shelfOf("manager-face")).toBe("orchestrator");
  expect(shelfOf("map")).toBe("yard");
  expect(shelfOf("lang-go")).toBe("langs");
  expect(shelfOf("day-0")).toBe("ui");
  expect(shelfOf("connector-qq")).toBe("logos");
  expect(shelfOf("something-new")).toBe("other");
  const helpers = groupsOf(
    "helpers",
    pictures.filter((p) => shelfOf(p.name) === "helpers"),
  );
  expect(helpers[0]!.label).toBe("熊 · 农夫");
  expect(helpers.every((g) => g.pictures.every((p) => p.name.startsWith(g.key)))).toBe(true);
});

test("frames and matching", () => {
  const names = new Set(["walk", "walk-1", "walk-2", "run-1", "run-2", "run-3", "lone-1"]);
  const has = (n: string) => names.has(n);
  expect(framesOf("walk", has)).toEqual(["walk-1", "walk", "walk-2", "walk"]);
  expect(framesOf("run-2", has)).toEqual(["run-1", "run-2", "run-3"]);
  expect(framesOf("lone-1", has)).toBeUndefined();
  expect(pictureMatches(byName.get("bear-rain-down") ?? byName.get("bear-farmer-down")!, "熊")).toBe(true);
  expect(pictureMatches(byName.get("lang-go")!, "语言")).toBe(true);
  expect(pictureMatches(byName.get("lang-go")!, "熊")).toBe(false);
  expect(naturalCompare("x-2", "x-10")).toBeLessThan(0);
});
