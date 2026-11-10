import * as stylex from "@stylexjs/stylex";
import { type Component, createMemo, createSignal, For, Match, Show, Switch, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { RepoActivity, RepoLanguages, RepoSummary } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { useNow } from "#/base/dom.tsx";
import { api } from "#/infra/api.ts";
import { defineQuery, retryRead, ready, useRepos, useQuery } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { Button } from "#/ui/Button.tsx";
import { Dialog } from "#/ui/Dialog.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { ListCard, ListRow } from "#/ui/layout.tsx";
import { SpriteIcon } from "#/ui/pixel/index.ts";
import { toast } from "#/ui/toasts.ts";

import { dateText, type Recency, recencyOf, recencyText, since } from "./calendar";
import { type Asked, CommitCalendar, Hands, Languages, NewRepoForm, Stat } from "./RepoPanels";
import { languageShares, number, sortRepos } from "./repos";

const styles = stylex.create({
  reposPageDiv: {
    display: "flex",
    height: "100%",
    minHeight: "0",
    flexDirection: {
      default: "column",
      "@media (width>=48rem)": "row",
    },
    overflowY: {
      default: "auto",
      "@media (width>=48rem)": "hidden",
    },
    overflowX: {
      default: null,
      "@media (width>=48rem)": "hidden",
    },
  },
  overviewSpan: {
    borderRadius: "var(--radius-sm)",
    backgroundColor: {
      default: "var(--color-px-leaf-soft)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-leaf-300) 50%, transparent)",
    },
    paddingInline: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  reposPageDiv2: {
    display: "flex",
    minHeight: {
      default: "480px",
      "@media (width>=48rem)": "0",
    },
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
    padding: "calc(var(--spacing) * 3)",
  },
  overviewDiv: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
  },
  reposPageDiv3: {
    maxHeight: {
      default: "calc(var(--spacing) * 60)",
      "@media (width>=48rem)": "none",
    },
    flexShrink: "0",
    overflowY: "auto",
    borderBottomStyle: {
      default: "solid",
      "@media (width>=48rem)": "solid",
    },
    borderBottomWidth: {
      default: "1px",
      "@media (width>=48rem)": "0",
    },
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-side)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * 3)",
    width: {
      default: null,
      "@media (width>=48rem)": "calc(var(--spacing) * 72)",
    },
    borderRightStyle: {
      default: null,
      "@media (width>=48rem)": "solid",
    },
    borderRightWidth: {
      default: null,
      "@media (width>=48rem)": "1px",
    },
  },
  reposPageLi: {
    paddingInline: "calc(var(--spacing) * 2.5)",
    paddingTop: "var(--spacing)",
    paddingBottom: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  reposPageLi2: {
    paddingInline: "calc(var(--spacing) * 2.5)",
    paddingBottom: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
  },
  repo: {
    display: "flex",
    maxWidth: "var(--container-4xl)",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
    overflowY: {
      default: null,
      "@media (width>=48rem)": "auto",
    },
  },
  overviewSection: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 4)",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    padding: "calc(var(--spacing) * 4)",
  },
  overviewSpan2: {
    display: "flex",
    width: "calc(var(--spacing) * 24)",
    height: "calc(var(--spacing) * 24)",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-lg)",
    backgroundColor: "var(--color-hover)",
  },
  overviewDiv2: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 3)",
  },
  overviewH2: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xl)",
    lineHeight: "var(--text-xl--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  overviewDiv22: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: "calc(var(--spacing) * 6)",
    rowGap: "calc(var(--spacing) * 2)",
  },
  overviewDiv3: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
  },
  overviewSpan22: {
    minWidth: "0",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  overviewButton: {
    cursor: "pointer",
    borderRadius: "var(--radius-sm)",
    padding: "var(--spacing)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  overviewDiv4: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "var(--spacing)",
  },
  overviewButton2: {
    cursor: "pointer",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    padding: "calc(var(--spacing) * 1.5)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
    opacity: {
      default: null,
      ":disabled": ".5",
    },
  },
  overviewSpan3: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
});

const languagesQuery = defineQuery({
  schema: S.RepoLanguages,
  key: (id: string) => ["repo-languages", id],
  fetch: (id, context) => api.repo.language.list({ id }, context),
  ...retryRead,
});
const activityQuery = defineQuery({
  schema: S.RepoActivity,
  key: (id: string) => ["repo-activity", id],
  fetch: (id, context) => api.repo.activity.get({ id }, context),
  ...retryRead,
});
const useSurvey = (repo: () => string) => ({ languages: useQuery(() => languagesQuery(repo())), activity: useQuery(() => activityQuery(repo())) });

