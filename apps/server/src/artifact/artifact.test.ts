import { describe, expect, it } from "@effect/vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ownerId } from "@vibevalley/protocol";
import { artifactMax } from "./rules.ts";
import { Effect } from "effect";
import { Settings } from "../base/config.ts";
import { Channels } from "../channel/chat.ts";
import { worldBelowTasks } from "../testing/world.ts";
import { Artifacts } from "./artifact.ts";

const owner = { from: ownerId, by: ownerId };
const page = (words: string) => `<!doctype html><title>${words}</title><p>${words}</p>`;

describe("an artifact", () => {
  it.live("is announced with its card where it belongs, and a new version keeps the old ones readable", () =>
    Effect.gen(function* () {
      const artifacts = yield* Artifacts;
      const chat = yield* Channels;
      const general = chat.defaultChannel();
      const made = yield* artifacts.create(owner, { title: " 详情：抽屉还是整页 ", kind: "html", content: page("抽屉"), note: "两种" });
      expect(made).toMatchObject({ title: "详情：抽屉还是整页", body: "html", channel: general, by: ownerId, version: 1 });
      expect(made.versions).toEqual([expect.objectContaining({ version: 1, note: "两种", channel: general, number: expect.any(Number) })]);
      const said = (yield* chat.history(general)).at(-1)!;
      expect(said.artifact).toEqual({ id: made.id, title: "详情：抽屉还是整页", body: "html", version: 1, note: "两种" });
      expect(said.number).toBe(made.versions[0]!.number);

      const next = yield* artifacts.version(owner, { id: made.id, content: page("整页"), note: "加了整页" });
      expect([next.version, next.versions.map((v) => v.version)]).toEqual([2, [1, 2]]);
      expect((yield* chat.history(general)).at(-1)!.artifact).toMatchObject({ id: made.id, version: 2, note: "加了整页" });
      expect(yield* artifacts.content(made.id)).toMatchObject({ version: 2, content: page("整页"), body: "html" });
      expect(yield* artifacts.content(made.id, 1)).toMatchObject({ version: 1, content: page("抽屉") });
      expect(yield* Effect.flip(artifacts.content(made.id, 3))).toMatchObject({ _tag: "Missing" });

      const forIssue = yield* artifacts.create(owner, { title: "调研", kind: "markdown", content: "# 结论\n\n用抽屉。", issue: "issue-1" });
      expect((yield* artifacts.list({ issue: "issue-1" })).map((a) => a.id)).toEqual([forIssue.id]);
      expect((yield* artifacts.list({ channel: general })).map((a) => a.id)).toEqual([forIssue.id, made.id]);
      expect((yield* artifacts.list({})).length).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(worldBelowTasks())),
  );

  it.live("handed in as Markdown is read into blocks to write on together, and takes no new version", () =>
    Effect.gen(function* () {
      const artifacts = yield* Artifacts;
      const chat = yield* Channels;
      const made = yield* artifacts.create({ from: ownerId, by: "lab" }, { title: "调研", kind: "markdown", content: "# 结论\n\n用**抽屉**。", note: "初稿" });
      expect(made).toMatchObject({ body: "blocks", version: 0, seq: 1, versions: [] });
      expect((yield* chat.history(chat.defaultChannel())).at(-1)!.artifact).toEqual({ id: made.id, title: "调研", body: "blocks", version: 0, note: "初稿" });
      const snap = yield* artifacts.blocks(made.id);
      expect([snap.artifact.id, snap.blocks.map((b) => [b.type, b.updatedBy])]).toEqual([
        made.id,
        [
          ["heading", "lab"],
          ["paragraph", "lab"],
        ],
      ]);
      expect(yield* artifacts.content(made.id)).toEqual({ version: 1, content: "# 结论\n\n用**抽屉**。\n", body: "blocks" });
      expect(yield* Effect.flip(artifacts.version(owner, { id: made.id, content: "x" }))).toMatchObject({ _tag: "Refused" });
    }).pipe(Effect.scoped, Effect.provide(worldBelowTasks())),
  );

  it.live("started on the page with a title is empty, announced nowhere, and an html one has no blocks", () =>
    Effect.gen(function* () {
      const artifacts = yield* Artifacts;
      const chat = yield* Channels;
      const before = (yield* chat.history(chat.defaultChannel())).length;
      const blank = yield* artifacts.create(owner, { title: "周报" });
      expect(blank).toMatchObject({ body: "blocks", version: 0, seq: 0, by: ownerId });
      expect(blank.channel).toBeUndefined();
      expect([(yield* artifacts.blocks(blank.id)).blocks, (yield* chat.history(chat.defaultChannel())).length]).toEqual([[], before]);
      const html = yield* artifacts.create(owner, { title: "页", kind: "html", content: page("页") });
      expect(yield* Effect.flip(artifacts.blocks(html.id))).toMatchObject({ _tag: "Refused" });
      expect((yield* artifacts.rename(blank.id, "  第 43 周  ")).title).toBe("第 43 周");
      expect(yield* Effect.flip(artifacts.rename(blank.id, " "))).toMatchObject({ _tag: "Refused" });
    }).pipe(Effect.scoped, Effect.provide(worldBelowTasks())),
  );

  it.live("refuses what it cannot be, and says which", () =>
    Effect.gen(function* () {
      const artifacts = yield* Artifacts;
      const refusedFor = (title: string, kind: string, content: string) => Effect.flip(artifacts.create(owner, { title, kind: kind as "html", content }));
      expect(yield* refusedFor("", "html", page("a"))).toMatchObject({ _tag: "Refused" });
      expect(yield* refusedFor("a", "pdf", page("a"))).toMatchObject({ _tag: "Refused" });
      expect(yield* refusedFor("a", "html", "")).toMatchObject({ _tag: "Refused" });
      expect(yield* refusedFor("a", "html", "x".repeat(artifactMax + 1))).toMatchObject({ _tag: "Refused" });
      expect(yield* Effect.flip(artifacts.version(owner, { id: "nope", content: "x" }))).toMatchObject({ _tag: "Missing" });
      expect(yield* Effect.flip(artifacts.create(owner, { title: "a", kind: "html", content: "x", channel: "#nowhere" }))).toMatchObject({
        _tag: "Missing",
      });
      expect(yield* artifacts.list({})).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(worldBelowTasks())),
  );

  it.live("goes with its versions, and its content files go once no other artifact keeps them", () =>
    Effect.gen(function* () {
      const artifacts = yield* Artifacts;
      const chat = yield* Channels;
      const dir = join((yield* Settings).home, "artifacts");
      const same = page("同一页");
      const one = yield* artifacts.create(owner, { title: "一", kind: "html", content: same });
      yield* artifacts.version(owner, { id: one.id, content: page("一的第二版") });
      const two = yield* artifacts.create(owner, { title: "二", kind: "html", content: same });
      expect(readdirSync(dir).length).toBe(2);
      expect((yield* artifacts.previewRemove(one.id)).does.length).toBeGreaterThan(0);
      yield* artifacts.remove(one.id);
      expect(yield* Effect.flip(artifacts.get(one.id))).toMatchObject({ _tag: "Missing" });
      // 「同一页」 is still two's.
      expect(readdirSync(dir).length).toBe(1);
      yield* artifacts.remove(two.id);
      expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
      // Its cards stay in the conversation.
      expect((yield* chat.history(chat.defaultChannel())).filter((m) => m.artifact).length).toBe(3);
    }).pipe(Effect.scoped, Effect.provide(worldBelowTasks())),
  );
});
