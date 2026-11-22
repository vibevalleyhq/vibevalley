import "../../infra/polyfill";
import { expect, test } from "nsh/test";

import { type Artifact, type LibraryItem, type PkmPageSummary, userId } from "@vibevalley/protocol";
import { artifactId } from "@vibevalley/protocol/schema";

import type { ContentBucket } from "../content";
import { artifactMatchesType, shownArtifacts, shownMedia, shownNotes } from "./items";
import {
  activeFileId,
  askRemove,
  bucketArtifactType,
  bucketFileKind,
  cancelRemove,
  clearSelection,
  closeLightbox,
  focusFile,
  initialLibrarySelection,
  isAskingRemove,
  isPinnedBucket,
  type LibrarySelection,
  lightboxIndex,
  openLightbox,
  pickFile,
  reconcileSelection,
  selectBucketSelection,
  selectedFileIds,
  showsArtifactsInBucket,
  showsMediaInBucket,
  showsNotesInBucket,
} from "./libraryView";

const makeArtifact = (over: Omit<Partial<Artifact>, "id"> & { readonly id: string; readonly title: string }): Artifact => ({
  body: "html",
  isDefault: false,
  by: userId,
  byName: "Me",
  version: 1,
  seq: 0,
  versions: [],
  at: 100,
  updated: 100,
  ...over,
  id: artifactId(over.id),
});

const makeNote = (over: Partial<PkmPageSummary> & { readonly slug: string; readonly title: string }): PkmPageSummary => ({
  tier: "inbox",
  file: `${over.slug}.md`,
  tldr: "",
  updated: 100,
  open: 0,
  ...over,
});

const makeMedia = (over: { readonly id: string; readonly name: string; readonly type: string; readonly origin: LibraryItem["origin"] }): LibraryItem => ({
  attachment: { id: over.id, name: over.name, type: over.type, size: 128 },
  origin: over.origin,
  addedAt: 100,
  lastAt: 100,
});

test("bucket helpers report visible content categories and clear incompatible media selections", () => {
  const recent: ContentBucket = { kind: "recent" };
  expect(showsNotesInBucket(recent)).toBe(true);
  expect(showsArtifactsInBucket(recent)).toBe(true);
  expect(showsMediaInBucket(recent)).toBe(true);
  expect(isPinnedBucket(recent)).toBe(false);
  expect(bucketArtifactType(recent)).toBeUndefined();
  expect(bucketFileKind(recent)).toBeUndefined();

  const pinned: ContentBucket = { kind: "pinned" };
  expect(showsNotesInBucket(pinned)).toBe(true);
  expect(showsArtifactsInBucket(pinned)).toBe(true);
  expect(showsMediaInBucket(pinned)).toBe(true);
  expect(isPinnedBucket(pinned)).toBe(true);

  const outline: ContentBucket = { kind: "artifacts", artifactType: "outline" };
  expect(showsNotesInBucket(outline)).toBe(false);
  expect(showsArtifactsInBucket(outline)).toBe(true);
  expect(showsMediaInBucket(outline)).toBe(false);
  expect(bucketArtifactType(outline)).toBe("outline");

  const whiteboard: ContentBucket = { kind: "artifacts", artifactType: "whiteboard" };
  expect(showsNotesInBucket(whiteboard)).toBe(false);
  expect(showsArtifactsInBucket(whiteboard)).toBe(true);
  expect(showsMediaInBucket(whiteboard)).toBe(false);
  expect(bucketArtifactType(whiteboard)).toBe("whiteboard");
  expect(bucketFileKind(whiteboard)).toBeUndefined();

  const audio: ContentBucket = { kind: "media", fileKind: "audio" };
  expect(showsNotesInBucket(audio)).toBe(false);
  expect(showsArtifactsInBucket(audio)).toBe(false);
  expect(showsMediaInBucket(audio)).toBe(true);
  expect(bucketFileKind(audio)).toBe("audio");
  expect(bucketArtifactType(audio)).toBeUndefined();

  const withAsking = askRemove(focusFile("f1"));
  expect(selectBucketSelection(withAsking, outline)).toEqual({ kind: "none" });
  expect(selectBucketSelection(withAsking, whiteboard)).toEqual({ kind: "none" });
  expect(selectBucketSelection(withAsking, audio)).toEqual({ kind: "files", ids: ["f1"], anchor: "f1", asking: false });
  expect(selectBucketSelection(openLightbox(withAsking, 0, 2), whiteboard)).toEqual({ kind: "none" });
});

