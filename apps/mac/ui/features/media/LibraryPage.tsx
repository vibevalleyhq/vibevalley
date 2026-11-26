import { effect, keymap, Picker, Scroll, signal, Text, untracked, View, windowSize } from "nsh";

import { t } from "@vibevalley/i18n";
import { type Artifact, type LibraryItem, type LibrarySort, LibrarySortValues, type MediaJob } from "@vibevalley/protocol";

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
import { useCollabSlice, useOpsSlice } from "../../infra/frame";
import { currentHost } from "../../infra/host";
import { ready, useAgents, useQuery, useQueryClient } from "../../infra/query";
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
import { artifactTypeLabel, buildOutlineFromMarkdown, inferArtifactFromName, InstallAppletModal, useArtifacts, useInstalledApplets } from "../artifact";
import { AudioPanel } from "./AudioPanel";
import { ImagePanel } from "./ImagePanel";
import { Inspector } from "./Inspector";
import { type ArtifactTypeFilter, justify, kindOf, making, type Names, neighbor, shownArtifacts, shownMedia, understoodText } from "./items";
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
  showsArtifactsInBucket,
  showsMediaInBucket,
} from "./libraryView";
import { libraryQuery } from "./listing";
import { publicationKey } from "./publication";
import { SpeechPanel } from "./SpeechPanel";
import { ArtifactTiles, knows, MakingTiles, ratioOf, type Seen, tileGap, Tiles } from "./Tiles";
import { UnderstandingPanel } from "./UnderstandingPanel";

type Make = "image" | "speech" | "audio";
const makes: readonly Make[] = ["image", "speech", "audio"];
const tileMin = 96;
const isMediaMakeSupported = (b: ContentBucket) => showsMediaInBucket(b) && bucketFileKind(b) !== "video" && bucketFileKind(b) !== "other";
const tileMax = 280;

const deliverableNameRe =
  /\.(?:(?:slide|slides|visual|canvas|design|dashboard|motion|prototype|page)\.(?:json|html)|html|htm|whiteboard(?:\.json|\.html)?|(?:design-system|tokens|sheet|diagram|storyboard|outline)\.json|outline\.md|doc\.md|md|markdown)$/iu;
const markdownFileRe = /\.(?:md|markdown)$/iu;

function importDeliverable(filename: string, content: string, inOutlineBucket: boolean): Promise<Artifact> {
  const inferred = inferArtifactFromName(filename, content);
  if (inferred.artifactType === "outline" || (inOutlineBucket && markdownFileRe.test(filename))) {
    const outlineContent = markdownFileRe.test(filename) ? `${JSON.stringify(buildOutlineFromMarkdown(inferred.title, content), null, 2)}\n` : content;
    return api.artifact.create({
      title: inferred.title,
      artifactType: "outline",
      content: outlineContent,
    });
  }
  return api.artifact.create({
    title: inferred.title,
    artifactType: inferred.artifactType,
    content,
  });
}

function artifactTypeTitle(type: ArtifactTypeFilter | undefined): string {
  if (type === undefined) return t("web.library.content.artifactType.all");
  return artifactTypeLabel(type);
}

function titleOfBucket(bucket: ContentBucket): string {
  switch (bucket.kind) {
    case "recent":
      return t("web.library.content.recent");
    case "pinned":
      return t("web.library.content.pinned");
    case "apps":
      return t("web.library.content.installedApps");
    case "artifacts":
      return artifactTypeTitle(bucket.artifactType);
    case "media":
      return bucket.fileKind === undefined ? t("web.library.content.media") : t(`web.library.kind.${bucket.fileKind}`);
  }
}

