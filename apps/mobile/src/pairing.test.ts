import { expect, test } from "vite-plus/test";

import { lanKeyCookie } from "@vibevalley/protocol";

import { deviceName, isPairPage, keyScript, level, parsePairLink } from "./pairing";

test("a pairing link, from the QR code or the app's own scheme", () => {
  expect(parsePairLink(" http://192.168.1.20:8790/pair?c=ABCDE12345 ")).toEqual({ url: "http://192.168.1.20:8790", code: "ABCDE12345" });
  expect(parsePairLink("vibevalley://pair?u=" + encodeURIComponent("http://10.0.0.3:8790") + "&c=K")).toEqual({ url: "http://10.0.0.3:8790", code: "K" });
  for (const bad of [
    "",
    "看看",
    "http://192.168.1.20:8790/pair",
    "http://192.168.1.20:8790/issues?c=X",
    "ftp://x/pair?c=X",
    "vibevalley://pair?u=ftp://x&c=K",
    "vibevalley://other?u=http://x&c=K",
  ]) {
    expect(parsePairLink(bad)).toBeUndefined();
  }
});

test("the phone's name, the key's cookie, the page's own pairing, a level", () => {
  expect([deviceName("ios", undefined), deviceName("android", undefined), deviceName("ios", "小明的 iPhone")]).toEqual(["iPhone", "安卓手机", "小明的 iPhone"]);
  expect(keyScript("a+b").startsWith(`document.cookie = "${lanKeyCookie}=a%2Bb; Path=/;`)).toBe(true);
  expect([isPairPage("http://h:1", "http://h:1/pair"), isPairPage("http://h:1", "http://h:1/issues"), isPairPage("http://h:1", "http://other:1/pair")]).toEqual(
    [true, false, false],
  );
  expect([level(0), level(255), level(undefined)]).toEqual([0, 100, 0]);
});
