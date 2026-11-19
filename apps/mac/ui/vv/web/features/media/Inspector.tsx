// Ported from VibeValley apps/web/src/features/media/Inspector.tsx:
// inspector pane for the selected library item(s).
import { Image, Scroll, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Channel, LibraryItem } from "@vibevalley/protocol";

import { useNow } from "../../base/dom";
import { ago } from "../../base/format";
import { openAttachment, playAudio, useAttachmentFile, useAttachmentUrl } from "../../infra/attachmentFile";
import { Link } from "../../infra/router";
import { Button } from "../../ui/Button";
import { sizeText } from "../../ui/domain/AttachmentTile";
import { Icon } from "../../ui/Icon";
import { IconButton } from "../../ui/IconButton";
import { MoreMenu } from "../../ui/MoreMenu";
import { durationText, extOf, kindOf, type Names, originLine } from "./items";
import type { Seen } from "./Tiles";

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
    <View role="alert" testID="library-remove-ask" class="flex-row flex-wrap items-center gap-2 rounded-md bg-bad-soft p-2">
      <Text class="w-full text-sm text-berry">{props.question}</Text>
      <Button tone="danger" testID="library-remove-sure" onPress={() => props.act.remove()}>
        {t("web.library.removeSure")}
      </Button>
      <Button tone="quiet" testID="library-remove-keep" onPress={() => props.act.keep()}>
        {t("web.library.keep")}
      </Button>
    </View>
  );
}

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
  const oneId = () => one()?.attachment.id ?? "";
  const url = useAttachmentUrl(oneId);
  const diskFile = useAttachmentFile(oneId);

  return (
    <Scroll testID="library-inspector" class="w-76 shrink-0 border-l border-line bg-page" contentClass="gap-4 p-4">
      <If
        when={one()}
        else={
          <>
            <View class="flex-row items-start gap-2">
              <Text class="min-w-0 flex-1 text-base font-semibold text-ink">{t("web.library.inspector.selected", { n: props.items.length })}</Text>
              <IconButton icon="close" label={t("web.library.inspector.clear")} testid="library-clear" onClick={() => props.act.clear()} />
            </View>
            <View class="flex-row items-center gap-1">
              <SendMenu channels={props.act.channels} send={props.act.send} />
              <View class="flex-1" />
              <MoreMenu
                label={t("web.library.inspector.more")}
                testid="library-more"
                items={[{ key: "remove", label: t("web.library.remove"), icon: "delete", danger: true, onSelect: () => props.act.ask() }]}
              />
            </View>
            <If when={props.asking}>
              <Asking question={t("web.library.removeSome", { n: props.items.length })} act={props.act} />
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
              <View class="flex-row items-start gap-2">
                <Text testID="library-inspector-name" class="min-w-0 flex-1 text-base font-semibold text-ink">
                  {file().name}
                </Text>
                <IconButton icon="close" label={t("web.library.inspector.clear")} testid="library-clear" onClick={() => props.act.clear()} />
              </View>
              <View
                role="button"
                onPress={() => (kind() === "image" ? props.act.look() : void openAttachment(file().id))}
                class="min-h-32 max-h-64 items-center justify-center overflow-hidden rounded-lg bg-hover p-2"
              >
                <If
                  when={kind() === "image" ? url() : undefined}
                  else={
                    <View class="items-center gap-1 py-6">
                      <Icon name={kind() === "audio" ? "audio" : kind() === "video" ? "video" : "file"} size={48} tone="muted" />
                      <If when={extOf(file().name)}>{(ext) => <Text class="text-xs font-medium text-ink">{ext()}</Text>}</If>
                    </View>
                  }
                >
                  {(src) => <Image src={src()} style={{ width: 240, height: 180, objectFit: "contain" }} />}
                </If>
              </View>
              <If when={kind() === "audio" ? diskFile()?.path : undefined}>
                {(path) => (
                  <Button icon="play" onPress={() => void playAudio(path())}>
                    {t("web.library.kind.audio")}
                  </Button>
                )}
              </If>
              <View class="flex-row items-center gap-1">
                <IconButton icon="download" label={t("web.library.download")} testid="library-download" onClick={() => void openAttachment(file().id)} />
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
                <Asking question={t("web.library.removeAsk", { name: file().name })} act={props.act} />
              </If>
              <View class="gap-2">
                <View class="flex-row gap-3">
                  <Text class="w-16 text-sm text-muted">{t("web.library.inspector.kind")}</Text>
                  <Text class="flex-1 text-sm text-ink">{`${t(`web.library.kind.${kind()}`)} · ${file().type}`}</Text>
                </View>
                <If when={props.seen?.width !== undefined && props.seen.height !== undefined ? props.seen : undefined}>
                  {(seen) => (
                    <View class="flex-row gap-3">
                      <Text class="w-16 text-sm text-muted">{t("web.library.inspector.pixels")}</Text>
                      <Text testID="library-pixels" class="flex-1 text-sm text-ink">{`${seen().width} × ${seen().height}`}</Text>
                    </View>
                  )}
                </If>
                <If when={props.seen?.seconds}>
                  {(s) => (
                    <View class="flex-row gap-3">
                      <Text class="w-16 text-sm text-muted">{t("web.library.inspector.length")}</Text>
                      <Text class="flex-1 text-sm text-ink">{durationText(s())}</Text>
                    </View>
                  )}
                </If>
                <View class="flex-row gap-3">
                  <Text class="w-16 text-sm text-muted">{t("web.library.inspector.bytes")}</Text>
                  <Text class="flex-1 text-sm text-ink">{sizeText(file().size)}</Text>
                </View>
                <View class="flex-row gap-3">
                  <Text class="w-16 text-sm text-muted">{t("web.library.inspector.from")}</Text>
                  <View class="flex-1 flex-row flex-wrap items-center gap-1">
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
                </View>
                <View class="flex-row gap-3">
                  <Text class="w-16 text-sm text-muted">{t("web.library.inspector.added")}</Text>
                  <Text class="flex-1 text-sm text-ink">{ago(item().addedAt, now())}</Text>
                </View>
              </View>
              <If when={props.understood}>
                {(text) => (
                  <View class="gap-1.5">
                    <Text class="text-xs font-medium text-faint">{t("web.library.understood")}</Text>
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
  );
}
