import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { verifyMoss, type MossEvents, type MossTransport } from "./moss.ts";

/** A MOSS that answers the way script says, after the socket opens; status is what plain HTTPS answers. */
const fake = (script: (on: MossEvents, sent: string[]) => void, status: MossTransport["status"] = () => Promise.resolve({ code: 400, body: "" })) => {
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
        if (sent.includes(JSON.stringify({ action: "attach_session" }))) on.text(JSON.stringify({ action: "session_attached", data: { session_id: "s1" } }));
      });
      expect(yield* verifyMoss("sk-good", transport)).toEqual({ kind: "ok" });
      expect([log.closed, log.asked]).toEqual([1, 0]);
    }),
  );

  it.effect("says a refused key is refused, from what plain HTTPS answers", () =>
    Effect.gen(function* () {
      const body = JSON.stringify({ error: { type: "permission_error", message: "iam api key auth failed" } });
      const { transport } = fake(
        (on) => on.down(""),
        () => Promise.resolve({ code: 403, body }),
      );
      expect(yield* verifyMoss("sk-bad", transport)).toEqual({ kind: "refused", why: "iam api key auth failed" });
    }),
  );

  it.effect("tells unreachable from refused, and passes on MOSS's own error", () =>
    Effect.gen(function* () {
      const offline = fake(
        (on) => on.down(""),
        () => Promise.reject(new Error("getaddrinfo ENOTFOUND api.mosi.cn")),
      );
      expect((yield* verifyMoss("sk-x", offline.transport)).kind).toBe("unreachable");
      const erring = fake((on) => {
        on.open();
        on.text(
          JSON.stringify({ action: "error", data: { type: "error", error: { code: "invalid_public_request", message: "invalid or unsupported request" } } }),
        );
      });
      expect(yield* verifyMoss("sk-x", erring.transport)).toEqual({ kind: "failed", why: "invalid or unsupported request" });
    }),
  );
});
