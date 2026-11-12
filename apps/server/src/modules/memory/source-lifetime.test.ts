import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { z } from "zod";

import { systemClock } from "@vibevalley/async";
import { whenTrue } from "@vibevalley/testkit/until";

import { keptLog } from "#/infra/log.ts";

import { everos } from "./everos.ts";
import { nowledge } from "./nowledge.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

/** What an operation came to: its message when it failed. */
const ended = (p: Promise<unknown>) =>
  p.then(
    () => "completed",
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );

const signal = new AbortController().signal;
const deps = { clock: systemClock, log: keptLog() };

test("a late Nowledge connection cannot issue a tool call or reopen after the source stopped", async () => {
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const { promise: started, resolve: entered } = Promise.withResolvers<void>();
  const connect = vi.spyOn(Client.prototype, "connect").mockImplementation(async () => {
    entered();
    await held;
  });
  const call = vi.spyOn(Client.prototype, "callTool");
  const source = nowledge({ kind: "nowledge", url: "http://unused/mcp", enabled: true, read: true }, deps);
  const query = { agent: "lab", repo: "", text: "query", kind: "" as const, limit: 1 };
  const pending = ended(source.search(query, signal));
  await started;
  await source.stop();
  release();
  expect(await pending).toContain("stopped");
  expect(await ended(source.search(query, signal))).toContain("stopped");
  expect(call).not.toHaveBeenCalled();
  expect(connect).toHaveBeenCalledTimes(1);
});

const Session = z.object({ session_id: z.string() });

test("EverOS flushes completed writes but a canceled late response creates no new pending session", async () => {
  const requests: { path: string; session: string }[] = [];
  const { promise: held, resolve: release } = Promise.withResolvers<Response>();
  const { promise: started, resolve: entered } = Promise.withResolvers<void>();
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const href = url instanceof Request ? url.url : url.toString();
    const body = Session.parse(JSON.parse(typeof init?.body === "string" ? init.body : ""));
    requests.push({ path: new URL(href).pathname, session: body.session_id });
    if (body.session_id === "vibevalley-late" && href.endsWith("/add")) {
      entered();
      return held;
    }
    return new Response("{}", { status: 200 });
  };
  const source = everos({ kind: "everos", url: "http://unused", enabled: true, write: true }, { ...deps, fetch });
  const turn = { agent: "lab", session: "done", repo: "demo", brief: "brief", outcome: "completed" as const, said: "done", summary: "done" };
  expect(await ended(source.syncTurn(turn, signal))).toBe("completed");
  const pending = ended(source.syncTurn({ ...turn, session: "late" }, signal));
  await started;
  await source.stop();
  release(new Response("{}", { status: 200 }));
  expect(await pending).toContain("stopped");
  await source.stop();
  expect(await ended(source.syncTurn({ ...turn, session: "later" }, signal))).toContain("stopped");
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
  const source = nowledge({ kind: "nowledge", url: "http://unused/mcp", enabled: true, read: true }, deps);
  const search = () => ended(source.search({ agent: "lab", repo: "", text: "query", kind: "", limit: 1 }, signal));
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
  await source.stop();
});
