import * as stylex from "@stylexjs/stylex";
import { Array as Arr } from "effect";
import { For, Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import { attachmentPath, type Channel, type LibraryItem } from "@vibevalley/protocol";

import { useNow } from "#/base/dom.tsx";
import { ago, momentText } from "#/base/format.ts";
import { Link } from "#/infra/router.ts";
import { sizeText } from "#/ui/AttachmentTile.tsx";
import { Button } from "#/ui/Button.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { IconButton } from "#/ui/IconButton.tsx";
import { MoreMenu } from "#/ui/MoreMenu.tsx";

import { durationText, extOf, kindOf, type Names, originLine } from "./items.ts";
import type { Seen } from "./Tiles.tsx";

const styles = stylex.create({
  panel: {
    gridArea: "side",
    display: "flex",
    flexShrink: 0,
    flexDirection: "column",
    gap: "calc(var(--spacing) * 4)",
    overflowY: "auto",
    backgroundColor: "var(--color-page)",
    padding: "calc(var(--spacing) * 4)",
    width: { default: "calc(var(--spacing) * 76)", "@media (width < 40rem)": "auto" },
    borderLeftWidth: { default: 1, "@media (width < 40rem)": 0 },
    borderLeftStyle: "solid",
    borderLeftColor: "var(--color-line)",
    // On a phone it is a sheet from the bottom, over the files.
    position: { default: "static", "@media (width < 40rem)": "fixed" },
    insetInline: { default: null, "@media (width < 40rem)": 0 },
    bottom: { default: null, "@media (width < 40rem)": 0 },
    zIndex: { default: null, "@media (width < 40rem)": 30 },
    maxHeight: { default: null, "@media (width < 40rem)": "70vh" },
    borderTopWidth: { default: 0, "@media (width < 40rem)": 1 },
    borderTopStyle: "solid",
    borderTopColor: "var(--color-line)",
    borderTopLeftRadius: { default: 0, "@media (width < 40rem)": "var(--radius-xl)" },
    borderTopRightRadius: { default: 0, "@media (width < 40rem)": "var(--radius-xl)" },
    boxShadow: { default: "none", "@media (width < 40rem)": "var(--shadow-float)" },
    animationName: { default: null, "@media (width < 40rem)": { default: "pop-in", "@media (prefers-reduced-motion: reduce)": "none" } },
    animationDuration: "280ms",
    animationTimingFunction: "var(--ease-out)",
  },
  preview: {
    display: "flex",
    minHeight: "calc(var(--spacing) * 32)",
    maxHeight: "calc(var(--spacing) * 72)",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderRadius: "var(--radius-lg)",
    backgroundColor: "var(--color-hover)",
    color: "var(--color-muted)",
  },
  previewPlain: { flexDirection: "column", gap: "var(--spacing)", paddingBlock: "calc(var(--spacing) * 6)" },
  image: { maxWidth: "100%", maxHeight: "calc(var(--spacing) * 72)", objectFit: "contain", display: "block", cursor: "zoom-in" },
  player: { width: "100%" },
  ext: { fontSize: "var(--text-xs)", lineHeight: "var(--text-xs--line-height)", fontWeight: "var(--font-weight-medium)", color: "var(--color-ink)" },
  head: { display: "flex", alignItems: "flex-start", gap: "calc(var(--spacing) * 2)" },
  name: {
    minWidth: 0,
    flex: 1,
    overflowWrap: "anywhere",
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  actions: { display: "flex", alignItems: "center", gap: "var(--spacing)" },
  grow: { flex: 1 },
  facts: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    columnGap: "calc(var(--spacing) * 4)",
    rowGap: "calc(var(--spacing) * 2)",
    margin: 0,
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  term: { color: "var(--color-muted)", whiteSpace: "nowrap" },
  value: { margin: 0, minWidth: 0, overflowWrap: "anywhere", color: "var(--color-ink)" },
  faint: { color: "var(--color-faint)" },
  link: { color: "var(--color-water)", textDecorationLine: { default: "none", ":hover": "underline" } },
  section: { display: "flex", flexDirection: "column", gap: "calc(var(--spacing) * 2)" },
  sectionTitle: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--color-faint)",
  },
  understood: { whiteSpace: "pre-wrap", fontSize: "var(--text-sm)", lineHeight: "var(--text-sm--line-height)" },
  // Asking before something goes: a berry tinted line, the danger button and a way out (docs/style/design.md).
  ask: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--color-bad-soft)",
    padding: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-berry)",
  },
  askWords: { flexBasis: "100%" },
  strip: { display: "flex", flexWrap: "wrap", gap: "var(--spacing)" },
  stripItem: {
    width: "calc(var(--spacing) * 12)",
    height: "calc(var(--spacing) * 12)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--color-hover)",
    color: "var(--color-muted)",
  },
  stripImage: { width: "100%", height: "100%", objectFit: "cover" },
});

