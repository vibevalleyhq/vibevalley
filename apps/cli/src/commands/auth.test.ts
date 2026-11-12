import { describe, expect, it } from "vite-plus/test";

import { signedIn } from "@vibevalley/home";
import { pathOf } from "@vibevalley/protocol/api";
import { tempDir } from "@vibevalley/testkit/temp";

import { cli } from "#/testing/cli.ts";
import { fakeServer } from "#/testing/http.ts";

const device = { id: "d1", name: "buildbox", came: "login", addedAt: 1 };

/** A server behind its gate, as auth login meets it: the code, two collects (waiting, then the key), and user.get that
 * knows the device only by its key. */
const gateLike = async (here: boolean) => {
  let collects = 0;
  const keys: string[] = [];
  const server = await fakeServer(({ url, authorization: key }) => {
    keys.push(`${url} ${key}`);
    switch (url) {
      case pathOf("user.get"):
        return {
          json: {
            bizCode: 0,
            message: "ok",
            data: { name: key === "Bearer k1" ? "小明" : "", password: true, here, ...(key === "Bearer k1" ? { device } : {}) },
          },
        };
      case pathOf("user.approval.create"):
        return { json: { bizCode: 0, message: "ok", data: { code: "BCDF-GHJK", claim: "t1", expiresAt: 1, every: 0.01 } } };
      case pathOf("user.approval.collect"):
        collects++;
        // Waiting, then told to slow down (to a wait a test can afford), then the key.
        return {
          json: { bizCode: 0, message: "ok", data: collects === 1 ? {} : collects === 2 ? { every: 0.02 } : { login: { device: "d1", key: "k1" } } },
        };
      case pathOf("user.logout"):
        return { json: { bizCode: 0, message: "ok" } };
      default:
        return { status: 404 };
    }
  });
  return { server, keys };
};

const said = (path: string) => (k: string) => k.startsWith(path);

// Real time: auth login waits between its tries.
describe("auth", () => {
  it("auth login shows the code, waits for approval, keeps the key, sends it, and auth logout gives it back", async () => {
    const { server: running, keys } = await gateLike(false);
    await using _ = running;
    const server = running.url;
    const env = { VIBEVALLEY_HOME: tempDir("vv-auth-") };
    const login = await cli(["auth", "login", server + "/"], "", env);
    expect([login.code, login.out]).toEqual([0, expect.stringContaining("buildbox")]);
    expect(login.err).toContain(`${server}/approve?code=BCDF-GHJK`);
    expect(signedIn(env.VIBEVALLEY_HOME)).toEqual({ server, key: "k1", device: "d1" });
    const status = await cli(["auth", "status", "--format", "json"], "", env);
    const told: unknown = JSON.parse(status.out);
    expect(told).toMatchObject({ signedIn: true, server, name: "小明" });
    // Every command after carries the key to that server, and only to it.
    expect(keys.findLast(said(pathOf("user.get")))).toEqual(`${pathOf("user.get")} Bearer k1`);
    const logout = await cli(["auth", "logout"], "", env);
    expect(logout.code).toBe(0);
    expect(keys.at(-1)).toBe(`${pathOf("user.logout")} Bearer k1`);
    expect(signedIn(env.VIBEVALLEY_HOME)).toBeUndefined();
  });

  it("auth login on the server's own computer says there is nothing to sign in to", async () => {
    const { server: running, keys } = await gateLike(true);
    await using _ = running;
    const env = { VIBEVALLEY_HOME: tempDir("vv-auth-") };
    const login = await cli(["auth", "login", running.url], "", env);
    expect([login.code, login.out.includes("不用登录")]).toEqual([0, true]);
    expect(keys.some(said(pathOf("user.approval.create")))).toBe(false);
    expect(signedIn(env.VIBEVALLEY_HOME)).toBeUndefined();
  });
});
