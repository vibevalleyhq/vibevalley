import type { LibraryFileKind } from "@vibevalley/protocol";

import type { ContentBucket } from "../../infra/state/contentNav";
import { type ArtifactTypeFilter, between } from "./items";

export interface PriorFileSelection {
  readonly ids: readonly string[];
  readonly anchor?: string;
}

export type LibrarySelection =
  | { readonly kind: "none" }
  | { readonly kind: "files"; readonly ids: readonly string[]; readonly anchor?: string; readonly asking: boolean }
  | { readonly kind: "lightbox"; readonly index: number; readonly prior?: PriorFileSelection };

export interface PickMode {
  readonly add: boolean;
  readonly range: boolean;
}

export const initialLibrarySelection: LibrarySelection = { kind: "none" };

export function showsArtifactsInBucket(bucket: ContentBucket): boolean {
  switch (bucket.kind) {
    case "recent":
    case "pinned":
    case "artifacts":
      return true;
    case "media":
      return false;
  }
}

export function showsMediaInBucket(bucket: ContentBucket): boolean {
  switch (bucket.kind) {
    case "recent":
    case "pinned":
    case "media":
      return true;
    case "artifacts":
      return false;
  }
}

export function bucketArtifactType(bucket: ContentBucket): ArtifactTypeFilter | undefined {
  return bucket.kind === "artifacts" ? bucket.artifactType : undefined;
}

export function bucketFileKind(bucket: ContentBucket): LibraryFileKind | undefined {
  return bucket.kind === "media" ? bucket.fileKind : undefined;
}

export function isPinnedBucket(bucket: ContentBucket): boolean {
  return bucket.kind === "pinned";
}

export function selectBucketSelection(selection: LibrarySelection, bucket: ContentBucket): LibrarySelection {
  if (!showsMediaInBucket(bucket)) return { kind: "none" };
  return cancelRemove(selection);
}

export function focusFile(id: string): LibrarySelection {
  return { kind: "files", ids: [id], anchor: id, asking: false };
}

export function pickFile(selection: LibrarySelection, id: string, how: PickMode, visibleIds: readonly string[]): LibrarySelection {
  const prevAnchor = selection.kind === "files" ? selection.anchor : undefined;
  if (how.range && prevAnchor !== undefined) {
    const ranged = between({ ids: visibleIds, from: prevAnchor, to: id });
    if (ranged.length === 0) return { kind: "none" };
    return { kind: "files", ids: ranged, anchor: prevAnchor, asking: false };
  }
  if (how.add) {
    const prevIds = selection.kind === "files" ? selection.ids : [];
    const nextIds = prevIds.includes(id) ? prevIds.filter((x) => x !== id) : [...prevIds, id];
    if (nextIds.length === 0) return { kind: "none" };
    return { kind: "files", ids: nextIds, anchor: id, asking: false };
  }
  return { kind: "files", ids: [id], anchor: id, asking: false };
}

export function openLightbox(selection: LibrarySelection, index: number, imageCount?: number): LibrarySelection {
  if (index < 0 || (imageCount !== undefined && index >= imageCount)) return selection;
  switch (selection.kind) {
    case "files": {
      const prior: PriorFileSelection = selection.anchor !== undefined ? { ids: selection.ids, anchor: selection.anchor } : { ids: selection.ids };
      return { kind: "lightbox", index, prior };
    }
    case "lightbox":
      if (selection.index === index) return selection;
      return selection.prior !== undefined ? { kind: "lightbox", index, prior: selection.prior } : { kind: "lightbox", index };
    case "none":
      return { kind: "lightbox", index };
  }
}

export function closeLightbox(selection: LibrarySelection): LibrarySelection {
  switch (selection.kind) {
    case "lightbox":
      if (selection.prior !== undefined && selection.prior.ids.length > 0) {
        return selection.prior.anchor !== undefined
          ? { kind: "files", ids: selection.prior.ids, anchor: selection.prior.anchor, asking: false }
          : { kind: "files", ids: selection.prior.ids, asking: false };
      }
      return { kind: "none" };
    case "none":
    case "files":
      return selection;
  }
}

export function clearSelection(): LibrarySelection {
  return { kind: "none" };
}

export function askRemove(selection: LibrarySelection): LibrarySelection {
  switch (selection.kind) {
    case "files":
      return selection.asking ? selection : { ...selection, asking: true };
    case "none":
    case "lightbox":
      return selection;
  }
}

export function cancelRemove(selection: LibrarySelection): LibrarySelection {
  switch (selection.kind) {
    case "files":
      return selection.asking ? { ...selection, asking: false } : selection;
    case "none":
    case "lightbox":
      return selection;
  }
}

export function reconcileSelection(
  selection: LibrarySelection,
  visible: { readonly fileIds: readonly string[]; readonly imageCount: number },
): LibrarySelection {
  switch (selection.kind) {
    case "none":
      return selection;
    case "files": {
      const visibleFiles = new Set(visible.fileIds);
      const kept = selection.ids.filter((id) => visibleFiles.has(id));
      if (kept.length === 0) return { kind: "none" };
      const anchor = selection.anchor !== undefined && visibleFiles.has(selection.anchor) ? selection.anchor : kept.at(-1);
      if (kept.length === selection.ids.length && anchor === selection.anchor) return selection;
      return anchor !== undefined ? { kind: "files", ids: kept, anchor, asking: false } : { kind: "files", ids: kept, asking: false };
    }
    case "lightbox": {
      if (visible.imageCount <= 0) return { kind: "none" };
      const index = Math.min(selection.index, visible.imageCount - 1);
      const visibleFiles = new Set(visible.fileIds);
      const priorIds = selection.prior?.ids.filter((id) => visibleFiles.has(id)) ?? [];
      const priorAnchor = selection.prior?.anchor !== undefined && visibleFiles.has(selection.prior.anchor) ? selection.prior.anchor : priorIds.at(-1);
      const prior: PriorFileSelection | undefined =
        priorIds.length > 0 ? (priorAnchor !== undefined ? { ids: priorIds, anchor: priorAnchor } : { ids: priorIds }) : undefined;
      const priorUnchanged = prior?.ids.length === selection.prior?.ids.length && prior?.anchor === selection.prior?.anchor;
      if (index === selection.index && priorUnchanged) return selection;
      return prior !== undefined ? { kind: "lightbox", index, prior } : { kind: "lightbox", index };
    }
  }
}

const emptyIds: readonly string[] = [];

export function selectedFileIds(selection: LibrarySelection): readonly string[] {
  switch (selection.kind) {
    case "files":
      return selection.ids;
    case "none":
    case "lightbox":
      return emptyIds;
  }
}

export function activeFileId(selection: LibrarySelection): string | undefined {
  switch (selection.kind) {
    case "files":
      return selection.anchor ?? selection.ids.at(-1);
    case "none":
    case "lightbox":
      return undefined;
  }
}

export function lightboxIndex(selection: LibrarySelection): number | undefined {
  switch (selection.kind) {
    case "lightbox":
      return selection.index;
    case "none":
    case "files":
      return undefined;
  }
}

export function isAskingRemove(selection: LibrarySelection): boolean {
  switch (selection.kind) {
    case "files":
      return selection.asking;
    case "none":
    case "lightbox":
      return false;
  }
}
