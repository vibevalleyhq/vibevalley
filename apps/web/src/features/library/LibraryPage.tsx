import * as stylex from "@stylexjs/stylex";
import { Array as Arr, Option } from "effect";
import { createEffect, createSignal, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import { attachmentPath, type LibraryItem, type MediaJob } from "@vibevalley/protocol";

import { useNow } from "#/base/dom.tsx";
import { ago } from "#/base/format.ts";
import { AudioPanel, ImagePanel, publicationKey, SpeechPanel, UnderstandingPanel } from "#/features/media/index.ts";
import { api } from "#/infra/api.ts";
import { attachmentData } from "#/infra/attachment.ts";
import { useCore } from "#/infra/frame.ts";
import { ready, useAgents, useQuery } from "#/infra/query.ts";
import { Link, useSearchParams } from "#/infra/router.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { ConfirmButton } from "#/ui/ConfirmButton.tsx";
import { Dialog } from "#/ui/Dialog.tsx";
import { Select } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { Empty, Quiet } from "#/ui/layout.tsx";
import { Segmented } from "#/ui/Segmented.tsx";

import { type KindFilter, kindOf, making, type Names, type OriginFilter, originLine, shown, understoodText } from "./items.ts";
import { libraryQuery } from "./queries.ts";

const viewStyles = stylex.create({
  page: {
    display: "flex",
    height: "100%",
    minWidth: 0,
    flexDirection: "column",
    gap: "calc(var(--spacing) * 4)",
    overflowY: "auto",
    padding: "calc(var(--spacing) * 5)",
  },
  header: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "calc(var(--spacing) * 3)" },
  title: { fontSize: "var(--text-xl)", lineHeight: "var(--text-xl--line-height)", fontWeight: "var(--font-weight-semibold)" },
  link: { fontSize: "var(--text-sm)", lineHeight: "var(--text-sm--line-height)", color: "var(--color-water)", textDecorationLine: "underline" },
  grow: { flex: 1 },
  bar: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "calc(var(--spacing) * 3)" },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, calc(var(--spacing) * 64)), 1fr))",
    alignItems: "start",
    gap: "calc(var(--spacing) * 4)",
  },
  card: {
    display: "flex",
    minWidth: 0,
    flexDirection: "column",
    overflow: "hidden",
    borderRadius: "var(--radius-lg)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-paper)",
  },
  preview: {
    display: "flex",
    aspectRatio: "4 / 3",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    color: "var(--color-muted)",
  },
  previewImage: { height: "100%", width: "100%", objectFit: "contain" },
  previewMedia: { width: "100%" },
  body: { display: "flex", minWidth: 0, flexDirection: "column", gap: "calc(var(--spacing) * 2)", padding: "calc(var(--spacing) * 3)" },
  name: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  line: { fontSize: "var(--text-xs)", lineHeight: "var(--text-xs--line-height)", overflowWrap: "anywhere", color: "var(--color-muted)" },
  understood: {
    display: "-webkit-box",
    overflow: "hidden",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 4,
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    whiteSpace: "pre-wrap",
  },
  actions: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "calc(var(--spacing) * 2)" },
  send: { display: "flex", minWidth: 0, alignItems: "center", gap: "calc(var(--spacing) * 2)" },
  error: { fontSize: "var(--text-sm)", lineHeight: "var(--text-sm--line-height)", color: "var(--color-berry)" },
  hidden: { display: "none" },
});

type Make = "image" | "speech" | "audio";
const makes: readonly Make[] = ["image", "speech", "audio"];

/** The library (/library): every kept file with where it came from; ?make= opens the generate dialog on a form,
 * ?understand=<attachment id> the understanding of one file. */
