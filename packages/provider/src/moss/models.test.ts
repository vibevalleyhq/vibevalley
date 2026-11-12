import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { answering, failure, hanging, json, shown } from "../base/testing.ts";
import { mossModels } from "./models.ts";

const model = (id: string) => ({ id, object: "model", created: 1767225600, owned_by: "MOSS" });
const catalog = (ids: string[]) => json({ object: "list", data: ids.map(model) });
const answer = (body: string, status = 200) => answering(() => new Response(body, { status }));

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

it("MOSS lists account models with explicit authentication and no redirect or capability inference", async () => {
  const sent: { url: string; key: string | null; method: string | undefined; redirect: string | undefined }[] = [];
  const fetcher: typeof fetch = (input, init) => {
    sent.push({
      url: input instanceof Request ? input.url : String(input),
      key: new Headers(init?.headers).get("authorization"),
      method: init?.method,
      redirect: init?.redirect,
    });
    return Promise.resolve(new Response(catalog(["moss-transcribe-1.0", "unknown-future-model"])));
  };
  const mossModels2 = await mossModels("test-key", { fetch: fetcher });
  expect(mossModels2).toEqual([
    { id: "moss-transcribe-1.0", owner: "MOSS" },
    { id: "unknown-future-model", owner: "MOSS" },
  ]);
  expect(sent).toEqual([{ url: "https://api.mosi.cn/v1/models", key: "Bearer test-key", method: "GET", redirect: "manual" }]);
});

it("MOSS rejects empty or malformed credentials before touching the network", async () => {
  let calls = 0;
  const fetcher: typeof fetch = () => {
    calls++;
    throw new Error("Unexpected network request");
  };
  for (const key of ["", " ", "invalid key", "key\nheader"]) {
    const failed = await failure(mossModels(key, { fetch: fetcher }));
    expect(failed).toMatchObject({ reason: "Credentials" });
  }
  expect(calls).toBe(0);
});

it.for([301, 401, 403, 429, 500, 503])("MOSS reports HTTP %i once without exposing its response body", async (status) => {
  let calls = 0;
  const fetcher = answering(() => {
    calls++;
    return new Response("echoed-secret", { status });
  });
  const error = await failure(mossModels("test-key", { fetch: fetcher }));
  expect(error).toMatchObject({ reason: "HttpStatus", status });
  expect(shown(error)).not.toContain("echoed-secret");
  expect(shown(error)).not.toContain("test-key");
  expect(calls).toBe(1);
});

it.for(["not json", "{}", '{"object":"list","data":[{"id":"only-an-id"}]}', catalog([""])])(
  "MOSS rejects malformed catalogs %# without leaking the body",
  async (body) => {
    const mossModelsFailure = await failure(mossModels("test-key", { fetch: answer(body) }));
    expect(mossModelsFailure).toMatchObject({ reason: "InvalidResponse" });
  },
);

it("MOSS accepts an empty account catalog", async () => {
  const mossModels2 = await mossModels("test-key", { fetch: answer(catalog([])) });
  expect(mossModels2).toEqual([]);
});

it.for([" ".repeat((1 << 20) + 1), catalog(Array.from({ length: 1001 }, (_, i) => `model-${i}`))])(
  "MOSS refuses oversized catalogs instead of returning a truncated list %#",
  async (body) => {
    const mossModelsFailure = await failure(mossModels("test-key", { fetch: answer(body) }));
    expect(mossModelsFailure).toMatchObject({ reason: "TooLarge" });
  },
);

it("MOSS query timeout interrupts the transport without retrying", async () => {
  const transport = hanging();
  const result = failure(mossModels("test-key", { fetch: transport.fetch }));
  await transport.started;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await result).toMatchObject({ reason: "Timeout" });
  expect(transport.seen.stopped).toBe(true);
  expect(transport.seen.calls).toBe(1);
});

it("MOSS query timeout also bounds reading the response body", async () => {
  const started = Promise.withResolvers<void>();
  let canceled = false;
  const fetcher: typeof fetch = async () => {
    started.resolve();
    return new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      }),
    );
  };
  const result = failure(mossModels("test-key", { fetch: fetcher }));
  await started.promise;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await result).toMatchObject({ reason: "Timeout" });
  expect(canceled).toBe(true);
});

it("MOSS transport failures do not expose request credentials", async () => {
  const fetcher: typeof fetch = () => Promise.reject(new Error("test-secret-in-network-error"));
  const error = await failure(mossModels("test-key", { fetch: fetcher }));
  expect(error).toMatchObject({ reason: "Network" });
  expect(shown(error)).not.toContain("test-secret-in-network-error");
  expect(shown(error)).not.toContain("test-key");
});

it("canceling MOSS discovery interrupts the in-flight transport", async () => {
  const transport = hanging();
  const stop = new AbortController();
  const result = failure(mossModels("test-key", { fetch: transport.fetch, signal: stop.signal }));
  await transport.started;
  stop.abort();
  await result;
  expect(transport.seen.stopped).toBe(true);
});
