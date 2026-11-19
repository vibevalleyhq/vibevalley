// Ported from VibeValley apps/web/src/features/artifact/ArtifactsPage.tsx:
// the list (delivered to the user, then the user's own) beside the one open:
// Back-to-Library link, collapsible list toggle, title typed over in place,
// top-header kind/suffix/default badges & version pills, blocks/html/store
// viewers, and an embedded live ChannelSidePane in the rail.
//
// Changed for the app: a deck's Present fills this page with the deck (no
// fullscreen element; Escape or the bar's button comes back). A web view is
// drawn over whatever nsh draws in its box, so it is hidden (`covered`) while
// a menu is open. Suggestions are drawn in the rail by BlocksView's onRail.
import { effect, keymap, Scroll, signal, Text, untracked, View, type InputRef, type JSX } from "nsh";
import { Input } from "nsh/base";
import { z } from "zod";

import { t } from "@vibevalley/i18n";
import { type Artifact, type ArtifactType, type ArtifactVersion, userId } from "@vibevalley/protocol";

import { createMemo, createSignal } from "../../../solid";
import { Keyed, useNow } from "../../base/dom";
import { ago } from "../../base/format";
import { spelled } from "../../base/search";
import { api, reasonOf } from "../../infra/api";
import { useCore } from "../../infra/frame";
import { ready, useQueryClient } from "../../infra/query";
import { Link as A, useRouter, useSearch } from "../../infra/router";
import { defineAtom } from "../../state/atom";
import { defineStored } from "../../state/stored";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { IconButton } from "../../ui/IconButton";
import { Empty } from "../../ui/layout";
import { type MoreItem, MoreMenu } from "../../ui/MoreMenu";
import { toast } from "../../ui/toasts";
import { tone } from "../../ui/tone";
import { artifactHref, artifactIcon, artifactSuffix, artifactTypeIcon, kindLabel, useArtifact, useArtifacts } from "./ArtifactCard";
import { BlocksView } from "./BlocksView";
import type { BlockEditor } from "./editor";
import type { Frame } from "./frame";
import { HtmlFrame } from "./HtmlFrame";
import { PageWords } from "./PageWords";
import { createTypedArtifact, exportMarkdownFile } from "./store";
import { StoreArtifactView } from "./StoreArtifactView";

const listOpen = defineStored("artifact.list", z.boolean(), true);
const rail = defineStored("artifact.rail", z.boolean(), true);

/** The one just made with New: its title is selected to be typed over when it opens. */
const justMade = defineAtom<string | undefined>(undefined);

/** Provided by app/: channel shows artifacts, so artifact does not import channel back. */
export type ArtifactChat = (props: {
  readonly channel?: string | undefined;
  readonly issue?: string | undefined;
  readonly point?: number | undefined;
}) => JSX.Element;

