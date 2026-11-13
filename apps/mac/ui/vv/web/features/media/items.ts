import { t } from "@vibevalley/i18n";
import type { LibraryFileKind, LibraryItem, LibraryOrigin, LibraryOriginKind, MediaJob, MediaUnderstandingJob } from "@vibevalley/protocol";

export type KindFilter = LibraryFileKind | "all";

export type Where =
  | { readonly by: "all" }
  | { readonly by: "origin"; readonly origin: LibraryOriginKind }
  | { readonly by: "channel"; readonly channel: string }
  | { readonly by: "agent"; readonly agent: string };

export const whereKey = (where: Where): string => {
  switch (where.by) {
    case "all":
      return "all";
    case "origin":
      return where.origin;
    case "channel":
      return `channel:${where.channel}`;
    case "agent":
      return `agent:${where.agent}`;
  }
};

export const kindOf = (type: string): LibraryFileKind =>
  type.startsWith("image/") ? "image" : type.startsWith("audio/") ? "audio" : type.startsWith("video/") ? "video" : "other";

const channelOf = (origin: LibraryOrigin) => (origin.kind === "uploaded" ? origin.channel : undefined);
const agentOf = (origin: LibraryOrigin) => (origin.kind === "fetched" ? origin.agent : undefined);

const isIn = (where: Where) => (item: LibraryItem) => {
  switch (where.by) {
    case "all":
      return true;
    case "origin":
      return item.origin.kind === where.origin;
    case "channel":
      return channelOf(item.origin) === where.channel;
    case "agent":
      return agentOf(item.origin) === where.agent;
  }
};

const isKind = (kind: KindFilter) => (item: LibraryItem) => kind === "all" || kindOf(item.attachment.type) === kind;

export const shown = (given: { readonly items: readonly LibraryItem[]; readonly where: Where; readonly kind: KindFilter }): LibraryItem[] =>
  given.items.filter((item) => isIn(given.where)(item) && isKind(given.kind)(item));

export interface Counts {
  readonly where: ReadonlyMap<string, number>;
  readonly kind: ReadonlyMap<KindFilter, number>;
  readonly channels: readonly string[];
  readonly agents: readonly string[];
}

/** Cross-filtered facet counts: each group applies the other group's active filter. */
export const countsOf = (given: { readonly items: readonly LibraryItem[]; readonly where: Where; readonly kind: KindFilter }): Counts => {
  const { items, where, kind } = given;
  const byWhere = new Map<string, number>();
  const byKind = new Map<KindFilter, number>();
  const channels: string[] = [];
  const agents: string[] = [];
  const bump = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const item of items) {
    const channel = channelOf(item.origin);
    const agent = agentOf(item.origin);
    if (channel !== undefined && !channels.includes(channel)) channels.push(channel);
    if (agent !== undefined && !agents.includes(agent)) agents.push(agent);
    if (isKind(kind)(item)) {
      bump(byWhere, "all");
      bump(byWhere, item.origin.kind);
      if (channel !== undefined) bump(byWhere, `channel:${channel}`);
      if (agent !== undefined) bump(byWhere, `agent:${agent}`);
    }
    if (isIn(where)(item)) {
      bump(byKind, "all");
      bump(byKind, kindOf(item.attachment.type));
    }
  }
  return { where: byWhere, kind: byKind, channels, agents };
};

/** Excludes understanding jobs, which produce no file. */
export const making = (jobs: readonly MediaJob[]): MediaJob[] =>
  jobs.filter((job) => job.kind !== "understanding" && (job.phase === "queued" || job.phase === "generating" || job.phase === "downloading"));

export interface Placed {
  readonly index: number;
  readonly x: number;
  readonly width: number;
  readonly height: number;
}

// Clamp extreme aspect ratios so a panorama or sliver does not claim an entire row.
const widest = 3;
const narrowest = 0.5;

const clamp = (r: number) => (Number.isFinite(r) && r > 0 ? Math.min(widest, Math.max(narrowest, r)) : 1);

