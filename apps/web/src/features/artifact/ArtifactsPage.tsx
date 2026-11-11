import * as stylex from "@stylexjs/stylex";
import { Schema } from "effect";
import { createMemo, createSignal, For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Artifact, type ArtifactVersion, artifactPath, userId, type SayRequest } from "@vibevalley/protocol";

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
import { HtmlFrame } from "./HtmlFrame";
import { PageWords } from "./PageWords";

const fadeIn = stylex.keyframes({
  from: { opacity: 0 },
});

const styles = stylex.create({
  artifactsPageA: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.5rem",
    borderRadius: "var(--radius-md)",
    paddingInline: "0.5rem",
    paddingBlock: "0.375rem",
    transitionProperty: "color, background-color, border-color",
    transitionTimingFunction: "var(--ease-out)",
    transitionDuration: "120ms",
  },
  artifactsPageAState: {
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
      },
    },
  },
  artifactsPageAState2: {
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
      },
      "@media (width>=64rem)": "var(--wb-selected)",
    },
  },
  artifactsPageAState3: {
    backgroundColor: "var(--wb-selected)",
  },
  shownDiv: {
    display: "flex",
    minHeight: "0",
    flex: "1",
    flexDirection: {
      default: "column",
      "@media (width>=80rem)": "row",
    },
    overflowY: {
      default: "auto",
      "@media (width>=80rem)": "hidden",
    },
    overflowX: {
      default: null,
      "@media (width>=80rem)": "hidden",
    },
  },
  artifactsPageDiv: {
    marginInline: "-0.5rem",
    display: "flex",
    minHeight: "0",
    WebkitMaskImage: "linear-gradient(to bottom, transparent, black var(--fade-top), black calc(100% - var(--fade-bottom)), transparent)",
    maskImage: "linear-gradient(to bottom, transparent, black var(--fade-top), black calc(100% - var(--fade-bottom)), transparent)",
    animationName: "scroll-fade-y",
    animationDuration: "0s",
    animationTimingFunction: "linear",
    animationFillMode: "both",
    animationTimeline: "scroll(self y)",
    flexDirection: "column",
    gap: "0.5rem",
    overflowY: "auto",
    paddingInline: "0.5rem",
  },
  shownDiv2: {
    marginTop: "0.5rem",
    display: "flex",
    animationName: { default: fadeIn, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "180ms",
    animationTimingFunction: "var(--ease-out)",
    animationFillMode: "both",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.5rem",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--wb-bad-soft)",
    paddingInline: "0.75rem",
    paddingBlock: "0.5rem",
  },
  shownButton: {
    display: "flex",
    width: "100%",
    cursor: "pointer",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "0.125rem",
    borderRadius: "var(--radius-md)",
    paddingInline: "0.625rem",
    paddingBlock: "0.375rem",
    textAlign: "left",
    transitionProperty: "color, background-color, border-color",
    transitionTimingFunction: "var(--ease-out)",
    transitionDuration: "120ms",
  },
  shownButtonPrimary: {
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  shownButtonSecondary: {
    backgroundColor: "var(--color-selected)",
  },
  artifactsPageIcon: {
    flexShrink: "0",
    color: "var(--color-muted)",
  },
  artifactsPageIcon2: {
    marginTop: "0.125rem",
    flexShrink: "0",
    color: "var(--color-muted)",
  },
  shownA: {
    color: "var(--color-water)",
    textDecorationLine: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "underline",
      },
    },
  },
  shownA2: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.25rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
  },
  artifactsPageNav: {
    minHeight: "0",
    flexShrink: "0",
    flexDirection: "column",
    gap: "0.75rem",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-side)",
    padding: "0.75rem",
    width: {
      default: null,
      "@media (width>=64rem)": "16rem",
    },
    borderRightStyle: {
      default: null,
      "@media (width>=64rem)": "solid",
    },
    borderRightWidth: {
      default: null,
      "@media (width>=64rem)": "1px",
    },
  },
  artifactsPageNavTone: {
    display: {
      default: "none",
      "@media (width>=64rem)": "flex",
    },
  },
  artifactsPageNavAlt: {
    display: "flex",
  },
  artifactsPageSpan: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  artifactsPageSpanTone: {
    color: {
      default: "var(--color-ink)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-ink) 75%, transparent)",
    },
  },
  artifactsPageSpanAlt: {
    color: "var(--color-muted)",
  },
  artifactsPageDiv2: {
    minHeight: "0",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
  },
  shownSection: {
    display: "flex",
    minHeight: {
      default: "70vh",
      "@media (width>=80rem)": "0",
    },
    minWidth: "0",
    // Narrow, the view scrolls: the section is as tall as what it holds (a deck's controls too), not squeezed under the rail.
    flex: {
      default: "0 0 auto",
      "@media (width>=80rem)": "1",
    },
    flexDirection: "column",
    paddingInline: "1rem",
    paddingBlock: "1rem",
  },
  shownDiv3: {
    display: "flex",
    minHeight: "0",
    width: "100%",
    flex: "1",
    flexDirection: "column",
    gap: "0.75rem",
  },
  shownDivTone: {},
  shownDivAlt: {
    marginInline: "auto",
    maxWidth: "var(--container-3xl)",
  },
  shownHeader: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
  },
  shownHeaderTone: {
    paddingLeft: {
      default: null,
      "@media (width>=64rem)": "35px",
    },
  },
  replyAction: { alignSelf: "flex-end" },
  artifactsPageDiv3: {
    display: "flex",
    height: "100%",
    minHeight: "0",
    flexDirection: {
      default: "column",
      "@media (width>=64rem)": "row",
    },
  },
  artifactsPageDiv22: {
    display: "flex",
    gap: "0.375rem",
  },
  artifactsPageLabel: {
    display: "flex",
    height: "2rem",
    minWidth: "0",
    flex: "1",
    alignItems: "center",
    gap: "0.375rem",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: {
      default: "var(--color-line)",
      ":focus-within": "var(--color-focus)",
    },
    backgroundColor: "var(--color-page)",
    paddingInline: "0.5rem",
  },
  artifactSearch: {
    minWidth: "0",
    flex: "1",
    backgroundColor: "transparent",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    outlineStyle: "none",
    color: {
      default: null,
      "::placeholder": "var(--color-faint)",
    },
  },
  artifactsPageP: {
    paddingInline: "0.5rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-berry)",
  },
  artifactsPageP2: {
    paddingInline: "0.5rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
    display: {
      default: null,
      "@media (width>=64rem)": "none",
    },
  },
  artifactsPageP3: {
    paddingInline: "0.5rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  artifactGroup: {
    display: "flex",
    flexDirection: "column",
    gap: "0.125rem",
  },
  artifactsPageButton: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "0.25rem",
    paddingInline: "0.25rem",
    paddingTop: "0.25rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-semibold)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
  },
  artifactsPageSpan2: {
    fontWeight: "var(--font-weight-normal)",
    color: "var(--color-faint)",
  },
  artifactsPageSpan22: {
    display: "flex",
    minWidth: "0",
    flexDirection: "column",
  },
  artifactsPageSpan3: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    fontWeight: "var(--font-weight-medium)",
  },
  artifactTitle: {
    marginInline: "-0.25rem",
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
        ":hover": "var(--color-hover)",
      },
      ":focus": "var(--color-hover)",
    },
    paddingInline: "0.25rem",
    fontSize: "var(--text-xl)",
    lineHeight: "2rem",
    fontWeight: "var(--font-weight-semibold)",
    outlineStyle: "none",
  },
  shownDiv4: {
    display: {
      default: null,
      "@media (width>=64rem)": "none",
    },
  },
  shownDiv22: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  },
  shownDiv32: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: "0.5rem",
    rowGap: "0.25rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  shownSpan: {
    minWidth: "0",
    flex: "1",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-berry)",
  },
  // Narrow, the page scrolls: the frame keeps its own height and the deck's controls stay under it.
  artifactFramed: {
    minHeight: {
      default: "auto",
      "@media (width>=80rem)": "0",
    },
    flexShrink: {
      default: "0",
      "@media (width>=80rem)": "1",
    },
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
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
  },
  shownP: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-faint)",
  },
  artifactRail: {
    display: "flex",
    flexShrink: "0",
    flexDirection: "column",
    gap: "1.25rem",
    borderTopStyle: {
      default: "solid",
      "@media (width>=80rem)": "solid",
    },
    borderTopWidth: {
      default: "1px",
      "@media (width>=80rem)": "0",
    },
    borderColor: "var(--color-line)",
    paddingInline: "1rem",
    paddingBlock: "1rem",
    width: {
      default: null,
      "@media (width>=80rem)": "18rem",
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
  shownDiv42: {
    display: {
      default: null,
      ":empty": "none",
    },
  },
  shownDiv5: {
    display: "flex",
    flexDirection: "column",
    gap: "0.375rem",
  },
  shownH2: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
  shownSpan2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    fontWeight: "var(--font-weight-medium)",
  },
  shownSpan3: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-normal)",
    color: "var(--color-muted)",
  },
  shownSpan4: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  shownDiv6: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  replyForm: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  },
});

