import { expect, test } from "bun:test";
import { lanKeyCookie } from "@vibevalley/protocol";
import { deviceGuess, isPaired, isRemote, keyCookie } from "./lan";

test("only this computer's own addresses are not remote", () => {
  for (const h of ["127.0.0.1", "localhost", "[::1]"]) expect(isRemote(h)).toBe(false);
  for (const h of ["192.168.1.20", "10.0.0.3", "my-mac.local"]) expect(isRemote(h)).toBe(true);
});

test("a kept key is a pairing; an empty one is not", () => {
  expect(isPaired("")).toBe(false);
  expect(isPaired(`theme=dark; ${lanKeyCookie}=abc`)).toBe(true);
  expect(isPaired(`${lanKeyCookie}=`)).toBe(false);
  expect(isPaired(`x${lanKeyCookie}=abc`)).toBe(false);
  expect(keyCookie("a+b")).toStartWith(`${lanKeyCookie}=a%2Bb; Path=/;`);
});

test("a device is guessed from its browser", () => {
  expect(deviceGuess("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)")).toBe("iPhone");
  expect(deviceGuess("Mozilla/5.0 (Linux; Android 16; Pixel 10)")).toBe("安卓手机");
  expect(deviceGuess("Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)")).toBe("Mac");
  expect(deviceGuess("curl/8")).toBe("一台设备");
});