/** `ratios` are width / height; the final incomplete row keeps `height` rather than stretching across `width`. */
export function justify(given: { readonly ratios: readonly number[]; readonly width: number; readonly height: number; readonly gap: number }): Placed[][] {
  const { ratios, width, height, gap } = given;
  if (width <= 0) return [];
  const rows: Placed[][] = [];
  let row: number[] = [];
  let sum = 0;
  const lay = (indices: readonly number[], h: number) => {
    const placed: Placed[] = [];
    let x = 0;
    for (const index of indices) {
      const w = clamp(ratios[index] ?? 1) * h;
      placed.push({ index, x, width: w, height: h });
      x += w + gap;
    }
    return placed;
  };
  for (let index = 0; index < ratios.length; index++) {
    row.push(index);
    sum += clamp(ratios[index] ?? 1);
    if (sum * height + gap * (row.length - 1) >= width) {
      rows.push(lay(row, (width - gap * (row.length - 1)) / sum));
      row = [];
      sum = 0;
    }
  }
  if (row.length > 0) rows.push(lay(row, height));
  return rows;
}

export function neighbor(given: {
  readonly rows: readonly Placed[][];
  readonly index: number;
  readonly key: "left" | "right" | "up" | "down";
}): number | undefined {
  const { rows, index, key } = given;
  let count = 0;
  let at = -1;
  let from: Placed | undefined;
  for (const [i, row] of rows.entries()) {
    count += row.length;
    for (const p of row)
      if (p.index === index) {
        at = i;
        from = p;
      }
  }
  if (key === "left") return index > 0 ? index - 1 : undefined;
  if (key === "right") return index < count - 1 ? index + 1 : undefined;
  const target = rows[at + (key === "up" ? -1 : 1)];
  if (from === undefined || target === undefined) return undefined;
  const middle = from.x + from.width / 2;
  let best: Placed | undefined;
  for (const p of target) if (best === undefined || Math.abs(p.x + p.width / 2 - middle) < Math.abs(best.x + best.width / 2 - middle)) best = p;
  return best?.index;
}

export const between = (given: { readonly ids: readonly string[]; readonly from: string; readonly to: string }): string[] => {
  const a = given.ids.indexOf(given.from);
  const b = given.ids.indexOf(given.to);
  if (b < 0) return [];
  if (a < 0) return [given.to];
  const out: string[] = [];
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(given.ids[i] ?? "");
  return out;
};

export const extOf = (name: string): string => {
  const found = /[^./][^/]*\.([^./]+)$/u.exec(name);
  return found?.[1] === undefined ? "" : found[1].toUpperCase();
};

const pad = (s: string) => s.padStart(2, "0");

export const durationText = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds));
  const two = (n: number) => pad(String(n));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
};

export interface Names {
  readonly agent: (id: string) => string;
  readonly channel: (id: string) => string;
}

const jobWord: Record<MediaJob["kind"], () => string> = {
  image: () => t("web.library.job.image"),
  speech: () => t("web.library.job.speech"),
  speakers: () => t("web.library.job.speakers"),
  voiceDesign: () => t("web.library.job.voiceDesign"),
  clone: () => t("web.library.job.clone"),
  transcription: () => t("web.library.job.transcription"),
  understanding: () => t("web.library.job.understanding"),
};

export const originLine =
  (names: Names) =>
  (origin: LibraryOrigin): string => {
    switch (origin.kind) {
      case "generated":
        return t("web.library.from.generated", { job: jobWord[origin.jobKind]() });
      case "uploaded":
        return origin.channel === undefined ? t("web.library.from.uploadedHere") : t("web.library.from.uploadedIn", { channel: names.channel(origin.channel) });
      case "fetched":
        return "url" in origin.from
          ? t("web.library.from.fetchedUrl", { agent: names.agent(origin.agent), url: origin.from.url })
          : t("web.library.from.fetchedPath", { agent: names.agent(origin.agent), path: origin.from.path });
    }
  };

const none = (): MediaUnderstandingJob | undefined => undefined;

export const understoodText =
  (attachment: string) =>
  (jobs: readonly MediaJob[]): string | undefined =>
    jobs.reduce(
      (newest, job) =>
        job.kind === "understanding" &&
        job.result !== null &&
        job.inputs.some((input) => input.hash === attachment) &&
        (newest === undefined || job.updatedAt > newest.updatedAt)
          ? job
          : newest,
      none(),
    )?.result?.text;