const messageHref = (at: { readonly channel: string; readonly number?: number }) =>
  at.number !== undefined ? `/chat/${at.channel}?m=${at.number}` : `/chat/${at.channel}`;

const rail = defineStored("artifact.rail", Schema.Boolean, true);

/** The one just made with New: its title is selected to be typed over when it opens. */
const justMade = defineAtom<string | undefined>(undefined);

/** `rest` is the path after /artifacts/. */
/** The user's lines in a channel (features/channel's chatSay), given by app/: the channel feature shows artifacts, so this
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
    <div {...stylex.attrs(styles.artifactsPageDiv3)}>
      <nav
        aria-label={t("web.artifact.page.list")}
        data-testid="artifact-list"
        {...stylex.attrs(styles.artifactsPageNav, id() ? styles.artifactsPageNavTone : styles.artifactsPageNavAlt)}
      >
        <div {...stylex.attrs(styles.artifactsPageDiv22)}>
          <label {...stylex.attrs(styles.artifactsPageLabel)}>
            <Icon name="search" size={14} styles={[styles.artifactsPageIcon]} />
            <input
              data-testid="artifact-search"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              placeholder={t("web.artifact.page.find")}
              aria-label={t("web.artifact.page.find")}
              {...stylex.attrs(styles.artifactSearch)}
            />
          </label>
          {/* Beside the search, not a green button over the page being read: a new one is not what this page is for. */}
          <IconButton icon="add" label={t("web.artifact.page.new")} testid="new-artifact" disabled={making.busy()} onClick={() => void create()} />
        </div>
        <Show when={all.error()}>
          <p {...stylex.attrs(styles.artifactsPageP)}>{reasonOf(all.error())}</p>
        </Show>
        <Show when={all.status() === "success" && list().length === 0}>
          <p {...stylex.attrs(styles.artifactsPageP2)}>{t("web.artifact.page.none")}</p>
        </Show>
        <Show when={list().length > 0 && shown().length === 0}>
          <p {...stylex.attrs(styles.artifactsPageP3)}>{t("web.artifact.page.nothingFound")}</p>
        </Show>
        <div {...stylex.attrs(styles.artifactsPageDiv)}>
          <For each={groups().filter((g) => g.rows.length > 0)}>
            {(g) => (
              <section data-testid="artifact-group" data-key={g.key} {...stylex.attrs(styles.artifactGroup)}>
                <button
                  type="button"
                  aria-expanded={shut().has(g.key) ? "false" : "true"}
                  onClick={() => toggle(g.key)}
                  {...stylex.attrs(styles.artifactsPageButton)}
                >
                  <Icon name={shut().has(g.key) ? "expand" : "choose"} size={12} />
                  {t(`web.artifact.page.group.${g.key}`)}
                  <span {...stylex.attrs(styles.artifactsPageSpan2)}>{g.rows.length}</span>
                </button>
                <Show when={!shut().has(g.key)}>
                  <ul {...stylex.attrs(styles.artifactGroup)}>
                    <For each={g.rows} keyed={(a) => a.id}>
                      {(a) => (
                        <li>
                          <A
                            href={artifactHref(a().id)}
                            data-testid="artifact-row"
                            data-key={a().id}
                            data-body={a().body}
                            aria-current={a().id === open() ? "page" : undefined}
                            {...stylex.attrs(
                              styles.artifactsPageA,
                              a().id === id() ? styles.artifactsPageAState3 : a().id === open() ? styles.artifactsPageAState2 : styles.artifactsPageAState,
                            )}
                          >
                            <Icon name={bodyIcon[a().body]} size={16} styles={[styles.artifactsPageIcon2]} />
                            <span {...stylex.attrs(styles.artifactsPageSpan22)}>
                              <span {...stylex.attrs(styles.artifactsPageSpan3)}>{a().title}</span>
                              {/* On the selected row's darker ground the line takes more ink, to stay readable. */}
                              <span {...stylex.attrs(styles.artifactsPageSpan, a().id === open() ? styles.artifactsPageSpanTone : styles.artifactsPageSpanAlt)}>
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
      <div {...stylex.attrs(styles.artifactsPageDiv2, id() ? styles.artifactsPageNavAlt : styles.artifactsPageNavTone)}>
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
      {...stylex.attrs(styles.artifactTitle)}
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
      {...stylex.attrs(styles.shownDiv)}
    >
      <section {...stylex.attrs(styles.shownSection)}>
        {/* A page is shown as wide as there is room; written blocks read in a column. */}
        <div {...stylex.attrs(styles.shownDiv3, html() ? styles.shownDivTone : styles.shownDivAlt)}>
          <div {...stylex.attrs(styles.shownDiv4)}>
            <Button icon="back" onClick={() => router.navigate("/artifacts")}>
              {t("web.artifact.page.all")}
            </Button>
          </div>
          {/* A blocks one's header lines up with its text, past the gutter of faces and author bars (BlocksView). */}
          <header {...stylex.attrs(styles.shownHeader, html() ? styles.shownDivTone : styles.shownHeaderTone)}>
            <div {...stylex.attrs(styles.shownDiv22)}>
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
            <div {...stylex.attrs(styles.shownDiv32)}>
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
                    <A href={`/issues/${i().id}`} data-testid="artifact-issue" {...stylex.attrs(styles.shownA)}>
                      {t("web.artifact.page.forIssue", { number: i().number })}
                    </A>
                  </>
                )}
              </Show>
            </div>
            <Show when={asking()}>
              <div role="group" data-testid="artifact-delete" {...stylex.attrs(styles.shownDiv2)} onKeyDown={(e) => e.key === "Escape" && setAsking(false)}>
                <span {...stylex.attrs(styles.shownSpan)}>{t("web.artifact.page.deleteAsk", { title: props.artifact.title })}</span>
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
                  frameStyle={styles.artifactFrame}
                  rootStyle={styles.artifactFramed}
                  onFrame={setFrame}
                />
                {/* Words are changed in place only on the latest version: the hint shows only there, with the rail. */}
                <Show when={rail.get() && v().version === props.artifact.version}>
                  <p {...stylex.attrs(styles.shownP)}>{t("web.artifact.edit.hint")}</p>
                </Show>
              </>
            )}
          </Show>
        </div>
      </section>
      <Show when={rail.get()}>
        <aside aria-label={t("web.artifact.page.rail")} data-testid="artifact-rail" {...stylex.attrs(styles.artifactRail)}>
          {/* The written blocks' open suggestions are drawn here (BlocksView). */}
          <div ref={setSuggestionsAt} {...stylex.attrs(styles.shownDiv42)} />
          <Show when={framed()}>
            {(p) => <Keyed key={p().version}>{() => <PageWords artifact={props.artifact} version={p().version} frame={p().frame} />}</Keyed>}
          </Show>
          {/* A list of one says nothing the head does not: the versions show once there is a second. */}
          <Show when={html() && props.artifact.versions.length > 1}>
            <div {...stylex.attrs(styles.shownDiv5)}>
              <h2 {...stylex.attrs(styles.shownH2)}>{t("web.artifact.page.versions")}</h2>
              <ol data-testid="artifact-versions" {...stylex.attrs(styles.artifactGroup)}>
                <For each={[...props.artifact.versions].toReversed()} keyed={(v) => v.version}>
                  {(v) => (
                    <li>
                      <button
                        type="button"
                        data-key={v().version}
                        aria-pressed={v().version === version()?.version ? "true" : "false"}
                        onClick={() => pick(v().version)}
                        {...stylex.attrs(styles.shownButton, v().version === version()?.version ? styles.shownButtonSecondary : styles.shownButtonPrimary)}
                      >
                        <span {...stylex.attrs(styles.shownSpan2)}>
                          {t("web.artifact.card.version", { version: v().version })}{" "}
                          <span {...stylex.attrs(styles.shownSpan3)}>
                            · {v().byName} · {ago(v().at, now())}
                          </span>
                        </span>
                        <Show when={v().note}>{(note) => <span {...stylex.attrs(styles.shownSpan4)}>{note()}</span>}</Show>
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
              <p data-testid="artifact-unsaid" {...stylex.attrs(styles.shownP)}>
                {t("web.artifact.talk.none")}
              </p>
            }
          >
            {(at) => (
              <div {...stylex.attrs(styles.shownDiv5)}>
                <div {...stylex.attrs(styles.shownDiv6)}>
                  <h2 {...stylex.attrs(styles.shownH2)}>{version() ? t("web.artifact.talk.replyVersion") : t("web.artifact.talk.reply")}</h2>
                  <A href={messageHref(at())} data-testid="artifact-message" {...stylex.attrs(styles.shownA2)}>
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
    if (end?.phase === "failed") return toast(end.fault.reason, "bad");
    setText("");
    toast(props.version ? t("web.artifact.talk.sentVersion", { version: props.version.version }) : t("web.artifact.talk.sent"));
  };
  return (
    <form
      {...stylex.attrs(styles.replyForm)}
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
      <Button type="submit" tone="primary" icon="reply" disabled={!text().trim() || busy()} data-testid="artifact-send" styles={styles.replyAction}>
        {t("web.artifact.talk.send")}
      </Button>
    </form>
  );
}
