import { describe, expect, test } from "vite-plus/test";

import type { Issue, Session, StateFrame } from "@vibevalley/protocol";

import { glanceOf } from "./island";

const issue = (number: number, state: Issue["attention"]["state"], more: Partial<Issue["attention"]> = {}, sessions: string[] = []) =>
  ({ id: `i${number}`, number, title: `第 ${number} 张`, sessions, attention: { state, acts: [], ...more } }) as unknown as Issue;

const working = (id: string, name: string, label: string) =>
  ({ id, name, phase: { _tag: "working", since: 0, doing: { action: "run_command", label } } }) as unknown as Session;

const frame = (issues: Issue[], sessions: Session[] = []) => ({ state: { issues, sessions } }) as unknown as StateFrame;

describe("the island's glance", () => {
  test("shows the issues in flight, those waiting on the owner first", () => {
    const g = glanceOf(
      frame(
        [
          issue(3, "working", {}, ["w1"]),
          issue(1, "draft"),
          issue(5, "reviewing"),
          issue(2, "stuck", { stuck: "conflict" }),
          issue(4, "done"),
          issue(6, "queued"),
          issue(7, "asking"),
        ],
        [working("w1", "阿狐", "vp test")],
      ),
      0,
    );
    expect(g.working).toBe(1);
    expect(g.waiting).toBe(3);
    expect(g.rows.map((r) => [r.number, r.tone, r.doing])).toEqual([
      [2, "stuck", "有冲突"],
      [5, "waiting", "等你验收"],
      [7, "waiting", "等你回答"],
      [3, "working", "阿狐 · 在跑命令：vp test"],
    ]);
  });

  test("is empty when nothing is in flight; an issue at work with no helper (the orchestrator's) says so", () => {
    expect(glanceOf(frame([issue(1, "done"), issue(2, "canceled")]), 0)).toEqual({
      working: 0,
      waiting: 0,
      strip: { working: "没在干", waiting: "0 等你" },
      rows: [],
    });
    expect(glanceOf(frame([issue(9, "working")]), 0).rows).toEqual([{ issue: "i9", number: 9, title: "第 9 张", doing: "在做", tone: "working" }]);
  });
});
