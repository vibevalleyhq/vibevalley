// Ported from VibeValley apps/web/src/features/artifact/ArtifactsPage.tsx:
// the list (delivered to the user, then the user's own) beside the one
// open: its title typed over in place, the blocks written together or an
// html version in its web view, and the rail with the versions, the words
// picked in the page and a reply under the message that announced it.
//
// Changed for the app: there is no address to copy or tab to open a version
// in (VibeValley's "copy link" and "open" serve the page over HTTP), so the
// menu has neither. A deck's Present fills this page with the deck (no
// fullscreen element; Escape or the bar's button comes back). A web view is
// drawn over whatever nsh draws in its box, so it is hidden (`covered`)
// while the ⋯ menu is open. The suggestions are drawn in the rail by
// BlocksView's onRail (no Portal), above the blocks when the rail is shut.
import { effect, keymap, Scroll, signal, Text, untracked, View, type InputRef, type JSX } from "nsh";
import { Input } from "nsh/base";
import { z } from "zod";

import { t } from "@vibevalley/i18n";
import { type Artifact, type ArtifactVersion, userId, type SayRequest } from "@vibevalley/protocol";

import { createMemo, createSignal } from "../../../solid";
import { Keyed, useNow } from "../../base/dom";
import { ago } from "../../base/format";
import { spelled } from "../../base/search";
import { api, reasonOf } from "../../infra/api";
import { useCore } from "../../infra/frame";
import { ready, useQueryClient } from "../../infra/query";
import { Link as A, useRouter, useSearch } from "../../infra/router";
import { defineAtom } from "../../state/atom";
import { type IntentType, sendOnce, useIntents } from "../../state/intent";
import { defineStored } from "../../state/stored";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { TextArea } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { IconButton } from "../../ui/IconButton";
import { Empty } from "../../ui/layout";
import { type MoreItem, MoreMenu } from "../../ui/MoreMenu";
import { toast } from "../../ui/toasts";
import { tone } from "../../ui/tone";
import { artifactHref, bodyIcon, useArtifact, useArtifacts } from "./ArtifactCard";
import { BlocksView } from "./BlocksView";
import type { BlockEditor } from "./editor";
import type { Frame } from "./frame";
import { HtmlFrame } from "./HtmlFrame";
import { PageWords } from "./PageWords";

const messageHref = (at: { readonly channel: string; readonly number?: number }) =>
  at.number !== undefined ? `/chat/${at.channel}?m=${at.number}` : `/chat/${at.channel}`;

const rail = defineStored("artifact.rail", z.boolean(), true);

/** The one just made with New: its title is selected to be typed over when it opens. */
const justMade = defineAtom<string | undefined>(undefined);

/** The user's lines in a channel (features/channel's chatSay), given by app/: the channel feature shows artifacts, so this
 * one does not import it back. */
type ChatSay = IntentType<Omit<SayRequest, "sendKey">, void>;

/** `rest` is the path after /artifacts/. */
export function ArtifactsPage(props: { rest: string; say: ChatSay }) {
  const queries = useQueryClient();
  const router = useRouter();
  const now = useNow();
  const all = useArtifacts(() => ({}));
  const query = signal("");
  const presenting = signal(false);
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
  const create = () =>
    making.run(async () => {
      const made = await api.artifact.create({ title: t("web.artifact.page.untitled"), kind: "markdown" });
      justMade.set(made.id);
      await queries.invalidate({ prefix: ["artifacts"] });
      router.navigate(artifactHref(made.id));
    });
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
        class={`min-h-0 shrink-0 gap-3 border-line bg-side p-3 lg:w-64 lg:border-r ${presenting() ? "hidden" : id() ? "hidden lg:flex" : "flex-1 lg:flex-none"}`}
      >
        <View class="flex-row gap-1.5">
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
          {/* Beside the search, not a green button over the page being read: a new one is not what this page is for. */}
          <IconButton icon="add" label={t("web.artifact.page.new")} testid="new-artifact" disabled={making.busy()} onClick={() => void create()} />
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
                          <Icon name={bodyIcon[a().body]} size={16} tone="muted" />
                        </View>
                        <View class="min-w-0 flex-1">
                          <Text class="truncate text-sm font-medium text-ink">{a().title}</Text>
                          {/* On the selected row's darker ground the line takes more ink, to stay readable. */}
                          <Text
                            class={`truncate text-xs ${a().id === open() ? "" : "text-muted"}`}
                            style={a().id === open() ? { color: tone("ink"), opacity: 0.75 } : undefined}
                          >
                            {`${a().byName} · ${ago(a().updated, now())}`}
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
                  <Button icon="add" disabled={making.busy()} onPress={() => void create()}>
                    {t("web.artifact.page.new")}
                  </Button>
                }
              >
                {t("web.artifact.page.none")}
              </Empty>
            </If>
          }
        >
          {(o) => <Keyed key={o()}>{() => <Opened id={untracked(o)} say={props.say} presenting={presenting} />}</Keyed>}
        </If>
      </View>
    </View>
  );
}

