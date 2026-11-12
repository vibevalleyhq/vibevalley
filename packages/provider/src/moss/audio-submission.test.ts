import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { answering, failure, hanging, shown, unreachable } from "../base/testing.ts";
import { submitMossAudioTask } from "./audio-submission.ts";

const endpoints = ["speech/speakers", "voice/generations", "transcriptions"] as const;
const answer = (body: unknown, status = 200) => ({ fetch: answering(() => Response.json(body, { status })) });

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

it.for(endpoints)("%s never retries ambiguous billable submissions or exposes vendor diagnostics", async (endpoint) => {
  let calls = 0;
  const fetch = answering(() => {
    calls++;
    return Response.json({ error: { code: "secret-account", message: "private-key signed-url" } }, { status: 503 });
  });
  const error = await failure(submitMossAudioTask("test-key", endpoint, {}, { fetch }));
  expect(error).toMatchObject({ reason: "HttpStatus", status: 503, outcome: "Unknown" });
  expect(shown(error)).not.toMatch(/secret-account|private-key|signed-url/u);
  expect(calls).toBe(1);
});

it.for([{}, { task_id: "../task" }, { task_id: "task", retry_after: -1 }, { task_id: "task", retry_after: 1.5 }, { task_id: "task", retry_after: "5" }])(
  "invalid submission receipt %# remains unknown, not rejected",
  async (body) => {
    const mossAudioTaskSubmittedFailure = await failure(submitMossAudioTask("test-key", "transcriptions", {}, answer(body)));
    expect(mossAudioTaskSubmittedFailure).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
  },
);

it.for(["", " ", "private\nheader"])("invalid credentials %# do not submit", async (key) => {
  const mossAudioTaskSubmittedFailure = await failure(submitMossAudioTask(key, "voice/generations", {}, { fetch: unreachable }));
  expect(mossAudioTaskSubmittedFailure).toMatchObject({ reason: "Credentials", outcome: "NotSubmitted" });
});

it("oversized submission receipts are bounded independently of task metadata", async () => {
  const mossAudioTaskSubmittedFailure = await failure(
    submitMossAudioTask("test-key", "speech/speakers", {}, answer({ task_id: "task", padding: "x".repeat(1 << 20) })),
  );
  expect(mossAudioTaskSubmittedFailure).toMatchObject({ reason: "TooLarge", outcome: "Unknown" });
});

it.for([301, 302, 303, 307, 308])("regression: bodyless HTTP %i stays unknown and is never followed", async (status) => {
  let calls = 0;
  const fetch = answering((request) => {
    calls++;
    expect(request.redirect).toBe("manual");
    return new Response(null, { status, headers: { location: "https://private.example.com/signed-url" } });
  });
  const error = await failure(submitMossAudioTask("test-key", "transcriptions", {}, { fetch }));
  expect(error).toMatchObject({ reason: "HttpStatus", status, outcome: "Unknown" });
  expect(shown(error)).not.toMatch(/private|signed-url/u);
  expect(calls).toBe(1);
});

it.for([400, 401, 403, 413, 422, 429, 503])("regression: bodyless HTTP %i preserves submission status", async (status) => {
  const mossAudioTaskSubmittedFailure = await failure(
    submitMossAudioTask("test-key", "transcriptions", {}, { fetch: answering(() => new Response(null, { status })) }),
  );
  expect(mossAudioTaskSubmittedFailure).toMatchObject({
    reason: "HttpStatus",
    status,
    outcome: status === 503 ? "Unknown" : "Rejected",
  });
});

it.for([200, 204])("regression: empty HTTP %i is not a valid submission receipt", async (status) => {
  const mossAudioTaskSubmittedFailure = await failure(
    submitMossAudioTask("test-key", "transcriptions", {}, { fetch: answering(() => new Response(null, { status })) }),
  );
  expect(mossAudioTaskSubmittedFailure).toMatchObject({
    reason: "InvalidResponse",
    outcome: "Unknown",
  });
});

it("regression: transport errors are not mistaken for empty receipts", async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = () => {
    calls++;
    return Promise.reject(new TypeError("fetch failed", { cause: new Error("private-key signed-url") }));
  };
  const error = await failure(submitMossAudioTask("test-key", "transcriptions", {}, { fetch }));
  expect(error).toMatchObject({ reason: "Network", outcome: "Unknown" });
  expect(shown(error)).not.toMatch(/private-key|signed-url/u);
  expect(calls).toBe(1);
});

it("regression: interrupted receipt bodies stay network failures with unknown outcomes", async () => {
  const fetch = answering(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("private-body-error"));
          },
        }),
      ),
  );
  const error = await failure(submitMossAudioTask("test-key", "transcriptions", {}, { fetch }));
  expect(error).toMatchObject({ reason: "Network", outcome: "Unknown" });
  expect(shown(error)).not.toContain("private-body-error");
});

it.for(["timeout", "cancel"])("%s interrupts an outstanding submission without retry or remote-cancel claims", async (action) => {
  const transport = hanging();
  const stop = new AbortController();
  const result = failure(submitMossAudioTask("test-key", "voice/generations", {}, { fetch: transport.fetch, signal: stop.signal }));
  await transport.started;
  if (action === "cancel") {
    stop.abort();
    await result;
  } else {
    await vi.advanceTimersByTimeAsync(300_000);
    expect(await result).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
  }
  expect(transport.seen.stopped).toBe(true);
  expect(transport.seen.calls).toBe(1);
});

it("submission deadline includes a response body that never completes", async () => {
  const started = Promise.withResolvers<void>();
  const fetch: typeof globalThis.fetch = async () => {
    started.resolve();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"task_id":"task"'));
        },
      }),
    );
  };
  const result = failure(submitMossAudioTask("test-key", "transcriptions", {}, { fetch }));
  await started.promise;
  await vi.advanceTimersByTimeAsync(300_000);
  expect(await result).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
});
