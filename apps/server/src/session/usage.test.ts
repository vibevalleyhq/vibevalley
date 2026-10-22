import { expect, it } from "vite-plus/test";
import { usageText } from "./usage.ts";

it("words a model answer's tokens", () => {
  expect(usageText({ input: 1_000, cacheRead: 1_000, output: 1_234_567 }, ["memory", "tools"])).toBe(
    "缓存命中 50%：读缓存 1 000，没命中 1 000，输出 1 234 567；开头变了：记性、工具",
  );
  expect(usageText({ input: 0, cacheRead: 0, output: 12 })).toBe("没报读了多少：输出 12");
});
