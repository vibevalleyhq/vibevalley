import * as stylex from "@stylexjs/stylex";
import { Schema } from "effect";
import { createSignal, For, Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { PkmBacklink, PkmComment, PkmPageSummary, PkmPageView, PkmTier } from "@vibevalley/protocol";

import { api } from "#/infra/api.ts";
import { ready, useQueryClient } from "#/infra/query.ts";
import { useRouter, Link as A } from "#/infra/router.ts";
import { defineStored } from "#/state/stored.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Select } from "#/ui/Field.tsx";
import { IconButton } from "#/ui/IconButton.tsx";
import { Empty } from "#/ui/layout.tsx";
import { type MoreItem, MoreMenu } from "#/ui/MoreMenu.tsx";
import { Dot, type DotTone } from "#/ui/Tag.tsx";
import { toast } from "#/ui/toasts.ts";

import { Body } from "./Body";
import { Calendar } from "./Calendar";
import { daysUntil, dayKey, titleFor } from "./days";
import { tierOrder, wordDiff } from "./outline";
import { Outline } from "./OutlineView";
import { pkmHref, refreshPkm as refreshQueries, usePkmPage } from "./vault";

const styles = stylex.create({
  propsSpanState: {
    color: "var(--wb-muted)",
  },
  propsSpanState2: {
    color: "var(--wb-warn-ink)",
  },
  propsSpanState3: {
    color: "var(--wb-berry)",
  },
  shownA: {
    textDecorationLine: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "underline",
      },
    },
  },
  backlinkRowA: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
    textDecorationLine: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "underline",
      },
    },
  },
  shownDiv: {
    display: "flex",
    minHeight: "0",
    flex: "1",
    flexDirection: {
      default: "column",
      "@media (width>=80rem)": "row",
    },
    overflowY: "auto",
    alignItems: {
      default: null,
      "@media (width>=80rem)": "flex-start",
    },
  },
  pkmDay: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  },
  shownH2: {
    fontSize: "var(--text-lg)",
    lineHeight: "var(--leading-lg)",
    fontWeight: "var(--font-weight-semibold)",
  },
  shownArticle: {
    marginInline: "auto",
    display: "flex",
    width: "100%",
    maxWidth: "var(--container-3xl)",
    minWidth: "0",
    flexDirection: "column",
    gap: "1rem",
    paddingInline: "1rem",
    paddingBlock: "1rem",
  },
  pkmRail: {
    marginInline: {
      default: "auto",
      "@media (width>=80rem)": "0",
    },
    display: "flex",
    width: {
      default: "100%",
      "@media (width>=80rem)": "18rem",
    },
    maxWidth: "var(--container-3xl)",
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
    position: {
      default: null,
      "@media (width>=80rem)": "sticky",
    },
    top: {
      default: null,
      "@media (width>=80rem)": "0",
    },
    maxHeight: {
      default: null,
      "@media (width>=80rem)": "100%",
    },
    flexShrink: {
      default: null,
      "@media (width>=80rem)": "0",
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
  headerDiv: {
    display: {
      default: null,
      "@media (width>=64rem)": "none",
    },
  },
  headerDiv2: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
  },
  pkmTitle: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xl)",
    lineHeight: "2rem",
    fontWeight: "var(--font-weight-semibold)",
  },
  headerP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
  },
  pkmProps: {
    display: "flex",
    flexDirection: "column",
    gap: "0.375rem",
  },
  propsDiv: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: "0.75rem",
    rowGap: "0.25rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  pkmProp: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.375rem",
  },
  pkmProp2: {
    color: "var(--color-muted)",
  },
  pkmProp3: {
    borderRadius: "9999px",
    backgroundColor: "var(--color-hover)",
    paddingInline: "0.5rem",
    paddingBlock: "0.125rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  pkmPropsMore: {
    cursor: "pointer",
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
  propsDl: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    columnGap: "0.75rem",
    rowGap: "0.125rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  commentsH2: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
  pkmComment: {
    display: "flex",
    flexDirection: "column",
    gap: "0.375rem",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    padding: "0.625rem",
  },
  pkmCommentAt: {
    cursor: "pointer",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textAlign: "left",
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
  commentCardP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  pkmDiff: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    whiteSpace: "pre-wrap",
  },
  commentCardDel: {
    backgroundColor: "var(--color-bad-soft)",
    color: "var(--color-berry)",
  },
  commentCardIns: {
    backgroundColor: "var(--color-ok-soft)",
    color: "var(--color-ok-ink)",
    textDecorationLine: "none",
  },
  commentCardDiv: {
    display: "flex",
    gap: "0.375rem",
    alignSelf: "flex-end",
  },
  backlinksP: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-faint)",
  },
  backlinksDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "0.125rem",
  },
  backlinksH3: {
    fontSize: "var(--text-2xs)",
    lineHeight: "var(--leading-2xs)",
    color: "var(--color-faint)",
  },
  pkmBacklink: {
    display: "flex",
    flexDirection: "column",
    borderRadius: "var(--radius-md)",
    paddingInline: "0.5rem",
    paddingBlock: "0.375rem",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  contentsDiv: {
    cursor: "pointer",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    borderRadius: "var(--radius-md)",
    paddingInline: "0.5rem",
    paddingBlock: "0.125rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
});

