import { Image, Scroll, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Artifact, Channel, LibraryItem } from "@vibevalley/protocol";

import { useNow } from "../../base/dom";
import { ago } from "../../base/format";
import { api } from "../../infra/api";
import { openAttachment, playAudio, useAttachmentFile, useAttachmentUrl } from "../../infra/attachmentFile";
import { Link } from "../../infra/router";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { sizeText } from "../../ui/domain/AttachmentTile";
import { Icon } from "../../ui/Icon";
import { IconButton } from "../../ui/IconButton";
import { MoreMenu } from "../../ui/MoreMenu";
import { artifactIcon, artifactSuffix, kindLabel } from "../artifact";
import { exportMarkdownFile, saveTextFile } from "../artifact/store";
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
  readonly openArtifact?: ((id: string) => void) | undefined;
  readonly removeArtifact?: ((id: string) => void) | undefined;
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
    <View role="alert" testID="library-remove-ask" class="flex-row flex-wrap items-center gap-2 rounded-md bg-bad-soft p-2">
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

async function saveArtifactFile(artifact: Artifact): Promise<boolean> {
  const safeName = (artifact.title.trim() || "deliverable").replace(/[\\/:*?"<>|]/gu, "-");
  if (artifact.body === "blocks") {
    return exportMarkdownFile(artifact.id, artifact.title);
  }
  if (artifact.body === "html") {
    const content = await api.artifact.content.get({ id: artifact.id, version: artifact.version });
    const suffix = artifactSuffix(artifact);
    return saveTextFile(`${safeName}${suffix}`, "text/html;charset=utf-8", content.content);
  }
  const snap = await api.artifact.entry.list({ id: artifact.id, includeValues: true });
  return saveTextFile(`${safeName}.json`, "application/json;charset=utf-8", JSON.stringify(snap.entries, null, 2));
}

export function Inspector(props: {
  items: readonly LibraryItem[];
  artifact?: Artifact | undefined;
  seen: Seen | undefined;
  understood: string | undefined;
  names: Names;
  asking: boolean;
  act: InspectorActions;
}) {
  const now = useNow();
  const saving = createAct();
  const one = () => (props.items.length === 1 ? props.items[0] : undefined);
  const oneId = () => one()?.attachment.id ?? "";
  const url = useAttachmentUrl(oneId);
  const diskFile = useAttachmentFile(oneId);

  return (
    <Scroll testID="library-inspector" class="w-76 shrink-0 border-l border-line bg-page" contentClass="gap-4 p-4">
      <If
        when={props.artifact && props.items.length === 0 ? props.artifact : undefined}
        else={
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
                  <Asking
                    question={t("web.library.removeSome", { n: props.items.length })}
                    onRemove={() => props.act.remove()}
                    onKeep={() => props.act.keep()}
                  />
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
                      {(src) => <Image src={src()} class="h-45 w-60 object-contain" />}
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
                    <Asking question={t("web.library.removeAsk", { name: file().name })} onRemove={() => props.act.remove()} onKeep={() => props.act.keep()} />
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
        }
      >
        {(artifact) => (
          <>
            <View class="flex-row items-start gap-2">
              <Text testID="library-inspector-name" class="min-w-0 flex-1 text-base font-semibold text-ink">
                {artifact().title}
              </Text>
              <IconButton icon="close" label={t("web.library.inspector.clear")} testid="library-clear" onClick={() => props.act.clear()} />
            </View>
            <View
              role="button"
              onPress={() => props.act.openArtifact?.(artifact().id)}
              class="min-h-32 items-center justify-center gap-2 rounded-lg border border-line bg-side p-4 hover:bg-hover"
            >
              <Icon name={artifactIcon(artifact())} size={48} tone="muted" />
              <View class="flex-row flex-wrap items-center justify-center gap-1.5">
                <View class="rounded-sm bg-selected px-1.5 py-0.5">
                  <Text class="text-2xs font-medium text-ink">{kindLabel(artifact())}</Text>
                </View>
                <View class="rounded-sm border border-line bg-page px-1.5 py-0.5">
                  <Text class="font-mono text-2xs text-muted">{artifactSuffix(artifact())}</Text>
                </View>
                <If when={artifact().body === "html"}>
                  <View class="rounded-sm border border-line bg-page px-1.5 py-0.5">
                    <Text class="text-2xs text-muted">{t("web.library.inspector.versionBadge", { version: artifact().version })}</Text>
                  </View>
                </If>
                <If when={artifact().isDefault}>
                  <View class="rounded-sm bg-accent px-1.5 py-0.5">
                    <Text class="text-2xs font-medium text-page">{t("web.artifact.types.defaultBadge")}</Text>
                  </View>
                </If>
              </View>
            </View>
            <View class="flex-row items-center gap-1.5">
              <Button tone="primary" icon="open" testID="library-artifact-open" class="flex-1" onPress={() => props.act.openArtifact?.(artifact().id)}>
                {t("web.library.inspector.openWorkbench")}
              </Button>
              <IconButton
                icon="download"
                label={t("web.library.download")}
                testid="library-artifact-download"
                disabled={saving.busy()}
                onClick={() => void saving.run(() => saveArtifactFile(artifact()))}
              />
              <MoreMenu
                label={t("web.library.inspector.more")}
                testid="library-more"
                items={[{ key: "remove", label: t("web.artifact.page.delete"), icon: "delete", danger: true, onSelect: () => props.act.ask() }]}
              />
            </View>
            <If when={props.asking}>
              <Asking
                question={t("web.artifact.page.deleteAsk", { title: artifact().title })}
                onRemove={() => props.act.removeArtifact?.(artifact().id)}
                onKeep={() => props.act.keep()}
              />
            </If>
            <View class="gap-2">
              <View class="flex-row gap-3">
                <Text class="w-16 text-sm text-muted">{t("web.library.inspector.kind")}</Text>
                <Text class="flex-1 text-sm text-ink">{`${kindLabel(artifact())} · ${artifactSuffix(artifact())}`}</Text>
              </View>
              <View class="flex-row gap-3">
                <Text class="w-16 text-sm text-muted">{t("web.library.inspector.from")}</Text>
                <View class="flex-1 flex-row flex-wrap items-center gap-1">
                  <Text class="text-sm text-ink">{t("web.library.inspector.byMaker", { name: artifact().byName })}</Text>
                  <If when={artifact().channel}>
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
                <Text class="flex-1 text-sm text-ink">{ago(artifact().updated, now())}</Text>
              </View>
            </View>
          </>
        )}
      </If>
    </Scroll>
  );
}
