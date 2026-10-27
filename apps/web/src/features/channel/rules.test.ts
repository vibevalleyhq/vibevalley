import { expect, test } from "vite-plus/test";
import type { Channel, WorkspaceState } from "@vibevalley/protocol";
import { archivedOf, groupsOf, messagePath, orchestratorTyping, pointedAt, threadsIn, topsOf } from "./rules";

const at = (id: string): Channel => ({ id, type: "channel", replies: 0, at: 0 });
const state = (orchestrator: WorkspaceState["orchestrator"], where?: string): WorkspaceState => ({
  call: "idle",
  orchestrator,
  ...(where ? { orchestratorChannel: where } : {}),
  sessions: [],
});

test("the orchestrator's dots show only in the channel it thinks or writes in", () => {
  expect(orchestratorTyping(state("thinking", "c1"), at("c1"))).toBe("thinking");
  expect(orchestratorTyping(state("speaking", "c1"), at("c1"))).toBe("speaking");
  expect(orchestratorTyping(state("thinking", "c1"), at("c2"))).toBeUndefined();
  expect(orchestratorTyping(state("thinking"), at("c1"))).toBeUndefined();
  expect(orchestratorTyping(state("listening", "c1"), at("c1"))).toBeUndefined();
  expect(orchestratorTyping(undefined, at("c1"))).toBeUndefined();
});

test("the sidebar lists the default first, then by place, grouped in the order the groups first come", () => {
  const chat = {
    channels: [
      { ...at("b"), position: 2, category: "work" },
      { ...at("a"), position: 1 },
      { ...at("z"), default: true },
      { ...at("c"), position: 0, category: "work" },
      { ...at("old"), archived: 5 },
      { ...at("t"), type: "thread" as const, parent: "a" },
    ],
  };
  const tops = topsOf(chat);
  expect(tops.map((c) => c.id)).toEqual(["z", "c", "a", "b"]);
  expect(groupsOf(tops).map((g) => [g.category, g.channels.map((c) => c.id)])).toEqual([
    [undefined, ["z", "a"]],
    ["work", ["c", "b"]],
  ]);
  expect(archivedOf(chat).map((c) => c.id)).toEqual(["old"]);
  expect(threadsIn(chat, tops[2]!).map((c) => c.id)).toEqual(["t"]);
});

test("a message's address names its number, which the page reads back", () => {
  expect(messagePath(at("c1"), 7)).toBe("/chat/c1?m=7");
  expect(messagePath({ ...at("g"), default: true }, 3)).toBe("/chat?m=3");
  expect(pointedAt("/chat/c1?m=7")).toBe(7);
  expect(pointedAt("/chat/c1")).toBeUndefined();
});
