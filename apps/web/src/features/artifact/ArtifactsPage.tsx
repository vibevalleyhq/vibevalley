import * as stylex from "@stylexjs/stylex";
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
import { useQueryClient, ready } from "#/infra/query.ts";
import { useRouter, useSearch, Link as A } from "#/infra/router.ts";
import { defineAtom } from "#/state/atom.ts";
import { type IntentType, sendOnce, useIntents } from "#/state/intent.ts";
import { defineStored } from "#/state/stored.ts";
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

const viewStyles = stylex.create({
  replyAction: { alignSelf: "flex-end" },
  artifactsPageDiv: {
    display: "flex",
    height: "100%",
    minHeight: "0",
    flexDirection: {
      default: "column",
      "@media (width>=64rem)": "row",
    },
  },
  artifactsPageDiv2: {
    display: "flex",
    gap: "calc(var(--spacing) * 1.5)",
  },
  artifactsPageLabel: {
    display: "flex",
    height: "calc(var(--spacing) * 8)",
    minWidth: "0",
    flex: "1",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: {
      default: "var(--wb-line)",
      ":focus-within": "var(--wb-focus)",
    },
    backgroundColor: "var(--wb-page)",
    paddingInline: "calc(var(--spacing) * 2)",
  },
  artifactSearch: {
    minWidth: "0",
    flex: "1",
    backgroundColor: "transparent",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    outlineStyle: "none",
    color: {
      default: null,
      "::placeholder": "var(--wb-faint)",
    },
  },
  artifactsPageP: {
    paddingInline: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-berry)",
  },
  artifactsPageP2: {
    paddingInline: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
    display: {
      default: null,
      "@media (width>=64rem)": "none",
    },
  },
  artifactsPageP3: {
    paddingInline: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  artifactGroup: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * .5)",
  },
  artifactsPageButton: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "var(--spacing)",
    paddingInline: "var(--spacing)",
    paddingTop: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: {
      default: "var(--wb-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-ink)",
      },
    },
  },
  artifactsPageSpan: {
    fontWeight: "var(--font-weight-normal)",
    color: "var(--wb-faint)",
  },
  artifactsPageSpan2: {
    display: "flex",
    minWidth: "0",
    flexDirection: "column",
  },
  artifactsPageSpan3: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-medium)",
  },
  artifactTitle: {
    marginInline: "calc(var(--spacing) * -1)",
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    borderRadius: "var(--radius-md)",
    backgroundColor: {
      default: "transparent",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
      },
      ":focus": "var(--wb-hover)",
    },
    paddingInline: "var(--spacing)",
    fontSize: "var(--text-xl)",
    lineHeight: "calc(var(--spacing) * 8)",
    fontWeight: "var(--font-weight-semibold)",
    outlineStyle: "none",
  },
  shownDiv: {
    display: {
      default: null,
      "@media (width>=64rem)": "none",
    },
  },
  shownDiv2: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  shownDiv3: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: "calc(var(--spacing) * 2)",
    rowGap: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  shownSpan: {
    minWidth: "0",
    flex: "1",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-berry)",
  },
  artifactFrame: {
    minHeight: {
      default: "60vh",
      "@media (width>=80rem)": "0",
    },
    width: "100%",
    flex: "1",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
    backgroundColor: "var(--wb-page)",
  },
  shownP: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-faint)",
  },
  artifactRail: {
    display: "flex",
    flexShrink: "0",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 5)",
    borderTopStyle: {
      default: "solid",
      "@media (width>=80rem)": "solid",
    },
    borderTopWidth: {
      default: "1px",
      "@media (width>=80rem)": "0",
    },
    borderColor: "var(--wb-line)",
    paddingInline: "calc(var(--spacing) * 4)",
    paddingBlock: "calc(var(--spacing) * 4)",
    width: {
      default: null,
      "@media (width>=80rem)": "calc(var(--spacing) * 72)",
    },
    overflowY: {
      default: null,
      "@media (width>=80rem)": "auto",
    },
    borderLeftStyle: {
      default: null,
      "@media (width>=80rem)": "solid",
    },
    borderLeftWidth: {
      default: null,
      "@media (width>=80rem)": "1px",
    },
  },
  shownDiv4: {
    display: {
      default: null,
      ":empty": "none",
    },
  },
  shownDiv5: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 1.5)",
  },
  shownH2: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--wb-muted)",
  },
  shownSpan2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-medium)",
  },
  shownSpan3: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-normal)",
    color: "var(--wb-muted)",
  },
  shownSpan4: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  shownDiv6: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  replyForm: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2)",
  },
});

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
    <div {...stylex.attrs(viewStyles.artifactsPageDiv)}>
      <nav
        aria-label={t("web.artifact.page.list")}
        data-testid="artifact-list"
        class={[id() ? "hidden lg:flex" : "flex", "min-h-0 shrink-0 flex-col gap-3 border-line bg-side p-3 lg:w-64 lg:border-r"]}
      >
        <div {...stylex.attrs(viewStyles.artifactsPageDiv2)}>
          <label {...stylex.attrs(viewStyles.artifactsPageLabel)}>
            <Icon name="search" size={14} class="shrink-0 text-muted" />
            <input
              data-testid="artifact-search"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              placeholder={t("web.artifact.page.find")}
              aria-label={t("web.artifact.page.find")}
              {...stylex.attrs(viewStyles.artifactSearch)}
            />
          </label>
          {/* Beside the search, not a green button over the page being read: a new one is not what this page is for. */}
          <IconButton icon="add" label={t("web.artifact.page.new")} testid="new-artifact" disabled={making.busy()} onClick={() => void create()} />
        </div>
        <Show when={all.error()}>
          <p {...stylex.attrs(viewStyles.artifactsPageP)}>{reasonOf(all.error())}</p>
        </Show>
        <Show when={all.status() === "success" && list().length === 0}>
          <p {...stylex.attrs(viewStyles.artifactsPageP2)}>{t("web.artifact.page.none")}</p>
        </Show>
        <Show when={list().length > 0 && shown().length === 0}>
          <p {...stylex.attrs(viewStyles.artifactsPageP3)}>{t("web.artifact.page.nothingFound")}</p>
        </Show>
        <div class="-mx-2 flex min-h-0 scroll-fade-y flex-col gap-2 overflow-y-auto px-2">
          <For each={groups().filter((g) => g.rows.length > 0)}>
            {(g) => (
              <section data-testid="artifact-group" data-key={g.key} {...stylex.attrs(viewStyles.artifactGroup)}>
                <button
                  type="button"
                  aria-expanded={shut().has(g.key) ? "false" : "true"}
                  onClick={() => toggle(g.key)}
                  {...stylex.attrs(viewStyles.artifactsPageButton)}
                >
                  <Icon name={shut().has(g.key) ? "expand" : "choose"} size={12} />
                  {t(`web.artifact.page.group.${g.key}`)}
                  <span {...stylex.attrs(viewStyles.artifactsPageSpan)}>{g.rows.length}</span>
                </button>
                <Show when={!shut().has(g.key)}>
                  <ul {...stylex.attrs(viewStyles.artifactGroup)}>
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
                            <span {...stylex.attrs(viewStyles.artifactsPageSpan2)}>
                              <span {...stylex.attrs(viewStyles.artifactsPageSpan3)}>{a().title}</span>
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
        <Show when={found.status() === "error"}>
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
    const done = await act.run(async () => {
      await api.artifact.update({ id, title });
      void queries.invalidate({ prefix: ["artifacts"] });
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
      {...stylex.attrs(viewStyles.artifactTitle)}
    />
  );
}

function Shown(props: { artifact: Artifact; say: ChatSay }) {
  const queries = useQueryClient();
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
          <div {...stylex.attrs(viewStyles.shownDiv)}>
            <Button icon="back" onClick={() => router.navigate("/artifacts")}>
              {t("web.artifact.page.all")}
            </Button>
          </div>
          {/* A blocks one's header lines up with its text, past the gutter of faces and author bars (BlocksView). */}
          <header class={["flex flex-col gap-1", html() ? "" : "lg:pl-[35px]"]}>
            <div {...stylex.attrs(viewStyles.shownDiv2)}>
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
            <div {...stylex.attrs(viewStyles.shownDiv3)}>
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
                <span {...stylex.attrs(viewStyles.shownSpan)}>{t("web.artifact.page.deleteAsk", { title: props.artifact.title })}</span>
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
                  {...stylex.attrs(viewStyles.artifactFrame)}
                />
                {/* Words are changed in place only on the latest version: the hint shows only there, with the rail. */}
                <Show when={rail.get() && v().version === props.artifact.version}>
                  <p {...stylex.attrs(viewStyles.shownP)}>{t("web.artifact.edit.hint")}</p>
                </Show>
              </>
            )}
          </Show>
        </div>
      </section>
      <Show when={rail.get()}>
        <aside aria-label={t("web.artifact.page.rail")} data-testid="artifact-rail" {...stylex.attrs(viewStyles.artifactRail)}>
          {/* The written blocks' open suggestions are drawn here (BlocksView). */}
          <div ref={setSuggestionsAt} {...stylex.attrs(viewStyles.shownDiv4)} />
          <Show when={framed()}>
            {(p) => <Keyed key={p().version}>{() => <PageWords artifact={props.artifact} version={p().version} frame={p().frame} />}</Keyed>}
          </Show>
          {/* A list of one says nothing the head does not: the versions show once there is a second. */}
          <Show when={html() && props.artifact.versions.length > 1}>
            <div {...stylex.attrs(viewStyles.shownDiv5)}>
              <h2 {...stylex.attrs(viewStyles.shownH2)}>{t("web.artifact.page.versions")}</h2>
              <ol data-testid="artifact-versions" {...stylex.attrs(viewStyles.artifactGroup)}>
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
                        <span {...stylex.attrs(viewStyles.shownSpan2)}>
                          {t("web.artifact.card.version", { version: v().version })}{" "}
                          <span {...stylex.attrs(viewStyles.shownSpan3)}>
                            · {v().byName} · {ago(v().at, now())}
                          </span>
                        </span>
                        <Show when={v().note}>{(note) => <span {...stylex.attrs(viewStyles.shownSpan4)}>{note()}</span>}</Show>
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
              <p data-testid="artifact-unsaid" {...stylex.attrs(viewStyles.shownP)}>
                {t("web.artifact.talk.none")}
              </p>
            }
          >
            {(at) => (
              <div {...stylex.attrs(viewStyles.shownDiv5)}>
                <div {...stylex.attrs(viewStyles.shownDiv6)}>
                  <h2 {...stylex.attrs(viewStyles.shownH2)}>{version() ? t("web.artifact.talk.replyVersion") : t("web.artifact.talk.reply")}</h2>
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
      {...stylex.attrs(viewStyles.replyForm)}
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
      <Button type="submit" tone="primary" icon="reply" disabled={!text().trim() || busy()} data-testid="artifact-send" styles={viewStyles.replyAction}>
        {t("web.artifact.talk.send")}
      </Button>
    </form>
  );
}
