import { expect, test } from "vite-plus/test";

import type { Channel, OrchestratorState, WorkspaceState } from "@vibevalley/protocol";

import { orchestratorTyping } from "./feed";
import { linkedMessages } from "./links";
import { archivedOf, groupsOf, messagePath, pointedAt, threadsIn, topsOf } from "./places";
import { switchTargets } from "./switcher";
const at = (id: string): Channel => ({ id, type: "channel", default: false, category: "", description: "", title: "", replies: 0, at: 0 });
const state = (orchestrator: OrchestratorState, where?: string): WorkspaceState => ({
  call: "idle",
  callReason: "",
  orchestrators: { orchestrator: { state: orchestrator, ...(where ? { channel: where } : {}) } },
  sessions: [],
  crons: [],
  issues: [],
  connectors: [],
});

test("the orchestrator's dots show only in the channel it thinks or writes in", () => {
  expect(orchestratorTyping(state("thinking", "c1"), at("c1"))).toEqual({ agent: "orchestrator", mood: "thinking" });
  expect(orchestratorTyping(state("speaking", "c1"), at("c1"))).toEqual({ agent: "orchestrator", mood: "speaking" });
  expect(orchestratorTyping(state("thinking", "c1"), at("c2"))).toBeUndefined();
  expect(orchestratorTyping(state("thinking"), at("c1"))).toBeUndefined();
  expect(orchestratorTyping(state("listening", "c1"), at("c1"))).toBeUndefined();
  expect(orchestratorTyping(undefined, at("c1"))).toBeUndefined();
  const two: WorkspaceState = {
    call: "idle",
    callReason: "",
    sessions: [],
    orchestrators: { orchestrator: { state: "listening" }, lead: { state: "speaking", channel: "c2" } },
    crons: [],
    issues: [],
    connectors: [],
  };
  expect([orchestratorTyping(two, at("c1")), orchestratorTyping(two, at("c2"))]).toEqual([undefined, { agent: "lead", mood: "speaking" }]);
  const since: WorkspaceState = {
    call: "idle",
    callReason: "",
    sessions: [],
    orchestrators: { lead: { state: "thinking", channel: "c2", since: 1_000 } },
    crons: [],
    issues: [],
    connectors: [],
  };
  expect(orchestratorTyping(since, at("c2"))).toEqual({ agent: "lead", mood: "thinking", since: 1_000 });
});

test("the sidebar lists the default first, then by place, grouped in the order the groups first come", () => {
  const chat = {
    ownerMentions: [],
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
    ownerMentions: [],
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

test("a message's links to farm messages are read from any host for a known channel, the default's only from this one", () => {
  const chat = { channels: [{ ...at("01a17e65-9647-7222-9a7d-06132e9d4dae") }, { ...at("g"), default: true }], ownerMentions: [] };
  const known = "01a17e65-9647-7222-9a7d-06132e9d4dae";
  const text = `看这条 http://127.0.0.1:8787/chat/${known}?m=7 还有 http://192.168.1.5:8787/chat/${known}?m=7 和 http://127.0.0.1:8787/chat?m=3、http://other:1/chat?m=4 http://x/chat/01a17e65-0000-7222-9a7d-06132e9d4dae?m=1`;
  expect(linkedMessages(text, chat, "127.0.0.1:8787")).toEqual([
    { channel: known, number: 7 },
    { channel: "g", number: 3 },
  ]);
});
