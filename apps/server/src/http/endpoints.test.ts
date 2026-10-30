import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { VibeValleyApi, VibeValleyApiError } from "@vibevalley/protocol";

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
    }).pipe(Effect.scoped),
  );

  it.live("take a blocks artifact's block in the editor's shape: the new block's content and place, the rest filled in", () =>
    Effect.gen(function* () {
      const api = yield* farm;
      const before = Date.now();
      const made = yield* call(() => api.artifact.create({ title: "插入" }));
      const inserted = crypto.randomUUID();
      yield* call(() =>
        api.artifact.submit({
          id: made.id,
          batchId: crypto.randomUUID(),
          lastSeq: 0,
          ops: [{ op: "insert_block", block: { id: inserted, orderKey: "V", type: "paragraph", attrs: {}, text: [{ t: "你好世界", marks: {} }] } }],
        }),
      );
      const saved = (yield* call(() => api.artifact.block.list({ id: made.id }))).blocks[0]!;
      expect(saved).toMatchObject({ id: inserted, artifactId: made.id, rev: 1, updatedBy: "owner", text: [{ t: "你好世界", marks: {} }] });
      expect(saved.updated).toBeGreaterThanOrEqual(before);
      expect(saved.deleted).toBeUndefined();

      const imported = yield* call(() => api.artifact.create({ title: "拆分", kind: "markdown", content: "你好世界" }));
      const source = (yield* call(() => api.artifact.block.list({ id: imported.id }))).blocks[0]!;
      const split = crypto.randomUUID();
      yield* call(() =>
        api.artifact.submit({
          id: imported.id,
          batchId: crypto.randomUUID(),
          lastSeq: imported.seq,
          ops: [
            {
              op: "split_block",
              blockId: source.id,
              baseRev: source.rev,
              offset: 2,
              newBlock: { id: split, orderKey: "W", type: "paragraph", attrs: {}, text: [] },
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
});
