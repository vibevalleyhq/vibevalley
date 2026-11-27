import { signal } from "nsh";
import { z } from "zod";

import type { LibraryFileKind, LibraryItem, Note, NoteType } from "@vibevalley/protocol";

import { defineAtom } from "./atom";
import { defineStored } from "./stored";

export type NoteFacet = NoteType;

export type ContentBucket =
  | { readonly kind: "recent" }
  | { readonly kind: "pinned" }
  | { readonly kind: "apps" }
  | { readonly kind: "notes"; readonly noteType?: NoteFacet | undefined }
  | { readonly kind: "media"; readonly fileKind?: LibraryFileKind | undefined };

export type TemplateCategory = "recommended" | "apps" | "engineering" | "doc" | "base" | "canvas" | "media" | "ai";

export const contentSidebarOpen = defineStored("content.sidebar", z.boolean(), true);
export const contentBrowseBucket = signal<ContentBucket>({ kind: "recent" });
export const activeNoteType = signal<NoteType | undefined>(undefined);
export const contentPresenting = signal(false);
export const contentFocusMediaId = signal<string | undefined>(undefined);

const pinnedStorage = defineStored("content.pinned", z.array(z.string()), []);
const lastContentPathStorage = defineStored("content.lastPath", z.string(), "/library");

export interface TemplatePickerInitial {
  readonly category: TemplateCategory;
  readonly noteType?: NoteType | undefined;
}

export const templatePickerState = defineAtom<TemplatePickerInitial | undefined>(undefined);
export const contentSearchOpen = defineAtom<boolean>(false);

function categoryForNoteType(type: NoteType): TemplateCategory {
  return type;
}

export function templatePickerContextFor(bucket: ContentBucket, openType?: NoteType): TemplatePickerInitial {
  if (openType !== undefined) {
    return { category: categoryForNoteType(openType), noteType: openType };
  }
  switch (bucket.kind) {
    case "notes":
      return bucket.noteType !== undefined ? { category: categoryForNoteType(bucket.noteType), noteType: bucket.noteType } : { category: "recommended" };
    case "apps":
      return { category: "apps" };
    case "media":
      return { category: "ai" };
    case "recent":
    case "pinned":
      return { category: "recommended" };
  }
}

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

export function openTemplatePicker(
  input?: TemplateCategory | { readonly category?: TemplateCategory | undefined; readonly noteType?: NoteType | undefined },
): void {
  if (typeof input === "string") {
    templatePickerState.set({ category: input });
    return;
  }
  if (input === undefined) {
    templatePickerState.set({ category: "recommended" });
    return;
  }
  const category = input.category ?? (input.noteType !== undefined ? categoryForNoteType(input.noteType) : "recommended");
  templatePickerState.set({
    category,
    ...(input.noteType !== undefined ? { noteType: input.noteType } : {}),
  });
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

export const contentPrefixes = ["/library", "/notes"] as const;

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

export function noteFacetOf(n: { readonly noteType: NoteType }): NoteFacet {
  return n.noteType;
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
  readonly installedApps: number;
  readonly notes: number;
  readonly noteByFacet: ReadonlyMap<NoteFacet, number>;
  readonly media: number;
  readonly mediaByKind: ReadonlyMap<LibraryFileKind, number>;
}

/** Single count formula shared by `ContentSidebar` badges and `LibraryPage` bucket views. */
export function countContentHub(input: {
  readonly notes: readonly Pick<Note, "id" | "noteType">[];
  readonly media: readonly { readonly attachment: Pick<LibraryItem["attachment"], "id" | "type"> }[];
  readonly pinned: ReadonlySet<string>;
  readonly installedNoteIds?: ReadonlySet<string> | undefined;
}): ContentHubCounts {
  let pinned = 0;
  let installedApps = 0;
  const noteByFacet = new Map<NoteFacet, number>();
  for (const n of input.notes) {
    if (input.pinned.has(`note:${n.id}`)) pinned += 1;
    if (input.installedNoteIds?.has(n.id) === true) installedApps += 1;
    const facet = noteFacetOf(n);
    noteByFacet.set(facet, (noteByFacet.get(facet) ?? 0) + 1);
  }
  const mediaByKind = new Map<LibraryFileKind, number>();
  for (const m of input.media) {
    if (input.pinned.has(`media:${m.attachment.id}`)) pinned += 1;
    const kind = mediaKindOf(m.attachment.type);
    mediaByKind.set(kind, (mediaByKind.get(kind) ?? 0) + 1);
  }
  return {
    total: input.notes.length + input.media.length,
    pinned,
    installedApps,
    notes: input.notes.length,
    noteByFacet,
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
    case "apps":
      return counts.installedApps;
    case "notes":
      return bucket.noteType === undefined ? counts.notes : (counts.noteByFacet.get(bucket.noteType) ?? 0);
    case "media":
      return bucket.fileKind === undefined ? counts.media : (counts.mediaByKind.get(bucket.fileKind) ?? 0);
  }
}
