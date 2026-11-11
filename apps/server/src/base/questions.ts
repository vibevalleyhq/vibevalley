import type { CriterionCheck, Question } from "@vibevalley/protocol";

const askLine = /^[\s>*#_-]*(?:\*\*)?要问用户(?:\*\*)?\s*[:：]\s*(?:\*\*)?(.+)$/u;
const optionsTail = /\s*[（(]\s*选项\s*[:：]\s*(.+?)\s*[)）]\s*$/u;

/** The questions a report's question lines ask, one per line; a line's options tail gives the options (at least two). */
const checkLine = /^标准\s*(\d+)\s*[:：]\s*(做到了|没做到|不确定)(?:\s*——\s*(.*))?$/u;
const results: Readonly<Record<string, CriterionCheck["result"]>> = { 做到了: "met", 没做到: "unmet", 不确定: "unsure" };

/** The helper's text checks, one per criterion line; explicit issue_report.checks still win. */
export const checksFromText = (said: string): CriterionCheck[] =>
  said.split("\n").flatMap((line) => {
    const m = checkLine.exec(line);
    if (!m) return [];
    const criterion = Number(m[1]) - 1;
    const word = m[2];
    if (!Number.isInteger(criterion) || criterion < 0) return [];
    const result = results[word ?? ""];
    if (result === undefined) return [];
    return [{ criterion, result, proof: (m[3] ?? "").trim() }];
  });

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
