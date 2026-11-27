import "../../infra/polyfill";
import { expect, test } from "nsh/test";

import {
  type Channel,
  type Issue,
  type IssueId,
  type LibraryItem,
  type MediaJob,
  type Note,
  NoteTypeValues,
  type Session,
  type SessionId,
  userId,
} from "@vibevalley/protocol";
import { noteId } from "@vibevalley/protocol/schema";

import { type ContentBucket, countContentHub, countForBucket } from "../../infra/state/contentNav";
import {
  buildCategoryFilterOptions,
  type ContentContextLookup,
  countCategoryFilters,
  noteMatchesType,
  resolveMediaContext,
  resolveNoteContext,
  shownMedia,
  shownNotes,
} from "./items";
import {
  activeFileId,
  askRemove,
  bucketFileKind,
  bucketNoteType,
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
  showsMediaInBucket,
  showsNotesInBucket,
} from "./libraryView";

const makeNote = (over: Omit<Partial<Note>, "id"> & { readonly id: string; readonly title: string }): Note => ({
  noteType: "doc",
  sortOrder: 0,
  by: userId,
  byName: "Me",
  version: 0,
  seq: 0,
  versions: [],
  at: 100,
  updated: 100,
  ...over,
  id: noteId(over.id),
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
  expect(showsMediaInBucket(recent)).toBe(true);
  expect(isPinnedBucket(recent)).toBe(false);
  expect(bucketNoteType(recent)).toBeUndefined();
  expect(bucketFileKind(recent)).toBeUndefined();

  const pinned: ContentBucket = { kind: "pinned" };
  expect(showsNotesInBucket(pinned)).toBe(true);
  expect(showsMediaInBucket(pinned)).toBe(true);
  expect(isPinnedBucket(pinned)).toBe(true);

  const apps: ContentBucket = { kind: "apps" };
  expect(showsNotesInBucket(apps)).toBe(true);
  expect(showsMediaInBucket(apps)).toBe(false);
  expect(isPinnedBucket(apps)).toBe(false);

  const docBucket: ContentBucket = { kind: "notes", noteType: "doc" };
  expect(showsNotesInBucket(docBucket)).toBe(true);
  expect(showsMediaInBucket(docBucket)).toBe(false);
  expect(bucketNoteType(docBucket)).toBe("doc");

  const canvasBucket: ContentBucket = { kind: "notes", noteType: "canvas" };
  expect(showsNotesInBucket(canvasBucket)).toBe(true);
  expect(showsMediaInBucket(canvasBucket)).toBe(false);
  expect(bucketNoteType(canvasBucket)).toBe("canvas");
  expect(bucketFileKind(canvasBucket)).toBeUndefined();

  const audio: ContentBucket = { kind: "media", fileKind: "audio" };
  expect(showsNotesInBucket(audio)).toBe(false);
  expect(showsMediaInBucket(audio)).toBe(true);
  expect(bucketFileKind(audio)).toBe("audio");
  expect(bucketNoteType(audio)).toBeUndefined();

  const withAsking = askRemove(focusFile("f1"));
  expect(selectBucketSelection(withAsking, docBucket)).toEqual({ kind: "none" });
  expect(selectBucketSelection(withAsking, canvasBucket)).toEqual({ kind: "none" });
  expect(selectBucketSelection(withAsking, audio)).toEqual({ kind: "files", ids: ["f1"], anchor: "f1", asking: false });
  expect(selectBucketSelection(openLightbox(withAsking, 0, 2), canvasBucket)).toEqual({ kind: "none" });
});

test("noteMatchesType matches all 3+1 canonical note types", () => {
  const byType = new Map(NoteTypeValues.map((t) => [t, makeNote({ id: `n-${t}`, title: t, noteType: t })]));
  for (const type of NoteTypeValues) {
    const target = byType.get(type)!;
    expect(noteMatchesType(target, type)).toBe(true);
    expect(noteMatchesType(target, undefined)).toBe(true);
    for (const other of NoteTypeValues) {
      if (other !== type) expect(noteMatchesType(target, other)).toBe(false);
    }
  }
});

