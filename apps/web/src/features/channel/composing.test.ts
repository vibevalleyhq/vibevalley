import { createRoot, flush } from "solid-js";
import type * as solid from "solid-js";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";

import { api } from "@/base/api";
import { type Intent, intentsIn } from "@/base/intent";
import { deferred, testRegistry } from "@/base/testing";

import { chatSay, createComposer, type ComposerWays, pendingLines, type Said } from "./composing";
import { followed } from "./follow";

vi.mock("solid-js", () => vi.importActual<typeof solid>("../../../node_modules/solid-js/dist/solid.js"));
// A line's channel is followed while the line is kept; these tests have no server to follow.
beforeEach(() => void vi.spyOn(followed, "subscribe").mockReturnValue(() => {}));
afterEach(() => vi.restoreAllMocks());

function setup(target: ReturnType<ComposerWays["target"]> = { id: "channel" }) {
  const says = intentsIn(testRegistry(), chatSay);
  const failed = vi.fn();
  let dispose = () => {};
  const box = createRoot((stop) => {
    dispose = stop;
    return createComposer(
      () => undefined,
      () => undefined,
      { target: () => target, says, failed },
    );
  });
  flush();
  const type = (text: string) => {
    box.edit(text, text.length);
    flush();
  };
  return { box, says, failed, type, dispose: () => dispose() };
}

test("a line is on its way at once: the box empties, and every routing field goes with it under the line's key", async () => {
  const send = vi.spyOn(api.channel.message, "send").mockResolvedValue(undefined);
  const s = setup({ id: "thread", agent: "a", project: "p", station: 1 });
  try {
    s.type(" 同一句 ");
    const sending = s.box.send();
    flush();
    expect(s.box.text()).toBe("");
    const [line] = s.says.all();
    expect(line).toMatchObject({ status: "pending", input: { id: "thread", agent: "a", project: "p", station: 1, text: "同一句" } });
    await sending;
    expect(send).toHaveBeenCalledWith({ id: "thread", agent: "a", project: "p", station: 1, text: "同一句", sendKey: line?.key });
  } finally {
    s.dispose();
  }
});

test("a lost reply leaves the line failed and told; a retry after the composer is gone sends the same key", async () => {
  const send = vi.spyOn(api.channel.message, "send").mockRejectedValueOnce(new Error("response lost")).mockResolvedValue(undefined);
  const s = setup();
  s.type("还在吗");
  await s.box.send();
  expect(s.failed).toHaveBeenCalledWith("response lost");
  const [line] = s.says.all();
  expect(line).toMatchObject({ status: "failed", input: { text: "还在吗" } });
  s.dispose();
  await s.says.retry(line?.key ?? "");
  expect(send.mock.calls.map(([body]) => body.sendKey)).toEqual([line?.key, line?.key]);
  expect(s.says.all()).toMatchObject([{ key: line?.key, status: "pending", replied: {} }]);
});

test("a composer closed while its line is on its way tells nobody of the outcome", async () => {
  const reply = deferred<undefined>();
  vi.spyOn(api.channel.message, "send").mockReturnValue(reply.promise);
  const s = setup();
  s.type("还在发送");
  const sending = s.box.send();
  s.dispose();
  reply.reject(new Error("lost"));
  await sending;
  expect(s.failed).not.toHaveBeenCalled();
  expect(s.says.all()).toMatchObject([{ status: "failed" }]);
});

test("a channel's lines on their way are the ones its messages do not have yet, oldest first", () => {
  const said = (key: string, id: string, over: Partial<Intent<Said, void>> = {}): Intent<Said, void> => ({
    key,
    input: { id, text: key },
    status: "pending",
    queued: false,
    ...over,
  });
  const arrived = [{ sendKey: "b" }];
  expect(pendingLines([said("a", "c1"), said("b", "c1"), said("x", "c2"), said("d", "c1", { status: "failed", reason: "不行" })], "c1", arrived)).toEqual([
    { key: "a", text: "a", state: "sending" },
    { key: "d", text: "d", state: "failed", reason: "不行" },
  ]);
  expect(pendingLines([said("a", "c1")], undefined, [])).toEqual([]);
});