/** `rest` is the path after /artifacts/. */
export function ArtifactsPage(props: { rest: string; chat: ArtifactChat }) {
  const queries = useQueryClient();
  const router = useRouter();
  const now = useNow();
  const all = useArtifacts(() => ({}));
  const query = signal("");
  const presenting = signal(false);
  const typeMenu = signal(false);
  const list = () => ready(all, []);
  const shown = () => {
    const q = query().trim().toLowerCase();
    return q ? list().filter((a) => spelled(a.title, q)) : list();
  };
  const id = () => {
    const rest = props.rest.split("?")[0] ?? "";
    return rest ? decodeURIComponent(rest) : undefined;
  };
  const open = () => id() ?? list()[0]?.id;
  const making = createAct();
  const create = (choice: ArtifactType | "html" = "docs") =>
    making.run(async () => {
      const made = await createTypedArtifact(choice, t("web.artifact.page.untitled"));
      justMade.set(made.id);
      await queries.invalidate({ prefix: ["artifacts"] });
      router.navigate(artifactHref(made.id));
    });
  const newTypeItems = (): MoreItem[] => [
    { key: "docs", label: t("web.artifact.types.docs"), icon: artifactTypeIcon.docs, onSelect: () => void create("docs") },
    { key: "slides", label: t("web.artifact.types.slides"), icon: artifactTypeIcon.slides, onSelect: () => void create("slides") },
    { key: "dashboard", label: t("web.artifact.types.dashboard"), icon: artifactTypeIcon.dashboard, onSelect: () => void create("dashboard") },
    { key: "motion", label: t("web.artifact.types.motion"), icon: artifactTypeIcon.motion, onSelect: () => void create("motion") },
    { key: "whiteboard", label: t("web.artifact.types.whiteboard"), icon: artifactTypeIcon.whiteboard, onSelect: () => void create("whiteboard") },
    { key: "design", label: t("web.artifact.types.design"), icon: artifactTypeIcon.design, onSelect: () => void create("design") },
    {
      key: "design-system",
      label: t("web.artifact.types.designSystem"),
      icon: artifactTypeIcon["design-system"],
      onSelect: () => void create("design-system"),
    },
    { key: "html", label: t("web.artifact.types.html"), icon: "web", onSelect: () => void create("html") },
  ];
  const groups = () => {
    const rows = shown();
    return [
      { key: "delivered", rows: rows.filter((a) => a.by !== userId) },
      { key: "mine", rows: rows.filter((a) => a.by === userId) },
    ] as const;
  };
  const shut = signal<ReadonlySet<string>>(new Set());
  const toggle = (key: string) => {
    const next = new Set(shut());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    shut.set(next);
  };
  return (
    <View testID="artifacts" class="h-full min-h-0 flex-1 lg:flex-row">
      <View
        accessibilityLabel={t("web.artifact.page.list")}
        testID="artifact-list"
        class={`min-h-0 shrink-0 gap-3 border-line bg-side p-3 lg:w-64 lg:border-r ${
          presenting() ? "hidden" : listOpen.get() ? (id() ? "hidden lg:flex" : "flex-1 lg:flex-none") : id() ? "hidden" : "flex-1 lg:hidden"
        }`}
      >
        <View class="flex-row items-center gap-1.5">
          <View class="h-8 min-w-0 flex-1 flex-row items-center gap-1.5 rounded-md border border-line bg-page px-2 focus-within:border-focus">
            <Icon name="search" size={14} tone="muted" />
            <Input
              testID="artifact-search"
              value={query()}
              onChange={(e) => query.set(e.value)}
              placeholder={t("web.artifact.page.find")}
              accessibilityLabel={t("web.artifact.page.find")}
              class="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-faint"
            />
          </View>
          <IconButton icon="add" label={t("web.artifact.page.new")} testid="new-artifact" disabled={making.busy()} onClick={() => void create("docs")} />
          <MoreMenu
            icon="choose"
            label={t("web.artifact.types.pick")}
            testid="new-artifact-type"
            items={newTypeItems()}
            open={typeMenu()}
            onOpenChange={(o) => typeMenu.set(o)}
          />
        </View>
        <If when={all.error()}>
          <Text class="px-2 text-xs text-berry">{reasonOf(all.error())}</Text>
        </If>
        <If when={all.status() === "success" && list().length === 0}>
          <Text class="px-2 text-xs text-muted lg:hidden">{t("web.artifact.page.none")}</Text>
        </If>
        <If when={list().length > 0 && shown().length === 0}>
          <Text class="px-2 text-xs text-muted">{t("web.artifact.page.nothingFound")}</Text>
        </If>
        <Scroll class="-mx-2 min-h-0 flex-1" contentClass="gap-2 px-2">
          <Each of={groups().filter((g) => g.rows.length > 0)} key={(g) => g.key}>
            {(g) => (
              <View testID={`artifact-group-${g().key}`} class="gap-0.5">
                <View
                  role="button"
                  accessibilityState={{ expanded: !shut().has(g().key) }}
                  onPress={() => toggle(g().key)}
                  class="group flex-row items-center gap-1 px-1 pt-1"
                >
                  <Icon name={shut().has(g().key) ? "expand" : "choose"} size={12} tone="muted" />
                  <Text class="text-xs font-semibold text-muted group-hover:text-ink">{t(`web.artifact.page.group.${g().key}`)}</Text>
                  <Text class="text-xs text-faint">{String(g().rows.length)}</Text>
                </View>
                <If when={!shut().has(g().key)}>
                  <Each of={g().rows} key={(a) => a.id}>
                    {(a) => (
                      <A
                        href={artifactHref(a().id)}
                        testID={`artifact-row-${a().id}`}
                        accessibilityState={{ selected: a().id === open() }}
                        class={[
                          "flex-row items-start gap-2 rounded-md px-2 py-1.5 transition duration-120 ease-out",
                          a().id === id() ? "bg-selected" : a().id === open() ? "hover:bg-hover lg:bg-selected" : "hover:bg-hover",
                        ].join(" ")}
                      >
                        <View class="mt-0.5 shrink-0">
                          <Icon name={artifactIcon(a())} size={16} tone="muted" />
                        </View>
                        <View class="min-w-0 flex-1">
                          <Text class="truncate text-sm font-medium text-ink">{a().title}</Text>
                          <Text
                            class={`truncate text-xs ${a().id === open() ? "" : "text-muted"}`}
                            style={a().id === open() ? { color: tone("ink"), opacity: 0.75 } : undefined}
                          >
                            {[
                              `${kindLabel(a())} (${artifactSuffix(a())})`,
                              ...(a().body === "html" ? [t("web.artifact.card.version", { version: a().version })] : []),
                              ago(a().updated, now()),
                            ].join(" · ")}
                          </Text>
                        </View>
                      </A>
                    )}
                  </Each>
                </If>
              </View>
            )}
          </Each>
        </Scroll>
      </View>
      <View class={`min-h-0 min-w-0 flex-1 ${id() ? "" : "hidden lg:flex"}`}>
        <If
          when={open()}
          else={
            <If when={all.status() === "success"}>
              <Empty
                icon="artifacts"
                action={
                  <Button icon="add" disabled={making.busy()} onPress={() => void create("docs")}>
                    {t("web.artifact.page.new")}
                  </Button>
                }
              >
                {t("web.artifact.page.none")}
              </Empty>
            </If>
          }
        >
          {(o) => (
            <Keyed key={o()}>
              {() => (
                <Opened
                  id={untracked(o)}
                  chat={props.chat}
                  presenting={presenting}
                  covered={typeMenu()}
                  listOpen={listOpen.get()}
                  onToggleList={() => listOpen.update((on) => !on)}
                />
              )}
            </Keyed>
          )}
        </If>
      </View>
    </View>
  );
}

