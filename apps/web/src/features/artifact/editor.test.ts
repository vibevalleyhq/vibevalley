import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import { type Block, type BlockAck, type BlockSnapshot, userId } from "@vibevalley/protocol";
import { artifactId, blockId } from "@vibevalley/protocol/schema";

import { api } from "#/infra/api.ts";
import { deferred } from "#/state/testing.ts";

import { BlockEditor } from "./editor";

const id = artifactId("artifact");
const block = (rev: number, text: string, by = "helper", key = "a"): Block => ({
  id: blockId(key),
  artifactId: id,
  orderKey: key,
  type: "paragraph",
  attrs: {},
  text: [{ t: text, marks: {} }],
  rev,
  updatedBy: by,
  updated: rev,
});
const snapshot = (blocks: Block[], seq = 1): BlockSnapshot => ({
  artifact: { id, title: "shared", body: "blocks", by: userId, byName: "user", version: 0, seq, versions: [], at: 0, updated: 0 },
  blocks,
});
const editors: BlockEditor[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const opened = async (blocks = [block(1, "initial", userId)]) => {
  vi.spyOn(api.artifact.block, "list").mockResolvedValue(snapshot(blocks));
  const editor = new BlockEditor(api, id);
  editors.push(editor);
  await editor.load();
  editor.setLive(true);
  return editor;
};

test("regression: writer indicators expire without another poll or pushed batch", async () => {
  const editor = await opened();
  const changed = vi.fn();
  editor.subscribe(changed);
  editor.receive({ seq: 2, blocks: [block(2, "remote")] });
  expect(editor.writing(editor.blocks[0]!)).toBe(true);
  expect(editor.othersWriting).toBe(true);
  changed.mockClear();
  await vi.advanceTimersByTimeAsync(2999);
  expect(editor.writing(editor.blocks[0]!)).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(editor.writing(editor.blocks[0]!)).toBe(false);
  expect(changed).toHaveBeenCalled();
  changed.mockClear();
  await vi.advanceTimersByTimeAsync(1000);
  expect(editor.othersWriting).toBe(false);
  expect(changed).toHaveBeenCalled();
  expect(api.artifact.block.list).toHaveBeenCalledTimes(1);
});

test("regression: leaving an unchanged focused block applies the newest deferred version without polling", async () => {
  const editor = await opened();
  const mine = editor.blocks[0]!;
  editor.focus(mine, true);
  editor.receive({ seq: 3, blocks: [block(3, "newest")] });
  editor.receive({ seq: 2, blocks: [block(2, "older")] });
  expect([mine.text, mine.rev]).toEqual(["initial", 1]);
  editor.focus(mine, false);
  expect([mine.text, mine.rev]).toEqual(["newest", 3]);
  expect(api.artifact.block.list).toHaveBeenCalledTimes(1);
});

test("regression: a deferred update cannot rebase queued local text behind an in-flight batch", async () => {
  const editor = await opened([block(1, "first", userId), block(1, "second", userId, "b")]);
  const replies = [deferred<BlockAck>(), deferred<BlockAck>()];
  const submit = vi.spyOn(api.artifact, "submit").mockReturnValueOnce(replies[0]!.promise).mockReturnValueOnce(replies[1]!.promise);
  const [first, second] = editor.blocks;
  editor.edited(first!, "first local", 11);
  editor.flush();
  editor.focus(second!, true);
  editor.receive({ seq: 2, blocks: [block(2, "remote second", "helper", "b")] });
  editor.edited(second!, "second local", 12);
  editor.focus(second!, false);
  expect([second!.text, second!.rev]).toEqual(["second local", 1]);
  replies[0]!.resolve({ batchId: "first", seq: 3, blocks: [block(2, "first local", userId)], results: [] });
  await vi.advanceTimersByTimeAsync(0);
  expect(submit.mock.calls[1]?.[0].ops).toEqual([{ op: "update_text", blockId: second!.id, baseRev: 1, text: [{ t: "second local", marks: {} }] }]);
  replies[1]!.resolve({
    batchId: "second",
    seq: 3,
    blocks: [block(2, "remote second", "helper", "b")],
    results: [{ status: "conflict", blockId: second!.id, reason: "changed" }],
  });
  await vi.advanceTimersByTimeAsync(0);
  expect([second!.text, second!.rev]).toEqual(["remote second", 2]);
  expect(second!.problem).toContain("changed");
});

test("regression: composition keeps its text and original revision across a remote update and blur", async () => {
  const editor = await opened();
  const mine = editor.blocks[0]!;
  const reply = deferred<BlockAck>();
  const submit = vi.spyOn(api.artifact, "submit").mockReturnValue(reply.promise);
  editor.focus(mine, true);
  editor.composition(mine, true, "initial");
  editor.edited(mine, "拼字中", 3);
  editor.receive({ seq: 2, blocks: [block(2, "remote")] });
  editor.focus(mine, false);
  expect([mine.text, mine.rev]).toEqual(["拼字中", 1]);
  expect(submit).not.toHaveBeenCalled();
  editor.composition(mine, false, "拼字中");
  await vi.advanceTimersByTimeAsync(500);
  expect(submit.mock.calls[0]?.[0].ops[0]).toMatchObject({ op: "update_text", baseRev: 1, text: [{ t: "拼字中", marks: {} }] });
  reply.resolve({ batchId: "ime", seq: 2, blocks: [block(2, "remote")], results: [{ status: "conflict", blockId: mine.id, reason: "changed" }] });
  await vi.advanceTimersByTimeAsync(0);
  expect(mine.problem).toContain("changed");
});

test("regression: a late acknowledgement cannot move the next batch cursor behind a pushed update", async () => {
  const editor = await opened([block(1, "first", userId), block(1, "second", userId, "b")]);
  const replies = [deferred<BlockAck>(), deferred<BlockAck>()];
  const submit = vi.spyOn(api.artifact, "submit").mockReturnValueOnce(replies[0]!.promise).mockReturnValueOnce(replies[1]!.promise);
  const mine = editor.blocks[0]!;
  editor.edited(mine, "local", 5);
  editor.flush();
  editor.receive({ seq: 5, blocks: [block(5, "newest", "helper", "b")] });
  replies[0]!.resolve({ batchId: "first", seq: 2, blocks: [block(2, "local", userId)], results: [] });
  await vi.advanceTimersByTimeAsync(0);
  editor.receive({ seq: 3, blocks: [block(3, "old", "helper", "b")] });
  editor.receive({ seq: 4, blocks: [{ ...block(4, "deleted", "helper", "b"), deleted: true }] });
  expect([editor.blocks[1]!.text, editor.blocks[1]!.rev]).toEqual(["newest", 5]);
  editor.edited(mine, "local again", 11);
  editor.flush();
  expect(submit.mock.calls[1]?.[0].lastSeq).toBe(5);
  replies[1]!.resolve({ batchId: "second", seq: 6, blocks: [block(3, "local again", userId)], results: [] });
  await vi.advanceTimersByTimeAsync(0);
});

test("the HTTP fallback still reads remote edits while the socket is unavailable", async () => {
  const editor = await opened();
  vi.mocked(api.artifact.block.list).mockResolvedValue(snapshot([block(2, "fallback")], 2));
  editor.setLive(false);
  await vi.advanceTimersByTimeAsync(4000);
  expect(editor.blocks[0]!.text).toBe("fallback");
  expect(api.artifact.block.list).toHaveBeenCalledTimes(2);
  editor.dispose();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(10000);
  expect(api.artifact.block.list).toHaveBeenCalledTimes(2);
});

test("regression: a snapshot started before a newer pushed update cannot replace it", async () => {
  const editor = await opened();
  const pending = deferred<BlockSnapshot>();
  vi.mocked(api.artifact.block.list).mockReturnValueOnce(pending.promise);
  const loading = editor.load();
  editor.receive({ seq: 4, blocks: [block(4, "newest")] });
  pending.resolve(snapshot([block(2, "stale snapshot")], 2));
  await loading;
  expect([editor.blocks[0]!.text, editor.blocks[0]!.rev]).toEqual(["newest", 4]);
});

test("regression: a reset snapshot cannot rebase text already being edited", async () => {
  const editor = await opened();
  const mine = editor.blocks[0]!;
  const reply = deferred<BlockAck>();
  const submit = vi.spyOn(api.artifact, "submit").mockReturnValue(reply.promise);
  editor.focus(mine, true);
  editor.edited(mine, "local", 5);
  vi.mocked(api.artifact.block.list).mockResolvedValue(snapshot([block(2, "remote")], 2));
  await editor.load();
  expect([mine.text, mine.rev]).toEqual(["local", 1]);
  editor.focus(mine, false);
  expect(submit.mock.calls[0]?.[0].ops[0]).toMatchObject({ op: "update_text", baseRev: 1 });
  reply.resolve({ batchId: "reset", seq: 2, blocks: [block(2, "remote")], results: [{ status: "conflict", blockId: mine.id, reason: "changed" }] });
  await vi.advanceTimersByTimeAsync(0);
  expect(mine.problem).toContain("changed");
});

test("regression: an unrelated batch does not delay a clean block's deferred update", async () => {
  const editor = await opened([block(1, "first", userId), block(1, "second", userId, "b")]);
  const pending = deferred<BlockAck>();
  vi.spyOn(api.artifact, "submit").mockReturnValue(pending.promise);
  const [first, second] = editor.blocks;
  editor.edited(first!, "local", 5);
  editor.flush();
  editor.focus(second!, true);
  editor.receive({ seq: 2, blocks: [block(2, "remote", "helper", "b")] });
  editor.focus(second!, false);
  expect([second!.text, second!.rev]).toEqual(["remote", 2]);
  pending.resolve({ batchId: "first", seq: 3, blocks: [block(2, "local", userId)], results: [] });
  await vi.advanceTimersByTimeAsync(0);
});

test("regression: a reset snapshot preserves a new block whose insertion is in flight", async () => {
  const editor = await opened();
  const pending = deferred<BlockAck>();
  vi.spyOn(api.artifact, "submit").mockReturnValue(pending.promise);
  editor.append();
  const added = editor.blocks[1]!;
  expect(added.rev).toBe(0);
  await editor.load();
  expect(editor.blocks.map((b) => b.id)).toEqual([blockId("a"), added.id]);
  pending.resolve({ batchId: "insert", seq: 2, blocks: [{ ...block(1, "", userId, added.id), orderKey: added.orderKey }], results: [] });
  await vi.advanceTimersByTimeAsync(0);
  expect(editor.blocks[1]?.rev).toBe(1);
});