/** A tier as a group of pages (the sidebar's heads): Projects. */
export const tierLabel = (tier: PkmTier) => t(`web.pkm.tier.${tier}`);
/** A tier as where one page is: Project. */
const tierOfOne = (tier: PkmTier) => t(`web.pkm.tierOne.${tier}`);

const rail = defineStored("pkm.rail", Schema.Boolean, true);

/** compact: in the stream of days, the column alone, its title a link to the day's own page. */
export function Opened(props: { slug: string; pages: readonly PkmPageSummary[]; point?: string | undefined; compact?: boolean }) {
  const [editing, setEditing] = createSignal(false);
  const found = usePkmPage(() => props.slug, editing);
  return (
    <Show
      when={ready(found, undefined)}
      fallback={
        <Show when={found.status() === "error"}>
          <Empty icon="file">{t("web.pkm.gone")}</Empty>
        </Show>
      }
    >
      {(view) => (
        <Shown
          view={view()}
          summary={props.pages.find((p) => p.slug === props.slug)}
          pages={props.pages}
          point={props.point}
          compact={props.compact === true}
          onEditing={setEditing}
        />
      )}
    </Show>
  );
}

function Shown(props: {
  view: PkmPageView;
  summary: PkmPageSummary | undefined;
  pages: readonly PkmPageSummary[];
  point: string | undefined;
  compact: boolean;
  onEditing: (on: boolean) => void;
}) {
  const page = () => props.view.page;
  const outline = () => <Outline view={props.view} pages={props.pages} point={props.point} onEditing={props.onEditing} />;
  return (
    <Show
      when={!props.compact}
      fallback={
        <article data-testid="pkm-day" data-key={page().slug} {...stylex.attrs(styles.pkmDay)}>
          <h2 {...stylex.attrs(styles.shownH2)}>
            <A href={pkmHref(page().slug)} {...stylex.attrs(styles.shownA)}>
              {titleFor(page().title, props.summary?.day)}
            </A>
          </h2>
          {outline()}
        </article>
      }
    >
      <div data-testid="pkm-page" data-key={page().slug} {...stylex.attrs(styles.shownDiv)}>
        <article {...stylex.attrs(styles.shownArticle)}>
          <Header view={props.view} summary={props.summary} />
          {outline()}
        </article>
        <Show when={rail.get()}>
          <aside aria-label={t("web.pkm.rail.label")} data-testid="pkm-rail" {...stylex.attrs(styles.pkmRail)}>
            <Calendar pages={props.pages} open={props.summary?.day} />
            <Comments view={props.view} />
            <Backlinks view={props.view} pages={props.pages} />
            <Contents view={props.view} />
          </aside>
        </Show>
      </div>
    </Show>
  );
}

