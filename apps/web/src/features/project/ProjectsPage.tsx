import { type Component, createMemo, createSignal, For, Match, Show, Switch, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { ProjectActivity, ProjectLanguages, ProjectSummary } from "@vibevalley/protocol";

import { useNow } from "#/base/dom.tsx";
import { api } from "#/infra/api.ts";
import { ready, useProjects, useQuery } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { Button } from "#/ui/Button.tsx";
import { Dialog } from "#/ui/Dialog.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { ListCard, ListRow } from "#/ui/layout.tsx";
import { SpriteIcon } from "#/ui/pixel/index.ts";
import { toast } from "#/ui/toasts.ts";

import { dateText, type Recency, recencyOf, recencyText, since } from "./calendar";
import { type Asked, CommitCalendar, Hands, Languages, NewProjectForm, Stat } from "./ProjectPanels";
import { languageShares, number, sortProjects } from "./projects";

const useSurvey = (project: () => string) => ({
  languages: useQuery(() => ({
    queryKey: ["project-languages", project()],
    queryFn: () => api.project.language.list({ id: project() }),
    placeholderData: (p: ProjectLanguages | undefined) => p,
  })),
  activity: useQuery(() => ({
    queryKey: ["project-activity", project()],
    queryFn: () => api.project.activity.get({ id: project() }),
    placeholderData: (p: ProjectActivity | undefined) => p,
  })),
});

/** What a skin draws on this page; app/ hands it in, since a feature never reads a skin. */
export interface ProjectsSkin {
  /** every project at once. */
  readonly Map: Component;
  /** Over one project's overview. */
  readonly Head: Component<{ name: string }>;
  /** A project's picture in the list, a sprite's name. */
  readonly picture: (project: string) => string;
}

/** The pixel art the overview shows for a recency: the map's crops, so a project looks the same in both. */
const recencyPicture: Record<Recency, string> = {
  never: "plot-empty",
  day: "plot-flowering",
  week: "plot-leafy",
  month: "plot-sprout",
  quarter: "plot-dry",
  older: "plot-withered",
};

/** `rest` is the path after /projects/. */
export function ProjectsPage(props: { rest: string; skin: ProjectsSkin }) {
  const router = useRouter();
  // A minute at a time: enough for "3h ago".
  const now = useNow(60_000);
  const list = useProjects();
  const sorted = () => sortProjects(ready(list, []));
  const selected = () => sorted().find((p) => p.name === (props.rest && decodeURIComponent(props.rest)));
  const [creating, setCreating] = createSignal(false);
  return (
    // The list is the page's side column, against the rail as the chat's and the notes' are (ui/layout.tsx Split edge).
    <div class="flex h-full min-h-0 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
      <div class="max-h-60 shrink-0 overflow-y-auto border-b border-line bg-side px-2 py-3 md:max-h-none md:w-72 md:border-r md:border-b-0">
        <ListCard
          bare
          title={t("web.project.title")}
          label={t("web.project.list")}
          testid="projects"
          action={
            <Button icon="add" data-testid="new-project" onClick={() => setCreating(true)}>
              {t("web.project.add")}
            </Button>
          }
        >
          <li class="px-2.5 pt-1 pb-1.5 text-xs text-muted">{t("web.project.repos")}</li>
          <Switch
            fallback={
              <>
                <ListRow to="/projects" item="" active={!selected()} title={t("web.project.all")} line={t("web.project.allLine")} />
                <For each={sorted()}>
                  {(p) => {
                    const recency = () => recencyText(recencyOf(p.last, now()));
                    const line = () => (!p.git ? t("web.project.notGit") : p.last !== undefined ? `${recency()} · ${since(p.last, now())}` : recency());
                    return (
                      <ListRow
                        to={`/projects/${encodeURIComponent(p.name)}`}
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
              <li class="px-2.5 pb-2 text-sm text-muted">{t("web.project.finding")}</li>
            </Match>
            <Match when={sorted().length === 0}>
              <li class="px-2.5 pb-2 text-sm text-muted">{t("web.project.none")}</li>
            </Match>
          </Switch>
        </ListCard>
      </div>
      <div class="flex min-h-[480px] min-w-0 flex-1 flex-col p-3 md:min-h-0">
        {/* Keyed by the name, a plain value: the panel's queries are still settling when the page moves back to the map, and a read through a narrowed accessor then would halt the page. */}
        <Show when={selected()?.name} keyed fallback={<props.skin.Map />}>
          {(name) => <ProjectPanel name={name} projects={sorted} now={now()} Head={props.skin.Head} />}
        </Show>
      </div>
      <Dialog open={creating()} onClose={() => setCreating(false)} title={t("web.project.add")} testid="new-project-dialog">
        <NewProjectForm
          onDone={(made) => {
            setCreating(false);
            if (made) router.navigate(`/projects/${encodeURIComponent(made.name)}`);
          }}
        />
      </Dialog>
    </div>
  );
}

/** One project: the skin's head and its details. */
function ProjectPanel(props: { name: string; projects: () => ProjectSummary[]; now: number; Head: ProjectsSkin["Head"] }) {
  const project = createMemo<ProjectSummary | undefined>((last) => props.projects().find((p) => p.name === props.name) ?? last);
  return (
    <div data-testid="project" data-key={props.name} class="flex max-w-4xl flex-col gap-3 md:overflow-y-auto">
      <props.Head name={props.name} />
      <Show when={project()}>{(p) => <Details project={p()} now={props.now} />}</Show>
    </div>
  );
}

function Details(props: { project: ProjectSummary; now: number }) {
  // Keyed by the name: the queries ask about this one project for the panel's life.
  const name = untrack(() => props.project.name);
  const survey = useSurvey(() => name);
  return (
    <>
      <Overview project={props.project} languages={survey.languages} activity={survey.activity} now={props.now} />
      <Languages languages={survey.languages} />
      <CommitCalendar activity={survey.activity} />
      <Hands activity={ready(survey.activity, undefined)} />
    </>
  );
}

async function copyPath(path: string) {
  try {
    await navigator.clipboard.writeText(path);
    toast(t("web.project.copied", { path }));
  } catch {
    toast(t("web.project.notCopied"));
  }
}

function Overview(props: { project: ProjectSummary; languages: Asked<ProjectLanguages>; activity: Asked<ProjectActivity>; now: number }) {
  const recency = () => recencyOf(props.project.last, props.now);
  const counted = () => ready(props.languages, undefined);
  const worked = () => ready(props.activity, undefined);
  const lines = () => counted()?.languages.reduce((n, l) => n + l.code + l.comments, 0);
  const firstCommit = () => {
    const w = worked();
    return w?.first !== undefined ? dateText(w.first) : w ? t("web.project.noCommits") : "…";
  };
  const codeLines = () => {
    const n = lines();
    return n !== undefined ? t("web.project.lines", { n: number(n) }) : notCounted() ? t("web.project.uncounted") : "…";
  };
  const languageCount = () => {
    const c = counted();
    return c ? languageShares(c.languages, undefined).length : undefined;
  };
  const commitTotal = () => {
    const w = worked();
    return w ? t("web.project.commits", { n: number(w.total) }) : "…";
  };
  const languageTotal = () => {
    const count = languageCount();
    return count !== undefined ? t("web.project.kinds", { n: count }) : notCounted() ? t("web.project.uncounted") : "…";
  };
  const busy = () => props.languages.isFetching || props.activity.isFetching;
  const notCounted = () => !!props.languages.error;
  return (
    <section class="flex flex-wrap items-center gap-4 rounded-lg border border-line bg-page p-4">
      <span class="flex size-24 shrink-0 items-center justify-center rounded-lg bg-hover">
        <SpriteIcon name={recencyPicture[recency()]} size={80} label={t("web.project.recency.label", { label: recencyText(recency()) })} />
      </span>
      <div class="flex min-w-0 flex-1 flex-col gap-3">
        <div class="flex flex-wrap items-center gap-3">
          <h2 class="truncate text-xl font-semibold">{props.project.name}</h2>
          <span class="rounded bg-leaf-300/50 px-1.5 text-xs">{recencyText(recency())}</span>
        </div>
        <div class="flex flex-wrap gap-x-6 gap-y-2">
          <Stat label={t("web.project.firstCommit")} value={firstCommit()} />
          <Stat label={t("web.project.commitCount")} value={commitTotal()} />
          <Stat label={t("web.project.code")} value={codeLines()} />
          <Stat label={t("web.project.languages")} value={languageTotal()} />
        </div>
        <div class="flex items-center gap-1.5">
          <Icon name="folder" size={14} />
          <span class="min-w-0 truncate font-mono text-xs text-muted" title={props.project.path}>
            {props.project.path}
          </span>
          <button
            type="button"
            title={t("web.project.copyPath")}
            aria-label={t("web.project.copyPath")}
            class="cursor-pointer rounded p-1 hover:bg-hover"
            onClick={() => void copyPath(props.project.path)}
          >
            <Icon name="copy" size={14} />
          </button>
        </div>
      </div>
      <div class="flex flex-col items-end gap-1">
        <button
          type="button"
          title={busy() ? t("web.project.counting") : t("web.project.recount")}
          aria-label={t("web.project.recount")}
          disabled={busy()}
          onClick={() => {
            void props.languages.refetch();
            void props.activity.refetch();
          }}
          class="cursor-pointer rounded-md border border-line p-1.5 hover:bg-hover disabled:opacity-50"
        >
          <Icon name="refresh" size={16} />
        </button>
        <Show when={counted()}>{(c) => <span class="text-xs text-muted">{t("web.project.countedAgo", { ago: since(c().at, props.now) })}</span>}</Show>
      </div>
    </section>
  );
}
