import { expect, test } from "vite-plus/test";

import { deviceKeyCookie } from "@vibevalley/protocol";

import { isRemote, keyCookie } from "./device";

test("only this computer's own addresses are not remote", () => {
  for (const h of ["127.0.0.1", "localhost", "[::1]"]) expect(isRemote(h)).toBe(false);
  for (const h of ["192.168.1.20", "10.0.0.3", "my-mac.local"]) expect(isRemote(h)).toBe(true);
});

test("a paired key is kept in the device's cookie", () => {
  expect(keyCookie("a+b").startsWith(`${deviceKeyCookie}=a%2Bb; Path=/;`)).toBe(true);
});
