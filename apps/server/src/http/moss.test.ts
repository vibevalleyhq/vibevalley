import { request } from "node:http";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Formatter, Layer, Schema } from "effect";

import { t } from "@vibevalley/i18n";
import { mossLinePath, visionLinePath } from "@vibevalley/protocol";
import type { MossTransport } from "@vibevalley/provider/moss/server";

import { app } from "#/testing/http.ts";
import { testConfig, whenTrue } from "#/testing/layers.ts";
import { quietApp } from "#/testing/world.ts";

/** A MOSS that attaches a session when asked and sends audio back as it came; it keeps the key it was given. */
const echo = () => {
  const keys: string[] = [];
  const connections: { closed: boolean }[] = [];
  const transport: MossTransport = {
    connect: (key, on) => {
      keys.push(key);
      const connection = { closed: false };
      connections.push(connection);
      queueMicrotask(on.open);
      return {
        send: (frame) => {
          if (connection.closed) return;
          if (typeof frame !== "string") on.binary?.(frame);
          else if (frame.includes("attach_session")) on.text(Formatter.formatJson({ action: "session_attached", data: { session_id: "s1" } }));
        },
        close: () => {
          connection.closed = true;
        },
      };
    },
    status: () => Effect.succeed({ code: 400, body: "" }),
  };
  return { transport, keys, connections };
};

const farm = (transport: MossTransport) =>
  Effect.gen(function* () {
    let address = "";
    yield* Layer.build(app(testConfig(), 0, (a) => Effect.sync(() => void (address = a)), { ...quietApp, voice: { moss: transport } }));
    return address;
  });

/** An upgrade asked with these headers: its status, and the body when it was refused. */
const upgrade = (address: string, headers: Record<string, string> = {}, path = mossLinePath) =>
  Effect.promise(
    () =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const [host, port] = address.split(":");
        const req = request({
          host,
          port: Number(port),
          path,
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
      const upgraded = yield* upgrade(address);
      expect(upgraded).toEqual({ status: 409, body: t("server.provider.capabilityUnbound", { capability: t("server.provider.use.live") }) });
    }).pipe(Effect.scoped),
  );

  it.live("regression: relays the frozen Live account while refusing a second competing Live socket", () =>
    Effect.gen(function* () {
      const moss = echo();
      const address = yield* farm(moss.transport);
      yield* Effect.promise(() =>
        // The test calls the server as the page does, through the platform's own fetch.
        // @effect-diagnostics-next-line globalFetchInEffect:off
        fetch(`http://${address}/api/v1/provider/update`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: Formatter.formatJson({
            revision: 0,
            connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: "sk-test-key" }],
            dictation: null,
            understanding: null,
            speech: null,
            image: null,
            speakers: null,
            voiceDesign: null,
            transcription: null,
            vision: null,
            live: { connection: "moss", model: "moss-live-1.0" },
          }),
        }),
      );
      const got: (string | number)[] = [];
      const ws = new WebSocket(`ws://${address}${mossLinePath}`);
      yield* Effect.addFinalizer(() => Effect.sync(() => ws.close()));
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        ws.send(Formatter.formatJson({ action: "attach_session" }));
        ws.send(new Uint8Array([0, 1, 2, 3]));
      };
      ws.onmessage = (e) => got.push(typeof e.data === "string" ? e.data : e.data instanceof ArrayBuffer ? e.data.byteLength : -1);
      yield* Effect.promise(() => whenTrue(() => got.length >= 2, "both frames back"));
      let competingClose = 0;
      const competing = new WebSocket(`ws://${address}${mossLinePath}`);
      yield* Effect.addFinalizer(() => Effect.sync(() => competing.close()));
      competing.onclose = (event) => {
        competingClose = event.code;
      };
      yield* Effect.promise(() => whenTrue(() => competingClose !== 0, "competing Live line refused"));
      expect(competingClose).toBe(1013);
      ws.close();
      expect(got).toEqual([Formatter.formatJson({ action: "session_attached", data: { session_id: "s1" } }), 4]);
      expect(moss.keys).toEqual(["sk-test-key"]);
    }).pipe(Effect.scoped),
  );

  it.live("regression: a delayed stop for a disconnected call cannot close its replacement relay", () =>
    Effect.gen(function* () {
      const moss = echo();
      const address = yield* farm(moss.transport);
      const post = (path: string, body?: unknown) =>
        Effect.promise(async () => {
          // @effect-diagnostics-next-line globalFetchInEffect:off
          const response = await fetch(`http://${address}/api/v1/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            ...(body === undefined ? {} : { body: Formatter.formatJson(body) }),
          });
          if (response.status === 204) return undefined;
          expect(response.status).toBe(200);
          const value: unknown = await response.json();
          return value;
        });
      yield* post("provider/update", {
        revision: 0,
        connections: [{ id: "moss", name: "MOSS", adapter: "moss", enabled: true, key: "replacement-private" }],
        dictation: null,
        understanding: null,
        speech: null,
        image: null,
        speakers: null,
        voiceDesign: null,
        transcription: null,
        vision: null,
        live: { connection: "moss", model: "moss-live-1.0" },
      });
      yield* post("setting/update", { voice: { answer: { vendor: "moss" } } });
      const grant = Schema.decodeUnknownEffect(Schema.Struct({ channel: Schema.String, uid: Schema.String }));
      const call = Schema.decodeUnknownEffect(Schema.Struct({ agentId: Schema.String }));
      const response2 = yield* post("voice/grant/create");
      const firstGrant = yield* grant(response2);
      const first = new WebSocket(`ws://${address}${mossLinePath}`);
      yield* Effect.addFinalizer(() => Effect.sync(() => first.close()));
      let firstAttached = false;
      let firstClosed = false;
      first.onopen = () => first.send(Formatter.formatJson({ action: "attach_session" }));
      first.onmessage = () => {
        firstAttached = true;
      };
      first.onclose = () => {
        firstClosed = true;
      };
      yield* Effect.promise(() => whenTrue(() => firstAttached, "first relay attached"));
      const response3 = yield* post("voice/call/start", firstGrant);
      const firstCall = yield* call(response3);
      first.close();
      yield* Effect.promise(() => whenTrue(() => firstClosed && moss.connections[0]?.closed === true, "first relay released"));
      const response4 = yield* post("voice/grant/create");
      const nextGrant = yield* grant(response4);
      const next = new WebSocket(`ws://${address}${mossLinePath}`);
      yield* Effect.addFinalizer(() => Effect.sync(() => next.close()));
      next.binaryType = "arraybuffer";
      const received: (string | number)[] = [];
      next.onopen = () => next.send(Formatter.formatJson({ action: "attach_session" }));
      next.onmessage = (event) => received.push(typeof event.data === "string" ? event.data : event.data instanceof ArrayBuffer ? event.data.byteLength : -1);
      yield* Effect.promise(() => whenTrue(() => received.length === 1, "replacement relay attached"));
      const response5 = yield* post("voice/call/start", nextGrant);
      const nextCall = yield* call(response5);
      yield* post("voice/call/stop", firstCall);
      expect(moss.connections[1]?.closed).toBe(false);
      next.send(new Uint8Array([7, 8, 9]));
      yield* Effect.promise(() => whenTrue(() => received.length === 2, "replacement audio returned"));
      expect(received[1]).toBe(3);
      yield* post("voice/call/stop", nextCall);
      expect(moss.connections[1]?.closed).toBe(true);
    }).pipe(Effect.scoped),
  );
});

const control = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.String,
      seq_no: Schema.optionalKey(Schema.Int),
    }),
  ),
);

