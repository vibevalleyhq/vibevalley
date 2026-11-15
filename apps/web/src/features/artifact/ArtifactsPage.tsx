import type { JSX } from "@solidjs/web";
import { type Accessor, createMemo, createSignal, For, Show, untrack } from "solid-js";
import { z } from "zod";

import type { BlockEditor } from "@vibevalley/artifact/editor";
import { t } from "@vibevalley/i18n";
import { type Artifact, type ArtifactVersion, artifactPath, userId } from "@vibevalley/protocol";

import { Keyed, useNow } from "#/base/dom.tsx";
import { ago } from "#/base/format.ts";
import { spelled } from "#/base/search.ts";
import { api, reasonOf } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { useQueryClient, ready } from "#/infra/query.ts";
import { useRouter, useSearch, Link as A } from "#/infra/router.ts";
import { defineAtom } from "#/state/atom.ts";
import { defineStored } from "#/state/stored.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { IconButton } from "#/ui/IconButton.tsx";
import { Empty } from "#/ui/layout.tsx";
import { type MoreItem, MoreMenu } from "#/ui/MoreMenu.tsx";
import { Segmented } from "#/ui/Segmented.tsx";
import { toast } from "#/ui/toasts.ts";

import { artifactHref, artifactIcon, artifactSuffix, kindLabel, useArtifact, useArtifacts } from "./ArtifactCard";
import { BlocksView } from "./BlocksView";
import { CanvasInspector } from "./CanvasControls";
import type { Shown as FrameShown } from "./frame";
import { HtmlFrame } from "./HtmlFrame";
import { PageWords } from "./PageWords";

const listOpen = defineStored("artifact.list", z.boolean(), true);
const rail = defineStored("artifact.rail", z.boolean(), true);

/** The one just made with New: its title is selected to be typed over when it opens. */
const justMade = defineAtom<string | undefined>(undefined);

/** Provided by app/: channel shows artifacts, so artifact does not import channel back. */
type ArtifactChat = (props: { readonly channel?: string | undefined; readonly issue?: string | undefined; readonly point?: number | undefined }) => JSX.Element;

/** `rest` is the path after /artifacts/. */
export function ArtifactsPage(props: { rest: string; chat: ArtifactChat }) {
  const queries = useQueryClient();
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
      await queries.invalidate({ prefix: ["artifacts"] });
      router.navigate(artifactHref(made.id));
    });
  const groups = () => {
    const list = shown();
    return [
      { key: "delivered", rows: list.filter((a) => a.by !== userId) },
      { key: "mine", rows: list.filter((a) => a.by === userId) },
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
        class={[
          "min-h-0 shrink-0 flex-col gap-3 border-line bg-side p-3 lg:w-64 lg:[border-right-style:solid] lg:border-r",
          listOpen.get() ? (id() ? "hidden lg:flex" : "flex") : id() ? "hidden" : "flex lg:hidden",
        ]}
      >
        <div class="flex gap-1.5">
          <label class="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-line focus-within:border-focus bg-page px-2">
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
        <Show when={all.error()}>
          <p class="px-2 text-xs text-berry">{reasonOf(all.error())}</p>
        </Show>
        <Show when={all.status() === "success" && list().length === 0}>
          <p class="px-2 text-xs text-muted lg:hidden">{t("web.artifact.page.none")}</p>
        </Show>
        <Show when={list().length > 0 && shown().length === 0}>
          <p class="px-2 text-xs text-muted">{t("web.artifact.page.nothingFound")}</p>
        </Show>
        <div class="-mx-2 flex min-h-0 [mask-image:linear-gradient(to_bottom,_transparent,_black_var(--fade-top),_black_calc(100%_-_var(--fade-bottom)),_transparent)] [animation-name:scroll-fade-y] [animation-duration:0ms] [animation-timing-function:linear] [animation-fill-mode:both] [animation-timeline:scroll(self_y)] flex-col gap-2 overflow-y-auto px-2">
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
                              "flex items-start gap-2 rounded-md px-2 py-1.5 transition-[color,background-color,border-color] ease-out duration-120",
                              a().id === id() ? "bg-selected" : a().id === open() ? "hover:bg-hover lg:bg-selected" : "hover:bg-hover",
                            ]}
                          >
                            <Icon name={artifactIcon(a())} size={16} class="mt-0.5 shrink-0 text-muted" />
                            <span class="flex min-w-0 flex-col">
                              <span class="truncate text-sm font-medium">{a().title}</span>
                              {/* On the selected row's darker ground the line takes more ink, to stay readable. */}
                              <span class={["truncate text-xs", a().id === open() ? "text-ink/75" : "text-muted"]}>
                                {kindLabel(a())}
                                <span class="font-mono text-2xs"> ({artifactSuffix(a())})</span>
                                <Show when={a().body === "html"}> · {t("web.artifact.card.version", { version: a().version })}</Show>
                                {" · "}
                                {ago(a().updated, now())}
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
      <div class={["min-h-0 min-w-0 flex-1 flex-col", id() ? "flex" : "hidden lg:flex"]}>
        <Show
          when={open()}
          fallback={
            <Show when={all.status() === "success"}>
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
          {(o) => (
            <Keyed key={o()}>{() => <Opened id={o()} chat={props.chat} listOpen={listOpen.get()} onToggleList={() => listOpen.update((on) => !on)} />}</Keyed>
          )}
        </Show>
      </div>
    </div>
  );
}

