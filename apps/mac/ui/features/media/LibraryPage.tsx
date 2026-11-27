import { effect, keymap, Picker, Scroll, signal, Text, untracked, View, windowSize } from "nsh";
import { Popover } from "nsh/base";

import { t } from "@vibevalley/i18n";
import { type LibraryItem, type LibrarySort, LibrarySortValues, type MediaJob, type Note, type NoteType } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { Dialog } from "../../design/Dialog";
import { Select } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { Empty } from "../../design/layout";
import { Lightbox, type Picture } from "../../design/Lightbox";
import { readFiles } from "../../design/picked";
import { Segmented } from "../../design/Segmented";
import { CountPill } from "../../design/Tag";
import { toast } from "../../design/toasts";
import { api, reasonOf } from "../../infra/api";
import { attachmentData, decodeBase64Utf8 } from "../../infra/attachment";
import { fileUrl, importLocalAttachment, localPathFromUri, useAttachmentFile } from "../../infra/attachmentFile";
import { hostApi } from "../../infra/bridge";
import { useBoardSlice, useCollabSlice, useOpsSlice, useSessionsSlice } from "../../infra/frame";
import { currentHost } from "../../infra/host";
import { ready, useAgents, useQuery, useQueryClient, useRepos } from "../../infra/query";
import { useRouter, useSearchParams } from "../../infra/router";
import { createMemo } from "../../infra/solid";
import {
  type ContentBucket,
  contentBrowseBucket,
  contentFocusMediaId,
  contentSidebarOpen,
  isPinned,
  openContentSearch,
  openTemplatePicker,
  pinnedKeys,
  templatePickerContextFor,
  togglePinned,
} from "../../infra/state/contentNav";
import { prefsNow, setLibraryTile } from "../../infra/state/prefs";
import { useVdpNode } from "../../infra/vdpProbe";
import { InstallAppletModal, noteHref, noteTypeLabel, useInstalledApplets, useNotes } from "../note";
import { AudioPanel } from "./AudioPanel";
import { ImagePanel } from "./ImagePanel";
import { Inspector } from "./Inspector";
import {
  buildCategoryFilterOptions,
  type ContentCategoryFilter,
  type ContentContextLookup,
  countCategoryFilters,
  emptyCategoryFilter,
  hasAnyCategoryFilter,
  justify,
  kindOf,
  making,
  type Names,
  neighbor,
  type NoteTypeFilter,
  shownMedia,
  shownNotes,
  textToDocJson,
  understoodText,
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
  isAppsBucket,
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
import { libraryQuery } from "./listing";
import { publicationKey } from "./publication";
import { SpeechPanel } from "./SpeechPanel";
import { knows, MakingTiles, NoteTiles, ratioOf, type Seen, tileGap, Tiles } from "./Tiles";
import { UnderstandingPanel } from "./UnderstandingPanel";

type Make = "image" | "speech" | "audio";
const makes: readonly Make[] = ["image", "speech", "audio"];
const tileMin = 96;
const isMediaMakeSupported = (b: ContentBucket) => showsMediaInBucket(b) && bucketFileKind(b) !== "video" && bucketFileKind(b) !== "other";
const tileMax = 280;

const noteFileNameRe = /\.(?:base\.json|canvas\.json|whiteboard\.json|media\.json|md|markdown)$/iu;

function inferNoteFile(filename: string, content: string): { readonly title: string; readonly noteType: NoteType; readonly content: string } {
  const trimmed = filename.trim();
  if (/\.base\.json$/iu.test(trimmed)) {
    return { title: trimmed.replace(/\.base\.json$/iu, "") || trimmed, noteType: "base", content };
  }
  if (/\.(?:canvas|whiteboard)\.json$/iu.test(trimmed)) {
    return { title: trimmed.replace(/\.(?:canvas|whiteboard)\.json$/iu, "") || trimmed, noteType: "canvas", content };
  }
  if (/\.media\.json$/iu.test(trimmed)) {
    return { title: trimmed.replace(/\.media\.json$/iu, "") || trimmed, noteType: "media", content };
  }
  return {
    title: trimmed.replace(/\.(?:doc\.md|md|markdown)$/iu, "") || trimmed,
    noteType: "doc",
    content: textToDocJson(content),
  };
}

function importNoteFile(filename: string, content: string): Promise<Note> {
  const inferred = inferNoteFile(filename, content);
  return api.note.create({
    title: inferred.title,
    noteType: inferred.noteType,
    content: inferred.content,
  });
}

function noteTypeTitle(type: NoteTypeFilter | undefined): string {
  if (type === undefined) return t("web.library.content.artifactType.all");
  return noteTypeLabel(type);
}

function titleOfBucket(bucket: ContentBucket): string {
  switch (bucket.kind) {
    case "recent":
      return t("web.library.content.recent");
    case "pinned":
      return t("web.library.content.pinned");
    case "apps":
      return t("web.library.content.installedApps");
    case "notes":
      return noteTypeTitle(bucket.noteType);
    case "media":
      return bucket.fileKind === undefined ? t("web.library.content.media") : t(`web.library.kind.${bucket.fileKind}`);
  }
}

export function LibraryPage() {
  useVdpNode({ testId: "library-page", role: "region" });
  const ops = useOpsSlice();
  const board = useBoardSlice();
  const collab = useCollabSlice();
  const sessions = useSessionsSlice();
  const agents = useAgents();
  const reposQuery = useRepos();
  const router = useRouter();
  const queries = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const sort = signal<LibrarySort>("recent");
  const category = signal<ContentCategoryFilter>(emptyCategoryFilter);
  const items = useQuery(() => libraryQuery({ text: "", sort: sort() }), { interval: () => 10_000, keepPrevious: true });
  const notesQuery = useNotes(() => ({}));
  const installedApplets = useInstalledApplets();
  const selection = signal<LibrarySelection>(initialLibrarySelection);
  const dragging = signal(false);
  const gridWidth = signal<number | undefined>(undefined);
  const seen = signal<ReadonlyMap<string, Seen>>(new Map());
  const appletTarget = signal<Note | undefined>(undefined);
  const act = createAct();

  const bucket = () => contentBrowseBucket();
  const tile = () => Math.min(tileMax, Math.max(tileMin, prefsNow().libraryTile));
  const effectiveSort = createMemo((): LibrarySort => (!showsMediaInBucket(bucket()) && sort() === "size" ? "recent" : sort()));
  const sortOptions = createMemo(() => {
    const allowed = showsMediaInBucket(bucket()) ? LibrarySortValues : LibrarySortValues.filter((v) => v !== "size");
    return allowed.map((value) => ({ value, label: t(`web.library.sort.${value}`) }));
  });
  const allMedia = createMemo((): readonly LibraryItem[] => ready(items, undefined) ?? []);
  const allNotes = createMemo((): readonly Note[] => ready(notesQuery, undefined) ?? []);
  const installedMap = createMemo(
    () =>
      new Map(
        installedApplets()
          .filter((item) => item.installed)
          .map((item) => [item.noteId, item]),
      ),
  );
  const jobs = (): readonly MediaJob[] => ops()?.media ?? [];
  const mediaSummary = () => ops()?.mediaSummary;
  const working = createMemo(() => making(jobs(), mediaSummary()));
  const activeMediaCount = () => mediaSummary()?.activeCount ?? working().length;

  const pinnedSet = createMemo(() => new Set(pinnedKeys()));
  const pinnedOnly = () => isPinnedBucket(bucket());
  const appsOnly = () => isAppsBucket(bucket());

  const contextLookup = createMemo((): ContentContextLookup => ({
    issuesById: new Map((board()?.issues ?? []).map((issue) => [issue.id, issue])),
    channelsById: new Map((collab()?.chat?.channels ?? []).map((ch) => [ch.id, ch])),
    sessionsById: new Map((sessions()?.sessions ?? []).map((s) => [s.id, s])),
    jobsById: new Map(jobs().map((job) => [job.id, job])),
  }));
  const effectiveCategory = createMemo((): ContentCategoryFilter => {
    const cur = category();
    return showsMediaInBucket(bucket()) ? cur : { ...cur, origin: undefined };
  });
  const categoryOptions = createMemo(() =>
    buildCategoryFilterOptions({
      notes: allNotes(),
      media: allMedia(),
      lookup: contextLookup(),
      extraRepos: ready(reposQuery, []).map((r) => r.name),
    }),
  );
  const hasCategoryOptions = createMemo(
    () => categoryOptions().repos.length > 0 || categoryOptions().issues.length > 0 || categoryOptions().channels.length > 0,
  );
  const activeCategoryCount = createMemo(() => countCategoryFilters(effectiveCategory()));
  const compactToolbar = createMemo(() => {
    const measured = gridWidth();
    const w = measured !== undefined && measured > 0 ? measured : windowSize().width - (contentSidebarOpen.get() ? 232 : 0) - 76;
    return w < 920;
  });

  const visibleNotes = createMemo(() => {
    if (!showsNotesInBucket(bucket())) return [];
    const base = shownNotes(allNotes(), {
      noteType: bucketNoteType(bucket()),
      sort: effectiveSort(),
      pinnedOnly: pinnedOnly(),
      pinned: pinnedSet(),
      category: effectiveCategory(),
      lookup: contextLookup(),
    });
    return appsOnly() ? base.filter((n) => installedMap().has(n.id)) : base;
  });
  const visibleMedia = createMemo(() =>
    showsMediaInBucket(bucket())
      ? shownMedia(allMedia(), {
          fileKind: bucketFileKind(bucket()),
          pinnedOnly: pinnedOnly(),
          pinned: pinnedSet(),
          category: effectiveCategory(),
          lookup: contextLookup(),
        })
      : [],
  );

  const totalCount = createMemo(() => visibleNotes().length + visibleMedia().length);
  const sectionCount = createMemo(() => (visibleNotes().length > 0 ? 1 : 0) + (visibleMedia().length > 0 ? 1 : 0));
  const ids = createMemo(() => visibleMedia().map((item) => item.attachment.id));
  const imageItems = createMemo(() => visibleMedia().filter((item) => kindOf(item.attachment.type) === "image"));

  const picked = () => selectedFileIds(selection());
  const active = () => activeFileId(selection());
  const looking = () => lightboxIndex(selection());
  const asking = () => isAskingRemove(selection());

  const chosen = createMemo(() => {
    const on = new Set(picked());
    return allMedia().filter((item) => on.has(item.attachment.id));
  });
  const inspectorOpen = createMemo(() => chosen().length > 0);

  const inner = createMemo(() => {
    const measured = gridWidth();
    if (measured !== undefined && measured > 0) {
      return Math.max(220, measured - 32);
    }
    const w = windowSize().width;
    const appRailW = w < 640 ? 68 : 76;
    const sideW = contentSidebarOpen.get() ? 232 : 0;
    const inspW = inspectorOpen() && w >= 640 ? 304 : 0;
    return Math.max(220, w - appRailW - sideW - inspW - 36);
  });

  const rows = createMemo(() => {
    const known = seen();
    return justify({
      ratios: visibleMedia().map((item) => ratioOf({ item, seen: known.get(item.attachment.id) })),
      width: inner(),
      height: tile(),
      gap: tileGap,
    });
  });

  const names: Names = {
    agent: (id) => (ready(agents, undefined) ?? []).find((a) => a.id === id)?.name ?? id,
    channel: (id) => {
      const c = (collab()?.chat?.channels ?? []).find((x) => x.id === id);
      return c === undefined ? id : `#${c.name ?? c.id}`;
    },
  };

  let lastReadyCount: number | undefined;
  effect(() => {
    const n = jobs().filter((job) => job.phase === "ready").length;
    if (lastReadyCount !== undefined && n !== lastReadyCount) void items.refetch();
    lastReadyCount = n;
  });

  let prevBucket: ContentBucket | undefined;
  effect(() => {
    const current = bucket();
    if (prevBucket !== undefined && prevBucket !== current) {
      selection.set(selectBucketSelection(untracked(selection), current));
    }
    prevBucket = current;
  });

  effect(() => {
    const targetId = contentFocusMediaId();
    if (!targetId) return;
    const currentBucket = untracked(contentBrowseBucket);
    if (!showsMediaInBucket(currentBucket) || isPinnedBucket(currentBucket)) {
      contentBrowseBucket.set({ kind: "media" });
    }
    const mediaList = allMedia();
    const target = mediaList.find((item) => item.attachment.id === targetId);
    if (target === undefined && ready(items, undefined) === undefined) return;
    if (target !== undefined) {
      const currentKind = bucketFileKind(untracked(contentBrowseBucket));
      if (currentKind !== undefined && kindOf(target.attachment.type) !== currentKind) {
        contentBrowseBucket.set({ kind: "media" });
      }
      selection.set(focusFile(targetId));
    }
    contentFocusMediaId.set(undefined);
  });

  effect(() => {
    const cur = untracked(selection);
    const next = reconcileSelection(cur, {
      fileIds: ids(),
      imageCount: imageItems().length,
    });
    if (next !== cur) selection.set(next);
  });

  const make = createMemo((): Make | undefined => {
    const m = search().get("make");
    return makes.find((x) => x === m);
  });
  const understanding = createMemo(() => {
    const id = search().get("understand");
    if (id === null || id === "") return undefined;
    return allMedia().find((item) => item.attachment.id === id)?.attachment ?? { id, name: id, type: "", size: 0 };
  });

  const openNote = (id: string) => router.navigate(noteHref(id));

  const handleTogglePin = (key: string) => {
    const nowPinned = togglePinned(key);
    toast(nowPinned ? t("web.library.content.pinnedToast") : t("web.library.content.unpinnedToast"));
  };

  const finishUpload = async (lastNote: Note | undefined, lastMedia: LibraryItem | undefined) => {
    if (lastNote !== undefined) {
      await queries.invalidate({ prefix: ["notes"] });
      if (lastMedia === undefined) openNote(lastNote.id);
    }
    if (lastMedia !== undefined) {
      void items.refetch();
      selection.set(focusFile(lastMedia.attachment.id));
    }
  };

  const uploadEntries = (entries: readonly { name: string; type: string; data: Promise<string> }[]) =>
    entries.length === 0
      ? Promise.resolve()
      : act.run(async () => {
          let lastMedia: LibraryItem | undefined;
          let lastNote: Note | undefined;
          for (const entry of entries) {
            const data = await entry.data;
            const filename = entry.name.trim() || "file";
            if (noteFileNameRe.test(filename)) {
              lastNote = await importNoteFile(filename, decodeBase64Utf8(data));
            } else {
              const kept = await api.attachment.create({
                name: filename,
                type: entry.type === "" ? "application/octet-stream" : entry.type,
                data,
              });
              lastMedia = await api.library.item.add({ attachment: kept.id });
            }
          }
          await finishUpload(lastNote, lastMedia);
        });

  const pickFiles = async () => {
    const chosenFiles = readFiles(await Picker.pickFiles({ multiple: true }));
    await uploadEntries(chosenFiles.map((file) => ({ name: file.name, type: file.type, data: attachmentData(file) })));
  };

  const dropUris = (uris: readonly string[]) =>
    uris.length === 0
      ? Promise.resolve()
      : act.run(async () => {
          let lastMedia: LibraryItem | undefined;
          let lastNote: Note | undefined;
          for (const uri of uris) {
            const pathOrUri = localPathFromUri(uri) ?? uri;
            const basename = pathOrUri.split("/").at(-1)?.trim() ?? "";
            if (noteFileNameRe.test(basename)) {
              const read = await hostApi.readFile(uri);
              if (read.bizCode !== 0 || !read.data) continue;
              const filename = read.data.name.trim() || basename || "file";
              lastNote = await importNoteFile(filename, decodeBase64Utf8(read.data.data));
            } else {
              const kept = await importLocalAttachment(uri);
              lastMedia = await api.library.item.add({ attachment: kept.id });
            }
          }
          await finishUpload(lastNote, lastMedia);
        });

  const pick = (id: string, how: { readonly add: boolean; readonly range: boolean }) => {
    selection.set(pickFile(untracked(selection), id, how, ids()));
  };

  const look = (id: string | undefined) => {
    const images = imageItems();
    const at = images.findIndex((p) => p.attachment.id === id);
    if (at >= 0) selection.set(openLightbox(untracked(selection), at, images.length));
  };

  const send = (channel: string) => {
    const files = chosen();
    const attachments = files.map((item) => item.attachment.id);
    const words = files.map((item) => item.attachment.name).join("\n");
    return act.run(() =>
      publicationKey(`library:${attachments.join(",")}`, channel)
        .then((sendKey) => api.channel.message.send({ id: channel, text: words, attachments, sendKey }))
        .then(() => toast(t("web.library.sentTo", { channel: names.channel(channel) }))),
    );
  };

  const remove = () => {
    const gone = picked();
    return act.run(() =>
      Promise.all(gone.map((id) => api.library.item.delete({ id }))).then(() => {
        selection.set(clearSelection());
        void items.refetch();
      }),
    );
  };

  const stepKey = (way: "left" | "right" | "up" | "down") => {
    const at = active();
    const index = at === undefined ? -1 : ids().indexOf(at);
    const next = index < 0 ? 0 : neighbor({ rows: rows(), index, key: way });
    const id = next === undefined ? undefined : ids()[next];
    if (id !== undefined) pick(id, { add: false, range: false });
  };

  keymap.bind(
    {
      left: () => stepKey("left"),
      right: () => stepKey("right"),
      up: () => stepKey("up"),
      down: () => stepKey("down"),
      space: () => {
        const at = active();
        if (at !== undefined) look(at);
      },
      backspace: () => {
        if (inspectorOpen()) selection.set(askRemove(untracked(selection)));
      },
      delete: () => {
        if (inspectorOpen()) selection.set(askRemove(untracked(selection)));
      },
      escape: () => {
        if (inspectorOpen()) selection.set(clearSelection());
      },
    },
    { when: "notEditing", passThrough: true },
  );

  const empty = () => allNotes().length === 0 && allMedia().length === 0 && activeMediaCount() === 0;
  const nothingShown = () => totalCount() === 0;
  const bucketTitle = () => titleOfBucket(bucket());

  return (
    <View
      testID="library-page"
      class="relative h-full min-h-0 min-w-0 flex-1 flex-row overflow-hidden"
      onFileDragEnter={() => dragging.set(true)}
      onFileDragLeave={() => dragging.set(false)}
      onFileDrop={(e) => {
        dragging.set(false);
        void dropUris(e.uris);
      }}
    >
      <View class="min-h-0 min-w-0 flex-1">
        <View
          role="toolbar"
          accessibilityLabel={bucketTitle()}
          desktop={{ windowDrag: true }}
          class="h-11 shrink-0 flex-row items-center gap-2 border-b border-line bg-page px-3"
        >
          <If when={!contentSidebarOpen.get()}>
            <IconButton
              icon="sidebar"
              size={16}
              label={t("web.library.content.sidebarToggle")}
              testid="content-sidebar-toggle"
              pressed={false}
              onClick={() => contentSidebarOpen.set(true)}
            />
          </If>
          <View class="min-w-0 flex-row items-center gap-2">
            <Text testID="library-bucket-title" class="truncate text-sm font-semibold text-ink">
              {bucketTitle()}
            </Text>
            <CountPill count={totalCount()} />
          </View>
          <If when={hasCategoryOptions()}>
            <If
              when={!compactToolbar()}
              else={
                <Popover
                  placement="bottom"
                  align="start"
                  offset={6}
                  popupClass="w-72 gap-2.5 rounded-lg border border-line bg-elevated p-3 shadow-float"
                  popupStyle={{ maxWidth: Math.max(240, windowSize().width - 24) }}
                  trigger={
                    <View
                      testID="library-filter-popover"
                      role="button"
                      accessibilityLabel={t("web.issue.page.filter")}
                      class={`h-7 shrink-0 flex-row items-center gap-1.5 rounded-md border border-line px-2.5 ${
                        activeCategoryCount() > 0 ? "bg-selected" : "bg-page hover:bg-hover"
                      }`}
                    >
                      <Icon name="filter" size={14} tone={activeCategoryCount() > 0 ? "accent" : "muted"} />
                      <Text class="text-sm text-ink">{t("web.issue.page.filter")}</Text>
                      <If when={activeCategoryCount() > 0}>
                        <CountPill count={activeCategoryCount()} active />
                      </If>
                    </View>
                  }
                >
                  <View testID="library-filter-popover-menu" class="gap-2.5">
                    <If when={categoryOptions().repos.length > 0}>
                      <View class="gap-1">
                        <Text class="text-xs font-medium text-muted">{t("web.issue.page.byRepo")}</Text>
                        <Select
                          size="control"
                          class="w-full"
                          label={t("web.issue.page.byRepo")}
                          testid="library-filter-repo"
                          filter
                          value={category().repo ?? ""}
                          placeholder={t("web.issue.page.allRepos")}
                          options={categoryOptions().repos}
                          onChange={(repo) => category.set({ ...category(), repo: repo || undefined })}
                        />
                      </View>
                    </If>
                    <If when={categoryOptions().issues.length > 0}>
                      <View class="gap-1">
                        <Text class="text-xs font-medium text-muted">{t("web.base.place.issues.label")}</Text>
                        <Select
                          size="control"
                          class="w-full"
                          label={t("web.base.place.issues.label")}
                          testid="library-filter-issue"
                          filter
                          value={category().issueId ?? ""}
                          placeholder={t("web.issue.list.all")}
                          options={categoryOptions().issues}
                          onChange={(issueId) => category.set({ ...category(), issueId: issueId || undefined })}
                        />
                      </View>
                    </If>
                    <If when={categoryOptions().channels.length > 0}>
                      <View class="gap-1">
                        <Text class="text-xs font-medium text-muted">{t("web.channel.channelsTitle")}</Text>
                        <Select
                          size="control"
                          class="w-full"
                          label={t("web.channel.channelsTitle")}
                          testid="library-filter-channel"
                          filter
                          value={category().channelId ?? ""}
                          placeholder={t("web.channel.filter.all")}
                          options={categoryOptions().channels}
                          onChange={(channelId) => category.set({ ...category(), channelId: channelId || undefined })}
                        />
                      </View>
                    </If>
                    <If when={hasAnyCategoryFilter(effectiveCategory())}>
                      <View class="flex-row justify-end border-t border-line pt-2">
                        <Button size="compact" tone="quiet" testID="library-filter-clear" onPress={() => category.set(emptyCategoryFilter)}>
                          {t("web.issue.page.clear")}
                        </Button>
                      </View>
                    </If>
                  </View>
                </Popover>
              }
            >
              <View testID="library-filter-bar" class="shrink-0 flex-row items-center rounded-md border border-line bg-side pl-2">
                <Icon name="filter" size={14} tone={activeCategoryCount() > 0 ? "accent" : "faint"} />
                <If when={categoryOptions().repos.length > 0}>
                  <View class="mx-1.5 h-3.5 w-px bg-line" />
                  <Select
                    quiet
                    size="control"
                    class="max-w-24"
                    label={t("web.issue.page.byRepo")}
                    testid="library-filter-repo"
                    filter
                    value={category().repo ?? ""}
                    placeholder={t("web.issue.page.allRepos")}
                    options={categoryOptions().repos}
                    onChange={(repo) => category.set({ ...category(), repo: repo || undefined })}
                  />
                </If>
                <If when={categoryOptions().issues.length > 0}>
                  <View class="h-3.5 w-px bg-line" />
                  <Select
                    quiet
                    size="control"
                    class="max-w-28"
                    label={t("web.base.place.issues.label")}
                    testid="library-filter-issue"
                    filter
                    value={category().issueId ?? ""}
                    placeholder={t("web.issue.list.all")}
                    options={categoryOptions().issues}
                    onChange={(issueId) => category.set({ ...category(), issueId: issueId || undefined })}
                  />
                </If>
                <If when={categoryOptions().channels.length > 0}>
                  <View class="h-3.5 w-px bg-line" />
                  <Select
                    quiet
                    size="control"
                    class="max-w-24"
                    label={t("web.channel.channelsTitle")}
                    testid="library-filter-channel"
                    filter
                    value={category().channelId ?? ""}
                    placeholder={t("web.channel.filter.all")}
                    options={categoryOptions().channels}
                    onChange={(channelId) => category.set({ ...category(), channelId: channelId || undefined })}
                  />
                </If>
              </View>
              <If when={hasAnyCategoryFilter(effectiveCategory())}>
                <IconButton
                  icon="close"
                  size={14}
                  testid="library-filter-clear"
                  label={t("web.issue.page.clear")}
                  onClick={() => category.set(emptyCategoryFilter)}
                />
              </If>
            </If>
          </If>
          <View class="min-w-0 flex-1" />
          <If when={!contentSidebarOpen.get()}>
            <IconButton icon="search" size={14} label={t("web.library.content.searchAll")} testid="content-search-btn" onClick={() => openContentSearch()} />
          </If>
          <Select
            label={t("web.library.sortLabel")}
            testid="library-sort"
            size="control"
            quiet
            value={effectiveSort()}
            onChange={(v) => sort.set(v)}
            options={sortOptions()}
          />
          <If when={showsMediaInBucket(bucket()) && visibleMedia().length > 0}>
            <Segmented
              label={t("web.library.tileSize")}
              testid="library-tile-size"
              value={tile() <= 128 ? "sm" : tile() >= 220 ? "lg" : "md"}
              onChange={(v) => setLibraryTile(v === "sm" ? 112 : v === "lg" ? 240 : 160)}
              options={[
                { value: "sm", label: "S" },
                { value: "md", label: "M" },
                { value: "lg", label: "L" },
              ]}
            />
          </If>
          <If when={isMediaMakeSupported(bucket())}>
            <Button
              size="compact"
              tone="quiet"
              testID="library-make-btn"
              icon="generate"
              onPress={() => setSearch({ make: bucketFileKind(bucket()) === "audio" ? "audio" : "image" })}
            >
              {t("web.library.make")}
            </Button>
          </If>
          <If when={!appsOnly() && !pinnedOnly()}>
            <Button size="compact" tone="quiet" testID="library-upload" icon="upload" disabled={act.busy()} onPress={() => void pickFiles()}>
              {act.busy() ? t("web.library.uploading") : t("web.library.upload")}
            </Button>
          </If>
        </View>

        <Scroll
          testID="library-grid"
          onLayout={(e) => {
            const w = Math.floor(e.bounds.size.width);
            if (w > 0 && w !== untracked(gridWidth)) gridWidth.set(w);
          }}
          class="min-h-0 flex-1"
          contentClass="gap-5 p-4"
        >
          <If
            when={!empty()}
            else={
              <Empty
                icon="media"
                testid="library-empty"
                action={
                  <View class="items-center gap-3">
                    <Text class="max-w-96 text-center text-sm text-muted">{t("web.library.emptyHow")}</Text>
                    <View class="flex-row justify-center gap-2">
                      <Button icon="upload" onPress={() => void pickFiles()}>
                        {t("web.library.upload")}
                      </Button>
                      <Button tone="primary" icon="add" onPress={() => openTemplatePicker()}>
                        {t("web.library.content.new")}
                      </Button>
                      <Button icon="generate" onPress={() => setSearch({ make: "image" })}>
                        {t("web.library.make")}
                      </Button>
                    </View>
                  </View>
                }
              >
                {t("web.library.empty")}
              </Empty>
            }
          >
            <If when={showsMediaInBucket(bucket()) && !pinnedOnly() && activeMediaCount() > 0 && working().length > 0}>
              <MakingTiles jobs={working()} width={inner()} height={tile()} label={(job) => t(`web.library.job.${job.kind}`)} />
            </If>
            <If
              when={!nothingShown()}
              else={
                <Empty
                  icon={appsOnly() ? "devices" : pinnedOnly() ? "pin" : showsNotesInBucket(bucket()) && !showsMediaInBucket(bucket()) ? "notes" : "media"}
                  testid={appsOnly() ? "library-apps-empty" : "library-nothing-shown"}
                  action={
                    <View class="flex-row flex-wrap items-center justify-center gap-2">
                      <If when={hasAnyCategoryFilter(effectiveCategory())}>
                        <Button icon="close" testID="library-filter-clear-empty" onPress={() => category.set(emptyCategoryFilter)}>
                          {t("web.issue.page.clear")}
                        </Button>
                      </If>
                      <If when={bucket().kind === "notes"}>
                        <Button tone="primary" icon="add" onPress={() => openTemplatePicker(templatePickerContextFor(bucket()))}>
                          {t("web.library.content.new")}
                        </Button>
                      </If>
                      <If when={bucket().kind === "media"}>
                        <>
                          <Button icon="upload" onPress={() => void pickFiles()}>
                            {t("web.library.upload")}
                          </Button>
                          <If when={isMediaMakeSupported(bucket())}>
                            <Button
                              tone="primary"
                              icon="generate"
                              onPress={() => setSearch({ make: bucketFileKind(bucket()) === "audio" ? "audio" : "image" })}
                            >
                              {t("web.library.make")}
                            </Button>
                          </If>
                        </>
                      </If>
                    </View>
                  }
                >
                  {appsOnly()
                    ? t("web.library.content.installedAppsEmpty")
                    : pinnedOnly()
                      ? t("web.library.content.pinnedEmpty")
                      : t("web.library.nothingShown")}
                </Empty>
              }
            >
              <If when={visibleNotes().length > 0}>
                <View class="gap-2.5">
                  <If when={sectionCount() > 1}>
                    <View class="flex-row items-center gap-1.5">
                      <Text class="text-xs font-semibold text-muted">{t("web.library.content.artifacts")}</Text>
                      <CountPill count={visibleNotes().length} hoverBright />
                    </View>
                  </If>
                  <NoteTiles
                    notes={visibleNotes()}
                    width={inner()}
                    onOpen={(id) => openNote(id)}
                    isPinned={(id) => isPinned(`note:${id}`)}
                    onTogglePin={(id) => handleTogglePin(`note:${id}`)}
                    onDelete={(n) => {
                      void act.run(async () => {
                        await api.note.delete({ id: n.id });
                        toast(t("web.note.page.deleted", { title: n.title }));
                        void queries.invalidate({ prefix: ["notes"] });
                      });
                    }}
                    installedApplets={installedMap()}
                    canInstallApplet={currentHost().applet !== undefined}
                    onInstallApplet={(n) => appletTarget.set(n)}
                    onOpenApplet={(id) =>
                      void currentHost()
                        .applet?.open(id)
                        .then(
                          () => toast(t("web.note.applet.openedToast", { name: installedMap().get(id)?.appName ?? id })),
                          (e: unknown) => toast(reasonOf(e), "bad"),
                        )
                    }
                  />
                </View>
              </If>
              <If when={visibleMedia().length > 0}>
                <View class="gap-2.5">
                  <If when={sectionCount() > 1}>
                    <View class="flex-row items-center gap-1.5">
                      <Text class="text-xs font-semibold text-muted">{t("web.library.content.media")}</Text>
                      <CountPill count={visibleMedia().length} hoverBright />
                    </View>
                  </If>
                  <Tiles
                    items={visibleMedia()}
                    rows={rows()}
                    picked={picked()}
                    active={active()}
                    isPinned={(id) => isPinned(`media:${id}`)}
                    onTogglePin={(id) => handleTogglePin(`media:${id}`)}
                    seen={(id) => seen().get(id)}
                    onSeen={(id, s) => {
                      const was = seen();
                      const had = was.get(id);
                      if (had !== undefined && knows({ had, learnt: s })) return;
                      const next = new Map(was);
                      next.set(id, { ...had, ...s });
                      seen.set(next);
                    }}
                    onPick={(id, how) => pick(id, how)}
                    onLook={(id) => look(id)}
                  />
                </View>
              </If>
            </If>
          </If>
        </Scroll>
      </View>

      <If when={inspectorOpen()}>
        <Inspector
          items={chosen()}
          pinned={chosen().length === 1 && isPinned(`media:${chosen()[0]?.attachment.id ?? ""}`)}
          seen={chosen().length === 1 ? seen().get(chosen()[0]?.attachment.id ?? "") : undefined}
          understood={chosen().length === 1 ? understoodText(chosen()[0]?.attachment.id ?? "")(jobs()) : undefined}
          names={names}
          asking={asking()}
          act={{
            channels: collab()?.chat?.channels ?? [],
            send: (channel) => void send(channel),
            understand: () => setSearch({ understand: chosen()[0]?.attachment.id }),
            look: () => look(chosen()[0]?.attachment.id),
            togglePin: (id) => handleTogglePin(`media:${id}`),
            ask: () => selection.set(askRemove(untracked(selection))),
            remove: () => void remove(),
            keep: () => selection.set(cancelRemove(untracked(selection))),
            clear: () => selection.set(clearSelection()),
          }}
        />
      </If>

      <If when={dragging()}>
        <View
          testID="library-drop"
          class="pointer-events-none absolute inset-2 z-20 flex-row items-center justify-center gap-2 rounded-xl border-2 border-dashed border-accent bg-page p-4"
        >
          <Icon name="upload" size={20} />
          <Text class="text-base text-ink">{t("web.library.drop")}</Text>
        </View>
      </If>

      <LibraryLightbox
        items={imageItems()}
        at={looking()}
        onAt={(at) => selection.set(at === undefined ? closeLightbox(untracked(selection)) : openLightbox(untracked(selection), at, imageItems().length))}
      />

      <Dialog
        open={make() !== undefined}
        onClose={() => setSearch({ make: undefined })}
        title={t("web.library.makeTitle")}
        size="lg"
        height="fixed"
        toolbar={
          <Segmented
            label={t("web.library.makeTitle")}
            testid="library-make-form"
            value={make() ?? "image"}
            onChange={(value) => setSearch({ make: value })}
            options={makes.map((value) => ({ value, label: t(`web.library.makeTabs.${value}`) }))}
          />
        }
        testid="library-make-dialog"
      >
        <If when={make() === "image"}>
          <ImagePanel />
        </If>
        <If when={make() === "speech"}>
          <SpeechPanel />
        </If>
        <If when={make() === "audio"}>
          <AudioPanel />
        </If>
      </Dialog>

      <If when={understanding()}>
        {(file) => (
          <Dialog
            open
            onClose={() => setSearch({ understand: undefined })}
            title={t("web.library.understandTitle", { name: file().name })}
            size="lg"
            height="fixed"
            testid="library-understand-dialog"
          >
            <UnderstandingPanel file={file()} />
          </Dialog>
        )}
      </If>

      <If when={appletTarget()}>{(n) => <InstallAppletModal open note={n()} onClose={() => appletTarget.set(undefined)} />}</If>
    </View>
  );
}

function LibraryLightbox(props: { items: readonly LibraryItem[]; at: number | undefined; onAt: (at: number | undefined) => void }) {
  const curId = createMemo(() => (props.at !== undefined ? (props.items[props.at]?.attachment.id ?? "") : ""));
  const file = useAttachmentFile(curId);
  const pictures = createMemo((): readonly Picture[] =>
    props.items.map((item, i) => {
      const f = i === props.at ? file() : undefined;
      return {
        src: f ? fileUrl(f.path) : "",
        name: item.attachment.name,
        ...(f ? { path: f.path } : {}),
      };
    }),
  );
  return <Lightbox pictures={pictures()} at={props.at} onAt={props.onAt} />;
}
