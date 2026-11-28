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
  it("regression: the approval list preserves the JSON argument text returned by the server", async () => {
    const argumentsJson = '{ "title": "Review", "priority": 1.0, "labels": ["ui"] }';
    const approval = { id: "c1", taskId: "t1", toolCallId: "call1", toolName: "issue_create", reason: "requires review", requestedAtMs: 10 };
    const list = (args: unknown) =>
      client(200, JSON.stringify({ bizCode: 0, message: "ok", data: [{ ...approval, argumentsJson: args }] })).session.approval.list({});
    expect(await list(argumentsJson)).toEqual([{ ...approval, argumentsJson }]);
    await expect(list({ title: "Review" })).rejects.toThrow(/argumentsJson/u);
  });

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
    expect(await client(200, `{"bizCode":0,"message":"ok"}`).session.stop({ id: "s1" })).toBeUndefined();
    await expect(client(200, "").session.stop({ id: "s1" })).rejects.toThrow(/not in its shape/u);
    await expect(client(200, "not json").server.health.get()).rejects.toThrow(SyntaxError);
    await expect(client(200, `{"ok":true,"version":"test"}`).server.health.get()).rejects.toThrow(/not in its shape/u);
    await expect(client(200, `{"bizCode":0,"message":"ok","data":{"ok":"yes"}}`).server.health.get()).rejects.toThrow(/not in its shape/u);
  });

  it("calls direct envelope transports via VibeValleyApi.over without HTTP serialization", async () => {
    const calls: [string, unknown][] = [];
    const api = VibeValleyApi.over((op, input) => {
      calls.push([op, input]);
      if (op === "server.health.get") {
        return Promise.resolve({ bizCode: 0, message: "ok", data: { ok: true, version: "native" } });
      }
      return Promise.resolve({ bizCode: BizCode.IssueNotFound, message: "missing" });
    });
    expect(await api.server.health.get()).toEqual({ ok: true, version: "native" });
    await expect(api.session.stop({ id: "s1" })).rejects.toMatchObject({
      status: 404,
      bizCode: BizCode.IssueNotFound,
      tag: "Missing",
      reason: "missing",
    });
    expect(calls).toEqual([
      ["server.health.get", undefined],
      ["session.stop", { id: "s1" }],
    ]);
  });

  it("trusts in-process bridge bizCode 0 envelopes without re-running Zod payload validation", async () => {
    const payload = { ok: true, version: "native" };
    const api = VibeValleyApi.over((op) => {
      if (op === "server.health.get") return Promise.resolve({ bizCode: 0, message: "ok", data: payload });
      if (op === "session.stop") return Promise.resolve({ bizCode: 0, message: "ok" });
      return Promise.resolve({ bizCode: 999999, message: "unexpected" });
    });
    // Preserves exact object identity without cloning via Zod safeParse.
    expect(await api.server.health.get()).toBe(payload);
    expect(await api.session.stop({ id: "s1" })).toBeUndefined();
    await expect(api.repo.list()).rejects.toMatchObject({ status: 500, reason: "unexpected" });
  });

  it("round-trips note.collab.export and note.collab.import with Zod decoding", async () => {
    const requests: [string, unknown][] = [];
    const api = new VibeValleyApi("http://farm", (url, init) => {
      const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push([url, body]);
      if (url.endsWith("/api/v1/note/collab/export")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              bizCode: 0,
              message: "ok",
              data: {
                noteId: "note_1",
                seq: 2,
                versionVector: "dnYx",
                frontiers: "ZjE=",
                snapshot: false,
                update: "dXBkYXRl",
              },
            }),
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            bizCode: 0,
            message: "ok",
            data: {
              noteId: "note_1",
              seq: 3,
              versionVector: "dnYy",
              frontiers: "ZjI=",
              files: [{ path: "structure/doc.json", mime: "application/json", size: 12, hash: "h1", updatedAt: 1000 }],
              deleted: [],
              serverUpdate: "c2VydmVy",
              serverSnapshot: false,
            },
          }),
        ),
      );
    });

    const exported = await api.note.collab.export({ id: "note_1" as never, versionVector: "dnYw" });
    expect(exported.seq).toBe(2);
    expect(exported.snapshot).toBe(false);
    expect(exported.update).toBe("dXBkYXRl");

    const imported = await api.note.collab.import({
      id: "note_1" as never,
      update: "Y2xpZW50",
      clientVersionVector: "dnYw",
      origin: "user",
    });
    expect(imported.seq).toBe(3);
    expect(imported.serverUpdate).toBe("c2VydmVy");
    expect(imported.serverSnapshot).toBe(false);
    expect(requests).toEqual([
      ["http://farm/api/v1/note/collab/export", { id: "note_1", versionVector: "dnYw" }],
      ["http://farm/api/v1/note/collab/import", { id: "note_1", update: "Y2xpZW50", clientVersionVector: "dnYw", origin: "user" }],
    ]);
  });
});
