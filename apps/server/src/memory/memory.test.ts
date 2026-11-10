import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { FetchHttpClient } from "effect/http";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { defaultOrchestrator, memoryKeep } from "@vibevalley/protocol";

import { Agent } from "#/agent/agent.ts";
import { user, worker } from "#/base/actor.ts";
import { agentHome, ServerConfig } from "#/infra/config.ts";
import { Database, Db } from "#/infra/db.ts";
import { Setting } from "#/setting/setting.ts";
import { testConfig } from "#/testing/layers.ts";
import { allow, refuse } from "#/testing/refuse.ts";
import * as q from "#db/memory.sql.ts";

import { Memory, make } from "./memory.ts";
import { memoryIsNewNote, issueMemoryText, recallChars } from "./recall.ts";

const onDisk = <E>(lay: (fs: FileSystem.FileSystem, path: Path.Path) => Effect.Effect<void, E>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* lay(fs, path);
  }).pipe(Effect.provide(NodeServices.layer));

const world = (config = testConfig()) =>
  Layer.effect(Memory, make()).pipe(
    Layer.provideMerge(Agent.layer),
    Layer.provideMerge(Setting.layer),
    Layer.provideMerge(Db.layer),
    Layer.provideMerge(Database),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(Layer.succeed(ServerConfig, config)),
    Layer.provideMerge(NodeServices.layer),
  );

