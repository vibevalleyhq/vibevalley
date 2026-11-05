import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { tempDir } from "@vibevalley/testkit/temp";

import { announce, announced, defaultHome, homeOf, savedLocale } from "./index";

test("a home is VIBEVALLEY_HOME, else ~/.vibevalley with a channel's suffix", () => {
  expect(homeOf({ VIBEVALLEY_HOME: "/farm" })).toBe("/farm");
  expect(defaultHome("-beta", "/Users/o")).toBe("/Users/o/.vibevalley-beta");
});

test("a server says where it listens in its home while it runs, and a stopped one's word is not taken", () => {
  const home = tempDir("vv-announce-");
  expect(announced(home)).toBeUndefined();
  const withdraw = announce(home, "http://127.0.0.1:56048");
  expect(announced(home)).toBe("http://127.0.0.1:56048");
  withdraw();
  expect(announced(home)).toBeUndefined();
  // Left behind by a server that died: its pid is not running.
  writeFileSync(join(home, "server.json"), JSON.stringify({ url: "http://127.0.0.1:1", pid: 2 ** 22 + 7 }));
  expect(announced(home)).toBeUndefined();
});

test("the saved language is settings.json's, Chinese when there is none or it is not one we speak", () => {
  const home = tempDir("vv-locale-");
  expect(savedLocale(home)).toBe("zh");
  writeFileSync(join(home, "settings.json"), JSON.stringify({ locale: "en" }));
  expect(savedLocale(home)).toBe("en");
  writeFileSync(join(home, "settings.json"), "{");
  expect(savedLocale(home)).toBe("zh");
});
