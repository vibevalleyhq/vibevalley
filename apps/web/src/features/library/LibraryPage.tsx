import * as stylex from "@stylexjs/stylex";
import { Array as Arr, Option, String as Str } from "effect";
import { createEffect, createMemo, createSignal, onSettled, Show } from "solid-js";

import { Slider } from "@vibevalley/base-ui";
import { t } from "@vibevalley/i18n";
import { attachmentPath, type LibraryItem, type LibrarySort, LibrarySortValues, type MediaJob } from "@vibevalley/protocol";

import { createSettled } from "#/base/dom.tsx";
import { AudioPanel, ImagePanel, publicationKey, SpeechPanel, UnderstandingPanel } from "#/features/media/index.ts";
import { api } from "#/infra/api.ts";
import { attachmentData } from "#/infra/attachment.ts";
import { useCore } from "#/infra/frame.ts";
import { ready, useAgents, useQuery } from "#/infra/query.ts";
import { useSearchParams } from "#/infra/router.ts";
import { prefsNow, setLibraryTile } from "#/state/prefs.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Dialog } from "#/ui/Dialog.tsx";
import { Select, TextInput } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { Empty, Quiet } from "#/ui/layout.tsx";
import { Lightbox } from "#/ui/Lightbox.tsx";
import { Segmented } from "#/ui/Segmented.tsx";
import { toast } from "#/ui/toasts.ts";

import { Inspector } from "./Inspector.tsx";
import { between, countsOf, justify, type KindFilter, kindOf, making, type Names, neighbor, shown, understoodText, type Where } from "./items.ts";
import { libraryQuery } from "./listing.ts";
import { Rail } from "./Rail.tsx";
import { knows, MakingTiles, ratioOf, type Seen, tileGap, Tiles, useWidth } from "./Tiles.tsx";

const styles = stylex.create({
  // The rail and the inspector run the page's height beside the bar and the files; on a phone the bar is on top, the
  // filters under it, and the inspector a sheet over the files.
  page: {
    position: "relative",
    display: "grid",
    height: "100%",
    minHeight: 0,
    minWidth: 0,
    gridTemplateColumns: { default: "auto minmax(0, 1fr) auto", "@media (width < 40rem)": "minmax(0, 1fr)" },
    gridTemplateRows: { default: "auto minmax(0, 1fr)", "@media (width < 40rem)": "auto auto minmax(0, 1fr)" },
    gridTemplateAreas: { default: '"rail bar side" "rail files side"', "@media (width < 40rem)": '"bar" "rail" "files"' },
  },
  toolbar: {
    gridArea: "bar",
    display: "flex",
    flexShrink: 0,
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: "var(--color-line)",
    // The page's one bar, as high as the head other pages have (app/Shell.tsx's 66px desk).
    minHeight: 66,
    paddingBlock: "calc(var(--spacing) * 2)",
    paddingInline: "calc(var(--spacing) * 4)",
  },
  search: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    flex: { default: "0 1 calc(var(--spacing) * 64)", "@media (width < 40rem)": "1 1 100%" },
    minWidth: "calc(var(--spacing) * 40)",
  },
  searchIcon: { position: "absolute", left: "calc(var(--spacing) * 2.5)", color: "var(--color-faint)", pointerEvents: "none" },
  searchInput: { width: "100%", paddingLeft: "calc(var(--spacing) * 8)" },
  grow: { flex: 1 },
  size: {
    display: { default: "flex", "@media (width < 40rem)": "none" },
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    color: "var(--color-faint)",
  },
  sliderRoot: { width: "calc(var(--spacing) * 24)" },
  sliderControl: { position: "relative", display: "flex", height: "calc(var(--spacing) * 4)", cursor: "pointer", alignItems: "center" },
  sliderTrack: {
    position: "relative",
    height: "var(--spacing)",
    width: "100%",
    borderRadius: "calc(infinity * 1px)",
    backgroundColor: "var(--color-selected)",
  },
  sliderIndicator: { height: "100%", borderRadius: "calc(infinity * 1px)", backgroundColor: "var(--color-muted)" },
  sliderThumb: {
    position: "absolute",
    // Half its own height above the middle: the slider writes the thumb's translate itself, for its left.
    top: "calc(50% - var(--spacing) * 1.5)",
    width: "calc(var(--spacing) * 3)",
    height: "calc(var(--spacing) * 3)",
    borderRadius: "calc(infinity * 1px)",
    borderStyle: "solid",
    borderWidth: 1,
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    boxShadow: "var(--shadow-raise)",
  },
  scroller: {
    gridArea: "files",
    position: "relative",
    display: "flex",
    minHeight: 0,
    flex: 1,
    flexDirection: "column",
    // The same gap as the tiles' (Tiles.tsx's tileGap): StyleX reads only this file's constants.
    gap: 12,
    overflowY: "auto",
    padding: "calc(var(--spacing) * 4)",
    outlineStyle: "none",
  },
  hidden: { display: "none" },
  emptyHow: { maxWidth: "calc(var(--spacing) * 96)", color: "var(--color-muted)" },
  emptyActions: { display: "flex", justifyContent: "center", gap: "calc(var(--spacing) * 2)" },
  // The landing place while files are dragged over the page.
  drop: {
    position: "absolute",
    inset: "calc(var(--spacing) * 2)",
    zIndex: 20,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-xl)",
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: "var(--color-accent)",
    backgroundColor: "color-mix(in srgb, var(--color-page) 88%, transparent)",
    color: "var(--color-ink)",
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
    pointerEvents: "none",
    animationName: { default: "fade-in", "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "180ms",
  },
});