function Header(props: { view: PkmPageView; summary: PkmPageSummary | undefined }) {
  const client = useQueryClient();
  const refreshPkm = () => refreshQueries(client);
  const router = useRouter();
  const page = () => props.view.page;
  const act = createAct();
  const move = (tier: PkmTier) => {
    const { slug, tier: was } = page();
    if (tier === was) return undefined;
    return act.run(async () => {
      await api.pkm.page.move({ page: slug, tier });
      toast(t("web.pkm.page.moved", { tier: tierOfOne(tier) }));
      void refreshPkm();
    });
  };
  const exportIt = () => {
    const { slug } = page();
    return act.run(async () => {
      const { markdown } = await api.pkm.page.export({ page: slug });
      await navigator.clipboard.writeText(markdown);
      toast(t("web.pkm.page.exported"));
    });
  };
  const copyFile = () => {
    const { file } = page();
    return act.run(async () => {
      await navigator.clipboard.writeText(file);
      toast(t("web.pkm.page.copiedFile"));
    });
  };
  const undo = () =>
    act.run(async () => {
      const done = await api.pkm.undo();
      toast(done.undone ? t("web.pkm.page.undone", { what: done.what ?? "" }) : t("web.pkm.page.nothingToUndo"));
      void refreshPkm();
    });
  const more = (): MoreItem[] => [
    { key: "export", label: t("web.pkm.page.export"), icon: "copy", onSelect: () => void exportIt() },
    { key: "path", label: t("web.pkm.page.copyFile", { file: page().file }), icon: "file", onSelect: () => void copyFile() },
    { key: "undo", label: t("web.pkm.page.undo"), icon: "undo", onSelect: () => void undo() },
  ];
  return (
    <header {...stylex.attrs(styles.pkmDay)}>
      <div {...stylex.attrs(styles.headerDiv)}>
        <Button icon="back" onClick={() => router.navigate("/pkm")}>
          {t("web.pkm.list.today")}
        </Button>
      </div>
      <div {...stylex.attrs(styles.headerDiv2)}>
        <h1 data-testid="pkm-title" {...stylex.attrs(styles.pkmTitle)}>
          {titleFor(page().title, props.summary?.day)}
        </h1>
        <Select
          testid="pkm-tier-select"
          label={t("web.pkm.page.tier")}
          size="control"
          value={page().tier}
          options={tierOrder.map((tier) => ({ value: tier, label: tierOfOne(tier) }))}
          onChange={(tier) => void move(tier)}
        />
        <IconButton
          icon="thread"
          label={rail.get() ? t("web.pkm.rail.hide") : t("web.pkm.rail.show")}
          testid="pkm-rail-toggle"
          pressed={rail.get()}
          onClick={() => rail.update((open) => !open)}
        />
        <MoreMenu label={t("web.pkm.page.more")} testid="pkm-more" items={more()} />
      </div>
      <Props view={props.view} />
      <Show when={page().tldr}>
        <p {...stylex.attrs(styles.headerP)}>{page().tldr}</p>
      </Show>
    </header>
  );
}

/** The properties that say how the page stands, said in a line; the rest folded under a count. */
const leading = new Set(["status", "deadline", "area", "areas", "tags"]);
const hidden = new Set(["title", "tldr", "alias", "para"]);

const statusTone = (status: string): DotTone => {
  const s = status.trim().toLowerCase();
  if (["active", "doing", "now", "in-progress"].includes(s)) return "leaf";
  if (["waiting", "paused", "blocked", "someday"].includes(s)) return "wheat";
  if (["done", "completed", "archived"].includes(s)) return "faint";
  return "idle";
};