export interface InspectorActions {
  readonly channels: readonly Channel[];
  readonly send: (channel: string) => void;
  readonly understand: () => void;
  readonly look: () => void;
  readonly ask: () => void;
  readonly remove: () => void;
  readonly keep: () => void;
  readonly clear: () => void;
}

const download = (id: string, name: string) => {
  const a = document.createElement("a");
  a.href = attachmentPath(id);
  a.download = name;
  a.click();
};

function SendMenu(props: { channels: readonly Channel[]; send: (channel: string) => void }) {
  return (
    <MoreMenu
      label={t("web.library.sendTo")}
      icon="send"
      testid="library-send"
      items={Arr.map(props.channels, (c) => ({ key: c.id, label: `#${c.name ?? c.id}`, icon: "chat" as const, onSelect: () => props.send(c.id) }))}
    />
  );
}

function Asking(props: { question: string; act: InspectorActions }) {
  return (
    <div role="alert" data-testid="library-remove-ask" {...stylex.attrs(styles.ask)}>
      <span {...stylex.attrs(styles.askWords)}>{props.question}</span>
      <Button tone="danger" data-testid="library-remove-sure" onClick={() => props.act.remove()}>
        {t("web.library.removeSure")}
      </Button>
      <Button tone="quiet" data-testid="library-remove-keep" onClick={() => props.act.keep()}>
        {t("web.library.keep")}
      </Button>
    </div>
  );
}

