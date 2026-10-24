import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { type Message, QQClient } from "./qq.ts";

type FakeEvent = { data?: unknown; code?: number };
type FakeListener = (event: FakeEvent) => void;

const sockets: FakeWebSocket[] = [];

class FakeWebSocket {
  readonly sent: unknown[] = [];
  closed = false;
  private readonly listeners = new Map<string, FakeListener[]>();

  constructor(readonly url: string) {
    sockets.push(this);
  }

  addEventListener(kind: string, listener: FakeListener) {
    this.listeners.set(kind, [...(this.listeners.get(kind) ?? []), listener]);
  }

  send(payload: string) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.closed = true;
  }

  message(payload: unknown) {
    for (const listener of this.listeners.get("message") ?? []) listener({ data: typeof payload === "string" ? payload : JSON.stringify(payload) });
  }
}

type Outcome = { status: "resolved" } | { status: "rejected"; error: unknown };

const active: { controller: AbortController; outcome: Promise<Outcome> }[] = [];

afterEach(async () => {
  for (const { controller } of active) controller.abort();
  await Promise.all(active.map(({ outcome }) => outcome));
  active.length = 0;
  sockets.length = 0;
  vi.unstubAllGlobals();
});

async function open() {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://bots.qq.com/app/getAppAccessToken") return Response.json({ access_token: "token", expires_in: 7200 });
    if (url === "https://api.sgroup.qq.com/gateway") return Response.json({ url: "ws://qq.test" });
    throw new Error("unexpected fetch " + url);
  });
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const controller = new AbortController();
  const received: Message[] = [];
  const listening = new QQClient().listen(controller.signal, { appId: "app", secret: "secret" }, async (message) => {
    received.push(message);
  });
  const outcome = listening.then(
    () => ({ status: "resolved" as const }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  active.push({ controller, outcome });
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  return { socket: sockets[0]!, received, outcome };
}

const within = async (outcome: Promise<Outcome>) => Promise.race([outcome, new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 100))]);

const incoming = {
  op: 0,
  t: "C2C_MESSAGE_CREATE",
  s: 2,
  d: { id: "m1", content: "你好", author: { user_openid: "owner" }, attachments: [{ url: "one" }, { url: "two" }] },
};

describe("QQ gateway frames", () => {
  it("keeps accepting the current hello and message fields", async () => {
    const { socket, received, outcome } = await open();
    socket.message({ op: 10, s: 1, d: { heartbeat_interval: 60_000 } });
    socket.message(incoming);
    await vi.waitFor(() => expect(received).toEqual([{ id: "m1", from: "owner", content: "你好", attachments: 2 }]));
    expect(socket.sent[0]).toMatchObject({ op: 2, d: { token: "QQBot token", intents: 1 << 25 } });
    active[0]!.controller.abort();
    await expect(outcome).resolves.toMatchObject({ status: "resolved" });
  });

  it.each([
    ["null", null],
    ["an array", []],
  ])("rejects %s instead of leaving the connection pending", async (_name, frame) => {
    const { socket, outcome } = await open();
    socket.message(frame);
    const result = await within(outcome);
    expect(result).toMatchObject({ status: "rejected" });
    if (result !== "pending" && result.status === "rejected") expect(String(result.error)).toContain("QQ 网关：连接出错");
  });

  it("rejects a malformed heartbeat payload", async () => {
    const { socket, outcome } = await open();
    socket.message({ op: 10, d: { heartbeat_interval: "soon" } });
    await expect(within(outcome)).resolves.toMatchObject({ status: "rejected", error: new Error("QQ 网关：连接出错") });
  });

  it.each(["1e400", "2147483648"])("rejects a heartbeat interval that Node cannot schedule: %s", async (frame) => {
    const { socket, outcome } = await open();
    socket.message(`{"op":10,"d":{"heartbeat_interval":${frame}}}`);
    await expect(within(outcome)).resolves.toMatchObject({ status: "rejected", error: new Error("QQ 网关：连接出错") });
  });

  it("closes on a bad frame and does not deliver a later good frame", async () => {
    const { socket, received, outcome } = await open();
    socket.message([]);
    socket.message(incoming);
    await expect(within(outcome)).resolves.toMatchObject({ status: "rejected" });
    await Promise.resolve();
    expect(received).toEqual([]);
    expect(socket.closed).toBe(true);
  });
});
