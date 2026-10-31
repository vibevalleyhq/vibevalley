import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { t } from "@vibevalley/i18n";
import type { ArtifactId, BlockOp } from "@vibevalley/protocol";
import { artifactId, blockId, type Wire } from "@vibevalley/protocol/schema";

import { newId } from "@/base/ids.ts";
import { orMissing } from "@/errors.ts";
import { ServerConfig } from "@/infra/config.ts";
import { Database, Db } from "@/infra/db.ts";
import { sampleAgent } from "@/testing/agents.ts";
import { testConfig } from "@/testing/layers.ts";
import { waitFor } from "@/testing/until.ts";

import * as qa from "../../db/generated/artifact.sql.ts";
import { type BlockStoreOptions, makeBlockStore } from "./blocks.ts";
import { demoPieces } from "./demo.ts";
import { plain } from "./spans.ts";
import { bold, para, sample, span } from "./testing.ts";

const on = (config: ServerConfig["Service"] = testConfig()) =>
  Db.layer.pipe(Layer.provideMerge(Database), Layer.provideMerge(Layer.succeed(ServerConfig, config)));

/** The blocks of artifacts made straight in the table: the rest of the Artifact service (channels, cards) is artifact.test.ts's. */
const make = (options: BlockStoreOptions = {}) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const row = (id: string) => db.one(qa.artifact({ id })).pipe(orMissing(id, []));
    const blocks = yield* makeBlockStore(row, options);
    const get = (id: ArtifactId) =>
      Effect.gen(function* () {
        const list = yield* blocks.blocks(id);
        const r = yield* row(id);
        return { artifact: { id: artifactId(r.id), title: r.title, seq: r.seq }, blocks: list };
      });
    const create = (title: string) =>
      Effect.gen(function* () {
        const id = artifactId(newId());
        yield* db.run(
          qa.addArtifact({
            id,
            title: title.trim() || t("server.artifact.untitled"),
            body: "blocks",
            channel_id: null,
            issue: null,
            by_id: "owner",
            by_name: "主人",
            version: 0,
            created_at: 0,
          }),
        );
        return yield* get(id);
      });
    const list = () => db.run(qa.artifacts({ limit_n: 100n }));
    const importMarkdown = (title: string, markdown: string, actor: string) =>
      Effect.gen(function* () {
        const made = yield* create(title);
        yield* blocks.fill(made.artifact.id, markdown, actor);
        return yield* get(made.artifact.id);
      });
    return { ...blocks, get, create, list, importMarkdown };
  });

type Service = Effect.Success<ReturnType<typeof make>>;

const submit = (s: Service, doc: ArtifactId, batchId: string, ...ops: Wire<BlockOp>[]) => s.submit(doc, "owner", { batchId, ops: ops as BlockOp[] });

const texts = (blocks: { text: { t: string }[] }[]) => blocks.map((b) => plain(b.text as never)).join("|");

const helpers = (...list: [string, boolean][]) => list.map(([id, enabled]) => sampleAgent({ id, enabled }));

const finished = (s: Service) =>
  waitFor(
    Effect.map(TestClock.adjust(1_000), () => s.demoRunning()),
    (running) => !running,
    "the demo finished",
  );

