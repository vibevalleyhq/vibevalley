import { expect, it } from "vite-plus/test";

import { mandateNoteFits } from "./mandate.ts";

it("limits manager notes by words across English and Chinese", () => {
  expect(mandateNoteFits("word ".repeat(30))).toBe(true);
  expect(mandateNoteFits("word ".repeat(31))).toBe(false);
  expect(mandateNoteFits("工作，".repeat(30))).toBe(true);
  expect(mandateNoteFits("工作，".repeat(31))).toBe(false);
  expect(mandateNoteFits(" \n … ")).toBe(true);
});