function Props(props: { view: PkmPageView }) {
  const [all, setAll] = createSignal(false);
  const entries = () => Object.entries(props.view.page.props).filter(([k]) => !hidden.has(k));
  const rest = () => entries().filter(([k]) => !leading.has(k));
  const value = (k: string) => props.view.page.props[k];
  const deadline = () => {
    const d = value("deadline");
    const left = d === undefined ? undefined : daysUntil(d, dayKey(Date.now()));
    return d === undefined ? undefined : { day: d, left };
  };
  return (
    <Show when={entries().length > 0}>
      <div data-testid="pkm-props" {...stylex.attrs(styles.pkmProps)}>
        <div {...stylex.attrs(styles.propsDiv)}>
          <Show when={value("status")}>
            {(s) => (
              <span data-testid="pkm-prop" data-key="status" {...stylex.attrs(styles.pkmProp)}>
                <Dot tone={statusTone(s())} />
                {s()}
              </span>
            )}
          </Show>
          <Show when={deadline()}>
            {(d) => (
              <span
                data-testid="pkm-prop"
                data-key="deadline"
                {...stylex.attrs((d().left ?? 1) < 0 ? styles.propsSpanState3 : (d().left ?? 99) <= 3 ? styles.propsSpanState2 : styles.propsSpanState)}
              >
                <Switch fallback={t("web.pkm.props.deadline", { day: d().day })}>
                  <Match when={d().left !== undefined && (d().left ?? 0) < 0}>{t("web.pkm.props.overdue", { day: d().day, n: -(d().left ?? 0) })}</Match>
                  <Match when={d().left === 0}>{t("web.pkm.props.dueToday", { day: d().day })}</Match>
                  <Match when={d().left !== undefined}>{t("web.pkm.props.left", { day: d().day, n: d().left ?? 0 })}</Match>
                </Switch>
              </span>
            )}
          </Show>
          <For each={["area", "areas"].filter((k) => value(k))}>
            {(k) => (
              <span data-testid="pkm-prop" data-key={k} {...stylex.attrs(styles.pkmProp2)}>
                {t("web.pkm.props.area")} <Body text={value(k) ?? ""} refs={props.view.transclusions} />
              </span>
            )}
          </For>
          <For
            each={(value("tags") ?? "")
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean)}
          >
            {(tag) => (
              <span data-testid="pkm-prop" data-key="tags" {...stylex.attrs(styles.pkmProp3)}>
                <Body text={tag.startsWith("#") || tag.startsWith("[[") ? tag : `[[${tag}]]`} refs={props.view.transclusions} />
              </span>
            )}
          </For>
          <Show when={rest().length > 0}>
            <button type="button" data-testid="pkm-props-more" onClick={() => setAll((a) => !a)} {...stylex.attrs(styles.pkmPropsMore)}>
              {all() ? t("web.pkm.props.fewer") : t("web.pkm.props.more", { n: rest().length })}
            </button>
          </Show>
        </div>
        <Show when={all()}>
          <dl {...stylex.attrs(styles.propsDl)}>
            <For each={rest()} keyed={([k]) => k}>
              {(entry) => (
                <>
                  <dt {...stylex.attrs(styles.pkmProp2)}>{entry()[0]}</dt>
                  <dd data-testid="pkm-prop" data-key={entry()[0]}>
                    <Body text={entry()[1]} refs={props.view.transclusions} />
                  </dd>
                </>
              )}
            </For>
          </dl>
        </Show>
      </div>
    </Show>
  );
}

function Comments(props: { view: PkmPageView }) {
  const bodyOf = (block: string) => props.view.page.blocks.find((b) => b.id === block)?.body ?? "";
  return (
    <Show when={props.view.comments.length > 0}>
      <section data-testid="pkm-comments" {...stylex.attrs(styles.pkmDay)}>
        <h2 {...stylex.attrs(styles.commentsH2)}>{t("web.pkm.comments.title", { n: props.view.comments.length })}</h2>
        <For each={props.view.comments} keyed={(c) => c.id}>
          {(c) => <CommentCard comment={c()} body={bodyOf(c().block)} slug={props.view.page.slug} />}
        </For>
      </section>
    </Show>
  );
}

function CommentCard(props: { comment: PkmComment; body: string; slug: string }) {
  const client = useQueryClient();
  const refreshPkm = () => refreshQueries(client);
  const router = useRouter();
  const act = createAct();
  const resolve = (accept: boolean) => {
    const { id } = props.comment;
    return act.run(async () => {
      await api.pkm.comment.resolve({ id, accept });
      toast(accept ? t("web.pkm.comments.accepted") : t("web.pkm.comments.rejected"));
      void refreshPkm();
    });
  };
  return (
    <div
      id={`comment-${props.comment.block}`}
      data-testid="pkm-comment"
      data-key={props.comment.id}
      data-status={props.comment.status}
      {...stylex.attrs(styles.pkmComment)}
    >
      <button
        type="button"
        data-testid="pkm-comment-at"
        onClick={() => router.navigate(pkmHref(props.slug, props.comment.block), { replace: true })}
        {...stylex.attrs(styles.pkmCommentAt)}
      >
        {t("web.pkm.comments.on", { span: props.comment.span ?? props.body })}
      </button>
      <p {...stylex.attrs(styles.commentCardP)}>{props.comment.body}</p>
      <Show when={props.comment.suggested}>
        {(s) => (
          <p data-testid="pkm-diff" {...stylex.attrs(styles.pkmDiff)}>
            <For each={wordDiff(props.body, s())}>
              {(d) => (
                <Switch fallback={<span>{d.text}</span>}>
                  <Match when={d.kind === "del"}>
                    <del {...stylex.attrs(styles.commentCardDel)}>{d.text}</del>
                  </Match>
                  <Match when={d.kind === "add"}>
                    <ins {...stylex.attrs(styles.commentCardIns)}>{d.text}</ins>
                  </Match>
                </Switch>
              )}
            </For>
          </p>
        )}
      </Show>
      <div {...stylex.attrs(styles.commentCardDiv)}>
        <Show when={props.comment.suggested}>
          <Button tone="primary" icon="check" data-testid="pkm-accept" disabled={act.busy()} onClick={() => void resolve(true)}>
            {t("web.pkm.comments.accept")}
          </Button>
        </Show>
        <Button icon="close" data-testid="pkm-reject" disabled={act.busy()} onClick={() => void resolve(false)}>
          {t("web.pkm.comments.reject")}
        </Button>
      </div>
    </div>
  );
}