function Opened(props: { id: string; chat: ArtifactChat; listOpen: boolean; onToggleList: () => void }) {
  const found = useArtifact(() => props.id);
  return (
    <Show
      when={ready(found, undefined)}
      fallback={
        <Show when={found.status() === "error"}>
          <Empty icon="artifacts">{t("web.artifact.page.gone")}</Empty>
        </Show>
      }
    >
      {(a) => <Shown artifact={a()} chat={props.chat} listOpen={props.listOpen} onToggleList={props.onToggleList} />}
    </Show>
  );
}

/** The title, typed over in place: Enter or leaving it renames, Escape puts it back. */
function Title(props: { artifact: Artifact }) {
  const queries = useQueryClient();
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
    const done = await act.run(() =>
      api.artifact.update({ id, title }).then(() => {
        void queries.invalidate({ prefix: ["artifacts"] });
        return true;
      }),
    );
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
      class="-mx-1 min-w-0 flex-1 truncate rounded-md bg-transparent hover:bg-hover focus:bg-hover px-1 text-xl leading-8 font-semibold outline-none"
    />
  );
}

function Shown(props: { artifact: Artifact; chat: ArtifactChat; listOpen: boolean; onToggleList: () => void }) {
  const queries = useQueryClient();
  const search = useSearch();
  const router = useRouter();
  const core = useCore();
  const now = useNow();
  const [asking, setAsking] = createSignal(false);
  const html = () => props.artifact.body === "html";
  const isCanvas = () => html() && (props.artifact.display === "canvas" || props.artifact.display === "dashboard" || props.artifact.display === "whiteboard");
  const asked = () => Number(search().get("v"));
  const version = createMemo((): ArtifactVersion | undefined => props.artifact.versions.find((v) => v.version === asked()) ?? props.artifact.versions.at(-1));
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
      void queries.invalidate({ prefix: ["artifacts"] });
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
  const [canvasShown, setCanvasShown] = createSignal<Accessor<FrameShown>>();
  const [railTab, setRailTab] = createSignal<"inspect" | "talk">("inspect");
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
      class="flex min-h-0 flex-1 flex-col xl:flex-row overflow-y-auto xl:overflow-y-hidden xl:overflow-x-hidden"
    >
      <section class="flex min-h-[70vh] xl:min-h-0 min-w-0 flex-[0_0_auto] xl:flex-1 flex-col px-4 py-4">
        {/* A page is shown as wide as there is room; written blocks read in a column. */}
        <div class={["flex min-h-0 w-full flex-1 flex-col gap-3", html() ? "" : "mx-auto max-w-3xl"]}>
          <div class="lg:hidden">
            <Button icon="back" onClick={() => router.navigate("/artifacts")}>
              {t("web.artifact.page.all")}
            </Button>
          </div>
          {/* A blocks one's header lines up with its text, past the gutter of faces and author bars (BlocksView). */}
          <header class={["flex flex-col gap-1", html() ? "" : "lg:pl-8.75"]}>
            <div class="flex items-center gap-2">
              <A
                href="/library"
                data-testid="artifact-back-library"
                class="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-line bg-page px-2 text-xs font-medium text-muted hover:bg-hover hover:text-ink transition-[color,background-color,border-color] duration-120 ease-out no-underline"
              >
                <Icon name="back" size={14} />
                {t("web.artifact.page.backToLibrary")}
              </A>
              <span class="hidden lg:inline-flex">
                <IconButton
                  icon={props.listOpen ? "previous" : "expand"}
                  label={props.listOpen ? t("web.artifact.page.listHide") : t("web.artifact.page.listShow")}
                  testid="artifact-list-toggle"
                  pressed={props.listOpen}
                  onClick={props.onToggleList}
                />
              </span>
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
              <span class="rounded-sm bg-selected px-1.5 py-0.5 text-2xs font-medium text-ink">{kindLabel(props.artifact)}</span>
              <span data-testid="artifact-suffix" class="rounded-sm border border-line bg-page px-1.5 py-0.5 font-mono text-2xs text-muted">
                {artifactSuffix(props.artifact)}
              </span>
              <span aria-hidden="true">·</span>
              <Show when={html() ? version() : undefined}>
                {(v) => (
                  <>
                    <span data-testid="artifact-shown-version">{t("web.artifact.card.version", { version: v().version })}</span>
                    <span aria-hidden="true">·</span>
                  </>
                )}
              </Show>
              <Show when={html() && props.artifact.versions.length > 1}>
                <ol data-testid="artifact-versions" class="inline-flex flex-wrap items-center gap-1">
                  <For each={[...props.artifact.versions].toReversed()} keyed={(v) => v.version}>
                    {(v) => (
                      <li>
                        <button
                          type="button"
                          data-key={v().version}
                          aria-pressed={v().version === version()?.version ? "true" : "false"}
                          title={v().note ? `${v().byName} · ${v().note}` : v().byName}
                          onClick={() => pick(v().version)}
                          class={[
                            "inline-flex h-5 cursor-pointer items-center rounded-sm border px-1.5 text-2xs font-medium transition-[color,background-color,border-color] duration-120 ease-out",
                            v().version === version()?.version
                              ? "border-accent bg-selected text-ink"
                              : "border-line bg-page text-muted hover:bg-hover hover:text-ink",
                          ]}
                        >
                          {t("web.artifact.card.version", { version: v().version })}
                        </button>
                      </li>
                    )}
                  </For>
                </ol>
                <span aria-hidden="true">·</span>
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
                class="animate-fade-in mt-2 flex flex-wrap items-center gap-2 rounded-md bg-bad-soft px-3 py-2"
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
                <HtmlFrame
                  artifact={props.artifact}
                  version={v().version}
                  title={t("web.artifact.page.frame", { title: props.artifact.title, version: v().version })}
                  testId="artifact-frame"
                  frameStyle={"min-h-[60vh] xl:min-h-0 w-full flex-1 rounded-lg border border-line bg-page"}
                  rootStyle={"min-h-auto xl:min-h-0 shrink-0 xl:shrink"}
                  onFrame={setFrame}
                  onShown={(s) => setCanvasShown(() => s)}
                  externalInspector={isCanvas() && rail.get()}
                  onOpenInspector={
                    isCanvas()
                      ? () => {
                          rail.set(true);
                          setRailTab("inspect");
                        }
                      : undefined
                  }
                />
                {/* Canvas has its own inspector. */}
                <Show when={rail.get() && v().version === props.artifact.version && !isCanvas()}>
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
          class="flex shrink-0 flex-col xl:[border-top-style:solid] border-t xl:border-t-0 border-line xl:min-h-0 xl:overflow-hidden xl:[border-left-style:solid] xl:border-l xl:w-88"
        >
          <Show when={isCanvas()}>
            <div class="shrink-0 border-b border-line px-3 py-2.5">
              <Segmented
                testid="artifact-rail-tabs"
                label={t("web.artifact.page.rail")}
                block
                value={railTab()}
                onChange={setRailTab}
                options={[
                  { value: "inspect", label: t("web.artifact.canvasEditor.tabInspect"), icon: "catalog" },
                  { value: "talk", label: t("web.artifact.canvasEditor.tabTalk"), icon: "chat" },
                ]}
              />
            </div>
          </Show>
          <Show when={isCanvas() && railTab() === "inspect" ? { version: version()?.version ?? props.artifact.version, shown: canvasShown() } : undefined}>
            {(p) => (
              <Show when={p().shown}>
                {(s) => (
                  <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                    <Keyed key={p().version}>{() => <CanvasInspector artifact={props.artifact} version={p().version} shown={s()} frame={frame} />}</Keyed>
                  </div>
                )}
              </Show>
            )}
          </Show>
          <Show when={!isCanvas() || railTab() === "talk"}>
            {/* The written blocks' open suggestions are drawn here (BlocksView). */}
            <div ref={setSuggestionsAt} class="empty:hidden shrink-0 border-b border-line px-4 py-3" />
            <Show when={!isCanvas() ? framed() : undefined}>
              {(p) => (
                <div class="empty:hidden shrink-0 border-b border-line px-4 py-3">
                  <Keyed key={p().version}>{() => <PageWords artifact={props.artifact} version={p().version} frame={p().frame} />}</Keyed>
                </div>
              )}
            </Show>
            <div class="flex min-h-[420px] flex-1 flex-col overflow-hidden xl:min-h-0">
              {props.chat({ channel: said()?.channel ?? props.artifact.channel, issue: props.artifact.issue, point: said()?.number })}
            </div>
          </Show>
        </aside>
      </Show>
    </div>
  );
}