test("artifactMatchesType matches all 9 exact artifact types and legacy body/display fallbacks", () => {
  const outline = makeArtifact({ id: "a-out", title: "Outline", body: "blocks", artifactType: "outline" });
  const wb = makeArtifact({ id: "a-wb", title: "Board", body: "store", artifactType: "whiteboard" });
  const docs = makeArtifact({ id: "a-docs", title: "Doc", body: "blocks", artifactType: "docs" });
  const legacyBlocks = makeArtifact({ id: "a-blocks", title: "Legacy Doc", body: "blocks" });
  const slides = makeArtifact({ id: "a-slides", title: "Deck", body: "html", artifactType: "slides" });
  const legacySlides = makeArtifact({ id: "a-lslides", title: "Legacy Deck", body: "html", display: "slides" });
  const dash = makeArtifact({ id: "a-dash", title: "KPI", body: "html", artifactType: "dashboard" });
  const design = makeArtifact({ id: "a-des", title: "Mock", body: "store", artifactType: "design" });
  const ds = makeArtifact({ id: "a-ds", title: "Tokens", body: "store", artifactType: "design-system" });
  const motion = makeArtifact({ id: "a-mot", title: "Anim", body: "html", artifactType: "motion" });
  const legacyMotion = makeArtifact({ id: "a-lmot", title: "Legacy Anim", body: "html", display: "motion" });
  const html = makeArtifact({ id: "a-html", title: "Page", body: "html", display: "page" });

  expect(artifactMatchesType(outline, "outline")).toBe(true);
  expect(artifactMatchesType(outline, "docs")).toBe(false);
  expect(artifactMatchesType(wb, "whiteboard")).toBe(true);
  expect(artifactMatchesType(wb, "design")).toBe(false);
  expect(artifactMatchesType(docs, "docs")).toBe(true);
  expect(artifactMatchesType(legacyBlocks, "docs")).toBe(true);
  expect(artifactMatchesType(slides, "slides")).toBe(true);
  expect(artifactMatchesType(legacySlides, "slides")).toBe(true);
  expect(artifactMatchesType(dash, "dashboard")).toBe(true);
  expect(artifactMatchesType(design, "design")).toBe(true);
  expect(artifactMatchesType(design, "design-system")).toBe(false);
  expect(artifactMatchesType(ds, "design-system")).toBe(true);
  expect(artifactMatchesType(motion, "motion")).toBe(true);
  expect(artifactMatchesType(legacyMotion, "motion")).toBe(true);
  expect(artifactMatchesType(html, "html")).toBe(true);
  expect(artifactMatchesType(slides, "html")).toBe(false);
  expect(artifactMatchesType(legacySlides, "html")).toBe(false);
  expect(artifactMatchesType(wb, undefined)).toBe(true);
  expect(artifactMatchesType(html, undefined)).toBe(true);
});

