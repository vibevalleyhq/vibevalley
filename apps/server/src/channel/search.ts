import { chatNamed } from "./mentions.ts";
export type SearchHas = "file" | "image" | "link";

export interface SearchQuery {
  readonly words: string;
  /** A participant's id, or a name to match. */
  readonly from?: string;
  readonly in?: string;
  readonly has: readonly SearchHas[];
  /** Before the day it names (that day left out), and from the day it names on: epoch ms, at the server's midnight. */
  readonly before?: number;
  readonly after?: number;
}

const filterPattern = /(?:^|\s)(from|in|has|before|after):(\S+)/giu;

const dayPattern = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

/** A filter that does not read stays among the words. */
export function parseSearch(text: string): SearchQuery {
  let from: string | undefined;
  let inName: string | undefined;
  let before: number | undefined;
  let after: number | undefined;
  const has: SearchHas[] = [];
  const words = text
    .replace(filterPattern, (whole, key: string, value: string) => {
      const day = dayPattern.exec(value);
      const at = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime() : undefined;
      switch (key.toLowerCase()) {
        case "from":
          from = chatNamed[value.replace(/^@/, "")] ?? value.replace(/^@/, "");
          return " ";
        case "in":
          inName = value.replace(/^#/, "");
          return " ";
        case "has":
          if (value === "file" || value === "image" || value === "link") {
            if (!has.includes(value)) has.push(value);
            return " ";
          }
          return whole;
        case "before":
          if (at === undefined) return whole;
          before = at;
          return " ";
        case "after":
          if (at === undefined) return whole;
          after = at;
          return " ";
        default:
          return whole;
      }
    })
    .replace(/\s+/g, " ")
    .trim();
  return {
    words,
    has,
    ...(from !== undefined ? { from } : {}),
    ...(inName !== undefined ? { in: inName } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
  };
}