type Presenting = ReturnType<typeof signal<boolean>>;

function Opened(props: { id: string; chat: ArtifactChat; presenting: Presenting; covered: boolean; listOpen: boolean; onToggleList: () => void }) {
  const found = useArtifact(() => props.id);
  return (
    <If
      when={ready(found, undefined)}
      else={
        <If when={found.status() === "error"}>
          <Empty icon="artifacts">{t("web.artifact.page.gone")}</Empty>
        </If>
      }
    >
      {(a) => (
        <Shown
          artifact={a()}
          chat={props.chat}
          presenting={props.presenting}
          covered={props.covered}
          listOpen={props.listOpen}
          onToggleList={props.onToggleList}
        />
      )}
    </If>
  );
}

/** The title, typed over in place: Return or leaving it renames, Escape puts it back. */
function Title(props: { artifact: Artifact }) {
  const queries = useQueryClient();
  const text = signal(untracked(() => props.artifact.title));
  const focused = signal(false);
  const initialFresh = untracked(justMade.get) === untracked(() => props.artifact.id);
  let field: InputRef | undefined;
  const act = createAct();
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
        if (initialFresh)
          queueMicrotask(() => {
            justMade.set(undefined);
            el.focus();
            el.setSelection(0, text().length);
          });
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
      class="-mx-1 h-8 min-w-0 flex-1 rounded-md bg-transparent px-1 text-xl font-semibold text-ink hover:bg-hover focus:bg-hover"
    />
  );
}