test("orthogonal SourceFilter and pinned filtering work across notes, artifacts, and media", () => {
  const notes = [makeNote({ slug: "beta", title: "Beta", updated: 200 }), makeNote({ slug: "alpha", title: "Alpha", updated: 100 })];
  const artifacts = [
    makeArtifact({ id: "art-user", title: "My Board", body: "store", artifactType: "whiteboard", by: userId, updated: 150 }),
    makeArtifact({ id: "art-agent", title: "Agent Deck", body: "html", artifactType: "slides", by: "a1", byName: "Agent", updated: 250 }),
  ];
  const media = [
    makeMedia({ id: "m-up", name: "photo.png", type: "image/png", origin: { kind: "uploaded" } }),
    makeMedia({ id: "m-gen", name: "voice.mp3", type: "audio/mpeg", origin: { kind: "generated", job: "j1", jobKind: "speech" } }),
    makeMedia({ id: "m-fetch", name: "clip.mp4", type: "video/mp4", origin: { kind: "fetched", agent: "w1", from: { url: "https://example.com/v.mp4" } } }),
  ];
  const pinned = new Set(["note:alpha", "artifact:art-agent", "media:m-up"]);

  expect(shownNotes(notes, { source: "all", sort: "recent" }).map((n) => n.slug)).toEqual(["beta", "alpha"]);
  expect(shownNotes(notes, { source: "user", sort: "name" }).map((n) => n.slug)).toEqual(["alpha", "beta"]);
  expect(shownNotes(notes, { source: "agent", sort: "recent" })).toEqual([]);
  expect(shownNotes(notes, { source: "all", sort: "recent", pinnedOnly: true, pinned }).map((n) => n.slug)).toEqual(["alpha"]);

  expect(shownArtifacts(artifacts, { source: "all", sort: "recent" }).map((a) => a.id)).toEqual(["art-agent", "art-user"]);
  expect(shownArtifacts(artifacts, { source: "agent", sort: "recent" }).map((a) => a.id)).toEqual(["art-agent"]);
  expect(shownArtifacts(artifacts, { source: "user", sort: "recent" }).map((a) => a.id)).toEqual(["art-user"]);
  expect(shownArtifacts(artifacts, { source: "all", artifactType: "whiteboard", sort: "recent" }).map((a) => a.id)).toEqual(["art-user"]);
  expect(shownArtifacts(artifacts, { source: "all", sort: "recent", pinnedOnly: true, pinned }).map((a) => a.id)).toEqual(["art-agent"]);

  expect(shownMedia(media, { source: "all" }).map((m) => m.attachment.id)).toEqual(["m-up", "m-gen", "m-fetch"]);
  expect(shownMedia(media, { source: "agent" }).map((m) => m.attachment.id)).toEqual(["m-gen", "m-fetch"]);
  expect(shownMedia(media, { source: "user" }).map((m) => m.attachment.id)).toEqual(["m-up"]);
  expect(shownMedia(media, { source: "all", fileKind: "audio" }).map((m) => m.attachment.id)).toEqual(["m-gen"]);
  expect(shownMedia(media, { source: "all", pinnedOnly: true, pinned }).map((m) => m.attachment.id)).toEqual(["m-up"]);
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

test("delete confirmation transitions are idempotent and reset on selection changes", () => {
  let sel: LibrarySelection = focusFile("f1");
  sel = askRemove(sel);
  expect(isAskingRemove(sel)).toBe(true);
  expect(askRemove(sel)).toBe(sel);

  sel = cancelRemove(sel);
  expect(isAskingRemove(sel)).toBe(false);
  expect(cancelRemove(sel)).toBe(sel);

  sel = pickFile(askRemove(sel), "f2", { add: false, range: false }, ["f1", "f2"]);
  expect(sel).toEqual({ kind: "files", ids: ["f2"], anchor: "f2", asking: false });
  expect(isAskingRemove(sel)).toBe(false);

  expect(askRemove(clearSelection())).toEqual({ kind: "none" });
});

test("lightbox transitions exclude file selection and restore prior files on close", () => {
  const files = askRemove(pickFile(initialLibrarySelection, "f2", { add: false, range: false }, ["f1", "f2", "f3"]));

  expect(openLightbox(files, -1, 3)).toBe(files);
  expect(openLightbox(files, 3, 3)).toBe(files);

  const opened = openLightbox(files, 1, 3);
  expect(opened).toEqual({ kind: "lightbox", index: 1, prior: { ids: ["f2"], anchor: "f2" } });
  expect(lightboxIndex(opened)).toBe(1);
  expect(selectedFileIds(opened)).toEqual([]);
  expect(isAskingRemove(opened)).toBe(false);
  expect(askRemove(opened)).toBe(opened);

  expect(openLightbox(opened, 1, 3)).toBe(opened);
  const nextPic = openLightbox(opened, 2, 3);
  expect(nextPic).toEqual({ kind: "lightbox", index: 2, prior: { ids: ["f2"], anchor: "f2" } });

  expect(closeLightbox(nextPic)).toEqual({ kind: "files", ids: ["f2"], anchor: "f2", asking: false });

  const direct = openLightbox(initialLibrarySelection, 0, 2);
  expect(direct).toEqual({ kind: "lightbox", index: 0 });
  expect(closeLightbox(direct)).toEqual({ kind: "none" });
  expect(closeLightbox(initialLibrarySelection)).toBe(initialLibrarySelection);
});

test("reconcileSelection prunes vanished files, anchors, and out-of-range lightbox indices", () => {
  const files: LibrarySelection = { kind: "files", ids: ["f1", "f2"], anchor: "f1", asking: true };
  expect(reconcileSelection(files, { fileIds: ["f1", "f2", "f3"], imageCount: 3 })).toBe(files);

  expect(reconcileSelection(files, { fileIds: ["f2", "f3"], imageCount: 2 })).toEqual({
    kind: "files",
    ids: ["f2"],
    anchor: "f2",
    asking: false,
  });

  expect(reconcileSelection(files, { fileIds: ["f3"], imageCount: 1 })).toEqual({ kind: "none" });

  const lb: LibrarySelection = { kind: "lightbox", index: 2, prior: { ids: ["f1", "f2"], anchor: "f1" } };
  expect(reconcileSelection(lb, { fileIds: ["f1", "f2", "f3"], imageCount: 3 })).toBe(lb);
  expect(reconcileSelection(lb, { fileIds: ["f2"], imageCount: 2 })).toEqual({
    kind: "lightbox",
    index: 1,
    prior: { ids: ["f2"], anchor: "f2" },
  });
  expect(reconcileSelection(lb, { fileIds: ["f2"], imageCount: 0 })).toEqual({ kind: "none" });
});
