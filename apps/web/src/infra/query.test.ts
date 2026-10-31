import { QueryClient } from "@tanstack/solid-query";
import { expect, test, vi } from "vite-plus/test";

import { refetchOnRelink } from "./query";
import { testFrames } from "./testing";

test("the REST reads are read again when the state stream comes back, not while it stays up or goes down", () => {
  const frames = testFrames({ link: "open" });
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
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
});