const backlinkGroups = ["projects", "journals", "areas", "archives"] as const;

function Backlinks(props: { view: PkmPageView; pages: readonly PkmPageSummary[] }) {
  const count = () => {
    const b = props.view.backlinks;
    return b.projects.length + b.journals.length + b.areas.length + b.archives.length;
  };
  return (
    <section data-testid="pkm-backlinks" {...stylex.attrs(styles.pkmDay)}>
      <h2 {...stylex.attrs(styles.commentsH2)}>{t("web.pkm.backlinks.title", { n: count() })}</h2>
      <Show when={count() > 0} fallback={<p {...stylex.attrs(styles.backlinksP)}>{t("web.pkm.backlinks.none")}</p>}>
        <For each={backlinkGroups.filter((g) => props.view.backlinks[g].length > 0)}>
          {(g) => (
            <div {...stylex.attrs(styles.backlinksDiv)}>
              <h3 {...stylex.attrs(styles.backlinksH3)}>{t(`web.pkm.backlinks.${g}`)}</h3>
              <For each={props.view.backlinks[g]} keyed={(l) => l.block}>
                {(l) => <BacklinkRow link={l()} refs={props.view.transclusions} day={props.pages.find((p) => p.slug === l().page)?.day} />}
              </For>
            </div>
          )}
        </For>
      </Show>
    </section>
  );
}

/** The page and path are the link to the block; the body's own links stay links (an anchor cannot hold another). */
function BacklinkRow(props: { link: PkmBacklink; refs: PkmPageView["transclusions"]; day: string | undefined }) {
  return (
    <div data-testid="pkm-backlink" data-key={props.link.block} {...stylex.attrs(styles.pkmBacklink)}>
      <A href={pkmHref(props.link.page, props.link.block)} data-testid="pkm-backlink-page" {...stylex.attrs(styles.backlinkRowA)}>
        {titleFor(props.link.pageTitle, props.day)}
        <Show when={props.link.path}> › {props.link.path}</Show>
      </A>
      <span {...stylex.attrs(styles.commentCardP)}>
        <Body text={props.link.body} refs={props.refs} />
      </span>
    </div>
  );
}

function Contents(props: { view: PkmPageView }) {
  const router = useRouter();
  const tops = () => props.view.page.blocks.filter((b) => b.depth === 0 && b.body.trim() !== "");
  return (
    <Show when={tops().length >= 3}>
      <section data-testid="pkm-contents" {...stylex.attrs(styles.backlinksDiv)}>
        <h2 {...stylex.attrs(styles.commentsH2)}>{t("web.pkm.rail.contents")}</h2>
        <For each={tops()} keyed={(b) => b.id}>
          {(b) => (
            <div
              role="link"
              tabindex="0"
              data-key={b().id}
              onClick={() => router.navigate(pkmHref(props.view.page.slug, b().id), { replace: true })}
              onKeyDown={(e) => e.key === "Enter" && router.navigate(pkmHref(props.view.page.slug, b().id), { replace: true })}
              {...stylex.attrs(styles.contentsDiv)}
            >
              {/* A heading's #s come off: the list is one size. */}
              <Body text={(b().body.split("\n")[0] ?? "").replace(/^#+\s*/u, "")} refs={props.view.transclusions} />
            </div>
          )}
        </For>
      </section>
    </Show>
  );
}
