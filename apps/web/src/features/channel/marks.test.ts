import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import { type Channel, type ChatMessage, ownerId, VibeValleyApiError } from "@vibevalley/protocol";

import { api } from "@/infra/api";
import { frameAt, testFrames } from "@/infra/testing";
import { type Intent, intentsIn } from "@/state/intent";
import { deferred, testRegistry } from "@/state/testing";

import { followed } from "./follow";
import {
  archiveSet,
  type ArchiveMark,
  markedChannel,
  markedMessages,
  notifySet,
  type NotifyMark,
  type PinMark,
  type ReactionMark,
  reactionSet,
  sameReaction,
  setMark,
} from "./marks";
import { markedRead, type ReadMark } from "./reading";

// A mark's channel is followed while the mark is kept; these tests have no server to follow.
beforeEach(() => void vi.spyOn(followed, "subscribe").mockReturnValue(() => {}));
afterEach(() => vi.restoreAllMocks());

const message = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  number: 1,
  channel: "c",
  from: "a",
  fromKind: "session",
  name: "a",
  kind: "chat",
  text: "hi",
  mentions: [],
  spoken: false,
  at: 0,
  revision: 1,
  reactions: [],
  attachments: [],
  embeds: [],
  ...over,
});

const kept = <I>(input: I, over: Partial<Intent<I, never>> = {}): Intent<I, never> => ({ key: "k", input, status: "pending", queued: false, ...over });

const channel = (over: Partial<Channel> = {}): Channel => ({
  id: "c",
  type: "channel",
  default: false,
  category: "",
  description: "",
  replies: 0,
  title: "",
  at: 0,
  ...over,
});

test("a reaction on its way shows as the owner's at once, beside the others', and only on its message", () => {
  const m = message("m", { reactions: [{ emoji: "👍", by: ["b"] }] });
  const other = message("n");
  const [shown, untouched] = markedMessages([m, other], [kept<ReactionMark>({ channel: "c", id: "m", emoji: "👍", on: true })], []);
  expect(shown?.reactions).toEqual([{ emoji: "👍", by: ["b", ownerId] }]);
  expect(untouched).toBe(other);
});

test("a reaction taken back goes, and the emoji with it when nobody else had it", () => {
  const m = message("m", {
    reactions: [
      { emoji: "👍", by: [ownerId] },
      { emoji: "🎉", by: [ownerId, "b"] },
    ],
  });
  const marks = [kept<ReactionMark>({ channel: "c", id: "m", emoji: "👍", on: false }), kept<ReactionMark>({ channel: "c", id: "m", emoji: "🎉", on: false })];
  expect(markedMessages([m], marks, [])[0]?.reactions).toEqual([{ emoji: "🎉", by: ["b"] }]);
});

test("a pin on its way sets pinned and nothing else; with no marks the list is the same object", () => {
  const m = message("m");
  const [shown] = markedMessages([m], [], [kept<PinMark>({ channel: "c", id: "m", on: true, at: 9 })]);
  expect(shown).toEqual({ ...m, pinned: 9 });
  const pinned = message("p", { pinned: 3 });
  expect(markedMessages([pinned], [], [kept<PinMark>({ channel: "c", id: "p", on: false, at: 9 })])[0]?.pinned).toBeUndefined();
  const list = [m];
  expect(markedMessages(list, [], [])).toBe(list);
});

test("a channel's archive, notify and unread marks set only those fields", () => {
  const c = channel({ read: 10, unread: 0, notify: "all" });
  const shown = markedChannel(c, {
    archives: [kept<ArchiveMark>({ id: "c", on: true, at: 5 })],
    notifies: [kept<NotifyMark>({ id: "c", notify: "none" })],
    unreads: [kept<ReadMark>({ channel: "c", number: 4 })],
  });
  expect(shown).toEqual({ ...c, archived: 5, notify: "none", read: 3 });
  expect(markedChannel(c, { archives: [], notifies: [], unreads: [] })).toBe(c);
});

test("marked unread at the first message reads as nothing read, and an older read is left as it is", () => {
  expect(markedRead(channel({ read: 5 }), [kept<ReadMark>({ channel: "c", number: 1 })]).read).toBe(0);
  const behind = channel({ read: 2 });
  expect(markedRead(behind, [kept<ReadMark>({ channel: "c", number: 8 })])).toBe(behind);
});

test("a reaction settles when the channel's copy shows it, not when the reply comes", async () => {
  const reply = deferred<ChatMessage>();
  vi.spyOn(api.channel.reaction, "set").mockReturnValue(reply.promise);
  let copy = message("m");
  let heard = () => {};
  vi.spyOn(followed, "subscribe").mockImplementation((_id, changed) => {
    heard = changed;
    return () => {};
  });
  vi.spyOn(followed, "get").mockImplementation(() => ({ messages: [copy], complete: true, ready: true }));
  const intents = intentsIn(testRegistry(), reactionSet);
  const { done } = intents.send({ channel: "c", id: "m", emoji: "👍", on: true });
  reply.resolve(copy);
  await done;
  expect(intents.all()).toHaveLength(1);
  copy = message("m", { reactions: [{ emoji: "👍", by: [ownerId] }] });
  heard();
  expect(intents.all()).toEqual([]);
});

test("a refused mark is let go and said, so the overlay goes and the server's state shows", async () => {
  vi.spyOn(api.channel.archive, "set").mockRejectedValue(new VibeValleyApiError(404, "Missing", "没有这个频道"));
  const intents = intentsIn(testRegistry(), archiveSet);
  const said = deferred<string>();
  setMark(intents, { id: "c", on: true, at: 1 }, (a, b) => a.id === b.id, said.resolve);
  expect(intents.all()).toHaveLength(1);
  expect(await said.promise).toBe("没有这个频道");
  expect(intents.all()).toEqual([]);
});

test("a level picked again before the first showed replaces it, and settles on the frame's level", async () => {
  const frames = testFrames({ frame: frameAt(0) });
  vi.spyOn(api.channel.notify, "set").mockResolvedValue(undefined);
  const intents = intentsIn(testRegistry(frames), notifySet);
  const same = (a: NotifyMark, b: NotifyMark) => a.id === b.id;
  setMark(intents, { id: "c", notify: "mentions" }, same, () => {});
  setMark(intents, { id: "c", notify: "none" }, same, () => {});
  expect(intents.all().map((i) => i.input.notify)).toEqual(["none"]);
  await Promise.resolve();
  const f = frameAt(1);
  frames.set({ frame: { ...f, state: { ...f.state, chat: { channels: [channel({ notify: "none" })], ownerMentions: [] } } } });
  expect(intents.all()).toEqual([]);
});

test("two reactions on one message are two marks; the same emoji again is one", () => {
  expect(sameReaction({ channel: "c", id: "m", emoji: "👍", on: true }, { channel: "c", id: "m", emoji: "👍", on: false })).toBe(true);
  expect(sameReaction({ channel: "c", id: "m", emoji: "👍", on: true }, { channel: "c", id: "m", emoji: "🎉", on: true })).toBe(false);
});
