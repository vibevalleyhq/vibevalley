import { signal } from "nsh";
import { z } from "zod";

import type { Artifact, ArtifactType, LibraryFileKind } from "@vibevalley/protocol";

import { defineAtom } from "../../infra/state/atom";
import { defineStored } from "../../infra/state/stored";

export type ContentBucket =
  | { readonly kind: "recent" }
  | { readonly kind: "pinned" }
  | { readonly kind: "notes" }
  | { readonly kind: "artifacts"; readonly artifactType?: ArtifactType | "html" | undefined }
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

export function artifactFacetOf(a: Pick<Artifact, "body" | "display" | "artifactType">): ArtifactType | "html" {
  if (a.artifactType) return a.artifactType;
  if (a.body === "blocks") return "docs";
  if (a.body === "html") {
    if (a.display === "slides") return "slides";
    if (a.display === "motion") return "motion";
    return "html";
  }
  return "docs";
}

export function mediaKindOf(mime: string): LibraryFileKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "other";
}