/** The one file chosen, at length: a large look at it, what it is and where it came from, and what can be done with it. */
export function Inspector(props: {
  items: readonly LibraryItem[];
  seen: Seen | undefined;
  understood: string | undefined;
  names: Names;
  asking: boolean;
  act: InspectorActions;
}) {
  const now = useNow();
  const one = () => (props.items.length === 1 ? props.items[0] : undefined);
  return (
    <aside aria-label={t("web.library.inspector.label")} data-testid="library-inspector" data-count={props.items.length} {...stylex.attrs(styles.panel)}>
      <Show
        when={one()}
        fallback={
          <>
            <div {...stylex.attrs(styles.head)}>
              <p {...stylex.attrs(styles.name)}>{t("web.library.inspector.selected", { n: props.items.length })}</p>
              <IconButton icon="close" label={t("web.library.inspector.clear")} testid="library-clear" onClick={() => props.act.clear()} />
            </div>
            <div {...stylex.attrs(styles.strip)}>
              <For each={props.items}>
                {(item) => (
                  <span {...stylex.attrs(styles.stripItem)} title={item.attachment.name}>
                    <Show when={kindOf(item.attachment.type) === "image"} fallback={<Icon name="file" size={16} />}>
                      <img src={attachmentPath(item.attachment.id)} alt="" {...stylex.attrs(styles.stripImage)} />
                    </Show>
                  </span>
                )}
              </For>
            </div>
            <div {...stylex.attrs(styles.actions)}>
              <SendMenu channels={props.act.channels} send={props.act.send} />
              <span {...stylex.attrs(styles.grow)} />
              <MoreMenu
                label={t("web.library.inspector.more")}
                testid="library-more"
                items={[{ key: "remove", label: t("web.library.remove"), icon: "delete", danger: true, onSelect: () => props.act.ask() }]}
              />
            </div>
            <Show when={props.asking}>
              <Asking question={t("web.library.removeSome", { n: props.items.length })} act={props.act} />
            </Show>
          </>
        }
      >
        {(item) => {
          const file = () => item().attachment;
          const kind = () => kindOf(file().type);
          const src = () => attachmentPath(file().id);
          const channel = () => {
            const origin = item().origin;
            return origin.kind === "uploaded" ? origin.channel : undefined;
          };
          return (
            <>
              <div {...stylex.attrs(styles.head)}>
                <p data-testid="library-inspector-name" {...stylex.attrs(styles.name)}>
                  {file().name}
                </p>
                <IconButton icon="close" label={t("web.library.inspector.clear")} testid="library-clear" onClick={() => props.act.clear()} />
              </div>
              <Switch>
                <Match when={kind() === "image"}>
                  <div {...stylex.attrs(styles.preview)}>
                    <img src={src()} alt={file().name} onClick={() => props.act.look()} {...stylex.attrs(styles.image)} />
                  </div>
                </Match>
                <Match when={kind() === "video"}>
                  <div {...stylex.attrs(styles.preview)}>
                    <video controls preload="metadata" src={src()} aria-label={file().name} {...stylex.attrs(styles.player)} />
                  </div>
                </Match>
                <Match when={kind() === "audio" || kind() === "other"}>
                  <div {...stylex.attrs(styles.preview, styles.previewPlain)}>
                    <Icon name={kind() === "audio" ? "audio" : "file"} size={48} />
                    <Show when={extOf(file().name)}>{(ext) => <span {...stylex.attrs(styles.ext)}>{ext()}</span>}</Show>
                  </div>
                </Match>
              </Switch>
              <Show when={kind() === "audio"}>
                <audio controls preload="metadata" src={src()} aria-label={file().name} {...stylex.attrs(styles.player)} />
              </Show>
              <div {...stylex.attrs(styles.actions)}>
                <IconButton icon="download" label={t("web.library.download")} testid="library-download" onClick={() => download(file().id, file().name)} />
                <SendMenu channels={props.act.channels} send={props.act.send} />
                <Show when={kind() === "image" || kind() === "video"}>
                  <IconButton icon="understand" label={t("web.library.understand")} testid="library-understand" onClick={() => props.act.understand()} />
                </Show>
                <span {...stylex.attrs(styles.grow)} />
                <MoreMenu
                  label={t("web.library.inspector.more")}
                  testid="library-more"
                  items={[{ key: "remove", label: t("web.library.remove"), icon: "delete", danger: true, onSelect: () => props.act.ask() }]}
                />
              </div>
              <Show when={props.asking}>
                <Asking question={t("web.library.removeAsk", { name: file().name })} act={props.act} />
              </Show>
              <dl {...stylex.attrs(styles.facts)}>
                <dt {...stylex.attrs(styles.term)}>{t("web.library.inspector.kind")}</dt>
                <dd {...stylex.attrs(styles.value)}>
                  {t(`web.library.kind.${kind()}`)} <span {...stylex.attrs(styles.faint)}>{file().type}</span>
                </dd>
                <Show when={props.seen?.width !== undefined && props.seen.height !== undefined ? props.seen : undefined}>
                  {(seen) => (
                    <>
                      <dt {...stylex.attrs(styles.term)}>{t("web.library.inspector.pixels")}</dt>
                      <dd data-testid="library-pixels" {...stylex.attrs(styles.value)}>
                        {seen().width} × {seen().height}
                      </dd>
                    </>
                  )}
                </Show>
                <Show when={props.seen?.seconds}>
                  {(s) => (
                    <>
                      <dt {...stylex.attrs(styles.term)}>{t("web.library.inspector.length")}</dt>
                      <dd {...stylex.attrs(styles.value)}>{durationText(s())}</dd>
                    </>
                  )}
                </Show>
                <dt {...stylex.attrs(styles.term)}>{t("web.library.inspector.bytes")}</dt>
                <dd {...stylex.attrs(styles.value)}>{sizeText(file().size)}</dd>
                <dt {...stylex.attrs(styles.term)}>{t("web.library.inspector.from")}</dt>
                <dd data-testid="library-origin-line" {...stylex.attrs(styles.value)}>
                  {originLine(props.names)(item().origin)}
                  <Show when={channel()}>
                    {(c) => (
                      <>
                        {" · "}
                        <Link href={`/chat/${encodeURIComponent(c())}`} {...stylex.attrs(styles.link)}>
                          {t("web.library.inspector.openChannel", { channel: props.names.channel(c()) })}
                        </Link>
                      </>
                    )}
                  </Show>
                </dd>
                <dt {...stylex.attrs(styles.term)}>{t("web.library.inspector.added")}</dt>
                <dd {...stylex.attrs(styles.value)} title={momentText(item().addedAt)}>
                  {ago(item().addedAt, now())}
                </dd>
              </dl>
              <Show when={props.understood}>
                {(text) => (
                  <section {...stylex.attrs(styles.section)}>
                    <h3 {...stylex.attrs(styles.sectionTitle)}>{t("web.library.understood")}</h3>
                    <p data-testid="library-understood" {...stylex.attrs(styles.understood)}>
                      {text()}
                    </p>
                  </section>
                )}
              </Show>
            </>
          );
        }}
      </Show>
    </aside>
  );
}
