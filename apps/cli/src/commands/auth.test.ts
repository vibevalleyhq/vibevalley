import { NodeHttpServer } from "@effect/platform-node";
import { expect, layer } from "@effect/vitest";
import { Array as Arr, Effect, Option, Schema, String as Str } from "effect";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

import { signedIn } from "@vibevalley/home";
import { pathOf } from "@vibevalley/protocol/api";
import { tempDir } from "@vibevalley/testkit/temp";

import { cli } from "#/testing/testing.ts";

const device = { id: "d1", name: "buildbox", came: "login", addedAt: 1 };

/** A server behind its gate, as auth login meets it: the code, two collects (waiting, then the key), and user.get that
 * knows the device only by its key. */
const gateLike = (here: boolean) =>
  Effect.gen(function* () {
    let collects = 0;
    const keys: string[] = [];
    yield* HttpServer.serveEffect()(
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;
        const key = req.headers.authorization ?? "";
        keys.push(`${req.url} ${key}`);
        switch (req.url) {
          case pathOf("user.get"):
            return yield* HttpServerResponse.json({
              bizCode: 0,
              message: "ok",
              data: {
                name: key === "Bearer k1" ? "小明" : "",
                password: true,
                here,
                ...(key === "Bearer k1" ? { device } : {}),
              },
            });
          case pathOf("user.approval.create"):
            return yield* HttpServerResponse.json({ bizCode: 0, message: "ok", data: { code: "BCDF-GHJK", claim: "t1", expiresAt: 1, every: 0.01 } });
          case pathOf("user.approval.collect"):
            collects++;
            // Waiting, then told to slow down (to a wait a test can afford), then the key.
            return yield* HttpServerResponse.json({
              bizCode: 0,
              message: "ok",
              data: collects === 1 ? {} : collects === 2 ? { every: 0.02 } : { login: { device: "d1", key: "k1" } },
            });
          case pathOf("user.logout"):
            return yield* HttpServerResponse.json({ bizCode: 0, message: "ok" });
          default:
            return HttpServerResponse.empty({ status: 404 });
        }
      }),
    );
    const { address } = yield* HttpServer.HttpServer;
    if (address._tag === "UnixPathAddress") return yield* Effect.die(new Error("No server address"));
    return { server: `http://127.0.0.1:${address.port}`, keys };
  });

const json = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const said = (path: string) => (k: string) => Str.startsWith(path)(k);

// Real time: auth login waits between its tries.
layer(NodeHttpServer.layerTest, { excludeTestServices: true, buildPerTest: true })("auth", (it) => {
  it.effect("auth login shows the code, waits for approval, keeps the key, sends it, and auth logout gives it back", () =>
    Effect.gen(function* () {
      const { server, keys } = yield* gateLike(false);
      const env = { VIBEVALLEY_HOME: tempDir("vv-auth-") };
      const login = yield* cli(["auth", "login", server + "/"], "", env);
      expect([login.code, login.out]).toEqual([0, expect.stringContaining("buildbox")]);
      expect(login.err).toContain(`${server}/approve?code=BCDF-GHJK`);
      expect(signedIn(env.VIBEVALLEY_HOME)).toEqual({ server, key: "k1", device: "d1" });
      const status = yield* cli(["auth", "status", "--format", "json"], "", env);
      const told = yield* json(status.out);
      expect(told).toMatchObject({ signedIn: true, server, name: "小明" });
      // Every command after carries the key to that server, and only to it.
      expect(Arr.findLast(keys, said(pathOf("user.get")))).toEqual(Option.some(`${pathOf("user.get")} Bearer k1`));
      const logout = yield* cli(["auth", "logout"], "", env);
      expect(logout.code).toBe(0);
      expect(keys.at(-1)).toBe(`${pathOf("user.logout")} Bearer k1`);
      expect(signedIn(env.VIBEVALLEY_HOME)).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("auth login on the server's own computer says there is nothing to sign in to", () =>
    Effect.gen(function* () {
      const { server, keys } = yield* gateLike(true);
      const env = { VIBEVALLEY_HOME: tempDir("vv-auth-") };
      const login = yield* cli(["auth", "login", server], "", env);
      expect([login.code, Str.includes("不用登录")(login.out)]).toEqual([0, true]);
      expect(Arr.some(keys, said(pathOf("user.approval.create")))).toBe(false);
      expect(signedIn(env.VIBEVALLEY_HOME)).toBeUndefined();
    }).pipe(Effect.scoped),
  );
});
