// Ported from VibeValley apps/web/src/features/media/LibraryPage.tsx: unified
// workspace library (/library) for media + deliverables, with origin/kind/artifact
// rail filters, cross-filtered counts, search, sort, tile size presets, Picker
// upload & FileDrop (auto-creating artifacts for compound suffixes), Lightbox,
// Inspector (with host.saveFile), "New deliverable" type menu, and generation dialogs.
import { effect, keymap, Picker, Scroll, signal, Text, View, windowSize } from "nsh";
import { Input } from "nsh/base";

import { inferArtifactFromName } from "@vibevalley/artifact/html";
import { t } from "@vibevalley/i18n";
import { type Artifact, type ArtifactType, type LibraryItem, type LibrarySort, LibrarySortValues, type MediaJob } from "@vibevalley/protocol";
import { artifactId } from "@vibevalley/protocol/schema";

import { hostApi } from "../../../../bridge";
import { createMemo } from "../../../solid";
import { createSettled } from "../../base/dom";
import { api } from "../../infra/api";
import { attachmentData } from "../../infra/attachment";
import { fileUrl, useAttachmentFile } from "../../infra/attachmentFile";
import { useCore } from "../../infra/frame";
import { ready, useAgents, useQuery, useQueryClient } from "../../infra/query";
import { useRouter, useSearchParams } from "../../infra/router";
import { prefsNow, setLibraryTile } from "../../state/prefs";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Select } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Empty, Quiet } from "../../ui/layout";
import { Lightbox, type Picture } from "../../ui/Lightbox";
import { type MoreItem, MoreMenu } from "../../ui/MoreMenu";
import { readFiles } from "../../ui/picked";
import { Segmented } from "../../ui/Segmented";
import { Bubble } from "../../ui/Tip";
import { toast } from "../../ui/toasts";
import { artifactTypeIcon, createTypedArtifact, useArtifacts } from "../artifact";
import { AudioPanel } from "./AudioPanel";
import { ImagePanel } from "./ImagePanel";
import { Inspector } from "./Inspector";
import {
  artifactCountsOf,
  type ArtifactKindFilter,
  between,
  countsOf,
  justify,
  type KindFilter,
  kindOf,
  making,
  type Names,
  neighbor,
  shown,
  shownArtifacts,
  understoodText,
  type Where,
} from "./items";
import { libraryQuery } from "./listing";
import { publicationKey } from "./publication";
import { Rail } from "./Rail";
import { SpeechPanel } from "./SpeechPanel";
import { ArtifactTiles, knows, MakingTiles, ratioOf, type Seen, tileGap, Tiles } from "./Tiles";
import { UnderstandingPanel } from "./UnderstandingPanel";

type Make = "image" | "speech" | "audio";
const makes: readonly Make[] = ["image", "speech", "audio"];
const tileMin = 96;
const tileMax = 280;

const deliverableNameRe =
  /\.(?:(?:slide|slides|visual|canvas|design|dashboard|motion|page)\.html|html|htm|whiteboard(?:\.json|\.html)?|(?:design-system|tokens)\.json|doc\.md|md|markdown)$/iu;

