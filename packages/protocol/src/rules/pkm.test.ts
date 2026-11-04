import { expect, test } from "vite-plus/test";

import { slugOf } from "./pkm";

test("a page's name from its title", () => {
  expect(slugOf(" Cetus Core ")).toBe("cetus-core");
  expect(slugOf("a/b")).toBe("a__b");
  expect(slugOf("a\\b")).toBe("a__b");
});
