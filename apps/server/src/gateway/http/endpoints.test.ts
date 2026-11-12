import { describe, expect, test } from "vite-plus/test";

import { VibeValleyApi, VibeValleyApiError } from "@vibevalley/protocol";
import { blockId } from "@vibevalley/protocol/schema";

import { newId } from "#/base/ids.ts";
import { app } from "#/testing/http.ts";
import { testConfig } from "#/testing/layers.ts";
import { quietApp } from "#/testing/world.ts";

/** The whole farm on a free port, and a client of it; closed with the test. */
const farm = async () => {
  const served = await app(testConfig(), 0, undefined, quietApp);
  return Object.assign(new VibeValleyApi(`http://${served.address}`, (url, init) => fetch(url, init)), { [Symbol.asyncDispose]: () => served.close() });
};

const call = <A>(p: () => Promise<A>) => p();
const refusal = (p: () => Promise<unknown>) =>
  p().then(
    () => "",
    (e: unknown) => (e instanceof VibeValleyApiError ? e.tag : String(e)),
  );

describe("the endpoints the agents' tools stand on", () => {
  test("list channels and unread places, filter issues, review and split them, search memories, write blocks", async () => {
    await using api = await farm();
    const channels = await call(() => api.channel.list());
    expect(channels.map((c) => c.type)).toEqual(["channel", "direct"]);
    const response = await call(() => api.channel.unread.list());
    expect(response).toEqual([]);

    const open = await call(() => api.issue.create({ title: "修登录", repo: "app" }));
    const read = await call(() => api.issue.get({ id: open.id }));
    for (const id of [open.id, String(open.number), `#${open.number}`]) {
      const response7 = await call(() => api.issue.get({ id }));
      expect(response7).toEqual(read);
      const response8 = await call(() => api.issue.run.list({ id }));
      expect(response8).toEqual([]);
      const response9 = await call(() => api.issue.timeline.get({ id }));
      const openTimeline = await call(() => api.issue.timeline.get({ id: open.id }));
      expect(response9).toEqual(openTimeline);
      const response10 = await call(() => api.issue.status.previewUpdate({ id, status: "canceled" }));
      const openCancelPreview = await call(() => api.issue.status.previewUpdate({ id: open.id, status: "canceled" }));
      expect(response10).toEqual(openCancelPreview);
      const refusal5 = await refusal(() => api.issue.diff.get({ id }));
      const openDiffRefusal = await refusal(() => api.issue.diff.get({ id: open.id }));
      expect(refusal5).toEqual(openDiffRefusal);
      const response11 = await call(() => api.issue.previewDelete({ id }));
      const openDeletePreview = await call(() => api.issue.previewDelete({ id: open.id }));
      expect(response11).toEqual(openDeletePreview);
    }
    await call(() => api.issue.create({ title: "加打卡" }));
    expect((await call(() => api.issue.list({}))).map((t) => t.title).toSorted()).toEqual(["修登录", "加打卡"]);
    expect((await call(() => api.issue.list({ repo: "app" }))).map((t) => t.title)).toEqual(["修登录"]);
    const response2 = await call(() => api.issue.list({ status: "done" }));
    expect(response2).toEqual([]);
    const refusal2 = await refusal(() => api.issue.review({ id: `#${open.number}`, pass: true }));
    // Nothing was handed back to review, and no session works it to split it.
    expect(refusal2).toBe("Refused");
    const refusal3 = await refusal(() => api.issue.split({ id: open.id, tasks: [{ id: "a", brief: "前端" }] }));
    expect(refusal3).toBe("Refused");

    const response3 = await call(() => api.memory.search({ text: "登录" }));
    expect(response3).toMatchObject({ found: [] });

    const doc = await call(() => api.artifact.create({ title: "说明", kind: "markdown" }));
    const made = await call(() => api.artifact.block.create({ id: doc.id, type: "heading", level: 1, text: "开头" }));
    expect(made).toMatchObject({ status: "applied", rev: 1 });
    const response4 = await call(() => api.artifact.block.update({ id: doc.id, block: made.blockId, baseRev: 1, text: "新的开头" }));
    expect(response4).toMatchObject({
      status: "applied",
    });
    const response5 = await call(() => api.artifact.block.update({ id: doc.id, block: made.blockId, baseRev: 1, text: "晚了" }));
    expect(response5).toMatchObject({
      status: "conflict",
    });
    const refusal4 = await refusal(() => api.artifact.block.create({ id: doc.id, type: "divider", text: "" }));
    expect(refusal4).toBe("Refused");
    const second = await call(() => api.artifact.block.create({ id: doc.id, text: "第二" }));
    await call(() => api.artifact.block.create({ id: doc.id, text: "中间", afterBlock: made.blockId }));
    expect((await call(() => api.artifact.block.list({ id: doc.id }))).blocks.map((b) => b.text.map((x) => x.t).join(""))).toEqual([
      "新的开头",
      "中间",
      "第二",
    ]);
    const response6 = await call(() => api.artifact.block.delete({ id: doc.id, block: second.blockId }));
    expect(response6).toMatchObject({ status: "applied" });
    expect((await call(() => api.artifact.block.list({ id: doc.id }))).blocks.map((b) => b.id)).not.toContain(second.blockId);
    // A message pointing at a block carries its id, the version quoted, and how it reads now.
    const general = channels.find((c) => c.default)!.id;
    const current = (await call(() => api.artifact.block.list({ id: doc.id }))).blocks.find((b) => b.id === made.blockId)!;
    await call(() => api.channel.message.send({ id: general, text: "看这块", blocks: [{ artifactId: doc.id, blockId: made.blockId, rev: 1 }] }));
    const quotedAfter = (await call(() => api.artifact.block.list({ id: doc.id }))).blocks.find((b) => b.id === made.blockId)!;
    expect(quotedAfter.text).toEqual(current.text);
    const allMessages = await call(() => api.channel.message.list({ id: general, limit: 5 }));
    const sent = allMessages.find((m) => m.text === "看这块")!;
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
    const third = await call(() => api.artifact.block.create({ id: doc.id, text: "要走" }));
    await call(() => api.artifact.block.update({ id: doc.id, block: made.blockId, baseRev: current.rev, text: "又改了" }));
    await call(() => api.artifact.block.delete({ id: doc.id, block: third.blockId }));
    await call(() =>
      api.channel.message.send({
        id: general,
        text: "两块一起看",
        blocks: [
          { artifactId: doc.id, blockId: made.blockId, rev: current.rev },
          { artifactId: doc.id, blockId: third.blockId, rev: third.rev ?? 1 },
        ],
      }),
    );
    const live = (await call(() => api.artifact.block.list({ id: doc.id }))).blocks.find((b) => b.id === made.blockId)!;
    const suggestion = await call(() =>
      api.artifact.suggestion.create({
        id: doc.id,
        block: made.blockId,
        baseRev: live.rev,
        change: { text: [{ t: "用户点过头的字", marks: {} }] },
      }),
    );
    expect((await call(() => api.artifact.suggestion.list({ id: doc.id }))).map((s) => s.id)).toContain(suggestion.id);
    const accepted = await call(() => api.artifact.suggestion.accept({ id: doc.id, suggestion: suggestion.id }));
    expect(accepted.status).toBe("accepted");
    expect(
      (await call(() => api.artifact.block.list({ id: doc.id }))).blocks
        .find((b) => b.id === made.blockId)!
        .text.map((x) => x.t)
        .join(""),
    ).toBe("用户点过头的字");
    const many = (await call(() => api.channel.message.list({ id: general, limit: 5 }))).find((m) => m.text === "两块一起看")!;
    expect(many.blocks).toMatchObject([
      { blockId: made.blockId, rev: current.rev, text: "又改了" },
      { blockId: third.blockId, rev: third.rev, deleted: true },
    ]);
  });

  test("take a blocks artifact's block in the editor's shape: the new block's content and place, the rest filled in", async () => {
    await using api = await farm();
    const before = Date.now();
    const made = await call(() => api.artifact.create({ title: "插入", kind: "markdown" }));
    const inserted = newId();
    await call(() =>
      api.artifact.submit({
        id: made.id,
        batchId: newId(),
        lastSeq: 0,
        ops: [{ op: "insert_block", block: { id: blockId(inserted), orderKey: "V", type: "paragraph", attrs: {}, text: [{ t: "你好世界", marks: {} }] } }],
      }),
    );
    const saved = (await call(() => api.artifact.block.list({ id: made.id }))).blocks[0]!;
    expect(saved).toMatchObject({ id: inserted, artifactId: made.id, rev: 1, updatedBy: "user", text: [{ t: "你好世界", marks: {} }] });
    expect(saved.updated).toBeGreaterThanOrEqual(before);
    expect(saved.deleted).toBeUndefined();

    const imported = await call(() => api.artifact.create({ title: "拆分", kind: "markdown", content: "你好世界" }));
    const source = (await call(() => api.artifact.block.list({ id: imported.id }))).blocks[0]!;
    const split = newId();
    await call(() =>
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
    const after = await call(() => api.artifact.block.list({ id: imported.id }));
    expect(after.blocks.map((b) => b.text.map((x) => x.t).join(""))).toEqual(["你好", "世界"]);
    expect(after.blocks[1]).toMatchObject({ id: split, artifactId: imported.id, rev: 1, updatedBy: "user" });
  });

  // The issue's page sends what the user changed but has not saved with the button they pressed.
  test("save an issue's unsaved fields before its act is tried, even when the act is refused", async () => {
    await using api = await farm();
    const made = await call(() => api.issue.create({ title: "带着改动开工之前" }));
    const refusal2 = await refusal(() => api.issue.status.update({ id: made.id, status: "todo", edit: { title: "带着改动开工", priority: "high" } }));
    expect(refusal2).toBe("Refused");
    const got = await call(() => api.issue.get({ id: made.id }));
    expect([got.title, got.priority, got.status]).toEqual(["带着改动开工", "high", "backlog"]);
  });

  test("refuses a body past its limit before reading it, and stops reading one that grows past it", async () => {
    await using served = await app(testConfig(), 0, undefined, quietApp);
    const [declared, streamed] = await postBig(`http://${served.address}/api/v1/channel/message/list`);
    expect([declared, streamed]).toEqual([413, 413]);
  });
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
  const init: RequestInit & { duplex: "half" } = { method: "POST", body: chunks, duplex: "half" };
  const streamed = await fetch(url, init).then(
    (r) => r.status,
    () => "cut",
  );
  return [declared, streamed] as const;
}
