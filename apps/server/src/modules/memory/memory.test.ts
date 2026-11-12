import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { sleep } from "@vibevalley/async";
import { defaultOrchestrator, memoryKeep } from "@vibevalley/protocol";
import { ApiError, BizCode } from "@vibevalley/protocol/api";

import { user, worker } from "#/base/actor.ts";
import { agentHome } from "#/infra/config.ts";
import { testConfig } from "#/testing/layers.ts";
import { allow, refuse } from "#/testing/refuse.ts";
import * as q from "#db/memory.sql.ts";

import { memoryIsNewNote, issueMemoryText, recallChars } from "./recall.ts";
import { memoryWorld } from "./testWorld.ts";

const refusal = async (p: Promise<unknown>): Promise<ApiError> => {
  const e = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(e instanceof ApiError)) throw new Error(`not refused: ${String(e)}`);
  return e;
};

describe("memory", () => {
  test("builds issue memories and compares explicit notes", () => {
    expect(issueMemoryText("给打卡接口加分页", "加好了（3f2a1bc）", "completed")).toBe("给打卡接口加分页 → 加好了（3f2a1bc）");
    expect(issueMemoryText("给打卡接口加分页", "pnpm test 没过", "failed")).toBe("给打卡接口加分页 → 没做成：pnpm test 没过");
    const known = [{ id: "1", agent: "lab", kind: "note", text: "这个仓库用 pnpm test 跑测试", repo: "clock", at: 0, recalled: 0 }] as never;
    expect(memoryIsNewNote(known, "这个仓库用 pnpm test 跑测试", "clock")).toBe(false);
    expect(memoryIsNewNote(known, "这个仓库用 pnpm test 跑测试", "blog")).toBe(true);
    expect(memoryIsNewNote(known, "数据库迁移放在 db/migrations", "clock")).toBe(true);
  });

  test("runs are kept, recalled and counted; notes written and forgotten", async () => {
    await using w = await memoryWorld(testConfig());
    const m = w.memory;
    await m.write({ agent: "lab", text: "这个仓库用 pnpm test 跑测试", repo: "clock", by: worker("w1") });
    await m.write({ agent: "lab", text: "提交信息写中文", repo: "", by: worker("w1") });
    await m.keep({
      agent: "lab",
      session: "w1",
      issue: "i1",
      repo: "clock",
      brief: "加分页",
      outcome: "completed",
      said: "记住：这个仓库用 pnpm test 跑测试\n记住（所有仓库）：提交信息写中文\n结论：加好了",
      summary: "加好了",
    });
    await m.keep({
      agent: "lab",
      session: "w1",
      issue: "i1",
      repo: "clock",
      brief: "加分页",
      outcome: "failed",
      said: "记住：这个仓库用 pnpm test 跑测试",
      summary: "测试没过",
    });
    await m.keep({
      agent: "lab",
      session: "w2",
      issue: "i2",
      repo: "clock",
      brief: "不算",
      outcome: "interrupted",
      said: "记住：停下的不算",
      summary: "",
    });
    const all = await m.list("lab");
    expect(all.map((x) => `${x.kind}:${x.text}`).toSorted()).toEqual([
      "issue:加分页 → 没做成：测试没过",
      "note:提交信息写中文",
      "note:这个仓库用 pnpm test 跑测试",
    ]);
    expect(all.find((x) => x.text === "提交信息写中文")?.repo).toBeUndefined();
    const picked = await m.recall({ agent: "lab", session: "w9", repo: "clock", text: "跑测试" });
    expect(picked.ids).toHaveLength(3);
    expect(picked.lines[0]).toBe("- （这个仓库）这个仓库用 pnpm test 跑测试");
    for (const x of await m.list("lab")) expect([x.recalled, x.recalledAt !== undefined]).toEqual([1, true]);
    const note = await m.write({ agent: "lab", text: "  周末别派夜班  ", repo: " clock ", by: user });
    expect([note.text, note.repo, note.kind]).toEqual(["周末别派夜班", "clock", "note"]);
    const writtenFailure = await refusal(m.write({ agent: "lab", text: "  ", repo: "", by: user }));
    expect(writtenFailure).toMatchObject({ bizCode: BizCode.MemoryRefused, message: "要记的话是空的" });
    await m.forget("lab", note.id);
    // One that is not there is missing, not silently passed over.
    expect((await refusal(m.forget("lab", "not-a-number"))).bizCode).toBe(BizCode.MemoryNotFound);
    const ms = await m.list("lab");
    expect(ms).toHaveLength(3);
    const ms2 = await m.list("other");
    expect(ms2).toHaveLength(0);
  });

  test("regression: orchestrator memory uses database rows and rewriting preserves the user's notes", async () => {
    const config = testConfig();
    await using w = await memoryWorld(config);
    {
      const m = w.memory;
      const port = m.forAgent(defaultOrchestrator, defaultOrchestrator);
      await port.remember("agent note");
      const written = await m.remember({ agent: defaultOrchestrator, text: "user note", repo: "", by: user });
      expect((await m.memoriesOf(defaultOrchestrator)).memories.map((note) => note.author)).toEqual(["user", "agent"]);
      expect((await port.read()).prompt).toContain("用户交代：user note");
      await port.rewrite("# notes\n- replacement note\n- 用户交代：user note");
      const notes = (await m.memoriesOf(defaultOrchestrator)).memories;
      expect(notes.map((note) => note.text)).toEqual(["replacement note", "user note"]);
      expect(notes.find((note) => note.author === "user")?.id).toBe(written.id);
      const legacy = existsSync(join(agentHome(config, defaultOrchestrator), "MEMORY.md"));
      expect(legacy).toBe(false);
      expect((await m.recallOf(defaultOrchestrator, "demo", "replacement")).lines.join("\n")).toContain("replacement note");
      await m.forget(defaultOrchestrator, written.id);
      expect((await m.memoriesOf(defaultOrchestrator)).memories.map((note) => note.text)).toEqual(["replacement note"]);
    }
  });

  test("a preview picks without counting, and the longest unused fade", async () => {
    await using w = await memoryWorld(testConfig());
    const m = w.memory;
    await m.write({ agent: "lab", text: "clock 的测试用 pnpm test", repo: "clock", by: user });
    await m.write({ agent: "lab", text: "提交前跑 lint", repo: "", by: user });
    const preview = await m.recallOf("lab", "clock", "");
    expect(preview.lines).toEqual(["- （这个仓库）clock 的测试用 pnpm test", "- （所有仓库）提交前跑 lint"]);
    expect(preview.limit).toBe(recallChars);
    for (const x of await m.list("lab")) expect([x.recalled, x.fading]).toEqual([0, false]);
    expect((await m.recallOf("lab", "", "")).lines).toEqual([]);
    for (let i = 0; i < 300 - 10; i++) await m.write({ agent: "lab", text: `第 ${i} 条，各不相同 ${i * 7919}`, repo: "", by: user });
    expect((await m.list("lab")).filter((x) => x.fading)).toHaveLength(2);
  });

  test("the search index follows the table", async () => {
    await using w = await memoryWorld(testConfig());
    const m = w.memory;
    const note = await m.write({ agent: "lab", text: "这个仓库测试用 pnpm test", repo: "demo", by: user });
    await m.write({ agent: "other", text: "测试前先装依赖", repo: "demo", by: user });
    const found = (await m.search({ agent: "lab", repo: "", text: "跑一遍测试", kind: "", limit: 0 })).found;
    expect(found.map((f) => f.id)).toEqual([note.id]);
    expect(found[0]!.score).toBeGreaterThan(0.5);
    await m.forget("lab", note.id);
    expect((await m.search({ agent: "lab", repo: "", text: "跑一遍测试", kind: "", limit: 0 })).found).toEqual([]);
  });

  test("different notes without terms are not duplicates", () => {
    for (const [a, b] of [
      ["甲", "乙"],
      ["a", "b"],
      ["✅", "❌"],
    ]) {
      const known = [{ kind: "note", text: a }] as never;
      expect(memoryIsNewNote(known, b!, undefined)).toBe(true);
      expect(memoryIsNewNote(known, a!, undefined)).toBe(false);
    }
  });

  const run = (session: string, said: string) => ({
    agent: "lab",
    session,
    issue: "i1",
    repo: "demo",
    brief: "work",
    said,
    summary: "",
    outcome: "completed" as const,
  });

  test("regression: a chat run keeps explicit notes without recording work on an issue", async () => {
    await using w = await memoryWorld(testConfig());
    const m = w.memory;
    await m.keep({ agent: "lab", session: "chat", repo: "demo", brief: "解释一下测试", outcome: "completed", said: "解释好了", summary: "解释好了" });
    const ms = await m.list("lab");
    expect(ms).toEqual([]);
    await m.write({ agent: "lab", text: "这个仓库用 pnpm test 跑测试", repo: "", by: worker("chat") });
    expect((await m.list("lab")).map(({ kind, text, session }) => ({ kind, text, session }))).toEqual([
      { kind: "note", text: "这个仓库用 pnpm test 跑测试", session: "chat" },
    ]);
    expect((await m.list("lab"))[0]?.repo).toBeUndefined();
  });

  test("a run's notes go back when its issue memory cannot be written", async () => {
    await using w = await memoryWorld(testConfig());
    const m = w.memory;
    const sql = w.db.sql;
    await refuse(sql, "fail_write", "before insert on memory", "new.kind = 'issue'", "write failed");
    await m.keep(run("s1", "记住：不要覆盖用户改动"));
    const ms = await m.list("lab");
    expect(ms).toEqual([]);
    await allow(sql, "fail_write");
    await m.keep(run("s1", "记住：不要覆盖用户改动"));
    const ms2 = await m.list("lab");
    expect(ms2).toHaveLength(1);
  });

  test("explicit notes are independent records", async () => {
    await using w = await memoryWorld(testConfig());
    const m = w.memory;
    await m.write({ agent: "lab", text: "use pnpm test", repo: "demo", by: worker("s1") });
    await m.write({ agent: "lab", text: "use pnpm test", repo: "demo", by: worker("s1") });
    const ms = await m.list("lab");
    expect(ms).toHaveLength(2);
  });

  test("what is shown fading is what goes", async () => {
    // The rows below were written at 1; what is kept now is later, by the test's clock.
    await using w = await memoryWorld(testConfig(), { clock: { now: () => Date.UTC(2026, 9, 1), sleep } });
    const m = w.memory;
    for (let i = 0; i < memoryKeep; i++) {
      const id = `old-${String(i).padStart(3, "0")}`;
      if (i % 2 === 0)
        await q.addNote(w.db.sql, { id, agent: "lab", body: id, terms: "", terms_of: 0, repo: null, session: null, author: "agent", created_at: 1 });
      else await q.keepIssueMemory(w.db.sql, { id, agent: "lab", body: id, terms: "", terms_of: 0, repo: null, session: id, created_at: 1 });
    }
    const before = await m.list("lab");
    const predicted = before.filter((x) => x.fading).map((x) => x.id);
    for (const [index, text] of ["apple", "banana", "cherry", "durian", "elephant", "flamingo", "giraffe", "hamster"].entries())
      await m.write({ agent: "lab", text, repo: "", by: worker(String(index)) });
    await m.keep(run("0", ""));
    await m.keep(run("1", ""));
    const after = new Set((await m.list("lab")).map((x) => x.id));
    expect(predicted).toHaveLength(10);
    expect(before.filter((x) => !after.has(x.id)).map((x) => x.id)).toEqual(predicted);
  });

  test("regression: a legacy memory path cannot interfere with database memory", async () => {
    const config = testConfig();
    mkdirSync(join(agentHome(config, defaultOrchestrator), "MEMORY.md"), { recursive: true });
    await using w = await memoryWorld(config);
    const m = w.memory;
    const note = await m.remember({ agent: defaultOrchestrator, text: "database memory", repo: "", by: user });
    expect((await m.memoriesOf(defaultOrchestrator)).memories[0]?.id).toBe(note.id);
    expect((await refusal(m.previewForget("orchestrator", "m1"))).bizCode).toBe(BizCode.MemoryNotFound);
    expect((await refusal(m.forget("orchestrator", "m1"))).bizCode).toBe(BizCode.MemoryNotFound);
  });
});
