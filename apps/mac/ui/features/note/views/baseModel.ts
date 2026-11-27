import { t } from "@vibevalley/i18n";
import type { BaseCellValue, BaseColumn, BaseColumnKind, BaseRow, BaseSelectOption, BaseSummaryOp, Note } from "@vibevalley/protocol";
import { issueId, noteId } from "@vibevalley/protocol/schema";

import type { IconName } from "../../../design/icons";

export interface OptionToneLook {
  readonly bgClass: string;
  readonly textClass: string;
  readonly mixToken?: string;
}

const OPTION_TONES: Readonly<Record<string, OptionToneLook>> = {
  green: { bgClass: "bg-ok-soft", textClass: "text-ok-ink" },
  leaf: { bgClass: "bg-ok-soft", textClass: "text-ok-ink" },
  ok: { bgClass: "bg-ok-soft", textClass: "text-ok-ink" },
  amber: { bgClass: "bg-warn-soft", textClass: "text-warn-ink" },
  wheat: { bgClass: "bg-warn-soft", textClass: "text-warn-ink" },
  yellow: { bgClass: "bg-warn-soft", textClass: "text-warn-ink" },
  warn: { bgClass: "bg-warn-soft", textClass: "text-warn-ink" },
  red: { bgClass: "bg-bad-soft", textClass: "text-berry" },
  berry: { bgClass: "bg-bad-soft", textClass: "text-berry" },
  bad: { bgClass: "bg-bad-soft", textClass: "text-berry" },
  blue: { bgClass: "", textClass: "text-water", mixToken: "water" },
  water: { bgClass: "", textClass: "text-water", mixToken: "water" },
  info: { bgClass: "", textClass: "text-water", mixToken: "water" },
  stone: { bgClass: "bg-hover", textClass: "text-muted" },
  gray: { bgClass: "bg-hover", textClass: "text-muted" },
  muted: { bgClass: "bg-hover", textClass: "text-muted" },
};

export function optionToneLook(color: string | undefined): OptionToneLook {
  if (!color) return { bgClass: "bg-hover", textClass: "text-ink" };
  return OPTION_TONES[color.toLowerCase()] ?? { bgClass: "bg-hover", textClass: "text-ink" };
}

export function columnKindIcon(kind: BaseColumnKind): IconName {
  switch (kind) {
    case "text":
      return "edit";
    case "number":
      return "spend";
    case "select":
      return "choose";
    case "multiSelect":
      return "filter";
    case "date":
      return "calendar";
    case "checkbox":
      return "ticked";
    case "media":
      return "image";
    case "issueRef":
      return "issues";
    case "agentRef":
      return "agents";
    case "noteRef":
      return "notes";
    case "formula":
      return "bolt";
    case "agentAction":
      return "play";
  }
}

export function formatBaseNumber(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n - Math.round(n)) < 1e-9 && Math.abs(n) < 1e15) {
    return String(Math.round(n));
  }
  return n.toFixed(4).replace(/\.?0+$/u, "");
}

export function formatSummaryValue(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "—") return "—";
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return trimmed;
  if (Math.abs(parsed - Math.round(parsed)) < 1e-9 && Math.abs(parsed) < 1e15) {
    return String(Math.round(parsed));
  }
  return parsed.toFixed(2).replace(/\.?0+$/u, "");
}

export function summaryOpLabel(op: BaseSummaryOp): string {
  switch (op) {
    case "count":
      return t("web.note.base.summary.count");
    case "sum":
      return t("web.note.base.summary.sum");
    case "avg":
      return t("web.note.base.summary.avg");
    case "min":
      return t("web.note.base.summary.min");
    case "max":
      return t("web.note.base.summary.max");
  }
}

export function columnWidthPx(col: BaseColumn): number {
  if (typeof col.width === "number" && Number.isFinite(col.width) && col.width > 0) {
    return Math.max(96, Math.min(420, Math.round(col.width)));
  }
  switch (col.kind) {
    case "checkbox":
      return 88;
    case "number":
      return 104;
    case "select":
      return 128;
    case "date":
      return 136;
    case "formula":
      return 140;
    case "multiSelect":
      return 160;
    case "agentRef":
      return 156;
    case "media":
      return 156;
    case "noteRef":
    case "issueRef":
      return 196;
    case "agentAction":
      return 200;
    case "text":
      return 220;
  }
}

