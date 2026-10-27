import { request } from "node:http";
import { describe, expect, it } from "@effect/vitest";
import { Subscriptions, rpcPath } from "@vibevalley/protocol/rpc";
import { Context, Effect, Fiber, Layer, Stream } from "effect";
import { Headers } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { Channels } from "../channel/chat.ts";
import { testConfig } from "../testing/layers.ts";
import { quietApp } from "../testing/world.ts";
import { app } from "./app.ts";
import { fromTheFarm } from "./rpc.ts";

/** The whole farm on a free port: its address once it listens, and its chat. */
const farm = Effect.gen(function* () {
  let address = "";
  const built = yield* Layer.build(app(testConfig(), 0, (a) => Effect.sync(() => void (address = a)), quietApp));
  return { address, chat: Context.get(built, Channels) };
});

/** A client on the test's scope: its socket stays open until the test ends. */
const client = (address: string) =>
  Effect.flatMap(
    Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Socket.layerWebSocket(`ws://${address}${rpcPath}`)),
        Layer.provide(Socket.layerWebSocketConstructorGlobal),
        Layer.provide(RpcSerialization.layerJson),
      ),
    ),
    (protocol) => RpcClient.make(Subscriptions).pipe(Effect.provide(protocol)),
  );

/** An upgrade asked with these headers, and the status it got. */
const upgrade = (address: string, headers: Record<string, string>) =>
  Effect.promise(
    () =>
      new Promise<number>((resolve, reject) => {
        const [host, port] = address.split(":");
        // No agent: a pooled socket left by an upgrade holds the next request.
        const req = request({
          host,
          port: Number(port),
          path: rpcPath,
          agent: false,
          headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers },
        });
        req.on("upgrade", (res, socket) => {
          socket.destroy();
          resolve(res.statusCode ?? 0);
        });
        req.on("response", (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      }),
  );

describe("the subscriptions", () => {
  it.live("a page follows a channel over the WebSocket: what it missed, then what is said", () =>
    Effect.gen(function* () {
      const { address, chat } = yield* farm;
      const general = chat.defaultChannel();
      for (const text of ["早", "在吗"]) yield* chat.say(text, undefined, "");
      const rpc = yield* client(address);
      const following = yield* Effect.forkChild(Stream.runCollect(Stream.take(rpc["channel.follow"]({ id: general, after: 1 }), 2)));
      yield* chat.say("看看进度", undefined, "");
      const got = yield* Fiber.join(following);
      expect(got.map((e) => (e._tag === "Message" ? e.message.text : e._tag))).toEqual(["在吗", "看看进度"]);
      expect(yield* Effect.flip(Stream.runDrain(rpc["channel.follow"]({ id: "no-such-channel", after: 0 })))).toMatchObject({ _tag: "Refused" });
    }).pipe(Effect.scoped),
  );

  it.live("only the farm's own page gets in", () =>
    Effect.gen(function* () {
      const { address } = yield* farm;
      const [, port] = address.split(":");
      expect(yield* upgrade(address, {})).toBe(101);
      expect(yield* upgrade(address, { origin: `http://${address}` })).toBe(101);
      expect(yield* upgrade(address, { origin: "https://evil.example" })).toBe(403);
      // A name made to resolve here is its own origin: the host has to be a loopback name.
      expect(yield* upgrade(address, { host: `evil.example:${port}`, origin: `http://evil.example:${port}` })).toBe(403);
    }).pipe(Effect.scoped),
  );

  it("takes the lan listener's word for what it hands on", () => {
    const at = (h: Record<string, string>) => fromTheFarm(Headers.fromInput(h));
    expect(at({ host: "192.168.1.20:8789", origin: "http://192.168.1.20:8789" })).toBe(false);
    expect(at({ host: "127.0.0.1:8787", origin: "http://192.168.1.20:8789", "x-vibevalley-lan-device": "d1" })).toBe(true);
    expect(at({ host: "localhost:5173", origin: "http://localhost:5173" })).toBe(true);
  });
});
