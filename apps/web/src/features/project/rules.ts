// 项目 and its map: what a codebase grows
// (languages, the tilling calendar, growth by its newest commit), and every project as an island whose plots are its
// helpers' worktrees. The room on an island is roomLeft, the rule the server refuses a start by: an open plot is one
// more that may start now, a shut one waits for the farm to free up.

import { projectsWording } from "./words";
import { appWording } from "../../base/words";
import { type Crop, dayMs, type Issue, type LanguageCount, maxRunning, type PlotView, type ProjectSummary, type Session } from "@vibevalley/protocol";
import { isBusy, phaseText, roomLeft } from "@vibevalley/protocol/rules";
import type { Pose } from "../../ui/cast";

interface LangDef {
  readonly label: string;
  readonly color: string;
  readonly names: readonly string[];
}

export const langs: Record<string, LangDef> = {
  typescript: { label: "TypeScript", color: "#3178c6", names: ["typescript", "tsx", "ts"] },
  javascript: { label: "JavaScript", color: "#f1e05a", names: ["javascript", "jsx", "js", "mjs", "cjs"] },
  python: { label: "Python", color: "#3572a5", names: ["python", "py", "cython"] },
  go: { label: "Go", color: "#00add8", names: ["go", "golang"] },
  rust: { label: "Rust", color: "#dea584", names: ["rust", "rs"] },
  java: { label: "Java", color: "#b07219", names: ["java"] },
  kotlin: { label: "Kotlin", color: "#a97bff", names: ["kotlin", "kt"] },
  swift: { label: "Swift", color: "#f05138", names: ["swift"] },
  c: { label: "C", color: "#555555", names: ["c", "c header"] },
  cpp: { label: "C++", color: "#f34b7d", names: ["c++", "cpp", "c++ header"] },
  csharp: { label: "C#", color: "#178600", names: ["c#", "csharp", "cs"] },
  ruby: { label: "Ruby", color: "#701516", names: ["ruby", "rb"] },
  php: { label: "PHP", color: "#4f5d95", names: ["php", "hack"] },
  shell: { label: "Shell", color: "#89e051", names: ["shell", "bash", "zsh", "sh", "fish"] },
  html: { label: "HTML", color: "#e34c26", names: ["html"] },
  css: { label: "CSS", color: "#563d7c", names: ["css", "less"] },
  sql: { label: "SQL", color: "#e38c00", names: ["sql", "plpgsql", "tsql", "plsql"] },
  dart: { label: "Dart", color: "#00b4ab", names: ["dart"] },
  lua: { label: "Lua", color: "#000080", names: ["lua", "luau"] },
  scala: { label: "Scala", color: "#c22d40", names: ["scala"] },
  elixir: { label: "Elixir", color: "#6e4a7e", names: ["elixir", "ex"] },
  haskell: { label: "Haskell", color: "#5e5086", names: ["haskell", "hs"] },
  zig: { label: "Zig", color: "#ec915c", names: ["zig"] },
  r: { label: "R", color: "#198ce7", names: ["r", "rmarkdown"] },
  markdown: { label: "Markdown", color: "#083fa1", names: ["markdown", "md", "mdx"] },
  json: { label: "JSON", color: "#292929", names: ["json", "json with comments", "json5", "jsonc"] },
  yaml: { label: "YAML", color: "#cb171e", names: ["yaml", "yml"] },
  julia: { label: "Julia", color: "#a270ba", names: ["julia", "jl"] },
  vue: { label: "Vue", color: "#41b883", names: ["vue"] },
  svelte: { label: "Svelte", color: "#ff3e00", names: ["svelte"] },
  docker: { label: "Dockerfile", color: "#384d54", names: ["dockerfile", "docker"] },
  jupyter: { label: "Jupyter", color: "#da5b0b", names: ["jupyter notebooks", "jupyter notebook", "jupyter", "ipynb"] },
  sass: { label: "Sass", color: "#c6538c", names: ["scss", "sass"] },
  powershell: { label: "PowerShell", color: "#012456", names: ["powershell", "ps1"] },
  terraform: { label: "Terraform", color: "#844fba", names: ["hcl", "terraform", "tf"] },
  other: { label: projectsWording().project.otherLang, color: "#a08c70", names: [] },
};

const byName = new Map(Object.entries(langs).flatMap(([id, def]) => def.names.map((n) => [n, id] as const)));

export interface Language {
  readonly id: string;
  readonly label: string;
  readonly color: string;
}

function languageOf(name: string): Language {
  const id = byName.get(name.trim().toLowerCase()) ?? "other";
  const def = langs[id]!;
  return { id, label: id === "other" && name.trim() ? name.trim() : def.label, color: def.color };
}

export const langIcon = (id: string) => `lang-${id}`;

