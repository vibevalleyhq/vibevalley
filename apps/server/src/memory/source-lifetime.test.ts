import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { afterEach, expect, test, vi } from "vite-plus/test";

import { whenTrue } from "@/testing/until.ts";

import { everos } from "./everos.ts";
import { nowledge } from "./nowledge.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

/** What an operation came to: its message when it failed. */
const ended = <A, E extends Error>(e: Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.match(e, {
      onFailure: (err) => err.message,
      onSuccess: () => "completed",
    }),
  );

test("a late Nowledge connection cannot issue a tool call or reopen after the source stopped", async () => {
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const { promise: started, resolve: entered } = Promise.withResolvers<void>();
  const connect = vi.spyOn(Client.prototype, "connect").mockImplementation(async () => {
    entered();
    await held;
  });
  const call = vi.spyOn(Client.prototype, "callTool");
  const source = nowledge({ kind: "nowledge", url: "http://unused/mcp", enabled: true, read: true });
  const query = { agent: "lab", project: "", text: "query", kind: "" as const, limit: 1 };
  const pending = ended(source.search(query));
  await started;
  await Effect.runPromise(source.stop);
  release();
  expect(await pending).toContain("stopped");
  expect(await ended(source.search(query))).toContain("stopped");
  expect(call).not.toHaveBeenCalled();
  expect(connect).toHaveBeenCalledTimes(1);
});

test("EverOS flushes completed writes but a canceled late response creates no new pending session", async () => {
  const requests: { path: string; session: string }[] = [];
  const { promise: held, resolve: release } = Promise.withResolvers<Response>();
  const { promise: started, resolve: entered } = Promise.withResolvers<void>();
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const href = url instanceof Request ? url.url : url.toString();
    const body = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as { session_id: string };
    requests.push({ path: new URL(href).pathname, session: body.session_id });
    if (body.session_id === "vibevalley-late" && href.endsWith("/add")) {
      entered();
      return held;
    }
    return new Response("{}", { status: 200 });
  };
  const http = Effect.runSync(Effect.service(HttpClient.HttpClient).pipe(Effect.provide(FetchHttpClient.layer)));
  const run = <A, E>(e: Effect.Effect<A, E>) => Effect.provideService(e, FetchHttpClient.Fetch, fetch);
  const source = everos({ kind: "everos", url: "http://unused", enabled: true, write: true }, http);
  const turn = { agent: "lab", session: "done", project: "demo", brief: "brief", outcome: "completed" as const, said: "done", summary: "done" };
  expect(await ended(run(source.syncTurn(turn)))).toBe("completed");
  const pending = ended(run(source.syncTurn({ ...turn, session: "late" })));
  await started;
  await Effect.runPromise(run(source.stop));
  release(new Response("{}", { status: 200 }));
  expect(await pending).toContain("stopped");
  await Effect.runPromise(run(source.stop));
  expect(await ended(run(source.syncTurn({ ...turn, session: "later" })))).toContain("stopped");
  expect(requests).toEqual([
    { path: "/api/v2/memory/add", session: "vibevalley-done" },
    { path: "/api/v2/memory/add", session: "vibevalley-late" },
    { path: "/api/v2/memory/flush", session: "vibevalley-done" },
  ]);
});

test("regression: a late failed Nowledge call does not discard a replacement connection", async () => {
  type Reply = Awaited<ReturnType<Client["callTool"]>>;
  const calls: { client: Client; result: ReturnType<typeof Promise.withResolvers<Reply>> }[] = [];
  const connect = vi.spyOn(Client.prototype, "connect").mockResolvedValue();
  vi.spyOn(Client.prototype, "close").mockResolvedValue();
  vi.spyOn(Client.prototype, "callTool").mockImplementation(function (this: Client) {
    const result = Promise.withResolvers<Reply>();
    calls.push({ client: this, result });
    return result.promise;
  });
  const source = nowledge({ kind: "nowledge", url: "http://unused/mcp", enabled: true, read: true });
  const search = () => ended(source.search({ agent: "lab", project: "", text: "query", kind: "", limit: 1 }));
  const first = search(),
    second = search();
  await whenTrue(() => calls.length === 2, "two original calls");
  calls[0]!.result.reject(new Error("first failure"));
  await first;
  const third = search();
  await whenTrue(() => calls.length === 3, "replacement connection");
  calls[1]!.result.reject(new Error("late failure"));
  await second;
  const fourth = search();
  await whenTrue(() => calls.length === 4, "fourth call");
  expect(calls[3]!.client).toBe(calls[2]!.client);
  expect(connect).toHaveBeenCalledTimes(2);
  for (const call of calls) call.result.resolve({ content: [{ type: "text", text: '{"results":[]}' }] });
  await Promise.all([third, fourth]);
  await Effect.runPromise(source.stop);
});
