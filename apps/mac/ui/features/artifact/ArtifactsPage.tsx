import { cleanup, effect, keymap, Scroll, signal, Text, untracked, View, type InputRef, type JSX } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { Artifact, ArtifactVersion } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { Empty } from "../../design/layout";
import { type MoreItem, MoreMenu } from "../../design/MoreMenu";
import { motionClass } from "../../design/motion";
import { SkeletonBar, SkeletonLines, useDelayedBusy } from "../../design/Skeleton";
import { Bubble } from "../../design/Tip";
import { toast } from "../../design/toasts";
import { api, newSendKey, reasonOf } from "../../infra/api";
import { Keyed, useNow } from "../../infra/base/dom";
import { ago } from "../../infra/base/format";
import { useCore } from "../../infra/frame";
import { ready, useQueryClient } from "../../infra/query";
import { Link as A, useRouter, useSearch } from "../../infra/router";
import { createMemo, createSignal } from "../../infra/solid";
import { contentPresenting, isPinned, openTemplatePicker, togglePinned } from "../content/navigation";
import { artifactHref, artifactSuffix, kindLabel, useArtifact, useArtifacts } from "./ArtifactCard";
import { BlocksView } from "./BlocksView";
import type { BlockEditor } from "./editor";
import type { Frame } from "./frame";
import { HtmlFrame } from "./HtmlFrame";
import { PageWords } from "./PageWords";
import { exportMarkdownFile, requestArtifactChatFocus, saveTextFile } from "./store";
import { StoreArtifactView } from "./StoreArtifactView";

/** Provided by app/: channel shows artifacts, so artifact does not import channel back. */
export type ArtifactChat = (props: {
  readonly channel?: string | undefined;
  readonly issue?: string | undefined;
  readonly point?: number | undefined;
}) => JSX.Element;

