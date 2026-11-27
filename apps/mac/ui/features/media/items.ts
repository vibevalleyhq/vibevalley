import { t } from "@vibevalley/i18n";
import {
  type Artifact,
  type ArtifactType,
  type Channel,
  type Issue,
  type LibraryFileKind,
  type LibraryItem,
  type LibraryOrigin,
  type LibrarySort,
  type MediaJob,
  type MediaSummary,
  type MediaUnderstandingJob,
  type Session,
} from "@vibevalley/protocol";
import { sessionChannelId, sessionIssueId, sessionRepo } from "@vibevalley/protocol/rules";

import { type ArtifactFacet, artifactFacetOf, mediaKindOf } from "../../infra/state/contentNav";

export type ArtifactTypeFilter = ArtifactFacet;

export interface ContentContextLookup {
  readonly issuesById: ReadonlyMap<string, Pick<Issue, "id" | "number" | "title" | "repo" | "parent">>;
  readonly channelsById: ReadonlyMap<string, Pick<Channel, "id" | "name" | "title" | "repo">>;
  readonly sessionsById: ReadonlyMap<string, Pick<Session, "id" | "bindings" | "policy">>;
  readonly jobsById: ReadonlyMap<string, Pick<MediaJob, "id" | "source">>;
}

export interface ContentItemContext {
  readonly repo?: string | undefined;
  readonly issueId?: string | undefined;
  readonly channelId?: string | undefined;
}

export interface ContentCategoryFilter {
  readonly repo?: string | undefined;
  readonly issueId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly origin?: LibraryOrigin["kind"] | undefined;
}

export interface CategorySelectOption {
  readonly value: string;
  readonly label: string;
}

export interface ContentCategoryOptions {
  readonly repos: readonly CategorySelectOption[];
  readonly issues: readonly CategorySelectOption[];
  readonly channels: readonly CategorySelectOption[];
}

export const emptyCategoryFilter: ContentCategoryFilter = {};

const emptyLookup: ContentContextLookup = {
  issuesById: new Map(),
  channelsById: new Map(),
  sessionsById: new Map(),
  jobsById: new Map(),
};

export const kindOf = (mime: string): LibraryFileKind => mediaKindOf(mime);

export const artifactMatchesType = (a: { readonly artifactType: ArtifactType }, type: ArtifactTypeFilter | undefined): boolean =>
  type === undefined || artifactFacetOf(a) === type;

function resolveIssueAndRepo(
  rawIssueId: string | undefined,
  channelId: string | undefined,
  lookup: ContentContextLookup,
): { readonly issueId?: string; readonly repo?: string } {
  const issue = rawIssueId !== undefined ? lookup.issuesById.get(rawIssueId) : undefined;
  const parentIssue = issue?.parent !== undefined ? lookup.issuesById.get(issue.parent) : undefined;
  const issueId = issue?.parent ?? rawIssueId;
  const channelRepo = channelId !== undefined ? lookup.channelsById.get(channelId)?.repo : undefined;
  const repo = issue?.repo ?? parentIssue?.repo ?? channelRepo;
  return {
    ...(issueId !== undefined ? { issueId } : {}),
    ...(repo !== undefined && repo !== "" ? { repo } : {}),
  };
}

export function resolveArtifactContext(artifact: Pick<Artifact, "channel" | "said" | "issue">, lookup: ContentContextLookup): ContentItemContext {
  const channelId = artifact.channel ?? artifact.said?.channel;
  const resolved = resolveIssueAndRepo(artifact.issue, channelId, lookup);
  return {
    ...resolved,
    ...(channelId !== undefined && channelId !== "" ? { channelId } : {}),
  };
}

export function resolveMediaContext(item: Pick<LibraryItem, "origin">, lookup: ContentContextLookup): ContentItemContext {
  switch (item.origin.kind) {
    case "generated": {
      const job = lookup.jobsById.get(item.origin.job);
      const channelId = job?.source.kind === "orchestrator" ? job.source.channel : undefined;
      const repo = channelId !== undefined ? lookup.channelsById.get(channelId)?.repo : undefined;
      return {
        ...(channelId !== undefined && channelId !== "" ? { channelId } : {}),
        ...(repo !== undefined && repo !== "" ? { repo } : {}),
      };
    }
    case "uploaded": {
      const channelId = item.origin.channel;
      const repo = channelId !== undefined ? lookup.channelsById.get(channelId)?.repo : undefined;
      return {
        ...(channelId !== undefined && channelId !== "" ? { channelId } : {}),
        ...(repo !== undefined && repo !== "" ? { repo } : {}),
      };
    }
    case "fetched": {
      const session = item.origin.session !== undefined ? lookup.sessionsById.get(item.origin.session) : undefined;
      const channelId = session !== undefined ? sessionChannelId(session) : undefined;
      const rawIssueId = session !== undefined ? sessionIssueId(session) : undefined;
      const resolved = resolveIssueAndRepo(rawIssueId, channelId, lookup);
      const directRepo = session !== undefined ? sessionRepo(session) : undefined;
      const repo = directRepo ?? resolved.repo;
      return {
        ...(resolved.issueId !== undefined ? { issueId: resolved.issueId } : {}),
        ...(channelId !== undefined && channelId !== "" ? { channelId } : {}),
        ...(repo !== undefined && repo !== "" ? { repo } : {}),
      };
    }
  }
}

