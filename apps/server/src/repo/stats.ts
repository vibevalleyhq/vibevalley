import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import { DateTime, Effect, Schema } from "effect";

import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { jsonOrNone } from "#/base/json.ts";
import { or } from "#/base/order.ts";

import { gitQuiet } from "./git.ts";

/** Not what a repo is written in: gitignore patterns, as tokei's --exclude takes them. */
const leftOut = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
  "*.min.js",
  "*.min.css",
  "*.map",
  "node_modules/",
  "vendor/",
  "dist/",
  "build/",
  "target/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".next/",
  "coverage/",
];

export const tokeiArgs = (path: string) => ["--output", "json", ...leftOut.flatMap((p) => ["--exclude", p]), path];

/** 53 weeks, so a whole year of weeks shows whatever day it is. */
export const yearDays = 53 * 7;

/** Close to JavaScript's localeCompare for names, as the Go has it: case ignored first, then by bytes. */
const localeCompare = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/** tokei --output json: each language's lines and the files it read. */
const tokeiOutput = jsonOrNone(
  Schema.Record(Schema.String, Schema.Struct({ code: Schema.Finite, comments: Schema.Finite, blanks: Schema.Finite, reports: Schema.Array(Schema.Unknown) })),
);

/** Its total, and languages with nothing but blank lines, left out; undefined when it is not tokei's output. */
export function countsOf(output: string): T.LanguageCount[] | undefined {
  const raw = tokeiOutput(output);
  if (!raw) return undefined;
  const out: T.LanguageCount[] = [];
  for (const [name, l] of Object.entries(raw)) {
    if (name === "Total" || l.code + l.comments <= 0) continue;
    out.push({
      name,
      files: l.reports.length,
      code: Math.trunc(l.code),
      comments: Math.trunc(l.comments),
      blanks: Math.trunc(l.blanks),
    });
  }
  return out.toSorted((a, b) => or(b.code + b.comments - (a.code + a.comments), localeCompare(a.name, b.name)));
}

/** The calendar day an instant falls on where the farm runs, as yyyy-mm-dd. */
const localDay = (ms: number) => DateTime.formatIsoDate(DateTime.makeZonedUnsafe(ms, { timeZone: DateTime.zoneMakeLocal() }));

export function activityOf(log: string, dayOf: (ms: number) => string = localDay): { days: T.DayCount[]; authors: T.Author[] } {
  const byDay = new Map<string, number>();
  const byAuthor = new Map<string, number>();
  for (const line of log.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const seconds = Number(line.slice(0, tab).trim());
    if (!Number.isFinite(seconds) || seconds <= 0 || line.slice(0, tab).trim() === "") continue;
    const day = dayOf(Math.trunc(seconds * 1000));
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
    const name = line.slice(tab + 1).trim() || t("server.repo.noName");
    byAuthor.set(name, (byAuthor.get(name) ?? 0) + 1);
  }
  const days = [...byDay].map(([day, commits]) => ({ day, commits })).toSorted((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const authors = [...byAuthor].map(([name, commits]) => ({ name, commits })).toSorted((a, b) => or(b.commits - a.commits, localeCompare(a.name, b.name)));
  return { days, authors };
}

export const secondsOf = (text: string) => {
  const n = Number(text.trim());
  return text.trim() === "" || !Number.isFinite(n) || n <= 0 ? 0 : Math.trunc(n * 1000);
};

/** Whether there is anything at path, a link included (which FileSystem's exists follows). */
export const lexists = (path: string) =>
  Effect.tryPromise({ try: () => lstat(path), catch: () => false }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

const skipDirs = new Set(["node_modules", ".git", ".venv", "vendor", "dist", "build", "target", ".next"]);

/** The repositories under dir, at most depth folders down; a repository's own folders are not looked into. */
const repoDirs = (dir: string, depth: number): Effect.Effect<string[]> =>
  Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({ try: () => readdir(dir, { withFileTypes: true }), catch: () => [] }).pipe(Effect.orElseSucceed(() => []));
    if (entries.some((e) => e.name === ".git")) return [dir];
    if (depth === 0) return [];
    const under = yield* Effect.forEach(
      entries.filter((e) => e.isDirectory() && !skipDirs.has(e.name)),
      (e) => repoDirs(join(dir, e.name), depth - 1),
      { concurrency: 8 },
    );
    return under.flat();
  });

export const contributionsOf = Effect.fn("Repo.contributions")(function* (root: string, extra: readonly string[]) {
  const global = (yield* gitQuiet("", "config", "--global", "user.email")).toLowerCase();
  const seen = new Set<string>();
  const out: T.Repo[] = [];
  for (const dir of yield* repoDirs(root, 3)) {
    // Worktrees share their repository's history: one count per repository.
    const common = yield* gitQuiet("", "-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
    if (common === "" || seen.has(common)) continue;
    seen.add(common);
    const mine = new Set([global, (yield* gitQuiet("", "-C", dir, "config", "user.email")).toLowerCase(), ...extra].filter((e) => e !== ""));
    const emails = (yield* gitQuiet("", "-C", dir, "log", "--all", "--format=%ae")).split("\n");
    const commits = emails.filter((e) => e !== "" && mine.has(e.toLowerCase())).length;
    out.push({
      path: (yield* gitQuiet("", "-C", dir, "rev-parse", "--show-toplevel")) || dir,
      commits,
    });
  }
  return out;
});
