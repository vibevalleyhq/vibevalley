import { Schema } from "effect";
import { createMemo, createSignal, For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Artifact, type ArtifactVersion, artifactPath, ownerId, type SayRequest } from "@vibevalley/protocol";
import { htmlSandbox } from "@vibevalley/protocol/rules";

import { Keyed, useNow } from "#/base/dom.tsx";
import { ago } from "#/base/format.ts";
import { spelled } from "#/base/search.ts";
import { api, reasonOf } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { queries, ready } from "#/infra/query.ts";
import { useRouter, useSearch } from "#/infra/router.ts";
import { defineAtom } from "#/state/atom.ts";
import { type IntentType, sendOnce, useIntents } from "#/state/intent.ts";
import { defineStored } from "#/state/stored.ts";
import { A } from "#/ui/A.tsx";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { TextArea } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { IconButton } from "#/ui/IconButton.tsx";
import { Empty } from "#/ui/layout.tsx";
import { type MoreItem, MoreMenu } from "#/ui/MoreMenu.tsx";
import { toast } from "#/ui/toasts.ts";

import { artifactHref, bodyIcon, useArtifact, useArtifacts } from "./ArtifactCard";
import { BlocksView } from "./BlocksView";
import type { BlockEditor } from "./editor";
import { PageWords } from "./PageWords";
import { shellPath } from "./shell";

const messageHref = (at: { readonly channel: string; readonly number?: number }) =>
  at.number !== undefined ? `/chat/${at.channel}?m=${at.number}` : `/chat/${at.channel}`;

const rail = defineStored("artifact.rail", Schema.Boolean, true);

/** The one just made with New: its title is selected to be typed over when it opens. */
const justMade = defineAtom<string | undefined>(undefined);

/** `rest` is the path after /artifacts/. */
/** The owner's lines in a channel (features/channel's chatSay), given by app/: the channel feature shows artifacts, so this
 * one does not import it back. */
type ChatSay = IntentType<Omit<SayRequest, "sendKey">, void>;