test("noteType, fileKind, sort, and pinned filtering work across notes and media", () => {
  const notes = [
    makeNote({ id: "note-user", title: "My Board", noteType: "canvas", by: userId, updated: 150 }),
    makeNote({ id: "note-agent", title: "Agent Base", noteType: "base", by: "a1", byName: "Agent", updated: 250 }),
  ];
  const media = [
    makeMedia({ id: "m-up", name: "photo.png", type: "image/png", origin: { kind: "uploaded" } }),
    makeMedia({ id: "m-gen", name: "voice.mp3", type: "audio/mpeg", origin: { kind: "generated", job: "j1", jobKind: "speech" } }),
    makeMedia({ id: "m-fetch", name: "clip.mp4", type: "video/mp4", origin: { kind: "fetched", agent: "w1", from: { url: "https://example.com/v.mp4" } } }),
  ];
  const pinned = new Set(["note:note-agent", "media:m-up"]);

  expect(shownNotes(notes, { sort: "recent" }).map((n) => n.id)).toEqual(["note-agent", "note-user"]);
  expect(shownNotes(notes, { sort: "name" }).map((n) => n.id)).toEqual(["note-agent", "note-user"]);
  expect(shownNotes(notes, { noteType: "canvas", sort: "recent" }).map((n) => n.id)).toEqual(["note-user"]);
  expect(shownNotes(notes, { sort: "recent", pinnedOnly: true, pinned }).map((n) => n.id)).toEqual(["note-agent"]);

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
  const notes = [
    makeNote({ id: "n-doc", title: "Doc", noteType: "doc" }),
    makeNote({ id: "n-base", title: "Base", noteType: "base" }),
    makeNote({ id: "n-canvas", title: "Canvas", noteType: "canvas" }),
    makeNote({ id: "n-media", title: "Media", noteType: "media" }),
  ];
  const media = [
    makeMedia({ id: "m-img", name: "photo.png", type: "image/png", origin: { kind: "uploaded" } }),
    makeMedia({ id: "m-aud", name: "voice.mp3", type: "audio/mpeg", origin: { kind: "generated", job: "j1", jobKind: "speech" } }),
    makeMedia({ id: "m-vid", name: "clip.mp4", type: "video/mp4", origin: { kind: "uploaded" } }),
    makeMedia({ id: "m-bin", name: "data.bin", type: "application/octet-stream", origin: { kind: "uploaded" } }),
  ];
  const pinned = new Set(["note:n-canvas", "media:m-img", "note:gone"]);
  const installedNoteIds = new Set(["n-canvas", "n-doc"]);

  const counts = countContentHub({ notes, media, pinned, installedNoteIds });
  const buckets: readonly ContentBucket[] = [
    { kind: "recent" },
    { kind: "pinned" },
    { kind: "apps" },
    { kind: "notes" },
    ...NoteTypeValues.map((noteType): ContentBucket => ({ kind: "notes", noteType })),
    { kind: "media" },
    { kind: "media", fileKind: "image" },
    { kind: "media", fileKind: "audio" },
    { kind: "media", fileKind: "video" },
    { kind: "media", fileKind: "other" },
  ];

  for (const bucket of buckets) {
    const pinnedOnly = isPinnedBucket(bucket);
    const pageTotal =
      (showsNotesInBucket(bucket)
        ? shownNotes(notes, { noteType: bucketNoteType(bucket), sort: "recent", pinnedOnly, pinned }).filter(
            (n) => bucket.kind !== "apps" || installedNoteIds.has(n.id),
          ).length
        : 0) + (showsMediaInBucket(bucket) ? shownMedia(media, { fileKind: bucketFileKind(bucket), pinnedOnly, pinned }).length : 0);
    expect(countForBucket(counts, bucket)).toBe(pageTotal);
  }
  expect(counts.total).toBe(notes.length + media.length);
  expect(counts.pinned).toBe(2);
  expect(counts.installedApps).toBe(2);
});

