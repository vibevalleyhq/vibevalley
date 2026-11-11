import { describe, expect, it } from "@effect/vitest";
import { Effect, Formatter } from "effect";

import { type MossEvents, type MossTransport, verifyMoss } from "./server.ts";

const fake = (script: (on: MossEvents, sent: string[]) => void, status: MossTransport["status"] = () => Effect.succeed({ code: 400, body: "" })) => {
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
  it.effect("attaches a session, closes it at once, and asks nothing more", () =>
    Effect.gen(function* () {
      const { transport, log } = fake((on, sent) => {
        on.open();
        if (sent[0]?.includes('"action":"attach_session"') === true) on.text(Formatter.formatJson({ action: "session_attached", data: { session_id: "s1" } }));
      });
      const mossVerified = yield* verifyMoss("sk-good", transport);
      expect(mossVerified).toEqual({ kind: "ok" });
      expect([log.closed, log.asked]).toEqual([1, 0]);
    }),
  );

  it.effect("says a refused key is refused, from what plain HTTPS answers", () =>
    Effect.gen(function* () {
      const body = Formatter.formatJson({ error: { type: "permission_error", message: "iam api key auth failed" } });
      const { transport } = fake(
        (on) => on.down(""),
        () => Effect.succeed({ code: 403, body }),
      );
      const mossVerified = yield* verifyMoss("sk-bad", transport);
      expect(mossVerified).toEqual({ kind: "refused", why: "iam api key auth failed" });
    }),
  );

  it.effect("tells unreachable from refused, and passes on MOSS's own error", () =>
    Effect.gen(function* () {
      const offline = fake(
        (on) => on.down(""),
        () => Effect.fail("Error: getaddrinfo ENOTFOUND api.mosi.cn"),
      );
      expect((yield* verifyMoss("sk-x", offline.transport)).kind).toBe("unreachable");
      const erring = fake((on) => {
        on.open();
        on.text(
          Formatter.formatJson({
            action: "error",
            data: { type: "error", error: { code: "invalid_public_request", message: "invalid or unsupported request" } },
          }),
        );
      });
      const mossVerified = yield* verifyMoss("sk-x", erring.transport);
      expect(mossVerified).toEqual({ kind: "failed", why: "invalid or unsupported request" });
    }),
  );
  it.effect("regression: verifies the selected Live snapshot without leaking its credential in errors", () =>
    Effect.gen(function* () {
      const models: (string | undefined)[] = [];
      const transport: MossTransport = {
        connect: (_key, on, model) => {
          models.push(model);
          queueMicrotask(() => {
            on.open();
            on.text(Formatter.formatJson({ action: "error", data: { error: "rejected private-fixture-key" } }));
          });
          return { send: () => {}, close: () => {} };
        },
        status: () => Effect.die("No HTTP fallback after explicit protocol error"),
      };
      const mossVerified = yield* verifyMoss("private-fixture-key", transport, "moss-live-1.0-2026-11-02");
      expect(mossVerified).toEqual({
        kind: "failed",
        why: "rejected [redacted]",
      });
      expect(models).toEqual(["moss-live-1.0-2026-11-02"]);
    }),
  );
});
