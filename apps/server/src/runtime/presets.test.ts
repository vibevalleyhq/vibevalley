import { expect, test } from "vite-plus/test";

import type { AccountUsage } from "@vibevalley/protocol";

import { sampleAgent } from "#/agent/seed.ts";

import { chooseAgent } from "./presets.ts";
import { quotaLeft, quotaOf, quotaText } from "./quota.ts";

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
