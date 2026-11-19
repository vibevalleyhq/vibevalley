// Ported from VibeValley apps/web/src/features/media/LibraryPage.tsx: the
// media library (/library) with origin & kind rail filters, search, sort,
// tile size presets, Picker upload & FileDrop, Lightbox, Inspector, and
// generation dialogs.
import { effect, keymap, Picker, Scroll, signal, Text, View, windowSize } from "nsh";

import { t } from "@vibevalley/i18n";
import { type LibraryItem, type LibrarySort, LibrarySortValues, type MediaJob } from "@vibevalley/protocol";

import { hostApi } from "../../../../bridge";
import { createMemo } from "../../../solid";
import { createSettled } from "../../base/dom";
import { api } from "../../infra/api";
import { attachmentData } from "../../infra/attachment";
import { fileUrl, useAttachmentFile } from "../../infra/attachmentFile";
import { useCore } from "../../infra/frame";
import { ready, useAgents, useQuery } from "../../infra/query";
import { useSearchParams } from "../../infra/router";
import { prefsNow, setLibraryTile } from "../../state/prefs";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Select, TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Empty, Quiet } from "../../ui/layout";
import { Lightbox, type Picture } from "../../ui/Lightbox";
import { readFiles } from "../../ui/picked";
import { Segmented } from "../../ui/Segmented";
import { toast } from "../../ui/toasts";
import { AudioPanel } from "./AudioPanel";
import { ImagePanel } from "./ImagePanel";
import { Inspector } from "./Inspector";
import { between, countsOf, justify, type KindFilter, kindOf, making, type Names, neighbor, shown, understoodText, type Where } from "./items";
import { libraryQuery } from "./listing";
import { publicationKey } from "./publication";
import { Rail } from "./Rail";
import { SpeechPanel } from "./SpeechPanel";
import { knows, MakingTiles, ratioOf, type Seen, tileGap, Tiles } from "./Tiles";
import { UnderstandingPanel } from "./UnderstandingPanel";

type Make = "image" | "speech" | "audio";
const makes: readonly Make[] = ["image", "speech", "audio"];
const tileMin = 96;
const tileMax = 280;

export function LibraryPage() {
  const core = useCore();
  const agents = useAgents();
  const [search, setSearch] = useSearchParams();
  const text = signal("");
  const typed = createSettled(text, 250);
  const sort = signal<LibrarySort>("recent");
  const items = useQuery(() => libraryQuery({ text: typed().trim(), sort: sort() }), { interval: () => 10_000, keepPrevious: true });
  const where = signal<Where>({ by: "all" });
  const kind = signal<KindFilter>("all");
  const picked = signal<readonly string[]>([]);
  const anchor = signal<string | undefined>(undefined);
  const asking = signal(false);
  const looking = signal<number | undefined>(undefined);
  const dragging = signal(false);
  const seen = signal<ReadonlyMap<string, Seen>>(new Map());
  const act = createAct();

  const tile = () => Math.min(tileMax, Math.max(tileMin, prefsNow().libraryTile));
  const all = (): readonly LibraryItem[] => ready(items, undefined) ?? [];
  const jobs = (): readonly MediaJob[] => core()?.media ?? [];
  const working = () => making(jobs());
  const list = createMemo(() => shown({ items: all(), where: where(), kind: kind() }));
  const ids = createMemo(() => list().map((item) => item.attachment.id));
  const counts = createMemo(() => countsOf({ items: all(), where: where(), kind: kind() }));

  const inner = () => {
    const w = windowSize().width;
    const railW = w < 640 ? 56 : 76 + 208;
    const inspW = picked().length > 0 && w >= 640 ? 304 : 0;
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

  const chosen = createMemo(() => {
    const on = picked();
    return all().filter((item) => on.includes(item.attachment.id));
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

  const make = (): Make | undefined => {
    const m = search().get("make");
    return makes.find((x) => x === m);
  };
  const understanding = () => {
    const id = search().get("understand");
    if (id === null || id === "") return undefined;
    return all().find((item) => item.attachment.id === id)?.attachment ?? { id, name: id, type: "", size: 0 };
  };

  const uploadEntries = (entries: readonly { name: string; type: string; data: Promise<string> }[]) =>
    entries.length === 0
      ? Promise.resolve()
      : act.run(() =>
          Promise.all(
            entries.map((entry) =>
              entry.data
                .then((data) =>
                  api.attachment.create({
                    name: entry.name === "" ? "file" : entry.name,
                    type: entry.type === "" ? "application/octet-stream" : entry.type,
                    data,
                  }),
                )
                .then((kept) => api.library.item.add({ attachment: kept.id })),
            ),
          ).then((added) => {
            void items.refetch();
            const last = added.at(-1);
            if (last !== undefined) {
              picked.set([last.attachment.id]);
              anchor.set(last.attachment.id);
            }
          }),
        );

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
        if (picked().length > 0) asking.set(true);
      },
      delete: () => {
        if (picked().length > 0) asking.set(true);
      },
      escape: () => {
        if (picked().length > 0) {
          picked.set([]);
          anchor.set(undefined);
          asking.set(false);
        }
      },
    },
    { when: "notEditing", passThrough: true },
  );

  const empty = () => all().length === 0 && working().length === 0 && typed().trim() === "";

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
        onWhere={(w) => {
          where.set(w);
          asking.set(false);
        }}
        onKind={(k) => {
          kind.set(k);
          asking.set(false);
        }}
      />
      <View class="min-h-0 min-w-0 flex-1">
        <View
          role="toolbar"
          accessibilityLabel={t("web.library.title")}
          class="min-h-16.5 shrink-0 flex-row flex-wrap items-center gap-2 border-b border-line px-4 py-2"
        >
          <View class="relative min-w-44 flex-row items-center">
            <View class="absolute left-2.5 z-10">
              <Icon name="search" size={14} tone="faint" />
            </View>
            <TextInput
              testID="library-search"
              placeholder={t("web.library.search")}
              accessibilityLabel={t("web.library.search")}
              value={text()}
              onInput={(v) => text.set(v)}
              class="w-56 pl-8"
            />
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
          <Button testID="library-make" tone="primary" icon="generate" onPress={() => setSearch({ make: "image" })}>
            {t("web.library.make")}
          </Button>
        </View>

        <View class="min-h-0 min-w-0 flex-1 flex-row">
          <Scroll testID="library-grid" class="min-h-0 flex-1" contentClass="gap-3 p-4">
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
              <If when={working().length > 0}>
                <MakingTiles jobs={working()} width={inner()} height={tile()} label={(job) => t(`web.library.job.${job.kind}`)} />
              </If>
              <If when={list().length > 0} else={<Quiet>{t("web.library.nothingShown")}</Quiet>}>
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
              </If>
            </If>
          </Scroll>

          <If when={chosen().length > 0}>
            <Inspector
              items={chosen()}
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
                  anchor.set(undefined);
                  asking.set(false);
                },
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
