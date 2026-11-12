import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import type * as T from "@vibevalley/protocol";

import { user } from "#/base/actor.ts";
import type { Memory } from "#/modules/memory/memory.ts";
import { briefBreak } from "#/modules/session/briefing.ts";
import { recallHead } from "#/modules/session/prompts.ts";
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
const kept = (fw: { readonly memory: Memory }, agent: string, n: number) =>
  await_(
    () => fw.memory.list(agent),
    (got) => got.length >= n,
    `${agent} remembers ${n}`,
  );

/** The next turn's input, once the farm has started it. */
const nextPrompt = async (f: Farm, next: () => string, seen: number) => {
  await await_(
    () => f.turns.length,
    (n) => n > seen,
    "a session was prompted",
  );
  return next();
};

describe("memory", () => {
  test("is kept by one session and recalled by the next", async () => {
    const firstTurn = Promise.withResolvers<void>();
    const f = farm({ beforeTurn: async (_turn, _input, n) => (n === 0 ? firstTurn.promise : Promise.resolve()) });
    const next = prompts(f);
    await using fw = await f.open();
    const w = watch(fw);
    const issues = fw.issue;
    const sessions = fw.inside;
    const memories = fw.memory;
    const core = fw.core;
    const lastText = (id: string, summary: string) => sessions.lastTextOf(id) || summary;

    const hired = await issues.hire(scribe(), "写上班打卡，记一笔", "memo");
    const first = mustHire(hired);
    const nextPrompt2 = await nextPrompt(f, next, 0);
    expect(nextPrompt2).toBe("写上班打卡，记一笔");
    await sessions.report(first.id, {
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
    const report = await w.nextReport();
    expect(report.outcome).toBe("completed");
    const text = lastText(report.id, report.summary);
    expect(text).toContain("issue_report.remember");

    const mine = await kept(fw, "scribe", 3);
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
    const memories2 = await memories.list(first.id);
    expect(memories2).toEqual([]);

    await sessions.dismiss(first.id);
    const hired2 = await issues.hire(scribe(), "再加一个下班打卡", "memo");
    const second = mustHire(hired2);
    const hiredPrompt = await nextPrompt(f, next, 1);
    let [recalled, asked] = reminded(hiredPrompt);
    expect(asked).toBe("再加一个下班打卡");
    expect([...recalled].toSorted()).toEqual(
      ["- （这个仓库）这个仓库用 pnpm test 跑测试", "- （所有仓库）提交信息写中文", "- 做过（这个仓库）：" + done.text].toSorted(),
    );
    await w.nextReport();
    const steps = (await sessions.events(second.id)) ?? [];
    expect(steps[0]!.type).toBe("run/start");
    expect([steps[1]!.type, steps[1]!.text, steps[2]!.type, steps[2]!.text]).toEqual([
      "user/message",
      "再加一个下班打卡",
      "memory/recalled",
      recalled.join("\n"),
    ]);

    await memories.write({
      agent: "scribe",
      text: "下班打卡也要有测试",
      repo: "memo",
      by: user,
    });
    expect((await sessions.deliver(second.id, "顺手把下班打卡的测试也补上", delivery({ kind: "comment" }))).kind).toBe("run");
    const commentPrompt = await nextPrompt(f, next, 2);
    [recalled, asked] = reminded(commentPrompt);
    expect([recalled, asked]).toEqual([["- （这个仓库）下班打卡也要有测试"], "顺手把下班打卡的测试也补上"]);
    await w.nextReport();

    const hired3 = await issues.hire(scribe(), "写一篇博客", "memo-blog");
    mustHire(hired3);
    const blogPrompt = await nextPrompt(f, next, 3);
    [recalled, asked] = reminded(blogPrompt);
    expect([recalled, asked]).toEqual([["- （所有仓库）提交信息写中文"], "写一篇博客"]);
    await w.nextReport();

    const hired4 = await issues.hire(refiner(), "跑一遍 pnpm test 测试，看看上班打卡", "memo");
    const other = mustHire(hired4);
    const nextPrompt3 = await nextPrompt(f, next, 4);
    expect(nextPrompt3).toBe("跑一遍 pnpm test 测试，看看上班打卡");
    await w.nextReport();
    const theirs = await kept(fw, "refiner", 1);
    expect(theirs.map((m) => [m.kind, m.session])).toEqual([["issue", other.id]]);
    for (const h of core.state().sessions) await sessions.dismiss(h.id);
  });

  test("is recalled once across a restart", async () => {
    // A database on disk, so the memories outlive the restart as they do in real use.
    const base = testConfig();
    const config = { ...base, db: join(base.home, "db") };
    const firstTurn = Promise.withResolvers<void>();
    const before = farm({ config, beforeTurn: async (_turn, _input, n) => (n === 0 ? firstTurn.promise : Promise.resolve()) });
    const next = prompts(before);
    let session = "";
    {
      await using fw = await before.open();
      const w = watch(fw);
      const issues = fw.issue;
      const sessions = fw.inside;
      // Waking after the restart reads the agent from the store, as in real use.
      await fw.agent.save(scribe());
      const hired = await issues.hire(scribe(), "写上班打卡，记一笔", "memo");
      const noted = mustHire(hired);
      await nextPrompt(before, next, 0);
      await sessions.report(noted.id, {
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
      await w.nextReport();
      await kept(fw, "scribe", 3);
      await sessions.dismiss(noted.id);
      const hired2 = await issues.hire(scribe(), "再加一个下班打卡", "memo");
      session = mustHire(hired2).id;
      const nextPrompt2 = await nextPrompt(before, next, 1);
      const [recalled] = reminded(nextPrompt2);
      expect(recalled).toHaveLength(3);
      await w.nextReport();
    }

    const after = farm({ config });
    const again = prompts(after);
    {
      await using fw = await after.open();
      const w = watch(fw);
      const sessions = fw.inside;
      await kept(fw, "scribe", 3);
      expect((await sessions.deliver(session, "顺手把下班打卡的测试也补上", delivery({ kind: "comment" }))).kind).toBe("run");
      const nextPrompt2 = await nextPrompt(after, again, 0);
      expect(nextPrompt2).toBe("顺手把下班打卡的测试也补上");
      await w.nextReport();
    }
  });
});
