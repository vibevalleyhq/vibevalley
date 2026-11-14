import { expect, it, test } from "vite-plus/test";

import { artifactId, blockId } from "@vibevalley/protocol/schema";

import type { Envelope } from "./envelope.ts";
import { messageLine, wakeInput } from "./prompts.ts";

test("regression: a delivery batch includes every acknowledged card", () => {
  const messages: Envelope[] = Array.from({ length: 5 }, (_, i) => ({
    id: `delivery-${i}`,
    number: i + 1,
    target: "#room",
    from: "user",
    actor: { kind: "user", id: "user", name: "user" },
    name: "user",
    text: `body-text-${i}`,
  }));
  const input = wakeInput(messages, []);
  for (const message of messages) expect(input).toContain(message.text);
});

const said = {
  id: "m",
  number: 1,
  target: "#general",
  from: "user",
  actor: { kind: "user" as const, id: "user", name: "用户" },
  name: "用户",
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
