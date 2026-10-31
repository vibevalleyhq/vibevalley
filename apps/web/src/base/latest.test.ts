import { afterEach, expect, test, vi } from "vite-plus/test";

import { VibeValleyApiError } from "@vibevalley/protocol";

import { type Answer, latestReader } from "./latest";
import { deferred } from "./testing";

afterEach(() => vi.useRealTimers());

function setup(waitMs = 0) {
  const asked: { key: string; reply: ReturnType<typeof deferred<string>> }[] = [];
  const heard: (Answer<string> | undefined)[] = [];
  const reader = latestReader<string, string>(
    (key) => {
      const reply = deferred<string>();
      asked.push({ key, reply });
      return reply.promise;
    },
    waitMs,
    (a) => heard.push(a),
  );
  const reply = (n: number) => {
    const a = asked[n];
    if (!a) throw new Error(`no ask ${n}`);
    return a.reply;
  };
  return { reader, asked, heard, reply };
}

/** Lets the answers' handlers run: they are a few microtasks behind the reply. */
const settle = () =>
  Promise.resolve()
    .then(() => Promise.resolve())
    .then(() => Promise.resolve());

test("an answer to an earlier ask that comes after the newest one's is dropped", async () => {
  const { reader, heard, reply } = setup();
  reader.request("a");
  reader.request("ab");
  reply(1).resolve("hits for ab");
  await settle();
  reply(0).resolve("hits for a");
  await settle();
  expect(heard.at(-1)).toEqual({ state: "done", value: "hits for ab" });
  expect(heard).not.toContainEqual({ state: "done", value: "hits for a" });
});

test("a failure is told as one, with the server's reason, not as nothing found", async () => {
  const { reader, heard, reply } = setup();
  reader.request("a");
  reply(0).reject(new VibeValleyApiError(500, undefined, "搜不了"));
  await settle();
  expect(heard).toEqual([{ state: "waiting" }, { state: "failed", reason: "搜不了" }]);
});

test("typing on within the wait asks once, for the last words; nothing to ask tells nothing", () => {
  vi.useFakeTimers();
  const { reader, asked, heard } = setup(200);
  reader.request("a");
  vi.advanceTimersByTime(100);
  reader.request("ab");
  vi.advanceTimersByTime(200);
  expect(asked.map((a) => a.key)).toEqual(["ab"]);
  reader.request(undefined);
  expect(heard.at(-1)).toBeUndefined();
});

test("stopped, nothing on its way is told", async () => {
  const { reader, heard, reply } = setup();
  reader.request("a");
  reader.stop();
  reply(0).resolve("late");
  await settle();
  expect(heard).toEqual([{ state: "waiting" }]);
});