export function cleanWikilinkText(raw: string, notesById?: ReadonlyMap<string, Note>): string {
  return raw
    .replace(/!?\[\[note:([^|\]]+)\|([^\]]+)\]\]/gu, (_, _id: string, label: string) => label.trim())
    .replace(/!?\[\[note:([^\]]+)\]\]/gu, (_, id: string) => notesById?.get(id.trim())?.title ?? "")
    .replace(/!?\[\[issue:([^|\]]+)\|([^\]]+)\]\]/gu, (_, _id: string, label: string) => label.trim())
    .replace(/!?\[\[issue:([^\]]+)\]\]/gu, (_, id: string) => `#${id.trim()}`)
    .replace(/\s{2,}/gu, " ")
    .trim();
}

export function baseCellAsText(cell: BaseCellValue | undefined): string {
  if (!cell) return "";
  switch (cell._tag) {
    case "text":
      return cell.value;
    case "number":
      return formatBaseNumber(cell.value);
    case "bool":
      return cell.value ? "true" : "false";
    case "strings":
      return cell.items.join(", ");
    case "issueRef":
      return cell.issueId;
    case "noteRef":
      return cell.noteId;
    case "agentRef":
      return cell.agentId;
    case "agentRun":
      return cell.summary ?? cell.status;
  }
}

export function baseCellAsNumber(cell: BaseCellValue | undefined): number {
  if (!cell) return 0;
  switch (cell._tag) {
    case "number":
      return cell.value;
    case "text": {
      const parsed = Number(cell.value.trim());
      return Number.isFinite(parsed) ? parsed : 0;
    }
    case "bool":
      return cell.value ? 1 : 0;
    case "strings":
    case "issueRef":
    case "noteRef":
    case "agentRef":
    case "agentRun":
      return 0;
  }
}

export function baseCellAsBool(cell: BaseCellValue | undefined): boolean {
  if (!cell) return false;
  switch (cell._tag) {
    case "bool":
      return cell.value;
    case "text":
      return cell.value.trim().toLowerCase() === "true";
    case "number":
      return cell.value !== 0;
    case "strings":
    case "issueRef":
    case "noteRef":
    case "agentRef":
    case "agentRun":
      return false;
  }
}

export function baseCellAsStrings(cell: BaseCellValue | undefined): string[] {
  if (!cell) return [];
  switch (cell._tag) {
    case "strings":
      return [...cell.items];
    case "text":
      return cell.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    case "number":
    case "bool":
    case "issueRef":
    case "noteRef":
    case "agentRef":
    case "agentRun":
      return [];
  }
}

export function defaultCellForColumn(col: BaseColumn): BaseCellValue {
  switch (col.kind) {
    case "text":
    case "date":
    case "media":
    case "formula":
      return { _tag: "text", value: "" };
    case "select":
      return { _tag: "text", value: col.options?.[0]?.value ?? "" };
    case "number":
      return { _tag: "number", value: 0 };
    case "checkbox":
      return { _tag: "bool", value: false };
    case "multiSelect":
      return { _tag: "strings", items: [] };
    case "issueRef":
      return { _tag: "issueRef", issueId: issueId("") };
    case "noteRef":
      return { _tag: "noteRef", noteId: noteId("") };
    case "agentRef":
      return { _tag: "agentRef", agentId: "" };
    case "agentAction":
      return { _tag: "agentRun", status: "idle", updatedAt: Date.now() };
  }
}

export function findSelectOption(col: BaseColumn, value: string): BaseSelectOption | undefined {
  return col.options?.find((opt) => opt.value === value);
}

export function rowTitleOf(row: BaseRow, columns: readonly BaseColumn[]): string {
  const titleCol =
    columns.find((c) => c.kind === "text" && /title|name/iu.test(c.id)) ??
    columns.find((c) => c.kind === "text" && /title|name/iu.test(c.name)) ??
    columns.find((c) => c.kind === "text");
  if (titleCol) {
    const val = baseCellAsText(row.cells[titleCol.id]).trim();
    if (val) return val;
  }
  return row.id;
}