export function ArtifactsPage(props: { rest: string; say: ChatSay }) {
  const router = useRouter();
  const now = useNow();
  const all = useArtifacts(() => ({}));
  const [query, setQuery] = createSignal("");
  const list = () => ready(all, []);
  const shown = () => {
    const q = query().trim().toLowerCase();
    return q ? list().filter((a) => spelled(a.title, q)) : list();
  };
  const id = () => (props.rest ? decodeURIComponent(props.rest) : undefined);
  const open = () => id() ?? list()[0]?.id;
  const making = createAct();
  const create = () =>
    making.run(async () => {
      const made = await api.artifact.create({ title: t("web.artifact.page.untitled"), kind: "markdown" });
      justMade.set(made.id);
      await queries.invalidateQueries({ queryKey: ["artifacts"] });
      router.navigate(artifactHref(made.id));
    });
  const groups = () => {
    const list = shown();
    return [
      { key: "delivered", rows: list.filter((a) => a.by !== ownerId) },
      { key: "mine", rows: list.filter((a) => a.by === ownerId) },
    ] as const;
  };
  const [shut, setShut] = createSignal<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setShut((was) => {
      const next = new Set(was);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <div class="flex h-full min-h-0 flex-col lg:flex-row">
      <nav
        aria-label={t("web.artifact.page.list")}
        data-testid="artifact-list"
        class={[id() ? "hidden lg:flex" : "flex", "min-h-0 shrink-0 flex-col gap-3 border-line bg-side p-3 lg:w-64 lg:border-r"]}
      >
        <div class="flex gap-1.5">
          <label class="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-line bg-page px-2 focus-within:border-focus">
            <Icon name="search" size={14} class="shrink-0 text-muted" />
            <input
              data-testid="artifact-search"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              placeholder={t("web.artifact.page.find")}
              aria-label={t("web.artifact.page.find")}
              class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
            />
          </label>
          {/* Beside the search, not a green button over the page being read: a new one is not what this page is for. */}
          <IconButton icon="add" label={t("web.artifact.page.new")} testid="new-artifact" disabled={making.busy()} onClick={() => void create()} />
        </div>
        <Show when={all.error}>
          <p class="px-2 text-xs text-berry">{reasonOf(all.error)}</p>
        </Show>
        <Show when={all.isSuccess && list().length === 0}>
          <p class="px-2 text-xs text-muted lg:hidden">{t("web.artifact.page.none")}</p>
        </Show>
        <Show when={list().length > 0 && shown().length === 0}>
          <p class="px-2 text-xs text-muted">{t("web.artifact.page.nothingFound")}</p>
        </Show>
        <div class="-mx-2 flex min-h-0 scroll-fade-y flex-col gap-2 overflow-y-auto px-2">
          <For each={groups().filter((g) => g.rows.length > 0)}>
            {(g) => (
              <section data-testid="artifact-group" data-key={g.key} class="flex flex-col gap-0.5">
                <button
                  type="button"
                  aria-expanded={shut().has(g.key) ? "false" : "true"}
                  onClick={() => toggle(g.key)}
                  class="flex cursor-pointer items-center gap-1 px-1 pt-1 text-xs font-semibold text-muted hover:text-ink"
                >
                  <Icon name={shut().has(g.key) ? "expand" : "choose"} size={12} />
                  {t(`web.artifact.page.group.${g.key}`)}
                  <span class="font-normal text-faint">{g.rows.length}</span>
                </button>
                <Show when={!shut().has(g.key)}>
                  <ul class="flex flex-col gap-0.5">
                    <For each={g.rows} keyed={(a) => a.id}>
                      {(a) => (
                        <li>
                          <A
                            href={artifactHref(a().id)}
                            data-testid="artifact-row"
                            data-key={a().id}
                            data-body={a().body}
                            aria-current={a().id === open() ? "page" : undefined}
                            class={[
                              "flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors duration-120",
                              // With no address, the first is open only where there is room to show it beside the list.
                              a().id === id() ? "bg-selected" : a().id === open() ? "hover:bg-hover lg:bg-selected" : "hover:bg-hover",
                            ]}
                          >
                            <Icon name={bodyIcon[a().body]} size={16} class="mt-0.5 shrink-0 text-muted" />
                            <span class="flex min-w-0 flex-col">
                              <span class="truncate text-sm font-medium">{a().title}</span>
                              {/* On the selected row's darker ground the line takes more ink, to stay readable. */}
                              <span class={["truncate text-xs", a().id === open() ? "text-ink/75" : "text-muted"]}>
                                {a().byName} · {ago(a().updated, now())}
                              </span>
                            </span>
                          </A>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </section>
            )}
          </For>
        </div>
      </nav>
      <div class={[id() ? "flex" : "hidden lg:flex", "min-h-0 min-w-0 flex-1 flex-col"]}>
        <Show
          when={open()}
          fallback={
            <Show when={all.isSuccess}>
              <Empty
                icon="artifacts"
                action={
                  <Button icon="add" disabled={making.busy()} onClick={() => void create()}>
                    {t("web.artifact.page.new")}
                  </Button>
                }
              >
                {t("web.artifact.page.none")}
              </Empty>
            </Show>
          }
        >
          {(o) => <Keyed key={o()}>{() => <Opened id={o()} say={props.say} />}</Keyed>}
        </Show>
      </div>
    </div>
  );
}

function Opened(props: { id: string; say: ChatSay }) {
  const found = useArtifact(() => props.id);
  return (
    <Show
      when={ready(found, undefined)}
      fallback={
        <Show when={found.isError}>
          <Empty icon="artifacts">{t("web.artifact.page.gone")}</Empty>
        </Show>
      }
    >
      {(a) => <Shown artifact={a()} say={props.say} />}
    </Show>
  );
}

/** The title, typed over in place: Enter or leaving it renames, Escape puts it back. */
function Title(props: { artifact: Artifact }) {
  const [text, setText] = createSignal(untrack(() => props.artifact.title));
  // Taken while the component is made: a ref runs where the props may not be read yet.
  const initialFresh = untrack(justMade.get) === untrack(() => props.artifact.id);
  let field!: HTMLInputElement;
  const act = createAct();
  const save = async () => {
    const title = text().trim();
    const id = props.artifact.id;
    if (!title || title === props.artifact.title) {
      setText(props.artifact.title);
      return;
    }
    const done = await act.run(async () => {
      await api.artifact.update({ id, title });
      void queries.invalidateQueries({ queryKey: ["artifacts"] });
      return true;
    });
    if (done !== true) setText(props.artifact.title);
  };
  return (
    <input
      ref={(el) => {
        field = el;
        if (initialFresh)
          queueMicrotask(() => {
            justMade.set(undefined);
            field.focus();
            field.select();
          });
      }}
      data-testid="artifact-title"
      aria-label={t("web.artifact.page.title")}
      value={text()}
      maxlength={80}
      onInput={(e) => setText(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.isComposing) return;
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setText(props.artifact.title);
          e.currentTarget.blur();
        }
      }}
      onBlur={() => void save()}
      class="-mx-1 min-w-0 flex-1 truncate rounded-md bg-transparent px-1 text-xl leading-8 font-semibold outline-none hover:bg-hover focus:bg-hover"
    />
  );
}

function Shown(props: { artifact: Artifact; say: ChatSay }) {
  const search = useSearch();
  const router = useRouter();
  const core = useCore();
  const now = useNow();
  const [asking, setAsking] = createSignal(false);
  const html = () => props.artifact.body === "html";
  const asked = () => Number(search().get("v"));
  const version = createMemo(() => props.artifact.versions.find((v) => v.version === asked()) ?? props.artifact.versions.at(-1));
  const issue = () => (props.artifact.issue ? (core()?.issues ?? []).find((i) => i.id === props.artifact.issue) : undefined);
  /** Where its comments are: the version shown, else where it was first said. */
  const said = () => version() ?? props.artifact.said;
  const pick = (n: number) => router.navigate(artifactHref(props.artifact.id, n === props.artifact.version ? undefined : n), { replace: true });
  const copyLink = async () => {
    await navigator.clipboard.writeText(location.origin + artifactHref(props.artifact.id));
    toast(t("web.artifact.page.copied"));
  };
  const removing = createAct();
  const remove = () => {
    const { id, title } = props.artifact;
    return removing.run(async () => {
      await api.artifact.delete({ id });
      // Away first: refreshed, this view's own read fails and it is gone before it could move on.
      router.navigate("/artifacts");
      toast(t("web.artifact.page.deleted", { title }));
      void queries.invalidateQueries({ queryKey: ["artifacts"] });
    });
  };
  const openTab = () => {
    const v = version();
    if (v) window.open(artifactPath(props.artifact.id, v.version), "_blank", "noopener");
  };
  let editor: BlockEditor | undefined;
  const demo = () => void editor?.demo();
  const more = (): MoreItem[] => [
    ...(html() ? [{ key: "open", label: t("web.artifact.page.open"), icon: "open" as const, onSelect: openTab }] : []),
    { key: "copy-link", label: t("web.artifact.page.copyLink"), icon: "copy", onSelect: () => void copyLink() },
    ...(html() ? [] : [{ key: "demo", label: t("web.artifact.blocks.demo"), icon: "play" as const, onSelect: demo }]),
    { key: "delete", label: t("web.artifact.page.delete"), icon: "delete", danger: true, onSelect: () => setAsking(true) },
  ];
  const [suggestionsAt, setSuggestionsAt] = createSignal<HTMLElement>();
  const [frame, setFrame] = createSignal<HTMLIFrameElement>();
  /** The version on show and the frame it is in, for PageWords: only when the page is html and both are there. */
  const framed = () => {
    const v = version();
    const f = frame();
    return html() && v && f ? { version: v.version, frame: f } : undefined;
  };
  return (
    <div
      data-testid="artifact"
      data-key={props.artifact.id}
      data-body={props.artifact.body}
      data-version={version()?.version}
      class="flex min-h-0 flex-1 flex-col overflow-y-auto xl:flex-row xl:overflow-hidden"
    >
      <section class="flex min-h-[70vh] min-w-0 flex-1 flex-col px-4 py-4 xl:min-h-0">
        {/* A page is shown as wide as there is room; written blocks read in a column. */}
        <div class={["flex min-h-0 w-full flex-1 flex-col gap-3", html() ? "" : "mx-auto max-w-3xl"]}>
          <div class="lg:hidden">
            <Button icon="back" onClick={() => router.navigate("/artifacts")}>
              {t("web.artifact.page.all")}
            </Button>
          </div>
          {/* A blocks one's header lines up with its text, past the gutter of faces and author bars (BlocksView). */}
          <header class={["flex flex-col gap-1", html() ? "" : "lg:pl-[35px]"]}>
            <div class="flex items-center gap-2">
              <Title artifact={props.artifact} />
              <IconButton
                icon="thread"
                label={rail.get() ? t("web.artifact.page.railHide") : t("web.artifact.page.railShow")}
                testid="artifact-rail-toggle"
                pressed={rail.get()}
                onClick={() => rail.update((on) => !on)}
              />
              <MoreMenu label={t("web.artifact.page.more")} testid="artifact-more" items={more()} />
            </div>
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              <Show when={html() ? version() : undefined}>
                {(v) => (
                  <>
                    <span data-testid="artifact-shown-version">{t("web.artifact.card.version", { version: v().version })}</span>
                    <span aria-hidden="true">·</span>
                  </>
                )}
              </Show>
              <span>{t("web.artifact.page.by", { name: props.artifact.byName })}</span>
              <span aria-hidden="true">·</span>
              <span>{t("web.artifact.page.updated", { when: ago(props.artifact.updated, now()) })}</span>
              <Show when={issue()}>
                {(i) => (
                  <>
                    <span aria-hidden="true">·</span>
                    <A href={`/issues/${i().id}`} data-testid="artifact-issue" class="text-water hover:underline">
                      {t("web.artifact.page.forIssue", { number: i().number })}
                    </A>
                  </>
                )}
              </Show>
            </div>
            <Show when={asking()}>
              <div
                role="group"
                data-testid="artifact-delete"
                class="mt-2 flex animate-fade-in flex-wrap items-center gap-2 rounded-md bg-bad-soft px-3 py-2"
                onKeyDown={(e) => e.key === "Escape" && setAsking(false)}
              >
                <span class="min-w-0 flex-1 text-sm text-berry">{t("web.artifact.page.deleteAsk", { title: props.artifact.title })}</span>
                <Button
                  tone="danger"
                  icon="delete"
                  data-testid="artifact-delete-sure"
                  ref={(el) => queueMicrotask(() => el.focus())}
                  onClick={() => void remove()}
                >
                  {t("web.artifact.page.delete")}
                </Button>
                <Button onClick={() => setAsking(false)}>{t("web.base.form.never")}</Button>
              </div>
            </Show>
          </header>
          <Show
            when={html() ? version() : undefined}
            fallback={<BlocksView id={props.artifact.id} onEditor={(e) => (editor = e)} suggestionsAt={rail.get() ? suggestionsAt() : undefined} />}
          >
            {(v) => (
              <>
                <iframe
                  ref={setFrame}
                  data-testid="artifact-frame"
                  title={t("web.artifact.page.frame", { title: props.artifact.title, version: v().version })}
                  src={shellPath(props.artifact.id, v().version)}
                  sandbox={htmlSandbox}
                  referrerpolicy="no-referrer"
                  class="min-h-[60vh] w-full flex-1 rounded-lg border border-line bg-page xl:min-h-0"
                />
                {/* Words are changed in place only on the latest version: the hint shows only there, with the rail. */}
                <Show when={rail.get() && v().version === props.artifact.version}>
                  <p class="text-xs text-faint">{t("web.artifact.edit.hint")}</p>
                </Show>
              </>
            )}
          </Show>
        </div>
      </section>
      <Show when={rail.get()}>
        <aside
          aria-label={t("web.artifact.page.rail")}
          data-testid="artifact-rail"
          class="flex shrink-0 flex-col gap-5 border-t border-line px-4 py-4 xl:w-72 xl:overflow-y-auto xl:border-t-0 xl:border-l"
        >
          {/* The written blocks' open suggestions are drawn here (BlocksView). */}
          <div ref={setSuggestionsAt} class="empty:hidden" />
          <Show when={framed()}>
            {(p) => <Keyed key={p().version}>{() => <PageWords artifact={props.artifact} version={p().version} frame={p().frame} />}</Keyed>}
          </Show>
          {/* A list of one says nothing the head does not: the versions show once there is a second. */}
          <Show when={html() && props.artifact.versions.length > 1}>
            <div class="flex flex-col gap-1.5">
              <h2 class="text-xs font-semibold text-muted">{t("web.artifact.page.versions")}</h2>
              <ol data-testid="artifact-versions" class="flex flex-col gap-0.5">
                <For each={[...props.artifact.versions].toReversed()} keyed={(v) => v.version}>
                  {(v) => (
                    <li>
                      <button
                        type="button"
                        data-key={v().version}
                        aria-pressed={v().version === version()?.version ? "true" : "false"}
                        onClick={() => pick(v().version)}
                        class={[
                          "flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left transition-colors duration-120",
                          v().version === version()?.version ? "bg-selected" : "hover:bg-hover",
                        ]}
                      >
                        <span class="text-sm font-medium">
                          {t("web.artifact.card.version", { version: v().version })}{" "}
                          <span class="text-xs font-normal text-muted">
                            · {v().byName} · {ago(v().at, now())}
                          </span>
                        </span>
                        <Show when={v().note}>{(note) => <span class="text-xs text-muted">{note()}</span>}</Show>
                      </button>
                    </li>
                  )}
                </For>
              </ol>
            </div>
          </Show>
          <Show
            when={said()}
            fallback={
              <p data-testid="artifact-unsaid" class="text-xs text-faint">
                {t("web.artifact.talk.none")}
              </p>
            }
          >
            {(at) => (
              <div class="flex flex-col gap-1.5">
                <div class="flex items-center justify-between">
                  <h2 class="text-xs font-semibold text-muted">{version() ? t("web.artifact.talk.replyVersion") : t("web.artifact.talk.reply")}</h2>
                  <A href={messageHref(at())} data-testid="artifact-message" class="inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
                    <Icon name="chat" size={12} />
                    {t("web.artifact.talk.atMessage")}
                  </A>
                </div>
                <Reply at={at()} version={version()} say={props.say} />
              </div>
            )}
          </Show>
        </aside>
      </Show>
    </div>
  );
}

/** A reply under the message that announced it (or the version shown): what its maker is woken with. */
function Reply(props: { at: { readonly channel: string; readonly number?: number }; version?: ArtifactVersion | undefined; say: ChatSay }) {
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const says = useIntents(untrack(() => props.say));
  const send = async () => {
    const words = text().trim();
    if (!words || busy()) return;
    setBusy(true);
    const end = await sendOnce(says, { id: props.at.channel, text: words, ...(props.at.number !== undefined ? { replyTo: props.at.number } : {}) });
    setBusy(false);
    if (end?.status === "failed") return toast(end.reason ?? "", "bad");
    setText("");
    toast(props.version ? t("web.artifact.talk.sentVersion", { version: props.version.version }) : t("web.artifact.talk.sent"));
  };
  return (
    <form
      class="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <TextArea
        data-testid="artifact-reply"
        aria-label={props.version ? t("web.artifact.talk.replyVersion") : t("web.artifact.talk.reply")}
        placeholder={t("web.artifact.talk.replyHint")}
        rows={3}
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <Button type="submit" tone="primary" icon="reply" disabled={!text().trim() || busy()} data-testid="artifact-send" class="self-end">
        {t("web.artifact.talk.send")}
      </Button>
    </form>
  );
}
