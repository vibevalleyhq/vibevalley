import "../polyfill";
import { expect, test } from "nsh/test";

import {
  activeFileId,
  askRemove,
  cancelRemove,
  clearSelection,
  closeLightbox,
  initialLibrarySelection,
  initialLibraryView,
  isAskingRemove,
  type LibrarySelection,
  lightboxIndex,
  openLightbox,
  pickArtifact,
  pickFile,
  reconcileSelection,
  scopeArtifactKind,
  scopeForArtifactKind,
  scopeForKind,
  scopeKindFilter,
  selectedArtifactId,
  selectedFileIds,
  selectScope,
  showsArtifactsInScope,
  showsMediaInScope,
} from "../web/features/media/libraryView";

test("scope switching eliminates conflicting media kind and artifactKind states and clears incompatible selections", () => {
  expect(initialLibraryView.scope).toEqual({ kind: "all" });
  expect(scopeKindFilter(initialLibraryView.scope)).toBe("all");
  expect(scopeArtifactKind(initialLibraryView.scope)).toBeUndefined();
  expect(showsMediaInScope(initialLibraryView.scope)).toBe(true);
  expect(showsArtifactsInScope(initialLibraryView.scope)).toBe(true);

  const imageScope = scopeForKind("image");
  expect(imageScope).toEqual({ kind: "media", fileKind: "image" });
  expect(scopeKindFilter(imageScope)).toBe("image");
  expect(scopeArtifactKind(imageScope)).toBeUndefined();
  expect(showsMediaInScope(imageScope)).toBe(true);
  expect(showsArtifactsInScope(imageScope)).toBe(false);

  const slidesScope = scopeForArtifactKind("slides");
  expect(slidesScope).toEqual({ kind: "artifact", artifactKind: "slides" });
  expect(scopeKindFilter(slidesScope)).toBe("all");
  expect(scopeArtifactKind(slidesScope)).toBe("slides");
  expect(showsMediaInScope(slidesScope)).toBe(false);
  expect(showsArtifactsInScope(slidesScope)).toBe(true);
  expect(scopeForArtifactKind(undefined)).toEqual({ kind: "all" });
  expect(scopeForKind("all")).toEqual({ kind: "all" });

  const withAskingFile = askRemove(pickFile(initialLibrarySelection, "f1", { add: false, range: false }, ["f1", "f2"]));
  const toArtifact = selectScope({ scope: imageScope, selection: withAskingFile }, slidesScope);
  expect(toArtifact).toEqual({ scope: slidesScope, selection: { kind: "none" } });

  const withAskingArtifact = askRemove(pickArtifact("art-1"));
  const toMedia = selectScope({ scope: slidesScope, selection: withAskingArtifact }, imageScope);
  expect(toMedia).toEqual({ scope: imageScope, selection: { kind: "none" } });

  const backToAll = selectScope({ scope: slidesScope, selection: withAskingArtifact }, { kind: "all" });
  expect(backToAll).toEqual({ scope: { kind: "all" }, selection: { kind: "artifact", id: "art-1", asking: false } });

  const fromLightbox = selectScope({ scope: imageScope, selection: openLightbox(withAskingFile, 0, 2) }, slidesScope);
  expect(fromLightbox).toEqual({ scope: slidesScope, selection: { kind: "none" } });
});

test("single, toggle (add), and shift range multi-select maintain anchor and never leave empty files selection", () => {
  const visible = ["f1", "f2", "f3", "f4"];

  let sel: LibrarySelection = pickFile(initialLibrarySelection, "f2", { add: false, range: false }, visible);
  expect(sel).toEqual({ kind: "files", ids: ["f2"], anchor: "f2", asking: false });
  expect(selectedFileIds(sel)).toEqual(["f2"]);
  expect(activeFileId(sel)).toBe("f2");

  sel = pickFile(sel, "f4", { add: false, range: true }, visible);
  expect(sel).toEqual({ kind: "files", ids: ["f2", "f3", "f4"], anchor: "f2", asking: false });
  expect(activeFileId(sel)).toBe("f2");

  sel = pickFile(sel, "f1", { add: false, range: true }, visible);
  expect(sel).toEqual({ kind: "files", ids: ["f1", "f2"], anchor: "f2", asking: false });

  sel = pickFile(sel, "f4", { add: true, range: false }, visible);
  expect(sel).toEqual({ kind: "files", ids: ["f1", "f2", "f4"], anchor: "f4", asking: false });

  sel = pickFile(sel, "f2", { add: true, range: false }, visible);
  expect(sel).toEqual({ kind: "files", ids: ["f1", "f4"], anchor: "f2", asking: false });

  sel = pickFile(initialLibrarySelection, "f1", { add: false, range: false }, visible);
  sel = pickFile(sel, "f1", { add: true, range: false }, visible);
  expect(sel).toEqual({ kind: "none" });
  expect(selectedFileIds(sel)).toEqual([]);
  expect(activeFileId(sel)).toBeUndefined();

  const anchored = pickFile(initialLibrarySelection, "f1", { add: false, range: false }, visible);
  expect(pickFile(anchored, "missing", { add: false, range: true }, visible)).toEqual({ kind: "none" });

  expect(pickFile(initialLibrarySelection, "f3", { add: false, range: true }, visible)).toEqual({
    kind: "files",
    ids: ["f3"],
    anchor: "f3",
    asking: false,
  });
});

