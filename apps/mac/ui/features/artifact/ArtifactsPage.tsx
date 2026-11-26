import { cleanup, effect, keymap, Scroll, signal, Text, untracked, View, WebView, windowSize, type InputRef, type JSX } from "nsh";
import { Input } from "nsh/base";

import { currentLocale, t } from "@vibevalley/i18n";
import type { Artifact, ArtifactHistoryPreviewResult, ArtifactVersion } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { IconButton } from "../../design/IconButton";
import { Banner, Empty } from "../../design/layout";
import { Markdown } from "../../design/Markdown";
import { SkeletonBar, SkeletonLines, useDelayedBusy } from "../../design/Skeleton";
import { Splitter, usePaneWidth } from "../../design/Splitter";
import { toast } from "../../design/toasts";
import { api, newSendKey, reasonOf } from "../../infra/api";
import { Keyed } from "../../infra/base/dom";
import { useCollabSlice, useIssue } from "../../infra/frame";
import { currentHost } from "../../infra/host";
import { ready, useQueryClient } from "../../infra/query";
import { richNative } from "../../infra/rich";
import { Link as A, useRouter, useSearch } from "../../infra/router";
import { createMemo } from "../../infra/solid";
import { activeArtifactType, contentPresenting, contentSidebarOpen, isPinned, openTemplatePicker, togglePinned } from "../../infra/state/contentNav";
import { artifactHref, kindLabel, useArtifact, useArtifacts } from "./ArtifactCard";
import { ArtifactDirectoryView, type ArtifactDirectoryMenuContext, type ArtifactMenuItem } from "./ArtifactDirectoryView";
import { buildPrototypeDocument } from "./frame";
import { HistoryPanel } from "./HistoryPanel";
import { InstallAppletModal, useInstalledApplet } from "./InstallAppletModal";
import { exportArtifactDirectory, requestArtifactChatFocus } from "./store";
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
      <View desktop={{ windowDrag: true }} class="h-11 shrink-0 flex-row items-center gap-2 border-b border-line bg-page px-3">
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
      <View desktop={{ windowDrag: true }} class="h-11 shrink-0 flex-row items-center gap-2 border-b border-line bg-page px-3">
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

