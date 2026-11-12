import { For, Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import { attachmentPath, type Channel, type LibraryItem } from "@vibevalley/protocol";

import { useNow } from "#/base/dom.tsx";
import { ago, momentText } from "#/base/format.ts";
import { Link } from "#/infra/router.ts";
import { Button } from "#/ui/Button.tsx";
import { sizeText } from "#/ui/domain/AttachmentTile.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { IconButton } from "#/ui/IconButton.tsx";
import { MoreMenu } from "#/ui/MoreMenu.tsx";

import { durationText, extOf, kindOf, type Names, originLine } from "./items.ts";
import type { Seen } from "./Tiles.tsx";

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
      items={props.channels.map((c) => ({ key: c.id, label: `#${c.name ?? c.id}`, icon: "chat" as const, onSelect: () => props.send(c.id) }))}
    />
  );
}

function Asking(props: { question: string; act: InspectorActions }) {
  return (
    <div role="alert" data-testid="library-remove-ask" class="flex flex-wrap items-center gap-2 rounded-md bg-bad-soft p-2 text-sm text-berry">
      <span class="basis-full">{props.question}</span>
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
    <aside
      aria-label={t("web.library.inspector.label")}
      data-testid="library-inspector"
      data-count={props.items.length}
      class="[grid-area:side] flex shrink-0 flex-col gap-4 overflow-y-auto bg-page p-4 w-76 max-sm:w-auto border-l max-sm:border-l-0 border-l-line static max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-30 max-sm:max-h-[70vh] border-t-0 max-sm:border-t border-t-line rounded-tl-none max-sm:rounded-tl-xl rounded-tr-none max-sm:rounded-tr-xl shadow-none max-sm:shadow-float max-sm:[animation-name:pop-in] max-sm:motion-reduce:[animation-name:none] [animation-duration:280ms] [animation-timing-function:var(--ease-out)]"
    >
      <Show
        when={one()}
        fallback={
          <>
            <div class="flex items-start gap-2">
              <p class="min-w-0 flex-1 wrap-anywhere text-base font-semibold">{t("web.library.inspector.selected", { n: props.items.length })}</p>
              <IconButton icon="close" label={t("web.library.inspector.clear")} testid="library-clear" onClick={() => props.act.clear()} />
            </div>
            <div class="flex flex-wrap gap-1">
              <For each={props.items}>
                {(item) => (
                  <span class="w-12 h-12 flex items-center justify-center overflow-hidden rounded-sm bg-hover text-muted" title={item.attachment.name}>
                    <Show when={kindOf(item.attachment.type) === "image"} fallback={<Icon name="file" size={16} />}>
                      <img src={attachmentPath(item.attachment.id)} alt="" class="w-full h-full object-cover" />
                    </Show>
                  </span>
                )}
              </For>
            </div>
            <div class="flex items-center gap-1">
              <SendMenu channels={props.act.channels} send={props.act.send} />
              <span class="flex-1" />
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
              <div class="flex items-start gap-2">
                <p data-testid="library-inspector-name" class="min-w-0 flex-1 wrap-anywhere text-base font-semibold">
                  {file().name}
                </p>
                <IconButton icon="close" label={t("web.library.inspector.clear")} testid="library-clear" onClick={() => props.act.clear()} />
              </div>
              <Switch>
                <Match when={kind() === "image"}>
                  <div class="flex min-h-32 max-h-72 items-center justify-center overflow-hidden rounded-lg bg-hover text-muted">
                    <img src={src()} alt={file().name} onClick={() => props.act.look()} class="max-w-full max-h-72 object-contain block cursor-zoom-in" />
                  </div>
                </Match>
                <Match when={kind() === "video"}>
                  <div class="flex min-h-32 max-h-72 items-center justify-center overflow-hidden rounded-lg bg-hover text-muted">
                    <video controls preload="metadata" src={src()} aria-label={file().name} class="w-full" />
                  </div>
                </Match>
                <Match when={kind() === "audio" || kind() === "other"}>
                  <div class={["flex min-h-32 max-h-72 items-center justify-center overflow-hidden rounded-lg bg-hover text-muted", "flex-col gap-1 py-6"]}>
                    <Icon name={kind() === "audio" ? "audio" : "file"} size={48} />
                    <Show when={extOf(file().name)}>{(ext) => <span class="text-xs font-medium text-ink">{ext()}</span>}</Show>
                  </div>
                </Match>
              </Switch>
              <Show when={kind() === "audio"}>
                <audio controls preload="metadata" src={src()} aria-label={file().name} class="w-full" />
              </Show>
              <div class="flex items-center gap-1">
                <IconButton icon="download" label={t("web.library.download")} testid="library-download" onClick={() => download(file().id, file().name)} />
                <SendMenu channels={props.act.channels} send={props.act.send} />
                <Show when={kind() === "image" || kind() === "video"}>
                  <IconButton icon="understand" label={t("web.library.understand")} testid="library-understand" onClick={() => props.act.understand()} />
                </Show>
                <span class="flex-1" />
                <MoreMenu
                  label={t("web.library.inspector.more")}
                  testid="library-more"
                  items={[{ key: "remove", label: t("web.library.remove"), icon: "delete", danger: true, onSelect: () => props.act.ask() }]}
                />
              </div>
              <Show when={props.asking}>
                <Asking question={t("web.library.removeAsk", { name: file().name })} act={props.act} />
              </Show>
              <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 m-0 text-sm">
                <dt class="text-muted whitespace-nowrap">{t("web.library.inspector.kind")}</dt>
                <dd class="m-0 min-w-0 wrap-anywhere text-ink">
                  {t(`web.library.kind.${kind()}`)} <span class="text-faint">{file().type}</span>
                </dd>
                <Show when={props.seen?.width !== undefined && props.seen.height !== undefined ? props.seen : undefined}>
                  {(seen) => (
                    <>
                      <dt class="text-muted whitespace-nowrap">{t("web.library.inspector.pixels")}</dt>
                      <dd data-testid="library-pixels" class="m-0 min-w-0 wrap-anywhere text-ink">
                        {seen().width} × {seen().height}
                      </dd>
                    </>
                  )}
                </Show>
                <Show when={props.seen?.seconds}>
                  {(s) => (
                    <>
                      <dt class="text-muted whitespace-nowrap">{t("web.library.inspector.length")}</dt>
                      <dd class="m-0 min-w-0 wrap-anywhere text-ink">{durationText(s())}</dd>
                    </>
                  )}
                </Show>
                <dt class="text-muted whitespace-nowrap">{t("web.library.inspector.bytes")}</dt>
                <dd class="m-0 min-w-0 wrap-anywhere text-ink">{sizeText(file().size)}</dd>
                <dt class="text-muted whitespace-nowrap">{t("web.library.inspector.from")}</dt>
                <dd data-testid="library-origin-line" class="m-0 min-w-0 wrap-anywhere text-ink">
                  {originLine(props.names)(item().origin)}
                  <Show when={channel()}>
                    {(c) => (
                      <>
                        {" · "}
                        <Link href={`/chat/${encodeURIComponent(c())}`} class="text-water no-underline hover:underline">
                          {t("web.library.inspector.openChannel", { channel: props.names.channel(c()) })}
                        </Link>
                      </>
                    )}
                  </Show>
                </dd>
                <dt class="text-muted whitespace-nowrap">{t("web.library.inspector.added")}</dt>
                <dd class="m-0 min-w-0 wrap-anywhere text-ink" title={momentText(item().addedAt)}>
                  {ago(item().addedAt, now())}
                </dd>
              </dl>
              <Show when={props.understood}>
                {(text) => (
                  <section class="flex flex-col gap-2">
                    <h3 class="text-xs font-medium text-faint">{t("web.library.understood")}</h3>
                    <p data-testid="library-understood" class="whitespace-pre-wrap text-sm">
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
