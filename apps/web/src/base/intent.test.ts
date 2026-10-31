import { afterEach, expect, test, vi } from "vite-plus/test";

import { VibeValleyApiError } from "@vibevalley/protocol";

import { bySeq, defineIntent, intentsIn, sendOnce, sendReplacing } from "./intent";
import { deferred, frameAt, testFrames, testRegistry } from "./testing";

afterEach(() => vi.useRealTimers());

/** A kind whose sends the test answers one by one, settled by the frame's seq. */
function setup(whileLost: "queue" | "refuse" = "queue") {
  const frames = testFrames({ frame: frameAt(0) });
  const sent: { key: string; reply: ReturnType<typeof deferred<{ seq: number }>> }[] = [];
  const type = defineIntent<{ id: string }, { seq: number }>({
    send: (_input, key) => {
      const reply = deferred<{ seq: number }>();
      sent.push({ key, reply });
      return reply.promise;
    },
    confirmed: bySeq,
    whileLost,
    timeoutMs: 1000,
  });
  const intents = intentsIn(testRegistry(frames), type);
  /** The nth send's reply, for the test to give. */
  const reply = (n: number) => {
    const s = sent[n];
    if (!s) throw new Error(`no send ${n}`);
    return s.reply;
  };
  return { frames, sent, intents, reply };
}

test("a refused one fails with the server's reason and stays, and a retry sends the same key", async () => {
  const { sent, intents, reply } = setup();
  const { key, done } = intents.send({ id: "12" });
  expect(intents.all()).toMatchObject([{ key, status: "pending" }]);
  reply(0).reject(new VibeValleyApiError(409, "Refused", "进行中满了"));
  expect(await done).toMatchObject({ status: "failed", reason: "进行中满了" });
  expect(intents.all()).toMatchObject([{ key, status: "failed", reason: "进行中满了" }]);
  const again = intents.retry(key);
  expect(intents.all()).toMatchObject([{ key, status: "pending" }]);
  expect(sent.map((s) => s.key)).toEqual([key, key]);
  reply(1).resolve({ seq: 0 });
  expect((await again)?.replied?.reply).toEqual({ seq: 0 });
  // The frame was there already: it settles on the reply.
  expect(intents.all()).toEqual([]);
});

test("a frame that came before the reply settles it once the reply comes, and only once", async () => {
  const { frames, sent, intents, reply } = setup();
  const { done } = intents.send({ id: "12" });
  frames.set({ frame: frameAt(5) });
  expect(intents.all()).toHaveLength(1);
  reply(0).resolve({ seq: 5 });
  await done;
  expect(intents.all()).toEqual([]);
  frames.set({ frame: frameAt(6) });
  expect(intents.all()).toEqual([]);
  expect(sent).toHaveLength(1);
});

test("a reply before its frame keeps it pending until a frame that far comes", async () => {
  const { frames, intents, reply } = setup();
  const { key, done } = intents.send({ id: "12" });
  reply(0).resolve({ seq: 7 });
  await done;
  expect(intents.all()).toMatchObject([{ key, status: "pending", replied: { reply: { seq: 7 } } }]);
  frames.set({ frame: frameAt(6) });
  expect(intents.all()).toHaveLength(1);
  frames.set({ frame: frameAt(7) });
  expect(intents.all()).toEqual([]);
});

test("no answer in time fails it and keeps it; a late reply still counts", async () => {
  vi.useFakeTimers();
  const { frames, intents, reply } = setup();
  const { key, done } = intents.send({ id: "12" });
  vi.advanceTimersByTime(1000);
  expect(await done).toMatchObject({ key, status: "failed" });
  expect(intents.all()).toMatchObject([{ key, status: "failed" }]);
  reply(0).resolve({ seq: 3 });
  await vi.runAllTimersAsync();
  expect(intents.all()).toMatchObject([{ key, status: "failed", replied: { reply: { seq: 3 } } }]);
  frames.set({ frame: frameAt(3) });
  expect(intents.all()).toEqual([]);
});

test("while the link is lost a keyed kind queues and sends once when it is back; another refuses", async () => {
  const { frames, sent, intents, reply } = setup();
  frames.set({ link: "lost" });
  const { key, done } = intents.send({ id: "12" });
  expect(intents.all()).toMatchObject([{ key, status: "pending", queued: true }]);
  frames.set({ link: "lost", count: 1 });
  expect(sent).toEqual([]);
  frames.set({ link: "open", frame: frameAt(1) });
  frames.set({ link: "open", frame: frameAt(2) });
  expect(sent.map((s) => s.key)).toEqual([key]);
  expect(intents.all()).toMatchObject([{ key, status: "pending", queued: false }]);
  reply(0).resolve({ seq: 2 });
  await done;
  expect(intents.all()).toEqual([]);

  const refusing = setup("refuse");
  refusing.frames.set({ link: "lost" });
  expect(await refusing.intents.send({ id: "12" }).done).toMatchObject({ status: "failed" });
  expect(refusing.sent).toEqual([]);
});

test("a button pressed again while its intent is on its way is that intent", async () => {
  const { sent, intents, reply } = setup();
  const first = sendOnce(intents, { id: "12" });
  const second = sendOnce(intents, { id: "12" });
  expect(sent).toHaveLength(1);
  expect((await second)?.key).toBe(sent[0]?.key);
  reply(0).reject(new Error("lost"));
  await first;
  void sendOnce(intents, { id: "12" });
  expect(sent.map((s) => s.key)).toEqual([sent[0]?.key, sent[0]?.key]);
});

test("letting one go drops it from the list and answers whoever waits", async () => {
  const { intents } = setup();
  const { key, done } = intents.send({ id: "12" });
  expect(intents.drop(key)).toMatchObject({ key });
  expect(intents.all()).toEqual([]);
  expect(await done).toBeUndefined();
});

test("a setting changed again before the first showed keeps only the newer", () => {
  const { intents, sent } = setup();
  sendReplacing(intents, { id: "12" }, (a, b) => a.id === b.id);
  const { key } = sendReplacing(intents, { id: "12" }, (a, b) => a.id === b.id);
  sendReplacing(intents, { id: "13" }, (a, b) => a.id === b.id);
  expect(intents.all().map((i) => [i.key, i.input.id])).toEqual([
    [key, "12"],
    [sent[2]?.key, "13"],
  ]);
});
