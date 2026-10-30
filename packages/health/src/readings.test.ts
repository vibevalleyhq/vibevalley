import { describe, expect, test } from "vite-plus/test";

import { drift, escapesByArea, escapesIn, hotspots, mechanicalFiles, underTodaysNames } from "./readings.ts";

const day = 86_400_000;
const now = 100 * day;
const all = () => true;

describe("names", () => {
  test("an older change to a renamed file counts under its new name, across two renames", () => {
    const changes = underTodaysNames([
      { sha: "c3", at: 3, entries: [{ path: "src/c.ts", from: "src/b.ts" }] },
      { sha: "c2", at: 2, entries: [{ path: "src/b.ts", from: "src/a.ts" }, { path: "src/x.ts" }] },
      { sha: "c1", at: 1, entries: [{ path: "src/a.ts" }] },
    ]);
    expect(changes.map((c) => c.files)).toEqual([["src/c.ts"], ["src/c.ts", "src/x.ts"], ["src/c.ts"]]);
  });
});

describe("hotspots", () => {
  const sources = [
    { path: "big.ts", text: "x\n".repeat(99) },
    { path: "small.ts", text: "x\n".repeat(9) },
    { path: "big.test.ts", text: "x\n".repeat(999) },
  ];
  const change = (at: number, ...files: string[]) => ({ sha: String(at), at, files });

  test("changes × lines, the window before beside it, files not counted left out", () => {
    const hot = hotspots(
      [change(now - day, "big.ts", "small.ts", "big.test.ts"), change(now - 2 * day, "small.ts"), change(now - 40 * day, "big.ts")],
      sources,
      now,
      30,
      (p) => !p.endsWith(".test.ts"),
    );
    expect(hot).toEqual([
      { path: "big.ts", changes: 1, before: 1, lines: 100, score: 100 },
      { path: "small.ts", changes: 2, before: 0, lines: 10, score: 20 },
    ]);
  });

  test("a mechanical change and one older than both windows count nowhere", () => {
    const wide = Array.from({ length: mechanicalFiles + 1 }, (_, i) => (i === 0 ? "big.ts" : `f${i}.ts`));
    expect(hotspots([change(now - day, ...wide), change(now - 70 * day, "big.ts")], sources, now, 30, all)).toEqual([]);
  });
});

describe("escapes", () => {
  test("non-null assertions, casts, casts through unknown and lint-off comments, in .ts and .tsx", () => {
    const ts = `const a = b!.c!;\nconst d = e as unknown as F;\nconst g = h as F;\nconst k = [1] as const;\nconst u = v as unknown;\n// oxlint-disable-next-line no-x\n/* eslint-disable y */\nconst s = "x!";`;
    expect(escapesIn("a.ts", ts)).toEqual({ nonNull: 2, doubleCast: 1, cast: 1, lintOff: 2, orDie: 0, ignored: 0, swallowed: 0 });
    expect(escapesIn("a.tsx", "const v = <b>{q!}</b>;")).toEqual({ nonNull: 1, doubleCast: 0, cast: 0, lintOff: 0, orDie: 0, ignored: 0, swallowed: 0 });
  });

  test("errors turned into defects, dropped, or caught and let go", () => {
    const ts = [
      "const a = run.pipe(Effect.orDie);",
      "const b = Effect.orDieWith(run, (e) => e);",
      "const c = Effect.ignore(run);",
      "const d = run.pipe(Effect.ignoreCause);",
      'const e = Effect.ignore(run, { log: "Warn" });',
      "const f = run.pipe(Effect.ignore({ log: true }));",
      "try { f(); } catch {}",
      "try { f(); } catch (e) { log(e); }",
      "p.catch(() => {});",
      "p.catch(() => undefined);",
      "p.catch((e) => log(e));",
    ].join("\n");
    expect(escapesIn("a.ts", ts)).toMatchObject({ orDie: 2, ignored: 2, swallowed: 3 });
  });

  test("summed by area, counted files only", () => {
    const sources = [
      { path: "a/one.ts", text: "x!;" },
      { path: "a/two.ts", text: "y!;" },
      { path: "b/one.ts", text: "z as unknown as T;" },
      { path: "a/one.test.ts", text: "w!;" },
    ];
    const health = { counted: (p: string) => !p.endsWith(".test.ts"), areaOf: (p: string) => p.split("/")[0]! };
    expect(escapesByArea(sources, health)).toEqual({
      a: { nonNull: 2, doubleCast: 0, cast: 0, lintOff: 0, orDie: 0, ignored: 0, swallowed: 0 },
      b: { nonNull: 0, doubleCast: 1, cast: 0, lintOff: 0, orDie: 0, ignored: 0, swallowed: 0 },
    });
  });

  test("the ratchet: up, down, a new area and a gone one all drift; equal counts do not", () => {
    const e = (nonNull: number) => ({ nonNull, doubleCast: 0, cast: 0, lintOff: 0, orDie: 0, ignored: 0, swallowed: 0 });
    expect(drift({ a: e(2), b: e(1), gone: e(3) }, { a: e(3), b: e(1), fresh: e(1) })).toEqual([
      { area: "a", kind: "nonNull", kept: 2, now: 3 },
      { area: "fresh", kind: "nonNull", kept: 0, now: 1 },
      { area: "gone", kind: "nonNull", kept: 3, now: 0 },
    ]);
  });
});
