import { setImmediate } from "node:timers/promises";

import { describe, expect, test } from "vite-plus/test";

import { abortError, mapConcurrent } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type { ArtifactId, BlockOp } from "@vibevalley/protocol";
import { ApiError, BizCode } from "@vibevalley/protocol/api";
import { artifactId, blockId, type Wire } from "@vibevalley/protocol/schema";

import { lookIn, orMissing } from "#/base/errors.ts";
import { newId } from "#/base/ids.ts";
import type { ServerConfig } from "#/infra/config.ts";
import { keptLog } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import { sampleAgent } from "#/modules/agent/seed.ts";
import { bold, para, sample, span } from "#/testing/artifact.ts";
import { testConfig, testDb, waitFor } from "#/testing/layers.ts";
import * as qa from "#db/artifact.sql.ts";

import { makeBlockStore } from "./blocks.ts";
import { plain } from "./ops.ts";
import { demoPieces } from "./policy.ts";

/** A clock that moves only when the test says, from 0; each wait it passes ends in order, and what it woke gets a few turns. */
function heldTime() {
  let at = 0;
  const waits = new Set<{ readonly until: number; readonly wake: () => void }>();
  const time: Time = {
    now: () => at,
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        const wait = { until: at + Math.max(0, ms), wake: resolve };
        waits.add(wait);
        signal?.addEventListener(
          "abort",
          () => {
            waits.delete(wait);
            reject(signal.reason ?? abortError("stopped"));
          },
          { once: true },
        );
      }),
    after: () => () => undefined,
  };
  const turns = async (n: number) => {
    for (let turn = 0; turn < n; turn++) await setImmediate();
  };
  const adjust = async (ms: number) => {
    const target = at + ms;
    for (;;) {
      const next = [...waits].filter((w) => w.until <= target).toSorted((a, b) => a.until - b.until)[0];
      if (next === undefined) break;
      waits.delete(next);
      at = next.until;
      next.wake();
      await turns(2);
    }
    at = target;
    await turns(20);
  };
  return { time, adjust };
}

/** The blocks of artifacts made straight in the table: the rest of the Artifact service (channels, cards) is artifact.test.ts's. */
const make = async (config: ServerConfig = testConfig()) => {
  const db = await testDb(config);
  const clock = heldTime();
  const row = async (id: string) => orMissing(id, [lookIn.artifact])(await qa.artifact(db.sql, { id }));
  const blocks = await makeBlockStore({ db, clock: clock.time, log: keptLog() }, row);
  const get = async (id: ArtifactId) => {
    const list = await blocks.blocks(id);
    const r = await row(id);
    return { artifact: { id: artifactId(r.id), title: r.title, seq: r.seq }, blocks: list };
  };
  const create = async (title: string) => {
    const id = artifactId(newId());
    await qa.addArtifact(db.sql, {
      id,
      title: title.trim() || t("server.artifact.untitled"),
      display: null,
      body: "blocks",
      channel_id: null,
      issue: null,
      by_id: "user",
      by_name: "用户",
      version: 0,
      created_at: 0,
    });
    return get(id);
  };
  const list = () => qa.artifacts(db.sql, { limit_n: 100 });
  const importMarkdown = async (title: string, markdown: string, actor: string) => {
    const made = await create(title);
    await blocks.fill(made.artifact.id, markdown, actor);
    return get(made.artifact.id);
  };
  return {
    ...blocks,
    db,
    adjust: clock.adjust,
    get,
    create,
    list,
    importMarkdown,
    [Symbol.asyncDispose]: async () => {
      await blocks.close();
      await db.close();
    },
  };
};

type Service = Awaited<ReturnType<typeof make>>;

const submit = (s: Service, doc: ArtifactId, batchId: string, ...ops: Wire<BlockOp>[]) => s.submit(doc, "user", { batchId, ops: ops as BlockOp[] });

