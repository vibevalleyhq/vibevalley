// 产出 (docs/subsystems/artifact.md): every artifact on the left, newest change first, found by its title; the one open on
// the right, written block by block or looked at as a page, with its versions and a reply that reaches its maker.

import { createMemo, createSignal, For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Artifact, type ArtifactVersion, artifactPath, type SayRequest } from "@vibevalley/protocol";

import { ago } from "@/base/format";
import { Keyed, useNow } from "@/base/util";
import { api, reasonOf } from "@/infra/api";
import { useCore } from "@/infra/frame";
import { queries, ready } from "@/infra/query";
import { useRouter, useSearch } from "@/infra/router";
import { type IntentType, sendOnce, useIntents } from "@/state/intent";
import { A } from "@/ui/A";
import { createAct } from "@/ui/act";
import { Button } from "@/ui/Button";
import { Empty } from "@/ui/Empty";
import { TextArea } from "@/ui/Field";
import { Icon } from "@/ui/Icon";
import { type MoreItem, MoreMenu } from "@/ui/MoreMenu";
import { Tag } from "@/ui/Tag";
import { toast } from "@/ui/toasts";

import { bodyIcon, bodyLabel } from "./ArtifactCard";
import { BlocksView } from "./BlocksView";
import type { BlockEditor } from "./editor";
import { artifactHref, useArtifact, useArtifacts } from "./queries";

/** What a page in the frame may do: run its scripts and open links in a tab of their own. Never allow-same-origin: it
 * would be the farm's own page. The server's header says the same (artifact/policy.ts). */
const sandbox = "allow-scripts allow-popups allow-popups-to-escape-sandbox";

const messageHref = (at: { readonly channel: string; readonly number?: number }) =>
  at.number !== undefined ? `/chat/${at.channel}?m=${at.number}` : `/chat/${at.channel}`;

/** The one just made with 新建: its title is selected to be typed over when it opens. */
const [justMade, setJustMade] = createSignal<string>();

/** `rest` is the path after /artifacts/. */
/** The owner's lines in a channel (features/channel's chatSay), given by app/: the channel feature shows artifacts, so this
 * one does not import it back. */
export type ChatSay = IntentType<Omit<SayRequest, "sendKey">, void>;

export function ArtifactsPage(props: { rest: string; say: ChatSay }) {
  const router = useRouter();
  const now = useNow();
  const all = useArtifacts(() => ({}));
  const [query, setQuery] = createSignal("");
  const list = () => ready(all, []);
  const shown = () => {
    const q = query().trim().toLowerCase();
    return q ? list().filter((a) => a.title.toLowerCase().includes(q)) : list();
  };
  const id = () => (props.rest ? decodeURIComponent(props.rest) : undefined);
  const open = () => id() ?? list()[0]?.id;
  const making = createAct();
  const create = () =>
    making.run(async () => {
      const made = await api.artifact.create({ title: t("web.artifact.page.untitled") });
      setJustMade(made.id);
      await queries.invalidateQueries({ queryKey: ["artifacts"] });
      router.navigate(artifactHref(made.id));
    });
  return (
    <div class="flex h-full min-h-0 flex-col gap-3 p-3 lg:flex-row">
      <nav
        aria-label={t("web.artifact.page.list")}
        data-testid="artifact-list"
        class={[id() ? "hidden lg:flex" : "flex", "min-h-0 shrink-0 flex-col gap-2 rounded-lg border border-line bg-page p-2 lg:w-72"]}
      >
        <div class="flex gap-1.5">
          <label class="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-line bg-page px-2 focus-within:border-focus">
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
          <Button tone="primary" icon="add" data-testid="new-artifact" disabled={making.busy()} onClick={() => void create()}>
            {t("web.artifact.page.new")}
          </Button>
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
        <ul class="-mx-2 flex min-h-0 scroll-fade-y flex-col gap-0.5 overflow-y-auto px-2">
          <For each={shown()} keyed={(a) => a.id}>
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
                    <span class="truncate text-xs text-muted">
                      {a().byName} · {ago(a().updated, now())}
                    </span>
                  </span>
                </A>
              </li>
            )}
          </For>
        </ul>
      </nav>
      <div class={[id() ? "flex" : "hidden lg:flex", "min-h-0 min-w-0 flex-1 flex-col gap-2"]}>
        <Show when={id()}>
          <div class="lg:hidden">
            <Button icon="back" onClick={() => router.navigate("/artifacts")}>
              {t("web.artifact.page.all")}
            </Button>
          </div>
        </Show>
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
  const initialFresh = untrack(justMade) === untrack(() => props.artifact.id);
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
            setJustMade(undefined);
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
  return (
    <div
      data-testid="artifact"
      data-key={props.artifact.id}
      data-body={props.artifact.body}
      data-version={version()?.version}
      class="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row"
    >
      <section class="flex min-h-[70vh] min-w-0 flex-1 flex-col gap-3 lg:min-h-0 lg:pl-2">
        {/* A blocks one's header lines up with its text, past the gutter of faces and author bars (BlocksView). */}
        <header class={["flex flex-col gap-1 pt-1", html() ? "" : "lg:pl-[35px]"]}>
          <div class="flex items-center gap-2">
            <Title artifact={props.artifact} />
            <MoreMenu label={t("web.artifact.page.more")} testid="artifact-more" items={more()} />
          </div>
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <Tag label={bodyLabel[props.artifact.body]} tone="wait" />
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
        <Show when={html() ? version() : undefined} fallback={<BlocksView id={props.artifact.id} onEditor={(e) => (editor = e)} />}>
          {(v) => (
            <iframe
              data-testid="artifact-frame"
              title={t("web.artifact.page.frame", { title: props.artifact.title, version: v().version })}
              src={artifactPath(props.artifact.id, v().version)}
              sandbox={sandbox}
              referrerpolicy="no-referrer"
              class="min-h-0 w-full flex-1 rounded-lg border border-line bg-page"
            />
          )}
        </Show>
      </section>
      <Show when={html() || said()}>
        <aside class="flex shrink-0 flex-col gap-4 border-line lg:w-72 lg:border-l lg:pl-4">
          <Show when={html()}>
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
          <Show when={said()}>
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
