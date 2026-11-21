import type { LibraryFileKind } from "@vibevalley/protocol";

import { type ArtifactKindFilter, between, type KindFilter } from "./items";

export type LibraryScope =
  | { readonly kind: "all" }
  | { readonly kind: "media"; readonly fileKind: LibraryFileKind }
  | { readonly kind: "artifact"; readonly artifactKind: ArtifactKindFilter };

export interface PriorFileSelection {
  readonly ids: readonly string[];
  readonly anchor?: string;
}

export type LibrarySelection =
  | { readonly kind: "none" }
  | { readonly kind: "files"; readonly ids: readonly string[]; readonly anchor?: string; readonly asking: boolean }
  | { readonly kind: "artifact"; readonly id: string; readonly asking: boolean }
  | { readonly kind: "lightbox"; readonly index: number; readonly prior?: PriorFileSelection };

export interface LibraryViewState {
  readonly scope: LibraryScope;
  readonly selection: LibrarySelection;
}

export interface PickMode {
  readonly add: boolean;
  readonly range: boolean;
}

export const initialLibraryScope: LibraryScope = { kind: "all" };
export const initialLibrarySelection: LibrarySelection = { kind: "none" };
export const initialLibraryView: LibraryViewState = { scope: initialLibraryScope, selection: initialLibrarySelection };

export function scopeForKind(kind: KindFilter): LibraryScope {
  return kind === "all" ? { kind: "all" } : { kind: "media", fileKind: kind };
}

export function scopeForArtifactKind(artifactKind: ArtifactKindFilter | undefined): LibraryScope {
  return artifactKind === undefined ? { kind: "all" } : { kind: "artifact", artifactKind };
}

function sameScope(a: LibraryScope, b: LibraryScope): boolean {
  switch (a.kind) {
    case "all":
      return b.kind === "all";
    case "media":
      return b.kind === "media" && a.fileKind === b.fileKind;
    case "artifact":
      return b.kind === "artifact" && a.artifactKind === b.artifactKind;
  }
}

export function selectScope(view: LibraryViewState, nextScope: LibraryScope): LibraryViewState {
  const scope = sameScope(view.scope, nextScope) ? view.scope : nextScope;
  switch (nextScope.kind) {
    case "all":
      return { scope, selection: cancelRemove(view.selection) };
    case "media":
      switch (view.selection.kind) {
        case "artifact":
          return { scope, selection: { kind: "none" } };
        case "none":
        case "files":
        case "lightbox":
          return { scope, selection: cancelRemove(view.selection) };
      }
      break;
    case "artifact":
      switch (view.selection.kind) {
        case "files":
        case "lightbox":
          return { scope, selection: { kind: "none" } };
        case "none":
        case "artifact":
          return { scope, selection: cancelRemove(view.selection) };
      }
  }
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

export function pickArtifact(id: string): LibrarySelection {
  return { kind: "artifact", id, asking: false };
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
    case "artifact":
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
    case "artifact":
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
    case "artifact":
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
    case "artifact":
      return selection.asking ? { ...selection, asking: false } : selection;
    case "none":
    case "lightbox":
      return selection;
  }
}

export function reconcileSelection(
  selection: LibrarySelection,
  visible: { readonly fileIds: readonly string[]; readonly artifactIds: readonly string[]; readonly imageCount: number },
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
    case "artifact":
      return visible.artifactIds.includes(selection.id) ? selection : { kind: "none" };
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

export function scopeKindFilter(scope: LibraryScope): KindFilter {
  switch (scope.kind) {
    case "all":
    case "artifact":
      return "all";
    case "media":
      return scope.fileKind;
  }
}

export function scopeArtifactKind(scope: LibraryScope): ArtifactKindFilter | undefined {
  switch (scope.kind) {
    case "all":
    case "media":
      return undefined;
    case "artifact":
      return scope.artifactKind;
  }
}

export function showsMediaInScope(scope: LibraryScope): boolean {
  switch (scope.kind) {
    case "all":
    case "media":
      return true;
    case "artifact":
      return false;
  }
}

export function showsArtifactsInScope(scope: LibraryScope): boolean {
  switch (scope.kind) {
    case "all":
    case "artifact":
      return true;
    case "media":
      return false;
  }
}

const emptyIds: readonly string[] = [];

export function selectedFileIds(selection: LibrarySelection): readonly string[] {
  switch (selection.kind) {
    case "files":
      return selection.ids;
    case "none":
    case "artifact":
    case "lightbox":
      return emptyIds;
  }
}

export function selectedArtifactId(selection: LibrarySelection): string | undefined {
  switch (selection.kind) {
    case "artifact":
      return selection.id;
    case "none":
    case "files":
    case "lightbox":
      return undefined;
  }
}

export function activeFileId(selection: LibrarySelection): string | undefined {
  switch (selection.kind) {
    case "files":
      return selection.anchor ?? selection.ids.at(-1);
    case "none":
    case "artifact":
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
    case "artifact":
      return undefined;
  }
}

export function isAskingRemove(selection: LibrarySelection): boolean {
  switch (selection.kind) {
    case "files":
    case "artifact":
      return selection.asking;
    case "none":
    case "lightbox":
      return false;
  }
}
