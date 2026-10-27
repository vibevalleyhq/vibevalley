import { expect, test } from "vite-plus/test";
import type { Channel, WorkspaceState } from "@vibevalley/protocol";
import { archivedOf, groupsOf, messagePath, orchestratorTyping, pointedAt, switchTargets, threadsIn, topsOf } from "./rules";

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

test("Ctrl+K lists places by what is typed: a name starting with it first, then the unread, then the newest", () => {
  const chat = {
    channels: [
      { ...at("g"), default: true, name: "general", at: 1 },
      { ...at("f"), name: "frontend", category: "dev", at: 5 },
      { ...at("b"), name: "backend", unread: 2, at: 2 },
      { ...at("old"), name: "front-old", archived: 9, at: 9 },
      { ...at("d"), type: "direct" as const, peer: "profile:lab", title: "Lab", at: 3 },
      { ...at("t"), type: "thread" as const, parent: "f", title: "the front page", at: 4 },
    ],
  };
  const profiles = [
    { id: "lab", name: "Lab" },
    { id: "docs", name: "Docs" },
  ];
  const ids = (q: string) => switchTargets(chat, q, { profiles }).map((t) => t.id);
  expect(ids("")).toEqual(["b", "f", "t", "d", "g", "docs"]);
  expect(ids("front")).toEqual(["f", "t"]);
  expect(ids("#end")).toEqual(["b", "f"]);
  expect(ids("@")).toEqual(["d", "docs"]);
  expect(switchTargets(chat, "front", { profiles })[1]).toMatchObject({ kind: "thread", hint: "#frontend" });
});
