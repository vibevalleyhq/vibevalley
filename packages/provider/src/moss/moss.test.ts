import { describe, expect, it } from "vite-plus/test";

import { json } from "../base/testing.ts";
import { type MossEvents, type MossTransport, verifyMoss } from "./server.ts";

const fake = (script: (on: MossEvents, sent: string[]) => void, status: MossTransport["status"] = async () => ({ code: 400, body: "" })) => {
  const log = { sent: [] as string[], closed: 0, asked: 0 };
  const transport: MossTransport = {
    connect: (_key, on) => {
      queueMicrotask(() => script(on, log.sent));
      return { send: (frame) => log.sent.push(typeof frame === "string" ? frame : "<binary>"), close: () => log.closed++ };
    },
    status: (key) => {
      log.asked++;
      return status(key);
    },
  };
  return { transport, log };
};

describe("checking a MOSS Live key", () => {
  it("attaches a session, closes it at once, and asks nothing more", async () => {
    const { transport, log } = fake((on, sent) => {
      on.open();
      if (sent[0]?.includes('"action":"attach_session"') === true) on.text(json({ action: "session_attached", data: { session_id: "s1" } }));
    });
    const mossVerified = await verifyMoss("sk-good", transport);
    expect(mossVerified).toEqual({ kind: "ok" });
    expect([log.closed, log.asked]).toEqual([1, 0]);
  });

  it("says a refused key is refused, from what plain HTTPS answers", async () => {
    const body = json({ error: { type: "permission_error", message: "iam api key auth failed" } });
    const { transport } = fake(
      (on) => on.down(""),
      async () => ({ code: 403, body }),
    );
    const mossVerified = await verifyMoss("sk-bad", transport);
    expect(mossVerified).toEqual({ kind: "refused", why: "iam api key auth failed" });
  });

  it("tells unreachable from refused, and passes on MOSS's own error", async () => {
    const offline = fake(
      (on) => on.down(""),
      () => Promise.reject(new Error("getaddrinfo ENOTFOUND api.mosi.cn")),
    );
    expect((await verifyMoss("sk-x", offline.transport)).kind).toBe("unreachable");
    const erring = fake((on) => {
      on.open();
      on.text(
        json({
          action: "error",
          data: { type: "error", error: { code: "invalid_public_request", message: "invalid or unsupported request" } },
        }),
      );
    });
    const mossVerified = await verifyMoss("sk-x", erring.transport);
    expect(mossVerified).toEqual({ kind: "failed", why: "invalid or unsupported request" });
  });
  it("regression: verifies the selected Live snapshot without leaking its credential in errors", async () => {
    const models: (string | undefined)[] = [];
    const transport: MossTransport = {
      connect: (_key, on, model) => {
        models.push(model);
        queueMicrotask(() => {
          on.open();
          on.text(json({ action: "error", data: { error: "rejected private-fixture-key" } }));
        });
        return { send: () => {}, close: () => {} };
      },
      status: () => Promise.reject(new Error("No HTTP fallback after explicit protocol error")),
    };
    const mossVerified = await verifyMoss("private-fixture-key", transport, "moss-live-1.0-2026-11-02");
    expect(mossVerified).toEqual({
      kind: "failed",
      why: "rejected [redacted]",
    });
    expect(models).toEqual(["moss-live-1.0-2026-11-02"]);
  });
});
