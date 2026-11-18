import { expect, open, test } from "nsh/test";

test("agent stories render", async () => {
  const app = await open("./stories/main.tsx", { width: 720, height: 1400 });
  const t = app.texts();
  expect(t).toContain("Used 6 tools");
  expect(t).toContain("Using tools…");
  expect(t).toContain("Failed");
  expect(t).toContain("Tool calls from this run will appear here.");
});
