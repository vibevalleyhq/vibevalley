import { cleanup, effect, keymap, Scroll, signal, Text, untracked, View, WebView, windowSize, type InputRef, type JSX } from "nsh";
import { Input } from "nsh/base";

import { currentLocale, t } from "@vibevalley/i18n";
import type { Artifact, ArtifactHistoryPreviewResult, ArtifactVersion } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { Banner, Empty } from "../../design/layout";
import { Markdown } from "../../design/Markdown";
import { type MoreItem, MoreMenu } from "../../design/MoreMenu";
import { motionClass } from "../../design/motion";
import { Segmented } from "../../design/Segmented";
import { SkeletonBar, SkeletonLines, useDelayedBusy } from "../../design/Skeleton";
import { Splitter, usePaneWidth } from "../../design/Splitter";
import { Bubble } from "../../design/Tip";
import { toast } from "../../design/toasts";
import { api, newSendKey, reasonOf } from "../../infra/api";
import { Keyed } from "../../infra/base/dom";
import { useCollabSlice, useIssue } from "../../infra/frame";
import { ready, useQueryClient } from "../../infra/query";
import { richNative } from "../../infra/rich";
import { Link as A, useRouter, useSearch } from "../../infra/router";
import { createMemo } from "../../infra/solid";
import { contentPresenting, contentSidebarOpen, isPinned, openTemplatePicker, togglePinned } from "../../infra/state/contentNav";
import { artifactHref, kindLabel, useArtifact, useArtifacts } from "./ArtifactCard";
import { type ArtifactDirectoryMeta, ArtifactDirectoryView, type ArtifactViewTab } from "./ArtifactDirectoryView";
import { buildPrototypeDocument } from "./frame";
import { InstallAppletButton } from "./InstallAppletModal";
import { exportArtifactDirectory, requestArtifactChatFocus } from "./store";
import { TimelineBar } from "./TimelineBar";
import { BOARD_FILE_PATH, boardToNativeEntries, parseBoardDocument } from "./WhiteboardView";

/** Tailwind's lg (64rem): side-by-side 3rd column on desktop, full overlay below. */
const lg = () => windowSize().width >= 1024;

/** Provided by app/: channel shows artifacts, so artifact does not import channel back. */
export type ArtifactChat = (props: {
  readonly channel?: string | undefined;
  readonly issue?: string | undefined;
  readonly point?: number | undefined;
  readonly onClose?: (() => void) | undefined;
}) => JSX.Element;

function ArtifactSkeleton() {
  return (
    <View testID="artifact-skeleton" accessibilityState={{ busy: true }} class="min-h-0 flex-1 bg-page">
      <View desktop={{ windowDrag: true }} class="h-9 shrink-0 flex-row items-center gap-2 border-b border-line bg-page px-3">
        <If when={!contentSidebarOpen.get()}>
          <IconButton
            icon="sidebar"
            size={16}
            label={t("web.library.content.sidebarToggle")}
            testid="content-sidebar-toggle"
            pressed={false}
            onClick={() => contentSidebarOpen.set(true)}
          />
        </If>
        <SkeletonBar class="h-5 w-44 rounded-sm" />
        <SkeletonBar class="h-5 w-14 rounded-sm" />
        <View class="flex-1" />
        <SkeletonBar class="size-6 rounded-md" />
        <SkeletonBar class="size-6 rounded-md" />
      </View>
      <View class="mx-auto w-full max-w-3xl gap-4 px-6 py-7">
        <SkeletonBar class="h-7 w-64 rounded-md" />
        <SkeletonLines rows={["92%", "78%", "85%", "60%", "88%", "45%"]} gap="md" />
      </View>
    </View>
  );
}

function CollapsedContentHeader() {
  return (
    <If when={!contentSidebarOpen.get()}>
      <View desktop={{ windowDrag: true }} class="h-9 shrink-0 flex-row items-center gap-2 border-b border-line bg-page px-3">
        <IconButton
          icon="sidebar"
          size={16}
          label={t("web.library.content.sidebarToggle")}
          testid="content-sidebar-toggle"
          pressed={false}
          onClick={() => contentSidebarOpen.set(true)}
        />
        <Text role="header" class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
          {t("web.library.content.title")}
        </Text>
      </View>
    </If>
  );
}