/** What a skin draws on this page; app/ hands it in, since a feature never reads a skin. */
export interface ReposSkin {
  /** every repo at once. */
  readonly Map: Component;
  /** Over one repo's overview. */
  readonly Head: Component<{ name: string }>;
  /** A sprite's name. */
  readonly picture: (repo: string) => string;
}

/** The map's crops, so a repo looks the same in both. */
const recencyPicture: Record<Recency, string> = {
  never: "plot-empty",
  day: "plot-flowering",
  week: "plot-leafy",
  month: "plot-sprout",
  quarter: "plot-dry",
  older: "plot-withered",
};

/** `rest` is the path after /repos/. */
export function ReposPage(props: { rest: string; skin: ReposSkin }) {
  const router = useRouter();
  // A minute at a time: enough for "3h ago".
  const now = useNow(60_000);
  const list = useRepos();
  const sorted = () => sortRepos(ready(list, []));
  const selected = () => sorted().find((p) => p.name === (props.rest && decodeURIComponent(props.rest)));
  const [creating, setCreating] = createSignal(false);
  return (
    // The list is the page's side column, against the rail as the chat's and the notes' are (ui/layout.tsx Split edge).
    <div {...stylex.attrs(styles.reposPageDiv)}>
      <div {...stylex.attrs(styles.reposPageDiv3)}>
        <ListCard
          bare
          title={t("web.repo.title")}
          label={t("web.repo.list")}
          testid="repos"
          action={
            <Button icon="add" data-testid="new-repo" onClick={() => setCreating(true)}>
              {t("web.repo.add")}
            </Button>
          }
        >
          <li {...stylex.attrs(styles.reposPageLi)}>{t("web.repo.repos")}</li>
          <Switch
            fallback={
              <>
                <ListRow to="/repos" item="" active={!selected()} title={t("web.repo.all")} line={t("web.repo.allLine")} />
                <For each={sorted()}>
                  {(p) => {
                    const recency = () => recencyText(recencyOf(p.last, now()));
                    const line = () => (!p.git ? t("web.repo.notGit") : p.last !== undefined ? `${recency()} · ${since(p.last, now())}` : recency());
                    return (
                      <ListRow
                        to={`/repos/${encodeURIComponent(p.name)}`}
                        item={p.name}
                        active={p.name === selected()?.name}
                        title={p.name}
                        line={line()}
                        leading={<SpriteIcon name={props.skin.picture(p.name)} size={40} />}
                      />
                    );
                  }}
                </For>
              </>
            }
          >
            <Match when={!ready(list, undefined)}>
              <li {...stylex.attrs(styles.reposPageLi2)}>{t("web.repo.finding")}</li>
            </Match>
            <Match when={sorted().length === 0}>
              <li {...stylex.attrs(styles.reposPageLi2)}>{t("web.repo.none")}</li>
            </Match>
          </Switch>
        </ListCard>
      </div>
      <div {...stylex.attrs(styles.reposPageDiv2)}>
        {/* Keyed by the name, a plain value: the panel's queries are still settling when the page moves back to the map, and a read through a narrowed accessor then would halt the page. */}
        <Show when={selected()?.name} keyed fallback={<props.skin.Map />}>
          {(name) => <RepoPanel name={name} repos={sorted} now={now()} Head={props.skin.Head} />}
        </Show>
      </div>
      <Dialog open={creating()} onClose={() => setCreating(false)} title={t("web.repo.add")} testid="new-repo-dialog">
        <NewRepoForm
          onDone={(made) => {
            setCreating(false);
            if (made) router.navigate(`/repos/${encodeURIComponent(made.name)}`);
          }}
        />
      </Dialog>
    </div>
  );
}

function RepoPanel(props: { name: string; repos: () => RepoSummary[]; now: number; Head: ReposSkin["Head"] }) {
  const repo = createMemo<RepoSummary | undefined>((last) => props.repos().find((p) => p.name === props.name) ?? last);
  return (
    <div data-testid="repo" data-key={props.name} {...stylex.attrs(styles.repo)}>
      <props.Head name={props.name} />
      <Show when={repo()}>{(p) => <Details repo={p()} now={props.now} />}</Show>
    </div>
  );
}