const visual = () => {
  const connections: { key: string; model: string | undefined; sent: (string | Uint8Array)[]; closed: boolean }[] = [];
  const transport: MossTransport = {
    connect: (key, on, model) => {
      const connection = { key, model, sent: [] as (string | Uint8Array)[], closed: false };
      connections.push(connection);
      const emit = (event: object) => on.text(Formatter.formatJson(event));
      queueMicrotask(() => {
        on.open();
        emit({ type: "session.created", session_id: "visual-fixture", model, configure_timeout_s: 10 });
      });
      let pending = 0;
      return {
        send: (frame) => {
          connection.sent.push(frame);
          if (typeof frame !== "string") {
            emit({ type: "input.frame.accepted", seq_no: pending, timestamp: pending, final: false, pending_events: 1 });
            return;
          }
          const event = control(frame);
          switch (event.type) {
            case "session.configure":
              emit({ type: "session.configured", max_frame_bytes: 262144, input_queue_capacity: 1 });
              emit({ type: "session.ready", turn_id: 0 });
              break;
            case "input.frame":
              pending = event.seq_no ?? 0;
              emit({ type: "input.frame.ready", seq_no: pending });
              break;
            case "input.prompt":
              emit({ type: "input.prompt.accepted", seq_no: event.seq_no, final: false, pending_events: 1 });
              emit({ type: "response.text.delta", response_id: "r1", response_seq: 0, turn_id: 1, delta: "Fixture " });
              emit({ type: "response.text.delta", response_id: "r1", response_seq: 0, turn_id: 1, delta: "camera" });
              emit({ type: "response.done", response_id: "r1", response_seq: 0, turn_id: 1, finish_reason: "stop" });
              break;
            case "session.abort":
              emit({ type: "session.done", reason: "aborted" });
              break;
            default:
              throw new Error("Unexpected visual fixture input");
          }
        },
        close: () => {
          connection.closed = true;
        },
        bufferedAmount: () => 0,
      };
    },
    status: () => Effect.succeed({ code: 400, body: "" }),
  };
  return { transport, connections };
};

