import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { VibeValleyApi, VibeValleyApiError } from "@vibevalley/protocol";
import { blockId } from "@vibevalley/protocol/schema";

import { newId } from "@/base/ids.ts";
import { testConfig } from "@/testing/layers.ts";
import { quietApp } from "@/testing/world.ts";

import { app } from "./app.ts";

const farm = Effect.gen(function* () {
  let address = "";
  yield* Layer.build(app(testConfig(), 0, (a) => Effect.sync(() => void (address = a)), quietApp));
  return new VibeValleyApi(`http://${address}`, (url, init) => fetch(url, init));
});

const call = <A>(p: () => Promise<A>) => Effect.promise(() => p());
const refusal = (p: () => Promise<unknown>) =>
  Effect.promise(() =>
    p().then(
      () => "",
      (e: unknown) => (e instanceof VibeValleyApiError ? e.tag : String(e)),
    ),
  );

describe("the endpoints the agents' tools stand on", () => {
  it.live("list channels and unread places, filter issues, review and split them, read graphs, search memories, write blocks", () =>
    Effect.gen(function* () {
      const api = yield* farm;
      const channels = yield* call(() => api.channel.list());
      expect(channels.map((c) => c.type)).toEqual(["channel", "direct"]);
      expect(yield* call(() => api.channel.unread.list())).toEqual([]);

      const open = yield* call(() => api.issue.create({ title: "修登录", project: "app" }));
      const read = yield* call(() => api.issue.get({ id: open.id }));
      for (const id of [open.id, String(open.number), `#${open.number}`]) {
        expect(yield* call(() => api.issue.get({ id }))).toEqual(read);
        expect(yield* call(() => api.issue.run.list({ id }))).toEqual([]);
        expect(yield* call(() => api.issue.timeline.get({ id }))).toEqual(yield* call(() => api.issue.timeline.get({ id: open.id })));
        expect(yield* call(() => api.issue.status.previewUpdate({ id, status: "canceled" }))).toEqual(
          yield* call(() => api.issue.status.previewUpdate({ id: open.id, status: "canceled" })),
        );
        expect(yield* refusal(() => api.issue.diff.get({ id }))).toEqual(yield* refusal(() => api.issue.diff.get({ id: open.id })));
        expect(yield* call(() => api.issue.previewDelete({ id }))).toEqual(yield* call(() => api.issue.previewDelete({ id: open.id })));
      }
      yield* call(() => api.issue.create({ title: "加打卡" }));
      expect((yield* call(() => api.issue.list({}))).map((t) => t.title).toSorted()).toEqual(["修登录", "加打卡"]);
      expect((yield* call(() => api.issue.list({ project: "app" }))).map((t) => t.title)).toEqual(["修登录"]);
      expect(yield* call(() => api.issue.list({ status: "done" }))).toEqual([]);
      // Nothing was handed back to review, and no session works it to split it.
      expect(yield* refusal(() => api.issue.review({ id: `#${open.number}`, pass: true }))).toBe("Refused");
      expect(yield* refusal(() => api.issue.split({ id: open.id, tasks: [{ id: "a", brief: "前端" }] }))).toBe("Refused");

      expect(yield* call(() => api.graph.list())).toEqual([]);
      expect(yield* refusal(() => api.graph.get({ id: "nope" }))).toBe("Missing");
      expect(yield* call(() => api.memory.search({ text: "登录" }))).toMatchObject({ found: [] });

      const doc = yield* call(() => api.artifact.create({ title: "说明" }));
      const made = yield* call(() => api.artifact.block.create({ id: doc.id, type: "heading", level: 1, text: "开头" }));
      expect(made).toMatchObject({ status: "applied", rev: 1 });
      expect(yield* call(() => api.artifact.block.update({ id: doc.id, block: made.blockId, baseRev: 1, text: "新的开头" }))).toMatchObject({
        status: "applied",
      });
      expect(yield* call(() => api.artifact.block.update({ id: doc.id, block: made.blockId, baseRev: 1, text: "晚了" }))).toMatchObject({
        status: "conflict",
      });
      expect(yield* refusal(() => api.artifact.block.create({ id: doc.id, type: "divider", text: "" }))).toBe("Refused");
      const second = yield* call(() => api.artifact.block.create({ id: doc.id, text: "第二" }));
      yield* call(() => api.artifact.block.create({ id: doc.id, text: "中间", afterBlock: made.blockId }));
      expect((yield* call(() => api.artifact.block.list({ id: doc.id }))).blocks.map((b) => b.text.map((x) => x.t).join(""))).toEqual([
        "新的开头",
        "中间",
        "第二",
      ]);
      expect(yield* call(() => api.artifact.block.delete({ id: doc.id, block: second.blockId }))).toMatchObject({ status: "applied" });
      expect((yield* call(() => api.artifact.block.list({ id: doc.id }))).blocks.map((b) => b.id)).not.toContain(second.blockId);
      // A message pointing at a block carries its id, the version quoted, and how it reads now.
      const general = channels.find((c) => c.default)!.id;
      const current = (yield* call(() => api.artifact.block.list({ id: doc.id }))).blocks.find((b) => b.id === made.blockId)!;
      yield* call(() => api.channel.message.send({ id: general, text: "看这块", blocks: [{ artifactId: doc.id, blockId: made.blockId, rev: 1 }] }));
      const allMessages = yield* call(() => api.channel.message.list({ id: general, limit: 5 }));
      const sent = allMessages.find((m) => m.text === "看这块")!;
      console.log("QUOTED", JSON.stringify(sent));
      expect(sent.blocks).toEqual([
        {
          artifactId: doc.id,
          blockId: made.blockId,
          rev: 1,
          title: "说明",
          type: current.type,
          text: "新的开头",
          nowRev: current.rev,
        },
      ]);
      // Several blocks at once: one changed since, one deleted, and the prompt keeps both versions.
      const third = yield* call(() => api.artifact.block.create({ id: doc.id, text: "要走" }));
      yield* call(() => api.artifact.block.update({ id: doc.id, block: made.blockId, baseRev: current.rev, text: "又改了" }));
      yield* call(() => api.artifact.block.delete({ id: doc.id, block: third.blockId }));
      yield* call(() =>
        api.channel.message.send({
          id: general,
          text: "两块一起看",
          blocks: [
            { artifactId: doc.id, blockId: made.blockId, rev: current.rev },
            { artifactId: doc.id, blockId: third.blockId, rev: third.rev ?? 1 },
          ],
        }),
      );
      const live = (yield* call(() => api.artifact.block.list({ id: doc.id }))).blocks.find((b) => b.id === made.blockId)!;
      const suggestion = yield* call(() =>
        api.artifact.suggestion.create({
          id: doc.id,
          block: made.blockId,
          baseRev: live.rev,
          change: { text: [{ t: "主人点过头的字", marks: {} }] },
        }),
      );
      expect((yield* call(() => api.artifact.suggestion.list({ id: doc.id }))).map((s) => s.id)).toContain(suggestion.id);
      const accepted = yield* call(() => api.artifact.suggestion.accept({ id: doc.id, suggestion: suggestion.id }));
      expect(accepted.status).toBe("accepted");
      expect(
        (yield* call(() => api.artifact.block.list({ id: doc.id }))).blocks
          .find((b) => b.id === made.blockId)!
          .text.map((x) => x.t)
          .join(""),
      ).toBe("主人点过头的字");
      const many = (yield* call(() => api.channel.message.list({ id: general, limit: 5 }))).find((m) => m.text === "两块一起看")!;
      expect(many.blocks).toMatchObject([
        { blockId: made.blockId, rev: current.rev, text: "又改了" },
        { blockId: third.blockId, rev: third.rev, deleted: true },
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("take a blocks artifact's block in the editor's shape: the new block's content and place, the rest filled in", () =>
    Effect.gen(function* () {
      const api = yield* farm;
      const before = Date.now();
      const made = yield* call(() => api.artifact.create({ title: "插入" }));
      const inserted = newId();
      yield* call(() =>
        api.artifact.submit({
          id: made.id,
          batchId: newId(),
          lastSeq: 0,
          ops: [{ op: "insert_block", block: { id: blockId(inserted), orderKey: "V", type: "paragraph", attrs: {}, text: [{ t: "你好世界", marks: {} }] } }],
        }),
      );
      const saved = (yield* call(() => api.artifact.block.list({ id: made.id }))).blocks[0]!;
      expect(saved).toMatchObject({ id: inserted, artifactId: made.id, rev: 1, updatedBy: "owner", text: [{ t: "你好世界", marks: {} }] });
      expect(saved.updated).toBeGreaterThanOrEqual(before);
      expect(saved.deleted).toBeUndefined();

      const imported = yield* call(() => api.artifact.create({ title: "拆分", kind: "markdown", content: "你好世界" }));
      const source = (yield* call(() => api.artifact.block.list({ id: imported.id }))).blocks[0]!;
      const split = newId();
      yield* call(() =>
        api.artifact.submit({
          id: imported.id,
          batchId: newId(),
          lastSeq: imported.seq,
          ops: [
            {
              op: "split_block",
              blockId: source.id,
              baseRev: source.rev,
              offset: 2,
              newBlock: { id: blockId(split), orderKey: "W", type: "paragraph", attrs: {}, text: [] },
            },
          ],
        }),
      );
      const after = yield* call(() => api.artifact.block.list({ id: imported.id }));
      expect(after.blocks.map((b) => b.text.map((x) => x.t).join(""))).toEqual(["你好", "世界"]);
      expect(after.blocks[1]).toMatchObject({ id: split, artifactId: imported.id, rev: 1, updatedBy: "owner" });
    }).pipe(Effect.scoped),
  );

  // The issue's page sends what the owner changed but has not saved with the button they pressed.
  it.live("save an issue's unsaved fields before its act is tried, even when the act is refused", () =>
    Effect.gen(function* () {
      const api = yield* farm;
      const made = yield* call(() => api.issue.create({ title: "带着改动开工之前" }));
      expect(yield* refusal(() => api.issue.status.update({ id: made.id, status: "todo", edit: { title: "带着改动开工", priority: "high" } }))).toBe("Refused");
      const got = yield* call(() => api.issue.get({ id: made.id }));
      expect([got.title, got.priority, got.status]).toEqual(["带着改动开工", "high", "backlog"]);
    }).pipe(Effect.scoped),
  );

  it.live("refuses a body past its limit before reading it, and stops reading one that grows past it", () =>
    Effect.gen(function* () {
      let address = "";
      yield* Layer.build(app(testConfig(), 0, (a) => Effect.sync(() => void (address = a)), quietApp));
      const [declared, streamed] = yield* Effect.promise(() => postBig(`http://${address}/api/v1/channel/message/list`));
      expect([declared, streamed]).toEqual([413, "cut"]);
    }),
  );
});

/** A body of 3 MB, once with its length said and once streamed without it: the status, or "cut" when the connection is. */
async function postBig(url: string) {
  const big = JSON.stringify({ id: "x".repeat(3 * 1024 * 1024) });
  const declared = (await fetch(url, { method: "POST", body: big })).status;
  const chunks = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(big));
      c.close();
    },
  });
  // Node's fetch takes duplex for a streamed body.
  const init = { method: "POST", body: chunks, duplex: "half" } as RequestInit;
  const streamed = await fetch(url, init).then(
    (r) => r.status,
    () => "cut",
  );
  return [declared, streamed] as const;
}