/** `rest` is the path after /artifacts/. */
export function ArtifactsPage(props: { rest: string; chat: ArtifactChat }) {
  const all = useArtifacts(() => ({}));
  const list = () => ready(all, []);
  const id = () => {
    const rest = props.rest.split("?")[0] ?? "";
    return rest ? decodeURIComponent(rest) : undefined;
  };
  const open = () => id() ?? list()[0]?.id;
  const showListSkeleton = useDelayedBusy(() => open() === undefined && all.status() !== "error" && all.status() !== "success");
  cleanup(() => contentPresenting.set(false));

  return (
    <View testID="artifacts" class="h-full min-h-0 min-w-0 flex-1 bg-page">
      <If
        when={open()}
        else={
          <If
            when={all.status() === "error"}
            else={
              <If
                when={all.status() === "success"}
                else={
                  <If when={showListSkeleton()}>
                    <ArtifactSkeleton />
                  </If>
                }
              >
                <View class="min-h-0 flex-1">
                  <CollapsedContentHeader />
                  <Empty
                    icon="artifacts"
                    action={
                      <Button icon="add" onPress={() => openTemplatePicker("deliverable")}>
                        {t("web.artifact.page.new")}
                      </Button>
                    }
                  >
                    {t("web.artifact.page.none")}
                  </Empty>
                </View>
              </If>
            }
          >
            <View class="min-h-0 flex-1">
              <CollapsedContentHeader />
              <Empty icon="artifacts">{reasonOf(all.error())}</Empty>
            </View>
          </If>
        }
      >
        {(o) => <Keyed key={o()}>{() => <Opened id={untracked(o)} chat={props.chat} />}</Keyed>}
      </If>
    </View>
  );
}

function Opened(props: { id: string; chat: ArtifactChat }) {
  const found = useArtifact(() => props.id);
  const showSkeleton = useDelayedBusy(() => ready(found, undefined) === undefined && found.status() !== "error");
  return (
    <If
      when={ready(found, undefined)}
      else={
        <If
          when={found.status() === "error"}
          else={
            <If when={showSkeleton()}>
              <ArtifactSkeleton />
            </If>
          }
        >
          <View class="min-h-0 flex-1">
            <CollapsedContentHeader />
            <Empty icon="artifacts">{t("web.artifact.page.gone")}</Empty>
          </View>
        </If>
      }
    >
      {(a) => <Shown artifact={a()} chat={props.chat} />}
    </If>
  );
}

/** The title, typed over in place: Return or leaving it renames, Escape puts it back. */
function Title(props: { artifact: Artifact }) {
  const queries = useQueryClient();
  const text = signal(untracked(() => props.artifact.title));
  const focused = signal(false);
  let field: InputRef | undefined;
  const act = createAct();
  effect(() => {
    const next = props.artifact.title;
    if (!untracked(focused)) text.set(next);
  });
  const save = async () => {
    const title = text().trim();
    const id = props.artifact.id;
    if (!title || title === props.artifact.title) {
      text.set(props.artifact.title);
      return;
    }
    const done = await act.run(() =>
      api.artifact.update({ id, title }).then(() => {
        void queries.invalidate({ prefix: ["artifacts"] });
        return true;
      }),
    );
    if (done !== true) text.set(props.artifact.title);
  };
  effect(() => {
    if (!focused()) return;
    return keymap.bind(
      "escape",
      () => {
        text.set(props.artifact.title);
        field?.blur();
      },
      { when: "always" },
    );
  });
  return (
    <Input
      ref={(el) => {
        field = el;
      }}
      testID="artifact-title"
      accessibilityLabel={t("web.artifact.page.title")}
      value={text()}
      maxLength={80}
      submitBehavior="blurAndSubmit"
      onChange={(e) => text.set(e.value)}
      onFocus={() => focused.set(true)}
      onBlur={() => {
        focused.set(false);
        void save();
      }}
      class="h-7 min-w-20 max-w-64 shrink rounded-md bg-transparent px-1.5 text-sm font-semibold text-ink hover:bg-hover focus:bg-hover"
    />
  );
}

