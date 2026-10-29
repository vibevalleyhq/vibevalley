import { t } from "@vibevalley/i18n";
// 产出 (docs/subsystems/artifact.md): every artifact on the left, newest change first, and a new one to write in; the one
// open on the right, written block by block or looked at as a page, with its versions and a reply that reaches its maker.

import { type Artifact, type ArtifactVersion, artifactPath } from "@vibevalley/protocol";
import { createMemo, createSignal, For, Show } from "solid-js";
import { api, reasonOf } from "../../base/api";
import { ago } from "../../base/format";
import { useCore } from "../../base/frame";
import { queries, ready } from "../../base/query";
import { useRouter, useSearch } from "../../base/router";
import { Keyed, useNow } from "../../base/util";
import { A } from "../../ui/A";
import { Button } from "../../ui/Button";
import { ConfirmButton } from "../../ui/ConfirmButton";
import { Empty } from "../../ui/Empty";
import { TextArea, TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { OutLink } from "../../ui/IconButton";
import { Tag } from "../../ui/Tag";
import { toast } from "../../ui/toasts";
import { BlocksView } from "./BlocksView";
import { bodyIcon, bodyLabel } from "./ArtifactCard";
import { artifactHref, useArtifact, useArtifacts } from "./data";

/** What a page in the frame may do: run its scripts and open links in a tab of their own. Never allow-same-origin: it
 * would be the farm's own page. The server's header says the same (artifact/rules.ts). */
const sandbox = "allow-scripts allow-popups allow-popups-to-escape-sandbox";

const messageHref = (at: { readonly channel: string; readonly number?: number }) =>
  at.number !== undefined ? `/chat/${at.channel}?m=${at.number}` : `/chat/${at.channel}`;

/** `rest` is the path after /artifacts/. */
export function ArtifactsPage(props: { rest: string }) {
  const router = useRouter();
  const now = useNow();
  const all = useArtifacts(() => ({}));
  const list = () => ready(all, []);
  const id = () => (props.rest ? decodeURIComponent(props.rest) : undefined);
  const open = () => id() ?? list()[0]?.id;
  const [title, setTitle] = createSignal("");
  const [problem, setProblem] = createSignal<string>();
  const create = async () => {
    try {
      const made = await api.artifact.create({ title: title() });
      setTitle("");
      setProblem(undefined);
      await queries.invalidateQueries({ queryKey: ["artifacts"] });
      router.navigate(artifactHref(made.id));
    } catch (e) {
      setProblem(reasonOf(e));
    }
  };
  return (
    <div class="flex h-full min-h-0 flex-col gap-3 p-3 lg:flex-row">
      <nav
        aria-label={t("web.artifact.page.list")}
        data-testid="artifact-list"
        class={[id() ? "hidden lg:flex" : "flex", "shrink-0 flex-col gap-2 rounded-lg border border-line bg-page p-2 lg:w-72 lg:overflow-y-auto"]}
      >
        <form
          class="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <TextInput
            data-testid="new-artifact-title"
            aria-label={t("web.artifact.page.newTitle")}
            placeholder={t("web.artifact.page.newTitle")}
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
          />
          <Button type="submit" tone="primary" icon="add" data-testid="new-artifact">
            {t("web.artifact.page.new")}
          </Button>
        </form>
        <Show when={problem() || all.error}>
          <p class="px-2 text-xs text-berry">{problem() ?? reasonOf(all.error)}</p>
        </Show>
        <Show when={all.isSuccess && list().length === 0}>
          <p class="px-2 text-xs text-muted lg:hidden">{t("web.artifact.page.none")}</p>
        </Show>
        <ul class="flex flex-col gap-0.5">
          <For each={list()} keyed={(a) => a.id}>
            {(a) => (
              <li>
                <A
                  href={artifactHref(a().id)}
                  data-testid="artifact-row"
                  data-key={a().id}
                  data-body={a().body}
                  aria-current={a().id === open() ? "page" : undefined}
                  class={["flex items-start gap-2 rounded-md px-2 py-1.5", a().id === open() ? "bg-selected" : "hover:bg-hover"]}
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
              <Empty icon="artifacts">{t("web.artifact.page.none")}</Empty>
            </Show>
          }
        >
          {(o) => <Keyed key={o()}>{() => <Opened id={o()} />}</Keyed>}
        </Show>
      </div>
    </div>
  );
}

function Opened(props: { id: string }) {
  const found = useArtifact(() => props.id);
  return (
    <Show when={ready(found, undefined)} fallback={<Show when={found.isError}>{<Empty icon="artifacts">{t("web.artifact.page.gone")}</Empty>}</Show>}>
      {(a) => <Shown artifact={a()} />}
    </Show>
  );
}

function Shown(props: { artifact: Artifact }) {
  const search = useSearch();
  const router = useRouter();
  const core = useCore();
  const now = useNow();
  const html = () => props.artifact.body === "html";
  const asked = () => Number(search().get("v"));
  const version = createMemo(() => props.artifact.versions.find((v) => v.version === asked()) ?? props.artifact.versions.at(-1));
  const issue = () => (props.artifact.issue ? (core()?.issues ?? []).find((i) => i.id === props.artifact.issue) : undefined);
  /** Where its comments are: the version shown, else where it was first said. */
  const said = () => version() ?? props.artifact.said;
  const pick = (n: number) => router.navigate(artifactHref(props.artifact.id, n === props.artifact.version ? undefined : n), { replace: true });
  const remove = async () => {
    try {
      const title = props.artifact.title;
      await api.artifact.delete({ id: props.artifact.id });
      // Away first: refreshed, this view's own read fails and it is gone before it could move on.
      router.navigate("/artifacts");
      toast(t("web.artifact.page.deleted", { title }));
      void queries.invalidateQueries({ queryKey: ["artifacts"] });
    } catch (e) {
      toast(reasonOf(e), "bad");
    }
  };
  return (
    <div
      data-testid="artifact"
      data-key={props.artifact.id}
      data-body={props.artifact.body}
      data-version={version()?.version}
      class="flex min-h-0 flex-1 flex-col gap-3 rounded-lg border border-line bg-page p-4 lg:flex-row"
    >
      <section class="flex min-h-[70vh] min-w-0 flex-1 flex-col gap-3 lg:min-h-0">
        <header class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 class="min-w-0 truncate text-xl font-semibold">{props.artifact.title}</h1>
          <Tag label={bodyLabel[props.artifact.body]} tone="wait" />
          <span class="text-xs text-muted">
            {t("web.artifact.page.by", { name: props.artifact.byName })} · {t("web.artifact.page.updated", { when: ago(props.artifact.updated, now()) })}
          </span>
          <Show when={issue()}>
            {(i) => (
              <A href={`/issues/${i().id}`} data-testid="artifact-issue" class="text-xs text-water hover:underline">
                {t("web.artifact.page.forIssue", { number: i().number })}
              </A>
            )}
          </Show>
          <span class="flex-1" />
          <Show when={html() ? version() : undefined}>
            {(v) => <OutLink href={artifactPath(props.artifact.id, v().version)} label={t("web.artifact.page.open")} />}
          </Show>
          <ConfirmButton
            label={t("web.artifact.page.delete")}
            question={t("web.artifact.page.deleteAsk")}
            tone="danger"
            icon="delete"
            testid="artifact-delete"
            onConfirm={remove}
          />
        </header>
        <Show when={html() ? version() : undefined} fallback={<BlocksView id={props.artifact.id} />}>
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
        <aside class="flex shrink-0 flex-col gap-3 lg:w-72">
          <Show when={html()}>
            <h2 class="text-xs font-semibold text-muted">{t("web.artifact.page.versions")}</h2>
            <ol data-testid="artifact-versions" class="flex flex-col gap-1">
              <For each={[...props.artifact.versions].reverse()} keyed={(v) => v.version}>
                {(v) => (
                  <li>
                    <button
                      type="button"
                      data-key={v().version}
                      aria-pressed={v().version === version()?.version ? "true" : "false"}
                      onClick={() => pick(v().version)}
                      class={[
                        "flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left",
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
          </Show>
          <Show when={said()}>
            {(at) => (
              <>
                <A href={messageHref(at())} data-testid="artifact-message" class="inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
                  <Icon name="chat" size={12} />
                  {t("web.artifact.talk.atMessage")}
                </A>
                <Reply at={at()} version={version()} />
              </>
            )}
          </Show>
        </aside>
      </Show>
    </div>
  );
}

/** A reply under the message that announced it (or the version shown): what its maker is woken with. */
function Reply(props: { at: { readonly channel: string; readonly number?: number }; version?: ArtifactVersion }) {
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const send = async () => {
    const words = text().trim();
    if (!words || busy()) return;
    setBusy(true);
    try {
      await api.channel.message.send({ id: props.at.channel, text: words, ...(props.at.number !== undefined ? { replyTo: props.at.number } : {}) });
      setText("");
      toast(props.version ? t("web.artifact.talk.sentVersion", { version: props.version.version }) : t("web.artifact.talk.sent"));
    } catch (e) {
      toast(reasonOf(e), "bad");
    } finally {
      setBusy(false);
    }
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
      />
      <Button type="submit" tone="primary" icon="reply" disabled={!text().trim() || busy()} data-testid="artifact-send" class="self-end">
        {t("web.artifact.talk.send")}
      </Button>
    </form>
  );
}