function base64ToUtf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function LibraryPage() {
  const core = useCore();
  const agents = useAgents();
  const router = useRouter();
  const queries = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const text = signal("");
  const typed = createSettled(text, 250);
  const sort = signal<LibrarySort>("recent");
  const items = useQuery(() => libraryQuery({ text: typed().trim(), sort: sort() }), { interval: () => 10_000, keepPrevious: true });
  const artifactsQuery = useArtifacts(() => ({}));
  const where = signal<Where>({ by: "all" });
  const kind = signal<KindFilter>("all");
  const artifactKind = signal<ArtifactKindFilter | undefined>(undefined);
  const picked = signal<readonly string[]>([]);
  const pickedArtifact = signal<string | undefined>(undefined);
  const anchor = signal<string | undefined>(undefined);
  const asking = signal(false);
  const looking = signal<number | undefined>(undefined);
  const dragging = signal(false);
  const seen = signal<ReadonlyMap<string, Seen>>(new Map());
  const act = createAct();

  const tile = () => Math.min(tileMax, Math.max(tileMin, prefsNow().libraryTile));
  const all = (): readonly LibraryItem[] => ready(items, undefined) ?? [];
  const allArtifacts = (): readonly Artifact[] => ready(artifactsQuery, undefined) ?? [];
  const jobs = (): readonly MediaJob[] => core()?.media ?? [];
  const working = () => making(jobs());
  const list = createMemo(() => (artifactKind() !== undefined ? [] : shown({ items: all(), where: where(), kind: kind() })));
  const visibleArtifacts = createMemo(() =>
    artifactKind() === undefined && kind() !== "all"
      ? []
      : shownArtifacts(allArtifacts(), { where: where(), artifactKind: artifactKind(), search: typed().trim(), sort: sort() }),
  );
  const ids = createMemo(() => list().map((item) => item.attachment.id));
  const counts = createMemo(() =>
    countsOf({
      items: all(),
      artifacts: allArtifacts(),
      where: where(),
      kind: kind(),
      artifactKind: artifactKind(),
      search: typed().trim(),
    }),
  );
  const artifactCounts = createMemo(() => artifactCountsOf(allArtifacts(), { where: where(), search: typed().trim() }));

  const chosen = createMemo(() => {
    const on = picked();
    return all().filter((item) => on.includes(item.attachment.id));
  });
  const chosenArtifact = createMemo(() => {
    const id = pickedArtifact();
    return id !== undefined ? allArtifacts().find((a) => a.id === id) : undefined;
  });
  const inspectorOpen = () => chosen().length > 0 || chosenArtifact() !== undefined;

  const inner = () => {
    const w = windowSize().width;
    const railW = w < 640 ? 56 : 76 + 224;
    const inspW = inspectorOpen() && w >= 640 ? 304 : 0;
    return Math.max(220, w - railW - inspW - 32);
  };

  const rows = createMemo(() => {
    const known = seen();
    return justify({
      ratios: list().map((item) => ratioOf({ item, seen: known.get(item.attachment.id) })),
      width: inner(),
      height: tile(),
      gap: tileGap,
    });
  });

  const active = () => anchor() ?? picked().at(-1);

  const names: Names = {
    agent: (id) => (ready(agents, undefined) ?? []).find((a) => a.id === id)?.name ?? id,
    channel: (id) => {
      const c = (core()?.chat?.channels ?? []).find((x) => x.id === id);
      return c === undefined ? id : `#${c.name ?? c.id}`;
    },
  };

  let lastReadyCount: number | undefined;
  effect(() => {
    const n = jobs().filter((job) => job.phase === "ready").length;
    if (lastReadyCount !== undefined && n !== lastReadyCount) void items.refetch();
    lastReadyCount = n;
  });

  effect(() => {
    const now = ids();
    const cur = picked();
    const kept = cur.filter((id) => now.includes(id));
    if (kept.length !== cur.length) {
      picked.set(kept);
      asking.set(false);
    }
  });

  effect(() => {
    const id = pickedArtifact();
    if (id !== undefined && !visibleArtifacts().some((a) => a.id === id)) {
      pickedArtifact.set(undefined);
      asking.set(false);
    }
  });

  const make = (): Make | undefined => {
    const m = search().get("make");
    return makes.find((x) => x === m);
  };
  const understanding = () => {
    const id = search().get("understand");
    if (id === null || id === "") return undefined;
    return all().find((item) => item.attachment.id === id)?.attachment ?? { id, name: id, type: "", size: 0 };
  };

  const createNewArtifact = (choice: ArtifactType | "html") =>
    act.run(async () => {
      const made = await createTypedArtifact(choice, t("web.artifact.page.untitled"));
      await queries.invalidate({ prefix: ["artifacts"] });
      router.navigate(`/artifacts/${encodeURIComponent(made.id)}`);
    });

  const newArtifactItems = (): MoreItem[] => [
    { key: "docs", label: t("web.artifact.types.docs"), icon: artifactTypeIcon.docs, onSelect: () => void createNewArtifact("docs") },
    { key: "slides", label: t("web.artifact.types.slides"), icon: artifactTypeIcon.slides, onSelect: () => void createNewArtifact("slides") },
    { key: "dashboard", label: t("web.artifact.types.dashboard"), icon: artifactTypeIcon.dashboard, onSelect: () => void createNewArtifact("dashboard") },
    { key: "motion", label: t("web.artifact.types.motion"), icon: artifactTypeIcon.motion, onSelect: () => void createNewArtifact("motion") },
    { key: "whiteboard", label: t("web.artifact.types.whiteboard"), icon: artifactTypeIcon.whiteboard, onSelect: () => void createNewArtifact("whiteboard") },
    { key: "design", label: t("web.artifact.types.design"), icon: artifactTypeIcon.design, onSelect: () => void createNewArtifact("design") },
    {
      key: "design-system",
      label: t("web.artifact.types.designSystem"),
      icon: artifactTypeIcon["design-system"],
      onSelect: () => void createNewArtifact("design-system"),
    },
    { key: "html", label: t("web.artifact.types.html"), icon: "web", onSelect: () => void createNewArtifact("html") },
  ];

  const uploadEntries = (entries: readonly { name: string; type: string; data: Promise<string> }[]) =>
    entries.length === 0
      ? Promise.resolve()
      : act.run(async () => {
          let lastMedia: LibraryItem | undefined;
          let lastArtifact: Artifact | undefined;
          for (const entry of entries) {
            const data = await entry.data;
            const filename = entry.name.trim() || "file";
            if (deliverableNameRe.test(filename)) {
              const content = base64ToUtf8(data);
              const inferred = inferArtifactFromName(filename, content);
              lastArtifact = await api.artifact.create({
                title: inferred.title,
                kind: inferred.kind,
                ...(inferred.display !== undefined ? { display: inferred.display } : {}),
                ...(inferred.artifactType !== undefined ? { artifactType: inferred.artifactType } : {}),
                content,
              });
            } else {
              const kept = await api.attachment.create({
                name: filename,
                type: entry.type === "" ? "application/octet-stream" : entry.type,
                data,
              });
              lastMedia = await api.library.item.add({ attachment: kept.id });
            }
          }
          if (lastArtifact !== undefined) {
            await queries.invalidate({ prefix: ["artifacts"] });
            picked.set([]);
            anchor.set(undefined);
            pickedArtifact.set(lastArtifact.id);
          }
          if (lastMedia !== undefined) {
            void items.refetch();
            pickedArtifact.set(undefined);
            picked.set([lastMedia.attachment.id]);
            anchor.set(lastMedia.attachment.id);
          }
        });

  const pickFiles = async () => {
    const chosenFiles = readFiles(await Picker.pickFiles({ multiple: true }));
    await uploadEntries(chosenFiles.map((file) => ({ name: file.name, type: file.type, data: attachmentData(file) })));
  };

  const dropUris = async (uris: readonly string[]) => {
    const read = await Promise.all(uris.map((u) => hostApi.readFile(u)));
    const ok = read.flatMap((r) => (r.bizCode === 0 && r.data ? [r.data] : []));
    await uploadEntries(ok.map((f) => ({ name: f.name, type: f.type, data: Promise.resolve(f.data) })));
  };

  const pick = (id: string, how: { readonly add: boolean; readonly range: boolean }) => {
    asking.set(false);
    pickedArtifact.set(undefined);
    const from = anchor();
    if (how.range && from !== undefined) picked.set(between({ ids: ids(), from, to: id }));
    else if (how.add) {
      const was = picked();
      picked.set(was.includes(id) ? was.filter((x) => x !== id) : [...was, id]);
      anchor.set(id);
    } else {
      picked.set([id]);
      anchor.set(id);
    }
  };

  const pickArtifact = (id: string) => {
    asking.set(false);
    picked.set([]);
    anchor.set(undefined);
    pickedArtifact.set(id);
  };

  const openArtifact = (id: string) => router.navigate(`/artifacts/${encodeURIComponent(id)}`);

  const imageItems = createMemo(() => list().filter((item) => kindOf(item.attachment.type) === "image"));
  const look = (id: string | undefined) => {
    const at = imageItems().findIndex((p) => p.attachment.id === id);
    if (at >= 0) looking.set(at);
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
        asking.set(false);
        picked.set([]);
        anchor.set(undefined);
        void items.refetch();
      }),
    );
  };

  const removeArtifact = (id: string) => {
    const target = allArtifacts().find((a) => a.id === id);
    return act.run(async () => {
      await api.artifact.delete({ id: artifactId(id) });
      asking.set(false);
      pickedArtifact.set(undefined);
      if (target) toast(t("web.artifact.page.deleted", { title: target.title }));
      await queries.invalidate({ prefix: ["artifacts"] });
    });
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
        if (inspectorOpen()) asking.set(true);
      },
      delete: () => {
        if (inspectorOpen()) asking.set(true);
      },
      escape: () => {
        if (inspectorOpen()) {
          picked.set([]);
          pickedArtifact.set(undefined);
          anchor.set(undefined);
          asking.set(false);
        }
      },
    },
    { when: "notEditing", passThrough: true },
  );

  const empty = () => all().length === 0 && allArtifacts().length === 0 && working().length === 0 && typed().trim() === "";
  const nothingShown = () => list().length === 0 && visibleArtifacts().length === 0;

  return (
    <View
      testID="library-page"
      class="relative h-full min-h-0 min-w-0 flex-1 flex-col sm:flex-row"
      onFileDragEnter={() => dragging.set(true)}
      onFileDragLeave={() => dragging.set(false)}
      onFileDrop={(e) => {
        dragging.set(false);
        void dropUris(e.uris);
      }}
    >
      <Rail
        counts={counts()}
        names={names}
        where={where()}
        kind={kind()}
        artifactKind={artifactKind()}
        artifactCounts={artifactCounts()}
        onWhere={(w) => {
          where.set(w);
          asking.set(false);
        }}
        onKind={(k) => {
          artifactKind.set(undefined);
          kind.set(k);
          asking.set(false);
        }}
        onArtifactKind={(ak) => {
          artifactKind.set(ak);
          asking.set(false);
        }}
      />
      <View class="min-h-0 min-w-0 flex-1">
        <View
          role="toolbar"
          accessibilityLabel={t("web.library.title")}
          class="min-h-14 shrink-0 flex-row flex-wrap items-center gap-2 border-b border-line px-4 py-2.5"
        >
          <View class="h-7 w-56 min-w-40 flex-row items-center gap-1.5 rounded-md border border-line bg-page px-2 transition duration-120 ease-out focus-within:border-focus">
            <Icon name="search" size={14} tone="faint" />
            <Input
              testID="library-search"
              placeholder={t("web.library.search")}
              accessibilityLabel={t("web.library.search")}
              value={text()}
              onChange={(e) => text.set(e.value)}
              class="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-faint"
            />
            <If when={text().length > 0}>
              <View
                role="button"
                testID="library-search-clear"
                accessibilityLabel={t("web.issue.page.clear")}
                tooltip={<Bubble text={t("web.issue.page.clear")} />}
                onPress={() => text.set("")}
                class="h-4 w-4 shrink-0 items-center justify-center rounded-sm hover:bg-hover"
              >
                <Icon name="close" size={12} tone="muted" />
              </View>
            </If>
          </View>
          <Select
            label={t("web.library.sortLabel")}
            testid="library-sort"
            size="control"
            quiet
            value={sort()}
            onChange={(v) => sort.set(v)}
            options={LibrarySortValues.map((value) => ({ value, label: t(`web.library.sort.${value}`) }))}
          />
          <View class="flex-1" />
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
          <Button testID="library-upload" icon="upload" disabled={act.busy()} onPress={() => void pickFiles()}>
            {act.busy() ? t("web.library.uploading") : t("web.library.upload")}
          </Button>
          <View class="flex-row items-center gap-1">
            <Button testID="library-new-artifact" icon="add" disabled={act.busy()} onPress={() => void createNewArtifact("docs")}>
              {t("web.library.newArtifact")}
            </Button>
            <MoreMenu icon="choose" label={t("web.artifact.types.pick")} testid="new-artifact-type" items={newArtifactItems()} />
          </View>
          <Button testID="library-make" tone="primary" icon="generate" onPress={() => setSearch({ make: "image" })}>
            {t("web.library.make")}
          </Button>
        </View>

        <View class="min-h-0 min-w-0 flex-1 flex-row">
          <Scroll testID="library-grid" class="min-h-0 flex-1" contentClass="gap-4 p-4">
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
                        <Button icon="add" onPress={() => void createNewArtifact("docs")}>
                          {t("web.library.newArtifact")}
                        </Button>
                        <Button tone="primary" icon="generate" onPress={() => setSearch({ make: "image" })}>
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
              <If when={working().length > 0}>
                <MakingTiles jobs={working()} width={inner()} height={tile()} label={(job) => t(`web.library.job.${job.kind}`)} />
              </If>
              <If when={!nothingShown()} else={<Quiet>{t("web.library.nothingShown")}</Quiet>}>
                <If when={visibleArtifacts().length > 0}>
                  <View class="gap-2.5">
                    <If when={list().length > 0}>
                      <View class="flex-row items-center gap-1.5">
                        <Text class="text-xs font-semibold text-muted">{t("web.library.rail.artifacts")}</Text>
                        <View class="rounded-full bg-hover px-1.5 py-px">
                          <Text class="font-mono text-2xs text-faint tabular-nums">{String(visibleArtifacts().length)}</Text>
                        </View>
                      </View>
                    </If>
                    <ArtifactTiles
                      artifacts={visibleArtifacts()}
                      selectedId={pickedArtifact()}
                      onSelect={(id) => pickArtifact(id)}
                      onOpen={(id) => openArtifact(id)}
                    />
                  </View>
                </If>
                <If when={list().length > 0}>
                  <View class="gap-2.5">
                    <If when={visibleArtifacts().length > 0}>
                      <View class="flex-row items-center gap-1.5">
                        <Text class="text-xs font-semibold text-muted">{t("web.library.rail.kind")}</Text>
                        <View class="rounded-full bg-hover px-1.5 py-px">
                          <Text class="font-mono text-2xs text-faint tabular-nums">{String(list().length)}</Text>
                        </View>
                      </View>
                    </If>
                    <Tiles
                      items={list()}
                      rows={rows()}
                      picked={picked()}
                      active={active()}
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

          <If when={inspectorOpen()}>
            <Inspector
              items={chosen()}
              artifact={chosenArtifact()}
              seen={chosen().length === 1 ? seen().get(chosen()[0]?.attachment.id ?? "") : undefined}
              understood={chosen().length === 1 ? understoodText(chosen()[0]?.attachment.id ?? "")(jobs()) : undefined}
              names={names}
              asking={asking()}
              act={{
                channels: core()?.chat?.channels ?? [],
                send: (channel) => void send(channel),
                understand: () => setSearch({ understand: chosen()[0]?.attachment.id }),
                look: () => look(chosen()[0]?.attachment.id),
                ask: () => asking.set(true),
                remove: () => void remove(),
                keep: () => asking.set(false),
                clear: () => {
                  picked.set([]);
                  pickedArtifact.set(undefined);
                  anchor.set(undefined);
                  asking.set(false);
                },
                openArtifact,
                removeArtifact: (id) => void removeArtifact(id),
              }}
            />
          </If>
        </View>
      </View>

      <If when={dragging()}>
        <View
          testID="library-drop"
          class="pointer-events-none absolute inset-2 z-20 flex-row items-center justify-center gap-2 rounded-xl border-2 border-dashed border-accent bg-page p-4"
        >
          <Icon name="upload" size={20} />
          <Text class="text-base text-ink">{t("web.library.drop")}</Text>
        </View>
      </If>

      <LibraryLightbox items={imageItems()} at={looking()} onAt={(at) => looking.set(at)} />

      <Dialog open={make() !== undefined} onClose={() => setSearch({ make: undefined })} title={t("web.library.makeTitle")} wide testid="library-make-dialog">
        <Segmented
          label={t("web.library.makeTitle")}
          testid="library-make-form"
          value={make() ?? "image"}
          onChange={(value) => setSearch({ make: value })}
          options={makes.map((value) => ({ value, label: t(`web.library.makeTabs.${value}`) }))}
        />
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
            wide
            testid="library-understand-dialog"
          >
            <UnderstandingPanel file={file()} />
          </Dialog>
        )}
      </If>
    </View>
  );
}

function LibraryLightbox(props: { items: readonly LibraryItem[]; at: number | undefined; onAt: (at: number | undefined) => void }) {
  const curId = () => (props.at !== undefined ? (props.items[props.at]?.attachment.id ?? "") : "");
  const file = useAttachmentFile(curId);
  const pictures = (): readonly Picture[] =>
    props.items.map((item, i) => {
      const f = i === props.at ? file() : undefined;
      return {
        src: f ? fileUrl(f.path) : "",
        name: item.attachment.name,
        ...(f ? { path: f.path } : {}),
      };
    });
  return <Lightbox pictures={pictures()} at={props.at} onAt={props.onAt} />;
}