function Shown(props: { artifact: Artifact; chat: ArtifactChat }) {
  const queries = useQueryClient();
  const search = useSearch();
  const router = useRouter();
  const collab = useCollabSlice();
  const asking = signal(false);
  const menu = signal(false);
  const sendMenu = signal(false);
  const appletModalOpen = signal(false);
  const timelineOpen = signal(false);
  const historyPreview = signal<ArtifactHistoryPreviewResult | undefined>(undefined);
  const revisionKey = signal(0);
  const viewTab = signal<ArtifactViewTab>("preview");
  const dirMeta = signal<ArtifactDirectoryMeta>({ fileCount: 0, seq: untracked(() => props.artifact.seq), peers: [] });
  const railWidth = usePaneWidth("artifact-rail", 352, 280, 560);

  const isWideCanvas = () => props.artifact.artifactType !== "docs" && props.artifact.artifactType !== "outline";
  // Wide visual canvases start with the chat rail collapsed so the canvas gets the full width.
  const railOpen = signal(!untracked(isWideCanvas));
  const askedVersion = () => {
    const raw = search().get("v");
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  };
  const selectedVersion = createMemo((): ArtifactVersion | undefined => {
    const v = askedVersion();
    return v !== undefined ? props.artifact.versions.find((item) => item.version === v) : undefined;
  });
  const issue = useIssue(() => props.artifact.issue);
  const channels = createMemo(() => (collab()?.chat?.channels ?? []).filter((c) => c.type === "channel" && c.archived === undefined));
  /** Where its comments are: the version shown, else where it was first said. */
  const said = createMemo(() => selectedVersion() ?? props.artifact.said);
  const pickVersion = (n: number | undefined) => router.navigate(artifactHref(props.artifact.id, n), { replace: true });
  const removing = createAct();
  const exporting = createAct();
  const sending = createAct();
  const creatingIssue = createAct();
  const snapshotting = createAct();

  const handleDirMeta = (next: ArtifactDirectoryMeta) => {
    const prev = untracked(dirMeta);
    if (
      prev.fileCount === next.fileCount &&
      prev.seq === next.seq &&
      prev.peers.length === next.peers.length &&
      prev.peers.every((p, i) => p === next.peers[i])
    ) {
      return;
    }
    dirMeta.set(next);
  };

  const currentSeq = () => (dirMeta().seq > 0 ? dirMeta().seq : props.artifact.seq);

  const pinKey = () => `artifact:${props.artifact.id}`;
  const pinned = () => isPinned(pinKey());
  const onTogglePin = () => {
    const next = togglePinned(pinKey());
    toast(next ? t("web.library.content.pinnedToast") : t("web.library.content.unpinnedToast"));
  };

  const sendToChannel = (channelId: string, channelLabel: string) => {
    const { id, title } = props.artifact;
    const kind = kindLabel(props.artifact);
    void sending.run(async () => {
      await api.channel.message.send({
        id: channelId,
        text: `[${title}](${artifactHref(id)}) · ${kind}`,
        sendKey: newSendKey(),
      });
      toast(t("web.library.sentTo", { channel: channelLabel }));
    });
  };

  const turnIntoIssue = () => {
    const { id, title } = props.artifact;
    const description = `${kindLabel(props.artifact)} · ${artifactHref(id)}`;
    return creatingIssue.run(async () => {
      await api.issue.create({ title, description, requestKey: newSendKey() });
      toast(t("web.library.content.issueCreated"));
    });
  };

  const createSnapshotVersion = () =>
    snapshotting.run(async () => {
      const updated = await api.artifact.version.create({
        id: props.artifact.id,
        note: t("web.artifact.page.snapshotNote"),
      });
      await queries.invalidate({ prefix: ["artifacts"] });
      toast(t("web.artifact.edit.saved", { version: updated.version }));
    });

  const toggleDefaultDesignSystem = () =>
    snapshotting.run(async () => {
      await api.artifact.update({ id: props.artifact.id, isDefault: !props.artifact.isDefault });
      await queries.invalidate({ prefix: ["artifacts"] });
    });

  const remove = () => {
    const { id, title } = props.artifact;
    return removing.run(async () => {
      await api.artifact.delete({ id });
      router.navigate("/library");
      toast(t("web.artifact.page.deleted", { title }));
      void queries.invalidate({ prefix: ["artifacts"] });
    });
  };

  const more = (): MoreItem[] => [
    ...(selectedVersion() === undefined
      ? [
          {
            key: "snapshot",
            label: `${t("web.artifact.edit.save")} · seq ${currentSeq()}`,
            icon: "add" as const,
            onSelect: () => void createSnapshotVersion(),
          },
        ]
      : []),
    ...(props.artifact.artifactType === "design-system" && selectedVersion() === undefined
      ? [
          {
            key: "default",
            label: props.artifact.isDefault ? t("web.artifact.types.unsetDefault") : t("web.artifact.types.setDefault"),
            icon: "check" as const,
            onSelect: () => void toggleDefaultDesignSystem(),
          },
        ]
      : []),
    {
      key: "export",
      label: t("web.library.content.exportArtifact"),
      icon: "download",
      onSelect: () => void exporting.run(() => exportArtifactDirectory(props.artifact, selectedVersion()?.version)),
    },
    { key: "issue", label: t("web.library.content.turnIntoIssue"), icon: "issues", onSelect: () => void turnIntoIssue() },
    { key: "delete", label: t("web.artifact.page.delete"), icon: "delete", danger: true, onSelect: () => asking.set(true) },
  ];

  const Chat = untracked(() => props.chat);
  const presenting = () => contentPresenting();
  const isCovered = createMemo(() => menu() || sendMenu() || appletModalOpen());

  effect(() => {
    if (!presenting()) return;
    return keymap.bind("escape", () => contentPresenting.set(false), { when: "always" });
  });
  effect(() => {
    if (!asking()) return;
    return keymap.bind("escape", () => asking.set(false), { when: "always" });
  });

  return (
    <View
      testID="artifact"
      accessibilityLabel={props.artifact.title}
      accessibilityValue={{ text: `${props.artifact.id} ${props.artifact.artifactType} ${selectedVersion()?.version ?? props.artifact.version}` }}
      class="relative h-full min-h-0 min-w-0 flex-1 flex-row overflow-hidden"
    >
      <View class="min-h-0 min-w-0 flex-1">
        <If when={presenting()}>
          <View testID="artifact-presenting" desktop={{ windowDrag: true }} class="h-9 shrink-0 flex-row items-center gap-2 border-b border-line bg-side px-3">
            <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{props.artifact.title}</Text>
            <Button size="compact" icon="close" testID="artifact-present-end" onPress={() => contentPresenting.set(false)}>
              {t("web.artifact.canvas.close")}
            </Button>
          </View>
        </If>

        <If when={!presenting()}>
          <View testID="artifact-header" desktop={{ windowDrag: true }} class="h-9 shrink-0 flex-row items-center gap-2 border-b border-line bg-page px-3">
            <If when={!contentSidebarOpen.get()}>
              <>
                <IconButton
                  icon="sidebar"
                  size={16}
                  label={t("web.library.content.sidebarToggle")}
                  testid="content-sidebar-toggle"
                  pressed={false}
                  onClick={() => contentSidebarOpen.set(true)}
                />
                <IconButton
                  icon="back"
                  size={14}
                  label={t("web.artifact.page.backToLibrary")}
                  testid="artifact-back-library"
                  onClick={() => router.navigate("/library")}
                />
              </>
            </If>
            <View class="min-w-0 flex-1 flex-row items-center gap-1.5 overflow-hidden">
              <Title artifact={props.artifact} />
              <View class="h-5 shrink-0 items-center justify-center rounded-sm bg-selected px-1.5">
                <Text class="text-2xs font-medium text-ink">{kindLabel(props.artifact)}</Text>
              </View>
              <If when={props.artifact.isDefault}>
                <View testID="artifact-default-badge" class="h-5 shrink-0 items-center justify-center rounded-sm bg-accent px-1.5">
                  <Text class="text-2xs font-semibold text-page">{t("web.artifact.types.defaultBadge")}</Text>
                </View>
              </If>
              <If when={props.artifact.versions.length > 0}>
                <View testID="artifact-versions" class="shrink-0 flex-row items-center gap-1">
                  <View
                    role="button"
                    testID="artifact-version-live"
                    accessibilityState={{ selected: selectedVersion() === undefined }}
                    onPress={() => pickVersion(undefined)}
                    class={`h-5 items-center justify-center rounded-sm border px-1.5 ${
                      selectedVersion() === undefined ? "border-accent bg-selected" : "border-line bg-page hover:bg-hover"
                    }`}
                  >
                    <Text class={`font-mono text-2xs font-medium ${selectedVersion() === undefined ? "text-ink" : "text-muted"}`}>
                      {t("web.artifact.page.liveVersion")}
                    </Text>
                  </View>
                  <If
                    when={props.artifact.versions.length <= 3}
                    else={
                      <View class="flex-row items-center gap-1">
                        <If when={selectedVersion()}>
                          {(sv) => (
                            <View class="h-5 items-center justify-center rounded-sm border border-accent bg-selected px-1.5">
                              <Text class="font-mono text-2xs font-medium text-ink tabular-nums">{`v${sv().version}`}</Text>
                            </View>
                          )}
                        </If>
                        <MoreMenu
                          icon="choose"
                          label={t("web.artifact.card.version", { version: selectedVersion()?.version ?? props.artifact.version })}
                          testid="artifact-version-menu"
                          items={props.artifact.versions.toReversed().map((v) => ({
                            key: String(v.version),
                            label: `v${v.version}${v.note ? ` · ${v.note}` : ""}`,
                            onSelect: () => pickVersion(v.version),
                          }))}
                        />
                      </View>
                    }
                  >
                    <Each of={props.artifact.versions.toReversed()} key={(v) => v.version}>
                      {(v) => (
                        <View
                          role="button"
                          testID={`artifact-version-${v().version}`}
                          accessibilityState={{ selected: v().version === selectedVersion()?.version }}
                          onPress={() => pickVersion(v().version)}
                          class={`h-5 items-center justify-center rounded-sm border px-1.5 ${
                            v().version === selectedVersion()?.version ? "border-accent bg-selected" : "border-line bg-page hover:bg-hover"
                          }`}
                        >
                          <Text class={`font-mono text-2xs font-medium tabular-nums ${v().version === selectedVersion()?.version ? "text-ink" : "text-muted"}`}>
                            {`v${v().version}`}
                          </Text>
                        </View>
                      )}
                    </Each>
                  </If>
                </View>
              </If>
              <If when={issue()}>
                {(i) => (
                  <A
                    href={`/issues/${i().id}`}
                    testID="artifact-issue"
                    class="h-5 shrink-0 items-center justify-center rounded-sm border border-line bg-side px-1.5 hover:bg-hover"
                  >
                    <Text class="font-mono text-2xs font-medium text-water">{`#${i().number}`}</Text>
                  </A>
                )}
              </If>
              <If when={dirMeta().peers.length > 0}>
                <View testID="artifact-presence-bar" class="shrink-0 flex-row items-center gap-1">
                  <Each of={dirMeta().peers} key={(p) => p.id}>
                    {(peer) => (
                      <View testID="artifact-presence-pill" class="h-5 flex-row items-center gap-1 rounded-full border border-line bg-side px-2">
                        <View class="size-1.5 shrink-0 rounded-full bg-accent" />
                        <Text class="max-w-28 truncate text-2xs font-medium text-ink">{peer().status ? `${peer().name} · ${peer().status}` : peer().name}</Text>
                      </View>
                    )}
                  </Each>
                </View>
              </If>
            </View>
            <View class="shrink-0 flex-row items-center gap-1">
              <If when={!historyPreview()}>
                <Segmented
                  testid="artifact-view-mode"
                  label={t("web.artifact.page.viewMode")}
                  value={viewTab()}
                  onChange={(v) => viewTab.set(v)}
                  options={[
                    { value: "preview" as const, label: t("web.artifact.page.previewTab") },
                    {
                      value: "files" as const,
                      label: dirMeta().fileCount > 0 ? t("web.artifact.page.filesTabCount", { n: dirMeta().fileCount }) : t("web.artifact.page.filesTab"),
                    },
                  ]}
                />
                <View class="mx-0.5 h-4 w-px shrink-0 bg-line" />
              </If>
              <View
                role="button"
                testID="artifact-pin"
                accessibilityLabel={pinned() ? t("web.library.content.unpin") : t("web.library.content.pin")}
                accessibilityState={{ selected: pinned() }}
                tooltip={<Bubble text={pinned() ? t("web.library.content.unpin") : t("web.library.content.pin")} />}
                onPress={onTogglePin}
                class={`size-7 shrink-0 items-center justify-center rounded-md ${motionClass("transition-transform duration-120 ease-out")} active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus ${
                  pinned() ? "bg-selected" : "hover:bg-hover"
                }`}
              >
                <Icon name="pin" size={16} tone={pinned() ? "wheat" : "muted"} />
              </View>
              <If when={channels().length > 0}>
                <MoreMenu
                  icon="send"
                  label={t("web.library.content.sendArtifact")}
                  testid="artifact-send"
                  items={channels().map((c) => {
                    const label = `#${c.name ?? c.id}`;
                    return { key: c.id, label, icon: "chat" as const, onSelect: () => sendToChannel(c.id, label) };
                  })}
                  open={sendMenu()}
                  onOpenChange={(o) => sendMenu.set(o)}
                />
              </If>
              <InstallAppletButton artifact={props.artifact} testID="artifact-install-applet" onOpenChange={(open) => appletModalOpen.set(open)} />
              <IconButton
                icon="clock"
                label={`${t("web.artifact.timeline.toggle")} · seq ${currentSeq()}`}
                testid="artifact-timeline-toggle"
                pressed={timelineOpen()}
                onClick={() => {
                  const next = !timelineOpen();
                  timelineOpen.set(next);
                  if (!next) historyPreview.set(undefined);
                }}
              />
              <IconButton
                icon="sidebarRight"
                label={railOpen() ? t("web.artifact.page.railHide") : t("web.artifact.page.railShow")}
                testid="artifact-rail-toggle"
                pressed={railOpen()}
                onClick={() => railOpen.set(!railOpen())}
              />
              <MoreMenu label={t("web.artifact.page.more")} testid="artifact-more" items={more()} open={menu()} onOpenChange={(o) => menu.set(o)} />
            </View>
          </View>
          <If when={timelineOpen()}>
            <TimelineBar
              artifact={props.artifact}
              activeFrontiers={historyPreview()?.frontiers}
              onPreview={(snap) => historyPreview.set(snap)}
              onMutated={() => {
                historyPreview.set(undefined);
                revisionKey.set(untracked(revisionKey) + 1);
              }}
              onForked={(forked) => {
                timelineOpen.set(false);
                historyPreview.set(undefined);
                router.navigate(artifactHref(forked.id));
              }}
              onClose={() => {
                timelineOpen.set(false);
                historyPreview.set(undefined);
              }}
            />
          </If>
          <If when={asking()}>
            <View testID="artifact-delete" class="shrink-0 flex-row flex-wrap items-center gap-2 border-b border-line bg-bad-soft px-3 py-2">
              <Text class="min-w-0 flex-1 text-sm text-berry">{t("web.artifact.page.deleteAsk", { title: props.artifact.title })}</Text>
              <Button tone="danger" icon="delete" testID="artifact-delete-sure" disabled={removing.busy()} onPress={() => void remove()}>
                {t("web.artifact.page.delete")}
              </Button>
              <Button onPress={() => asking.set(false)}>{t("web.base.form.never")}</Button>
            </View>
          </If>
        </If>

        <If
          when={historyPreview()}
          else={
            <Keyed key={`${props.artifact.id}:${selectedVersion()?.version ?? "live"}:${revisionKey()}`}>
              {() => (
                <ArtifactDirectoryView
                  artifact={props.artifact}
                  version={selectedVersion()?.version}
                  covered={isCovered()}
                  tab={viewTab()}
                  onTabChange={(v) => viewTab.set(v)}
                  hideToolbar
                  onMeta={handleDirMeta}
                  onPresent={(on) => contentPresenting.set(on)}
                  onOpenChat={() => {
                    railOpen.set(true);
                    requestArtifactChatFocus();
                  }}
                />
              )}
            </Keyed>
          }
        >
          {(preview) => <HistoryPreviewBody artifact={props.artifact} preview={preview()} onBackToLive={() => historyPreview.set(undefined)} />}
        </If>
      </View>

      <If when={railOpen() && !presenting()}>
        <View
          accessibilityLabel={t("web.artifact.page.rail")}
          testID="artifact-rail"
          class={`h-full min-h-0 border-l border-line bg-side ${lg() ? "relative shrink-0" : "absolute inset-0 z-20"}`}
          style={lg() ? { width: railWidth() } : undefined}
        >
          <If when={lg()}>
            <Splitter pane="artifact-rail" side="left" width={railWidth()} min={280} max={560} label={t("web.artifact.page.rail")} />
          </If>
          <View class="min-h-0 min-w-0 flex-1">
            <Chat channel={said()?.channel ?? props.artifact.channel} issue={props.artifact.issue} point={said()?.number} onClose={() => railOpen.set(false)} />
          </View>
        </View>
      </If>
    </View>
  );
}

