import { cleanup, Clipboard, effect, Image, Scroll, signal, Text, untracked, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Channel, LibraryItem } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { sizeText } from "../../design/domain/AttachmentTile";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { MoreMenu } from "../../design/MoreMenu";
import { toast } from "../../design/toasts";
import { openAttachment, playAudio, saveFile, useAttachmentFile, useAttachmentUrl } from "../../infra/attachmentFile";
import { useNow } from "../../infra/base/dom";
import { ago } from "../../infra/base/format";
import { useTimeout } from "../../infra/base/timer";
import { hostApi } from "../../infra/bridge";
import { Link } from "../../infra/router";
import { durationText, extOf, kindOf, type Names, originLine } from "./items";
import type { Seen } from "./Tiles";

export interface InspectorActions {
  readonly channels: readonly Channel[];
  readonly send: (channel: string) => void;
  readonly understand: () => void;
  readonly look: () => void;
  readonly togglePin: (id: string) => void;
  readonly ask: () => void;
  readonly remove: () => void;
  readonly keep: () => void;
  readonly clear: () => void;
}

function PropRow(props: { label: string; children: JSX.Element }) {
  return (
    <View class="flex-row items-baseline gap-3">
      <Text class="w-16 shrink-0 text-xs text-muted">{props.label}</Text>
      <View class="min-w-0 flex-1">{props.children}</View>
    </View>
  );
}

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

function Asking(props: { question: string; onRemove: () => void; onKeep: () => void }) {
  return (
    <View role="alert" testID="library-remove-ask" class="flex-row flex-wrap items-center gap-2 rounded-md bg-bad-soft p-2.5">
      <Text class="w-full text-sm text-berry">{props.question}</Text>
      <Button tone="danger" testID="library-remove-sure" onPress={() => props.onRemove()}>
        {t("web.library.removeSure")}
      </Button>
      <Button tone="quiet" testID="library-remove-keep" onPress={() => props.onKeep()}>
        {t("web.library.keep")}
      </Button>
    </View>
  );
}