export function LibraryPage() {
  const ops = useOpsSlice();
  const collab = useCollabSlice();
  const agents = useAgents();
  const router = useRouter();
  const queries = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const sort = signal<LibrarySort>("recent");
  const items = useQuery(() => libraryQuery({ text: "", sort: sort() }), { interval: () => 10_000, keepPrevious: true });
  const artifactsQuery = useArtifacts(() => ({}));
  const installedApplets = useInstalledApplets();
  const selection = signal<LibrarySelection>(initialLibrarySelection);
  const dragging = signal(false);
  const seen = signal<ReadonlyMap<string, Seen>>(new Map());
  const appletTarget = signal<Artifact | undefined>(undefined);
  const act = createAct();

  const bucket = () => contentBrowseBucket();
  const tile = () => Math.min(tileMax, Math.max(tileMin, prefsNow().libraryTile));
  const effectiveSort = createMemo((): LibrarySort => (!showsMediaInBucket(bucket()) && sort() === "size" ? "recent" : sort()));
  const sortOptions = createMemo(() => {
    const allowed = showsMediaInBucket(bucket()) ? LibrarySortValues : LibrarySortValues.filter((v) => v !== "size");
    return allowed.map((value) => ({ value, label: t(`web.library.sort.${value}`) }));
  });
  const allMedia = createMemo((): readonly LibraryItem[] => ready(items, undefined) ?? []);
  const allArtifacts = createMemo((): readonly Artifact[] => ready(artifactsQuery, undefined) ?? []);
  const installedMap = createMemo(
    () =>
      new Map(
        installedApplets()
          .filter((item) => item.installed)
          .map((item) => [item.artifactId, item]),
      ),
  );
  const jobs = (): readonly MediaJob[] => ops()?.media ?? [];
  const mediaSummary = () => ops()?.mediaSummary;
  const working = createMemo(() => making(jobs(), mediaSummary()));
  const activeMediaCount = () => mediaSummary()?.activeCount ?? working().length;

  const pinnedSet = createMemo(() => new Set(pinnedKeys()));
  const pinnedOnly = () => isPinnedBucket(bucket());
  const appsOnly = () => isAppsBucket(bucket());

  const visibleArtifacts = createMemo(() => {
    if (!showsArtifactsInBucket(bucket())) return [];
    const base = shownArtifacts(allArtifacts(), {
      artifactType: bucketArtifactType(bucket()),
      sort: effectiveSort(),
      pinnedOnly: pinnedOnly(),
      pinned: pinnedSet(),
    });
    return appsOnly() ? base.filter((a) => installedMap().has(a.id)) : base;
  });
  const visibleMedia = createMemo(() =>
    showsMediaInBucket(bucket())
      ? shownMedia(allMedia(), {
          fileKind: bucketFileKind(bucket()),
          pinnedOnly: pinnedOnly(),
          pinned: pinnedSet(),
        })
      : [],
  );

  const totalCount = createMemo(() => visibleArtifacts().length + visibleMedia().length);
  const sectionCount = createMemo(() => (visibleArtifacts().length > 0 ? 1 : 0) + (visibleMedia().length > 0 ? 1 : 0));
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
    const w = windowSize().width;
    const appRailW = w < 640 ? 56 : 68;
    const sideW = contentSidebarOpen.get() ? 232 : 0;
    const inspW = inspectorOpen() && w >= 640 ? 304 : 0;
    return Math.max(220, w - appRailW - sideW - inspW - 32);
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

  const openArtifact = (id: string) => router.navigate(`/artifacts/${encodeURIComponent(id)}`);

  const handleTogglePin = (key: string) => {
    const nowPinned = togglePinned(key);
    toast(nowPinned ? t("web.library.content.pinnedToast") : t("web.library.content.unpinnedToast"));
  };

  const finishUpload = async (lastArtifact: Artifact | undefined, lastMedia: LibraryItem | undefined) => {
    if (lastArtifact !== undefined) {
      await queries.invalidate({ prefix: ["artifacts"] });
      if (lastMedia === undefined) openArtifact(lastArtifact.id);
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
          let lastArtifact: Artifact | undefined;
          const inOutlineBucket = bucketArtifactType(untracked(contentBrowseBucket)) === "outline";
          for (const entry of entries) {
            const data = await entry.data;
            const filename = entry.name.trim() || "file";
            if (deliverableNameRe.test(filename)) {
              lastArtifact = await importDeliverable(filename, decodeBase64Utf8(data), inOutlineBucket);
            } else {
              const kept = await api.attachment.create({
                name: filename,
                type: entry.type === "" ? "application/octet-stream" : entry.type,
                data,
              });
              lastMedia = await api.library.item.add({ attachment: kept.id });
            }
          }
          await finishUpload(lastArtifact, lastMedia);
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
          let lastArtifact: Artifact | undefined;
          const inOutlineBucket = bucketArtifactType(untracked(contentBrowseBucket)) === "outline";
          for (const uri of uris) {
            const pathOrUri = localPathFromUri(uri) ?? uri;
            const basename = pathOrUri.split("/").at(-1)?.trim() ?? "";
            if (deliverableNameRe.test(basename)) {
              const read = await hostApi.readFile(uri);
              if (read.bizCode !== 0 || !read.data) continue;
              const filename = read.data.name.trim() || basename || "file";
              lastArtifact = await importDeliverable(filename, decodeBase64Utf8(read.data.data), inOutlineBucket);
            } else {
              const kept = await importLocalAttachment(uri);
              lastMedia = await api.library.item.add({ attachment: kept.id });
            }
          }
          await finishUpload(lastArtifact, lastMedia);
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

  const empty = () => allArtifacts().length === 0 && allMedia().length === 0 && activeMediaCount() === 0;
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
          class="h-9 shrink-0 flex-row items-center gap-2 border-b border-line bg-page px-3"
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
              testID="library-make-btn"
              icon="generate"
              onPress={() => setSearch({ make: bucketFileKind(bucket()) === "audio" ? "audio" : "image" })}
            >
              {t("web.library.make")}
            </Button>
          </If>
          <Button size="compact" testID="library-upload" icon="upload" disabled={act.busy()} onPress={() => void pickFiles()}>
            {act.busy() ? t("web.library.uploading") : t("web.library.upload")}
          </Button>
        </View>

        <Scroll testID="library-grid" class="min-h-0 flex-1" contentClass="gap-5 p-4">
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
                  icon={
                    appsOnly() ? "devices" : pinnedOnly() ? "pin" : showsArtifactsInBucket(bucket()) && !showsMediaInBucket(bucket()) ? "artifacts" : "media"
                  }
                  testid={appsOnly() ? "library-apps-empty" : "library-nothing-shown"}
                  action={
                    <View class="flex-row flex-wrap items-center justify-center gap-2">
                      <If when={bucket().kind === "artifacts"}>
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
              <If when={visibleArtifacts().length > 0}>
                <View class="gap-2.5">
                  <If when={sectionCount() > 1}>
                    <View class="flex-row items-center gap-1.5">
                      <Text class="text-xs font-semibold text-muted">{t("web.library.content.artifacts")}</Text>
                      <CountPill count={visibleArtifacts().length} hoverBright />
                    </View>
                  </If>
                  <ArtifactTiles
                    artifacts={visibleArtifacts()}
                    width={inner()}
                    onOpen={(id) => openArtifact(id)}
                    isPinned={(id) => isPinned(`artifact:${id}`)}
                    onTogglePin={(id) => handleTogglePin(`artifact:${id}`)}
                    onDelete={(art) => {
                      void act.run(async () => {
                        await api.artifact.delete({ id: art.id });
                        toast(t("web.artifact.page.deleted", { title: art.title }));
                        void queries.invalidate({ prefix: ["artifacts"] });
                      });
                    }}
                    installedApplets={installedMap()}
                    canInstallApplet={currentHost().applet !== undefined}
                    onInstallApplet={(a) => appletTarget.set(a)}
                    onOpenApplet={(id) =>
                      void currentHost()
                        .applet?.open(id)
                        .then(
                          () => toast(t("web.artifact.applet.openedToast", { name: installedMap().get(id)?.appName ?? id })),
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

      <If when={appletTarget()}>{(a) => <InstallAppletModal open artifact={a()} onClose={() => appletTarget.set(undefined)} />}</If>
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
