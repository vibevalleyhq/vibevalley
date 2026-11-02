import type { Question } from "@vibevalley/protocol";

const askLine = /^[\s>*#_-]*(?:\*\*)?要问主人(?:\*\*)?\s*[:：]\s*(?:\*\*)?(.+)$/u;
const optionsTail = /\s*[（(]\s*选项\s*[:：]\s*(.+?)\s*[)）]\s*$/u;

/** The questions a report's 要问主人 lines ask, one per line; a line's 选项 tail gives the options (at least two). */
export const questionsFromText = (said: string): Question[] =>
  said.split("\n").flatMap((line) => {
    const raw = askLine.exec(line)?.[1]?.replace(/\*\*$/u, "").trim();
    if (!raw) return [];
    const tail = optionsTail.exec(raw);
    const question = tail ? raw.slice(0, tail.index).trim() : raw;
    const options = (tail?.[1] ?? "")
      .split(/[｜|]/u)
      .map((option) => option.trim())
      .filter(Boolean);
    return [{ question, options: options.length >= 2 ? options : [] }];
  });