export function Inspector(props: {
  items: readonly LibraryItem[];
  pinned: boolean;
  seen: Seen | undefined;
  understood: string | undefined;
  names: Names;
  asking: boolean;
  act: InspectorActions;
}) {
  const now = useNow();
  const fileAct = createAct();
  const audioAct = createAct();
  const playingPath = signal<string | undefined>(undefined);
  const copiedPath = signal(false);
  const later = useTimeout();
  const one = () => (props.items.length === 1 ? props.items[0] : undefined);
  const oneId = () => one()?.attachment.id ?? "";
  const url = useAttachmentUrl(oneId);
  const diskFile = useAttachmentFile(oneId);

  effect(() => {
    void oneId();
    copiedPath.set(false);
  });

  effect(() => {
    const currentPath = diskFile()?.path;
    const playing = untracked(playingPath);
    if (playing !== undefined && playing !== currentPath) {
      playingPath.set(undefined);
      void hostApi.stopAudio();
    }
  });

  cleanup(() => {
    if (untracked(playingPath) !== undefined) {
      playingPath.set(undefined);
      void hostApi.stopAudio();
    }
  });

  const toggleAudio = (path: string) => {
    if (untracked(playingPath) === path) {
      playingPath.set(undefined);
      void audioAct.run(() => hostApi.stopAudio());
      return;
    }
    playingPath.set(path);
    void audioAct.run(async () => {
      try {
        await playAudio(path);
      } catch (e) {
        playingPath.set(undefined);
        throw e;
      }
    });
  };

  return (
    <View testID="library-inspector" class="h-full min-h-0 w-76 shrink-0 border-l border-line bg-side">
      <View desktop={{ windowDrag: true }} class="h-9 shrink-0 flex-row items-center gap-1.5 border-b border-line px-3">
        <If
          when={one()}
          else={
            <>
              <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{t("web.library.inspector.selected", { n: props.items.length })}</Text>
              <IconButton icon="close" size={14} label={t("web.library.inspector.clear")} testid="library-clear" onClick={() => props.act.clear()} />
            </>
          }
        >
          {(item) => (
            <>
              <Text testID="library-inspector-name" class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
                {item().attachment.name}
              </Text>
              <IconButton
                icon="pin"
                size={14}
                label={props.pinned ? t("web.library.content.unpin") : t("web.library.content.pin")}
                testid="library-pin"
                pressed={props.pinned}
                onClick={() => props.act.togglePin(item().attachment.id)}
              />
              <IconButton icon="close" size={14} label={t("web.library.inspector.clear")} testid="library-clear" onClick={() => props.act.clear()} />
            </>
          )}
        </If>
      </View>
      <Scroll class="min-h-0 flex-1" contentClass="gap-4 p-4">
        <If
          when={one()}
          else={
            <>
              <View class="flex-row items-center gap-1 border-b border-line pb-3">
                <SendMenu channels={props.act.channels} send={props.act.send} />
                <View class="flex-1" />
                <MoreMenu
                  label={t("web.library.inspector.more")}
                  testid="library-more"
                  items={[{ key: "remove", label: t("web.library.remove"), icon: "delete", danger: true, onSelect: () => props.act.ask() }]}
                />
              </View>
              <If when={props.asking}>
                <Asking question={t("web.library.removeSome", { n: props.items.length })} onRemove={() => props.act.remove()} onKeep={() => props.act.keep()} />
              </If>
            </>
          }
        >
          {(item) => {
            const file = () => item().attachment;
            const kind = () => kindOf(file().type);
            const channel = () => {
              const origin = item().origin;
              return origin.kind === "uploaded" ? origin.channel : undefined;
            };
            return (
              <>
                <View
                  role="button"
                  onPress={() => (kind() === "image" ? props.act.look() : void openAttachment(file().id))}
                  class="min-h-36 max-h-64 items-center justify-center overflow-hidden rounded-lg border border-line bg-page p-2 hover:border-faint"
                >
                  <If
                    when={kind() === "image" ? url() : undefined}
                    else={
                      <View class="items-center gap-1.5 py-6">
                        <Icon name={kind() === "audio" ? "audio" : kind() === "video" ? "video" : "file"} size={48} tone="muted" />
                        <If when={extOf(file().name)}>{(ext) => <Text class="font-mono text-xs font-medium text-muted">{ext()}</Text>}</If>
                      </View>
                    }
                  >
                    {(src) => <Image src={src()} class="h-45 w-60 object-contain" />}
                  </If>
                </View>

                <If when={kind() === "audio" ? diskFile()?.path : undefined}>
                  {(path) => {
                    const playing = () => playingPath() === path();
                    return (
                      <View class="flex-row items-center gap-2.5 rounded-lg border border-line bg-page p-2.5">
                        <Button
                          testID="library-audio-toggle"
                          tone={playing() ? "plain" : "primary"}
                          icon={playing() ? "stop" : "play"}
                          disabled={audioAct.busy()}
                          class="flex-1"
                          onPress={() => toggleAudio(path())}
                        >
                          {playing() ? t("web.library.content.inspector.stopAudio") : t("web.library.kind.audio")}
                        </Button>
                        <If when={props.seen?.seconds}>{(s) => <Text class="shrink-0 font-mono text-xs text-muted tabular-nums">{durationText(s())}</Text>}</If>
                      </View>
                    );
                  }}
                </If>

                <View class="flex-row items-center gap-1 border-b border-line pb-3">
                  <IconButton
                    icon="open"
                    label={t("web.library.content.inspector.openExternal")}
                    testid="library-open-external"
                    disabled={fileAct.busy()}
                    onClick={() => void fileAct.run(() => openAttachment(file().id))}
                  />
                  <IconButton
                    icon="download"
                    label={t("web.library.content.inspector.saveAs")}
                    testid="library-download"
                    disabled={diskFile() === undefined || fileAct.busy()}
                    onClick={() => {
                      const f = diskFile();
                      if (f) void fileAct.run(() => saveFile(f.path, file().name));
                    }}
                  />
                  <IconButton
                    icon={copiedPath() ? "check" : "copy"}
                    label={copiedPath() ? t("web.library.content.inspector.copiedPath") : t("web.library.content.inspector.copyPath")}
                    testid="library-copy-path"
                    disabled={diskFile() === undefined}
                    onClick={() => {
                      const f = diskFile();
                      if (f) {
                        void Clipboard.writeText(f.path).then(() => {
                          copiedPath.set(true);
                          later(() => copiedPath.set(false), 1500);
                          toast(t("web.library.content.inspector.copiedPath"));
                        });
                      }
                    }}
                  />
                  <IconButton
                    icon="folder"
                    label={t("web.library.content.inspector.reveal")}
                    testid="library-reveal"
                    disabled={diskFile() === undefined}
                    onClick={() => {
                      const f = diskFile();
                      if (f) void hostApi.reveal(f.path);
                    }}
                  />
                  <SendMenu channels={props.act.channels} send={props.act.send} />
                  <If when={kind() === "image" || kind() === "video"}>
                    <IconButton icon="understand" label={t("web.library.understand")} testid="library-understand" onClick={() => props.act.understand()} />
                  </If>
                  <View class="flex-1" />
                  <MoreMenu
                    label={t("web.library.inspector.more")}
                    testid="library-more"
                    items={[{ key: "remove", label: t("web.library.remove"), icon: "delete", danger: true, onSelect: () => props.act.ask() }]}
                  />
                </View>

                <If when={props.asking}>
                  <Asking question={t("web.library.removeAsk", { name: file().name })} onRemove={() => props.act.remove()} onKeep={() => props.act.keep()} />
                </If>

                <View class="gap-2.5">
                  <PropRow label={t("web.library.inspector.kind")}>
                    <Text class="text-sm text-ink">{`${t(`web.library.kind.${kind()}`)} · ${file().type}`}</Text>
                  </PropRow>
                  <If when={props.seen?.width !== undefined && props.seen.height !== undefined ? props.seen : undefined}>
                    {(seen) => (
                      <PropRow label={t("web.library.inspector.pixels")}>
                        <Text testID="library-pixels" class="font-mono text-sm text-ink tabular-nums">{`${seen().width} × ${seen().height}`}</Text>
                      </PropRow>
                    )}
                  </If>
                  <If when={props.seen?.seconds}>
                    {(s) => (
                      <PropRow label={t("web.library.inspector.length")}>
                        <Text class="font-mono text-sm text-ink tabular-nums">{durationText(s())}</Text>
                      </PropRow>
                    )}
                  </If>
                  <PropRow label={t("web.library.inspector.bytes")}>
                    <Text class="font-mono text-sm text-ink tabular-nums">{sizeText(file().size)}</Text>
                  </PropRow>
                  <PropRow label={t("web.library.inspector.from")}>
                    <View class="flex-row flex-wrap items-center gap-1">
                      <Text testID="library-origin-line" class="text-sm text-ink">
                        {originLine(props.names)(item().origin)}
                      </Text>
                      <If when={channel()}>
                        {(c) => (
                          <Link href={`/chat/${encodeURIComponent(c())}`}>
                            <Text class="text-sm text-water underline">{t("web.library.inspector.openChannel", { channel: props.names.channel(c()) })}</Text>
                          </Link>
                        )}
                      </If>
                    </View>
                  </PropRow>
                  <PropRow label={t("web.library.inspector.added")}>
                    <Text class="text-sm text-ink">{ago(item().addedAt, now())}</Text>
                  </PropRow>
                </View>

                <If when={props.understood}>
                  {(text) => (
                    <View class="gap-1.5 border-t border-line pt-3">
                      <Text class="text-xs font-semibold text-muted">{t("web.library.understood")}</Text>
                      <Text testID="library-understood" class="text-sm text-ink">
                        {text()}
                      </Text>
                    </View>
                  )}
                </If>
              </>
            );
          }}
        </If>
      </Scroll>
    </View>
  );
}
