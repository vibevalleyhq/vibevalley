import { effect, keymap, Picker, Scroll, signal, Text, untracked, View, windowSize } from "nsh";

import { t } from "@vibevalley/i18n";
import { type LibraryItem, type LibrarySort, LibrarySortValues, type MediaJob, type Note } from "@vibevalley/protocol";

import { Button } from "../../design/Button";
import { Icon } from "../../design/Icon";
import { Empty } from "../../design/layout";
import { readFiles } from "../../design/picked";
import { CountPill } from "../../design/Tag";
import { toast } from "../../design/toasts";
import { createAct } from "../../infra/act";
import { api, reasonOf } from "../../infra/api";
import { attachmentData, decodeBase64Utf8 } from "../../infra/attachment";
import { importLocalAttachment, localPathFromUri } from "../../infra/attachmentFile";
import { hostApi } from "../../infra/bridge";
import { useBoardSlice, useCollabSlice, useOpsSlice, useSessionsSlice } from "../../infra/frame";
import { currentHost } from "../../infra/host";
import { libraryQuery } from "../../infra/libraryQuery";
import { ready, useAgents, useQuery, useQueryClient, useRepos } from "../../infra/query";
import { useRouter, useSearchParams } from "../../infra/router";
import { createMemo } from "../../infra/solid";
import {
  type ContentBucket,
  contentBrowseBucket,
  contentFocusMediaId,
  contentSidebarOpen,
  isPinned,
  openTemplatePicker,
  pinnedKeys,
  templatePickerContextFor,
  togglePinned,
} from "../../infra/state/contentNav";
import { prefsNow } from "../../infra/state/prefs";
import { useVdpNode } from "../../infra/vdpProbe";
import { InstallAppletModal, noteHref, useInstalledApplets, useNotes } from "../note";
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
  shownMedia,
  shownNotes,
  understoodText,
} from "./items";
import {
  importNoteFile,
  isMediaMakeSupported,
  LibraryLightbox,
  LibraryMakeDialog,
  LibraryUnderstandDialog,
  type MakeTab,
  makeTabs,
  noteFileNameRe,
  titleOfBucket,
} from "./LibraryDialogs";
import { LibraryToolbar } from "./LibraryToolbar";
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
import { publicationKey } from "./publication";
import { knows, MakingTiles, NoteTiles, ratioOf, type Seen, tileGap, Tiles } from "./Tiles";

const tileMin = 96;
const tileMax = 280;

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
    if (measured !== undefined && measured > 0) return Math.max(220, measured - 32);
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

  const make = createMemo((): MakeTab | undefined => {
    const m = search().get("make");
    return makeTabs.find((x) => x === m);
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
        <LibraryToolbar
          bucketTitle={bucketTitle()}
          bucket={bucket()}
          totalCount={totalCount()}
          hasCategoryOptions={hasCategoryOptions()}
          compactToolbar={compactToolbar()}
          activeCategoryCount={activeCategoryCount()}
          category={category()}
          effectiveCategory={effectiveCategory()}
          categoryOptions={categoryOptions()}
          effectiveSort={effectiveSort()}
          sortOptions={sortOptions()}
          tile={tile()}
          hasVisibleMedia={visibleMedia().length > 0}
          appsOnly={appsOnly()}
          pinnedOnly={pinnedOnly()}
          busy={act.busy()}
          onCategory={(next) => category.set(next)}
          onSort={(next) => sort.set(next)}
          onMake={(next) => setSearch({ make: next })}
          onPickFiles={() => void pickFiles()}
        />

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

      <LibraryMakeDialog make={make()} onSelect={(value) => setSearch({ make: value })} onClose={() => setSearch({ make: undefined })} />

      <LibraryUnderstandDialog file={understanding()} onClose={() => setSearch({ understand: undefined })} />

      <If when={appletTarget()}>{(n) => <InstallAppletModal open note={n()} onClose={() => appletTarget.set(undefined)} />}</If>
    </View>
  );
}