function Shown(props: { artifact: Artifact; chat: ArtifactChat; presenting: Presenting; covered: boolean; listOpen: boolean; onToggleList: () => void }) {
  const queries = useQueryClient();
  const search = useSearch();
  const router = useRouter();
  const core = useCore();
  const now = useNow();
  const asking = signal(false);
  const menu = signal(false);
  const html = () => props.artifact.body === "html";
  const store = () => props.artifact.body === "store";
  const wide = () => html() || store();
  const asked = () => Number(search().get("v"));
  const version = createMemo((): ArtifactVersion | undefined => props.artifact.versions.find((v) => v.version === asked()) ?? props.artifact.versions.at(-1));
  const issue = () => (props.artifact.issue ? (core()?.issues ?? []).find((i) => i.id === props.artifact.issue) : undefined);
  /** Where its comments are: the version shown, else where it was first said. */
  const said = () => version() ?? props.artifact.said;
  const pick = (n: number) => router.navigate(artifactHref(props.artifact.id, n === props.artifact.version ? undefined : n), { replace: true });
  const removing = createAct();
  const exporting = createAct();
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
    ...(props.artifact.body === "blocks"
      ? [
          {
            key: "exportMd",
            label: t("web.artifact.types.exportMarkdown"),
            icon: "download" as const,
            onSelect: () => {
              const { id, title } = props.artifact;
              void exporting.run(() => exportMarkdownFile(id, title));
            },
          },
          { key: "demo", label: t("web.artifact.blocks.demo"), icon: "play" as const, onSelect: () => void editor?.demo() },
        ]
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
  const presenting = () => props.presenting();
  const isCovered = () => props.covered || menu();
  effect(() => {
    if (!presenting()) return;
    return keymap.bind("escape", () => props.presenting.set(false), { when: "always" });
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
      <View class={`min-h-0 min-w-0 flex-1 ${presenting() ? "" : "px-4 py-4"}`}>
        <View class={`min-h-0 w-full flex-1 gap-3 ${wide() ? "" : "mx-auto max-w-3xl"}`}>
          <If when={presenting()}>
            <View testID="artifact-presenting" class="h-9 shrink-0 flex-row items-center gap-2 border-b border-line bg-side px-3">
              <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{props.artifact.title}</Text>
              <Button icon="close" testID="artifact-present-end" onPress={() => props.presenting.set(false)}>
                {t("web.artifact.canvas.close")}
              </Button>
            </View>
          </If>
          <If when={!presenting()}>
            <View class={`gap-1 ${wide() ? "" : "lg:pl-8.75"}`}>
              <View class="flex-row items-center gap-2">
                <A
                  href="/library"
                  testID="artifact-back-library"
                  class="h-7 shrink-0 flex-row items-center gap-1 rounded-md border border-line bg-page px-2 transition duration-120 ease-out hover:bg-hover"
                >
                  <Icon name="back" size={14} tone="muted" />
                  <Text class="text-xs font-medium text-muted">{t("web.artifact.page.backToLibrary")}</Text>
                </A>
                <View class="hidden lg:flex">
                  <IconButton
                    icon={props.listOpen ? "previous" : "expand"}
                    label={props.listOpen ? t("web.artifact.page.listHide") : t("web.artifact.page.listShow")}
                    testid="artifact-list-toggle"
                    pressed={props.listOpen}
                    onClick={props.onToggleList}
                  />
                </View>
                <Title artifact={props.artifact} />
                <IconButton
                  icon="thread"
                  label={rail.get() ? t("web.artifact.page.railHide") : t("web.artifact.page.railShow")}
                  testid="artifact-rail-toggle"
                  pressed={rail.get()}
                  onClick={() => rail.update((on) => !on)}
                />
                <MoreMenu label={t("web.artifact.page.more")} testid="artifact-more" items={more()} open={menu()} onOpenChange={(o) => menu.set(o)} />
              </View>
              <View class="flex-row flex-wrap items-center gap-x-2 gap-y-1">
                <View class="rounded-sm bg-selected px-1.5 py-0.5">
                  <Text class="text-2xs font-medium text-ink">{kindLabel(props.artifact)}</Text>
                </View>
                <View testID="artifact-suffix" class="rounded-sm border border-line bg-page px-1.5 py-0.5">
                  <Text class="font-mono text-2xs text-muted">{artifactSuffix(props.artifact)}</Text>
                </View>
                <If when={props.artifact.isDefault}>
                  <View testID="artifact-default-badge" class="rounded-sm bg-accent px-1.5 py-0.5">
                    <Text class="text-2xs font-medium text-page">{t("web.artifact.types.defaultBadge")}</Text>
                  </View>
                </If>
                <Text class="text-xs text-muted">·</Text>
                <If when={html() ? version() : undefined}>
                  {(v) => (
                    <>
                      <Text testID="artifact-shown-version" class="text-xs text-muted">
                        {t("web.artifact.card.version", { version: v().version })}
                      </Text>
                      <Text class="text-xs text-muted">·</Text>
                    </>
                  )}
                </If>
                <If when={html() && props.artifact.versions.length > 1}>
                  <View testID="artifact-versions" class="flex-row flex-wrap items-center gap-1">
                    <Each of={[...props.artifact.versions].reverse()} key={(v) => v.version}>
                      {(v) => (
                        <View
                          role="button"
                          testID={`artifact-version-${v().version}`}
                          accessibilityState={{ selected: v().version === version()?.version }}
                          onPress={() => pick(v().version)}
                          class={`h-5 items-center justify-center rounded-sm border px-1.5 transition duration-120 ease-out ${
                            v().version === version()?.version ? "border-accent bg-selected" : "border-line bg-page hover:bg-hover"
                          }`}
                        >
                          <Text class={`text-2xs font-medium ${v().version === version()?.version ? "text-ink" : "text-muted"}`}>
                            {t("web.artifact.card.version", { version: v().version })}
                          </Text>
                        </View>
                      )}
                    </Each>
                  </View>
                  <Text class="text-xs text-muted">·</Text>
                </If>
                <Text class="text-xs text-muted">{t("web.artifact.page.by", { name: props.artifact.byName })}</Text>
                <Text class="text-xs text-muted">·</Text>
                <Text class="text-xs text-muted">{t("web.artifact.page.updated", { when: ago(props.artifact.updated, now()) })}</Text>
                <If when={issue()}>
                  {(i) => (
                    <>
                      <Text class="text-xs text-muted">·</Text>
                      <A href={`/issues/${i().id}`} testID="artifact-issue" class="group">
                        <Text class="text-xs text-water group-hover:underline">{t("web.artifact.page.forIssue", { number: i().number })}</Text>
                      </A>
                    </>
                  )}
                </If>
              </View>
              <If when={asking()}>
                <View testID="artifact-delete" class="mt-2 flex-row flex-wrap items-center gap-2 rounded-md bg-bad-soft px-3 py-2">
                  <Text class="min-w-0 flex-1 text-sm text-berry">{t("web.artifact.page.deleteAsk", { title: props.artifact.title })}</Text>
                  <Button tone="danger" icon="delete" testID="artifact-delete-sure" disabled={removing.busy()} onPress={() => void remove()}>
                    {t("web.artifact.page.delete")}
                  </Button>
                  <Button onPress={() => asking.set(false)}>{t("web.base.form.never")}</Button>
                </View>
              </If>
            </View>
          </If>
          <If when={props.artifact.body === "blocks"}>
            <If when={!rail.get() ? suggestions() : undefined}>{(s) => s().draw()}</If>
            <BlocksView id={props.artifact.id} onEditor={(e) => (editor = e)} onRail={(draw) => setSuggestions({ draw })} />
          </If>
          <If when={store()}>
            <StoreArtifactView
              artifact={props.artifact}
              covered={isCovered()}
              onPresent={(on) => props.presenting.set(on)}
              frameClass={`min-h-0 w-full flex-1 bg-page ${presenting() ? "" : "rounded-lg border border-line"}`}
            />
          </If>
          <If when={html() ? version() : undefined}>
            {(v) => (
              <Keyed key={v().version}>
                {() => (
                  <>
                    <HtmlFrame
                      artifact={props.artifact}
                      version={untracked(v).version}
                      title={t("web.artifact.page.frame", { title: props.artifact.title, version: untracked(v).version })}
                      testId="artifact-frame"
                      frameClass={`min-h-0 w-full flex-1 bg-page ${presenting() ? "" : "rounded-lg border border-line"}`}
                      covered={isCovered()}
                      onPresent={(on) => props.presenting.set(on)}
                      onFrame={setFrame}
                    />
                    <If when={!presenting() && rail.get() && untracked(v).version === props.artifact.version}>
                      <Text class="text-xs text-faint">{t("web.artifact.edit.hint")}</Text>
                    </If>
                  </>
                )}
              </Keyed>
            )}
          </If>
        </View>
      </View>
      <If when={rail.get() && !presenting()}>
        <View
          accessibilityLabel={t("web.artifact.page.rail")}
          testID="artifact-rail"
          class="max-h-96 min-h-0 shrink-0 border-t border-line xl:max-h-full xl:w-88 xl:border-t-0 xl:border-l"
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
            {props.chat({
              channel: said()?.channel ?? props.artifact.channel,
              issue: props.artifact.issue,
              point: said()?.number,
            })}
          </View>
        </View>
      </If>
    </View>
  );
}
