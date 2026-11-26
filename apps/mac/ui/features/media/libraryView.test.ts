import "../../infra/polyfill";
import { expect, test } from "nsh/test";

import { type Artifact, ArtifactTypeValues, type LibraryItem, userId } from "@vibevalley/protocol";
import { artifactId } from "@vibevalley/protocol/schema";

import { type ContentBucket, countContentHub, countForBucket } from "../../infra/state/contentNav";
import { artifactMatchesType, shownArtifacts, shownMedia } from "./items";
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
} from "./libraryView";

const makeArtifact = (over: Omit<Partial<Artifact>, "id"> & { readonly id: string; readonly title: string }): Artifact => ({
  artifactType: "docs",
  isDefault: false,
  by: userId,
  byName: "Me",
  version: 0,
  seq: 0,
  versions: [],
  at: 100,
  updated: 100,
  ...over,
  id: artifactId(over.id),
});

const makeMedia = (over: { readonly id: string; readonly name: string; readonly type: string; readonly origin: LibraryItem["origin"] }): LibraryItem => ({
  attachment: { id: over.id, name: over.name, type: over.type, size: 128 },
  origin: over.origin,
  addedAt: 100,
  lastAt: 100,
});

test("bucket helpers report visible content categories and clear incompatible media selections", () => {
  const recent: ContentBucket = { kind: "recent" };
  expect(showsArtifactsInBucket(recent)).toBe(true);
  expect(showsMediaInBucket(recent)).toBe(true);
  expect(isPinnedBucket(recent)).toBe(false);
  expect(bucketArtifactType(recent)).toBeUndefined();
  expect(bucketFileKind(recent)).toBeUndefined();

  const pinned: ContentBucket = { kind: "pinned" };
  expect(showsArtifactsInBucket(pinned)).toBe(true);
  expect(showsMediaInBucket(pinned)).toBe(true);
  expect(isPinnedBucket(pinned)).toBe(true);

  const apps: ContentBucket = { kind: "apps" };
  expect(showsArtifactsInBucket(apps)).toBe(true);
  expect(showsMediaInBucket(apps)).toBe(false);
  expect(isPinnedBucket(apps)).toBe(false);

  const outline: ContentBucket = { kind: "artifacts", artifactType: "outline" };
  expect(showsArtifactsInBucket(outline)).toBe(true);
  expect(showsMediaInBucket(outline)).toBe(false);
  expect(bucketArtifactType(outline)).toBe("outline");

  const whiteboard: ContentBucket = { kind: "artifacts", artifactType: "whiteboard" };
  expect(showsArtifactsInBucket(whiteboard)).toBe(true);
  expect(showsMediaInBucket(whiteboard)).toBe(false);
  expect(bucketArtifactType(whiteboard)).toBe("whiteboard");
  expect(bucketFileKind(whiteboard)).toBeUndefined();

  const audio: ContentBucket = { kind: "media", fileKind: "audio" };
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

test("artifactMatchesType matches all 12 exact artifact types", () => {
  const byType = new Map(ArtifactTypeValues.map((t) => [t, makeArtifact({ id: `a-${t}`, title: t, artifactType: t })]));
  for (const type of ArtifactTypeValues) {
    const target = byType.get(type)!;
    expect(artifactMatchesType(target, type)).toBe(true);
    expect(artifactMatchesType(target, undefined)).toBe(true);
    for (const other of ArtifactTypeValues) {
      if (other !== type) expect(artifactMatchesType(target, other)).toBe(false);
    }
  }
});

test("artifactType, fileKind, sort, and pinned filtering work across artifacts and media", () => {
  const artifacts = [
    makeArtifact({ id: "art-user", title: "My Board", artifactType: "whiteboard", by: userId, updated: 150 }),
    makeArtifact({ id: "art-agent", title: "Agent Deck", artifactType: "slides", by: "a1", byName: "Agent", updated: 250 }),
  ];
  const media = [
    makeMedia({ id: "m-up", name: "photo.png", type: "image/png", origin: { kind: "uploaded" } }),
    makeMedia({ id: "m-gen", name: "voice.mp3", type: "audio/mpeg", origin: { kind: "generated", job: "j1", jobKind: "speech" } }),
    makeMedia({ id: "m-fetch", name: "clip.mp4", type: "video/mp4", origin: { kind: "fetched", agent: "w1", from: { url: "https://example.com/v.mp4" } } }),
  ];
  const pinned = new Set(["artifact:art-agent", "media:m-up"]);

  expect(shownArtifacts(artifacts, { sort: "recent" }).map((a) => a.id)).toEqual(["art-agent", "art-user"]);
  expect(shownArtifacts(artifacts, { sort: "name" }).map((a) => a.id)).toEqual(["art-agent", "art-user"]);
  expect(shownArtifacts(artifacts, { artifactType: "whiteboard", sort: "recent" }).map((a) => a.id)).toEqual(["art-user"]);
  expect(shownArtifacts(artifacts, { sort: "recent", pinnedOnly: true, pinned }).map((a) => a.id)).toEqual(["art-agent"]);

  expect(shownMedia(media, {}).map((m) => m.attachment.id)).toEqual(["m-up", "m-gen", "m-fetch"]);
  expect(shownMedia(media, { fileKind: "audio" }).map((m) => m.attachment.id)).toEqual(["m-gen"]);
  expect(shownMedia(media, { pinnedOnly: true, pinned }).map((m) => m.attachment.id)).toEqual(["m-up"]);
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

test("regression: countContentHub sidebar badges match LibraryPage visible counts across every bucket", () => {
  const artifacts = [
    makeArtifact({ id: "a-out", title: "Outline", artifactType: "outline" }),
    makeArtifact({ id: "a-wb", title: "Board", artifactType: "whiteboard" }),
    makeArtifact({ id: "a-doc", title: "Doc", artifactType: "docs" }),
    makeArtifact({ id: "a-slides", title: "Slides", artifactType: "slides" }),
    makeArtifact({ id: "a-proto", title: "Prototype", artifactType: "prototype" }),
    makeArtifact({ id: "a-sheet", title: "Sheet", artifactType: "sheet" }),
    makeArtifact({ id: "a-diag", title: "Diagram", artifactType: "diagram" }),
    makeArtifact({ id: "a-sb", title: "Storyboard", artifactType: "storyboard" }),
  ];
  const media = [
    makeMedia({ id: "m-img", name: "photo.png", type: "image/png", origin: { kind: "uploaded" } }),
    makeMedia({ id: "m-aud", name: "voice.mp3", type: "audio/mpeg", origin: { kind: "generated", job: "j1", jobKind: "speech" } }),
    makeMedia({ id: "m-vid", name: "clip.mp4", type: "video/mp4", origin: { kind: "uploaded" } }),
    makeMedia({ id: "m-bin", name: "data.bin", type: "application/octet-stream", origin: { kind: "uploaded" } }),
  ];
  const pinned = new Set(["artifact:a-wb", "media:m-img", "artifact:gone"]);
  const installedArtifactIds = new Set(["a-wb", "a-proto"]);

  const counts = countContentHub({ artifacts, media, pinned, installedArtifactIds });
  const buckets: readonly ContentBucket[] = [
    { kind: "recent" },
    { kind: "pinned" },
    { kind: "apps" },
    { kind: "artifacts" },
    ...ArtifactTypeValues.map((artifactType): ContentBucket => ({ kind: "artifacts", artifactType })),
    { kind: "media" },
    { kind: "media", fileKind: "image" },
    { kind: "media", fileKind: "audio" },
    { kind: "media", fileKind: "video" },
    { kind: "media", fileKind: "other" },
  ];

  for (const bucket of buckets) {
    const pinnedOnly = isPinnedBucket(bucket);
    const pageTotal =
      (showsArtifactsInBucket(bucket)
        ? shownArtifacts(artifacts, { artifactType: bucketArtifactType(bucket), sort: "recent", pinnedOnly, pinned }).filter(
            (a) => bucket.kind !== "apps" || installedArtifactIds.has(a.id),
          ).length
        : 0) + (showsMediaInBucket(bucket) ? shownMedia(media, { fileKind: bucketFileKind(bucket), pinnedOnly, pinned }).length : 0);
    expect(countForBucket(counts, bucket)).toBe(pageTotal);
  }
  expect(counts.total).toBe(artifacts.length + media.length);
  expect(counts.pinned).toBe(2);
  expect(counts.installedApps).toBe(2);
});