function matchesCategoryFilter(ctx: ContentItemContext, filter: Pick<ContentCategoryFilter, "repo" | "issueId" | "channelId"> | undefined): boolean {
  if (filter === undefined) return true;
  if (filter.repo !== undefined && filter.repo !== "" && ctx.repo !== filter.repo) return false;
  if (filter.issueId !== undefined && filter.issueId !== "" && ctx.issueId !== filter.issueId) return false;
  if (filter.channelId !== undefined && filter.channelId !== "" && ctx.channelId !== filter.channelId) return false;
  return true;
}

export function hasAnyCategoryFilter(filter: ContentCategoryFilter): boolean {
  return (
    (filter.repo !== undefined && filter.repo !== "") ||
    (filter.issueId !== undefined && filter.issueId !== "") ||
    (filter.channelId !== undefined && filter.channelId !== "") ||
    filter.origin !== undefined
  );
}

export function countCategoryFilters(filter: ContentCategoryFilter): number {
  return (
    Number(filter.repo !== undefined && filter.repo !== "") +
    Number(filter.issueId !== undefined && filter.issueId !== "") +
    Number(filter.channelId !== undefined && filter.channelId !== "") +
    Number(filter.origin !== undefined)
  );
}

export function buildCategoryFilterOptions(input: {
  readonly artifacts: readonly Pick<Artifact, "channel" | "said" | "issue">[];
  readonly media: readonly Pick<LibraryItem, "origin">[];
  readonly lookup: ContentContextLookup;
  readonly extraRepos?: readonly string[];
}): ContentCategoryOptions {
  const repoSet = new Set((input.extraRepos ?? []).filter((r) => r !== ""));
  const issueIds = new Set<string>();
  const channelIds = new Set<string>();
  const record = (ctx: ContentItemContext) => {
    if (ctx.repo !== undefined && ctx.repo !== "") repoSet.add(ctx.repo);
    if (ctx.issueId !== undefined && ctx.issueId !== "") issueIds.add(ctx.issueId);
    if (ctx.channelId !== undefined && ctx.channelId !== "") channelIds.add(ctx.channelId);
  };
  for (const a of input.artifacts) record(resolveArtifactContext(a, input.lookup));
  for (const m of input.media) record(resolveMediaContext(m, input.lookup));
  for (const ch of input.lookup.channelsById.values()) {
    channelIds.add(ch.id);
    if (ch.repo !== undefined && ch.repo !== "") repoSet.add(ch.repo);
  }
  const repos = [...repoSet].toSorted((a, b) => a.localeCompare(b)).map((value) => ({ value, label: value }));
  const issues = [...issueIds]
    .map((id) => {
      const issue = input.lookup.issuesById.get(id);
      return { value: id, number: issue?.number ?? 0, label: issue !== undefined ? `#${issue.number} ${issue.title}` : id };
    })
    .toSorted((a, b) => (b.number !== a.number ? b.number - a.number : a.label.localeCompare(b.label)))
    .map(({ value, label }) => ({ value, label }));
  const channels = [...channelIds]
    .map((id) => {
      const ch = input.lookup.channelsById.get(id);
      const display = ch?.name ?? ch?.title ?? id;
      return { value: id, label: `#${display}` };
    })
    .toSorted((a, b) => a.label.localeCompare(b.label));
  return { repos, issues, channels };
}

export const shownArtifacts = (
  all: readonly Artifact[],
  filter: {
    readonly artifactType?: ArtifactTypeFilter | undefined;
    readonly sort: LibrarySort;
    readonly pinnedOnly?: boolean | undefined;
    readonly pinned?: ReadonlySet<string> | undefined;
    readonly category?: ContentCategoryFilter | undefined;
    readonly lookup?: ContentContextLookup | undefined;
  },
): Artifact[] => {
  const lookup = filter.lookup ?? emptyLookup;
  const filtered = all.filter(
    (a) =>
      artifactMatchesType(a, filter.artifactType) &&
      (filter.pinnedOnly !== true || filter.pinned?.has(`artifact:${a.id}`) === true) &&
      matchesCategoryFilter(resolveArtifactContext(a, lookup), filter.category),
  );
  if (filter.sort === "name") return filtered.toSorted((a, b) => a.title.localeCompare(b.title));
  return filtered.toSorted((a, b) => b.updated - a.updated);
};

export const shownMedia = (
  items: readonly LibraryItem[],
  filter: {
    readonly fileKind?: LibraryFileKind | undefined;
    readonly pinnedOnly?: boolean | undefined;
    readonly pinned?: ReadonlySet<string> | undefined;
    readonly category?: ContentCategoryFilter | undefined;
    readonly lookup?: ContentContextLookup | undefined;
  },
): LibraryItem[] => {
  const lookup = filter.lookup ?? emptyLookup;
  const origin = filter.category?.origin;
  return items.filter(
    (item) =>
      (filter.fileKind === undefined || kindOf(item.attachment.type) === filter.fileKind) &&
      (filter.pinnedOnly !== true || filter.pinned?.has(`media:${item.attachment.id}`) === true) &&
      (origin === undefined || item.origin.kind === origin) &&
      matchesCategoryFilter(resolveMediaContext(item, lookup), filter.category),
  );
};

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
