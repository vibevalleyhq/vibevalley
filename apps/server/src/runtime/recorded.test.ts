import { expect, test } from "vite-plus/test";

import type { AccountUsage, Agent, RuntimeInfo } from "@vibevalley/protocol";

import { sampleAgent } from "@/testing/agents.ts";
import { checkCases, goldenCases } from "@/testing/golden.ts";

import { agentProblems, chooseAgent } from "./fit.ts";
import { factsOf } from "./presets.ts";
import { moneyStop, quotaLeft, quotaOf, quotaText } from "./quota.ts";

test("the recorded cases", () => {
  const cases = goldenCases("runtime");
  expect(new Set(cases.map((c) => c.fn)).size).toBe(3);
  const failed = checkCases(cases, (c) => {
    switch (c.fn) {
      case "moneyStop":
        return moneyStop((c.in as RuntimeInfo | null) ?? undefined) || null;
      case "quota":
        return {
          left: quotaLeft(c.in as AccountUsage) ?? null,
          text: quotaText(c.in as AccountUsage),
        };
      case "agentProblems": {
        // Recorded before a runtime always carried its facts: one recorded without them has its own.
        const i = c.in as { agent: Agent; runtime: (Omit<RuntimeInfo, "facts"> & Partial<Pick<RuntimeInfo, "facts">>) | null };
        return agentProblems(i.agent, i.runtime ? { ...i.runtime, facts: i.runtime.facts ?? factsOf(i.runtime.id) } : undefined);
      }
      default:
        throw new Error(`line ${c.line}: no rule ${c.fn}`);
    }
  });
  expect(failed).toEqual([]);
});

test("quota in words", () => {
  const ok = (...windows: [string, number][]): AccountUsage => ({
    status: "ok",
    subscription: null,
    windows: windows.map(([label, usedPercent]) => ({ label, usedPercent, resetsAt: null })),
  });
  expect(quotaText(ok(["5 小时", 33.3]))).toBe("5 小时 剩 66.7%");
  expect(quotaLeft(ok(["", 30], ["", 120]))).toBe(0);
  expect(quotaOf(ok(["5 小时", 40]))).toEqual({ left: 60, text: "5 小时 剩 60%" });
  expect(quotaOf({ status: "login_required" }).left).toBeUndefined();
});

test("choose a profile", () => {
  const a = sampleAgent({ id: "a", name: "甲", runtime: "pi", tags: ["前端"] });
  const b = sampleAgent({ id: "b", name: "乙", runtime: "claude", tags: ["测试", "后端"] });
  const candidates = [
    { agent: a, usable: true },
    { agent: b, usable: true },
  ];
  expect(chooseAgent(candidates, "随便", "乙", "")?.id).toBe("b");
  expect(chooseAgent(candidates, "随便", "claude", "")?.id).toBe("b");
  expect(chooseAgent(candidates, "随便", "", "b")?.id).toBe("b");
  expect(chooseAgent(candidates, "补后端测试", "", "")?.id).toBe("b");
  expect(chooseAgent(candidates, "随便", "", "")?.id).toBe("a");
});