describe("a blocks artifact", () => {
  it.effect("what one person writes is there after the server starts again", () => {
    const config = { ...testConfig(), db: "" };
    return Effect.gen(function* () {
      const id = yield* Effect.scoped(
        Effect.gen(function* () {
          const s = yield* make();
          const d = yield* s.create("周报");
          yield* submit(s, d.artifact.id, "b1", { op: "insert_block", block: para("a", "V", "你好世界") });
          yield* submit(s, d.artifact.id, "b2", { op: "split_block", blockId: "a", baseRev: 1, offset: 2, newBlock: para("b", "W", "") });
          yield* submit(s, d.artifact.id, "b3", { op: "update_text", blockId: "b", baseRev: 1, text: [bold("世界🌾")] });
          return d.artifact.id;
        }),
      ).pipe(Effect.provide(on(config)));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const s = yield* make();
          const snap = yield* s.get(id);
          expect([texts(snap.blocks), snap.artifact.seq, snap.artifact.title]).toEqual(["你好|世界🌾", 3, "周报"]);
          const b = snap.blocks[1]!;
          expect([b.rev, b.text[0]!.marks.bold, b.updatedBy, b.artifactId]).toEqual([2, true, "owner", id]);
          expect((yield* s.list()).map((d) => d.id)).toEqual([id]);
        }),
      ).pipe(Effect.provide(on(config)));
    });
  });

  it.effect("the same batch sent twice is taken once and answered the same", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* make();
        const d = yield* s.create("");
        const first = yield* submit(s, d.artifact.id, "same", { op: "insert_block", block: para("a", "V", "一") });
        const second = yield* submit(s, d.artifact.id, "same", { op: "insert_block", block: para("a", "V", "一") });
        expect([first.seq, second.seq, second.results[0]!.status, second.blocks.length]).toEqual([1, 1, "applied", 1]);
        const snap = yield* s.get(d.artifact.id);
        expect([snap.artifact.seq, snap.blocks.length, snap.artifact.title]).toEqual([1, 1, t("server.artifact.untitled")]);
        const other = yield* s.create("另一篇");
        expect((yield* Effect.flip(submit(s, other.artifact.id, "same")))._tag).toBe("Refused");
        expect((yield* Effect.flip(submit(s, artifactId("nope"), "x")))._tag).toBe("Missing");
        // A block id is the doc's that has it.
        expect((yield* submit(s, other.artifact.id, "dup", { op: "insert_block", block: para("a", "V", "撞了") })).results[0]!.status).toBe("rejected");
      }),
    ).pipe(Effect.provide(on())),
  );

  it.effect("a stale update over someone else's change is a conflict, and mine is kept", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* make();
        const sql = yield* SqlClient.SqlClient;
        const id = (yield* s.create("t")).artifact.id;
        yield* submit(s, id, "1", { op: "insert_block", block: para("a", "V", "原来") });
        const [, r] = yield* s.updateText(id, "lab", blockId("a"), 1, "帮工改的");
        expect([r!.status, r!.rev]).toEqual(["applied", 2]);
        const ack = yield* submit(s, id, "3", { op: "update_text", blockId: "a", baseRev: 1, text: [span("我改的")] });
        expect([ack.results[0]!.status, plain(ack.results[0]!.yours ?? []), ack.results[0]!.rev, ack.seq]).toEqual(["conflict", "我改的", 2, 3]);
        const snap = yield* s.get(id);
        expect([texts(snap.blocks), snap.blocks[0]!.updatedBy]).toEqual(["帮工改的", "lab"]);
        const kinds = yield* sql<{ kind: string }>`select kind from artifact_block_revision where block_id = 'a' and spans like '%我改的%'`;
        expect(kinds.map((k) => k.kind)).toEqual(["conflict"]);
        // A checkbox ticked since does not make my text stale.
        yield* submit(s, id, "4", { op: "set_attrs", blockId: "a", attrs: { checked: true } });
        expect((yield* submit(s, id, "5", { op: "update_text", blockId: "a", baseRev: 2, text: [span("接着改")] })).results[0]!.status).toBe("applied");
      }),
    ).pipe(Effect.provide(on())),
  );

  it.effect("attribute changes in the same batch do not conflict with a text edit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* make();
        const id = (yield* s.create("待办")).artifact.id;
        yield* submit(s, id, "insert", { op: "insert_block", block: { ...para("a", "V", "原文"), type: "todo", attrs: { checked: false } } });
        const ack = yield* submit(
          s,
          id,
          "check-and-edit",
          { op: "set_attrs", blockId: "a", attrs: { checked: true } },
          { op: "update_text", blockId: "a", baseRev: 1, text: [span("新文")] },
        );
        expect(ack.results.map((r) => r.status)).toEqual(["applied", "applied"]);
        expect((yield* s.get(id)).blocks[0]).toMatchObject({ attrs: { checked: true }, text: [span("新文")], rev: 3 });
      }),
    ).pipe(Effect.provide(on())),
  );

  it.effect("import and export", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* make();
        const sql = yield* SqlClient.SqlClient;
        const snap = yield* s.importMarkdown("导入", sample, "lab");
        expect([snap.artifact.seq, snap.blocks.length, snap.blocks[0]!.updatedBy]).toEqual([1, 17, "lab"]);
        expect(yield* s.markdown(snap.artifact.id)).toBe(sample);
        const [b, r] = yield* s.append(snap.artifact.id, "lab", "paragraph", {}, "帮工写的 **一段**");
        expect([r!.status, b!.rev, b!.text.length]).toEqual(["applied", 1, 2]);
        expect(yield* s.markdown(snap.artifact.id)).toMatch(/### 结尾\n\n帮工写的 \*\*一段\*\*\n$/u);
        expect((yield* Effect.flip(s.get(artifactId("nope"))))._tag).toBe("Missing");
        expect((yield* sql<{ n: number }>`select count(*)::int as n from artifact_change`)[0]!.n).toBe(2);
      }),
    ).pipe(Effect.provide(on())),
  );

  // The demo writes three sections at once, each by its own helper: a section's blocks stay together under its heading, a
  // second start while it runs is refused.
  it.effect("the demo writes three sections", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* make();
        const id = (yield* s.create("演示")).artifact.id;
        yield* submit(s, id, "mine", { op: "insert_block", block: para("first", "V", "主人先写的") });
        const all = helpers(["off", false], ["backend", true], ["tester", true], ["frontend", true], ["docs", true]);
        yield* s.demo(id, all);
        expect(yield* Effect.flip(s.demo(id, all))).toMatchObject({ reason: expect.stringContaining("演示正在写") });
        yield* finished(s);
        const snap = yield* s.get(id);
        expect(snap.blocks[0]!.id).toBe("first");
        const writers = ["backend", "tester", "frontend"];
        let section = -1;
        for (const b of snap.blocks.slice(1)) {
          if (b.type === "heading") {
            section++;
            expect([plain(b.text).endsWith("· 演示"), b.updatedBy]).toEqual([true, writers[section]]);
            continue;
          }
          expect(b.updatedBy).toBe(writers[section]);
          expect(([0, 1, 2] as const).map((p) => t(`server.artifact.demo.${section as 0 | 1 | 2}.paragraphs.${p}`))).toContain(plain(b.text));
          expect(b.rev).toBe(demoPieces + 1);
        }
        expect([section, snap.blocks.length]).toEqual([2, 1 + 3 * 4]);
        yield* s.demo(id, all);
        yield* finished(s);
        expect((yield* Effect.flip(s.demo(id, helpers(["off", false]))))._tag).toBe("Refused");
        expect((yield* Effect.flip(s.demo(artifactId("nope"), all)))._tag).toBe("Missing");
      }),
    ).pipe(Effect.provide(on())),
  );

  // The owner writing in a paragraph the demo is growing keeps it: the demo's next piece is a conflict and it moves on.
  it.effect("the demo leaves the owner's block", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* make();
        const id = (yield* s.create("演示")).artifact.id;
        yield* s.demo(id, helpers(["backend", true]));
        // The owner takes the second block over once the demo has written it twice: asked again until it holds.
        const tryTaking = Effect.gen(function* () {
          const snap = yield* s.get(id);
          const b = snap.blocks[1];
          if (snap.blocks.length !== 2 || !b || b.rev < 2) return "";
          const ack = yield* submit(s, id, "owner", { op: "update_text", blockId: b.id, baseRev: b.rev, text: [span("主人接手了")] });
          return ack.results[0]!.status === "applied" ? b.id : "";
        });
        const taken = yield* waitFor(Effect.andThen(TestClock.adjust(500), tryTaking), (item) => item !== "", "the owner taking the block over");
        expect(taken).not.toBe("");
        yield* finished(s);
        const snap = yield* s.get(id);
        const mine = snap.blocks.find((b) => b.id === taken)!;
        expect([plain(mine.text), mine.updatedBy]).toEqual(["主人接手了", "owner"]);
        expect(snap.blocks).toHaveLength(4);
      }),
    ).pipe(Effect.provide(on())),
  );
  it.effect("inserts where asked, changes a block's type and attrs, and deletes it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* make();
        const id = (yield* s.create("块")).artifact.id;
        const a = yield* s.insertBlock(id, "owner", { text: "A" });
        const c = yield* s.insertBlock(id, "owner", { text: "C" });
        const b = yield* s.insertBlock(id, "owner", { text: "B", afterBlock: a.blockId });
        yield* s.insertBlock(id, "owner", { text: "首", afterBlock: blockId("") });
        const heading = yield* s.insertBlock(id, "owner", { text: "节", type: "heading", level: 1 });
        const child = yield* s.insertBlock(id, "owner", { text: "子", parentId: heading.blockId });
        const snap = yield* s.get(id);
        expect(texts(snap.blocks)).toBe("首|A|B|C|节|子");
        expect(snap.blocks.find((x) => x.id === child.blockId)!.parentId).toBe(heading.blockId);
        const changed = yield* s.updateBlock(id, "owner", { block: b.blockId, baseRev: b.rev!, type: "todo", checked: true, text: "B2" });
        expect(changed.status).toBe("applied");
        const todo = (yield* s.get(id)).blocks.find((x) => x.id === b.blockId)!;
        expect([todo.type, todo.attrs.checked, plain(todo.text)]).toEqual(["todo", true, "B2"]);
        expect((yield* s.deleteBlock(id, "owner", { block: c.blockId })).status).toBe("applied");
        expect((yield* s.deleteBlock(id, "owner", { block: c.blockId })).status).toBe("noop");
        expect((yield* s.get(id)).blocks.some((x) => x.id === c.blockId)).toBe(false);
      }),
    ).pipe(Effect.provide(on())),
  );

  it.effect("follows a blocks artifact from after a seq, then live", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* make();
        const id = (yield* s.create("跟进")).artifact.id;
        yield* s.insertBlock(id, "owner", { text: "一" });
        yield* s.insertBlock(id, "owner", { text: "二" });
        const caught = yield* Stream.runCollect(Stream.take(s.follow(id, 0), 2));
        expect(caught.map((e) => (e._tag === "Blocks" ? e.seq : "Reset"))).toEqual([1, 2]);
        expect(caught.flatMap((e) => (e._tag === "Blocks" ? e.blocks.map((b) => plain(b.text)) : []))).toEqual(["一", "二"]);
        const live = yield* Effect.forkChild(Stream.runCollect(Stream.take(s.follow(id, 2), 1)));
        yield* TestClock.adjust(1);
        yield* s.insertBlock(id, "owner", { text: "三" });
        const [event] = yield* Fiber.join(live);
        expect(event!._tag).toBe("Blocks");
        if (event!._tag === "Blocks") expect([event!.seq, event!.blocks.map((b) => plain(b.text))]).toEqual([3, ["三"]]);
      }),
    ).pipe(Effect.provide(on())),
  );
  it.effect("catches up a hundred batches and follows again after twenty reconnects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* make();
        const id = (yield* s.create("压力")).artifact.id;
        yield* Effect.forEach(
          Array.from({ length: 100 }, (_, i) => i),
          (i) => s.insertBlock(id, "owner", { text: `第 ${i} 块` }),
          {
            concurrency: 2,
            discard: true,
          },
        );
        const caught = yield* Stream.runCollect(Stream.take(s.follow(id, 0), 100));
        expect(caught.map((e) => (e._tag === "Blocks" ? e.seq : -1))).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
        for (let i = 0; i < 20; i++) {
          const live = yield* Effect.forkChild(Stream.runCollect(Stream.take(s.follow(id, 100 + i), 1)));
          yield* TestClock.adjust(1);
          yield* s.insertBlock(id, "owner", { text: `重连 ${i}` });
          const [event] = yield* Fiber.join(live);
          expect(event!._tag).toBe("Blocks");
          if (event!._tag === "Blocks") expect(event!.seq).toBe(101 + i);
        }
      }),
    ).pipe(Effect.provide(on())),
  );
});
