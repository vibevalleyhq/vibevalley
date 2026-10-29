import { expect, test } from "vite-plus/test";
import { commandOf, typedCommand } from "./commands";
test("a line that is a command runs it with the words after it; any other line is said as it is", () => {
  expect(commandOf("/issue 给打卡页加分页")).toEqual({ name: "issue", text: "给打卡页加分页" });
  expect(commandOf("  /stop  ")).toEqual({ name: "stop", text: "" });
  expect(commandOf("/remember 提交信息写中文\n别用缩写")).toEqual({ name: "remember", text: "提交信息写中文\n别用缩写" });
  expect([commandOf("/usr/bin/env"), commandOf("/issues"), commandOf("看 /issue 怎么用"), commandOf("/")]).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
});

test("the menu follows a command only while it is typed first in the box", () => {
  expect(typedCommand("/is", 3)).toEqual({ start: 0, query: "is" });
  expect(typedCommand("/", 1)).toEqual({ start: 0, query: "" });
  expect([typedCommand("/issue 标题", 9), typedCommand("说 /is", 5), typedCommand("/is", 0)]).toEqual([undefined, undefined, undefined]);
});