function HistoryPreviewBody(props: { artifact: Artifact; preview: ArtifactHistoryPreviewResult; onBackToLive: () => void }) {
  const native = richNative();
  const isWhiteboard = () => props.preview.artifactType === "whiteboard";
  const isPrototype = () => props.preview.artifactType === "prototype";
  const boardEntry = () => props.preview.files.find((f) => f.path === BOARD_FILE_PATH);
  const prototypeHtml = () => {
    const map = new Map(props.preview.files.map((f) => [f.path, f.content]));
    return buildPrototypeDocument(map);
  };
  return (
    <View testID="artifact-history-preview" class="min-h-0 w-full flex-1 bg-page">
      <Banner tone="info" edge icon="clock">
        <View class="flex-row items-center justify-between gap-2">
          <Text class="min-w-0 flex-1 truncate text-xs font-medium text-ink">
            {t("web.artifact.timeline.previewBanner", {
              summary: props.preview.entry?.summary ?? props.preview.entry?.origin ?? props.preview.frontiers.slice(0, 12),
            })}
          </Text>
          <Button size="compact" tone="plain" testID="history-preview-live" onPress={props.onBackToLive}>
            {t("web.artifact.timeline.backToLive")}
          </Button>
        </View>
      </Banner>

      <If
        when={isWhiteboard() && boardEntry() && native ? native : undefined}
        else={
          <If
            when={isPrototype() && props.preview.files.some((f) => f.path === "structure/index.html")}
            else={
              <Scroll testID="artifact-history-preview-files" class="min-h-0 flex-1" contentClass="mx-auto w-full max-w-3xl gap-2.5 p-5">
                <Each of={props.preview.files} key={(f) => f.path}>
                  {(file) => (
                    <View class="gap-1.5 rounded-lg border border-line bg-side px-3.5 py-2.5">
                      <View class="flex-row items-center justify-between gap-2">
                        <Text class="font-mono text-xs font-semibold text-ink">{file().path}</Text>
                        <Text class="font-mono text-2xs text-faint">{`${file().mime} · ${file().size} B`}</Text>
                      </View>
                      <If
                        when={file().path.endsWith(".md") || file().path.endsWith(".markdown")}
                        else={<Text class="font-mono text-xs leading-relaxed text-ink select-text">{file().content}</Text>}
                      >
                        <Markdown size="doc" text={file().content} />
                      </If>
                    </View>
                  )}
                </Each>
              </Scroll>
            }
          >
            <WebView
              testID="artifact-history-preview-html"
              accessibilityLabel={props.artifact.title}
              html={prototypeHtml()}
              incognito
              class="min-h-0 w-full flex-1 bg-page"
            />
          </If>
        }
      >
        {(rich) => {
          const VvWhiteboard = rich().VvWhiteboard;
          const doc = parseBoardDocument(boardEntry()?.content);
          return (
            <VvWhiteboard
              entriesJson={JSON.stringify(boardToNativeEntries(props.artifact.id, props.artifact.title, doc, 0))}
              readOnly
              title={props.artifact.title}
              locale={currentLocale()}
              class="min-h-0 min-w-0 flex-1"
            />
          );
        }}
      </If>
    </View>
  );
}
