import { describe, expect, it } from "vite-plus/test";

import { BizCode } from "./api";
import { VibeValleyApi, VibeValleyApiError } from "./client";

const client = (status: number, text: string) => new VibeValleyApi("http://farm", () => Promise.resolve(new Response(text, { status })));
const failure = async (status: number, text: string) => {
  const error = await client(status, text)
    .server.health.get()
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(VibeValleyApiError);
  return error as VibeValleyApiError;
};

describe("the API client envelope and error boundary", () => {
  it("regression: per-request cancellation reaches the transport without canceling another request", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const api = new VibeValleyApi("http://farm", (_url, init) => {
      const signal = init.signal ?? undefined;
      signals.push(signal);
      return signal
        ? new Promise<Response>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          })
        : Promise.resolve(new Response('{"bizCode":0,"message":"ok","data":{"ok":true,"version":"test"}}'));
    });
    const controller = new AbortController();
    const pending = api.server.health.get({ signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(await api.server.health.get()).toEqual({ ok: true, version: "test" });
    expect(signals).toEqual([controller.signal, undefined]);
  });

  it("keeps the status and original text of a non-JSON failure", async () => {
    const error = await failure(502, " proxy down\n");
    expect([error.status, error.bizCode, error.tag, error.reason, error.body, error.error]).toEqual([
      502,
      undefined,
      undefined,
      "proxy down",
      " proxy down\n",
      undefined,
    ]);
  });

  it("decodes a six-digit BizCode error envelope and its remediation detail", async () => {
    const body = JSON.stringify({
      bizCode: BizCode.IssueNotFound,
      message: "没有这张工单",
      error: { next: [{ say: "看工单", run: ["issue", "list"] }] },
    });
    const error = await failure(404, body);
    expect([error.status, error.bizCode, error.tag, error.reason, error.body]).toEqual([404, BizCode.IssueNotFound, "Missing", "没有这张工单", body]);
    expect(error.error).toEqual({
      next: [{ say: "看工单", run: ["issue", "list"] }],
    });
  });

  it("surfaces a business error envelope even if a proxy returns HTTP 200", async () => {
    const body = `{"bizCode":${BizCode.VoiceUnavailable},"message":"语音未配置","error":{"settings":"models"}}`;
    const error = await failure(200, body);
    expect([error.status, error.bizCode, error.tag, error.reason, error.error]).toEqual([
      503,
      BizCode.VoiceUnavailable,
      "VoiceUnavailable",
      "语音未配置",
      { settings: "models" },
    ]);
  });

  it("does not trust an error-shaped value with an unregistered bizCode or wrong field types", async () => {
    const body = `{"bizCode":999999,"message":42}`;
    const error = await failure(409, body);
    expect([error.status, error.bizCode, error.tag, error.reason, error.body, error.error]).toEqual([409, undefined, undefined, body, body, undefined]);
  });

  it("validates both data-carrying and void success envelopes strictly", async () => {
    expect(await client(200, `{"bizCode":0,"message":"ok","data":{"ok":true,"version":"test"}}`).server.health.get()).toEqual({
      ok: true,
      version: "test",
    });
    expect(await client(200, `{"bizCode":0,"message":"ok"}`).orchestrator.open()).toBeUndefined();
    await expect(client(200, "").orchestrator.open()).rejects.toThrow(/not in its shape/u);
    await expect(client(200, "not json").server.health.get()).rejects.toThrow(SyntaxError);
    await expect(client(200, `{"ok":true,"version":"test"}`).server.health.get()).rejects.toThrow(/not in its shape/u);
    await expect(client(200, `{"bizCode":0,"message":"ok","data":{"ok":"yes"}}`).server.health.get()).rejects.toThrow(/not in its shape/u);
  });
});