const texts = (blocks: { text: { t: string }[] }[]) => blocks.map((b) => plain(b.text as never)).join("|");

const helpers = (...list: [string, boolean][]) => list.map(([id, enabled]) => sampleAgent({ id, enabled }));

const finished = (s: Service) =>
  waitFor(
    async () => {
      await s.adjust(1_000);
      return s.demoRunning();
    },
    (running) => !running,
    "the demo finished",
  );

/** What p failed with: the refusal a test expects. */
const failed = async (p: Promise<unknown>): Promise<ApiError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("it was not refused");
};

/** The first n events of a stream, then it is closed. */
const take = async <A>(source: AsyncIterable<A>, n: number) => {
  const out: A[] = [];
  if (n <= 0) return out;
  for await (const a of source) {
    out.push(a);
    if (out.length >= n) break;
  }
  return out;
};

describe("a blocks artifact", () => {
  test("what one person writes is there after the server starts again", async () => {
    const config = { ...testConfig(), db: "" };
    {
      const id = await (async () => {
        await using s = await make(config);
        const d = await s.create("周报");
        await submit(s, d.artifact.id, "b1", { op: "insert_block", block: para("a", "V", "你好世界") });
        await submit(s, d.artifact.id, "b2", { op: "split_block", blockId: "a", baseRev: 1, offset: 2, newBlock: para("b", "W", "") });
        await submit(s, d.artifact.id, "b3", { op: "update_text", blockId: "b", baseRev: 1, text: [bold("世界🌾")] });
        await s.suggest(d.artifact.id, "lab", { block: blockId("b"), baseRev: 2, change: { text: [span("留到重启以后")] } });
        return d.artifact.id;
      })();
      {
        await using s = await make(config);
        const snap = await s.get(id);
        expect([texts(snap.blocks), snap.artifact.seq, snap.artifact.title]).toEqual(["你好|世界🌾", 3, "周报"]);
        const b = snap.blocks[1]!;
        expect([b.rev, b.text[0]!.marks.bold, b.updatedBy, b.artifactId]).toEqual([2, true, "user", id]);
        expect((await s.list()).map((d) => d.id)).toEqual([id]);
        expect((await s.suggestions(id)).map((x) => [x.blockId, x.status, x.change.text?.[0]?.t])).toEqual([["b", "open", "留到重启以后"]]);
      }
    }
  });

  test("the same batch sent twice is taken once and answered the same", async () => {
    await using s = await make();
    const d = await s.create("");
    const first = await submit(s, d.artifact.id, "same", { op: "insert_block", block: para("a", "V", "一") });
    const second = await submit(s, d.artifact.id, "same", { op: "insert_block", block: para("a", "V", "一") });
    expect([first.seq, second.seq, second.results[0]!.status, second.blocks.length]).toEqual([1, 1, "applied", 1]);
    const snap = await s.get(d.artifact.id);
    expect([snap.artifact.seq, snap.blocks.length, snap.artifact.title]).toEqual([1, 1, t("server.artifact.untitled")]);
    const other = await s.create("另一篇");
    expect((await failed(submit(s, other.artifact.id, "same"))).bizCode).toBe(BizCode.ArtifactRefused);
    expect((await failed(submit(s, artifactId("nope"), "x"))).bizCode).toBe(BizCode.ArtifactNotFound);
    // A block id is the doc's that has it.
    expect((await submit(s, other.artifact.id, "dup", { op: "insert_block", block: para("a", "V", "撞了") })).results[0]!.status).toBe("rejected");
  });

  test("a stale update over someone else's change is a conflict, and mine is kept", async () => {
    await using s = await make();
    const id = (await s.create("t")).artifact.id;
    await submit(s, id, "1", { op: "insert_block", block: para("a", "V", "原来") });
    const [, r] = await s.updateText(id, "lab", blockId("a"), 1, "帮工改的");
    expect([r!.status, r!.rev]).toEqual(["applied", 2]);
    const ack = await submit(s, id, "3", { op: "update_text", blockId: "a", baseRev: 1, text: [span("我改的")] });
    expect([ack.results[0]!.status, plain(ack.results[0]!.yours ?? []), ack.results[0]!.rev, ack.seq]).toEqual(["conflict", "我改的", 2, 3]);
    const snap = await s.get(id);
    expect([texts(snap.blocks), snap.blocks[0]!.updatedBy]).toEqual(["帮工改的", "lab"]);
    const kinds = await s.db.sql.query("select kind from artifact_block_revision where block_id = 'a' and spans like '%我改的%'");
    expect(kinds.map((k) => k.kind)).toEqual(["conflict"]);
    // A checkbox ticked since does not make my text stale.
    await submit(s, id, "4", { op: "set_attrs", blockId: "a", attrs: { checked: true } });
    expect((await submit(s, id, "5", { op: "update_text", blockId: "a", baseRev: 2, text: [span("接着改")] })).results[0]!.status).toBe("applied");
  });

  test("attribute changes in the same batch do not conflict with a text edit", async () => {
    await using s = await make();
    const id = (await s.create("待办")).artifact.id;
    await submit(s, id, "insert", { op: "insert_block", block: { ...para("a", "V", "原文"), type: "todo", attrs: { checked: false } } });
    const ack = await submit(
      s,
      id,
      "check-and-edit",
      { op: "set_attrs", blockId: "a", attrs: { checked: true } },
      { op: "update_text", blockId: "a", baseRev: 1, text: [span("新文")] },
    );
    expect(ack.results.map((r) => r.status)).toEqual(["applied", "applied"]);
    expect((await s.get(id)).blocks[0]).toMatchObject({ attrs: { checked: true }, text: [span("新文")], rev: 3 });
  });

  test("import and export", async () => {
    await using s = await make();
    const snap = await s.importMarkdown("导入", sample, "lab");
    expect([snap.artifact.seq, snap.blocks.length, snap.blocks[0]!.updatedBy]).toEqual([1, 17, "lab"]);
    const markdown2 = await s.markdown(snap.artifact.id);
    expect(markdown2).toBe(sample);
    const [b, r] = await s.append(snap.artifact.id, "lab", "paragraph", {}, "帮工写的 **一段**");
    expect([r!.status, b!.rev, b!.text.length]).toEqual(["applied", 1, 2]);
    const markdown3 = await s.markdown(snap.artifact.id);
    expect(markdown3).toMatch(/### 结尾\n\n帮工写的 \*\*一段\*\*\n$/u);
    expect((await failed(s.get(artifactId("nope")))).bizCode).toBe(BizCode.ArtifactNotFound);
    expect((await s.db.sql.query("select count(*)::int as n from artifact_change"))[0]!.n).toBe(2);
  });

  // The demo writes three sections at once, each by its own helper: a section's blocks stay together under its heading, a
  // second start while it runs is refused.
  test("the demo writes three sections", async () => {
    await using s = await make();
    const id = (await s.create("演示")).artifact.id;
    await submit(s, id, "mine", { op: "insert_block", block: para("first", "V", "用户先写的") });
    const all = helpers(["off", false], ["backend", true], ["tester", true], ["frontend", true], ["docs", true]);
    await s.demo(id, all);
    const demoFailure = await failed(s.demo(id, all));
    expect(demoFailure).toMatchObject({ message: expect.stringContaining("演示正在写") });
    await finished(s);
    const snap = await s.get(id);
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
    await s.demo(id, all);
    await finished(s);
    expect((await failed(s.demo(id, helpers(["off", false])))).bizCode).toBe(BizCode.ArtifactRefused);
    expect((await failed(s.demo(artifactId("nope"), all))).bizCode).toBe(BizCode.ArtifactNotFound);
  });

  // The user writing in a paragraph the demo is growing keeps it: the demo's next piece is a conflict and it moves on.
  test("the demo leaves the user's block", async () => {
    await using s = await make();
    const id = (await s.create("演示")).artifact.id;
    await s.demo(id, helpers(["backend", true]));
    // The user takes the second block over once the demo has written it twice: asked again until it holds.
    const tryTaking = async () => {
      const snap = await s.get(id);
      const b = snap.blocks[1];
      if (snap.blocks.length !== 2 || !b || b.rev < 2) return "";
      const ack = await submit(s, id, "user", { op: "update_text", blockId: b.id, baseRev: b.rev, text: [span("用户接手了")] });
      return ack.results[0]!.status === "applied" ? b.id : "";
    };
    const taken = await waitFor(
      async () => {
        await s.adjust(500);
        return tryTaking();
      },
      (item) => item !== "",
      "the user taking the block over",
    );
    expect(taken).not.toBe("");
    await finished(s);
    const snap = await s.get(id);
    const mine = snap.blocks.find((b) => b.id === taken)!;
    expect([plain(mine.text), mine.updatedBy]).toEqual(["用户接手了", "user"]);
    expect(snap.blocks).toHaveLength(4);
  });
  test("inserts where asked, changes a block's type and attrs, and deletes it", async () => {
    await using s = await make();
    const id = (await s.create("块")).artifact.id;
    const a = await s.insertBlock(id, "user", { text: "A" });
    const c = await s.insertBlock(id, "user", { text: "C" });
    const b = await s.insertBlock(id, "user", { text: "B", afterBlock: a.blockId });
    await s.insertBlock(id, "user", { text: "首", afterBlock: blockId("") });
    const heading = await s.insertBlock(id, "user", { text: "节", type: "heading", level: 1 });
    const child = await s.insertBlock(id, "user", { text: "子", parentId: heading.blockId });
    const snap = await s.get(id);
    expect(texts(snap.blocks)).toBe("首|A|B|C|节|子");
    expect(snap.blocks.find((x) => x.id === child.blockId)!.parentId).toBe(heading.blockId);
    const changed = await s.updateBlock(id, "user", { block: b.blockId, baseRev: b.rev!, type: "todo", checked: true, text: "B2" });
    expect(changed.status).toBe("applied");
    const todo = (await s.get(id)).blocks.find((x) => x.id === b.blockId)!;
    expect([todo.type, todo.attrs.checked, plain(todo.text)]).toEqual(["todo", true, "B2"]);
    expect((await s.deleteBlock(id, "user", { block: c.blockId })).status).toBe("applied");
    expect((await s.deleteBlock(id, "user", { block: c.blockId })).status).toBe("noop");
    expect((await s.get(id)).blocks.some((x) => x.id === c.blockId)).toBe(false);
  });

  test("follows a blocks artifact from after a seq, then live", async () => {
    await using s = await make();
    const id = (await s.create("跟进")).artifact.id;
    await s.insertBlock(id, "user", { text: "一" });
    await s.insertBlock(id, "user", { text: "二" });
    const caught = await take(s.follow(id, 0), 2);
    expect(caught.map((e) => (e._tag === "Blocks" ? e.seq : "Reset"))).toEqual([1, 2]);
    expect(caught.flatMap((e) => (e._tag === "Blocks" ? e.blocks.map((b) => plain(b.text)) : []))).toEqual(["一", "二"]);
    const live = take(s.follow(id, 2), 1);
    await s.adjust(1);
    await s.insertBlock(id, "user", { text: "三" });
    const [event] = await live;
    expect(event!._tag).toBe("Blocks");
    if (event!._tag === "Blocks") expect([event!.seq, event!.blocks.map((b) => plain(b.text))]).toEqual([3, ["三"]]);
  });
  test("catches up a hundred batches and follows again after twenty reconnects", async () => {
    await using s = await make();
    const id = (await s.create("压力")).artifact.id;
    await mapConcurrent(
      Array.from({ length: 100 }, (_, i) => i),
      2,
      (i) => s.insertBlock(id, "user", { text: `第 ${i} 块` }),
    );
    const caught = await take(s.follow(id, 0), 100);
    expect(caught.map((e) => (e._tag === "Blocks" ? e.seq : -1))).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    for (let i = 0; i < 20; i++) {
      const live = take(s.follow(id, 100 + i), 1);
      await s.adjust(1);
      await s.insertBlock(id, "user", { text: `重连 ${i}` });
      const [event] = await live;
      expect(event!._tag).toBe("Blocks");
      if (event!._tag === "Blocks") expect(event!.seq).toBe(101 + i);
    }
  });
  test("suggestions wait for the user, apply once, and go stale when the block moved", async () => {
    await using s = await make();
    const id = (await s.create("建议")).artifact.id;
    const a = await s.insertBlock(id, "user", { text: "用户写的" });
    const made = await s.suggest(id, "lab", { block: a.blockId, baseRev: a.rev!, change: { text: [span("帮工改的")] } });
    expect([made.status, made.author, made.baseRev]).toEqual(["open", "lab", a.rev]);
    const accepted = await s.acceptSuggestion(id, made.id, "user");
    expect(accepted.status).toBe("accepted");
    expect(
      (await s.get(id)).blocks
        .find((b) => b.id === a.blockId)!
        .text.map((x) => x.t)
        .join(""),
    ).toBe("帮工改的");
    expect((await s.acceptSuggestion(id, made.id, "user")).status).toBe("accepted");

    const b = await s.insertBlock(id, "user", { text: "再写一块" });
    const stale = await s.suggest(id, "lab", { block: b.blockId, baseRev: b.rev!, change: { text: [span("晚到的")] } });
    await s.updateBlock(id, "user", { block: b.blockId, baseRev: b.rev!, text: "用户先改了" });
    expect((await failed(s.acceptSuggestion(id, stale.id, "user"))).bizCode).toBe(BizCode.ArtifactRefused);
    expect((await s.suggestions(id)).find((x) => x.id === stale.id)!.status).toBe("open");
    expect((await s.rejectSuggestion(id, stale.id, "user")).status).toBe("rejected");
    expect((await s.rejectSuggestion(id, stale.id, "user")).status).toBe("rejected");

    const c = await s.insertBlock(id, "user", { text: "两块建议" });
    const first = await s.suggest(id, "lab", { block: c.blockId, baseRev: c.rev!, change: { text: [span("第一份")] } });
    const second = await s.suggest(id, "lab", { block: c.blockId, baseRev: c.rev!, change: { text: [span("第二份")] } });
    await s.acceptSuggestion(id, first.id, "user");
    expect((await failed(s.acceptSuggestion(id, second.id, "user"))).bizCode).toBe(BizCode.ArtifactRefused);
  });

  test("an agent's edit of the user's block becomes a suggestion, and a suggestion stream brings the list", async () => {
    await using s = await make();
    const id = (await s.create("自动建议")).artifact.id;
    const a = await s.insertBlock(id, "user", { text: "用户的字" });
    const made = await s.updateBlock(id, "lab", { block: a.blockId, baseRev: a.rev!, text: "帮工想改" });
    expect([made.status, made.suggestion !== undefined]).toEqual(["rejected", true]);
    expect(
      (await s.get(id)).blocks
        .find((b) => b.id === a.blockId)!
        .text.map((x) => x.t)
        .join(""),
    ).toBe("用户的字");
    const first = await take(s.suggestionStream(id), 1);
    expect(first.map((e) => (e._tag === "Suggestions" ? e.suggestions.length : -1))).toEqual([1]);
    const deleted = await s.deleteBlock(id, "lab", { block: a.blockId });
    expect([deleted.status, deleted.suggestion !== undefined]).toEqual(["rejected", true]);
    expect((await s.suggestions(id)).filter((x) => x.status === "open")).toHaveLength(2);
  });
  test("an agent's edit of the user's block becomes a suggestion for every operation", async () => {
    await using s = await make();
    const id = (await s.create("授权矩阵")).artifact.id;
    const text = await s.insertBlock(id, "user", { text: "用户的字" });
    const changed = [
      await s.updateBlock(id, "lab", { block: text.blockId, baseRev: text.rev!, text: "建议改字" }),
      await s.updateBlock(id, "lab", { block: text.blockId, baseRev: text.rev!, type: "heading", level: 2 }),
      await s.updateBlock(id, "lab", { block: text.blockId, baseRev: text.rev!, checked: true }),
      await s.deleteBlock(id, "lab", { block: text.blockId }),
    ];
    expect(changed.map((r) => [r.status, r.suggestion !== undefined])).toEqual(Array.from({ length: 4 }, () => ["rejected", true]));
    const made = await s.suggestions(id);
    expect(made.map((x) => [Boolean(x.change.text), x.change.type, x.change.attrs?.checked, Boolean(x.change.delete)])).toEqual([
      [true, undefined, undefined, false],
      [false, "heading", undefined, false],
      [false, undefined, true, false],
      [false, undefined, undefined, true],
    ]);
    expect((await s.updateBlock(id, "user", { block: text.blockId, baseRev: text.rev!, text: "用户自己改" })).status).toBe("applied");
    const own = await s.insertBlock(id, "lab", { text: "帮工自己的" });
    expect((await s.updateBlock(id, "lab", { block: own.blockId, baseRev: own.rev!, text: "帮工改自己的" })).status).toBe("applied");
  });

  test("three agents' suggestions on one block survive ten restarts, and accept and reject stay final", async () => {
    const config = { ...testConfig(), db: "" };
    {
      const { id, block, rev } = await (async () => {
        await using s = await make(config);
        const id = (await s.create("并发建议")).artifact.id;
        const b = await s.insertBlock(id, "user", { text: "同一块" });
        await mapConcurrent(["lab", "qa", "ops"], 3, (actor, i) =>
          s.suggest(id, actor, {
            block: b.blockId,
            baseRev: b.rev!,
            change: i === 0 ? { text: [span("一")] } : i === 1 ? { type: "heading", attrs: { level: 2 } } : { delete: true },
          }),
        );
        return { id, block: b.blockId, rev: b.rev! };
      })();
      for (let n = 0; n < 10; n++) {
        await using s = await make(config);
        const list = await s.suggestions(id);
        expect(list.map((x) => [x.blockId, x.status, x.author])).toEqual([
          [block, "open", "lab"],
          [block, "open", "qa"],
          [block, "open", "ops"],
        ]);
        expect([list[0]!.change.text?.[0]?.t, list[1]!.change.type, list[2]!.change.delete]).toEqual(["一", "heading", true]);
        expect(list.map((x) => x.baseRev)).toEqual([rev, rev, rev]);
      }
      {
        await using s = await make(config);
        const [one] = await s.suggestions(id);
        for (let n = 0; n < 20; n++) expect((await s.acceptSuggestion(id, one!.id, "user")).status).toBe("accepted");
        for (let n = 0; n < 20; n++) expect((await s.rejectSuggestion(id, one!.id, "user")).status).toBe("accepted");
        const other = (await s.suggestions(id))[1]!;
        for (let n = 0; n < 20; n++) expect((await s.rejectSuggestion(id, other.id, "user")).status).toBe("rejected");
        expect((await s.acceptSuggestion(id, other.id, "user")).status).toBe("rejected");
        expect(
          (await s.get(id)).blocks
            .find((b) => b.id === block)!
            .text.map((x) => x.t)
            .join(""),
        ).toBe("一");
      }
    }
  });
});