export function LibraryPage() {
  const core = useCore();
  const items = useQuery(libraryQuery, { interval: () => 10_000 });
  const agents = useAgents();
  const [search, setSearch] = useSearchParams();
  const [origin, setOrigin] = createSignal<OriginFilter>("all");
  const [kind, setKind] = createSignal<KindFilter>("all");
  const [error, setError] = createSignal<string>();
  const act = createAct(setError);
  const all = () => ready(items, undefined) ?? [];
  const jobs = (): readonly MediaJob[] => core()?.media ?? [];
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
    act.run(() =>
      Promise.all(
        Arr.map(files, (file) =>
          attachmentData(file)
            .then((data) =>
              api.attachment.create({ name: file.name === "" ? "file" : file.name, type: file.type === "" ? "application/octet-stream" : file.type, data }),
            )
            .then((kept) => api.library.item.add({ attachment: kept.id })),
        ),
      ).then(() => items.refetch()),
    );
  return (
    <div {...stylex.attrs(viewStyles.page)} data-testid="library-page">
      <div {...stylex.attrs(viewStyles.header)}>
        <h1 {...stylex.attrs(viewStyles.title)}>{t("web.library.title")}</h1>
        <Link href="/settings/providers" {...stylex.attrs(viewStyles.link)}>
          {t("web.library.configure")}
        </Link>
        <span {...stylex.attrs(viewStyles.grow)} />
        <input
          ref={setPicker}
          type="file"
          multiple
          data-testid="library-file"
          aria-label={t("web.library.upload")}
          {...stylex.attrs(viewStyles.hidden)}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void upload(files);
          }}
        />
        <Button data-testid="library-upload" disabled={act.busy()} onClick={() => picker()?.click()}>
          <Icon name="add" size={16} />
          {act.busy() ? t("web.library.uploading") : t("web.library.upload")}
        </Button>
        <Button data-testid="library-make" tone="primary" onClick={() => setSearch({ make: "image" })}>
          {t("web.library.make")}
        </Button>
      </div>
      <div {...stylex.attrs(viewStyles.bar)}>
        <Segmented
          label={t("web.library.originLabel")}
          testid="library-origin"
          value={origin()}
          onChange={setOrigin}
          options={Arr.map(["all", "generated", "uploaded", "fetched"] as const, (value) => ({ value, label: t(`web.library.origin.${value}`) }))}
        />
        <Segmented
          label={t("web.library.kindLabel")}
          testid="library-kind"
          value={kind()}
          onChange={setKind}
          options={Arr.map(["all", "image", "audio", "video", "other"] as const, (value) => ({ value, label: t(`web.library.kind.${value}`) }))}
        />
      </div>
      <Show when={error()}>
        {(why) => (
          <p role="alert" {...stylex.attrs(viewStyles.error)}>
            {why()}
          </p>
        )}
      </Show>
      <Show
        when={all().length > 0 || making(jobs()).length > 0}
        fallback={
          <Empty icon="media" testid="library-empty">
            {t("web.library.empty")}
          </Empty>
        }
      >
        <Show
          when={shown({ items: all(), origin: origin(), kind: kind() }).length > 0 || making(jobs()).length > 0}
          fallback={<Quiet>{t("web.library.nothingShown")}</Quiet>}
        >
          <div {...stylex.attrs(viewStyles.grid)} data-testid="library-grid">
            <For each={making(jobs())} keyed={(job) => job.id}>
              {(job) => (
                <div data-testid="library-making" data-id={job().id} data-phase={job().phase} {...stylex.attrs(viewStyles.card)}>
                  <div {...stylex.attrs(viewStyles.preview)}>
                    <Icon name="clock" size={48} />
                  </div>
                  <div {...stylex.attrs(viewStyles.body)}>
                    <p {...stylex.attrs(viewStyles.name)}>{job().phaseText}</p>
                  </div>
                </div>
              )}
            </For>
            <For each={shown({ items: all(), origin: origin(), kind: kind() })} keyed={(item) => item.attachment.id}>
              {(item) => (
                <ItemCard
                  item={item()}
                  names={names}
                  understood={understoodText(item().attachment.id)(jobs())}
                  onUnderstand={() => setSearch({ understand: item().attachment.id })}
                  onRemoved={() => void items.refetch()}
                />
              )}
            </For>
          </div>
        </Show>
      </Show>
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