export interface LanguageShare extends Language {
  /** Prose in Markdown counts as comments. */
  readonly lines: number;
  readonly files: number;
  /** 0..1. */
  readonly share: number;
}

/** By label, aliases merged, most lines first; past `top`, the rest is one 其他 (one leftover keeps its name). */
export function languageShares(counts: readonly LanguageCount[], top: number | undefined = 7): LanguageShare[] {
  const merged = new Map<string, { language: Language; lines: number; files: number }>();
  for (const c of counts) {
    const language = languageOf(c.name);
    const e = merged.get(language.label);
    merged.set(language.label, { language, lines: (e?.lines ?? 0) + c.code + c.comments, files: (e?.files ?? 0) + c.files });
  }
  const all = [...merged.values()]
    .filter((e) => e.lines > 0)
    .sort((a, b) => b.lines - a.lines || (a.language.label < b.language.label ? -1 : a.language.label > b.language.label ? 1 : 0));
  const total = all.reduce((n, e) => n + e.lines, 0);
  const cut = top ?? all.length;
  const rest = all.length > cut ? all.slice(cut) : [];
  const kept = rest.length > 1 ? all.slice(0, cut) : all;
  const shares = kept.map((e) => ({ ...e.language, lines: e.lines, files: e.files, share: total > 0 ? e.lines / total : 0 }));
  if (rest.length <= 1) return shares;
  const lines = rest.reduce((n, e) => n + e.lines, 0);
  const other = langs.other!;
  return [
    ...shares,
    { id: "other", label: other.label, color: other.color, lines, files: rest.reduce((n, e) => n + e.files, 0), share: total > 0 ? lines / total : 0 },
  ];
}

const two = (n: number) => String(n).padStart(2, "0");

/** The server counts commits by the same day. */
const dayKey = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;

export interface CalendarDay {
  readonly day: string;
  readonly at: Date;
  readonly commits: number;
  /** 0 bare, 1 seeded, 2 sprouting, 3 leafy, 4 in flower. */
  readonly level: number;
  readonly future: boolean;
}

export interface Calendar {
  readonly weeks: readonly (readonly CalendarDay[])[];
  readonly months: readonly { readonly week: number; readonly label: string }[];
}

/** By the calendar: a day is not always 24 hours. */
const plusDays = (from: Date, offset: number) => new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset);

/** Monday first, the last column this week; levels go against the year's 95th percentile, so one huge day does not leave
 * the rest bare. */
export function calendarOf(days: readonly { day: string; commits: number }[], now: Date, weeks = 53): Calendar {
  const commits = new Map(days.map((d) => [d.day, Math.round(d.commits)]));
  const today = plusDays(now, 0);
  const weekday = (today.getDay() + 6) % 7;
  const start = plusDays(plusDays(today, -weekday), -(weeks - 1) * 7);
  const busyDays = [...commits.values()].filter((n) => n > 0).sort((a, b) => a - b);
  const q = busyDays.length === 0 ? 0 : busyDays[Math.min(busyDays.length - 1, Math.max(0, Math.floor(0.95 * busyDays.length)))]!;
  const busy = q < 1 ? 1 : q;
  const level = (n: number) => (n <= 0 ? 0 : Math.min(4, Math.max(0, Math.ceil((4 * n) / busy))));
  const grid: CalendarDay[][] = [];
  const months: { week: number; label: string }[] = [];
  for (let w = 0; w < weeks; w++) {
    const column: CalendarDay[] = [];
    for (let d = 0; d < 7; d++) {
      const at = plusDays(start, w * 7 + d);
      const day = dayKey(at);
      const n = commits.get(day) ?? 0;
      column.push({ day, at, commits: n, level: level(n), future: at > today });
      // A month's name over the week its first day is in; the first week names the month it shows.
      if ((at.getDate() === 1 || (w === 0 && d === 0)) && (months.length === 0 || months.at(-1)!.week !== w))
        months.push({ week: w, label: appWording().time.month(at.getMonth() + 1) });
    }
    grid.push(column);
  }
  // A first label crowded by the next month's is dropped.
  if (months.length > 1 && months[1]!.week - months[0]!.week < 3) months.shift();
  return { weeks: grid, months };
}

export interface Streaks {
  readonly total: number;
  readonly days: number;
  readonly longest: number;
  /** The current run goes to today, or to yesterday if none yet today. */
  readonly current: number;
  /** The latest, on a tie. */
  readonly busiest?: { readonly day: string; readonly commits: number };
}

