// A Chinese input method types full-width marks: 【 for [, （ for (, 、 for /, ＃ for #, ＠ for @. Where a pair or a
// first character starts the editor's syntax, the marks just typed are read as that syntax, so a link, a block ref,
// a command or a name opens without switching to English input. One 【 stays 【: it is Chinese punctuation.

/** The syntax an editor takes: a doubled bracket, a / that starts the text, a # or an @. */
export type Mark = "[[" | "]]" | "((" | "))" | "/" | "#" | "@";

// Keystrokes, not words, so code points: \u3010 【, \u3011 】, \uff08 （, \uff09 ）, \u3001 、.
const doubled: Readonly<Record<"[[" | "]]" | "((" | "))", readonly string[]>> = {
  "[[": ["[", "\u3010"],
  "]]": ["]", "\u3011"],
  "((": ["(", "\uff08"],
  "))": [")", "\uff09"],
};
const single: Readonly<Record<"#" | "@", string>> = { "#": "＃", "@": "＠" };

/** The text with the marks just typed before the caret as the syntax they stand for; undefined when there are none.
 * Each mark is one character for one, so the caret stays where it is: from and to say what to replace. */
export function typedMarks(
  value: string,
  caret: number,
  marks: readonly Mark[],
): { readonly from: number; readonly to: number; readonly text: string } | undefined {
  const before = value.slice(0, caret);
  for (const mark of marks) {
    switch (mark) {
      case "[[":
      case "]]":
      case "((":
      case "))": {
        const two = before.slice(-2);
        const [a = "", b = ""] = two;
        const ways = doubled[mark];
        if (two.length === 2 && ways.includes(a) && ways.includes(b) && two !== mark) return { from: caret - 2, to: caret, text: mark };
        break;
      }
      case "/":
        if (before === "\u3001") return { from: 0, to: 1, text: "/" };
        break;
      case "#":
      case "@":
        if (before.endsWith(single[mark])) return { from: caret - 1, to: caret, text: mark };
        break;
    }
  }
  return undefined;
}
