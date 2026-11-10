import { expect, test } from "vite-plus/test";

import { channelOf, channels, farmHomeOf, serverEnvOf } from "./channel";

test("a packaged app is its version's channel; from the repository or between tags it is dev", () => {
  expect(["0.4.0", "0.4.0-beta.2", "0.4.0-alpha.1"].map((v) => channelOf(v, true))).toEqual(["stable", "beta", "alpha"]);
  expect([channelOf("0.4.0", false), channelOf("0.0.0", true)]).toEqual(["dev", "dev"]);
});

test("each channel has its own name, app id, command, farm and ports, so they open side by side", () => {
  const all = Object.values(channels);
  for (const key of ["name", "appId", "command", "suffix", "voiceLinePort", "lanPort"] as const) expect(new Set(all.map((c) => c[key])).size).toBe(all.length);
  const ports = all.flatMap((c) => [c.voiceLinePort, c.lanPort]);
  expect(new Set(ports).size).toBe(ports.length);
});

test("the channel's farm, work folder and ports go to its server unless the user set them", () => {
  expect(farmHomeOf("beta", {}, "/Users/o")).toBe("/Users/o/.vibevalley-beta");
  expect(serverEnvOf("alpha", { PATH: "/bin" }, "/Users/o")).toEqual({
    PATH: "/bin",
    VIBEVALLEY_HOME: "/Users/o/.vibevalley-alpha",
    VIBEVALLEY_WORK_ROOT: "/Users/o/vibevalley-alpha",
    VIBEVALLEY_VOICE_LINE_PORT: "8808",
    VIBEVALLEY_LAN_PORT: "8810",
  });
  expect(serverEnvOf("stable", { VIBEVALLEY_HOME: "/tmp/farm", VIBEVALLEY_LAN_PORT: "9000" }, "/Users/o")).toMatchObject({
    VIBEVALLEY_HOME: "/tmp/farm",
    VIBEVALLEY_WORK_ROOT: "/Users/o/vibevalley",
    VIBEVALLEY_LAN_PORT: "9000",
  });
});
