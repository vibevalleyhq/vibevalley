import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type * as T from "@vibevalley/protocol";

import { user } from "#/base/actor.ts";
import { Core } from "#/core/core.ts";
import { Agent } from "#/modules/agent/agent.ts";
import { Issue } from "#/modules/issue/issue.ts";
import { Memory } from "#/modules/memory/memory.ts";
import { briefBreak } from "#/modules/session/briefing.ts";
import { recallHead } from "#/modules/session/prompts.ts";
import { Session } from "#/modules/session/session.ts";
import type { DeliveryInput } from "#/modules/session/signals.ts";
import { testConfig } from "#/testing/layers.ts";

import { await_, farm, type Farm, lab, mustHire, watch } from "./farm.ts";

const scribe = (): T.Agent => ({ ...lab(), id: "scribe", name: "记录员" });
const refiner = (): T.Agent => ({ ...lab(), id: "refiner", name: "起草员" });
const delivery = (trigger: T.RunTrigger): DeliveryInput => ({ trigger, envelopeIds: [], byUserComment: false });

/** Each turn's input in order, as its session was prompted. */
const prompts = (f: Farm) => {
  let taken = 0;
  return () => {
    if (taken === f.turns.length) throw new Error("no session was prompted");
    return f.turns[taken++]!.input;
  };
};

/** What the input reminded the session of, and its brief under it. */
const reminded = (input: string): [string[], string] => {
  const parts = input.split(briefBreak);
  if (parts.length === 1) return [[], input];
  const lines = parts[0]!.split("\n");
  if (parts.length !== 2 || !lines[0]!.startsWith(recallHead)) throw new Error("on top of the brief is not just what it was reminded of: " + input);
  return [lines.slice(1), parts[1]!];
};

/** A finished turn is kept in the background. */
const kept = (agent: string, n: number) =>
  Effect.flatMap(Memory, (m) =>
    await_(
      () => m.list(agent),
      (got) => got.length >= n,
      `${agent} remembers ${n}`,
    ),
  );

/** The next turn's input, once the farm has started it. */
const nextPrompt = (f: Farm, next: () => string, seen: number) =>
  Effect.map(
    await_(
      () => f.turns.length,
      (n) => n > seen,
      "a session was prompted",
    ),
    () => next(),
  );