async function exportArtifactFile(artifact: Artifact, activeVersion?: number): Promise<boolean> {
  const safeName = (artifact.title.trim() || "deliverable").replace(/[\\/:*?"<>|]/gu, "-");
  if (artifact.body === "blocks") {
    return exportMarkdownFile(artifact.id, artifact.title);
  }
  if (artifact.body === "html") {
    const content = await api.artifact.content.get({ id: artifact.id, version: activeVersion ?? artifact.version });
    const suffix = artifactSuffix(artifact);
    return saveTextFile(`${safeName}${suffix}`, "text/html;charset=utf-8", content.content);
  }
  const snap = await api.artifact.entry.list({ id: artifact.id, includeValues: true });
  return saveTextFile(`${safeName}.json`, "application/json;charset=utf-8", JSON.stringify(snap.entries, null, 2));
}

function ArtifactSkeleton() {
  return (
    <View testID="artifact-skeleton" accessibilityState={{ busy: true }} class="min-h-0 flex-1 bg-page">
      <View class="h-11 shrink-0 flex-row items-center gap-2 border-b border-line bg-page px-3">
        <SkeletonBar class="h-6 w-16 rounded-md" />
        <SkeletonBar class="h-5 w-44 rounded-sm" />
        <SkeletonBar class="h-5 w-14 rounded-sm" />
        <View class="flex-1" />
        <SkeletonBar class="size-7 rounded-md" />
        <SkeletonBar class="size-7 rounded-md" />
      </View>
      <View class="mx-auto w-full max-w-3xl gap-4 px-6 py-7">
        <SkeletonBar class="h-7 w-64 rounded-md" />
        <SkeletonLines rows={["92%", "78%", "85%", "60%", "88%", "45%"]} gap="md" />
      </View>
    </View>
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
              </If>
            }
          >
            <Empty icon="artifacts">{reasonOf(all.error())}</Empty>
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
          <Empty icon="artifacts">{t("web.artifact.page.gone")}</Empty>
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
      class="h-7 min-w-24 max-w-72 flex-1 rounded-md bg-transparent px-1.5 text-base font-semibold text-ink hover:bg-hover focus:bg-hover"
    />
  );
}

function Shown(props: { artifact: Artifact; chat: ArtifactChat }) {
  const queries = useQueryClient();
  const search = useSearch();
  const router = useRouter();
  const core = useCore();
  const now = useNow();
  const asking = signal(false);
  const menu = signal(false);
  const sendMenu = signal(false);
  const html = () => props.artifact.body === "html";
  const store = () => props.artifact.body === "store";
  const wide = () => html() || store();
  // Wide artifacts start with the rail closed so the canvas gets the full width.
  const railOpen = signal(!untracked(wide));
  const asked = () => Number(search().get("v"));
  const version = createMemo((): ArtifactVersion | undefined => props.artifact.versions.find((v) => v.version === asked()) ?? props.artifact.versions.at(-1));
  const issue = () => (props.artifact.issue ? (core()?.issues ?? []).find((i) => i.id === props.artifact.issue) : undefined);
  const channels = () => (core()?.chat?.channels ?? []).filter((c) => c.type === "channel" && c.archived === undefined);
  /** Where its comments are: the version shown, else where it was first said. */
  const said = () => version() ?? props.artifact.said;
  const pick = (n: number) => router.navigate(artifactHref(props.artifact.id, n === props.artifact.version ? undefined : n), { replace: true });
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

  let editor: BlockEditor | undefined;
  const more = (): MoreItem[] => [
    { key: "issue", label: t("web.library.content.turnIntoIssue"), icon: "issues", onSelect: () => void turnIntoIssue() },
    ...(props.artifact.body === "blocks"
      ? [{ key: "demo", label: t("web.artifact.blocks.demo"), icon: "play" as const, onSelect: () => void editor?.demo() }]
      : []),
    { key: "delete", label: t("web.artifact.page.delete"), icon: "delete", danger: true, onSelect: () => asking.set(true) },
  ];

  const [frame, setFrame] = createSignal<Frame>();
  const framed = () => {
    const v = version();
    const f = frame();
    return html() && v && f ? { version: v.version, frame: f } : undefined;
  };
  const [suggestions, setSuggestions] = createSignal<{ readonly draw: () => JSX.Element }>();
  const Chat = untracked(() => props.chat);
  const presenting = () => contentPresenting();
  const isCovered = () => menu() || sendMenu();

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
      accessibilityValue={{ text: `${props.artifact.id} ${props.artifact.body} ${version()?.version ?? ""}` }}
      class="min-h-0 flex-1 xl:flex-row"
    >
      <View class="min-h-0 min-w-0 flex-1">
        <If when={presenting()}>
          <View testID="artifact-presenting" class="h-9 shrink-0 flex-row items-center gap-2 border-b border-line bg-side px-3">
            <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{props.artifact.title}</Text>
            <Button icon="close" testID="artifact-present-end" onPress={() => contentPresenting.set(false)}>
              {t("web.artifact.canvas.close")}
            </Button>
          </View>
        </If>

        <If when={!presenting()}>
          <View testID="artifact-header" class="h-11 shrink-0 flex-row items-center gap-2 border-b border-line bg-page px-3">
            <A
              href="/library"
              testID="artifact-back-library"
              tooltip={<Bubble text={t("web.library.content.back")} />}
              class={`h-7 shrink-0 flex-row items-center gap-1 rounded-md border border-line bg-page px-2 ${motionClass("transition-transform duration-120 ease-out")} hover:bg-hover active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus`}
            >
              <Icon name="back" size={14} tone="muted" />
              <Text class="text-xs font-medium text-muted">{t("web.library.content.back")}</Text>
            </A>
            <View class="min-w-0 flex-1 flex-row items-center gap-2 overflow-hidden">
              <Title artifact={props.artifact} />
              <View class="h-5 shrink-0 items-center justify-center rounded-sm bg-selected px-1.5">
                <Text class="text-2xs font-medium text-ink">{kindLabel(props.artifact)}</Text>
              </View>
              <If when={props.artifact.isDefault}>
                <View testID="artifact-default-badge" class="h-5 shrink-0 items-center justify-center rounded-sm bg-accent px-1.5">
                  <Text class="text-2xs font-semibold text-page">{t("web.artifact.types.defaultBadge")}</Text>
                </View>
              </If>
              <If when={html() && props.artifact.versions.length > 1}>
                <View testID="artifact-versions" class="shrink-0 flex-row items-center gap-1">
                  <Each of={props.artifact.versions.toReversed()} key={(v) => v.version}>
                    {(v) => (
                      <View
                        role="button"
                        testID={`artifact-version-${v().version}`}
                        accessibilityState={{ selected: v().version === version()?.version }}
                        onPress={() => pick(v().version)}
                        class={`h-5 items-center justify-center rounded-sm border px-1.5 ${
                          v().version === version()?.version ? "border-accent bg-selected" : "border-line bg-page hover:bg-hover"
                        }`}
                      >
                        <Text class={`font-mono text-2xs font-medium tabular-nums ${v().version === version()?.version ? "text-ink" : "text-muted"}`}>
                          {`v${v().version}`}
                        </Text>
                      </View>
                    )}
                  </Each>
                </View>
              </If>
              <Text class="hidden shrink-0 text-xs text-muted md:flex">{`${props.artifact.byName} · ${ago(props.artifact.updated, now())}`}</Text>
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
            </View>
            <View class="shrink-0 flex-row items-center gap-1">
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
              <IconButton
                icon="download"
                label={t("web.library.content.exportArtifact")}
                testid="artifact-export"
                disabled={exporting.busy()}
                onClick={() => void exporting.run(() => exportArtifactFile(props.artifact, version()?.version))}
              />
              <IconButton
                icon="thread"
                label={railOpen() ? t("web.artifact.page.railHide") : t("web.artifact.page.railShow")}
                testid="artifact-rail-toggle"
                pressed={railOpen()}
                onClick={() => railOpen.set(!railOpen())}
              />
              <MoreMenu label={t("web.artifact.page.more")} testid="artifact-more" items={more()} open={menu()} onOpenChange={(o) => menu.set(o)} />
            </View>
          </View>
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

        <If when={props.artifact.body === "blocks"}>
          <View class="min-h-0 w-full flex-1">
            <View class="mx-auto min-h-0 w-full max-w-3xl flex-1 gap-2 px-5 py-4">
              <If when={!railOpen() ? suggestions() : undefined}>{(s) => s().draw()}</If>
              <BlocksView id={props.artifact.id} onEditor={(e) => (editor = e)} onRail={(draw) => setSuggestions({ draw })} />
            </View>
          </View>
        </If>

        <If when={store()}>
          <StoreArtifactView
            artifact={props.artifact}
            covered={isCovered()}
            onPresent={(on) => contentPresenting.set(on)}
            onOpenChat={() => {
              railOpen.set(true);
              requestArtifactChatFocus();
            }}
            frameClass="min-h-0 w-full flex-1 bg-page"
          />
        </If>

        <If when={html() ? version() : undefined}>
          {(v) => (
            <Keyed key={v().version}>
              {() => (
                <View class="min-h-0 w-full flex-1">
                  <HtmlFrame
                    artifact={props.artifact}
                    version={untracked(v).version}
                    title={t("web.artifact.page.frame", { title: props.artifact.title, version: untracked(v).version })}
                    testId="artifact-frame"
                    frameClass="min-h-0 w-full flex-1 bg-page"
                    covered={isCovered()}
                    onPresent={(on) => contentPresenting.set(on)}
                    onFrame={setFrame}
                  />
                  <If when={!presenting() && railOpen() && untracked(v).version === props.artifact.version}>
                    <View class="shrink-0 border-t border-line bg-side px-3 py-1">
                      <Text class="text-xs text-faint">{t("web.artifact.edit.hint")}</Text>
                    </View>
                  </If>
                </View>
              )}
            </Keyed>
          )}
        </If>
      </View>

      <If when={railOpen() && !presenting()}>
        <View
          accessibilityLabel={t("web.artifact.page.rail")}
          testID="artifact-rail"
          class="h-96 min-h-0 shrink-0 border-t border-line bg-side xl:h-full xl:w-88 xl:border-t-0 xl:border-l"
        >
          <If when={!wide() ? suggestions() : undefined}>
            {(s) => (
              <Scroll class="max-h-56 shrink-0 border-b border-line" contentClass="px-3 py-3">
                {s().draw()}
              </Scroll>
            )}
          </If>
          <If when={framed()}>
            {(p) => (
              <View class="shrink-0 border-b border-line px-3 py-3">
                <Keyed key={p().version}>{() => <PageWords artifact={props.artifact} version={untracked(p).version} frame={untracked(p).frame} />}</Keyed>
              </View>
            )}
          </If>
          <View class="min-h-0 min-w-0 flex-1">
            <Chat channel={said()?.channel ?? props.artifact.channel} issue={props.artifact.issue} point={said()?.number} />
          </View>
        </View>
      </If>
    </View>
  );
}