test("artifact selection, file selection, and delete confirmation are mutually exclusive", () => {
  let sel: LibrarySelection = pickFile(initialLibrarySelection, "f1", { add: false, range: false }, ["f1"]);
  sel = askRemove(sel);
  expect(isAskingRemove(sel)).toBe(true);
  expect(askRemove(sel)).toBe(sel);

  sel = pickArtifact("art-1");
  expect(sel).toEqual({ kind: "artifact", id: "art-1", asking: false });
  expect(selectedFileIds(sel)).toEqual([]);
  expect(selectedArtifactId(sel)).toBe("art-1");
  expect(activeFileId(sel)).toBeUndefined();
  expect(isAskingRemove(sel)).toBe(false);

  sel = askRemove(sel);
  expect(isAskingRemove(sel)).toBe(true);
  sel = cancelRemove(sel);
  expect(isAskingRemove(sel)).toBe(false);
  expect(cancelRemove(sel)).toBe(sel);

  sel = pickFile(askRemove(sel), "f2", { add: false, range: false }, ["f1", "f2"]);
  expect(sel).toEqual({ kind: "files", ids: ["f2"], anchor: "f2", asking: false });
  expect(selectedArtifactId(sel)).toBeUndefined();
  expect(isAskingRemove(sel)).toBe(false);

  expect(askRemove(clearSelection())).toEqual({ kind: "none" });
});

test("lightbox transitions exclude file/artifact selection and restore prior files on close", () => {
  const files = askRemove(pickFile(initialLibrarySelection, "f2", { add: false, range: false }, ["f1", "f2", "f3"]));

  expect(openLightbox(files, -1, 3)).toBe(files);
  expect(openLightbox(files, 3, 3)).toBe(files);

  const opened = openLightbox(files, 1, 3);
  expect(opened).toEqual({ kind: "lightbox", index: 1, prior: { ids: ["f2"], anchor: "f2" } });
  expect(lightboxIndex(opened)).toBe(1);
  expect(selectedFileIds(opened)).toEqual([]);
  expect(selectedArtifactId(opened)).toBeUndefined();
  expect(isAskingRemove(opened)).toBe(false);
  expect(askRemove(opened)).toBe(opened);

  expect(openLightbox(opened, 1, 3)).toBe(opened);
  const nextPic = openLightbox(opened, 2, 3);
  expect(nextPic).toEqual({ kind: "lightbox", index: 2, prior: { ids: ["f2"], anchor: "f2" } });

  expect(closeLightbox(nextPic)).toEqual({ kind: "files", ids: ["f2"], anchor: "f2", asking: false });

  const direct = openLightbox(pickArtifact("art-1"), 0, 2);
  expect(direct).toEqual({ kind: "lightbox", index: 0 });
  expect(closeLightbox(direct)).toEqual({ kind: "none" });
  expect(closeLightbox(initialLibrarySelection)).toBe(initialLibrarySelection);
});

test("reconcileSelection prunes vanished files, artifacts, anchors, and out-of-range lightbox indices", () => {
  const files: LibrarySelection = { kind: "files", ids: ["f1", "f2"], anchor: "f1", asking: true };
  expect(reconcileSelection(files, { fileIds: ["f1", "f2", "f3"], artifactIds: [], imageCount: 3 })).toBe(files);

  expect(reconcileSelection(files, { fileIds: ["f2", "f3"], artifactIds: [], imageCount: 2 })).toEqual({
    kind: "files",
    ids: ["f2"],
    anchor: "f2",
    asking: false,
  });

  expect(reconcileSelection(files, { fileIds: ["f3"], artifactIds: [], imageCount: 1 })).toEqual({ kind: "none" });

  const art: LibrarySelection = { kind: "artifact", id: "a1", asking: true };
  expect(reconcileSelection(art, { fileIds: [], artifactIds: ["a1", "a2"], imageCount: 0 })).toBe(art);
  expect(reconcileSelection(art, { fileIds: [], artifactIds: ["a2"], imageCount: 0 })).toEqual({ kind: "none" });

  const lb: LibrarySelection = { kind: "lightbox", index: 2, prior: { ids: ["f1", "f2"], anchor: "f1" } };
  expect(reconcileSelection(lb, { fileIds: ["f1", "f2", "f3"], artifactIds: [], imageCount: 3 })).toBe(lb);
  expect(reconcileSelection(lb, { fileIds: ["f2"], artifactIds: [], imageCount: 2 })).toEqual({
    kind: "lightbox",
    index: 1,
    prior: { ids: ["f2"], anchor: "f2" },
  });
  expect(reconcileSelection(lb, { fileIds: ["f2"], artifactIds: [], imageCount: 0 })).toEqual({ kind: "none" });
});