describe("memory", () => {
  it.live("is kept by one session and recalled by the next", () => {
    const firstTurn = Promise.withResolvers<void>();
    const f = farm({ beforeTurn: async (_turn, _input, n) => (n === 0 ? firstTurn.promise : Promise.resolve()) });
    const next = prompts(f);
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issue;
      const sessions = yield* Session;
      const memories = yield* Memory;
      const core = yield* Core;
      const lastText = (id: string, summary: string) => sessions.lastTextOf(id) || summary;

      const hired = yield* issues.hire(scribe(), "写上班打卡，记一笔", "memo");
      const first = mustHire(hired);
      const nextPrompt2 = yield* nextPrompt(f, next, 0);
      expect(nextPrompt2).toBe("写上班打卡，记一笔");
      yield* sessions.report(first.id, {
        summary: "写好了",
        questions: [],
        checks: [],
        remember: [
          { text: "这个仓库用 pnpm test 跑测试", scope: "repo" },
          { text: "提交信息写中文", scope: "all" },
        ],
        prSubmit: false,
      });
      firstTurn.resolve();
      const report = yield* w.nextReport;
      expect(report.outcome).toBe("completed");
      const text = lastText(report.id, report.summary);
      expect(text).toContain("issue_report.remember");

      const mine = yield* kept("scribe", 3);
      expect(mine).toHaveLength(3);
      const done = mine.find((m) => m.kind === "issue")!;
      expect(done.text).toMatch(/^写上班打卡，记一笔 → /u);
      const rows = (ms: T.Memory[]) => ms.map((m) => [m.kind, m.text, m.repo ?? "所有仓库", m.session ?? ""].join("|")).toSorted();
      expect(rows(mine)).toEqual(
        [
          ["note", "这个仓库用 pnpm test 跑测试", "memo", first.id],
          ["note", "提交信息写中文", "所有仓库", first.id],
          ["issue", done.text, "memo", first.id],
        ]
          .map((r) => r.join("|"))
          .toSorted(),
      );
      const memories2 = yield* memories.list(first.id);
      expect(memories2).toEqual([]);

      yield* sessions.dismiss(first.id);
      const hired2 = yield* issues.hire(scribe(), "再加一个下班打卡", "memo");
      const second = mustHire(hired2);
      const hiredPrompt = yield* nextPrompt(f, next, 1);
      let [recalled, asked] = reminded(hiredPrompt);
      expect(asked).toBe("再加一个下班打卡");
      expect([...recalled].toSorted()).toEqual(
        ["- （这个仓库）这个仓库用 pnpm test 跑测试", "- （所有仓库）提交信息写中文", "- 做过（这个仓库）：" + done.text].toSorted(),
      );
      yield* w.nextReport;
      const steps = (yield* sessions.events(second.id)) ?? [];
      expect(steps[0]!.type).toBe("run/start");
      expect([steps[1]!.type, steps[1]!.text, steps[2]!.type, steps[2]!.text]).toEqual([
        "user/message",
        "再加一个下班打卡",
        "memory/recalled",
        recalled.join("\n"),
      ]);

      yield* memories.write({
        agent: "scribe",
        text: "下班打卡也要有测试",
        repo: "memo",
        by: user,
      });
      expect((yield* sessions.deliver(second.id, "顺手把下班打卡的测试也补上", delivery({ kind: "comment" }))).kind).toBe("run");
      const commentPrompt = yield* nextPrompt(f, next, 2);
      [recalled, asked] = reminded(commentPrompt);
      expect([recalled, asked]).toEqual([["- （这个仓库）下班打卡也要有测试"], "顺手把下班打卡的测试也补上"]);
      yield* w.nextReport;

      const hired3 = yield* issues.hire(scribe(), "写一篇博客", "memo-blog");
      mustHire(hired3);
      const blogPrompt = yield* nextPrompt(f, next, 3);
      [recalled, asked] = reminded(blogPrompt);
      expect([recalled, asked]).toEqual([["- （所有仓库）提交信息写中文"], "写一篇博客"]);
      yield* w.nextReport;

      const hired4 = yield* issues.hire(refiner(), "跑一遍 pnpm test 测试，看看上班打卡", "memo");
      const other = mustHire(hired4);
      const nextPrompt3 = yield* nextPrompt(f, next, 4);
      expect(nextPrompt3).toBe("跑一遍 pnpm test 测试，看看上班打卡");
      yield* w.nextReport;
      const theirs = yield* kept("refiner", 1);
      expect(theirs.map((m) => [m.kind, m.session])).toEqual([["issue", other.id]]);
      for (const h of core.state().sessions) yield* sessions.dismiss(h.id);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.live("is recalled once across a restart", () => {
    // A database on disk, so the memories outlive the restart as they do in real use.
    const base = testConfig();
    const config = { ...base, db: join(base.home, "db") };
    const firstTurn = Promise.withResolvers<void>();
    const before = farm({ config, beforeTurn: async (_turn, _input, n) => (n === 0 ? firstTurn.promise : Promise.resolve()) });
    const next = prompts(before);
    let session = "";
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const w = yield* watch;
        const issues = yield* Issue;
        const sessions = yield* Session;
        // Waking after the restart reads the agent from the store, as in real use.
        yield* (yield* Agent).save(scribe());
        const hired = yield* issues.hire(scribe(), "写上班打卡，记一笔", "memo");
        const noted = mustHire(hired);
        yield* nextPrompt(before, next, 0);
        yield* sessions.report(noted.id, {
          summary: "写好了",
          questions: [],
          checks: [],
          remember: [
            { text: "这个仓库用 pnpm test 跑测试", scope: "repo" },
            { text: "提交信息写中文", scope: "all" },
          ],
          prSubmit: false,
        });
        firstTurn.resolve();
        yield* w.nextReport;
        yield* kept("scribe", 3);
        yield* sessions.dismiss(noted.id);
        const hired2 = yield* issues.hire(scribe(), "再加一个下班打卡", "memo");
        session = mustHire(hired2).id;
        const nextPrompt2 = yield* nextPrompt(before, next, 1);
        const [recalled] = reminded(nextPrompt2);
        expect(recalled).toHaveLength(3);
        yield* w.nextReport;
      }).pipe(Effect.scoped, Effect.provide(before.layer));

      const after = farm({ config });
      const again = prompts(after);
      yield* Effect.gen(function* () {
        const w = yield* watch;
        const sessions = yield* Session;
        yield* kept("scribe", 3);
        expect((yield* sessions.deliver(session, "顺手把下班打卡的测试也补上", delivery({ kind: "comment" }))).kind).toBe("run");
        const nextPrompt2 = yield* nextPrompt(after, again, 0);
        expect(nextPrompt2).toBe("顺手把下班打卡的测试也补上");
        yield* w.nextReport;
      }).pipe(Effect.scoped, Effect.provide(after.layer));
    });
  });
});
