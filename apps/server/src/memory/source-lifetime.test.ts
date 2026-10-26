import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { everos } from "./everos.ts";
import { nowledge } from "./nowledge.ts";
import { wallTime } from "../base/time.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
  const source = nowledge({ kind: "nowledge", url: "http://unused/mcp", enabled: true, read: true }, wallTime.now);
  const query = { agent: "lab", project: "", text: "query", kind: "" as const, limit: 1 };
  const pending = source.search(query, new AbortController().signal).then(
    () => "completed",
    () => "canceled",
  );
  await started;
  await source.stop();
  release();
  expect(await pending).toBe("canceled");
  await expect(source.search(query, new AbortController().signal)).rejects.toThrow("stopped");
  expect(call).not.toHaveBeenCalled();
  expect(connect).toHaveBeenCalledTimes(1);
});

test("EverOS flushes completed writes but a canceled late response creates no new pending session", async () => {
  const requests: { path: string; session: string }[] = [];
  let release!: (response: Response) => void;
  let entered!: () => void;
  const held = new Promise<Response>((done) => (release = done));
  const started = new Promise<void>((done) => (entered = done));
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { session_id: string };
    requests.push({ path: new URL(url).pathname, session: body.session_id });
    if (body.session_id === "vibevalley-late" && url.endsWith("/add")) {
      entered();
      return held;
    }
    return new Response("{}", { status: 200 });
  });
  const source = everos({ kind: "everos", url: "http://unused", enabled: true, write: true }, wallTime.now);
  const run = { agent: "lab", session: "done", project: "demo", job: "job", outcome: "completed" as const, said: "done", summary: "done" };
  await source.syncTurn(run, new AbortController().signal);
  const pending = source.syncTurn({ ...run, session: "late" }, new AbortController().signal).then(
    () => "completed",
    () => "canceled",
  );
  await started;
  await source.stop();
  release(new Response("{}", { status: 200 }));
  expect(await pending).toBe("canceled");
  await source.stop();
  await expect(source.syncTurn({ ...run, session: "later" }, new AbortController().signal)).rejects.toThrow("stopped");
  expect(requests).toEqual([
    { path: "/api/v2/memory/add", session: "vibevalley-done" },
    { path: "/api/v2/memory/add", session: "vibevalley-late" },
    { path: "/api/v2/memory/flush", session: "vibevalley-done" },
  ]);
});