type Make = "image" | "speech" | "audio";
const makes: readonly Make[] = ["image", "speech", "audio"];
const tileMin = 96;
const tileMax = 280;

const hasFiles = (e: DragEvent) => Arr.contains(Array.from(e.dataTransfer?.types ?? []), "Files");

/** The library (/library): every kept file, Eagle-like. The rail filters, the middle is the files in justified rows,
 * the inspector shows the one picked. ?make= opens the generate dialog on a form, ?understand=<attachment id> the
 * understanding of one file. */
export function LibraryPage() {
  const core = useCore();
  const agents = useAgents();
  const [search, setSearch] = useSearchParams();
  const [text, setText] = createSignal("");
  const typed = createSettled(text, 250);
  const [sort, setSort] = createSignal<LibrarySort>("recent");
  const items = useQuery(() => libraryQuery({ text: Str.trim(typed()), sort: sort() }), { interval: () => 10_000, keepPrevious: true });
  const [where, setWhere] = createSignal<Where>({ by: "all" });
  const [kind, setKind] = createSignal<KindFilter>("all");
  const [picked, setPicked] = createSignal<readonly string[]>([]);
  const [anchor, setAnchor] = createSignal<string>();
  const [asking, setAsking] = createSignal(false);
  const [looking, setLooking] = createSignal<number>();
  const [dragging, setDragging] = createSignal(false);
  const [seen, setSeen] = createSignal<ReadonlyMap<string, Seen>>(new Map());
  // What fails is said in a toast: the files' area holds only files.
  const act = createAct();
  const tile = () => Math.min(tileMax, Math.max(tileMin, prefsNow().libraryTile));
  const all = (): readonly LibraryItem[] => ready(items, undefined) ?? [];
  const jobs = (): readonly MediaJob[] => core()?.media ?? [];
  const working = () => making(jobs());
  const list = createMemo(() => shown({ items: all(), where: where(), kind: kind() }));
  const ids = createMemo(() => Arr.map(list(), (item) => item.attachment.id));
  const counts = createMemo(() => countsOf({ items: all(), where: where(), kind: kind() }));
  const area = useWidth();
  // The scroller's width less its padding on both sides.
  const inner = () => Math.max(0, area.width() - 2 * 16);
  const rows = createMemo(() => {
    const known = seen();
    return justify({ ratios: Arr.map(list(), (item) => ratioOf({ item, seen: known.get(item.attachment.id) })), width: inner(), height: tile(), gap: tileGap });
  });
  const chosen = createMemo(() => {
    const on = picked();
    return Arr.filter(all(), (item) => on.includes(item.attachment.id));
  });
  const active = () => anchor() ?? picked().at(-1);
  const pictures = createMemo(() =>
    Arr.map(
      Arr.filter(list(), (item) => kindOf(item.attachment.type) === "image"),
      (item) => ({
        id: item.attachment.id,
        src: attachmentPath(item.attachment.id),
        name: item.attachment.name,
      }),
    ),
  );
  const names: Names = {
    agent: (id) =>
      Arr.findFirst(ready(agents, undefined) ?? [], (a) => a.id === id).pipe(
        Option.map((a) => a.name),
        Option.getOrElse(() => id),
      ),
    channel: (id) =>
      Arr.findFirst(core()?.chat?.channels ?? [], (x) => x.id === id).pipe(
        Option.map((c) => `#${c.name ?? c.id}`),
        Option.getOrElse(() => id),
      ),
  };
  // A job that finishes adds a file: the list is read again when the count of finished ones changes.
  createEffect(
    () => Arr.filter(jobs(), (job) => job.phase === "ready").length,
    (n, was) => {
      if (was !== undefined && n !== was) void items.refetch();
    },
  );
  // What was picked and has gone (removed, filtered out) is not picked any more.
  createEffect(
    () => ids(),
    (now) => {
      const kept = Arr.filter(picked(), (id) => now.includes(id));
      if (kept.length !== picked().length) {
        setPicked(kept);
        setAsking(false);
      }
    },
  );
  const make = (): Make | undefined => {
    const m = search().get("make");
    return Option.getOrUndefined(Arr.findFirst(makes, (x) => x === m));
  };
  const understanding = () => {
    const id = search().get("understand");
    if (id === null || id === "") return undefined;
    return Arr.findFirst(all(), (item) => item.attachment.id === id).pipe(
      Option.map((item) => item.attachment),
      Option.getOrElse(() => ({ id, name: id, type: "", size: 0 })),
    );
  };
  const [picker, setPicker] = createSignal<HTMLInputElement>();
  const upload = (files: readonly File[]) =>
    files.length === 0
      ? Promise.resolve()
      : act.run(() =>
          Promise.all(
            Arr.map(files, (file) =>
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
          ).then((added) => {
            void items.refetch();
            const last = added.at(-1);
            if (last !== undefined) {
              setPicked([last.attachment.id]);
              setAnchor(last.attachment.id);
            }
          }),
        );
  const pick = (id: string, how: { readonly add: boolean; readonly range: boolean }) => {
    setAsking(false);
    const from = anchor();
    if (how.range && from !== undefined) setPicked(between({ ids: ids(), from, to: id }));
    else if (how.add) {
      setPicked((was) => (was.includes(id) ? Arr.filter(was, (x) => x !== id) : [...was, id]));
      setAnchor(id);
    } else {
      setPicked([id]);
      setAnchor(id);
    }
  };
  const look = (id: string | undefined) => {
    const at = Arr.findFirstIndex(pictures(), (p) => p.id === id);
    if (Option.isSome(at)) setLooking(at.value);
  };
  const send = (channel: string) => {
    const files = chosen();
    const attachments = Arr.map(files, (item) => item.attachment.id);
    const words = Arr.join(
      Arr.map(files, (item) => item.attachment.name),
      "\n",
    );
    return act.run(() =>
      publicationKey(`library:${Arr.join(attachments, ",")}`, channel)
        .then((sendKey) => api.channel.message.send({ id: channel, text: words, attachments, sendKey }))
        .then(() => toast(t("web.library.sentTo", { channel: names.channel(channel) }))),
    );
  };
  const remove = () => {
    const gone = picked();
    return act.run(() =>
      Promise.all(Arr.map(gone, (id) => api.library.item.delete({ id }))).then(() => {
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
    if (e.key === "Escape" && picked().length > 0) {
      setPicked([]);
      setAnchor(undefined);
      setAsking(false);
    }
  };
  // A file pasted anywhere on the page goes in, unless a field takes the paste for its words.
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
  const empty = () => all().length === 0 && working().length === 0 && Str.isEmpty(Str.trim(typed()));
  return (
    <div
      data-testid="library-page"
      {...stylex.attrs(styles.page)}
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
        onWhere={(w) => {
          setWhere(w);
          setAsking(false);
        }}
        onKind={(k) => {
          setKind(k);
          setAsking(false);
        }}
      />
      <div role="toolbar" aria-label={t("web.library.title")} {...stylex.attrs(styles.toolbar)}>
        <label {...stylex.attrs(styles.search)}>
          <Icon name="search" size={14} styles={styles.searchIcon} />
          <TextInput
            type="search"
            data-testid="library-search"
            placeholder={t("web.library.search")}
            aria-label={t("web.library.search")}
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
            styles={styles.searchInput}
          />
        </label>
        <Select
          label={t("web.library.sortLabel")}
          testid="library-sort"
          size="control"
          quiet
          value={sort()}
          onChange={setSort}
          options={Arr.map(LibrarySortValues, (value) => ({ value, label: t(`web.library.sort.${value}`) }))}
        />
        <span {...stylex.attrs(styles.grow)} />
        <div {...stylex.attrs(styles.size)}>
          <Icon name="image" size={12} />
          <Slider.Root min={tileMin} max={tileMax} step={8} value={tile()} onValueChange={setLibraryTile} {...stylex.attrs(styles.sliderRoot)}>
            <Slider.Control {...stylex.attrs(styles.sliderControl)}>
              <Slider.Track {...stylex.attrs(styles.sliderTrack)}>
                <Slider.Indicator {...stylex.attrs(styles.sliderIndicator)} />
                <Slider.Thumb aria-label={t("web.library.tileSize")} data-testid="library-tile-size" {...stylex.attrs(styles.sliderThumb)} />
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
          {...stylex.attrs(styles.hidden)}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void upload(files);
          }}
        />
        <Button data-testid="library-upload" icon="upload" disabled={act.busy()} onClick={() => picker()?.click()}>
          {act.busy() ? t("web.library.uploading") : t("web.library.upload")}
        </Button>
        <Button data-testid="library-make" tone="primary" icon="generate" onClick={() => setSearch({ make: "image" })}>
          {t("web.library.make")}
        </Button>
      </div>
      <div
        ref={area.ref}
        role={list().length > 0 ? "listbox" : undefined}
        aria-label={t("web.library.grid")}
        aria-multiselectable={list().length > 0 ? "true" : undefined}
        aria-activedescendant={active() === undefined ? undefined : `library-tile-${active()}`}
        tabindex={0}
        data-testid="library-grid"
        onKeyDown={onKey}
        onClick={(e) => {
          // A click between the tiles lets go of what was picked.
          if (e.target === e.currentTarget) {
            setPicked([]);
            setAnchor(undefined);
            setAsking(false);
          }
        }}
        {...stylex.attrs(styles.scroller)}
      >
        <Show
          when={!empty()}
          fallback={
            <Empty
              icon="media"
              testid="library-empty"
              action={
                <>
                  <p {...stylex.attrs(styles.emptyHow)}>{t("web.library.emptyHow")}</p>
                  <div {...stylex.attrs(styles.emptyActions)}>
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
          <Show when={list().length > 0} fallback={<Quiet>{t("web.library.nothingShown")}</Quiet>}>
            <Tiles
              items={list()}
              rows={rows()}
              picked={picked()}
              active={active()}
              seen={(id) => seen().get(id)}
              onSeen={(id, s) =>
                setSeen((was) => {
                  const had = was.get(id);
                  // A picture loaded again tells what is known already: no new map, no new layout.
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
          </Show>
        </Show>
      </div>
      <Show when={chosen().length > 0}>
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
            ask: () => setAsking(true),
            remove: () => void remove(),
            keep: () => setAsking(false),
            clear: () => {
              setPicked([]);
              setAnchor(undefined);
              setAsking(false);
            },
          }}
        />
      </Show>
      <Show when={dragging()}>
        <div data-testid="library-drop" {...stylex.attrs(styles.drop)}>
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
          options={Arr.map(makes, (value) => ({ value, label: t(`web.library.makeTabs.${value}`) }))}
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
