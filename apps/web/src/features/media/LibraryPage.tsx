import { createEffect, createMemo, createSignal, onSettled, Show, untrack } from "solid-js";

import { inferArtifactFromName } from "@vibevalley/artifact/html";
import { Slider } from "@vibevalley/base-ui";
import { t } from "@vibevalley/i18n";
import { type Artifact, attachmentPath, type LibraryItem, type LibrarySort, LibrarySortValues, type MediaJob } from "@vibevalley/protocol";

import { createSettled } from "#/base/dom.tsx";
import { artifactHref, useArtifacts } from "#/features/artifact/index.ts";
import { api } from "#/infra/api.ts";
import { attachmentData } from "#/infra/attachment.ts";
import { useCore } from "#/infra/frame.ts";
import { ready, useAgents, useQuery, useQueryClient } from "#/infra/query.ts";
import { useRouter, useSearchParams } from "#/infra/router.ts";
import { prefsNow, setLibraryTile, shownTheme } from "#/state/prefs.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Dialog } from "#/ui/Dialog.tsx";
import { Select, TextInput } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { Empty, Quiet } from "#/ui/layout.tsx";
import { Lightbox } from "#/ui/Lightbox.tsx";
import { Segmented } from "#/ui/Segmented.tsx";
import { toast } from "#/ui/toasts.ts";

import { AudioPanel } from "./AudioPanel.tsx";
import { ImagePanel } from "./ImagePanel.tsx";
import { Inspector } from "./Inspector.tsx";
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
} from "./items.ts";
import { libraryQuery } from "./listing.ts";
import { publicationKey } from "./publication.ts";
import { Rail } from "./Rail.tsx";
import { SpeechPanel } from "./SpeechPanel.tsx";
import { ArtifactTiles, knows, MakingTiles, ratioOf, type Seen, tileGap, Tiles, useWidth } from "./Tiles.tsx";
import { UnderstandingPanel } from "./UnderstandingPanel.tsx";

type Make = "image" | "speech" | "audio";
const makes: readonly Make[] = ["image", "speech", "audio"];
const tileMin = 96;
const tileMax = 280;

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
const isArtifactFile = (name: string) => /\.(?:(?:slide|slides|visual|canvas|dashboard|motion)\.html|whiteboard(?:\.json|\.html)?|doc\.md)$/iu.test(name);