describe("memory", () => {
  it("builds issue memories and compares explicit notes", () => {
    expect(issueMemoryText("给打卡接口加分页", "加好了（3f2a1bc）", "completed")).toBe("给打卡接口加分页 → 加好了（3f2a1bc）");
    expect(issueMemoryText("给打卡接口加分页", "pnpm test 没过", "failed")).toBe("给打卡接口加分页 → 没做成：pnpm test 没过");
    const known = [{ id: "1", agent: "lab", kind: "note", text: "这个仓库用 pnpm test 跑测试", repo: "clock", at: 0, recalled: 0 }] as never;
    expect(memoryIsNewNote(known, "这个仓库用 pnpm test 跑测试", "clock")).toBe(false);
    expect(memoryIsNewNote(known, "这个仓库用 pnpm test 跑测试", "blog")).toBe(true);
    expect(memoryIsNewNote(known, "数据库迁移放在 db/migrations", "clock")).toBe(true);
  });

  it.effect("runs are kept, recalled and counted; notes written and forgotten", () =>
    Effect.gen(function* () {
      const m = yield* Memory;
      yield* m.write({ agent: "lab", text: "这个仓库用 pnpm test 跑测试", repo: "clock", by: worker("w1") });
      yield* m.write({ agent: "lab", text: "提交信息写中文", repo: "", by: worker("w1") });
      yield* m.keep({
        agent: "lab",
        session: "w1",
        issue: "i1",
        repo: "clock",
        brief: "加分页",
        outcome: "completed",
        said: "记住：这个仓库用 pnpm test 跑测试\n记住（所有仓库）：提交信息写中文\n结论：加好了",
        summary: "加好了",
      });
      yield* m.keep({
        agent: "lab",
        session: "w1",
        issue: "i1",
        repo: "clock",
        brief: "加分页",
        outcome: "failed",
        said: "记住：这个仓库用 pnpm test 跑测试",
        summary: "测试没过",
      });
      yield* m.keep({
        agent: "lab",
        session: "w2",
        issue: "i2",
        repo: "clock",
        brief: "不算",
        outcome: "interrupted",
        said: "记住：停下的不算",
        summary: "",
      });
      const all = yield* m.list("lab");
      expect(all.map((x) => `${x.kind}:${x.text}`).toSorted()).toEqual([
        "issue:加分页 → 没做成：测试没过",
        "note:提交信息写中文",
        "note:这个仓库用 pnpm test 跑测试",
      ]);
      expect(all.find((x) => x.text === "提交信息写中文")?.repo).toBeUndefined();
      const picked = yield* m.recall({ agent: "lab", session: "w9", repo: "clock", text: "跑测试" });
      expect(picked.ids).toHaveLength(3);
      expect(picked.lines[0]).toBe("- （这个仓库）这个仓库用 pnpm test 跑测试");
      for (const x of yield* m.list("lab")) expect([x.recalled, x.recalledAt !== undefined]).toEqual([1, true]);
      const note = yield* m.write({ agent: "lab", text: "  周末别派夜班  ", repo: " clock ", by: user });
      expect([note.text, note.repo, note.kind]).toEqual(["周末别派夜班", "clock", "note"]);
      const writtenFailure = yield* Effect.flip(m.write({ agent: "lab", text: "  ", repo: "", by: user }));
      expect(writtenFailure).toMatchObject({ _tag: "Refused", reason: "要记的话是空的" });
      yield* m.forget("lab", note.id);
      // One that is not there is missing, not silently passed over.
      expect((yield* Effect.flip(m.forget("lab", "not-a-number")))._tag).toBe("Missing");
      const ms = yield* m.list("lab");
      expect(ms).toHaveLength(3);
      const ms2 = yield* m.list("other");
      expect(ms2).toHaveLength(0);
    }).pipe(Effect.provide(world())),
  );

  it.effect("regression: orchestrator memory uses database rows and rewriting preserves the user's notes", () => {
    const config = testConfig();
    return Effect.gen(function* () {
      const m = yield* Memory;
      const port = m.forAgent(defaultOrchestrator, defaultOrchestrator);
      yield* port.remember("agent note");
      const written = yield* m.remember({ agent: defaultOrchestrator, text: "user note", repo: "", by: user });
      expect((yield* m.memoriesOf(defaultOrchestrator)).memories.map((note) => note.author)).toEqual(["user", "agent"]);
      expect((yield* port.read()).prompt).toContain("用户交代：user note");
      yield* port.rewrite("# notes\n- replacement note\n- 用户交代：user note");
      const notes = (yield* m.memoriesOf(defaultOrchestrator)).memories;
      expect(notes.map((note) => note.text)).toEqual(["replacement note", "user note"]);
      expect(notes.find((note) => note.author === "user")?.id).toBe(written.id);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const legacy = yield* fs.exists(path.join(agentHome(config, defaultOrchestrator), "MEMORY.md"));
      expect(legacy).toBe(false);
      expect((yield* m.recallOf(defaultOrchestrator, "demo", "replacement")).lines.join("\n")).toContain("replacement note");
      yield* m.forget(defaultOrchestrator, written.id);
      expect((yield* m.memoriesOf(defaultOrchestrator)).memories.map((note) => note.text)).toEqual(["replacement note"]);
    }).pipe(Effect.provide(world(config)));
  });

  it.effect("the orchestrator's archive", () => {
    const config = testConfig();
    const archived = onDisk((fs, path) =>
      Effect.gen(function* () {
        const folder = path.join(agentHome(config, defaultOrchestrator), "archive");
        yield* fs.makeDirectory(folder, { recursive: true });
        yield* fs.writeFileString(path.join(folder, "orchestrator-2026-10-12.md"), "用户：给 clock-in 加分页\n管家：派给老周了\n");
      }),
    );
    return Effect.andThen(
      archived,
      Effect.gen(function* () {
        const m = yield* Memory;
        const listing = yield* m.archive(defaultOrchestrator, "CLOCK-IN");
        expect(listing.files.map((f) => f.name)).toEqual(["orchestrator-2026-10-12.md"]);
        expect(listing.hits.map((h) => [h.file, h.line])).toEqual([["orchestrator-2026-10-12.md", 1]]);
        expect((yield* m.archive(defaultOrchestrator, "")).hits).toEqual([]);
        const archiveFile2 = yield* m.archiveFile(defaultOrchestrator, "orchestrator-2026-10-12.md");
        expect(archiveFile2).toContain("派给老周");
        const archiveFile3 = yield* m.archiveFile(defaultOrchestrator, "../MEMORY.md");
        expect(archiveFile3).toBeUndefined();
      }).pipe(Effect.provide(world(config))),
    );
  });

  it.effect("a preview picks without counting, and the longest unused fade", () =>
    Effect.gen(function* () {
      const m = yield* Memory;
      yield* m.write({ agent: "lab", text: "clock 的测试用 pnpm test", repo: "clock", by: user });
      yield* m.write({ agent: "lab", text: "提交前跑 lint", repo: "", by: user });
      const preview = yield* m.recallOf("lab", "clock", "");
      expect(preview.lines).toEqual(["- （这个仓库）clock 的测试用 pnpm test", "- （所有仓库）提交前跑 lint"]);
      expect(preview.limit).toBe(recallChars);
      for (const x of yield* m.list("lab")) expect([x.recalled, x.fading]).toEqual([0, false]);
      expect((yield* m.recallOf("lab", "", "")).lines).toEqual([]);
      for (let i = 0; i < 300 - 10; i++) yield* m.write({ agent: "lab", text: `第 ${i} 条，各不相同 ${i * 7919}`, repo: "", by: user });
      expect((yield* m.list("lab")).filter((x) => x.fading)).toHaveLength(2);
    }).pipe(Effect.provide(world())),
  );

  it.effect("the search index follows the table", () =>
    Effect.gen(function* () {
      const m = yield* Memory;
      const note = yield* m.write({ agent: "lab", text: "这个仓库测试用 pnpm test", repo: "demo", by: user });
      yield* m.write({ agent: "other", text: "测试前先装依赖", repo: "demo", by: user });
      const found = (yield* m.search({ agent: "lab", repo: "", text: "跑一遍测试", kind: "", limit: 0 })).found;
      expect(found.map((f) => f.id)).toEqual([note.id]);
      expect(found[0]!.score).toBeGreaterThan(0.5);
      yield* m.forget("lab", note.id);
      expect((yield* m.search({ agent: "lab", repo: "", text: "跑一遍测试", kind: "", limit: 0 })).found).toEqual([]);
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

  it.effect("regression: a chat run keeps explicit notes without recording work on an issue", () =>
    Effect.gen(function* () {
      const m = yield* Memory;
      yield* m.keep({ agent: "lab", session: "chat", repo: "demo", brief: "解释一下测试", outcome: "completed", said: "解释好了", summary: "解释好了" });
      const ms = yield* m.list("lab");
      expect(ms).toEqual([]);
      yield* m.write({ agent: "lab", text: "这个仓库用 pnpm test 跑测试", repo: "", by: worker("chat") });
      expect((yield* m.list("lab")).map(({ kind, text, session }) => ({ kind, text, session }))).toEqual([
        { kind: "note", text: "这个仓库用 pnpm test 跑测试", session: "chat" },
      ]);
      expect((yield* m.list("lab"))[0]?.repo).toBeUndefined();
    }).pipe(Effect.provide(world())),
  );

  it.effect("a run's notes go back when its issue memory cannot be written", () =>
    Effect.gen(function* () {
      const m = yield* Memory;
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(`select 1`);
      yield* refuse(sql, "fail_write", "before insert on memory", "new.kind = 'issue'", "write failed");
      yield* m.keep(run("s1", "记住：不要覆盖用户改动"));
      const ms = yield* m.list("lab");
      expect(ms).toEqual([]);
      yield* allow(sql, "fail_write");
      yield* m.keep(run("s1", "记住：不要覆盖用户改动"));
      const ms2 = yield* m.list("lab");
      expect(ms2).toHaveLength(1);
    }).pipe(Effect.provide(world())),
  );

  it.effect("explicit notes are independent records", () =>
    Effect.gen(function* () {
      const m = yield* Memory;
      yield* m.write({ agent: "lab", text: "use pnpm test", repo: "demo", by: worker("s1") });
      yield* m.write({ agent: "lab", text: "use pnpm test", repo: "demo", by: worker("s1") });
      const ms = yield* m.list("lab");
      expect(ms).toHaveLength(2);
    }).pipe(Effect.provide(world())),
  );

  it.effect("what is shown fading is what goes", () =>
    Effect.gen(function* () {
      // The rows below were written at 1; what is kept now is later, by the test's clock.
      yield* TestClock.setTime(Date.UTC(2026, 9, 1));
      const m = yield* Memory;
      for (let i = 0; i < memoryKeep; i++) {
        const id = `old-${String(i).padStart(3, "0")}`;
        if (i % 2 === 0) yield* q.addNote({ id, agent: "lab", body: id, terms: "", terms_of: 0, repo: null, session: null, author: "agent", created_at: 1 });
        else yield* q.keepIssueMemory({ id, agent: "lab", body: id, terms: "", terms_of: 0, repo: null, session: id, created_at: 1 });
      }
      const before = yield* m.list("lab");
      const predicted = before.filter((x) => x.fading).map((x) => x.id);
      yield* Effect.forEach(
        ["apple", "banana", "cherry", "durian", "elephant", "flamingo", "giraffe", "hamster"],
        (text, index) => m.write({ agent: "lab", text, repo: "", by: worker(String(index)) }),
        { discard: true },
      );
      yield* m.keep(run("0", ""));
      yield* m.keep(run("1", ""));
      const after = new Set((yield* m.list("lab")).map((x) => x.id));
      expect(predicted).toHaveLength(10);
      expect(before.filter((x) => !after.has(x.id)).map((x) => x.id)).toEqual(predicted);
    }).pipe(Effect.provide(world())),
  );

  it.effect("regression: a legacy memory path cannot interfere with database memory", () => {
    const config = testConfig();
    const legacy = onDisk((fs, path) => fs.makeDirectory(path.join(agentHome(config, defaultOrchestrator), "MEMORY.md"), { recursive: true }));
    return Effect.andThen(
      legacy,
      Effect.gen(function* () {
        const m = yield* Memory;
        const note = yield* m.remember({ agent: defaultOrchestrator, text: "database memory", repo: "", by: user });
        expect((yield* m.memoriesOf(defaultOrchestrator)).memories[0]?.id).toBe(note.id);
        expect((yield* Effect.flip(m.previewForget("orchestrator", "m1")))._tag).toBe("Missing");
        expect((yield* Effect.flip(m.forget("orchestrator", "m1")))._tag).toBe("Missing");
      }).pipe(Effect.provide(world(config))),
    );
  });
});