export function streaksOf(calendar: Calendar): Streaks {
  const days = calendar.weeks.flat().filter((d) => !d.future);
  let longest = 0;
  let run = 0;
  let busiest: { day: string; commits: number } | undefined;
  for (const d of days) {
    run = d.commits > 0 ? run + 1 : 0;
    if (run > longest) longest = run;
    if (d.commits > 0 && d.commits >= (busiest?.commits ?? 0)) busiest = { day: d.day, commits: d.commits };
  }
  let current = 0;
  const last = days.at(-1);
  for (let i = days.length - 1 - (last && last.commits === 0 ? 1 : 0); i >= 0 && days[i]!.commits > 0; i--) current++;
  return { total: days.reduce((n, d) => n + d.commits, 0), days: days.filter((d) => d.commits > 0).length, longest, current, ...(busiest ? { busiest } : {}) };
}

export interface Growth {
  readonly crop: Crop;
  readonly label: string;
}

export function growthOf(last: number | undefined, now: number): Growth {
  if (last === undefined) return { crop: "empty", label: projectsWording().project.growth.empty };
  const days = (now - last) / dayMs;
  if (days <= 1) return { crop: "flowering", label: projectsWording().project.growth.flowering };
  if (days <= 7) return { crop: "leafy", label: projectsWording().project.growth.leafy };
  if (days <= 30) return { crop: "sprout", label: projectsWording().project.growth.sprout };
  if (days <= 90) return { crop: "dry", label: projectsWording().project.growth.dry };
  return { crop: "withered", label: projectsWording().project.growth.withered };
}

/** Only repository home URLs, never credentials, arbitrary git transports or command-line options. */
export function githubRepository(input: string): { name: string; url: string } | undefined {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/?$/.exec(input.trim());
  if (!m) return undefined;
  const name = m[2]!.replace(/\.git$/, "");
  if (!name || name === "." || name === "..") return undefined;
  return { name, url: `https://github.com/${m[1]}/${name}.git` };
}

