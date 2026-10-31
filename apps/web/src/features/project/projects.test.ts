import { describe, expect, test } from "vite-plus/test";

import type { LanguageCount } from "@vibevalley/protocol";

import { calendarOf, recencyOf, since, streaksOf } from "./calendar";
import { languageShares } from "./languages";
import { githubRepository, number } from "./projects";
const lang = (name: string, code: number, comments = 0, files = 1): LanguageCount => ({ name, files, code, comments, blanks: 0 });

describe("languages", () => {
  test("aliases merge, shares add up, the tail becomes 其他", () => {
    const shares = languageShares([
      lang("TypeScript", 600),
      lang("TSX", 200, 100),
      lang("Rust", 50),
      lang("Python", 25),
      lang("Go", 10),
      lang("Shell", 5),
      lang("CSS", 4),
      lang("HTML", 3),
      lang("Zig", 2),
      lang("Lua", 1),
    ]);
    expect([shares[0]!.label, shares[0]!.lines, shares[0]!.files]).toEqual(["TypeScript", 900, 2]);
    expect(shares).toHaveLength(8);
    expect([shares.at(-1)!.label, shares.at(-1)!.lines]).toEqual(["其他", 3]);
    expect(shares.reduce((n, s) => n + s.share, 0)).toBeCloseTo(1, 9);
  });

  test("one leftover language keeps its name; unknown ones keep theirs", () => {
    const shares = languageShares([lang("Go", 10), lang("Nim", 5)], 1);
    expect(shares.map((s) => s.label)).toEqual(["Go", "Nim"]);
    expect(shares.at(-1)!.id).toBe("other");
    expect(languageShares([lang("Go", 1)], undefined)).toHaveLength(1);
  });
});

describe("calendar", () => {
  const now = new Date(2026, 9, 14, 15); // a Wednesday
  test("53 weeks, Monday first, today in the last column and the days after it future", () => {
    const c = calendarOf([], now);
    expect(c.weeks).toHaveLength(53);
    expect(c.weeks[0]![0]!.at.getDay()).toBe(1);
    const last = c.weeks.at(-1)!;
    expect([last[2]!.day, last[2]!.future, last[3]!.future]).toEqual(["2026-10-14", false, true]);
  });

  test("levels grow against the busy days; streaks count runs", () => {
    const c = calendarOf(
      [
        { day: "2026-10-14", commits: 8 },
        { day: "2026-10-13", commits: 2 },
        { day: "2026-10-12", commits: 1 },
        { day: "2026-10-08", commits: 4 },
      ],
      now,
    );
    expect(c.weeks.at(-1)![2]!.level).toBe(4);
    expect(c.weeks.at(-1)![1]!.level).toBe(1);
    expect(streaksOf(c)).toEqual({ total: 15, days: 4, longest: 3, current: 3, busiest: { day: "2026-10-14", commits: 8 } });
  });

  test("a month label over the week it starts in", () => {
    const c = calendarOf([], now);
    expect(c.months.at(-1)!.label).toBe("10月");
    expect(c.weeks[c.months.at(-1)!.week]!.some((d) => d.day === "2026-10-01")).toBe(true);
  });
});

test("recency by the newest commit", () => {
  const day = 86400000;
  expect(recencyOf(undefined, 0)).toBe("never");
  expect(recencyOf(0, day / 2)).toBe("day");
  expect(recencyOf(0, 5 * day)).toBe("week");
  expect(recencyOf(0, 20 * day)).toBe("month");
  expect(recencyOf(0, 60 * day)).toBe("quarter");
  expect(recencyOf(0, 200 * day)).toBe("older");
});

test("new projects: names and GitHub addresses", () => {
  expect(githubRepository("https://github.com/botiverse/raft-source.git/")).toEqual({
    name: "raft-source",
    url: "https://github.com/botiverse/raft-source.git",
  });
  expect(githubRepository("git@github.com:a/b.git")).toBeUndefined();
  expect(githubRepository("https://github.com/a/..")).toBeUndefined();
  expect(number(1234567)).toBe("1,234,567");
  expect(since(0, 3 * 3600000)).toBe("3 小时前");
});