export function firstMediaOfRow(row: BaseRow, columns: readonly BaseColumn[], notesById: ReadonlyMap<string, Note>): string | undefined {
  for (const col of columns) {
    if (col.kind !== "media") continue;
    const cell = row.cells[col.id];
    if (cell === undefined) continue;
    if (cell._tag === "text" && cell.value.trim() !== "") return cell.value.trim();
    if (cell._tag === "strings" && cell.items[0]) return cell.items[0];
  }
  if (row.pageNoteId) {
    const coverPath = notesById.get(row.pageNoteId)?.cover?.path;
    if (coverPath) return coverPath;
  }
  return undefined;
}

export interface TimelineBarItem {
  readonly row: BaseRow;
  readonly title: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly dateLabel: string;
  readonly leftPct: number;
  readonly widthPct: number;
}

export interface TimelineProjection {
  readonly dateColumnId: string | undefined;
  readonly minMs: number;
  readonly maxMs: number;
  readonly ticks: readonly { readonly key: string; readonly label: string; readonly leftPct: number }[];
  readonly bars: readonly TimelineBarItem[];
}

const DAY_MS = 86_400_000;

function parseIsoDayMs(raw: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/u.exec(raw.trim());
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return Date.UTC(year, month - 1, day);
}

function formatShortUtcDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

export function projectBaseTimeline(rows: readonly BaseRow[], columns: readonly BaseColumn[], scale: "week" | "month"): TimelineProjection {
  const dateCol = columns.find((c) => c.kind === "date");
  const rawSpans = rows.map((row) => {
    const title = rowTitleOf(row, columns);
    const rawDate = dateCol ? baseCellAsText(row.cells[dateCol.id]).trim() : "";
    let startMs: number | undefined;
    let endMs: number | undefined;
    if (rawDate) {
      const parts = rawDate.split(/\s*(?:->|to|\/|\.\.)\s*/iu);
      startMs = parseIsoDayMs(parts[0] ?? rawDate);
      endMs = parts[1] ? parseIsoDayMs(parts[1]) : startMs;
    }
    const fallbackStart = row.createdAt > 0 ? row.createdAt : Date.UTC(2026, 0, 1);
    const s = startMs ?? fallbackStart;
    const e = Math.max(s + DAY_MS, (endMs ?? s) + DAY_MS);
    return {
      row,
      title,
      startMs: s,
      endMs: e,
      dateLabel: rawDate || formatShortUtcDate(s),
    };
  });

  if (rawSpans.length === 0) {
    return { dateColumnId: dateCol?.id, minMs: 0, maxMs: DAY_MS * 7, ticks: [], bars: [] };
  }

  const minMs = Math.min(...rawSpans.map((s) => s.startMs));
  const rawMax = Math.max(...rawSpans.map((s) => s.endMs));
  const minWindow = scale === "week" ? DAY_MS * 7 : DAY_MS * 28;
  const spanMs = Math.max(minWindow, rawMax - minMs);
  const maxMs = minMs + spanMs;

  const tickCount = scale === "week" ? 7 : 4;
  const ticks = Array.from({ length: tickCount }, (_, i) => {
    const tMs = minMs + (spanMs * i) / tickCount;
    return {
      key: `tick-${i}`,
      label: formatShortUtcDate(tMs),
      leftPct: (i / tickCount) * 100,
    };
  });

  const bars: TimelineBarItem[] = rawSpans.map((s) => {
    const leftPct = Math.max(0, Math.min(96, ((s.startMs - minMs) / spanMs) * 100));
    const widthPct = Math.max(4, Math.min(100 - leftPct, ((s.endMs - s.startMs) / spanMs) * 100));
    return {
      row: s.row,
      title: s.title,
      startMs: s.startMs,
      endMs: s.endMs,
      dateLabel: s.dateLabel,
      leftPct,
      widthPct,
    };
  });

  return {
    dateColumnId: dateCol?.id,
    minMs,
    maxMs,
    ticks,
    bars,
  };
}
