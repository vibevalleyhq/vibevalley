import { expect, test } from "vite-plus/test";

import { deviceGuess } from "./device";

test("a device is guessed from its browser", () => {
  expect(deviceGuess("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)")).toBe("iPhone");
  expect(deviceGuess("Mozilla/5.0 (Linux; Android 16; Pixel 10)")).toBe("安卓手机");
  expect(deviceGuess("Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)")).toBe("Mac");
  expect(deviceGuess("curl/8")).toBe("一台设备");
});
