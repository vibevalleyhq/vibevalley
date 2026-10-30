import { drift, type Escapes, escapeKinds, type Hotspot } from "./readings.ts";

export interface ReportInput {
  readonly now: number;
  readonly days: number;
  /** Whether history reaches back over the window before: without it, there is nothing to compare with. */
  readonly compared: boolean;
  readonly hot: readonly Hotspot[];
  readonly hotByDesign: Readonly<Record<string, string>>;
  readonly escapes: Readonly<Record<string, Escapes>>;
  readonly kept: Readonly<Record<string, Escapes>>;
}

const shown = 10;

/** The report as Markdown: the hotspots to look at first, then the escapes by area against the ratchet. */
export function report({ now, days, compared, hot, hotByDesign, escapes, kept }: ReportInput): string {
  const trend = (h: Hotspot) => (!compared ? "" : h.changes > h.before ? ` ↑ (${h.before})` : h.changes < h.before ? ` ↓ (${h.before})` : " →");
  const row = (h: Hotspot) => `| \`${h.path}\` | ${h.changes}${trend(h)} | ${h.lines} | ${h.score} |`;
  const head = [`| File | Changes${compared ? " (before)" : ""} | Lines | Score |`, "|---|---|---|---|"];
  const looked = hot.filter((h) => !(h.path in hotByDesign)).slice(0, shown);
  const byDesign = hot.filter((h) => h.path in hotByDesign);
  const off = drift(kept, escapes);
  const total = (k: (typeof escapeKinds)[number]) => Object.values(escapes).reduce((n, e) => n + e[k], 0);
  return [
    `# Health at ${new Date(now).toISOString().slice(0, 10)}`,
    "",
    compared
      ? `## Hotspots: the last ${days} days against the ${days} before`
      : `## Hotspots: the last ${days} days (history is too short to compare with the ${days} before)`,
    "",
    ...head,
    ...looked.map(row),
    "",
    ...(byDesign.length > 0
      ? ["Hot by design:", "", ...byDesign.map((h) => `- \`${h.path}\`: ${h.changes} changes, ${h.lines} lines. ${hotByDesign[h.path]}`), ""]
      : []),
    `## Escapes: ${escapeKinds.map((k) => `${total(k)} ${k}`).join(", ")}`,
    "",
    "| Area | " + escapeKinds.join(" | ") + " |",
    "|---|" + escapeKinds.map(() => "---|").join(""),
    ...Object.entries(escapes).map(([area, e]) => `| ${area} | ${escapeKinds.map((k) => e[k]).join(" | ")} |`),
    "",
    off.length > 0 ? `Off the ratchet: ${off.map((d) => `${d.area} ${d.kind} ${d.kept} → ${d.now}`).join("; ")}` : "On the ratchet.",
  ].join("\n");
}
