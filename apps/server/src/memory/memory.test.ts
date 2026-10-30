import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { remember, rewriteMemory } from "@vibevalley/agent/memory";
import { defaultOrchestrator, memoryKeep } from "@vibevalley/protocol";

import { Agents } from "@/agent/agent.ts";
import { owner } from "@/base/actor.ts";
import { agentHome, ServerConfig } from "@/base/config.ts";
import { Database, Db } from "@/base/db.ts";
import { Setting } from "@/setting/setting.ts";
import { testConfig } from "@/testing/layers.ts";

import * as q from "../../db/generated/memory.sql.ts";
import { Memories, make } from "./memory.ts";
import { memoryIsNewNote, memoryJobText, memoryNotesOf, recallChars } from "./recall.ts";

const world = (config = testConfig()) =>
  Layer.effect(Memories, make()).pipe(
    Layer.provideMerge(Agents.layer),
    Layer.provideMerge(Setting.layer),
    Layer.provideMerge(Db.layer),
    Layer.provideMerge(Database),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(Layer.succeed(ServerConfig, config)),
  );

describe("memory", () => {
  it("the 记住 lines of a run", () => {
    const said = [
      "改好了，测试也过了。",
      "",
      "记住：这个项目用 pnpm test 跑测试，不要用 npm",
      "- 记住：迁移文件在 db/migrations",
      "**记住（所有项目）：** 主人要提交信息写中文",
      "记住：这个项目用 pnpm test 跑测试，不要用 npm",
      "要记住的是别的事",
      "记住：",
      "",
      "结论：加好了分页（3f2a1bc）。",
    ].join("\n");
    expect(memoryNotesOf(said)).toEqual([
      { text: "这个项目用 pnpm test 跑测试，不要用 npm", everywhere: false },
      { text: "迁移文件在 db/migrations", everywhere: false },
      { text: "主人要提交信息写中文", everywhere: true },
    ]);
    expect(memoryNotesOf(Array.from({ length: 9 }, (_, i) => `记住：第 ${i} 条`).join("\n"))).toHaveLength(5);
    expect(memoryNotesOf("结论：做完了。")).toEqual([]);
    expect(memoryNotesOf("Remember: tests run with pnpm test\n- **Remember (all projects):** commit messages in English")).toEqual([
      { text: "tests run with pnpm test", everywhere: false },
      { text: "commit messages in English", everywhere: true },
    ]);
    expect(memoryJobText("给打卡接口加分页", "加好了（3f2a1bc）", "completed")).toBe("给打卡接口加分页 → 加好了（3f2a1bc）");
    expect(memoryJobText("给打卡接口加分页", "pnpm test 没过", "failed")).toBe("给打卡接口加分页 → 没做成：pnpm test 没过");
    const known = [{ id: "1", agent: "lab", kind: "note", text: "这个项目用 pnpm test 跑测试", project: "clock", at: 0, recalled: 0 }] as never;
    expect(memoryIsNewNote(known, "这个项目用 pnpm test 跑测试", "clock")).toBe(false);
    expect(memoryIsNewNote(known, "这个项目用 pnpm test 跑测试", "blog")).toBe(true);
    expect(memoryIsNewNote(known, "数据库迁移放在 db/migrations", "clock")).toBe(true);
  });

  it.effect("runs are kept, recalled and counted; notes written and forgotten", () =>
    Effect.gen(function* () {
      const m = yield* Memories;
      yield* m.keep({
        agent: "lab",
        session: "w1",
        project: "clock",
        job: "加分页",
        outcome: "completed",
        said: "记住：这个项目用 pnpm test 跑测试\n记住（所有项目）：提交信息写中文\n结论：加好了",
        summary: "加好了",
      });
      yield* m.keep({
        agent: "lab",
        session: "w1",
        project: "clock",
        job: "加分页",
        outcome: "failed",
        said: "记住：这个项目用 pnpm test 跑测试",
        summary: "测试没过",
      });
      yield* m.keep({ agent: "lab", session: "w2", project: "clock", job: "不算", outcome: "interrupted", said: "记住：停下的不算", summary: "" });
      const all = yield* m.list("lab");
      expect(all.map((x) => `${x.kind}:${x.text}`).toSorted()).toEqual([
        "issue:加分页 → 没做成：测试没过",
        "note:提交信息写中文",
        "note:这个项目用 pnpm test 跑测试",
      ]);
      expect(all.find((x) => x.text === "提交信息写中文")?.project).toBeUndefined();
      const picked = yield* m.recall({ agent: "lab", session: "w9", project: "clock", text: "跑测试" });
      expect(picked.ids).toHaveLength(3);
      expect(picked.lines[0]).toBe("- （这个项目）这个项目用 pnpm test 跑测试");
      for (const x of yield* m.list("lab")) expect([x.recalled, x.recalledAt !== undefined]).toEqual([1, true]);
      const note = yield* m.write({ agent: "lab", text: "  周末别派夜班  ", project: " clock ", by: owner });
      expect([note.text, note.project, note.kind]).toEqual(["周末别派夜班", "clock", "note"]);
      expect(yield* Effect.flip(m.write({ agent: "lab", text: "  ", project: "", by: owner }))).toMatchObject({ _tag: "Refused", reason: "要记的话是空的" });
      yield* m.forget("lab", note.id);
      // One that is not there is missing, not silently passed over.
      expect((yield* Effect.flip(m.forget("lab", "not-a-number")))._tag).toBe("Missing");
      expect(yield* m.list("lab")).toHaveLength(3);
      expect(yield* m.list("other")).toHaveLength(0);
    }).pipe(Effect.provide(world())),
  );

  it.effect("the orchestrator's MEMORY.md: its lines, the owner's marked, dated, forgotten", () => {
    const config = testConfig();
    const folder = agentHome(config, defaultOrchestrator);
    return Effect.gen(function* () {
      const m = yield* Memories;
      expect((yield* m.memoriesOf("orchestrator")).memories).toEqual([]);
      remember(folder, "主人喜欢早上收到汇报", new Date(2026, 9, 12, 9));
      const written = yield* m.remember({ agent: "orchestrator", text: "  周末别派夜班\n真的  ", project: "", by: owner });
      expect([written.text, written.session]).toEqual(["周末别派夜班 真的", undefined]);
      expect(readFileSync(join(folder, "MEMORY.md"), "utf8")).toContain("主人交代：周末别派夜班 真的");
      const view = yield* m.memoriesOf("orchestrator");
      expect(view.memories.map((x) => [x.text, x.session])).toEqual([
        ["周末别派夜班 真的", undefined],
        ["主人喜欢早上收到汇报", "orchestrator"],
      ]);
      expect(view.memories[1]!.at).toBe(new Date(2026, 9, 12).getTime());
      expect(view.carried).toBe(2);
      yield* m.forget("orchestrator", view.memories[1]!.id);
      expect((yield* m.memoriesOf("orchestrator")).memories.map((x) => x.text)).toEqual(["周末别派夜班 真的"]);
      expect(yield* Effect.flip(m.remember({ agent: "orchestrator", text: "  ", project: "", by: owner }))).toMatchObject({
        _tag: "Refused",
        reason: "要记的话是空的",
      });
      rewriteMemory(folder, ("- 2026-10-13 " + "字".repeat(100) + "\n").repeat(100));
      const carried = (yield* m.memoriesOf("orchestrator")).carried!;
      expect(carried > 0 && carried < 100).toBe(true);
      rewriteMemory(folder, "# header\n- first\n* second\nplain third\n");
      expect((yield* m.memoriesOf("orchestrator")).carried).toBe(3);
      expect(yield* Effect.flip(m.recallOf("orchestrator", "", ""))).toMatchObject({ _tag: "Refused", reason: expect.stringMatching(/整份记性/u) });
    }).pipe(Effect.provide(world(config)));
  });

  it.effect("the orchestrator's archive", () => {
    const config = testConfig();
    const folder = agentHome(config, defaultOrchestrator);
    mkdirSync(join(folder, "archive"), { recursive: true });
    writeFileSync(join(folder, "archive", "orchestrator-2026-10-12.md"), "主人：给 clock-in 加分页\n管家：派给老周了\n");
    return Effect.gen(function* () {
      const m = yield* Memories;
      const listing = m.archive(defaultOrchestrator, "CLOCK-IN");
      expect(listing.files.map((f) => f.name)).toEqual(["orchestrator-2026-10-12.md"]);
      expect(listing.hits.map((h) => [h.file, h.line])).toEqual([["orchestrator-2026-10-12.md", 1]]);
      expect(m.archive(defaultOrchestrator, "").hits).toEqual([]);
      expect(m.archiveFile(defaultOrchestrator, "orchestrator-2026-10-12.md")).toContain("派给老周");
      expect(m.archiveFile(defaultOrchestrator, "../MEMORY.md")).toBeUndefined();
    }).pipe(Effect.provide(world(config)));
  });

  it.effect("a preview picks without counting, and the longest unused fade", () =>
    Effect.gen(function* () {
      const m = yield* Memories;
      yield* m.write({ agent: "lab", text: "clock 的测试用 pnpm test", project: "clock", by: owner });
      yield* m.write({ agent: "lab", text: "提交前跑 lint", project: "", by: owner });
      const preview = yield* m.recallOf("lab", "clock", "");
      expect(preview.lines).toEqual(["- （这个项目）clock 的测试用 pnpm test", "- （所有项目）提交前跑 lint"]);
      expect(preview.limit).toBe(recallChars);
      for (const x of yield* m.list("lab")) expect([x.recalled, x.fading]).toEqual([0, false]);
      expect((yield* m.recallOf("lab", "", "")).lines).toEqual([]);
      for (let i = 0; i < 300 - 10; i++) yield* m.write({ agent: "lab", text: `第 ${i} 条，各不相同 ${i * 7919}`, project: "", by: owner });
      expect((yield* m.list("lab")).filter((x) => x.fading)).toHaveLength(2);
    }).pipe(Effect.provide(world())),
  );

  it.effect("the search index follows the table", () =>
    Effect.gen(function* () {
      const m = yield* Memories;
      const note = yield* m.write({ agent: "lab", text: "这个项目测试用 pnpm test", project: "demo", by: owner });
      yield* m.write({ agent: "other", text: "测试前先装依赖", project: "demo", by: owner });
      const found = (yield* m.search({ agent: "lab", project: "", text: "跑一遍测试", kind: "", limit: 0 })).found;
      expect(found.map((f) => f.id)).toEqual([note.id]);
      expect(found[0]!.score).toBeGreaterThan(0.5);
      yield* m.forget("lab", note.id);
      expect((yield* m.search({ agent: "lab", project: "", text: "跑一遍测试", kind: "", limit: 0 })).found).toEqual([]);
    }).pipe(Effect.provide(world())),
  );

  it("different notes without terms are not duplicates", () => {
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

  const run = (session: string, said: string) => ({ agent: "lab", session, project: "demo", job: "work", said, summary: "", outcome: "completed" as const });

  it.effect("a run's notes go back when its job cannot be written", () =>
    Effect.gen(function* () {
      const m = yield* Memories;
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(`create function fail_job() returns trigger language plpgsql as $$ begin raise exception 'write failed'; end $$`);
      yield* sql.unsafe(`create trigger fail_job before insert on memory for each row when (new.kind = 'issue') execute function fail_job()`);
      yield* m.keep(run("s1", "记住：不要覆盖用户改动"));
      expect(yield* m.list("lab")).toEqual([]);
      yield* sql.unsafe(`drop trigger fail_job on memory`);
      yield* m.keep(run("s1", "记住：不要覆盖用户改动"));
      expect(yield* m.list("lab")).toHaveLength(2);
    }).pipe(Effect.provide(world())),
  );

  it.effect("nearly the same notes in one run are kept once", () =>
    Effect.gen(function* () {
      const m = yield* Memories;
      yield* m.keep(run("s1", "记住：use pnpm test\n记住：use pnpm test!"));
      expect(yield* m.list("lab")).toHaveLength(2);
    }).pipe(Effect.provide(world())),
  );

  it.effect("what is shown fading is what goes", () =>
    Effect.gen(function* () {
      // The rows below were written at 1; what is kept now is later, by the test's clock.
      yield* TestClock.setTime(Date.UTC(2026, 9, 1));
      const m = yield* Memories;
      for (let i = 0; i < memoryKeep; i++) {
        const id = `old-${String(i).padStart(3, "0")}`;
        if (i % 2 === 0)
          yield* q.addNote({ id, agent: "lab", body: id, terms: "", terms_of: 0, project: null, session: null, author: "session", created_at: 1 });
        else yield* q.keepJob({ id, agent: "lab", body: id, terms: "", terms_of: 0, project: null, session: id, created_at: 1 });
      }
      const before = yield* m.list("lab");
      const predicted = before.filter((x) => x.fading).map((x) => x.id);
      yield* m.keep(run("0", "记住：apple\n记住：banana\n记住：cherry\n记住：durian"));
      yield* m.keep(run("1", "记住：elephant\n记住：flamingo\n记住：giraffe\n记住：hamster"));
      const after = new Set((yield* m.list("lab")).map((x) => x.id));
      expect(predicted).toHaveLength(10);
      expect(before.filter((x) => !after.has(x.id)).map((x) => x.id)).toEqual(predicted);
    }).pipe(Effect.provide(world())),
  );

  it.effect("forget and its preview turn file failures into Refused", () => {
    const config = testConfig();
    mkdirSync(join(agentHome(config, defaultOrchestrator), "MEMORY.md"), { recursive: true });
    return Effect.gen(function* () {
      const m = yield* Memories;
      expect((yield* Effect.flip(m.previewForget("orchestrator", "m1")))._tag).toBe("Refused");
      expect((yield* Effect.flip(m.forget("orchestrator", "m1")))._tag).toBe("Refused");
    }).pipe(Effect.provide(world(config)));
  });
});
