import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { answering, failure, hanging, shown, unreachable } from "../base/testing.ts";
import { deleteMossFile, getMossFile, listMossFiles, uploadMossFile } from "./files.ts";
import { understandMossMedia } from "./understanding.ts";

const file = { id: "file-test", object: "file", bytes: 3, created_at: 42, filename: "image.png", purpose: "image", status: "processed" };
const input = { file: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), filename: "image.png", purpose: "image" };
const answer = (value: unknown, status = 200) => ({ fetch: answering(() => Response.json(value, { status })) });
const nowhere = { fetch: unreachable };

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

it("file upload keeps a Blob multipart body and the client owns its boundary", async () => {
  const sent: RequestInit[] = [];
  const fetcher: typeof fetch = (url, init) => {
    expect(url instanceof Request ? url.url : String(url)).toBe("https://api.mosi.cn/v1/files");
    if (init !== undefined) sent.push(init);
    return Promise.resolve(Response.json(file));
  };
  const mossFileUploaded = await uploadMossFile("test-key", input, { fetch: fetcher });
  expect(mossFileUploaded).toEqual(file);
  expect(sent).toHaveLength(1);
  const init = sent[0];
  expect(init?.method).toBe("POST");
  expect(init?.redirect).toBe("manual");
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
  expect(new Headers(init?.headers).has("content-type")).toBe(false);
  const body = init?.body;
  if (!(body instanceof FormData)) throw new Error("Expected a streaming multipart form");
  expect(body.get("purpose")).toBe("image");
  const uploaded = body.get("file");
  if (!(uploaded instanceof Blob)) throw new Error("Expected a Blob");
  expect(uploaded.size).toBe(3);
  expect(uploaded.type).toBe("image/png");
  const encoded = await new Response(body).text();
  expect(encoded).toContain('name="file"; filename="image.png"');
  expect(encoded).toContain('name="purpose"\r\n\r\nimage');
  expect(encoded).toContain(String.fromCharCode(1, 2, 3));
});

it.for([
  { file: "base64" },
  { file: new Blob([]) },
  { purpose: "other" },
  { filename: "" },
  { filename: "../secret" },
  { filename: "a\r\nb" },
  { filename: "a\\b" },
  { filename: "x".repeat(257) },
  { path: "/private/image" },
])("invalid upload never reaches the transport %#", async (invalid) => {
  const mossFileUploadedFailure = await failure(uploadMossFile("test-key", { ...input, ...invalid }, nowhere));
  expect(mossFileUploadedFailure).toMatchObject({ reason: "InvalidInput", outcome: "NotSubmitted" });
});

it.for([
  "",
  ".",
  "..",
  "../secret",
  "a/b",
  "a\\b",
  "a?key=value",
  "a#part",
  "key\n",
  "x".repeat(257),
  String.fromCharCode(0xd800),
  `file${String.fromCharCode(0)}`,
])("file IDs cannot escape the fixed endpoint %#", async (id) => {
  const mossFileFailure = await failure(getMossFile("test-key", id, nowhere));
  expect(mossFileFailure).toMatchObject({ reason: "InvalidInput", outcome: "NotSubmitted" });
  const mossFileDeletedFailure = await failure(deleteMossFile("test-key", id, nowhere));
  expect(mossFileDeletedFailure).toMatchObject({ reason: "InvalidInput", outcome: "NotSubmitted" });
});

it("lookup and deletion require receipts for the requested file", async () => {
  const mossFile = await getMossFile("test-key", "file-test", answer(file));
  expect(mossFile).toEqual(file);
  const mossFileDeleted = await deleteMossFile("test-key", "file-test", answer({ id: "file-test", object: "file", deleted: true }));
  expect(mossFileDeleted).toEqual({ id: "file-test", object: "file", deleted: true });
  const mossFileFailure = await failure(getMossFile("test-key", "file-other", answer(file)));
  expect(mossFileFailure).toMatchObject({
    reason: "InvalidResponse",
    outcome: "Unknown",
  });
  const mossFileDeletedFailure = await failure(deleteMossFile("test-key", "file-other", answer({ id: "file-test", object: "file", deleted: true })));
  expect(mossFileDeletedFailure).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
});

it.for([{ bytes: 4 }, { purpose: "video" }])("upload receipts must match the submitted bytes and purpose %#", async (change) => {
  const mossFileUploadedFailure = await failure(uploadMossFile("test-key", input, answer({ ...file, ...change })));
  expect(mossFileUploadedFailure).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
});

it.for([{ limit: 0 }, { limit: 201 }, { offset: -1 }, { offset: 100001 }, { limit: 1.5 }, { cursor: "arbitrary" }])(
  "invalid pagination does not query %#",
  async (page) => {
    const mossFilesFailure = await failure(listMossFiles("test-key", page, nowhere));
    expect(mossFilesFailure).toMatchObject({ reason: "InvalidInput", outcome: "NotSubmitted" });
  },
);

