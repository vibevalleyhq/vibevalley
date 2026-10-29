import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

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
