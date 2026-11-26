import { Clipboard, Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { RepoActivity, RepoLanguages, RepoSummary } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Button, ButtonLink } from "../../design/Button";
import { ConfirmButton } from "../../design/ConfirmButton";
import { Dialog } from "../../design/Dialog";
import { OpenTerminal } from "../../design/domain/OpenTerminal";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { Empty, ListCard, ListRow } from "../../design/layout";
import { Bubble } from "../../design/Tip";
import { toast } from "../../design/toasts";
import { mix } from "../../design/tone";
import { api } from "../../infra/api";
import { Keyed, useNow } from "../../infra/base/dom";
import { act as hostAct } from "../../infra/bridge";
import { readHostParams } from "../../infra/hostParams";
import { defineQuery, ready, retryRead, useQuery, useQueryClient, useRepos } from "../../infra/query";
import { useRouter } from "../../infra/router";
import { createMemo, untrack } from "../../infra/solid";
import { dateText, type Recency, recencyOf, recencyText, since } from "./calendar";
import { type Asked, CommitCalendar, Hands, Languages, NewRepoForm, Stat } from "./RepoPanels";
import { languageShares, number, sortRepos } from "./repos";

const languagesQuery = defineQuery({
  key: (id: string) => ["repo-languages", id],
  fetch: (id, context) => api.repo.language.list({ id }, context),
  ...retryRead,
});
const activityQuery = defineQuery({
  key: (id: string) => ["repo-activity", id],
  fetch: (id, context) => api.repo.activity.get({ id }, context),
  ...retryRead,
});
const useSurvey = (repo: () => string) => ({ languages: useQuery(() => languagesQuery(repo())), activity: useQuery(() => activityQuery(repo())) });

/** Recency tint for a repository card, from freshly worked (leaf) to quiet (bark). */
const recencyShade: Record<Recency, () => string> = {
  never: () => mix("bark", 0.16),
  day: () => mix("leaf", 0.35),
  week: () => mix("leaf", 0.24),
  month: () => mix("leaf", 0.14),
  quarter: () => mix("wheat", 0.24),
  older: () => mix("bark", 0.18),
};

const recencyIconTone: Record<Recency, "leaf" | "wheat" | "muted"> = {
  never: "muted",
  day: "leaf",
  week: "leaf",
  month: "leaf",
  quarter: "wheat",
  older: "muted",
};

/** A repo's recency badge tile. */
function Plot(props: { recency: Recency; size: number; label?: string }) {
  return (
    <View
      role={props.label ? "image" : undefined}
      accessibilityLabel={props.label}
      class="shrink-0 items-center justify-center rounded-md border border-line"
      style={{ width: props.size, height: props.size, backgroundColor: recencyShade[props.recency]() }}
    >
      <Icon name="repos" size={Math.max(16, Math.round(props.size * 0.45))} tone={recencyIconTone[props.recency]} />
    </View>
  );
}