test("category filtering resolves repo, parent/issue, channel, and media origin across notes and media", () => {
  const issues: Pick<Issue, "id" | "number" | "title" | "repo" | "parent">[] = [
    { id: "i-parent" as IssueId, number: 40, title: "Q4 Platform Work", repo: "vibevalley" },
    { id: "i-child" as IssueId, number: 42, title: "Board Drag FSM", repo: "vibevalley", parent: "i-parent" as IssueId },
    { id: "i-docs" as IssueId, number: 51, title: "Site Refresh", repo: "docs-site" },
  ];
  const channels: Pick<Channel, "id" | "name" | "title" | "repo">[] = [
    { id: "general", name: "general", title: "general", repo: "vibevalley" },
    { id: "marketing", name: "marketing", title: "marketing", repo: "docs-site" },
  ];
  const sessions: Pick<Session, "id" | "bindings" | "policy">[] = [
    {
      id: "s-1" as SessionId,
      bindings: [
        { kind: "issue", id: "i-child" as IssueId },
        { kind: "channel", id: "general" },
      ],
      policy: { kind: "managedWorktree", repo: "vibevalley", branch: "issue-42" },
    },
  ];
  const jobs: Pick<MediaJob, "id" | "source">[] = [{ id: "job-img", source: { kind: "orchestrator", agent: "orchestrator", channel: "marketing" } }];
  const lookup: ContentContextLookup = {
    issuesById: new Map(issues.map((i) => [i.id, i])),
    channelsById: new Map(channels.map((c) => [c.id, c])),
    sessionsById: new Map(sessions.map((s) => [s.id, s])),
    jobsById: new Map(jobs.map((j) => [j.id, j])),
  };

  const notes = [
    makeNote({ id: "note-child", title: "FSM Spec", noteType: "doc", issue: "i-child" as IssueId, channel: "general" }),
    makeNote({ id: "note-site", title: "Launch Base", noteType: "base", issue: "i-docs" as IssueId, channel: "marketing" }),
  ];
  const media = [
    makeMedia({ id: "m-gen", name: "hero.png", type: "image/png", origin: { kind: "generated", job: "job-img", jobKind: "image" } }),
    makeMedia({ id: "m-up", name: "demo.m4a", type: "audio/mp4", origin: { kind: "uploaded", channel: "general" } }),
    makeMedia({
      id: "m-fetch",
      name: "trace.png",
      type: "image/png",
      origin: { kind: "fetched", agent: "laozhou", session: "s-1" as SessionId, from: { path: "out/trace.png" } },
    }),
  ];

  expect(resolveNoteContext(notes[0], lookup)).toEqual({ repo: "vibevalley", issueId: "i-parent", channelId: "general" });
  expect(resolveMediaContext(media[0], lookup)).toEqual({ repo: "docs-site", channelId: "marketing" });
  expect(resolveMediaContext(media[2], lookup)).toEqual({ repo: "vibevalley", issueId: "i-parent", channelId: "general" });

  const options = buildCategoryFilterOptions({ notes, media, lookup, extraRepos: ["extra-repo"] });
  expect(options.repos.map((r) => r.value)).toEqual(["docs-site", "extra-repo", "vibevalley"]);
  expect(options.issues.map((p) => p.value)).toEqual(["i-docs", "i-parent"]);
  expect(options.channels.map((c) => c.value)).toEqual(["general", "marketing"]);

  expect(shownNotes(notes, { sort: "recent", category: { repo: "vibevalley" }, lookup }).map((n) => n.id)).toEqual(["note-child"]);
  expect(shownNotes(notes, { sort: "recent", category: { issueId: "i-parent" }, lookup }).map((n) => n.id)).toEqual(["note-child"]);
  expect(shownNotes(notes, { sort: "recent", category: { channelId: "marketing" }, lookup }).map((n) => n.id)).toEqual(["note-site"]);

  expect(shownMedia(media, { category: { repo: "vibevalley" }, lookup }).map((m) => m.attachment.id)).toEqual(["m-up", "m-fetch"]);
  expect(shownMedia(media, { category: { issueId: "i-parent" }, lookup }).map((m) => m.attachment.id)).toEqual(["m-fetch"]);
  expect(shownMedia(media, { category: { origin: "generated" }, lookup }).map((m) => m.attachment.id)).toEqual(["m-gen"]);
  expect(countCategoryFilters({ repo: "vibevalley", issueId: "i-parent" })).toBe(2);
});