function ItemCard(props: { item: LibraryItem; names: Names; understood: string | undefined; onUnderstand: () => void; onRemoved: () => void }) {
  const core = useCore();
  const [channel, setChannel] = createSignal("");
  const [sent, setSent] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const act = createAct(setError);
  const file = () => props.item.attachment;
  const kind = () => kindOf(file().type);
  const now = useNow();
  const send = () => {
    const id = channel();
    const attachment = file().id;
    const text = file().name;
    return act.run(() =>
      publicationKey(`library:${attachment}`, id)
        .then((sendKey) => api.channel.message.send({ id, text, attachments: [attachment], sendKey }))
        .then(() => setSent(true)),
    );
  };
  const remove = () => {
    const id = file().id;
    const removed = props.onRemoved;
    return act.run(() => api.library.item.delete({ id }).then(removed));
  };
  return (
    <article data-testid="library-item" data-key={file().id} data-origin={props.item.origin.kind} data-kind={kind()} {...stylex.attrs(viewStyles.card)}>
      <div {...stylex.attrs(viewStyles.preview)}>
        <Show when={kind() === "image"}>
          <img src={attachmentPath(file().id)} alt={file().name} loading="lazy" {...stylex.attrs(viewStyles.previewImage)} />
        </Show>
        <Show when={kind() === "audio"}>
          <audio controls preload="none" src={attachmentPath(file().id)} aria-label={file().name} {...stylex.attrs(viewStyles.previewMedia)} />
        </Show>
        <Show when={kind() === "video"}>
          <video controls preload="metadata" src={attachmentPath(file().id)} aria-label={file().name} {...stylex.attrs(viewStyles.previewImage)} />
        </Show>
        <Show when={kind() === "other"}>
          <Icon name="file" size={48} />
        </Show>
      </div>
      <div {...stylex.attrs(viewStyles.body)}>
        <p {...stylex.attrs(viewStyles.name)} title={file().name}>
          {file().name}
        </p>
        <p data-testid="library-origin-line" {...stylex.attrs(viewStyles.line)}>
          {originLine(props.names)(props.item.origin)} · {ago(props.item.lastAt, now())}
        </p>
        <Show when={props.understood}>
          {(text) => (
            <p data-testid="library-understood" aria-label={t("web.library.understood")} {...stylex.attrs(viewStyles.understood)}>
              {text()}
            </p>
          )}
        </Show>
        <div {...stylex.attrs(viewStyles.actions)}>
          <a data-testid="library-download" href={attachmentPath(file().id)} download={file().name} {...stylex.attrs(viewStyles.link)}>
            {t("web.library.download")}
          </a>
          <Show when={kind() === "image" || kind() === "video"}>
            <Button data-testid="library-understand" onClick={() => props.onUnderstand()}>
              {t("web.library.understand")}
            </Button>
          </Show>
          <ConfirmButton
            testid="library-remove"
            tone="danger"
            label={t("web.library.remove")}
            question={t("web.library.removeAsk", { name: file().name })}
            disabled={act.busy()}
            onConfirm={() => void remove()}
          />
        </div>
        <div {...stylex.attrs(viewStyles.send)}>
          <Select
            label={t("web.library.sendTo")}
            testid="library-channel"
            placeholder={t("web.library.sendTo")}
            value={channel()}
            onChange={(value) => {
              setChannel(value);
              setSent(false);
            }}
            options={Arr.map(core()?.chat?.channels ?? [], (c) => ({ value: c.id, label: c.name ?? c.id }))}
          />
          <Button
            data-testid="library-send"
            data-sent={sent() ? "true" : "false"}
            disabled={act.busy() || channel() === "" || sent()}
            onClick={() => void send()}
          >
            {sent() ? t("web.library.sent") : t("web.library.send")}
          </Button>
        </div>
        <Show when={error()}>
          {(why) => (
            <p role="alert" {...stylex.attrs(viewStyles.error)}>
              {why()}
            </p>
          )}
        </Show>
      </div>
    </article>
  );
}