/** Newest commit first, then by name. */
export const sortProjects = (list: readonly ProjectSummary[]) =>
  [...list].sort((a, b) => (b.last ?? 0) - (a.last ?? 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

export function since(at: number, now: number) {
  const minutes = Math.max(0, (now - at) / 60000);
  if (minutes < 2) return appWording().time.justNow;
  if (minutes < 60) return appWording().time.minutesAgo(Math.round(minutes));
  const hours = minutes / 60;
  if (hours < 24) return appWording().time.hoursAgo(Math.round(hours));
  const days = hours / 24;
  if (days < 45) return appWording().time.daysAgo(Math.round(days));
  if (days < 365) return appWording().time.monthsAgo(Math.round(days / 30));
  return appWording().time.yearsAgo((days / 365).toFixed(1));
}

export const dateText = (at: number) => {
  const d = new Date(Math.round(at));
  return appWording().time.date(d.getFullYear(), d.getMonth() + 1, d.getDate());
};

export const dayText = (d: Date) => appWording().time.day(d.getMonth() + 1, d.getDate(), appWording().time.weekdays[d.getDay()]!);

/** As toLocaleString('zh-CN') writes it: 「12,345」. */
export const number = (n: number) => (n < 0 ? "-" : "") + String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export const percent = (share: number) => (share >= 0.1 ? `${Math.round(share * 100)}%` : `${(share * 100).toFixed(1)}%`);

export type Spot = { readonly kind: "taken"; readonly session: Session; readonly plot: PlotView } | { readonly kind: "open" } | { readonly kind: "shut" };

export interface Island {
  readonly project: string;
  /** Undefined for a project the list does not have (any more) that helpers are still in. */
  readonly summary?: ProjectSummary;
  readonly spots: readonly Spot[];
  readonly working: number;
  readonly maxSessions: number;
  readonly queued: readonly Issue[];
}

export const openOf = (i: Island) => i.spots.filter((s) => s.kind === "open").length;
const isFull = (i: Island) => i.working >= i.maxSessions;

/** The project's todos waiting for room, first queued first: the sacks at its gate. */
const queuedIn = (issues: readonly Issue[], project: string) =>
  issues.filter((i) => i.project === project && i.status === "todo" && i.queuedAt !== undefined).sort((a, b) => a.queuedAt! - b.queuedAt!);

/** Peopled or waited on first, then the newest commit, then by name. */
export function islandsOf({
  projects,
  sessions,
  plots,
  issues,
}: {
  projects: readonly ProjectSummary[];
  sessions: readonly Session[];
  plots: Readonly<Record<string, PlotView>>;
  issues: readonly Issue[];
}): Island[] {
  const known = new Map(projects.map((p) => [p.name, p]));
  const names = new Set([...known.keys(), ...sessions.flatMap((h) => (h.project ? [h.project] : []))]);
  const islands = [...names].map((name) => {
    const summary = known.get(name);
    const mine = sessions.filter((h) => h.project === name).sort((a, b) => a.hiredAt - b.hiredAt);
    const working = mine.filter(isBusy).length;
    // A project the list does not have takes no more work: only its helpers show.
    const maxSessions = summary ? Math.round(summary.maxSessions) : working;
    const left = roomLeft(sessions, name, maxRunning, maxSessions);
    // No more plots are drawn than the farm has places.
    const room = Math.max(0, Math.min(maxSessions > 0 ? left.project : 0, maxRunning - mine.length));
    const open = Math.min(room, left.farm);
    const spots: Spot[] = [
      ...mine.map((h): Spot => ({ kind: "taken", session: h, plot: plots[h.id] ?? { crop: "seeded" } })),
      ...Array.from({ length: open }, (): Spot => ({ kind: "open" })),
      ...Array.from({ length: room - open }, (): Spot => ({ kind: "shut" })),
    ];
    return { project: name, ...(summary ? { summary } : {}), spots, working, maxSessions, queued: queuedIn(issues, name) };
  });
  const quiet = (i: Island) => (i.spots.some((s) => s.kind === "taken") || i.queued.length > 0 ? 0 : 1);
  return islands.sort(
    (a, b) => quiet(a) - quiet(b) || (b.summary?.last ?? 0) - (a.summary?.last ?? 0) || (a.project < b.project ? -1 : a.project > b.project ? 1 : 0),
  );
}

export const homeless = (sessions: readonly Session[]) => sessions.filter((h) => h.project === undefined);

export const mapTally = (islands: readonly Island[]) => ({
  peopled: islands.filter((i) => i.spots.some((s) => s.kind === "taken")).length,
  working: islands.reduce((n, i) => n + i.working, 0),
  queued: islands.reduce((n, i) => n + i.queued.length, 0),
});

/** The farm's plot size (village/world plotW, plotH) and how the yard's rows are spaced. */
const plotW = 34;
const plotH = 26;
const head = 15;
const rowPitch = 36;
const maxColPitch = 54;

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Rows of three at most from the back, as even as they go (four is two and two), each row and the whole block centred:
 * each plot's foot. */
export function plotsIn(yard: Rect, n: number): { x: number; y: number }[] {
  if (n <= 0) return [];
  const rows = Math.ceil(n / 3);
  const perRow = Math.ceil(n / rows);
  const pitch = perRow === 1 ? 0 : Math.min(maxColPitch, (yard.width - plotW - 8) / (perRow - 1));
  const block = head + plotH + (rows - 1) * rowPitch;
  const cx = yard.left + yard.width / 2;
  const firstBottom = yard.top + yard.height / 2 - block / 2 + head + plotH;
  return Array.from({ length: n }, (_, i) => {
    const row = Math.floor(i / perRow);
    const inRow = Math.min(perRow, n - row * perRow);
    return { x: cx + ((i % perRow) - (inRow - 1) / 2) * pitch, y: firstBottom + row * rowPitch };
  });
}

/** Where a helper stands from its plot's foot. */
export const sessionInPlot = { x: 0, y: -10 };

const handedBack = (h: Session) => h.phase._tag === "done" || h.phase._tag === "resting";

export function mapPose(h: Session): Pose {
  if ((handedBack(h) && h.conflict) || h.phase._tag === "failed") return "worry";
  switch (h.phase._tag) {
    case "working":
      return h.phase.doing.action === "thinking" || h.phase.doing.action === "speaking_text" ? "think" : "work";
    case "done":
      return "cheer";
    default:
      return "idle";
  }
}

export function spotText(spot: Spot, now: number) {
  switch (spot.kind) {
    case "taken":
      return `${spot.session.name} · ${phaseText(spot.session, now)}${spot.session.branch ? projectsWording().project.branch(spot.session.branch) : ""}`;
    case "open":
      return projectsWording().project.open;
    case "shut":
      return projectsWording().project.shut(maxRunning);
  }
}

export const islandText = (i: Island) =>
  [
    !i.summary ? projectsWording().project.gone : projectsWording().project.working(i.working, i.maxSessions, isFull(i)),
    ...(i.queued.length > 0 ? [projectsWording().project.queued(i.queued.length)] : []),
  ].join(" · ");

/** Twice as big two to a row, smaller to fit two, one to a row on a narrow page. */
export function islandScale(width: number, cell: number, gap: number) {
  for (const s of [2, 1.5]) if (2 * cell * s + gap <= width) return s;
  const one = width / cell;
  return one >= 1.5 ? Math.min(2.5, Math.floor(one * 2) / 2) : one;
}

export const islandLooks = ["island-meadow", "island-orchard", "island-pond", "island-pines", "island-windmill", "island-lavender"];

/** The same one every time, from its name. */
export function islandLook(project: string) {
  let h = 0;
  for (const c of project) h = (h * 31 + c.codePointAt(0)!) & 0x7fffffff;
  return islandLooks[h % islandLooks.length]!;
}
