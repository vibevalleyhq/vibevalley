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
    <div class="flex h-full min-h-0 flex-col md:flex-row overflow-y-auto md:overflow-y-hidden md:overflow-x-hidden">
      <div class="max-h-60 md:max-h-none shrink-0 overflow-y-auto md:[border-bottom-style:solid] border-b md:border-b-0 border-line bg-side px-2 py-3 md:w-72 md:[border-right-style:solid] md:border-r">
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
          <li class="px-2.5 pt-1 pb-1.5 text-xs text-muted">{t("web.repo.repos")}</li>
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
              <li class="px-2.5 pb-2 text-sm text-muted">{t("web.repo.finding")}</li>
            </Match>
            <Match when={sorted().length === 0}>
              <li class="px-2.5 pb-2 text-sm text-muted">{t("web.repo.none")}</li>
            </Match>
          </Switch>
        </ListCard>
      </div>
      <div class="flex min-h-120 md:min-h-0 min-w-0 flex-1 flex-col p-3">
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
    <div data-testid="repo" data-key={props.name} class="flex max-w-4xl flex-col gap-3 md:overflow-y-auto">
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
    <section class="flex flex-wrap items-center gap-4 rounded-lg border border-line bg-page p-4">
      <span class="flex w-24 h-24 shrink-0 items-center justify-center rounded-lg bg-hover">
        <SpriteIcon name={recencyPicture[recency()]} size={80} label={t("web.repo.recency.label", { label: recencyText(recency()) })} />
      </span>
      <div class="flex min-w-0 flex-1 flex-col gap-3">
        <div class="flex flex-wrap items-center gap-3">
          <h2 class="truncate text-xl font-semibold">{props.repo.name}</h2>
          <span class="rounded-sm bg-leaf-300/50 px-1.5 text-xs">{recencyText(recency())}</span>
        </div>
        <div class="flex flex-wrap gap-x-6 gap-y-2">
          <Stat label={t("web.repo.firstCommit")} value={firstCommit()} />
          <Stat label={t("web.repo.commitCount")} value={commitTotal()} />
          <Stat label={t("web.repo.code")} value={codeLines()} />
          <Stat label={t("web.repo.languages")} value={languageTotal()} />
        </div>
        <div class="flex items-center gap-1.5">
          <Icon name="folder" size={14} />
          <span class="min-w-0 truncate font-mono text-xs text-muted" title={props.repo.path}>
            {props.repo.path}
          </span>
          <button
            type="button"
            title={t("web.repo.copyPath")}
            aria-label={t("web.repo.copyPath")}
            class="cursor-pointer rounded-sm p-1 hover:bg-hover"
            onClick={() => void copyPath(props.repo.path)}
          >
            <Icon name="copy" size={14} />
          </button>
        </div>
      </div>
      <div class="flex flex-col items-end gap-1">
        <button
          type="button"
          title={busy() ? t("web.repo.counting") : t("web.repo.recount")}
          aria-label={t("web.repo.recount")}
          disabled={busy()}
          onClick={() => {
            void Promise.allSettled([props.languages.refetch(), props.activity.refetch()]);
          }}
          class="cursor-pointer rounded-md border border-line p-1.5 hover:bg-hover disabled:opacity-50"
        >
          <Icon name="refresh" size={16} />
        </button>
        <Show when={counted()}>{(c) => <span class="text-xs text-muted">{t("web.repo.countedAgo", { ago: since(c().at, props.now) })}</span>}</Show>
      </div>
    </section>
  );
}
