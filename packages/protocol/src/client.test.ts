import { describe, expect, it } from "vite-plus/test";

import { VibeValleyApi, VibeValleyApiError } from "./client";

const client = (status: number, text: string) => new VibeValleyApi("http://farm", async () => new Response(text, { status }));
const failure = async (status: number, text: string) => {
  const error = await client(status, text)
    .server.health.get()
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(VibeValleyApiError);
  return error as VibeValleyApiError;
};

describe("the API client error boundary", () => {
  it("keeps the status and original text of a non-JSON failure", async () => {
    const error = await failure(502, " proxy down\n");
    expect([error.status, error.tag, error.reason, error.body, error.error]).toEqual([502, undefined, "proxy down", " proxy down\n", undefined]);
  });

  it("decodes a real ApiError and its next steps", async () => {
    const body = JSON.stringify({
      _tag: "Missing",
      what: "没有这张工单",
      next: [{ say: "看工单", run: ["issue", "list"] }],
    });
    const error = await failure(404, body);
    expect([error.status, error.tag, error.reason, error.body]).toEqual([404, "Missing", "没有这张工单", body]);
    expect(error.error).toEqual({
      _tag: "Missing",
      what: "没有这张工单",
      next: [{ say: "看工单", run: ["issue", "list"] }],
    });
  });

  it("does not trust an error-shaped value with the wrong field types", async () => {
    const body = `{"_tag":"Refused","reason":42}`;
    const error = await failure(409, body);
    expect([error.status, error.tag, error.reason, error.body, error.error]).toEqual([409, "Refused", body, body, undefined]);
  });

  it("keeps success JSON parsing separate from HTTP failure handling", async () => {
    expect(await client(200, `{"ok":true,"version":"test"}`).server.health.get()).toEqual({
      ok: true,
      version: "test",
    });
    await expect(client(200, "not json").server.health.get()).rejects.toThrow(SyntaxError);
  });
});
