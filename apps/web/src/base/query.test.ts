import { QueryClient, type QueryObserverResult } from "@tanstack/solid-query";
import type * as solid from "solid-js";
import { createRoot, createSignal, flush } from "solid-js";
import { expect, test, vi } from "vite-plus/test";

import { ready, useQuery } from "./query";

// These tests exercise the real client reactive runtime without a DOM. Node otherwise selects Solid's SSR runtime.
vi.mock("solid-js", () => vi.importActual<typeof solid>("../../node_modules/solid-js/dist/solid.js"));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("enabled and key changes keep the observer's placeholder while the next answer is in flight", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const requests: { key: string; reply: ReturnType<typeof deferred<string>> }[] = [];
  let enable!: (next: boolean) => unknown;
  let choose!: (next: string) => unknown;
  let dispose!: () => void;
  let query!: QueryObserverResult<string>;
  createRoot((stop) => {
    dispose = stop;
    const [enabled, setEnabled] = createSignal(false);
    const [key, setKey] = createSignal("a");
    enable = setEnabled;
    choose = setKey;
    query = useQuery(
      () => ({
        queryKey: ["value", key()],
        enabled: enabled(),
        queryFn: ({ queryKey }) => {
          const reply = deferred<string>();
          requests.push({ key: queryKey[1]!, reply });
          return reply.promise;
        },
        placeholderData: (previous) => previous,
      }),
      () => client,
    );
  });
  flush();
  expect(ready(query, "nothing")).toBe("nothing");
  expect(requests).toHaveLength(0);
  enable(true);
  flush();
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  requests[0]!.reply.resolve("first");
  await vi.waitFor(() => expect(ready(query, "nothing")).toBe("first"));
  choose("b");
  flush();
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  expect(query.isPlaceholderData).toBe(true);
  expect(ready(query, "nothing")).toBe("first");
  expect(requests.map((r) => r.key)).toEqual(["a", "b"]);
  requests[1]!.reply.resolve("second");
  await vi.waitFor(() => expect(ready(query, "nothing")).toBe("second"));
  enable(false);
  choose("c");
  flush();
  expect(requests).toHaveLength(2);
  dispose();
  client.clear();
});

test("refetch stays readable and disposal detaches the observer before an in-flight answer settles", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const replies: ReturnType<typeof deferred<string>>[] = [];
  let dispose!: () => void;
  let query!: QueryObserverResult<string>;
  createRoot((stop) => {
    dispose = stop;
    query = useQuery(
      () => ({
        queryKey: ["value"],
        queryFn: () => {
          const reply = deferred<string>();
          replies.push(reply);
          return reply.promise;
        },
      }),
      () => client,
    );
  });
  flush();
  await vi.waitFor(() => expect(replies).toHaveLength(1));
  replies[0]!.resolve("shown");
  await vi.waitFor(() => expect(ready(query, "nothing")).toBe("shown"));
  const next = query.refetch();
  flush();
  expect(query.isFetching).toBe(true);
  expect(ready(query, "nothing")).toBe("shown");
  dispose();
  replies[1]!.resolve("after closing");
  await next;
  expect(client.getQueryData(["value"])).toBe("after closing");
  client.clear();
});
