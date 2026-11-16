import { t } from "@vibevalley/i18n";
import {
  type Artifact,
  type ArtifactBody,
  type ArtifactDisplay,
  type LibraryFileKind,
  type LibraryItem,
  type LibraryOrigin,
  type LibraryOriginKind,
  type LibrarySort,
  type MediaJob,
  type MediaUnderstandingJob,
  userId,
} from "@vibevalley/protocol";

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

const pushUnique = (list: string[], value: string | undefined) => {
  if (value !== undefined && !list.includes(value)) list.push(value);
};

const artifactAgentOf = (a: Artifact): string | undefined => (a.by !== userId && a.by !== "system" && a.by !== "" ? a.by : undefined);

const isArtifactIn =
  (where: Where) =>
  (a: Artifact): boolean => {
    switch (where.by) {
      case "all":
        return true;
      case "origin":
        if (where.origin === "generated") return artifactAgentOf(a) !== undefined;
        if (where.origin === "uploaded") return a.by === userId;
        return false;
      case "channel":
        return a.channel === where.channel;
      case "agent":
        return artifactAgentOf(a) === where.agent;
    }
  };

const artifactMatchesSearch = (a: Artifact, search: string): boolean => {
  const q = search.trim().toLowerCase();
  return !q || a.title.toLowerCase().includes(q) || a.byName.toLowerCase().includes(q);
};

export interface Counts {
  readonly where: ReadonlyMap<string, number>;
  readonly kind: ReadonlyMap<KindFilter, number>;
  readonly channels: readonly string[];
  readonly agents: readonly string[];
}

/** Cross-filtered facet counts: each group applies the other group's active filter. */
export const countsOf = (given: {
  readonly items: readonly LibraryItem[];
  readonly artifacts?: readonly Artifact[] | undefined;
  readonly where: Where;
  readonly kind: KindFilter;
  readonly artifactKind?: ArtifactKindFilter | undefined;
  readonly search?: string | undefined;
}): Counts => {
  const { items, where, kind, artifactKind } = given;
  const search = given.search ?? "";
  const byWhere = new Map<string, number>();
  const byKind = new Map<KindFilter, number>();
  const channels: string[] = [];
  const agents: string[] = [];
  const bump = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1);
  const recordWhere = (origin: LibraryOriginKind, channel: string | undefined, agent: string | undefined) => {
    bump(byWhere, "all");
    bump(byWhere, origin);
    if (channel !== undefined) bump(byWhere, `channel:${channel}`);
    if (agent !== undefined) bump(byWhere, `agent:${agent}`);
  };
  for (const item of items) {
    const channel = channelOf(item.origin);
    const agent = agentOf(item.origin);
    pushUnique(channels, channel);
    pushUnique(agents, agent);
    if (artifactKind === undefined && isKind(kind)(item)) recordWhere(item.origin.kind, channel, agent);
    if (isIn(where)(item)) {
      bump(byKind, "all");
      bump(byKind, kindOf(item.attachment.type));
    }
  }
  const inWhere = isArtifactIn(where);
  for (const artifact of given.artifacts ?? []) {
    if (!artifactMatchesSearch(artifact, search)) continue;
    const agent = artifactAgentOf(artifact);
    pushUnique(channels, artifact.channel);
    pushUnique(agents, agent);
    const matchesRight = artifactKind !== undefined ? artifactMatchesKind(artifact, artifactKind) : kind === "all";
    if (matchesRight) recordWhere(agent !== undefined ? "generated" : "uploaded", artifact.channel, agent);
    if (inWhere(artifact)) bump(byKind, "all");
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

export type ArtifactKindFilter = "all" | "canvas" | "slides" | "dashboard" | "whiteboard" | "page";

export const artifactFilterKinds: readonly Exclude<ArtifactKindFilter, "all">[] = ["canvas", "slides", "dashboard", "whiteboard", "page"];

const artifactMatchesKind = (a: { readonly body: ArtifactBody; readonly display?: ArtifactDisplay | undefined }, kind: ArtifactKindFilter): boolean => {
  if (kind === "all") return true;
  if (kind === "page") return a.body === "blocks" || (a.display ?? "page") === "page" || a.display === "motion";
  return a.body === "html" && a.display === kind;
};

export const shownArtifacts = (
  all: readonly Artifact[],
  filter: {
    readonly where?: Where | undefined;
    readonly artifactKind?: ArtifactKindFilter | undefined;
    readonly search: string;
    readonly sort: LibrarySort;
  },
): Artifact[] => {
  const kind = filter.artifactKind ?? "all";
  const inWhere = isArtifactIn(filter.where ?? { by: "all" });
  const filtered = all.filter((a) => inWhere(a) && artifactMatchesKind(a, kind) && artifactMatchesSearch(a, filter.search));
  if (filter.sort === "name") return filtered.toSorted((a, b) => a.title.localeCompare(b.title));
  return filtered.toSorted((a, b) => b.updated - a.updated);
};

export interface ArtifactCounts {
  readonly all: number;
  readonly byKind: Record<Exclude<ArtifactKindFilter, "all">, number>;
}

export const artifactCountsOf = (
  all: readonly Artifact[],
  filter?: { readonly where?: Where | undefined; readonly search?: string | undefined },
): ArtifactCounts => {
  const inWhere = isArtifactIn(filter?.where ?? { by: "all" });
  const q = filter?.search ?? "";
  const scoped = all.filter((a) => inWhere(a) && artifactMatchesSearch(a, q));
  return {
    all: scoped.length,
    byKind: {
      canvas: scoped.filter((a) => artifactMatchesKind(a, "canvas")).length,
      slides: scoped.filter((a) => artifactMatchesKind(a, "slides")).length,
      dashboard: scoped.filter((a) => artifactMatchesKind(a, "dashboard")).length,
      whiteboard: scoped.filter((a) => artifactMatchesKind(a, "whiteboard")).length,
      page: scoped.filter((a) => artifactMatchesKind(a, "page")).length,
    },
  };
};
