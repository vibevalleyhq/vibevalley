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

const viewStyles = stylex.create({
  pkmDay: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2)",
  },
  shownH2: {
    fontSize: "var(--text-lg)",
    lineHeight: "var(--text-lg--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  shownArticle: {
    marginInline: "auto",
    display: "flex",
    width: "100%",
    maxWidth: "var(--container-3xl)",
    minWidth: "0",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 4)",
    paddingInline: "calc(var(--spacing) * 4)",
    paddingBlock: "calc(var(--spacing) * 4)",
  },
  pkmRail: {
    marginInline: {
      default: "auto",
      "@media (width>=80rem)": "0",
    },
    display: "flex",
    width: {
      default: "100%",
      "@media (width>=80rem)": "calc(var(--spacing) * 72)",
    },
    maxWidth: "var(--container-3xl)",
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
    gap: "calc(var(--spacing) * 2)",
  },
  pkmTitle: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xl)",
    lineHeight: "calc(var(--spacing) * 8)",
    fontWeight: "var(--font-weight-semibold)",
  },
  headerP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-muted)",
  },
  pkmProps: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 1.5)",
  },
  propsDiv: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: "calc(var(--spacing) * 3)",
    rowGap: "var(--spacing)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  pkmProp: {
    display: "inline-flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
  },
  pkmProp2: {
    color: "var(--wb-muted)",
  },
  pkmProp3: {
    borderRadius: "2147483647px",
    backgroundColor: "var(--wb-hover)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * .5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  pkmPropsMore: {
    cursor: "pointer",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: {
      default: "var(--wb-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-ink)",
      },
    },
  },
  propsDl: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    columnGap: "calc(var(--spacing) * 3)",
    rowGap: "calc(var(--spacing) * .5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  commentsH2: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--wb-muted)",
  },
  pkmComment: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 1.5)",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
    padding: "calc(var(--spacing) * 2.5)",
  },
  pkmCommentAt: {
    cursor: "pointer",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textAlign: "left",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: {
      default: "var(--wb-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-ink)",
      },
    },
  },
  commentCardP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  pkmDiff: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    whiteSpace: "pre-wrap",
  },
  commentCardDel: {
    backgroundColor: "var(--wb-bad-soft)",
    color: "var(--wb-berry)",
  },
  commentCardIns: {
    backgroundColor: "var(--wb-ok-soft)",
    color: "var(--wb-ok-ink)",
    textDecorationLine: "none",
  },
  commentCardDiv: {
    display: "flex",
    gap: "calc(var(--spacing) * 1.5)",
    alignSelf: "flex-end",
  },
  backlinksP: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-faint)",
  },
  backlinksDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * .5)",
  },
  backlinksH3: {
    fontSize: "var(--text-2xs)",
    lineHeight: "var(--text-2xs--line-height)",
    color: "var(--wb-faint)",
  },
  pkmBacklink: {
    display: "flex",
    flexDirection: "column",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * 1.5)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
      },
    },
  },
  contentsDiv: {
    cursor: "pointer",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * .5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: {
      default: "var(--wb-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-ink)",
      },
    },
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
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
        <article data-testid="pkm-day" data-key={page().slug} {...stylex.attrs(viewStyles.pkmDay)}>
          <h2 {...stylex.attrs(viewStyles.shownH2)}>
            <A href={pkmHref(page().slug)} class="hover:underline">
              {titleFor(page().title, props.summary?.day)}
            </A>
          </h2>
          {outline()}
        </article>
      }
    >
      <div data-testid="pkm-page" data-key={page().slug} class="flex min-h-0 flex-1 flex-col overflow-y-auto xl:flex-row xl:items-start">
        <article {...stylex.attrs(viewStyles.shownArticle)}>
          <Header view={props.view} summary={props.summary} />
          {outline()}
        </article>
        <Show when={rail.get()}>
          <aside aria-label={t("web.pkm.rail.label")} data-testid="pkm-rail" {...stylex.attrs(viewStyles.pkmRail)}>
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
    <header {...stylex.attrs(viewStyles.pkmDay)}>
      <div {...stylex.attrs(viewStyles.headerDiv)}>
        <Button icon="back" onClick={() => router.navigate("/pkm")}>
          {t("web.pkm.list.today")}
        </Button>
      </div>
      <div {...stylex.attrs(viewStyles.headerDiv2)}>
        <h1 data-testid="pkm-title" {...stylex.attrs(viewStyles.pkmTitle)}>
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
        <p {...stylex.attrs(viewStyles.headerP)}>{page().tldr}</p>
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
      <div data-testid="pkm-props" {...stylex.attrs(viewStyles.pkmProps)}>
        <div {...stylex.attrs(viewStyles.propsDiv)}>
          <Show when={value("status")}>
            {(s) => (
              <span data-testid="pkm-prop" data-key="status" {...stylex.attrs(viewStyles.pkmProp)}>
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
                class={[(d().left ?? 1) < 0 ? "text-berry" : (d().left ?? 99) <= 3 ? "text-warn-ink" : "text-muted"]}
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
              <span data-testid="pkm-prop" data-key={k} {...stylex.attrs(viewStyles.pkmProp2)}>
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
              <span data-testid="pkm-prop" data-key="tags" {...stylex.attrs(viewStyles.pkmProp3)}>
                <Body text={tag.startsWith("#") || tag.startsWith("[[") ? tag : `[[${tag}]]`} refs={props.view.transclusions} />
              </span>
            )}
          </For>
          <Show when={rest().length > 0}>
            <button type="button" data-testid="pkm-props-more" onClick={() => setAll((a) => !a)} {...stylex.attrs(viewStyles.pkmPropsMore)}>
              {all() ? t("web.pkm.props.fewer") : t("web.pkm.props.more", { n: rest().length })}
            </button>
          </Show>
        </div>
        <Show when={all()}>
          <dl {...stylex.attrs(viewStyles.propsDl)}>
            <For each={rest()} keyed={([k]) => k}>
              {(entry) => (
                <>
                  <dt {...stylex.attrs(viewStyles.pkmProp2)}>{entry()[0]}</dt>
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
      <section data-testid="pkm-comments" {...stylex.attrs(viewStyles.pkmDay)}>
        <h2 {...stylex.attrs(viewStyles.commentsH2)}>{t("web.pkm.comments.title", { n: props.view.comments.length })}</h2>
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
      {...stylex.attrs(viewStyles.pkmComment)}
    >
      <button
        type="button"
        data-testid="pkm-comment-at"
        onClick={() => router.navigate(pkmHref(props.slug, props.comment.block), { replace: true })}
        {...stylex.attrs(viewStyles.pkmCommentAt)}
      >
        {t("web.pkm.comments.on", { span: props.comment.span ?? props.body })}
      </button>
      <p {...stylex.attrs(viewStyles.commentCardP)}>{props.comment.body}</p>
      <Show when={props.comment.suggested}>
        {(s) => (
          <p data-testid="pkm-diff" {...stylex.attrs(viewStyles.pkmDiff)}>
            <For each={wordDiff(props.body, s())}>
              {(d) => (
                <Switch fallback={<span>{d.text}</span>}>
                  <Match when={d.kind === "del"}>
                    <del {...stylex.attrs(viewStyles.commentCardDel)}>{d.text}</del>
                  </Match>
                  <Match when={d.kind === "add"}>
                    <ins {...stylex.attrs(viewStyles.commentCardIns)}>{d.text}</ins>
                  </Match>
                </Switch>
              )}
            </For>
          </p>
        )}
      </Show>
      <div {...stylex.attrs(viewStyles.commentCardDiv)}>
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
    <section data-testid="pkm-backlinks" {...stylex.attrs(viewStyles.pkmDay)}>
      <h2 {...stylex.attrs(viewStyles.commentsH2)}>{t("web.pkm.backlinks.title", { n: count() })}</h2>
      <Show when={count() > 0} fallback={<p {...stylex.attrs(viewStyles.backlinksP)}>{t("web.pkm.backlinks.none")}</p>}>
        <For each={backlinkGroups.filter((g) => props.view.backlinks[g].length > 0)}>
          {(g) => (
            <div {...stylex.attrs(viewStyles.backlinksDiv)}>
              <h3 {...stylex.attrs(viewStyles.backlinksH3)}>{t(`web.pkm.backlinks.${g}`)}</h3>
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
    <div data-testid="pkm-backlink" data-key={props.link.block} {...stylex.attrs(viewStyles.pkmBacklink)}>
      <A href={pkmHref(props.link.page, props.link.block)} data-testid="pkm-backlink-page" class="truncate text-xs text-muted hover:text-ink hover:underline">
        {titleFor(props.link.pageTitle, props.day)}
        <Show when={props.link.path}> › {props.link.path}</Show>
      </A>
      <span {...stylex.attrs(viewStyles.commentCardP)}>
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
      <section data-testid="pkm-contents" {...stylex.attrs(viewStyles.backlinksDiv)}>
        <h2 {...stylex.attrs(viewStyles.commentsH2)}>{t("web.pkm.rail.contents")}</h2>
        <For each={tops()} keyed={(b) => b.id}>
          {(b) => (
            <div
              role="link"
              tabindex="0"
              data-key={b().id}
              onClick={() => router.navigate(pkmHref(props.view.page.slug, b().id), { replace: true })}
              onKeyDown={(e) => e.key === "Enter" && router.navigate(pkmHref(props.view.page.slug, b().id), { replace: true })}
              {...stylex.attrs(viewStyles.contentsDiv)}
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