export function LibraryPage() {
  const core = useCore();
  const router = useRouter();
  const queries = useQueryClient();
  const agents = useAgents();
  const [search, setSearch] = useSearchParams();
  const [text, setText] = createSignal("");
  const typed = createSettled(text, 250);
  const [sort, setSort] = createSignal<LibrarySort>("recent");
  const items = useQuery(() => libraryQuery({ text: typed().trim(), sort: sort() }), { interval: () => 10_000, keepPrevious: true });
  const artifacts = useArtifacts(() => ({}));
  const [where, setWhere] = createSignal<Where>({ by: "all" });
  const [kind, setKind] = createSignal<KindFilter>("all");
  const [artifactKind, setArtifactKind] = createSignal<ArtifactKindFilter | undefined>(undefined);
  const [picked, setPicked] = createSignal<readonly string[]>([]);
  const [pickedArtifactId, setPickedArtifactId] = createSignal<string | undefined>(undefined);
  const [anchor, setAnchor] = createSignal<string>();
  const [asking, setAsking] = createSignal(false);
  const [looking, setLooking] = createSignal<number>();
  const [dragging, setDragging] = createSignal(false);
  const [seen, setSeen] = createSignal<ReadonlyMap<string, Seen>>(new Map());
  const act = createAct();
  const tile = () => Math.min(tileMax, Math.max(tileMin, prefsNow().libraryTile));
  const all = (): readonly LibraryItem[] => ready(items, undefined) ?? [];
  const allArtifacts = (): readonly Artifact[] => ready(artifacts, undefined) ?? [];
  const jobs = (): readonly MediaJob[] => core()?.media ?? [];
  const working = () => making(jobs());
  const list = createMemo(() => shown({ items: all(), where: where(), kind: kind() }));
  const filteredArtifacts = createMemo(() => shownArtifacts(allArtifacts(), { artifactKind: artifactKind(), search: typed(), sort: sort() }));
  const artifactCounts = createMemo(() => artifactCountsOf(allArtifacts()));
  const showArtifacts = () => artifactKind() !== undefined || (where().by === "all" && kind() === "all");
  const shownArtifactList = createMemo(() => (showArtifacts() ? filteredArtifacts() : []));
  const pickedArtifact = createMemo(() => {
    const id = pickedArtifactId();
    return id === undefined ? undefined : allArtifacts().find((a) => a.id === id);
  });
  const ids = createMemo(() => list().map((item) => item.attachment.id));
  const counts = createMemo(() => countsOf({ items: all(), where: where(), kind: kind() }));
  const area = useWidth();
  const inner = () => Math.max(0, area.width() - 2 * 16);
  const rows = createMemo(() => {
    const known = seen();
    return justify({ ratios: list().map((item) => ratioOf({ item, seen: known.get(item.attachment.id) })), width: inner(), height: tile(), gap: tileGap });
  });
  const chosen = createMemo(() => {
    const on = picked();
    return all().filter((item) => on.includes(item.attachment.id));
  });
  const active = () => anchor() ?? picked().at(-1);
  const pictures = createMemo(() =>
    list()
      .filter((item) => kindOf(item.attachment.type) === "image")
      .map((item) => ({
        id: item.attachment.id,
        src: attachmentPath(item.attachment.id),
        name: item.attachment.name,
      })),
  );
  const names: Names = {
    agent: (id) => (ready(agents, undefined) ?? []).find((a) => a.id === id)?.name ?? id,
    channel: (id) => {
      const c = (core()?.chat?.channels ?? []).find((x) => x.id === id);
      return c === undefined ? id : `#${c.name ?? c.id}`;
    },
  };
  createEffect(
    () => jobs().filter((job) => job.phase === "ready").length,
    (n, was) => {
      if (was !== undefined && n !== was) void items.refetch();
    },
  );
  createEffect(
    () => ids(),
    (now) => {
      const current = untrack(picked);
      const kept = current.filter((id) => now.includes(id));
      if (kept.length !== current.length) {
        setPicked(kept);
        setAsking(false);
      }
    },
  );
  createEffect(
    () => ({ status: artifacts.status(), ids: new Set<string>(allArtifacts().map((a) => a.id)) }),
    ({ status, ids: idsNow }) => {
      const id = untrack(pickedArtifactId);
      if (status === "success" && id !== undefined && !idsNow.has(id)) setPickedArtifactId(undefined);
    },
  );
  const make = (): Make | undefined => {
    const m = search().get("make");
    return makes.find((x) => x === m);
  };
  const understanding = () => {
    const id = search().get("understand");
    if (id === null || id === "") return undefined;
    return all().find((item) => item.attachment.id === id)?.attachment ?? { id, name: id, type: "", size: 0 };
  };
  const [picker, setPicker] = createSignal<HTMLInputElement>();
  const upload = (files: readonly File[]) => {
    if (files.length === 0) return Promise.resolve();
    const artifactFiles = files.filter((file) => isArtifactFile(file.name));
    const mediaFiles = files.filter((file) => !isArtifactFile(file.name));
    return act.run(async () => {
      const [madeArtifacts, addedMedia] = await Promise.all([
        Promise.all(
          artifactFiles.map((file) =>
            file.text().then((content) => {
              const info = inferArtifactFromName(file.name, content);
              return api.artifact.create({
                title: info.title,
                kind: info.kind,
                ...(info.display === undefined ? {} : { display: info.display }),
                content,
              });
            }),
          ),
        ),
        Promise.all(
          mediaFiles.map((file) =>
            attachmentData(file)
              .then((data) =>
                api.attachment.create({
                  name: file.name === "" ? "file" : file.name,
                  type: file.type === "" ? "application/octet-stream" : file.type,
                  data,
                }),
              )
              .then((kept) => api.library.item.add({ attachment: kept.id })),
          ),
        ),
      ]);
      if (mediaFiles.length > 0) void items.refetch();
      if (artifactFiles.length > 0) void queries.invalidate({ prefix: ["artifacts"] });
      const lastMedia = addedMedia.at(-1);
      const lastArtifact = madeArtifacts.at(-1);
      if (lastMedia !== undefined) {
        setPickedArtifactId(undefined);
        setPicked([lastMedia.attachment.id]);
        setAnchor(lastMedia.attachment.id);
      } else if (lastArtifact !== undefined) {
        setPicked([]);
        setAnchor(undefined);
        setPickedArtifactId(lastArtifact.id);
      }
    });
  };
  const pickArtifact = (id: string) => {
    setAsking(false);
    setPicked([]);
    setAnchor(undefined);
    setPickedArtifactId(id);
  };
  const pick = (id: string, how: { readonly add: boolean; readonly range: boolean }) => {
    setAsking(false);
    setPickedArtifactId(undefined);
    const from = anchor();
    if (how.range && from !== undefined) setPicked(between({ ids: ids(), from, to: id }));
    else if (how.add) {
      setPicked((was) => (was.includes(id) ? was.filter((x) => x !== id) : [...was, id]));
      setAnchor(id);
    } else {
      setPicked([id]);
      setAnchor(id);
    }
  };
  const look = (id: string | undefined) => {
    const at = pictures().findIndex((p) => p.id === id);
    if (at >= 0) setLooking(at);
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
        setAsking(false);
        setPicked([]);
        setAnchor(undefined);
        void items.refetch();
      }),
    );
  };
  const onKey = (e: KeyboardEvent) => {
    const at = active();
    const index = at === undefined ? -1 : ids().indexOf(at);
    const arrows: Record<string, "left" | "right" | "up" | "down"> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
    const way = arrows[e.key];
    if (way !== undefined) {
      e.preventDefault();
      const next = index < 0 ? 0 : neighbor({ rows: rows(), index, key: way });
      const id = next === undefined ? undefined : ids()[next];
      if (id === undefined) return;
      pick(id, { add: false, range: e.shiftKey });
      document.getElementById(`library-tile-${id}`)?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (e.key === " " && at !== undefined) {
      e.preventDefault();
      look(at);
      return;
    }
    if ((e.key === "Delete" || e.key === "Backspace") && picked().length > 0) {
      e.preventDefault();
      setAsking(true);
      return;
    }
    if (e.key === "Escape" && (picked().length > 0 || pickedArtifactId() !== undefined)) {
      setPicked([]);
      setPickedArtifactId(undefined);
      setAnchor(undefined);
      setAsking(false);
    }
  };
  onSettled(() => {
    const paste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      void upload(files);
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  });
  const empty = () => all().length === 0 && allArtifacts().length === 0 && working().length === 0 && typed().trim() === "";
  return (
    <div
      data-testid="library-page"
      class={
        'relative grid h-full min-h-0 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] max-sm:grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] max-sm:grid-rows-[auto_auto_minmax(0,1fr)] [grid-template-areas:"rail_bar_side"_"rail_files_side"] max-sm:[grid-template-areas:"bar"_"rail"_"files"]'
      }
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(false);
        void upload(Array.from(e.dataTransfer?.files ?? []));
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
          setArtifactKind(undefined);
          setPickedArtifactId(undefined);
          setWhere(w);
          setAsking(false);
        }}
        onKind={(k) => {
          setArtifactKind(undefined);
          setPickedArtifactId(undefined);
          setKind(k);
          setAsking(false);
        }}
        onArtifactKind={(ak) => {
          setArtifactKind(ak);
          setWhere({ by: "all" });
          setKind("all");
          setPicked([]);
          setPickedArtifactId(undefined);
          setAnchor(undefined);
          setAsking(false);
        }}
      />
      <div
        role="toolbar"
        aria-label={t("web.library.title")}
        class="[grid-area:bar] flex shrink-0 flex-wrap items-center gap-2 border-b border-b-line min-h-16.5 py-2 px-4"
      >
        <label class="relative flex items-center flex-[0_1_16rem] max-sm:flex-[1_1_100%] min-w-40">
          <Icon name="search" size={14} class="absolute left-2.5 text-faint pointer-events-none" />
          <TextInput
            type="search"
            data-testid="library-search"
            placeholder={t("web.library.search")}
            aria-label={t("web.library.search")}
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
            class="w-full pl-8"
          />
        </label>
        <Select
          label={t("web.library.sortLabel")}
          testid="library-sort"
          size="control"
          quiet
          value={sort()}
          onChange={setSort}
          options={LibrarySortValues.map((value) => ({ value, label: t(`web.library.sort.${value}`) }))}
        />
        <span class="flex-1" />
        <div class="flex max-sm:hidden items-center gap-2 text-faint">
          <Icon name="image" size={12} />
          <Slider.Root min={tileMin} max={tileMax} step={8} value={tile()} onValueChange={setLibraryTile} class="w-24">
            <Slider.Control class="relative flex h-4 cursor-pointer items-center">
              <Slider.Track class="relative h-1 w-full rounded-full bg-selected">
                <Slider.Indicator class="h-full rounded-full bg-muted" />
                <Slider.Thumb
                  aria-label={t("web.library.tileSize")}
                  data-testid="library-tile-size"
                  class="absolute top-[calc(50%_-_0.375rem)] w-3 h-3 rounded-full border border-line bg-page shadow-raise"
                />
              </Slider.Track>
            </Slider.Control>
          </Slider.Root>
          <Icon name="image" size={16} />
        </div>
        <input
          ref={setPicker}
          type="file"
          multiple
          data-testid="library-file"
          aria-label={t("web.library.upload")}
          class="hidden"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void upload(files);
          }}
        />
        <Button data-testid="library-new-artifact" icon="artifacts" onClick={() => router.navigate("/artifacts")}>
          {t("web.library.newArtifact")}
        </Button>
        <Button data-testid="library-upload" icon="upload" disabled={act.busy()} onClick={() => picker()?.click()}>
          {act.busy() ? t("web.library.uploading") : t("web.library.upload")}
        </Button>
        <Button data-testid="library-make" tone="primary" icon="generate" onClick={() => setSearch({ make: "image" })}>
          {t("web.library.make")}
        </Button>
      </div>
      <div
        ref={area.ref}
        tabindex={0}
        data-testid="library-grid"
        onKeyDown={onKey}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            setPicked([]);
            setPickedArtifactId(undefined);
            setAnchor(undefined);
            setAsking(false);
          }
        }}
        class="[grid-area:files] relative flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 outline-none"
      >
        <Show
          when={!empty()}
          fallback={
            <Empty
              icon="media"
              testid="library-empty"
              action={
                <>
                  <p class="max-w-96 text-muted">{t("web.library.emptyHow")}</p>
                  <div class="flex justify-center gap-2">
                    <Button icon="upload" onClick={() => picker()?.click()}>
                      {t("web.library.upload")}
                    </Button>
                    <Button icon="generate" onClick={() => setSearch({ make: "image" })}>
                      {t("web.library.make")}
                    </Button>
                  </div>
                </>
              }
            >
              {t("web.library.empty")}
            </Empty>
          }
        >
          <Show when={working().length > 0}>
            <MakingTiles jobs={working()} width={inner()} height={tile()} label={(job) => t(`web.library.job.${job.kind}`)} />
          </Show>
          <Show when={shownArtifactList().length > 0}>
            <ArtifactTiles
              artifacts={shownArtifactList()}
              pickedId={pickedArtifactId()}
              theme={shownTheme()}
              onPick={pickArtifact}
              onOpen={(id) => router.navigate(artifactHref(id))}
            />
          </Show>
          <Show when={artifactKind() === undefined && list().length > 0}>
            <div
              role="listbox"
              aria-label={t("web.library.grid")}
              aria-multiselectable="true"
              aria-activedescendant={active() === undefined ? undefined : `library-tile-${active()}`}
            >
              <Tiles
                items={list()}
                rows={rows()}
                picked={picked()}
                active={active()}
                seen={(id) => seen().get(id)}
                onSeen={(id, s) =>
                  setSeen((was) => {
                    const had = was.get(id);
                    // The same map back, so the grid does not re-layout.
                    if (had !== undefined && knows({ had, learnt: s })) return was;
                    const next = new Map(was);
                    next.set(id, { ...had, ...s });
                    return next;
                  })
                }
                onPick={(id, how) => {
                  pick(id, how);
                  document.querySelector<HTMLElement>('[data-testid="library-grid"]')?.focus({ preventScroll: true });
                }}
                onLook={(id) => look(id)}
              />
            </div>
          </Show>
          <Show when={shownArtifactList().length === 0 && (artifactKind() !== undefined || list().length === 0)}>
            <Quiet>{t("web.library.nothingShown")}</Quiet>
          </Show>
        </Show>
      </div>
      <Show when={chosen().length > 0 || pickedArtifact() !== undefined}>
        <Inspector
          items={chosen()}
          artifact={pickedArtifact()}
          theme={shownTheme()}
          seen={chosen().length === 1 ? seen().get(chosen()[0]?.attachment.id ?? "") : undefined}
          understood={chosen().length === 1 ? understoodText(chosen()[0]?.attachment.id ?? "")(jobs()) : undefined}
          names={names}
          asking={asking()}
          onOpenArtifact={(id) => router.navigate(artifactHref(id))}
          onClearArtifact={() => setPickedArtifactId(undefined)}
          act={{
            channels: core()?.chat?.channels ?? [],
            send: (channel) => void send(channel),
            understand: () => setSearch({ understand: chosen()[0]?.attachment.id }),
            look: () => look(chosen()[0]?.attachment.id),
            ask: () => setAsking(true),
            remove: () => void remove(),
            keep: () => setAsking(false),
            clear: () => {
              setPicked([]);
              setPickedArtifactId(undefined);
              setAnchor(undefined);
              setAsking(false);
            },
          }}
        />
      </Show>
      <Show when={dragging()}>
        <div
          data-testid="library-drop"
          class="animate-fade-in absolute inset-2 z-20 flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-accent bg-page/88 text-ink text-base pointer-events-none"
        >
          <Icon name="upload" size={20} />
          {t("web.library.drop")}
        </div>
      </Show>
      <Lightbox pictures={pictures()} at={looking()} onAt={setLooking} />
      <Dialog open={make() !== undefined} onClose={() => setSearch({ make: undefined })} title={t("web.library.makeTitle")} wide testid="library-make-dialog">
        <Segmented
          label={t("web.library.makeTitle")}
          testid="library-make-form"
          value={make() ?? "image"}
          onChange={(value) => setSearch({ make: value })}
          options={makes.map((value) => ({ value, label: t(`web.library.makeTabs.${value}`) }))}
        />
        <Show when={make() === "image"}>
          <ImagePanel />
        </Show>
        <Show when={make() === "speech"}>
          <SpeechPanel />
        </Show>
        <Show when={make() === "audio"}>
          <AudioPanel />
        </Show>
      </Dialog>
      <Show when={understanding()}>
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
      </Show>
    </div>
  );
}
