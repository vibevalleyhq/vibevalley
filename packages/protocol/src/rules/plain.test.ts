import { describe, expect, it } from "vite-plus/test";

import { plainText } from "./plain";

describe("plainText", () => {
  it("takes headings, bullets, emphasis, code and links off, and joins the lines", () => {
    expect(plainText("## 做完了\n\n- 加了 **计时**\n- 改了 `clock.ts`，见 [PR](https://x.test/1)\n1. 测试过了")).toBe(
      "做完了 加了 计时 改了 clock.ts，见 PR 测试过了",
    );
  });

  it("leaves a code block out of the line", () => {
    expect(plainText("看这里：\n```ts\nconst a = 1;\n```\n就这样")).toBe("看这里： 就这样");
  });

  it("leaves plain text as it is", () => {
    expect(plainText("用 8787 还是 8797?")).toBe("用 8787 还是 8797?");
  });
});
