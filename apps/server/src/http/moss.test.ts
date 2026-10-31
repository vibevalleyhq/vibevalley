import { request } from "node:http";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { mossLinePath } from "@vibevalley/protocol";

import { testConfig } from "@/testing/layers.ts";
import { whenTrue } from "@/testing/until.ts";
import { quietApp } from "@/testing/world.ts";
import type { MossTransport } from "@/voice/moss.ts";

import { app } from "./app.ts";

/** A MOSS that attaches a session when asked and sends audio back as it came; it keeps the key it was given. */
const echo = () => {
  const keys: string[] = [];
  const transport: MossTransport = {
    connect: (key, on) => {
      keys.push(key);
      queueMicrotask(on.open);
      return {
        send: (frame) => {
          if (typeof frame !== "string") on.binary?.(frame);
          else if (frame.includes("attach_session")) on.text(JSON.stringify({ action: "session_attached", data: { session_id: "s1" } }));
        },
        close: () => {},
      };
    },
    status: () => Effect.succeed({ code: 400, body: "" }),
  };
  return { transport, keys };
};

const farm = (transport: MossTransport) =>
  Effect.gen(function* () {
    let address = "";
    yield* Layer.build(app(testConfig(), 0, (a) => Effect.sync(() => void (address = a)), { ...quietApp, voice: { moss: transport } }));
    return address;
  });

/** An upgrade asked with these headers: its status, and the body when it was refused. */
const upgrade = (address: string, headers: Record<string, string> = {}) =>
  Effect.promise(
    () =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const [host, port] = address.split(":");
        const req = request({
          host,
          port: Number(port),
          path: mossLinePath,
          agent: false,
          headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers },
        });
        req.on("upgrade", (res, socket) => {
          socket.destroy();
          resolve({ status: res.statusCode ?? 0, body: "" });
        });
        req.on("response", (res) => {
          let body = "";
          res.on("data", (c: Buffer) => (body += c.toString("utf8")));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.end();
      }),
  );

describe("a page's line to MOSS Live", () => {
  it.live("is refused to other pages, and says why while no key is saved", () =>
    Effect.gen(function* () {
      const address = yield* farm(echo().transport);
      expect((yield* upgrade(address, { origin: "http://elsewhere.example" })).status).toBe(403);
      expect(yield* upgrade(address)).toEqual({ status: 409, body: "还没填 MOSS Live 的 API Key" });
    }).pipe(Effect.scoped),
  );

  it.live("passes words and audio both ways, with the saved key added", () =>
    Effect.gen(function* () {
      const moss = echo();
      const address = yield* farm(moss.transport);
      yield* Effect.promise(() =>
        // The test calls the server as the page does, through the platform's own fetch.
        // @effect-diagnostics-next-line globalFetchInEffect:off
        fetch(`http://${address}/api/v1/setting/update`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mossKey: "sk-test-key" }),
        }),
      );
      const got: (string | number)[] = [];
      const ws = new WebSocket(`ws://${address}${mossLinePath}`);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        ws.send(JSON.stringify({ action: "attach_session" }));
        ws.send(new Uint8Array([0, 1, 2, 3]));
      };
      ws.onmessage = (e) => got.push(typeof e.data === "string" ? e.data : e.data instanceof ArrayBuffer ? e.data.byteLength : -1);
      yield* Effect.promise(() => whenTrue(() => got.length >= 2, "both frames back"));
      ws.close();
      expect(got).toEqual([JSON.stringify({ action: "session_attached", data: { session_id: "s1" } }), 4]);
      expect(moss.keys).toEqual(["sk-test-key"]);
    }).pipe(Effect.scoped),
  );
});
