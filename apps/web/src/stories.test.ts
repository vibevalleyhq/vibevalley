import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { levels } from "./storyLevels";

const ui = join(import.meta.dirname, "ui");

const without: Record<string, string> = {
  "A.tsx": "a link that moves the router: it draws a plain <a>",
  "TitleBar.tsx": "the desktop window's strip, from the host",
};

test("every part in ui/ has stories, or a reason not to", () => {
  const missing = readdirSync(ui, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".stories.tsx") && !(f in without))
    .filter((f) => !existsSync(join(ui, f.replace(/\.tsx$/, ".stories.tsx"))));
  expect(missing).toEqual([]);
});

test("no reason is kept for a part that is gone or has stories", () => {
  const stale = Object.keys(without).filter((f) => !existsSync(join(ui, f)) || existsSync(join(ui, f.replace(/\.tsx$/, ".stories.tsx"))));
  expect(stale).toEqual([]);
});

test("every stories file sits on a level of the pyramid", () => {
  const src = import.meta.dirname;
  const off = readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".stories.tsx"))
    .map((f) => [f, /title: "([^"]+)"/.exec(readFileSync(join(src, f), "utf8"))?.[1] ?? ""] as const)
    .filter(([, title]) => !levels.some((l) => title.startsWith(`${l}/`)))
    .map(([f, title]) => `${f}: ${title}`);
  expect(off).toEqual([]);
});
