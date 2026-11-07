import { Schema } from "effect";
import { expect, test, vi } from "vite-plus/test";

import * as S from "@vibevalley/protocol/schema";

import { api } from "./api";
import { defineQuery, retryRead, refetchOnRelink } from "./query";
import { createQueryClient } from "./query/cache";
import { testFrames } from "./testing";

test("the REST reads are read again when the state stream comes back, not while it stays up or goes down", () => {
  const frames = testFrames({ link: "open" });
  const client = createQueryClient();
  const invalidate = vi.spyOn(client, "invalidate");
  const stop = refetchOnRelink(frames.source, client);
  frames.set({ count: 1 });
  frames.set({ link: "lost" });
  expect(invalidate).not.toHaveBeenCalled();
  frames.set({ link: "open" });
  expect(invalidate).toHaveBeenCalledOnce();
  stop();
  frames.set({ link: "lost" });
  frames.set({ link: "open" });
  expect(invalidate).toHaveBeenCalledOnce();
  client.dispose();
});

test("regression: a wrapped API connection failure still gets its single classified read retry", async () => {
  vi.useFakeTimers();
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(Response.json([]));
  const query = defineQuery({
    schema: Schema.Array(S.Agent),
    key: () => ["retry-transport"],
    fetch: (_: void, context) => api.agent.list(context),
    ...retryRead,
  });
  const client = createQueryClient();
  try {
    const pending = client.fetch(query());
    await vi.advanceTimersByTimeAsync(300);
    expect(await pending).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    client.dispose();
    fetch.mockRestore();
    vi.useRealTimers();
  }
});