/** Click-to-edit header title: displays full text with ellipsis at rest; Return or blur renames, Escape cancels. */
function Title(props: { artifact: Artifact }) {
  const queries = useQueryClient();
  const text = signal(untracked(() => props.artifact.title));
  const editing = signal(false);
  let field: InputRef | undefined;
  const act = createAct();
  effect(() => {
    const next = props.artifact.title;
    if (!untracked(editing)) text.set(next);
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
  const startEdit = () => {
    text.set(props.artifact.title);
    editing.set(true);
  };
  const commit = () => {
    if (!untracked(editing)) return;
    editing.set(false);
    void save();
  };
  effect(() => {
    if (!editing()) return;
    return keymap.bind(
      "escape",
      () => {
        text.set(props.artifact.title);
        editing.set(false);
        field?.blur();
      },
      { when: "always" },
    );
  });
  return (
    <If
      when={editing()}
      else={
        <View
          role="button"
          testID="artifact-title"
          accessibilityLabel={t("web.artifact.page.title")}
          accessibilityValue={{ text: props.artifact.title }}
          onPress={startEdit}
          class="h-7 min-w-0 max-w-lg shrink flex-row items-center rounded-md px-1.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
        >
          <Text class="min-w-0 truncate text-sm font-semibold text-ink">{props.artifact.title}</Text>
        </View>
      }
    >
      <Input
        ref={(el) => {
          field = el;
        }}
        autoFocus
        testID="artifact-title"
        accessibilityLabel={t("web.artifact.page.title")}
        value={text()}
        maxLength={80}
        submitBehavior="blurAndSubmit"
        onChange={(e) => text.set(e.value)}
        onSubmit={commit}
        onBlur={commit}
        class="h-7 min-w-44 max-w-lg flex-1 rounded-md border border-focus bg-page px-1.5 text-sm font-semibold text-ink"
      />
    </If>
  );
}

type ArtifactRightPanel = "none" | "chat" | "history";

function Shown(props: { artifact: Artifact; chat: ArtifactChat }) {
  const queries = useQueryClient();
  const search = useSearch();
  const router = useRouter();
  const collab = useCollabSlice();
  const asking = signal(false);
  const dirMenuOpen = signal(false);
  const appletModalOpen = signal(false);
  const historyPreview = signal<ArtifactHistoryPreviewResult | undefined>(undefined);
  const revisionKey = signal(0);
  const railWidth = usePaneWidth("artifact-rail", 384, 300, 560);
  const installedApplet = useInstalledApplet(() => props.artifact.id);

  const isWideCanvas = () => props.artifact.artifactType !== "docs" && props.artifact.artifactType !== "outline";
  effect(() => {
    activeArtifactType.set(props.artifact.artifactType);
  });
  cleanup(() => activeArtifactType.set(undefined));
  // Wide visual canvases and narrower viewports (< lg) start with the right rail collapsed so the editor keeps full width.
  const rightPanel = signal<ArtifactRightPanel>(untracked(() => !isWideCanvas() && lg()) ? "chat" : "none");
  const setRightPanel = (next: ArtifactRightPanel) => {
    rightPanel.set(next);
    if (next !== "history") historyPreview.set(undefined);
  };
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

  const remove = () => {
    const { id, title } = props.artifact;
    return removing.run(async () => {
      await api.artifact.delete({ id });
      router.navigate("/library");
      toast(t("web.artifact.page.deleted", { title }));
      void queries.invalidate({ prefix: ["artifacts"] });
    });
  };

  const Chat = untracked(() => props.chat);
  const presenting = () => contentPresenting();
  const isCovered = createMemo(() => dirMenuOpen() || appletModalOpen() || asking());

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
          <View testID="artifact-presenting" desktop={{ windowDrag: true }} class="h-11 shrink-0 flex-row items-center gap-2 border-b border-line bg-side px-3">
            <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{props.artifact.title}</Text>
            <Button size="compact" icon="close" testID="artifact-present-end" onPress={() => contentPresenting.set(false)}>
              {t("web.artifact.canvas.close")}
            </Button>
          </View>
        </If>

        <Keyed key={`${props.artifact.id}:${selectedVersion()?.version ?? "live"}`}>
          {() => (
            <ArtifactDirectoryView
              artifact={props.artifact}
              version={selectedVersion()?.version}
              reloadKey={revisionKey()}
              covered={isCovered()}
              hideHeader={presenting()}
              headerTestID="artifact-header"
              headerWindowDrag
              menuTestID="artifact-more"
              onMenuOpenChange={(open) => dirMenuOpen.set(open)}
              headerLeft={
                <>
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
                  <Title artifact={props.artifact} />
                  <View class="h-5 shrink-0 items-center justify-center rounded-sm bg-selected px-1.5">
                    <Text class="text-2xs font-medium text-ink">{kindLabel(props.artifact)}</Text>
                  </View>
                  <If when={props.artifact.isDefault}>
                    <View testID="artifact-default-badge" class="h-5 shrink-0 items-center justify-center rounded-sm bg-accent px-1.5">
                      <Text class="text-2xs font-semibold text-page">{t("web.artifact.types.defaultBadge")}</Text>
                    </View>
                  </If>
                  <If when={selectedVersion()}>
                    {(v) => (
                      <View
                        role="button"
                        testID="artifact-version-badge"
                        accessibilityLabel={t("web.artifact.card.version", { version: v().version })}
                        onPress={() => setRightPanel("history")}
                        class="h-5 shrink-0 items-center justify-center rounded-sm border border-line bg-side px-1.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
                      >
                        <Text class="font-mono text-2xs font-medium text-ink tabular-nums">{t("web.artifact.card.version", { version: v().version })}</Text>
                      </View>
                    )}
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
                </>
              }
              headerRight={
                <>
                  <IconButton
                    icon="clock"
                    label={rightPanel() === "history" ? t("web.artifact.timeline.hide") : t("web.artifact.timeline.show")}
                    testid="artifact-history-toggle"
                    pressed={rightPanel() === "history"}
                    onClick={() => setRightPanel(rightPanel() === "history" ? "none" : "history")}
                  />
                  <IconButton
                    icon="sidebarRight"
                    label={rightPanel() === "chat" ? t("web.artifact.page.railHide") : t("web.artifact.page.railShow")}
                    testid="artifact-rail-toggle"
                    pressed={rightPanel() === "chat"}
                    onClick={() => setRightPanel(rightPanel() === "chat" ? "none" : "chat")}
                  />
                </>
              }
              menuItems={(ctx: ArtifactDirectoryMenuContext) => {
                const items: ArtifactMenuItem[] = [];
                items.push({
                  key: "pin",
                  testID: "artifact-pin",
                  icon: "pin",
                  label: pinned() ? t("web.library.content.unpin") : t("web.library.content.pin"),
                  checked: pinned(),
                  separatorBefore: true,
                  onSelect: onTogglePin,
                });
                const chanList = channels();
                if (chanList.length > 0) {
                  items.push({
                    key: "send",
                    testID: "artifact-send",
                    icon: "send",
                    label: t("web.library.content.sendArtifact"),
                    submenu: chanList.map((c) => {
                      const label = `#${c.name ?? c.id}`;
                      return {
                        key: `send-${c.id}`,
                        testID: `artifact-send-${c.id}`,
                        icon: "chat" as const,
                        label,
                        onSelect: () => sendToChannel(c.id, label),
                      };
                    }),
                  });
                }
                const applet = currentHost().applet;
                if (applet !== undefined) {
                  const info = installedApplet();
                  if (info !== undefined) {
                    items.push(
                      {
                        key: "open-applet",
                        testID: "artifact-open-applet",
                        icon: "open",
                        label: t("web.artifact.applet.openApp"),
                        onSelect: () => {
                          void applet.open(props.artifact.id).catch(() => undefined);
                        },
                      },
                      {
                        key: "install-applet",
                        testID: "artifact-install-applet",
                        icon: "settings",
                        label: t("web.artifact.applet.manageApp"),
                        checked: true,
                        onSelect: () => appletModalOpen.set(true),
                      },
                    );
                  } else {
                    items.push({
                      key: "install-applet",
                      testID: "artifact-install-applet",
                      icon: "download",
                      label: t("web.artifact.applet.button"),
                      onSelect: () => appletModalOpen.set(true),
                    });
                  }
                }
                if (props.artifact.artifactType === "design-system" && selectedVersion() === undefined) {
                  items.push({
                    key: "default",
                    icon: "check",
                    label: props.artifact.isDefault ? t("web.artifact.types.unsetDefault") : t("web.artifact.types.setDefault"),
                    checked: props.artifact.isDefault,
                    disabled: ctx.busy,
                    onSelect: ctx.toggleDefaultDesignSystem,
                  });
                }
                items.push(
                  {
                    key: "issue",
                    icon: "issues",
                    label: t("web.library.content.turnIntoIssue"),
                    onSelect: () => void turnIntoIssue(),
                  },
                  {
                    key: "export",
                    icon: "download",
                    label: t("web.library.content.exportArtifact"),
                    onSelect: () => void exporting.run(() => exportArtifactDirectory(props.artifact, selectedVersion()?.version)),
                  },
                  {
                    key: "delete",
                    icon: "delete",
                    label: t("web.artifact.page.delete"),
                    danger: true,
                    separatorBefore: true,
                    onSelect: () => asking.set(true),
                  },
                );
                return items;
              }}
              belowHeader={
                <>
                  <If when={!presenting() && selectedVersion() !== undefined && historyPreview() === undefined}>
                    <Banner tone="info" edge icon="clock">
                      <View class="flex-row items-center justify-between gap-2">
                        <Text class="min-w-0 flex-1 truncate text-xs font-medium text-ink">
                          {t("web.artifact.timeline.versionBanner", {
                            version: selectedVersion()!.version,
                            note: selectedVersion()!.note ? ` · ${selectedVersion()!.note}` : "",
                          })}
                        </Text>
                        <Button size="compact" tone="plain" testID="artifact-version-back-live" onPress={() => pickVersion(undefined)}>
                          {t("web.artifact.timeline.backToLive")}
                        </Button>
                      </View>
                    </Banner>
                  </If>
                  <If when={!presenting() && asking()}>
                    <View testID="artifact-delete" class="shrink-0 flex-row flex-wrap items-center gap-2 border-b border-line bg-bad-soft px-3 py-2">
                      <Text class="min-w-0 flex-1 text-sm text-berry">{t("web.artifact.page.deleteAsk", { title: props.artifact.title })}</Text>
                      <Button tone="danger" icon="delete" testID="artifact-delete-sure" disabled={removing.busy()} onPress={() => void remove()}>
                        {t("web.artifact.page.delete")}
                      </Button>
                      <Button onPress={() => asking.set(false)}>{t("web.base.form.never")}</Button>
                    </View>
                  </If>
                </>
              }
              overrideBodyActive={historyPreview() !== undefined}
              overrideBody={
                <If when={historyPreview()}>
                  {(preview) => <HistoryPreviewBody artifact={props.artifact} preview={preview()} onBackToLive={() => historyPreview.set(undefined)} />}
                </If>
              }
              onPresent={(on) => contentPresenting.set(on)}
              onOpenChat={() => {
                setRightPanel("chat");
                requestArtifactChatFocus();
              }}
            />
          )}
        </Keyed>
      </View>

      <InstallAppletModal open={appletModalOpen()} artifact={props.artifact} onClose={() => appletModalOpen.set(false)} />

      <If when={rightPanel() !== "none" && !presenting()}>
        <View
          accessibilityLabel={rightPanel() === "history" ? t("web.artifact.timeline.title") : t("web.artifact.page.rail")}
          testID="artifact-rail"
          class={`h-full min-h-0 overflow-hidden border-l border-line bg-side ${lg() ? "relative shrink-0" : "absolute inset-0 z-20"}`}
          style={lg() ? { width: railWidth() } : undefined}
        >
          <If when={lg()}>
            <Splitter pane="artifact-rail" side="left" width={railWidth()} min={300} max={560} label={t("web.artifact.page.rail")} />
          </If>
          <View class="min-h-0 min-w-0 flex-1">
            <If
              when={rightPanel() === "history"}
              else={
                <View class="min-h-0 min-w-0 flex-1 pr-1.5">
                  <Chat
                    channel={said()?.channel ?? props.artifact.channel}
                    issue={props.artifact.issue}
                    point={said()?.number}
                    onClose={() => setRightPanel("none")}
                  />
                </View>
              }
            >
              <HistoryPanel
                artifact={props.artifact}
                selectedVersion={selectedVersion()?.version}
                activeFrontiers={historyPreview()?.frontiers}
                onPickVersion={pickVersion}
                onPreview={(snap) => historyPreview.set(snap)}
                onMutated={() => {
                  historyPreview.set(undefined);
                  revisionKey.set(untracked(revisionKey) + 1);
                }}
                onForked={(forked) => {
                  setRightPanel("none");
                  router.navigate(artifactHref(forked.id));
                }}
                onClose={() => setRightPanel("none")}
              />
            </If>
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
