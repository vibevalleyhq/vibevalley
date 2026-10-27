import { afterEach, expect, test, vi } from "vite-plus/test";
import type * as solid from "solid-js";
import { createRoot, createSignal, flush } from "solid-js";
import { api } from "../../base/api";
import { createComposer, type ComposerWays } from "./composing";

vi.mock("solid-js", () => vi.importActual<typeof solid>("../../../node_modules/solid-js/dist/solid.js"));
afterEach(() => vi.restoreAllMocks());

function setup() {
  let dispose!: () => void;
  let target!: (next: ReturnType<ComposerWays["target"]>) => unknown;
  const failed = vi.fn();
  const box = createRoot((stop) => {
    dispose = stop;
    const [to, setTo] = createSignal<ReturnType<ComposerWays["target"]>>({ conversation: "channel" });
    target = setTo;
    return createComposer(
      () => undefined,
      () => undefined,
      { target: to, failed },
    );
  });
  flush();
  const edit = (text: string) => {
    box.edit(text, text.length);
    flush();
  };
  return {
    box,
    target: (next: ReturnType<ComposerWays["target"]>) => {
      target(next);
      flush();
    },
    edit,
    failed,
    dispose,
  };
}

test("every routing field participates in a send identity, while unchanged retries keep it", async () => {
  const send = vi.spyOn(api.channel, "say").mockRejectedValue(new Error("response lost"));
  const s = setup();
  try {
    s.edit("同一句");
    for (const target of [
      { conversation: "channel" },
      { conversation: "thread" },
      { conversation: "thread", agent: "a" },
      { conversation: "thread", agent: "a", project: "p" },
      { conversation: "thread", agent: "a", project: "p", station: 1 },
    ]) {
      s.target(target);
      await s.box.send();
      const first = send.mock.calls.at(-1)![0].body;
      await s.box.send();
      expect(send.mock.calls.at(-1)![0].body).toEqual(first);
    }
    const keys = send.mock.calls.filter((_, i) => i % 2 === 0).map(([request]) => request.body.sendKey);
    expect(new Set(keys).size).toBe(5);
    s.edit("改了文字");
    await s.box.send();
    expect(keys).not.toContain(send.mock.calls.at(-1)![0].body.sendKey);
  } finally {
    s.dispose();
  }
});

test("editing back to the original words while sending still keeps the later draft", async () => {
  let complete!: () => void;
  const send = vi.spyOn(api.channel, "say").mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const s = setup();
  try {
    s.edit("原来的话");
    const pending = s.box.send();
    await s.box.send();
    expect(send).toHaveBeenCalledTimes(1);
    s.edit("改了一下");
    s.edit("原来的话");
    complete();
    await pending;
    flush();
    expect(s.box.text()).toBe("原来的话");
    expect(s.box.busy()).toBe(false);
  } finally {
    s.dispose();
  }
});

test("a response for the previous destination cannot clear the current destination's draft", async () => {
  let complete!: () => void;
  vi.spyOn(api.channel, "say").mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const s = setup();
  try {
    s.edit("给这里的一句话");
    const pending = s.box.send();
    s.target({ conversation: "somewhere-else" });
    complete();
    await pending;
    flush();
    expect(s.box.text()).toBe("给这里的一句话");
  } finally {
    s.dispose();
  }
});

test("closing a composer releases its target before a pending response arrives", async () => {
  let complete!: () => void;
  vi.spyOn(api.channel, "say").mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  let dispose!: () => void;
  let closed = false;
  const box = createRoot((stop) => {
    dispose = stop;
    return createComposer(
      () => undefined,
      () => undefined,
      {
        target: () => {
          if (closed) throw new Error("disposed target was read");
          return { conversation: "a" };
        },
        failed: () => {
          throw new Error("disposed failure callback was called");
        },
      },
    );
  });
  flush();
  box.edit("还在发送", 4);
  flush();
  const pending = box.send();
  dispose();
  closed = true;
  complete();
  await pending;
});