/** `rest` is the path after /repos/. */
export function ReposPage(props: { rest: string }) {
  const router = useRouter();
  // A minute at a time: enough for "3h ago".
  const now = useNow(60_000);
  const list = useRepos();
  const sorted = createMemo(() => sortRepos(ready(list, [])));
  const selected = createMemo(() => sorted().find((p) => p.name === (props.rest && decodeURIComponent(props.rest))));
  const creating = signal(false);
  const createMode = signal<"local" | "new" | "github">("github");
  const openAdd = (mode: "local" | "new" | "github") => {
    createMode.set(mode);
    creating.set(true);
  };
  return (
    // The list is the page's side column, against the rail as the chat's and the notes' are (ui/layout.tsx Split edge).
    <View testID="repos-page" class="h-full min-h-0 flex-1 md:flex-row">
      <Scroll class="max-h-60 shrink-0 border-b border-line bg-side md:max-h-none md:w-70 md:border-r md:border-b-0" contentClass="px-2 py-3">
        <ListCard
          bare
          title={t("web.repo.list")}
          label={t("web.repo.list")}
          testid="repos"
          action={
            <View class="flex-row flex-wrap items-center gap-1.5">
              <If when={readHostParams().globalShell}>
                <ButtonLink href="/workspace" icon="terminal" size="compact" testID="open-workspace">
                  {t("web.repo.openWorkspace")}
                </ButtonLink>
              </If>
              <Button icon="folder" size="compact" testID="mount-local-repo" onPress={() => openAdd("local")}>
                {t("web.repo.mountLocal")}
              </Button>
              <Button icon="add" size="compact" testID="new-repo" onPress={() => openAdd("github")}>
                {t("web.repo.add")}
              </Button>
            </View>
          }
        >
          <View class="flex-row items-center justify-between px-2 pt-1 pb-1.5">
            <Text class="text-xs text-muted">{t("web.repo.repos")}</Text>
            <If when={sorted().length > 0}>
              <View class="rounded-sm bg-hover px-1.5 py-px">
                <Text class="text-2xs font-medium text-muted tabular-nums">{String(sorted().length)}</Text>
              </View>
            </If>
          </View>
          <If when={ready(list, undefined)} else={<Text class="px-2.5 pb-2 text-sm text-muted">{t("web.repo.finding")}</Text>}>
            <If when={sorted().length > 0} else={<Text class="px-2.5 pb-2 text-sm text-muted">{t("web.repo.none")}</Text>}>
              <ListRow to="/repos" item="" active={!selected()} title={t("web.repo.all")} line={t("web.repo.allLine")} />
              <Each of={sorted()} key={(p) => p.name}>
                {(p) => {
                  const recency = () => recencyText(recencyOf(p().last, now()));
                  const line = () => {
                    const last = p().last;
                    const base = !p().git ? t("web.repo.notGit") : last !== undefined ? `${recency()} · ${since(last, now())}` : recency();
                    return p().external ? `${t("web.repo.badgeLocal")} · ${base}` : base;
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
      <Scroll class="min-h-120 min-w-0 flex-1 bg-page md:min-h-0" contentClass="p-4">
        {/* Keyed by the name, a plain value: the panel's queries ask about this one repo for its life. */}
        <If when={selected()?.name} else={<ReposOverviewEmpty onMountLocal={() => openAdd("local")} />}>
          {(name) => <Keyed key={name()}>{() => <RepoPanel name={untrack(name)} repos={sorted} now={now()} />}</Keyed>}
        </If>
      </Scroll>
      <Dialog
        open={creating()}
        onClose={() => creating.set(false)}
        title={createMode() === "local" ? t("web.repo.mountLocal") : t("web.repo.add")}
        size="sm"
        height="fixed"
        scroll={false}
        testid="new-repo-dialog"
      >
        <NewRepoForm
          initialMode={createMode()}
          onDone={(made) => {
            creating.set(false);
            if (made) router.navigate(`/repos/${encodeURIComponent(made.name)}`);
          }}
        />
      </Dialog>
    </View>
  );
}

function ReposOverviewEmpty(props: { onMountLocal: () => void }) {
  return (
    <Empty
      icon="repos"
      testid="repos-empty"
      action={
        <Button icon="folder" testID="repos-empty-mount" onPress={props.onMountLocal}>
          {t("web.repo.mountLocal")}
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
  const router = useRouter();
  const client = useQueryClient();
  const unmountAct = createAct();
  const unmountRepo = async () => {
    const repoName = props.repo.name;
    const ok = await unmountAct.run(async () => {
      await api.repo.unmount({ id: repoName });
      await client.invalidate({ prefix: ["repos"] });
      return true;
    });
    if (ok === true) {
      toast(t("web.repo.unmounted", { name: repoName }));
      router.navigate("/repos");
    }
  };
  const recency = createMemo(() => recencyOf(props.repo.last, props.now));
  const counted = () => ready(props.languages, undefined);
  const worked = () => ready(props.activity, undefined);
  const lines = createMemo(() => counted()?.languages.reduce((n, l) => n + l.code + l.comments, 0));
  const notCounted = () => !!props.languages.error();
  const firstCommit = () => {
    const w = worked();
    return w?.first !== undefined ? dateText(w.first) : w ? t("web.repo.noCommits") : "…";
  };
  const codeLines = () => {
    const n = lines();
    return n !== undefined ? t("web.repo.lines", { n: number(n) }) : notCounted() ? t("web.repo.uncounted") : "…";
  };
  const languageCount = createMemo(() => {
    const c = counted();
    return c ? languageShares(c.languages, undefined).length : undefined;
  });
  const commitTotal = () => {
    const w = worked();
    return w ? t("web.repo.commits", { n: number(w.total) }) : "…";
  };
  const languageTotal = () => {
    const count = languageCount();
    return count !== undefined ? t("web.repo.kinds", { n: count }) : notCounted() ? t("web.repo.uncounted") : "…";
  };
  const busy = createMemo(() => props.languages.fetching() || props.activity.fetching());
  const badge = () => {
    switch (recency()) {
      case "day":
      case "week":
      case "month":
        return { box: "bg-ok-soft", ink: "text-ok-ink" };
      case "quarter":
        return { box: "bg-warn-soft", ink: "text-warn-ink" };
      case "older":
      case "never":
        return { box: "bg-hover", ink: "text-muted" };
    }
  };
  return (
    <View testID="repo-overview" class="flex-row flex-wrap items-center gap-4 rounded-lg border border-line bg-page p-4">
      <View class="h-24 w-24 shrink-0 items-center justify-center rounded-lg bg-hover">
        <Plot recency={recency()} size={80} label={t("web.repo.recency.label", { label: recencyText(recency()) })} />
      </View>
      <View class="min-w-0 flex-1 gap-3">
        <View class="flex-row flex-wrap items-center gap-2.5">
          <Text role="header" class="truncate text-xl font-semibold text-ink">
            {props.repo.name}
          </Text>
          <View testID="repo-origin-badge" class={`rounded-sm px-1.5 py-0.5 ${props.repo.external ? "bg-selected" : "bg-hover"}`}>
            <Text class={`text-xs font-medium ${props.repo.external ? "text-water" : "text-muted"}`}>
              {props.repo.external ? t("web.repo.badgeLocal") : t("web.repo.badgeManaged")}
            </Text>
          </View>
          <View class={`rounded-sm px-1.5 py-0.5 ${badge().box}`}>
            <Text class={`text-xs font-medium ${badge().ink}`}>{recencyText(recency())}</Text>
          </View>
        </View>
        <View class="flex-row flex-wrap gap-x-6 gap-y-2">
          <Stat label={t("web.repo.firstCommit")} value={firstCommit()} />
          <Stat label={t("web.repo.commitCount")} value={commitTotal()} />
          <Stat label={t("web.repo.code")} value={codeLines()} />
          <Stat label={t("web.repo.languages")} value={languageTotal()} />
        </View>
        <View class="flex-row flex-wrap items-center gap-1.5">
          <Icon name="folder" size={14} tone="muted" />
          <View class="min-w-0 shrink" tooltip={<Bubble text={props.repo.path} />}>
            <Text class="truncate font-mono text-xs text-muted">{props.repo.path}</Text>
          </View>
          <IconButton icon="copy" size={14} testid="repo-copy" label={t("web.repo.copyPath")} onClick={() => void copyPath(props.repo.path)} />
          <OpenTerminal cwd={props.repo.path} title={props.repo.name} testid="repo-terminal" />
          <If when={readHostParams().globalShell}>
            <Button size="compact" icon="terminal" testID="repo-open-workspace" onPress={() => hostAct({ type: "activate_path", path: props.repo.path })}>
              {t("web.repo.openWorkspace")}
            </Button>
          </If>
        </View>
      </View>
      <View class="items-end gap-1.5">
        <View class="flex-row items-center gap-1.5">
          <If when={props.repo.external}>
            <ConfirmButton
              testid="repo-unmount"
              icon="close"
              tone="danger"
              label={unmountAct.busy() ? t("web.repo.unmounting") : t("web.repo.unmount")}
              title={t("web.repo.unmountTip")}
              disabled={unmountAct.busy()}
              onConfirm={unmountRepo}
            />
          </If>
          <IconButton
            icon="refresh"
            testid="repo-recount"
            label={busy() ? t("web.repo.counting") : t("web.repo.recount")}
            disabled={busy()}
            onClick={() => {
              void Promise.allSettled([props.languages.refetch(), props.activity.refetch()]);
            }}
          />
        </View>
        <If when={counted()}>{(c) => <Text class="text-xs tabular-nums text-faint">{t("web.repo.countedAgo", { ago: since(c().at, props.now) })}</Text>}</If>
      </View>
    </View>
  );
}
