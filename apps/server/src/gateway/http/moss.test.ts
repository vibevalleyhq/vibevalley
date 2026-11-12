import { request } from "node:http";

import { describe, expect, onTestFinished, test } from "vite-plus/test";
import { z } from "zod";

import { t } from "@vibevalley/i18n";
import { mossLinePath, visionLinePath } from "@vibevalley/protocol";
import { jsonString } from "@vibevalley/protocol/schema";
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
          else if (frame.includes("attach_session")) on.text(JSON.stringify({ action: "session_attached", data: { session_id: "s1" } }));
        },
        close: () => {
          connection.closed = true;
        },
      };
    },
    status: async () => ({ code: 400, body: "" }),
  };
  return { transport, keys, connections };
};

const farm = (transport: MossTransport) => app(testConfig(), 0, undefined, { ...quietApp, voice: { moss: transport } });

/** An upgrade asked with these headers: its status, and the body when it was refused. */
const upgrade = (address: string, headers: Record<string, string> = {}, path = mossLinePath) =>
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
  });

describe("a page's line to MOSS Live", () => {
  test("is refused to other pages, and says why while no key is saved", async () => {
    await using served = await farm(echo().transport);
    const address = served.address;
    expect((await upgrade(address, { origin: "http://elsewhere.example" })).status).toBe(403);
    const upgraded = await upgrade(address);
    expect(upgraded).toEqual({ status: 409, body: t("server.provider.capabilityUnbound", { capability: t("server.provider.use.live") }) });
  });

  test("regression: relays the frozen Live account while refusing a second competing Live socket", async () => {
    const moss = echo();
    await using served = await farm(moss.transport);
    const address = served.address;
    await // The test calls the server as the page does, through the platform's own fetch.
    fetch(`http://${address}/api/v1/provider/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
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
    });
    const got: (string | number)[] = [];
    const ws = new WebSocket(`ws://${address}${mossLinePath}`);
    onTestFinished(() => ws.close());
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      ws.send(JSON.stringify({ action: "attach_session" }));
      ws.send(new Uint8Array([0, 1, 2, 3]));
    };
    ws.onmessage = (e) => got.push(typeof e.data === "string" ? e.data : e.data instanceof ArrayBuffer ? e.data.byteLength : -1);
    await whenTrue(() => got.length >= 2, "both frames back");
    let competingClose = 0;
    const competing = new WebSocket(`ws://${address}${mossLinePath}`);
    onTestFinished(() => competing.close());
    competing.onclose = (event) => {
      competingClose = event.code;
    };
    await whenTrue(() => competingClose !== 0, "competing Live line refused");
    expect(competingClose).toBe(1013);
    ws.close();
    expect(got).toEqual([JSON.stringify({ action: "session_attached", data: { session_id: "s1" } }), 4]);
    expect(moss.keys).toEqual(["sk-test-key"]);
  });

  test("regression: a delayed stop for a disconnected call cannot close its replacement relay", async () => {
    const moss = echo();
    await using served = await farm(moss.transport);
    const address = served.address;
    const post = async (path: string, body?: unknown) => {
      const response = await fetch(`http://${address}/api/v1/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.status).toBe(200);
      const env = (await response.json()) as { bizCode: number; data?: unknown };
      expect(env.bizCode).toBe(0);
      return env.data;
    };
    await post("provider/update", {
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
    await post("setting/update", { voice: { answer: { vendor: "moss" } } });
    const grant = (v: unknown) => z.object({ channel: z.string(), uid: z.string() }).parse(v);
    const call = (v: unknown) => z.object({ agentId: z.string() }).parse(v);
    const response2 = await post("voice/grant/create");
    const firstGrant = grant(response2);
    const first = new WebSocket(`ws://${address}${mossLinePath}`);
    onTestFinished(() => first.close());
    let firstAttached = false;
    let firstClosed = false;
    first.onopen = () => first.send(JSON.stringify({ action: "attach_session" }));
    first.onmessage = () => {
      firstAttached = true;
    };
    first.onclose = () => {
      firstClosed = true;
    };
    await whenTrue(() => firstAttached, "first relay attached");
    const response3 = await post("voice/call/start", firstGrant);
    const firstCall = call(response3);
    first.close();
    await whenTrue(() => firstClosed && moss.connections[0]?.closed === true, "first relay released");
    const response4 = await post("voice/grant/create");
    const nextGrant = grant(response4);
    const next = new WebSocket(`ws://${address}${mossLinePath}`);
    onTestFinished(() => next.close());
    next.binaryType = "arraybuffer";
    const received: (string | number)[] = [];
    next.onopen = () => next.send(JSON.stringify({ action: "attach_session" }));
    next.onmessage = (event) => received.push(typeof event.data === "string" ? event.data : event.data instanceof ArrayBuffer ? event.data.byteLength : -1);
    await whenTrue(() => received.length === 1, "replacement relay attached");
    const response5 = await post("voice/call/start", nextGrant);
    const nextCall = call(response5);
    await post("voice/call/stop", firstCall);
    expect(moss.connections[1]?.closed).toBe(false);
    next.send(new Uint8Array([7, 8, 9]));
    await whenTrue(() => received.length === 2, "replacement audio returned");
    expect(received[1]).toBe(3);
    await post("voice/call/stop", nextCall);
    expect(moss.connections[1]?.closed).toBe(true);
  });
});

const control = (frame: string) =>
  jsonString(
    z.object({
      type: z.string(),
      seq_no: z.exactOptional(z.number().int()),
    }),
  ).parse(frame);

const visual = () => {
  const connections: { key: string; model: string | undefined; sent: (string | Uint8Array)[]; closed: boolean }[] = [];
  const transport: MossTransport = {
    connect: (key, on, model) => {
      const connection = { key, model, sent: [] as (string | Uint8Array)[], closed: false };
      connections.push(connection);
      const emit = (event: object) => on.text(JSON.stringify(event));
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
    status: async () => ({ code: 400, body: "" }),
  };
  return { transport, connections };
};

const configureVision = (address: string, revision: number, key: string) =>
  fetch(`http://${address}/api/v1/provider/update`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
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
  });

describe("independent visual realtime relay", () => {
  test("requires its own binding and same-origin page, without opening a vendor connection on rejection", async () => {
    const fixture = visual();
    await using served = await farm(fixture.transport);
    const address = served.address;
    expect((await upgrade(address, { origin: "https://untrusted.example" }, visionLinePath)).status).toBe(403);
    expect((await upgrade(address, {}, visionLinePath)).status).toBe(409);
    expect(fixture.connections).toHaveLength(0);
  });

  test("freezes visual account and model until explicit reconnect; relays ordered metadata, binary and incremental output", async () => {
    const fixture = visual();
    await using served = await farm(fixture.transport);
    const address = served.address;
    expect((await configureVision(address, 0, "visual-old-private")).status).toBe(200);
    expect((await upgrade(address)).status).toBe(409);
    const received: string[] = [];
    const ws = new WebSocket(`ws://${address}${visionLinePath}`);
    onTestFinished(() => ws.close());
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      received.push(event.data);
      const response = control(event.data);
      if (response.type === "session.created") ws.send(JSON.stringify({ type: "session.configure", input_queue_capacity: 1 }));
      if (response.type === "session.ready") ws.send(JSON.stringify({ type: "input.frame", seq_no: 0, timestamp: 0, mime_type: "image/jpeg" }));
      if (response.type === "input.frame.ready") ws.send(new Uint8Array([255, 216, 255, 217]));
      if (response.type === "input.frame.accepted") ws.send(JSON.stringify({ type: "input.prompt", seq_no: 1, prompt: "Describe", final: false }));
    };
    await whenTrue(() => received.some((frame) => frame.includes("response.done")), "visual output");
    expect(fixture.connections.map(({ key, model }) => ({ key, model }))).toEqual([{ key: "visual-old-private", model: "moss-vl-realtime-1.0-2026-09-09" }]);
    expect(received.join("")).not.toContain("private");
    expect((await configureVision(address, 1, "visual-new-private")).status).toBe(200);
    expect(fixture.connections).toHaveLength(1);
    ws.send(JSON.stringify({ type: "session.abort" }));
    await whenTrue(() => received.some((frame) => frame.includes("session.done")), "visual terminal event");
    ws.close();
    await whenTrue(() => fixture.connections[0]?.closed === true, "old connection released");
    const next = new WebSocket(`ws://${address}${visionLinePath}`);
    onTestFinished(() => next.close());
    await whenTrue(() => fixture.connections.length === 2, "explicit reconnect");
    expect(fixture.connections[1]?.key).toBe("visual-new-private");
    expect(fixture.connections[1]?.sent).toEqual([]);
    next.close();
  });

  test("regression: oversized page frames close both sockets rather than accumulating upstream buffers", async () => {
    const fixture = visual();
    await using served = await farm(fixture.transport);
    const address = served.address;
    expect((await configureVision(address, 0, "fixture-private")).status).toBe(200);
    const ws = new WebSocket(`ws://${address}${visionLinePath}`);
    onTestFinished(() => ws.close());
    ws.onopen = () => ws.send(new Uint8Array(256 * 1024 + 2));
    await whenTrue(() => fixture.connections[0]?.closed === true, "oversized connection released");
    expect(fixture.connections[0]?.sent).toHaveLength(0);
  });

  test("regression: vendor error and close payloads cannot echo the saved credential to the page", async () => {
    const transport: MossTransport = {
      connect: (key, on) => {
        queueMicrotask(() => {
          on.open();
          on.text(JSON.stringify({ type: "error", code: "invalid_request", message: `Rejected ${key}` }));
          on.down(`Rejected ${key}`);
        });
        return { send: () => {}, close: () => {} };
      },
      status: async () => ({ code: 400, body: "" }),
    };
    await using served = await farm(transport);
    const address = served.address;
    expect((await configureVision(address, 0, "never-expose-this-key")).status).toBe(200);
    const ws = new WebSocket(`ws://${address}${visionLinePath}`);
    onTestFinished(() => ws.close());
    const received: string[] = [];
    let closed = false;
    ws.onmessage = (event) => received.push(String(event.data));
    ws.onclose = (event) => {
      received.push(event.reason);
      closed = true;
    };
    await whenTrue(() => closed, "vendor failure closes relay");
    expect(received.join("")).toContain("[redacted]");
    expect(received.join("")).not.toContain("never-expose-this-key");
  });
});
