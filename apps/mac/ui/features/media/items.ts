import { t } from "@vibevalley/i18n";
import {
  type Artifact,
  type ArtifactBody,
  type ArtifactDisplay,
  type ArtifactType,
  type LibraryFileKind,
  type LibraryItem,
  type LibraryOrigin,
  type LibrarySort,
  type MediaJob,
  type MediaSummary,
  type MediaUnderstandingJob,
  type PkmPageSummary,
  userId,
} from "@vibevalley/protocol";

import { type ArtifactFacet, artifactFacetOf, mediaKindOf } from "../content/navigation";

export type SourceFilter = "all" | "agent" | "user";
export const sourceFilters: readonly SourceFilter[] = ["all", "agent", "user"];

export type ArtifactTypeFilter = ArtifactFacet;

export const kindOf = mediaKindOf;

const isMediaFromSource = (item: LibraryItem, source: SourceFilter): boolean => {
  switch (source) {
    case "all":
      return true;
    case "agent":
      return item.origin.kind === "generated" || item.origin.kind === "fetched";
    case "user":
      return item.origin.kind === "uploaded";
  }
};

const isArtifactFromSource = (artifact: Artifact, source: SourceFilter): boolean => {
  switch (source) {
    case "all":
      return true;
    case "agent":
      return artifact.by !== userId;
    case "user":
      return artifact.by === userId;
  }
};

const isNoteFromSource = (source: SourceFilter): boolean => {
  switch (source) {
    case "all":
    case "user":
      return true;
    case "agent":
      return false;
  }
};

export const artifactMatchesType = (
  a: { readonly body: ArtifactBody; readonly display?: ArtifactDisplay | undefined; readonly artifactType?: ArtifactType | undefined },
  type: ArtifactTypeFilter | undefined,
): boolean => type === undefined || artifactFacetOf(a) === type;

export const shownNotes = (
  pages: readonly PkmPageSummary[],
  filter: {
    readonly source: SourceFilter;
    readonly sort: LibrarySort;
    readonly pinnedOnly?: boolean | undefined;
    readonly pinned?: ReadonlySet<string> | undefined;
  },
): PkmPageSummary[] => {
  if (!isNoteFromSource(filter.source)) return [];
  const filtered = filter.pinnedOnly === true ? pages.filter((p) => filter.pinned?.has(`note:${p.slug}`) === true) : [...pages];
  if (filter.sort === "name") return filtered.toSorted((a, b) => a.title.localeCompare(b.title));
  return filtered.toSorted((a, b) => b.updated - a.updated);
};

export const shownArtifacts = (
  all: readonly Artifact[],
  filter: {
    readonly source: SourceFilter;
    readonly artifactType?: ArtifactTypeFilter | undefined;
    readonly sort: LibrarySort;
    readonly pinnedOnly?: boolean | undefined;
    readonly pinned?: ReadonlySet<string> | undefined;
  },
): Artifact[] => {
  const filtered = all.filter(
    (a) =>
      isArtifactFromSource(a, filter.source) &&
      artifactMatchesType(a, filter.artifactType) &&
      (filter.pinnedOnly !== true || filter.pinned?.has(`artifact:${a.id}`) === true),
  );
  if (filter.sort === "name") return filtered.toSorted((a, b) => a.title.localeCompare(b.title));
  return filtered.toSorted((a, b) => b.updated - a.updated);
};

export const shownMedia = (
  items: readonly LibraryItem[],
  filter: {
    readonly source: SourceFilter;
    readonly fileKind?: LibraryFileKind | undefined;
    readonly pinnedOnly?: boolean | undefined;
    readonly pinned?: ReadonlySet<string> | undefined;
  },
): LibraryItem[] =>
  items.filter(
    (item) =>
      isMediaFromSource(item, filter.source) &&
      (filter.fileKind === undefined || kindOf(item.attachment.type) === filter.fileKind) &&
      (filter.pinnedOnly !== true || filter.pinned?.has(`media:${item.attachment.id}`) === true),
  );

/** Excludes understanding jobs, which produce no file; consumes Rust `MediaSummary.activeIds` when present. */
export const making = (jobs: readonly MediaJob[], summary?: MediaSummary): MediaJob[] => {
  if (summary !== undefined) {
    if (summary.activeCount <= 0 || summary.activeIds.length === 0) return [];
    const byId = new Map(jobs.map((job) => [job.id, job]));
    return summary.activeIds.flatMap((id) => {
      const job = byId.get(id);
      return job !== undefined ? [job] : [];
    });
  }
  return jobs.filter((job) => job.kind !== "understanding" && (job.phase === "queued" || job.phase === "generating" || job.phase === "downloading"));
};

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
