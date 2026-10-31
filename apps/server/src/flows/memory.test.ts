import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { Agent, Memory } from "@vibevalley/protocol";

import { Agents } from "@/agent/agent.ts";
import { owner } from "@/base/actor.ts";
import { Core } from "@/core/core.ts";
import { Issues } from "@/issue/issue.ts";
import { Memories } from "@/memory/memory.ts";
import { briefBreak } from "@/session/briefing.ts";
import { recallHead } from "@/session/prompts.ts";
import { Sessions } from "@/session/session.ts";
import { testConfig } from "@/testing/layers.ts";

import { await_, farm, type Farm, lab, mustHire, watch } from "./farm.ts";

const scribe = (): Agent => ({ ...lab(), id: "scribe", name: "记录员" });
const refiner = (): Agent => ({ ...lab(), id: "refiner", name: "起草员" });

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
  Effect.flatMap(Memories, (m) =>
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
    const f = farm();
    const next = prompts(f);
    return Effect.gen(function* () {
      const w = yield* watch;
      const issues = yield* Issues;
      const sessions = yield* Sessions;
      const memories = yield* Memories;
      const core = yield* Core;
      const lastText = (id: string, summary: string) => sessions.find(id)?.lastText ?? summary;

      const first = mustHire(yield* issues.hire(scribe(), "写上班打卡，记一笔", "memo"));
      expect(yield* nextPrompt(f, next, 0)).toBe("写上班打卡，记一笔");
      const report = yield* w.nextReport;
      expect(report.outcome).toBe("completed");
      const text = lastText(report.id, report.summary);
      expect(text).toMatch(/｜人设：[\s\S]*「记住：」/u);
      expect(text).toMatch(/\n记住：这个项目用 pnpm test 跑测试\n记住（所有项目）：提交信息写中文$/u);

      const mine = yield* kept("scribe", 3);
      expect(mine).toHaveLength(3);
      const done = mine.find((m) => m.kind === "issue")!;
      expect(done.text).toMatch(/^写上班打卡，记一笔 → /u);
      const rows = (ms: Memory[]) => ms.map((m) => [m.kind, m.text, m.project ?? "所有项目", m.session ?? ""].join("|")).toSorted();
      expect(rows(mine)).toEqual(
        [
          ["note", "这个项目用 pnpm test 跑测试", "memo", first.id],
          ["note", "提交信息写中文", "所有项目", first.id],
          ["issue", done.text, "memo", first.id],
        ]
          .map((r) => r.join("|"))
          .toSorted(),
      );
      expect(yield* memories.list(first.id)).toEqual([]);

      yield* sessions.dismiss(first.id);
      const second = mustHire(yield* issues.hire(scribe(), "再加一个下班打卡", "memo"));
      let [recalled, asked] = reminded(yield* nextPrompt(f, next, 1));
      expect(asked).toBe("再加一个下班打卡");
      expect([...recalled].toSorted()).toEqual(
        ["- （这个项目）这个项目用 pnpm test 跑测试", "- （所有项目）提交信息写中文", "- 做过（这个项目）：" + done.text].toSorted(),
      );
      yield* w.nextReport;
      const steps = sessions.events(second.id)!;
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
        project: "memo",
        by: owner,
      });
      expect((yield* sessions.deliver(second.id, "顺手把下班打卡的测试也补上", { kind: "comment" })).kind).toBe("run");
      [recalled, asked] = reminded(yield* nextPrompt(f, next, 2));
      expect([recalled, asked]).toEqual([["- （这个项目）下班打卡也要有测试"], "顺手把下班打卡的测试也补上"]);
      yield* w.nextReport;

      mustHire(yield* issues.hire(scribe(), "写一篇博客", "memo-blog"));
      [recalled, asked] = reminded(yield* nextPrompt(f, next, 3));
      expect([recalled, asked]).toEqual([["- （所有项目）提交信息写中文"], "写一篇博客"]);
      yield* w.nextReport;

      const other = mustHire(yield* issues.hire(refiner(), "跑一遍 pnpm test 测试，看看上班打卡", "memo"));
      expect(yield* nextPrompt(f, next, 4)).toBe("跑一遍 pnpm test 测试，看看上班打卡");
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
    const before = farm({ config });
    const next = prompts(before);
    let session = "";
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const w = yield* watch;
        const issues = yield* Issues;
        const sessions = yield* Sessions;
        // Waking after the restart reads the agent from the store, as in real use.
        yield* (yield* Agents).save(scribe());
        const noted = mustHire(yield* issues.hire(scribe(), "写上班打卡，记一笔", "memo"));
        yield* nextPrompt(before, next, 0);
        yield* w.nextReport;
        yield* kept("scribe", 3);
        yield* sessions.dismiss(noted.id);
        session = mustHire(yield* issues.hire(scribe(), "再加一个下班打卡", "memo")).id;
        const [recalled] = reminded(yield* nextPrompt(before, next, 1));
        expect(recalled).toHaveLength(3);
        yield* w.nextReport;
      }).pipe(Effect.scoped, Effect.provide(before.layer));

      const after = farm({ config });
      const again = prompts(after);
      yield* Effect.gen(function* () {
        const w = yield* watch;
        const sessions = yield* Sessions;
        yield* kept("scribe", 3);
        expect((yield* sessions.deliver(session, "顺手把下班打卡的测试也补上", { kind: "comment" })).kind).toBe("run");
        expect(yield* nextPrompt(after, again, 0)).toBe("顺手把下班打卡的测试也补上");
        yield* w.nextReport;
      }).pipe(Effect.scoped, Effect.provide(after.layer));
    });
  });
});
