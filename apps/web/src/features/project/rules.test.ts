import { describe, expect, test } from "vite-plus/test";
import type { Issue, LanguageCount, Phase, ProjectSummary, Session } from "@vibevalley/protocol";
import {
  calendarOf,
  githubRepository,
  growthOf,
  type Island,
  islandScale,
  islandsOf,
  islandText,
  homeless,
  languageShares,
  mapPose,
  mapTally,
  number,
  plotsIn,
  since,
  streaksOf,
} from "./rules";

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

test("growth by the newest commit", () => {
  const day = 86400000;
  expect(growthOf(undefined, 0).crop).toBe("empty");
  expect(growthOf(0, day / 2).label).toBe("正旺");
  expect(growthOf(0, 5 * day).crop).toBe("leafy");
  expect(growthOf(0, 20 * day).crop).toBe("sprout");
  expect(growthOf(0, 60 * day).crop).toBe("dry");
  expect(growthOf(0, 200 * day).label).toBe("荒了");
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

const working: Phase = { _tag: "working", since: 0, doing: { action: "edit_file", label: "src/a.ts" } };
const project = (name: string, last?: number, maxSessions = 3): ProjectSummary => ({
  name,
  path: `/work/${name}`,
  git: true,
  maxSessions,
  pullRequest: { available: false, reason: "尚未检测 GitHub" },
  ...(last !== undefined ? { last } : {}),
});
const todo = (id: string, p: string, queuedAt?: number) =>
  ({ id, title: `活 ${id}`, project: p, status: queuedAt === undefined ? "backlog" : "todo", ...(queuedAt !== undefined ? { queuedAt } : {}) }) as Issue;
const hired = (id: string, p: string | undefined, phase: Phase, at = 0, more: Partial<Session> = {}) =>
  ({ id, name: `帮工${id}`, agent: "a", hiredAt: at, phase, brief: "", ...(p ? { project: p } : {}), ...more, refining: false }) as Session;
const kinds = (i: Island) => i.spots.map((s) => (s.kind === "taken" ? s.session.id : s.kind));

describe("islands", () => {
  const projects = [project("clock-in", 9), project("docs", 5), project("task-smoke", 7)];
  test("worktrees in the order the helpers came, then the room the project and the farm leave", () => {
    const islands = islandsOf({
      projects,
      sessions: [
        hired("w2", "clock-in", { _tag: "done" }, 2),
        hired("w1", "clock-in", working, 1),
        hired("w4", "clock-in", { _tag: "resting" }, 4),
        hired("w5", "docs", working),
        hired("w3", undefined, { _tag: "failed" }),
      ],
      plots: { w1: { crop: "leafy" } },
      issues: [todo("b2", "docs", 8), todo("b1", "docs", 3), todo("b3", "clock-in")],
    });
    expect(islands.map((i) => i.project)).toEqual(["clock-in", "docs", "task-smoke"]);
    const clock = islands[0]!;
    expect(kinds(clock)).toEqual(["w1", "w2", "w4", "open", "open"]);
    expect([clock.working, clock.maxSessions]).toEqual([1, 3]);
    expect(clock.spots[0]!.kind === "taken" && clock.spots[0]!.plot.crop).toBe("leafy");
    expect(clock.spots[1]!.kind === "taken" && clock.spots[1]!.plot.crop).toBe("seeded");
    expect(islandText(clock)).toBe("在干 1/3");
    expect(islands[1]!.queued.map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(islandText(islands[1]!)).toBe("在干 1/3 · 排队 2");
    expect(kinds(islands[2]!)).toEqual(["open", "open", "open"]);
    expect(homeless([hired("w3", undefined, { _tag: "failed" })]).map((h) => h.id)).toEqual(["w3"]);
    expect(mapTally(islands)).toEqual({ peopled: 2, working: 2, queued: 2 });
  });

  test("a full project has no room; when every bed is working, its open plots are shut", () => {
    const full = islandsOf({ projects, sessions: ["a", "b", "c"].map((id) => hired(id, "clock-in", working)), plots: {}, issues: [] })[0]!;
    expect(kinds(full)).toEqual(["a", "b", "c"]);
    expect(islandText(full)).toBe("在干 3/3（满了）");
    const busy = islandsOf({
      projects,
      sessions: Array.from({ length: 6 }, (_, i) => hired(`h${i}`, i % 2 === 0 ? "clock-in" : "docs", working)),
      plots: {},
      issues: [],
    });
    expect(kinds(busy.find((i) => i.project === "task-smoke")!)).toEqual(["shut", "shut", "shut"]);
  });

  test("a project gone from the list keeps its helpers and takes no more", () => {
    const gone = islandsOf({ projects: [], sessions: [hired("w1", "old", { _tag: "done" })], plots: {}, issues: [] });
    expect(gone).toHaveLength(1);
    expect(gone[0]!.summary).toBeUndefined();
    expect(kinds(gone[0]!)).toEqual(["w1"]);
    expect(islandText(gone[0]!)).toBe("不在工作目录里了");
  });

  test("a yard holds six plots at most", () => {
    const crowded = islandsOf({
      projects: [project("big", undefined, 6)],
      sessions: Array.from({ length: 5 }, (_, i) => hired(`r${i}`, "big", { _tag: "resting" })),
      plots: {},
      issues: [],
    })[0]!;
    expect(crowded.spots).toHaveLength(6);
    expect(kinds(crowded).at(-1)).toBe("open");
  });
});

describe("the yard", () => {
  const yard = { left: 100, top: 50, width: 150, height: 80 };
  test("three plots side by side, centred; four as two and two; five as three and two", () => {
    const three = plotsIn(yard, 3);
    expect(three.map((p) => p.x)).toEqual([121, 175, 229]);
    expect(new Set(three.map((p) => p.y)).size).toBe(1);
    const four = plotsIn(yard, 4);
    expect(four.map((p) => p.x)).toEqual([148, 202, 148, 202]);
    expect(four[2]!.y - four[0]!.y).toBe(36);
    expect(
      plotsIn(yard, 5)
        .slice(3)
        .map((p) => p.x),
    ).toEqual([148, 202]);
    for (const p of [...three, ...four]) expect(p.x - 17 >= yard.left && p.x + 17 <= yard.left + yard.width).toBe(true);
    expect(plotsIn(yard, 0)).toEqual([]);
    expect(plotsIn(yard, 1)[0]!.x).toBe(175);
  });

  test("islands twice as big two to a row, smaller to fit two, one to a row on a narrow page", () => {
    expect(islandScale(1340, 292, 24)).toBe(2);
    expect(islandScale(940, 292, 24)).toBe(1.5);
    expect(islandScale(800, 292, 24)).toBe(2.5);
    expect(islandScale(500, 292, 24)).toBe(1.5);
    expect(islandScale(326, 292, 24)).toBeCloseTo(1.116, 3);
  });

  test("how a helper looks on its plot", () => {
    expect(mapPose(hired("a", "p", working))).toBe("work");
    expect(mapPose(hired("a", "p", { _tag: "working", since: 0, doing: { action: "thinking", label: "" } }))).toBe("think");
    expect(mapPose(hired("a", "p", { _tag: "done" }))).toBe("cheer");
    expect(mapPose(hired("a", "p", { _tag: "failed" }))).toBe("worry");
    expect(mapPose(hired("a", "p", { _tag: "resting" }, 0, { conflict: { base: "main", files: ["a.ts"] } }))).toBe("worry");
  });
});
