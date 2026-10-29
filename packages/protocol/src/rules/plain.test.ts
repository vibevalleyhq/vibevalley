import { describe, expect, it } from "vite-plus/test";
import { plainLine } from "./plain";

describe("plainLine", () => {
  it("takes headings, bullets, emphasis, code and links off, and joins the lines", () => {
    expect(plainLine("## 做完了\n\n- 加了 **计时**\n- 改了 `clock.ts`，见 [PR](https://x.test/1)\n1. 测试过了")).toBe(
      "做完了 加了 计时 改了 clock.ts，见 PR 测试过了",
    );
  });

  it("keeps a code block's text and words with underscores in them", () => {
    expect(plainLine("```ts\nconst a_b = 1;\n```\nsession_list 列出谁在场")).toBe("const a_b = 1; session_list 列出谁在场");
  });

  it("leaves plain text as it is", () => {
    expect(plainLine("用 8787 还是 8797?")).toBe("用 8787 还是 8797?");
  });
});
