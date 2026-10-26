import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { afterEach, expect, test, vi } from "vite-plus/test";
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
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((done) => (release = done));
  const started = new Promise<void>((done) => (entered = done));
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
  let release!: (response: Response) => void;
  let entered!: () => void;
  const held = new Promise<Response>((done) => (release = done));
  const started = new Promise<void>((done) => (entered = done));
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
  const http = Effect.runSync(
    Effect.gen(function* () {
      return yield* HttpClient.HttpClient;
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
  const run = <A, E>(e: Effect.Effect<A, E>) => Effect.provideService(e, FetchHttpClient.Fetch, fetch);
  const source = everos({ kind: "everos", url: "http://unused", enabled: true, write: true }, http);
  const turn = { agent: "lab", session: "done", project: "demo", job: "job", outcome: "completed" as const, said: "done", summary: "done" };
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
