// Ported from VibeValley apps/web/src/features/repo/ReposPage.tsx: the
// repos as the page's side list, one repo's overview, languages, commit
// calendar and hands beside it, and the new repo dialog. Not ported: the
// skin (`skin={repoMap}` in VibeValley's App.tsx), the farm's map of every
// repo and the map's head over one repo; the farm is the GPUI app's
// (docs/vibevalley-port.md § Architecture 5), so with no repo open the
// page offers the farm instead. A repo's picture is the map's crop for how
// recently it was worked (a tile in that shade without the art). VibeValley adds: a terminal at the
// repo's folder.
import { Clipboard, Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { RepoActivity, RepoLanguages, RepoSummary } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { act as shellAct } from "../../../../bridge";
import { createMemo, untrack } from "../../../solid";
import { Keyed, useNow } from "../../base/dom";
import { api } from "../../infra/api";
import { defineQuery, ready, retryRead, useQuery, useRepos } from "../../infra/query";
import { useRouter } from "../../infra/router";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { OpenTerminal } from "../../ui/domain/OpenTerminal";
import { Icon } from "../../ui/Icon";
import { IconButton } from "../../ui/IconButton";
import { Empty, ListCard, ListRow } from "../../ui/layout";
import { SpriteOr } from "../../ui/pixel/icons";
import { Bubble } from "../../ui/Tip";
import { toast } from "../../ui/toasts";
import { mix } from "../../ui/tone";
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

/** The map's crops (plot-flowering … plot-withered) as the shade of their bed, so a repo reads the same in both. */
const recencyShade: Record<Recency, () => string> = {
  never: () => mix("bark", 0.25),
  day: () => mix("leaf", 0.95),
  week: () => mix("leaf", 0.7),
  month: () => mix("leaf", 0.45),
  quarter: () => mix("wheat", 0.55),
  older: () => mix("bark", 0.55),
};

/** A repo's picture: its bed, as green as it was worked recently. */
function Plot(props: { recency: Recency; size: number; label?: string }) {
  return (
    <SpriteOr name={recencyPicture[props.recency]} size={props.size} label={props.label}>
      <PlotStandIn {...props} />
    </SpriteOr>
  );
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

function PlotStandIn(props: { recency: Recency; size: number; label?: string }) {
  return (
    <View
      role={props.label ? "image" : undefined}
      accessibilityLabel={props.label}
      class="shrink-0 rounded-md border-2"
      style={{ width: props.size, height: props.size, backgroundColor: recencyShade[props.recency](), borderColor: mix("bark", 0.5) }}
    />
  );
}

/** `rest` is the path after /repos/. */
export function ReposPage(props: { rest: string }) {
  const router = useRouter();
  // A minute at a time: enough for "3h ago".
  const now = useNow(60_000);
  const list = useRepos();
  const sorted = () => sortRepos(ready(list, []));
  const selected = () => sorted().find((p) => p.name === (props.rest && decodeURIComponent(props.rest)));
  const creating = signal(false);
  return (
    // The list is the page's side column, against the rail as the chat's and the notes' are (ui/layout.tsx Split edge).
    <View testID="repos-page" class="h-full min-h-0 flex-1 md:flex-row">
      <Scroll class="max-h-60 shrink-0 border-b border-line bg-side md:max-h-none md:w-72 md:border-r md:border-b-0" contentClass="px-2 py-3">
        <ListCard
          bare
          title={t("web.repo.title")}
          label={t("web.repo.list")}
          testid="repos"
          action={
            <Button icon="add" testID="new-repo" onPress={() => creating.set(true)}>
              {t("web.repo.add")}
            </Button>
          }
        >
          <Text class="px-2.5 pt-1 pb-1.5 text-xs text-muted">{t("web.repo.repos")}</Text>
          <If when={ready(list, undefined)} else={<Text class="px-2.5 pb-2 text-sm text-muted">{t("web.repo.finding")}</Text>}>
            <If when={sorted().length > 0} else={<Text class="px-2.5 pb-2 text-sm text-muted">{t("web.repo.none")}</Text>}>
              <ListRow to="/repos" item="" active={!selected()} title={t("web.repo.all")} line={t("web.repo.allLine")} />
              <Each of={sorted()} key={(p) => p.name}>
                {(p) => {
                  const recency = () => recencyText(recencyOf(p().last, now()));
                  const line = () => {
                    const last = p().last;
                    return !p().git ? t("web.repo.notGit") : last !== undefined ? `${recency()} · ${since(last, now())}` : recency();
                  };
                  return (
                    <ListRow
                      to={`/repos/${encodeURIComponent(p().name)}`}
                      item={p().name}
                      active={p().name === selected()?.name}
                      title={p().name}
                      line={line()}
                      leading={<Plot recency={recencyOf(p().last, now())} size={40} />}
                    />
                  );
                }}
              </Each>
            </If>
          </If>
        </ListCard>
      </Scroll>
      <Scroll class="min-h-120 min-w-0 flex-1 md:min-h-0" contentClass="p-3">
        {/* Keyed by the name, a plain value: the panel's queries ask about this one repo for its life. */}
        <If when={selected()?.name} else={<FarmInstead />}>
          {(name) => <Keyed key={name()}>{() => <RepoPanel name={untrack(name)} repos={sorted} now={now()} />}</Keyed>}
        </If>
      </Scroll>
      <Dialog open={creating()} onClose={() => creating.set(false)} title={t("web.repo.add")} testid="new-repo-dialog">
        <NewRepoForm
          onDone={(made) => {
            creating.set(false);
            if (made) router.navigate(`/repos/${encodeURIComponent(made.name)}`);
          }}
        />
      </Dialog>
    </View>
  );
}

/** The farm's map of every repo is the app's own pixel view, not a page. */
function FarmInstead() {
  return (
    <Empty
      icon="farm"
      testid="repos-map"
      action={
        <Button icon="farm" onPress={() => shellAct({ type: "openFarm", repo: "" })}>
          {t("web.base.farm")}
        </Button>
      }
    >
      {t("web.repo.allLine")}
    </Empty>
  );
}

function RepoPanel(props: { name: string; repos: () => RepoSummary[]; now: number }) {
  const repo = createMemo<RepoSummary | undefined>((last) => props.repos().find((p) => p.name === props.name) ?? last);
  return (
    <View testID="repo" class="max-w-4xl gap-3">
      <If when={repo()}>{(p) => <Details repo={p()} now={props.now} />}</If>
    </View>
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
    await Clipboard.writeText(path);
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
  const notCounted = () => !!props.languages.error();
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
  return (
    <View testID="repo-overview" class="flex-row flex-wrap items-center gap-4 rounded-lg border border-line bg-page p-4">
      <View class="h-24 w-24 shrink-0 items-center justify-center rounded-lg bg-hover">
        <Plot recency={recency()} size={80} label={t("web.repo.recency.label", { label: recencyText(recency()) })} />
      </View>
      <View class="min-w-0 flex-1 gap-3">
        <View class="flex-row flex-wrap items-center gap-3">
          <Text role="header" class="truncate text-xl font-semibold text-ink">
            {props.repo.name}
          </Text>
          <View class="rounded-sm px-1.5" style={{ backgroundColor: mix("leaf", 0.3) }}>
            <Text class="text-xs text-ink">{recencyText(recency())}</Text>
          </View>
        </View>
        <View class="flex-row flex-wrap gap-x-6 gap-y-2">
          <Stat label={t("web.repo.firstCommit")} value={firstCommit()} />
          <Stat label={t("web.repo.commitCount")} value={commitTotal()} />
          <Stat label={t("web.repo.code")} value={codeLines()} />
          <Stat label={t("web.repo.languages")} value={languageTotal()} />
        </View>
        <View class="flex-row items-center gap-1.5">
          <Icon name="folder" size={14} />
          <View class="min-w-0 shrink" tooltip={<Bubble text={props.repo.path} />}>
            <Text class="truncate font-mono text-xs text-muted">{props.repo.path}</Text>
          </View>
          <IconButton icon="copy" size={14} testid="repo-copy" label={t("web.repo.copyPath")} onClick={() => void copyPath(props.repo.path)} />
          <OpenTerminal cwd={props.repo.path} title={props.repo.name} testid="repo-terminal" />
        </View>
      </View>
      <View class="items-end gap-1">
        <IconButton
          icon="refresh"
          testid="repo-recount"
          label={busy() ? t("web.repo.counting") : t("web.repo.recount")}
          disabled={busy()}
          onClick={() => {
            void Promise.allSettled([props.languages.refetch(), props.activity.refetch()]);
          }}
        />
        <If when={counted()}>{(c) => <Text class="text-xs text-muted">{t("web.repo.countedAgo", { ago: since(c().at, props.now) })}</Text>}</If>
      </View>
    </View>
  );
}
