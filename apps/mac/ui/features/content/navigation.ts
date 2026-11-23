import { signal } from "nsh";
import { z } from "zod";

import type { Artifact, ArtifactBody, ArtifactDisplay, ArtifactType, LibraryFileKind, LibraryItem, PkmPageSummary } from "@vibevalley/protocol";

import { defineAtom } from "../../infra/state/atom";
import { defineStored } from "../../infra/state/stored";

export type ArtifactFacet = ArtifactType | "html";

export type ContentBucket =
  | { readonly kind: "recent" }
  | { readonly kind: "pinned" }
  | { readonly kind: "artifacts"; readonly artifactType?: ArtifactFacet | undefined }
  | { readonly kind: "media"; readonly fileKind?: LibraryFileKind | undefined };

export type TemplateCategory = "recommended" | "note" | "whiteboard" | "deliverable" | "ai";

export const contentSidebarOpen = defineStored("content.sidebar", z.boolean(), true);
export const contentBrowseBucket = signal<ContentBucket>({ kind: "recent" });
export const contentPresenting = signal(false);
export const contentFocusMediaId = signal<string | undefined>(undefined);

const pinnedStorage = defineStored("content.pinned", z.array(z.string()), []);
const lastContentPathStorage = defineStored("content.lastPath", z.string(), "/library");

export const templatePickerState = defineAtom<{ readonly category: TemplateCategory } | undefined>(undefined);
export const contentSearchOpen = defineAtom<boolean>(false);

export function pinnedKeys(): readonly string[] {
  return pinnedStorage.get();
}

export function isPinned(key: string): boolean {
  return pinnedStorage.get().includes(key);
}

export function togglePinned(key: string): boolean {
  const current = pinnedStorage.get();
  if (current.includes(key)) {
    pinnedStorage.set(current.filter((item) => item !== key));
    return false;
  }
  pinnedStorage.set([...current, key]);
  return true;
}

export function openTemplatePicker(category: TemplateCategory = "recommended"): void {
  templatePickerState.set({ category });
}

export function closeTemplatePicker(): void {
  templatePickerState.set(undefined);
}

export function openContentSearch(): void {
  contentSearchOpen.set(true);
}

export function closeContentSearch(): void {
  contentSearchOpen.set(false);
}

const contentPrefixes = ["/library", "/artifacts", "/pkm"] as const;

function isContentPath(path: string): boolean {
  return contentPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`));
}

// Transient modal/nav triggers: Content reopens the document without re-opening them.
function normalizeContentPath(pathname: string, search = ""): string | undefined {
  if (!isContentPath(pathname)) return undefined;
  const params = new URLSearchParams(search);
  params.delete("make");
  params.delete("nav");
  params.delete("understand");
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function recordContentPath(pathname: string, search: string): void {
  const normalized = normalizeContentPath(pathname, search);
  if (normalized === undefined) return;
  if (lastContentPathStorage.get() !== normalized) {
    lastContentPathStorage.set(normalized);
  }
}

export function safeLastContentPath(): string {
  const raw = lastContentPathStorage.get().trim();
  if (!raw || raw.includes("://")) return "/library";
  const [pathname = "", query = ""] = raw.split("?");
  return normalizeContentPath(pathname, query ? `?${query}` : "") ?? "/library";
}

export function artifactFacetOf(a: {
  readonly body: ArtifactBody;
  readonly display?: ArtifactDisplay | undefined;
  readonly artifactType?: ArtifactType | undefined;
}): ArtifactFacet {
  if (a.artifactType !== undefined) return a.artifactType;
  switch (a.body) {
    case "blocks":
    case "store":
      return "docs";
    case "html":
      if (a.display === "slides") return "slides";
      if (a.display === "motion") return "motion";
      return "html";
  }
}

export function mediaKindOf(mime: string): LibraryFileKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "other";
}

export interface ContentHubCounts {
  readonly total: number;
  readonly pinned: number;
  readonly artifacts: number;
  readonly artifactByFacet: ReadonlyMap<ArtifactFacet, number>;
  readonly media: number;
  readonly mediaByKind: ReadonlyMap<LibraryFileKind, number>;
}

/** Single count formula shared by `ContentSidebar` badges and `LibraryPage` bucket views. */
export function countContentHub(input: {
  readonly notes: readonly Pick<PkmPageSummary, "slug">[];
  readonly artifacts: readonly Pick<Artifact, "id" | "body" | "display" | "artifactType">[];
  readonly media: readonly { readonly attachment: Pick<LibraryItem["attachment"], "id" | "type"> }[];
  readonly pinned: ReadonlySet<string>;
}): ContentHubCounts {
  let pinned = 0;
  for (const n of input.notes) {
    if (input.pinned.has(`note:${n.slug}`)) pinned += 1;
  }
  const artifactByFacet = new Map<ArtifactFacet, number>();
  for (const a of input.artifacts) {
    if (input.pinned.has(`artifact:${a.id}`)) pinned += 1;
    const facet = artifactFacetOf(a);
    artifactByFacet.set(facet, (artifactByFacet.get(facet) ?? 0) + 1);
  }
  const mediaByKind = new Map<LibraryFileKind, number>();
  for (const m of input.media) {
    if (input.pinned.has(`media:${m.attachment.id}`)) pinned += 1;
    const kind = mediaKindOf(m.attachment.type);
    mediaByKind.set(kind, (mediaByKind.get(kind) ?? 0) + 1);
  }
  return {
    total: input.notes.length + input.artifacts.length + input.media.length,
    pinned,
    artifacts: input.artifacts.length,
    artifactByFacet,
    media: input.media.length,
    mediaByKind,
  };
}

export function countForBucket(counts: ContentHubCounts, bucket: ContentBucket): number {
  switch (bucket.kind) {
    case "recent":
      return counts.total;
    case "pinned":
      return counts.pinned;
    case "artifacts":
      return bucket.artifactType === undefined ? counts.artifacts : (counts.artifactByFacet.get(bucket.artifactType) ?? 0);
    case "media":
      return bucket.fileKind === undefined ? counts.media : (counts.mediaByKind.get(bucket.fileKind) ?? 0);
  }
}
