import { expect, test } from "./fixtures";

test("insert accepts only the new block's content and position", async ({ api, request }) => {
  const doc = await api.doc.create({ body: { title: "最小插入命令" } });
  const id = crypto.randomUUID();
  const before = Date.now();
  const response = await request.post(`/api/v1/docs/${doc.doc.id}/submit`, {
    data: {
      batchId: crypto.randomUUID(),
      lastSeq: 0,
      ops: [{ op: "insert_block", block: { id, orderKey: "V", type: "paragraph", attrs: {}, text: [{ t: "你好世界", marks: {} }] } }],
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  const saved = (await api.doc.get({ id: doc.doc.id })).blocks[0]!;
  expect(saved).toMatchObject({ id, docId: doc.doc.id, rev: 1, updatedBy: "owner", text: [{ t: "你好世界", marks: {} }] });
  expect(saved.updated).toBeGreaterThanOrEqual(before);
  expect(saved.updated).toBeLessThanOrEqual(Date.now());
  expect(saved.deleted).toBeUndefined();
});

test("split accepts a new block without fabricated server metadata", async ({ api, request }) => {
  const doc = await api.doc.import({ body: { title: "最小拆分命令", markdown: "你好世界" } });
  const source = doc.blocks[0]!;
  const id = crypto.randomUUID();
  const before = Date.now();
  const response = await request.post(`/api/v1/docs/${doc.doc.id}/submit`, {
    data: {
      batchId: crypto.randomUUID(),
      lastSeq: doc.doc.seq,
      ops: [{ op: "split_block", blockId: source.id, baseRev: source.rev, offset: 2, newBlock: { id, orderKey: "W", type: "paragraph", attrs: {}, text: [] } }],
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  const saved = await api.doc.get({ id: doc.doc.id });
  expect(saved.blocks.map((b) => b.text.map((s) => s.t).join(""))).toEqual(["你好", "世界"]);
  expect(saved.blocks[1]).toMatchObject({ id, docId: doc.doc.id, rev: 1, updatedBy: "owner" });
  expect(saved.blocks[1]!.updated).toBeGreaterThanOrEqual(before);
});
