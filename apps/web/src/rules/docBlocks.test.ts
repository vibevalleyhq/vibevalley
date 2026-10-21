import { expect, test } from "bun:test";
import { blockHeading, blockNumbered, blockParagraph, type DocSpan } from "@vibevalley/protocol";
import { keyBetween, validKey } from "@vibevalley/protocol/rules";
import { codePointOffset, editSpans, listNumbers, markdownShortcut, plainOf } from "./docBlocks";

const span = (t: string, bold = false): DocSpan => ({ t, marks: bold ? { bold: true } : {} });

test("keys between, as the server makes them", () => {
  expect(keyBetween("", "")).toBe("V");
  expect(keyBetween("V", "")).toBe("W");
  expect(keyBetween("", "V")).toBe("U");
  expect(keyBetween("z", "")).toBe("z1");
  expect(keyBetween("", "1")).toBe("0z");
  expect(keyBetween("V", "W")).toBe("VV");
  expect(keyBetween("0V", "1")).toBe("0l");
  expect(() => keyBetween("b", "a")).toThrow();
  expect(() => keyBetween("a0", "")).toThrow();
  let keys: string[] = [];
  for (let i = 0; i < 300; i++) {
    keys = [...keys, keyBetween(keys.at(-1) ?? "", "")];
    keys = [keyBetween("", keys[0]!), ...keys];
    keys = [keys[0]!, keyBetween(keys[0]!, keys[1]!), ...keys.slice(1)];
  }
  expect([...keys].sort()).toEqual(keys);
  expect(keys.every(validKey)).toBe(true);
});

test("offsets are code points", () => {
  expect(codePointOffset("你好👍世界", 4)).toBe(3);
  expect(codePointOffset("ét", 2)).toBe(2);
});

test("an edit keeps the marks around it, and typed text takes the marks before it", () => {
  const edited = editSpans([span("你"), span("好", true), span("世界")], "你好呀世界");
  expect(plainOf(edited)).toBe("你好呀世界");
  expect(edited.map((s) => [s.t, s.marks.bold ?? false])).toEqual([
    ["你", false],
    ["好呀", true],
    ["世界", false],
  ]);
  // An emoji typed next to another is never cut in half.
  expect(plainOf(editSpans([span("👍")], "👍👎"))).toBe("👍👎");
});

test("line-start Markdown and list numbers", () => {
  expect(markdownShortcut("### 标题")?.type).toBe(blockHeading);
  expect(markdownShortcut("[x] 做完了")?.attrs.checked).toBe(true);
  expect(markdownShortcut("#没有空格")).toBeUndefined();
  expect(
    Object.fromEntries(
      listNumbers([
        { id: "a", type: blockNumbered },
        { id: "a1", parentId: "a", type: blockNumbered },
        { id: "b", type: blockNumbered },
        { id: "p", type: blockParagraph },
        { id: "c", type: blockNumbered },
      ]),
    ),
  ).toEqual({ a: 1, a1: 1, b: 2, c: 1 });
});