type Presenting = ReturnType<typeof signal<boolean>>;

function Opened(props: { id: string; say: ChatSay; presenting: Presenting }) {
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
      {(a) => <Shown artifact={a()} say={props.say} presenting={props.presenting} />}
    </If>
  );
}

/** The title, typed over in place: Return or leaving it renames, Escape puts it back. */
function Title(props: { artifact: Artifact }) {
  const queries = useQueryClient();
  const text = signal(untracked(() => props.artifact.title));
  const focused = signal(false);
  // Taken while the component is made: a ref runs where the props may not be read yet.
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

function Shown(props: { artifact: Artifact; say: ChatSay; presenting: Presenting }) {
  const queries = useQueryClient();
  const search = useSearch();
  const router = useRouter();
  const core = useCore();
  const now = useNow();
  const asking = signal(false);
  const menu = signal(false);
  const html = () => props.artifact.body === "html";
  const asked = () => Number(search().get("v"));
  const version = createMemo(() => props.artifact.versions.find((v) => v.version === asked()) ?? props.artifact.versions.at(-1));
  const issue = () => (props.artifact.issue ? (core()?.issues ?? []).find((i) => i.id === props.artifact.issue) : undefined);
  /** Where its comments are: the version shown, else where it was first said. */
  const said = () => version() ?? props.artifact.said;
  const pick = (n: number) => router.navigate(artifactHref(props.artifact.id, n === props.artifact.version ? undefined : n), { replace: true });
  const removing = createAct();
  const remove = () => {
    const { id, title } = props.artifact;
    return removing.run(async () => {
      await api.artifact.delete({ id });
      // Away first: refreshed, this view's own read fails and it is gone before it could move on.
      router.navigate("/artifacts");
      toast(t("web.artifact.page.deleted", { title }));
      void queries.invalidate({ prefix: ["artifacts"] });
    });
  };
  let editor: BlockEditor | undefined;
  const more = (): MoreItem[] => [
    ...(html() ? [] : [{ key: "demo", label: t("web.artifact.blocks.demo"), icon: "play" as const, onSelect: () => void editor?.demo() }]),
    { key: "delete", label: t("web.artifact.page.delete"), icon: "delete", danger: true, onSelect: () => asking.set(true) },
  ];
  const [frame, setFrame] = createSignal<Frame>();
  /** The version on show and its frame, for PageWords: only when the page is html and both are there. */
  const framed = () => {
    const v = version();
    const f = frame();
    return html() && v && f ? { version: v.version, frame: f } : undefined;
  };
  const [suggestions, setSuggestions] = createSignal<{ readonly draw: () => JSX.Element }>();
  const presenting = () => props.presenting();
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
        {/* A page is shown as wide as there is room; written blocks read in a column. */}
        <View class={`min-h-0 w-full flex-1 gap-3 ${html() ? "" : "mx-auto max-w-3xl"}`}>
          <If when={presenting()}>
            <View testID="artifact-presenting" class="h-9 shrink-0 flex-row items-center gap-2 border-b border-line bg-side px-3">
              <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{props.artifact.title}</Text>
              <Button icon="close" testID="artifact-present-end" onPress={() => props.presenting.set(false)}>
                {t("web.artifact.canvas.close")}
              </Button>
            </View>
          </If>
          <If when={!presenting()}>
            <View class="items-start lg:hidden">
              <Button icon="back" onPress={() => router.navigate("/artifacts")}>
                {t("web.artifact.page.all")}
              </Button>
            </View>
            {/* A blocks one's header lines up with its text, past the gutter of faces and author bars (BlocksView). */}
            <View class={`gap-1 ${html() ? "" : "lg:pl-8.75"}`}>
              <View class="flex-row items-center gap-2">
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
          <If
            when={html() ? version() : undefined}
            else={
              <>
                <If when={!rail.get() ? suggestions() : undefined}>{(s) => s().draw()}</If>
                <BlocksView id={props.artifact.id} onEditor={(e) => (editor = e)} onRail={(draw) => setSuggestions({ draw })} />
              </>
            }
          >
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
                      covered={menu()}
                      onPresent={(on) => props.presenting.set(on)}
                      onFrame={setFrame}
                    />
                    {/* Words are changed in place only on the latest version: the hint shows only there, with the rail. */}
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
        <Scroll
          accessibilityLabel={t("web.artifact.page.rail")}
          testID="artifact-rail"
          class="max-h-80 shrink-0 border-t border-line xl:max-h-full xl:w-72 xl:border-t-0 xl:border-l"
          contentClass="gap-5 px-4 py-4"
        >
          {/* The written blocks' open suggestions (BlocksView). */}
          <If when={html() ? undefined : suggestions()}>{(s) => s().draw()}</If>
          <If when={framed()}>
            {(p) => <Keyed key={p().version}>{() => <PageWords artifact={props.artifact} version={untracked(p).version} frame={untracked(p).frame} />}</Keyed>}
          </If>
          {/* A list of one says nothing the head does not: the versions show once there is a second. */}
          <If when={html() && props.artifact.versions.length > 1}>
            <View class="gap-1.5">
              <Text role="header" class="text-xs font-semibold text-muted">
                {t("web.artifact.page.versions")}
              </Text>
              <View testID="artifact-versions" class="gap-0.5">
                <Each of={[...props.artifact.versions].reverse()} key={(v) => v.version}>
                  {(v) => (
                    <View
                      role="button"
                      testID={`artifact-version-${v().version}`}
                      accessibilityState={{ selected: v().version === version()?.version }}
                      onPress={() => pick(v().version)}
                      class={`w-full gap-0.5 rounded-md px-2.5 py-1.5 transition duration-120 ease-out ${v().version === version()?.version ? "bg-selected" : "hover:bg-hover"}`}
                    >
                      <View class="flex-row items-baseline gap-1">
                        <Text class="text-sm font-medium text-ink">{t("web.artifact.card.version", { version: v().version })}</Text>
                        <Text class="min-w-0 flex-1 truncate text-xs text-muted">{`· ${v().byName} · ${ago(v().at, now())}`}</Text>
                      </View>
                      <If when={v().note}>{(note) => <Text class="text-xs text-muted">{note()}</Text>}</If>
                    </View>
                  )}
                </Each>
              </View>
            </View>
          </If>
          <If
            when={said()}
            else={
              <Text testID="artifact-unsaid" class="text-xs text-faint">
                {t("web.artifact.talk.none")}
              </Text>
            }
          >
            {(at) => (
              <View class="gap-1.5">
                <View class="flex-row items-center justify-between">
                  <Text role="header" class="text-xs font-semibold text-muted">
                    {version() ? t("web.artifact.talk.replyVersion") : t("web.artifact.talk.reply")}
                  </Text>
                  <A href={messageHref(at())} testID="artifact-message" class="group flex-row items-center gap-1">
                    <Icon name="chat" size={12} tone="muted" />
                    <Text class="text-xs text-muted group-hover:text-ink">{t("web.artifact.talk.atMessage")}</Text>
                  </A>
                </View>
                <Reply at={at()} version={version()} say={props.say} />
              </View>
            )}
          </If>
        </Scroll>
      </If>
    </View>
  );
}

