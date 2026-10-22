import { describe, expect, it } from "@effect/vitest";
import type { Agent, DocOp } from "@vibevalley/protocol";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { Database } from "../base/db.ts";
import { Settings, type Config } from "../base/config.ts";
import { testConfig } from "../testing/layers.ts";
import { make } from "./doc.ts";
import { demoPieces, demoScript } from "./demo.ts";
import { plain } from "./text.ts";
import { bold, para, sample, span } from "./testing.ts";

const on = (config: Config = testConfig()) => Database.pipe(Layer.provideMerge(Layer.succeed(Settings, config)));

type Service = Effect.Success<ReturnType<typeof make>>;

const submit = (s: Service, doc: string, batchId: string, ...ops: DocOp[]) => s.submit(doc, "owner", { batchId, ops });

const texts = (blocks: { text: { t: string }[] }[]) => blocks.map((b) => plain(b.text as never)).join("|");

const helpers = (...list: [string, boolean][]) => list.map(([id, enabled]) => ({ id, enabled }) as Agent);

const finished = (s: Service) =>
  Effect.promise(async () => {
    for (let i = 0; i < 2000 && s.demoRunning(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(s.demoRunning()).toBe(false);
  });

describe("doc", () => {
  it.live("what one person writes is there after the server starts again", () => {
    const config = { ...testConfig(), db: "" };
    return Effect.gen(function* () {
      const id = yield* Effect.scoped(
        Effect.gen(function* () {
          const s = yield* make();
          const d = yield* s.create("周报");
          yield* submit(s, d.doc.id, "b1", { op: "insert_block", block: para("a", "V", "你好世界") });
          yield* submit(s, d.doc.id, "b2", { op: "split_block", blockId: "a", baseRev: 1, offset: 2, newBlock: para("b", "W", "") });
          yield* submit(s, d.doc.id, "b3", { op: "update_text", blockId: "b", baseRev: 1, text: [bold("世界🌾")] });
          return d.doc.id;
        }),
      ).pipe(Effect.provide(on(config)));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const s = yield* make();
          const snap = yield* s.get(id);
          expect([texts(snap.blocks), snap.doc.seq, snap.doc.title]).toEqual(["你好|世界🌾", 3, "周报"]);
          const b = snap.blocks[1]!;
          expect([b.rev, b.text[0]!.marks.bold, b.updatedBy, b.docId]).toEqual([2, true, "owner", id]);
          expect((yield* s.list()).map((d) => d.id)).toEqual([id]);
        }),
      ).pipe(Effect.provide(on(config)));
    });
  });

  it.live("the same batch sent twice is taken once and answered the same", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* make();
        const d = yield* s.create("");
        const first = yield* submit(s, d.doc.id, "same", { op: "insert_block", block: para("a", "V", "一") });
        const second = yield* submit(s, d.doc.id, "same", { op: "insert_block", block: para("a", "V", "一") });
        expect([first.seq, second.seq, second.results[0]!.status, second.blocks.length]).toEqual([1, 1, "applied", 1]);
        const snap = yield* s.get(d.doc.id);
        expect([snap.doc.seq, snap.blocks.length, snap.doc.title]).toEqual([1, 1, "没起名的文档"]);
        const other = yield* s.create("另一篇");
        expect((yield* Effect.flip(submit(s, other.doc.id, "same")))._tag).toBe("Refused");
        expect((yield* Effect.flip(submit(s, "nope", "x")))._tag).toBe("Missing");
        // A block id is the doc's that has it.
        expect((yield* submit(s, other.doc.id, "dup", { op: "insert_block", block: para("a", "V", "撞了") })).results[0]!.status).toBe("rejected");
      }),
    ).pipe(Effect.provide(on())),
  );

  it.live("a stale update over someone else's change is a conflict, and mine is kept", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* make();
        const sql = yield* SqlClient.SqlClient;
        const id = (yield* s.create("t")).doc.id;
        yield* submit(s, id, "1", { op: "insert_block", block: para("a", "V", "原来") });
        const [, r] = yield* s.updateText(id, "lab", "a", 1, "帮工改的");
        expect([r!.status, r!.rev]).toEqual(["applied", 2]);
        const ack = yield* submit(s, id, "3", { op: "update_text", blockId: "a", baseRev: 1, text: [span("我改的")] });
        expect([ack.results[0]!.status, plain(ack.results[0]!.yours!), ack.results[0]!.rev, ack.seq]).toEqual(["conflict", "我改的", 2, 3]);
        const snap = yield* s.get(id);
        expect([texts(snap.blocks), snap.blocks[0]!.updatedBy]).toEqual(["帮工改的", "lab"]);
        const kinds = yield* sql<{ kind: string }>`select kind from doc_block_revision where block_id = 'a' and spans like '%我改的%'`;
        expect(kinds.map((k) => k.kind)).toEqual(["conflict"]);
        // A checkbox ticked since does not make my text stale.
        yield* submit(s, id, "4", { op: "set_attrs", blockId: "a", attrs: { checked: true } });
        expect((yield* submit(s, id, "5", { op: "update_text", blockId: "a", baseRev: 2, text: [span("接着改")] })).results[0]!.status).toBe("applied");
      }),
    ).pipe(Effect.provide(on())),
  );

  it.live("attribute changes in the same batch do not conflict with a text edit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* make();
        const id = (yield* s.create("待办")).doc.id;
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

  it.live("import and export", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* make();
        const sql = yield* SqlClient.SqlClient;
        const snap = yield* s.importMarkdown("导入", sample, "lab");
        expect([snap.doc.seq, snap.blocks.length, snap.blocks[0]!.updatedBy]).toEqual([1, 17, "lab"]);
        expect(yield* s.markdown(snap.doc.id)).toBe(sample);
        const [b, r] = yield* s.append(snap.doc.id, "lab", "paragraph", {}, "帮工写的 **一段**");
        expect([r!.status, b!.rev, b!.text.length]).toEqual(["applied", 1, 2]);
        expect(yield* s.markdown(snap.doc.id)).toMatch(/### 结尾\n\n帮工写的 \*\*一段\*\*\n$/);
        expect((yield* Effect.flip(s.get("nope")))._tag).toBe("Missing");
        expect((yield* sql<{ n: number }>`select count(*)::int as n from doc_change`)[0]!.n).toBe(2);
      }),
    ).pipe(Effect.provide(on())),
  );

  // The demo writes three sections at once, each by its own helper: a section's blocks stay together under its heading, a
  // second start while it runs is refused.
  it.live("the demo writes three sections", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* make({ tickMs: 1 });
        const id = (yield* s.create("演示")).doc.id;
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
          expect(demoScript[section]!.paragraphs).toContain(plain(b.text));
          expect(b.rev).toBe(demoPieces + 1);
        }
        expect([section, snap.blocks.length]).toEqual([2, 1 + 3 * 4]);
        yield* s.demo(id, all);
        yield* finished(s);
        expect((yield* Effect.flip(s.demo(id, helpers(["off", false]))))._tag).toBe("Refused");
        expect((yield* Effect.flip(s.demo("nope", all)))._tag).toBe("Missing");
      }),
    ).pipe(Effect.provide(on())),
  );

  // The owner writing in a paragraph the demo is growing keeps it: the demo's next piece is a conflict and it moves on.
  it.live("the demo leaves the owner's block", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* make({ tickMs: 20 });
        const id = (yield* s.create("演示")).doc.id;
        yield* s.demo(id, helpers(["backend", true]));
        let taken = "";
        for (let i = 0; i < 500 && !taken; i++) {
          const snap = yield* s.get(id);
          const b = snap.blocks[1];
          if (snap.blocks.length === 2 && b && b.rev >= 2) {
            const ack = yield* submit(s, id, "owner", { op: "update_text", blockId: b.id, baseRev: b.rev, text: [span("主人接手了")] });
            if (ack.results[0]!.status === "applied") taken = b.id;
          }
          if (!taken) yield* Effect.sleep(2);
        }
        expect(taken).not.toBe("");
        yield* finished(s);
        const snap = yield* s.get(id);
        const mine = snap.blocks.find((b) => b.id === taken)!;
        expect([plain(mine.text), mine.updatedBy]).toEqual(["主人接手了", "owner"]);
        expect(snap.blocks).toHaveLength(4);
      }),
    ).pipe(Effect.provide(on())),
  );
});
