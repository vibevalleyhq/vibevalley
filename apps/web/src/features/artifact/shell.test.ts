import { expect, test } from "vite-plus/test";

import { selectionOf, shellPath } from "./shell";

test("a frame's message is the shell's selection only in its one shape", () => {
  const anchor = { kind: "text", exact: "brave", prefix: "Hello ", suffix: " world" };
  expect(selectionOf({ vibevalley: "selection", anchor })).toEqual(anchor);
  expect(selectionOf({ vibevalley: "selection", anchor, extra: 1 })).toEqual(anchor);
  for (const other of [
    null,
    "selection",
    { vibevalley: "height", anchor },
    { vibevalley: "selection" },
    { vibevalley: "selection", anchor: null },
    { vibevalley: "selection", anchor: { ...anchor, kind: "element" } },
    { vibevalley: "selection", anchor: { ...anchor, exact: 1 } },
    { vibevalley: "selection", anchor: { ...anchor, prefix: "x".repeat(65) } },
  ])
    expect(selectionOf(other)).toBeUndefined();
  expect(shellPath("a", 2)).toBe("/api/v1/artifact/a/2?shell=1&display=page&theme=light");
  expect(shellPath("a", 2, "slides", "dark")).toBe("/api/v1/artifact/a/2?shell=1&display=slides&theme=dark");
});