/** A reply under the message that announced it (or the version shown): what its maker is woken with. ⌘Return sends (a
 * keymap binding while the box has the focus). */
function Reply(props: { at: { readonly channel: string; readonly number?: number }; version?: ArtifactVersion | undefined; say: ChatSay }) {
  const text = signal("");
  const busy = signal(false);
  const focused = signal(false);
  const says = useIntents(untracked(() => props.say));
  const send = async () => {
    const words = text().trim();
    if (!words || busy()) return;
    busy.set(true);
    const end = await sendOnce(says, { id: props.at.channel, text: words, ...(props.at.number !== undefined ? { replyTo: props.at.number } : {}) });
    busy.set(false);
    if (end?.phase === "failed") return toast(end.fault.reason, "bad");
    text.set("");
    toast(props.version ? t("web.artifact.talk.sentVersion", { version: props.version.version }) : t("web.artifact.talk.sent"));
  };
  effect(() => {
    if (!focused()) return;
    return keymap.bind("mod+enter", () => void send(), { when: "always" });
  });
  return (
    <View class="gap-2">
      <TextArea
        testID="artifact-reply"
        accessibilityLabel={props.version ? t("web.artifact.talk.replyVersion") : t("web.artifact.talk.reply")}
        placeholder={t("web.artifact.talk.replyHint")}
        rows={3}
        value={text()}
        onInput={(v) => text.set(v)}
        onFocus={() => focused.set(true)}
        onBlur={() => focused.set(false)}
      />
      <Button tone="primary" icon="reply" disabled={!text().trim() || busy()} testID="artifact-send" class="self-end" onPress={() => void send()}>
        {t("web.artifact.talk.send")}
      </Button>
    </View>
  );
}