function Details(props: { repo: RepoSummary; now: number }) {
  // Keyed by the name: the queries ask about this one repo for the panel's life.
  const name = untrack(() => props.repo.name);
  const survey = useSurvey(() => name);
  return (
    <>
      <Overview repo={props.repo} languages={survey.languages} activity={survey.activity} now={props.now} />
      <Languages languages={survey.languages} />
      <CommitCalendar activity={survey.activity} />
      <Hands activity={ready(survey.activity, undefined)} />
    </>
  );
}

async function copyPath(path: string) {
  try {
    await navigator.clipboard.writeText(path);
    toast(t("web.repo.copied", { path }));
  } catch {
    toast(t("web.repo.notCopied"));
  }
}

function Overview(props: { repo: RepoSummary; languages: Asked<RepoLanguages>; activity: Asked<RepoActivity>; now: number }) {
  const recency = () => recencyOf(props.repo.last, props.now);
  const counted = () => ready(props.languages, undefined);
  const worked = () => ready(props.activity, undefined);
  const lines = () => counted()?.languages.reduce((n, l) => n + l.code + l.comments, 0);
  const firstCommit = () => {
    const w = worked();
    return w?.first !== undefined ? dateText(w.first) : w ? t("web.repo.noCommits") : "…";
  };
  const codeLines = () => {
    const n = lines();
    return n !== undefined ? t("web.repo.lines", { n: number(n) }) : notCounted() ? t("web.repo.uncounted") : "…";
  };
  const languageCount = () => {
    const c = counted();
    return c ? languageShares(c.languages, undefined).length : undefined;
  };
  const commitTotal = () => {
    const w = worked();
    return w ? t("web.repo.commits", { n: number(w.total) }) : "…";
  };
  const languageTotal = () => {
    const count = languageCount();
    return count !== undefined ? t("web.repo.kinds", { n: count }) : notCounted() ? t("web.repo.uncounted") : "…";
  };
  const busy = () => props.languages.fetching() || props.activity.fetching();
  const notCounted = () => !!props.languages.error();
  return (
    <section {...stylex.attrs(styles.overviewSection)}>
      <span {...stylex.attrs(styles.overviewSpan2)}>
        <SpriteIcon name={recencyPicture[recency()]} size={80} label={t("web.repo.recency.label", { label: recencyText(recency()) })} />
      </span>
      <div {...stylex.attrs(styles.overviewDiv)}>
        <div {...stylex.attrs(styles.overviewDiv2)}>
          <h2 {...stylex.attrs(styles.overviewH2)}>{props.repo.name}</h2>
          <span {...stylex.attrs(styles.overviewSpan)}>{recencyText(recency())}</span>
        </div>
        <div {...stylex.attrs(styles.overviewDiv22)}>
          <Stat label={t("web.repo.firstCommit")} value={firstCommit()} />
          <Stat label={t("web.repo.commitCount")} value={commitTotal()} />
          <Stat label={t("web.repo.code")} value={codeLines()} />
          <Stat label={t("web.repo.languages")} value={languageTotal()} />
        </div>
        <div {...stylex.attrs(styles.overviewDiv3)}>
          <Icon name="folder" size={14} />
          <span {...stylex.attrs(styles.overviewSpan22)} title={props.repo.path}>
            {props.repo.path}
          </span>
          <button
            type="button"
            title={t("web.repo.copyPath")}
            aria-label={t("web.repo.copyPath")}
            {...stylex.attrs(styles.overviewButton)}
            onClick={() => void copyPath(props.repo.path)}
          >
            <Icon name="copy" size={14} />
          </button>
        </div>
      </div>
      <div {...stylex.attrs(styles.overviewDiv4)}>
        <button
          type="button"
          title={busy() ? t("web.repo.counting") : t("web.repo.recount")}
          aria-label={t("web.repo.recount")}
          disabled={busy()}
          onClick={() => {
            void Promise.allSettled([props.languages.refetch(), props.activity.refetch()]);
          }}
          {...stylex.attrs(styles.overviewButton2)}
        >
          <Icon name="refresh" size={16} />
        </button>
        <Show when={counted()}>
          {(c) => <span {...stylex.attrs(styles.overviewSpan3)}>{t("web.repo.countedAgo", { ago: since(c().at, props.now) })}</span>}
        </Show>
      </div>
    </section>
  );
}