const configureVision = (address: string, revision: number, key: string) =>
  Effect.promise(() =>
    // @effect-diagnostics-next-line globalFetchInEffect:off
    fetch(`http://${address}/api/v1/provider/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Formatter.formatJson({
        revision,
        connections: [{ id: "visual", name: "Visual", adapter: "moss", enabled: true, key }],
        dictation: null,
        understanding: null,
        image: null,
        speech: null,
        speakers: null,
        voiceDesign: null,
        transcription: null,
        live: null,
        vision: { connection: "visual", model: "moss-vl-realtime-1.0-2026-09-09" },
      }),
    }),
  );

describe("independent visual realtime relay", () => {
  it.live("requires its own binding and same-origin page, without opening a vendor connection on rejection", () =>
    Effect.gen(function* () {
      const fixture = visual();
      const address = yield* farm(fixture.transport);
      expect((yield* upgrade(address, { origin: "https://untrusted.example" }, visionLinePath)).status).toBe(403);
      expect((yield* upgrade(address, {}, visionLinePath)).status).toBe(409);
      expect(fixture.connections).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.live("freezes visual account and model until explicit reconnect; relays ordered metadata, binary and incremental output", () =>
    Effect.gen(function* () {
      const fixture = visual();
      const address = yield* farm(fixture.transport);
      expect((yield* configureVision(address, 0, "visual-old-private")).status).toBe(200);
      expect((yield* upgrade(address)).status).toBe(409);
      const received: string[] = [];
      const ws = new WebSocket(`ws://${address}${visionLinePath}`);
      yield* Effect.addFinalizer(() => Effect.sync(() => ws.close()));
      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        received.push(event.data);
        const response = control(event.data);
        if (response.type === "session.created") ws.send(Formatter.formatJson({ type: "session.configure", input_queue_capacity: 1 }));
        if (response.type === "session.ready") ws.send(Formatter.formatJson({ type: "input.frame", seq_no: 0, timestamp: 0, mime_type: "image/jpeg" }));
        if (response.type === "input.frame.ready") ws.send(new Uint8Array([255, 216, 255, 217]));
        if (response.type === "input.frame.accepted") ws.send(Formatter.formatJson({ type: "input.prompt", seq_no: 1, prompt: "Describe", final: false }));
      };
      yield* Effect.promise(() => whenTrue(() => received.some((frame) => frame.includes("response.done")), "visual output"));
      expect(fixture.connections.map(({ key, model }) => ({ key, model }))).toEqual([{ key: "visual-old-private", model: "moss-vl-realtime-1.0-2026-09-09" }]);
      expect(received.join("")).not.toContain("private");
      expect((yield* configureVision(address, 1, "visual-new-private")).status).toBe(200);
      expect(fixture.connections).toHaveLength(1);
      ws.send(Formatter.formatJson({ type: "session.abort" }));
      yield* Effect.promise(() => whenTrue(() => received.some((frame) => frame.includes("session.done")), "visual terminal event"));
      ws.close();
      yield* Effect.promise(() => whenTrue(() => fixture.connections[0]?.closed === true, "old connection released"));
      const next = new WebSocket(`ws://${address}${visionLinePath}`);
      yield* Effect.addFinalizer(() => Effect.sync(() => next.close()));
      yield* Effect.promise(() => whenTrue(() => fixture.connections.length === 2, "explicit reconnect"));
      expect(fixture.connections[1]?.key).toBe("visual-new-private");
      expect(fixture.connections[1]?.sent).toEqual([]);
      next.close();
    }).pipe(Effect.scoped),
  );

  it.live("regression: oversized page frames close both sockets rather than accumulating upstream buffers", () =>
    Effect.gen(function* () {
      const fixture = visual();
      const address = yield* farm(fixture.transport);
      expect((yield* configureVision(address, 0, "fixture-private")).status).toBe(200);
      const ws = new WebSocket(`ws://${address}${visionLinePath}`);
      yield* Effect.addFinalizer(() => Effect.sync(() => ws.close()));
      ws.onopen = () => ws.send(new Uint8Array(256 * 1024 + 2));
      yield* Effect.promise(() => whenTrue(() => fixture.connections[0]?.closed === true, "oversized connection released"));
      expect(fixture.connections[0]?.sent).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.live("regression: vendor error and close payloads cannot echo the saved credential to the page", () =>
    Effect.gen(function* () {
      const transport: MossTransport = {
        connect: (key, on) => {
          queueMicrotask(() => {
            on.open();
            on.text(Formatter.formatJson({ type: "error", code: "invalid_request", message: `Rejected ${key}` }));
            on.down(`Rejected ${key}`);
          });
          return { send: () => {}, close: () => {} };
        },
        status: () => Effect.succeed({ code: 400, body: "" }),
      };
      const address = yield* farm(transport);
      expect((yield* configureVision(address, 0, "never-expose-this-key")).status).toBe(200);
      const ws = new WebSocket(`ws://${address}${visionLinePath}`);
      yield* Effect.addFinalizer(() => Effect.sync(() => ws.close()));
      const received: string[] = [];
      let closed = false;
      ws.onmessage = (event) => received.push(String(event.data));
      ws.onclose = (event) => {
        received.push(event.reason);
        closed = true;
      };
      yield* Effect.promise(() => whenTrue(() => closed, "vendor failure closes relay"));
      expect(received.join("")).toContain("[redacted]");
      expect(received.join("")).not.toContain("never-expose-this-key");
    }).pipe(Effect.scoped),
  );
});