it("list preserves empty purpose and unfamiliar file status rather than assuming readiness", async () => {
  const listed = await listMossFiles("test-key", { limit: 1, offset: 0 }, answer({ object: "list", data: [{ ...file, purpose: "", status: "new-status" }] }));
  expect(listed).toEqual([{ ...file, purpose: "", status: "new-status" }]);
});

it.for([400, 401, 403, 413, 429, 302, 404, 500])("file HTTP %s is sanitized and not retried", async (status) => {
  let calls = 0;
  const fetch = answering(() => {
    calls++;
    return Response.json({ key: "test-key", url: "private-url" }, { status });
  });
  const error = await failure(uploadMossFile("test-key", input, { fetch }));
  expect(error).toMatchObject({ reason: "HttpStatus", status, outcome: [400, 401, 403, 413, 429].includes(status) ? "Rejected" : "Unknown" });
  expect(shown(error)).not.toMatch(/test-key|private-url/u);
  expect(calls).toBe(1);
});

it("regression: files larger than the vendor upload limit are rejected without reading bytes", async () => {
  class Oversized extends Blob {
    override get size() {
      return 512_000_001;
    }
  }
  const mossFileUploadedFailure = await failure(uploadMossFile("test-key", { ...input, file: new Oversized() }, nowhere));
  expect(mossFileUploadedFailure).toMatchObject({
    reason: "InvalidInput",
    outcome: "NotSubmitted",
  });
});

it.for(["", " ", "key\nheader"])("file credentials are explicit and validated %#", async (key) => {
  const mossFileUploadedFailure = await failure(uploadMossFile(key, input, nowhere));
  expect(mossFileUploadedFailure).toMatchObject({ reason: "Credentials", outcome: "NotSubmitted" });
});

it("file metadata and list responses are bounded", async () => {
  const mossFileFailure = await failure(getMossFile("test-key", "file-test", answer({ ...file, filename: "x".repeat(1 << 20) })));
  expect(mossFileFailure).toMatchObject({ reason: "TooLarge", outcome: "Unknown" });
  const mossFilesFailure = await failure(listMossFiles("test-key", { limit: 1 }, answer({ object: "list", data: [file, file] })));
  expect(mossFilesFailure).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
  const mossFileDeletedFailure = await failure(deleteMossFile("test-key", "file-test", answer({ id: "file-test", object: "file", deleted: false })));
  expect(mossFileDeletedFailure).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
});

it("canceling an upload interrupts only that transport and never resubmits", async () => {
  const transport = hanging();
  const stop = new AbortController();
  const result = failure(uploadMossFile("test-key", input, { fetch: transport.fetch, signal: stop.signal }));
  await transport.started;
  stop.abort();
  await result;
  expect(transport.seen.stopped).toBe(true);
  expect(transport.seen.calls).toBe(1);
});

it("an uploaded file can be referenced for understanding and explicitly deleted with the same account", async () => {
  const calls: string[] = [];
  const http = {
    fetch: answering(async (request) => {
      calls.push(`${request.method} ${request.url}`);
      expect(request.headers.get("authorization")).toBe("Bearer test-key");
      if (request.url.endsWith("/responses")) {
        expect(await request.json()).toEqual({
          model: "moss-vl-1.0",
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "Describe the image" },
                { type: "input_image", file_id: "file-test" },
              ],
            },
          ],
        });
        return Response.json({
          id: "response-id",
          model: "moss-vl-1.0",
          status: "completed",
          output: [{ content: [{ type: "output_text", text: "A farm" }] }],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        });
      }
      return Response.json(request.method === "DELETE" ? { id: file.id, object: "file", deleted: true } : file);
    }),
  };
  const uploaded = await uploadMossFile("test-key", input, http);
  expect((await getMossFile("test-key", uploaded.id, http)).status).toBe("processed");
  const result = await understandMossMedia(
    "test-key",
    {
      model: "moss-vl-1.0",
      text: "Describe the image",
      media: [{ kind: "image", fileId: uploaded.id }],
    },
    http,
  );
  expect(result.text).toBe("A farm");
  expect((await deleteMossFile("test-key", uploaded.id, http)).deleted).toBe(true);
  expect(calls).toEqual([
    "POST https://api.mosi.cn/v1/files",
    "GET https://api.mosi.cn/v1/files/file-test",
    "POST https://api.mosi.cn/v1/responses",
    "DELETE https://api.mosi.cn/v1/files/file-test",
  ]);
});

it("file request deadline includes response reading and cancels the stream", async () => {
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
  const result = failure(uploadMossFile("test-key", input, { fetch: fetcher }));
  await started.promise;
  await vi.advanceTimersByTimeAsync(300_000);
  expect(await result).toMatchObject({ reason: "Timeout", outcome: "Unknown" });
  expect(canceled).toBe(true);
});
