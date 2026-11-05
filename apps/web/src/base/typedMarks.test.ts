import { expect, test } from "vite-plus/test";

import { typedMarks } from "./typedMarks";

const all = ["[[", "]]", "((", "))", "/", "#", "@"] as const;
const typed = (value: string, caret = value.length) => {
  const m = typedMarks(value, caret, all);
  return m ? value.slice(0, m.from) + m.text + value.slice(m.to) : value;
};

test("a full-width pair typed with a Chinese input method is the syntax it stands for", () => {
  expect(typed("读了【【")).toBe("读了[[");
  expect(typed("读了[【")).toBe("读了[[");
  expect(typed("[[读书】】")).toBe("[[读书]]");
  expect(typed("见（（")).toBe("见((");
  expect(typed("((abc））")).toBe("((abc))");
});

test("one full-width bracket is Chinese punctuation and stays", () => {
  expect(typed("【注意")).toBe("【注意");
  expect(typed("说明【")).toBe("说明【");
  expect(typed("（")).toBe("（");
});

test("、 is a command only as the first character; ＃ and ＠ are # and @", () => {
  expect(typed("、")).toBe("/");
  expect(typed("甲、")).toBe("甲、");
  expect(typed("今天＃")).toBe("今天#");
  expect(typed("问＠")).toBe("问@");
});

test("only what is just before the caret is read, and an editor reads only its own marks", () => {
  expect(typedMarks("【【后面", 2, all)).toEqual({ from: 0, to: 2, text: "[[" });
  expect(typedMarks("【【后面", 4, all)).toBeUndefined();
  expect(typedMarks("、", 1, ["@"])).toBeUndefined();
});
