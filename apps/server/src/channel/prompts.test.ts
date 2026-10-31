import { expect, it } from "vite-plus/test";

import { artifactId, blockId } from "@vibevalley/protocol/schema";

import { messageLine } from "./prompts.ts";

const said = {
  id: "m",
  number: 1,
  target: "#general",
  from: "owner",
  fromKind: "owner" as const,
  name: "主人",
  text: "看这块",
};

it("tells a helper which block a message points at, the version quoted and how it reads now", () => {
  const line = messageLine({
    ...said,
    blocks: [{ artifactId: artifactId("a"), blockId: blockId("b"), rev: 1, title: "周报", type: "paragraph", text: "原来", nowRev: 2 }],
  });
  expect(line).toContain("artifact=a block=b");
  expect(line).toContain("引用时第 1 版");
  expect(line).toContain("现在第 2 版");
  expect(line).toContain("原来");
});

it("says a quoted block is gone rather than showing words that no longer count", () => {
  const line = messageLine({
    ...said,
    blocks: [{ artifactId: artifactId("a"), blockId: blockId("b"), rev: 1, title: "周报", deleted: true }],
  });
  expect(line).toContain("已删除");
  expect(line).not.toContain("原来");
});
