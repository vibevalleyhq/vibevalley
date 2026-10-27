// 项目: the codebases in the work root; 全部 is the whole map, a project its island, its
// deed, what is planted (tokei's count), the tilling calendar of a year's commits and who worked it. /projects/<name>.

import { projectsWording } from "./words";
import { createMemo, createSignal, For, Match, Show, Switch, untrack } from "solid-js";
import { type QueryObserverResult, useQueryClient } from "@tanstack/solid-query";
import type { ProjectActivity, ProjectLanguages, ProjectSummary } from "@vibevalley/protocol";
import { api, reasonOf } from "../../base/api";
import {
  calendarOf,
  type CalendarDay,
  dateText,
  dayText,
  githubRepository,
  growthOf,
  islandLook,
  langIcon,
  languageShares,
  number,
  percent,
  since,
  sortProjects,
  streaksOf,
} from "../../rules/projects";
import { toast } from "../../ui/toasts";
import { useRouter } from "../../base/router";
import { autofocus, useNow } from "../../base/util";
import { useWorkAgents } from "../../data/agents";
import { ready, useProjects, useQuery } from "../../base/query";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { AgentFace } from "../../ui/Face";
import { Field, TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Segmented } from "../../ui/Segmented";
import { Card, ListCard, ListRow, Quiet } from "../kit";
import { IslandDetail, ProjectMap, useIslands } from "./ProjectMap";

type Asked<A> = QueryObserverResult<A>;

const useSurvey = (project: () => string) => ({
  languages: useQuery(() => ({
    queryKey: ["project-languages", project()],
    queryFn: () => api.project.languages({ id: project() }),
    placeholderData: (p: ProjectLanguages | undefined) => p,
  })),
  activity: useQuery(() => ({
    queryKey: ["project-activity", project()],
    queryFn: () => api.project.activity({ id: project() }),
    placeholderData: (p: ProjectActivity | undefined) => p,
  })),
});

/** `rest` is the path after /projects/. */
export function ProjectsPage(props: { rest: string }) {
  const router = useRouter();
  // A minute at a time: enough for 「3 小时前」.
  const now = useNow(60_000);
  const list = useProjects();
  const sorted = () => sortProjects(ready(list, []));
  const selected = () => sorted().find((p) => p.name === (props.rest && decodeURIComponent(props.rest)));
  const [creating, setCreating] = createSignal(false);
  return (
    <div class="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3 md:flex-row md:overflow-hidden">
      <div class="max-h-60 shrink-0 overflow-y-auto md:max-h-none md:w-72">
        <ListCard
          title={projectsWording().title}
          label={projectsWording().list}
          action={
            <Button icon="button-add" onClick={() => setCreating(true)}>
              {projectsWording().add}
            </Button>
          }
        >
          <li class="px-2.5 pt-1 pb-1.5 text-xs text-muted">{projectsWording().repos}</li>
          <Switch
            fallback={
              <>
                <ListRow to="/projects" active={!selected()} title={projectsWording().all} line={projectsWording().allLine} />
                <For each={sorted()}>
                  {(p) => {
                    const growth = () => growthOf(p.last, now());
                    const line = () =>
                      !p.git ? projectsWording().notGit : p.last !== undefined ? `${growth().label} · ${since(p.last, now())}` : growth().label;
                    return (
                      <ListRow
                        to={`/projects/${encodeURIComponent(p.name)}`}
                        active={p.name === selected()?.name}
                        title={p.name}
                        line={line()}
                        leading={<Icon name={islandLook(p.name)} size={40} />}
                      />
                    );
                  }}
                </For>
              </>
            }
          >
            <Match when={!ready(list, undefined)}>
              <li class="px-2.5 pb-2 text-sm text-muted">{projectsWording().finding}</li>
            </Match>
            <Match when={sorted().length === 0}>
              <li class="px-2.5 pb-2 text-sm text-muted">{projectsWording().none}</li>
            </Match>
          </Switch>
        </ListCard>
      </div>
      <div class="flex min-h-[480px] min-w-0 flex-1 flex-col md:min-h-0">
        {/* Keyed by the name, a plain value: the panel's queries are still settling when the page moves back to the map,
            and a read through a narrowed accessor then would halt the page. */}
        <Show when={selected()?.name} keyed fallback={<ProjectMap />}>
          {(name) => <ProjectPanel name={name} projects={sorted} now={now()} />}
        </Show>
      </div>
      <Dialog open={creating()} onClose={() => setCreating(false)} title={projectsWording().add}>
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

/** One project: its island and its details. The project is the last one listed by this name, so it stays while the
 * list is asked again and while the page moves away. */
function ProjectPanel(props: { name: string; projects: () => ProjectSummary[]; now: number }) {
  const islands = useIslands();
  const project = createMemo<ProjectSummary | undefined>((last) => props.projects().find((p) => p.name === props.name) ?? last);
  const island = () => islands().find((i) => i.project === props.name);
  return (
    <div class="flex max-w-4xl flex-col gap-3 md:overflow-y-auto">
      <Show when={island()}>{(i) => <IslandDetail island={i()} />}</Show>
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
      <Deed project={props.project} languages={survey.languages} activity={survey.activity} now={props.now} />
      <Planted languages={survey.languages} />
      <TillingCalendar activity={survey.activity} />
      <Hands activity={ready(survey.activity, undefined)} />
    </>
  );
}

function Stat(props: { label: string; value: string }) {
  return (
    <div class="flex min-w-18 flex-col">
      <span class="text-xs text-muted">{props.label}</span>
      <span class="line-clamp-2 text-sm font-medium">{props.value}</span>
    </div>
  );
}

async function copyPath(path: string) {
  try {
    await navigator.clipboard.writeText(path);
    toast(projectsWording().copied(path));
  } catch {
    toast(projectsWording().notCopied);
  }
}

function Deed(props: { project: ProjectSummary; languages: Asked<ProjectLanguages>; activity: Asked<ProjectActivity>; now: number }) {
  const growth = () => growthOf(props.project.last, props.now);
  const counted = () => ready(props.languages, undefined);
  const worked = () => ready(props.activity, undefined);
  const lines = () => counted()?.languages.reduce((n, l) => n + l.code + l.comments, 0);
  const crops = () => {
    const c = counted();
    return c ? languageShares(c.languages, undefined).length : undefined;
  };
  const busy = () => props.languages.isFetching || props.activity.isFetching;
  const notCounted = () => !!props.languages.error;
  return (
    <section class="flex flex-wrap items-center gap-4 rounded-lg border border-line bg-page p-4">
      <span class="flex size-24 shrink-0 items-center justify-center rounded-lg bg-hover">
        <Icon name={`plot-${growth().crop}`} size={80} label={projectsWording().growth(growth().label)} />
      </span>
      <div class="flex min-w-0 flex-1 flex-col gap-3">
        <div class="flex flex-wrap items-center gap-3">
          <h2 class="truncate text-xl font-semibold">{props.project.name}</h2>
          <span class="rounded bg-leaf-300/50 px-1.5 text-xs">{projectsWording().growthTag(growth().label)}</span>
        </div>
        <div class="flex flex-wrap gap-x-6 gap-y-2">
          <Stat
            label={projectsWording().broken}
            value={worked()?.first !== undefined ? dateText(worked()!.first!) : worked() ? projectsWording().neverDug : "…"}
          />
          <Stat label={projectsWording().tilled} value={worked() ? projectsWording().commits(number(worked()!.total)) : "…"} />
          <Stat
            label={projectsWording().crops}
            value={lines() !== undefined ? projectsWording().lines(number(lines()!)) : notCounted() ? projectsWording().uncounted : "…"}
          />
          <Stat
            label={projectsWording().planted}
            value={crops() !== undefined ? projectsWording().kinds(crops()!) : notCounted() ? projectsWording().uncounted : "…"}
          />
        </div>
        <div class="flex items-center gap-1.5">
          <Icon name="button-folder" size={14} />
          <span class="min-w-0 truncate font-mono text-xs text-muted" title={props.project.path}>
            {props.project.path}
          </span>
          <button
            type="button"
            title={projectsWording().copyPath}
            aria-label={projectsWording().copyPath}
            class="cursor-pointer rounded p-1 hover:bg-hover"
            onClick={() => void copyPath(props.project.path)}
          >
            <Icon name="button-copy" size={14} />
          </button>
        </div>
      </div>
      <div class="flex flex-col items-end gap-1">
        <button
          type="button"
          title={busy() ? projectsWording().counting : projectsWording().recount}
          aria-label={projectsWording().recount}
          disabled={busy()}
          onClick={() => {
            void props.languages.refetch();
            void props.activity.refetch();
          }}
          class="cursor-pointer rounded-md border border-line p-1.5 hover:bg-hover disabled:opacity-50"
        >
          <Icon name="button-refresh" size={16} />
        </button>
        <Show when={counted()}>{(c) => <span class="text-xs text-muted">{projectsWording().countedAgo(since(c().at, props.now))}</span>}</Show>
      </div>
    </section>
  );
}

/** A thin rounded bar, filled to its share. */
function Bar(props: { share: number; color: string }) {
  return (
    <span class="block h-1.5 overflow-hidden rounded-full bg-hover">
      <span class="block h-full rounded-full" style={{ width: `${Math.min(1, Math.max(0, props.share)) * 100}%`, background: props.color }} />
    </span>
  );
}

/** A share wide enough carries its language's picture in the bed. */
const logoInBed = 0.07;

function Planted(props: { languages: Asked<ProjectLanguages> }) {
  const data = () => ready(props.languages, undefined);
  const shares = () => {
    const d = data();
    return d ? languageShares(d.languages) : [];
  };
  return (
    <Card title={projectsWording().whatPlanted} action={<span class="text-xs text-muted">{projectsWording().byLines}</span>}>
      <Switch
        fallback={
          <>
            {/* The bed itself, soil under the crops: it keeps the farm's brown. */}
            <div
              role="img"
              aria-label={shares()
                .map((s) => `${s.label} ${percent(s.share)}`)
                .join("，")}
              class="flex h-14 overflow-hidden rounded-md bg-[#7a5a3a] p-1"
            >
              <For each={shares()}>
                {(s) => (
                  <span
                    title={`${s.label} · ${percent(s.share)}`}
                    class="flex min-w-1 items-center justify-center"
                    style={{ "flex-grow": Math.max(1, Math.round(s.share * 10000)), background: s.color }}
                  >
                    <Show when={s.share >= logoInBed}>
                      <Icon name={langIcon(s.id)} size={36} />
                    </Show>
                  </span>
                )}
              </For>
            </div>
            <div class="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              <For each={shares()}>
                {(s) => (
                  <div class="flex items-center gap-3">
                    <Icon name={langIcon(s.id)} size={32} />
                    <div class="flex min-w-0 flex-1 flex-col gap-1">
                      <span class="flex text-sm">
                        <span class="min-w-0 flex-1 truncate font-medium">{s.label}</span>
                        <span class="text-muted">{percent(s.share)}</span>
                      </span>
                      <Bar share={s.share < 0.02 ? 0.02 : s.share} color={s.color} />
                      <span class="text-xs text-muted">{projectsWording().linesAndFiles(number(s.lines), number(s.files))}</span>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </>
        }
      >
        <Match when={props.languages.error && !data()}>
          <NotCounted reason={reasonOf(props.languages.error)} />
        </Match>
        <Match when={!data()}>
          <div class="h-12 rounded-md bg-hover" />
        </Match>
        <Match when={shares().length === 0}>
          <Quiet>{projectsWording().empty}</Quiet>
        </Match>
      </Switch>
    </Card>
  );
}

function NotCounted(props: { reason: string }) {
  const install = () => props.reason.includes("brew install tokei");
  const code = (t: string) => <code class="rounded bg-selected px-1.5 py-px font-mono text-sm">{t}</code>;
  return (
    <div class="flex flex-col gap-2 rounded-lg bg-hover p-3 text-sm">
      <p>{install() ? projectsWording().noTokei : props.reason}</p>
      <Show when={install()}>
        <p class="text-muted">
          {projectsWording().install}
          {code("brew install tokei")}
          {projectsWording().or}
          {code("cargo install tokei")}
          {projectsWording().thenRecount}
        </p>
      </Show>
    </div>
  );
}

const levelName = projectsWording().level;
const tile = 12;
const tileGap = 3;

function TillingCalendar(props: { activity: Asked<ProjectActivity> }) {
  const [pointed, setPointed] = createSignal<CalendarDay>();
  const worked = () => ready(props.activity, undefined);
  const calendar = createMemo(() => calendarOf(worked()?.days ?? [], new Date()));
  const streaks = createMemo(() => streaksOf(calendar()));
  const aside = () => <span class="text-xs text-muted">{projectsWording().year}</span>;
  const line = () => {
    const p = pointed();
    const busiest = streaks().busiest;
    return p && !p.future
      ? `${dayText(p.at)} · ${p.commits > 0 ? projectsWording().dayCommits(p.commits, levelName[p.level] ?? "") : projectsWording().untouched}`
      : busiest
        ? projectsWording().busiest(dayText(new Date(`${busiest.day}T12:00`)), busiest.commits)
        : " ";
  };
  return (
    <Show
      when={!(props.activity.error && !worked())}
      fallback={
        <Card title={projectsWording().calendar} action={aside()}>
          <p class="text-sm">{reasonOf(props.activity.error)}</p>
        </Card>
      }
    >
      <Card title={projectsWording().calendar} action={aside()}>
        <div class="grid grid-cols-4 gap-6">
          <Stat label={projectsWording().inYear} value={worked() ? projectsWording().commits(number(streaks().total)) : "…"} />
          <Stat label={projectsWording().daysWorked} value={worked() ? projectsWording().days(streaks().days) : "…"} />
          <Stat label={projectsWording().longest} value={worked() ? projectsWording().days(streaks().longest) : "…"} />
          <Stat label={projectsWording().current} value={worked() ? projectsWording().days(streaks().current) : "…"} />
        </div>
        <div class="overflow-x-auto pb-1">
          <div class="min-w-[704px]">
            <div class="relative h-4" style={{ width: `${20 + calendar().weeks.length * (tile + tileGap)}px` }}>
              <For each={calendar().months}>
                {(m) => (
                  <span class="absolute top-0 text-xs text-muted" style={{ left: `${20 + tileGap + m.week * (tile + tileGap)}px` }}>
                    {m.label}
                  </span>
                )}
              </For>
            </div>
            <div
              role="img"
              aria-label={worked() ? projectsWording().yearLabel(streaks().total, streaks().days) : projectsWording().readingCommits}
              class="mt-1 flex"
              onMouseLeave={() => setPointed(undefined)}
            >
              <div class="flex w-5 flex-col" style={{ gap: `${tileGap}px` }}>
                <For each={projectsWording().rows}>
                  {(d) => (
                    <span class="flex items-center text-[10px] leading-none text-muted" style={{ height: `${tile}px` }}>
                      {d}
                    </span>
                  )}
                </For>
              </div>
              <For each={calendar().weeks}>
                {(week) => (
                  <div class="flex flex-col" style={{ gap: `${tileGap}px`, "margin-left": `${tileGap}px` }}>
                    <For each={week}>
                      {(d) => (
                        <span onMouseEnter={() => setPointed(d)} style={{ opacity: d.future ? 0 : worked() ? 1 : 0.5 }}>
                          <Icon name={`day-${d.level}`} size={tile} />
                        </span>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs text-muted">{line()}</span>
          <span class="flex items-center gap-1 text-xs text-muted">
            {projectsWording().fewer}
            <For each={levelName}>
              {(n, l) => (
                <span title={n}>
                  <Icon name={`day-${l()}`} size={tile} />
                </span>
              )}
            </For>
            {projectsWording().more}
          </span>
        </div>
      </Card>
    </Show>
  );
}

const hands = 8;

function Hands(props: { activity?: ProjectActivity }) {
  const agents = useWorkAgents();
  const authors = () => props.activity?.authors ?? [];
  const top = () => (authors()[0] && authors()[0]!.commits > 0 ? authors()[0]!.commits : 1);
  const rest = () =>
    authors()
      .slice(hands)
      .reduce((n, a) => n + a.commits, 0);
  return (
    <Show when={authors().length > 0}>
      <Card title={projectsWording().who} action={<span class="text-xs text-muted">{projectsWording().whoWhen}</span>}>
        <div class="grid gap-2.5 sm:grid-cols-2">
          <For each={authors().slice(0, hands)}>
            {(author) => {
              const agent = () => agents().find((a) => a.name === author.name);
              return (
                <div class="flex items-center gap-3">
                  <Show
                    when={agent()}
                    fallback={
                      <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-selected text-sm font-medium">
                        {[...author.name][0] ?? ""}
                      </span>
                    }
                  >
                    {(a) => <AgentFace agentId={a().id} look={a().look} runtime={a().runtime} size={32} />}
                  </Show>
                  <div class="flex min-w-0 flex-1 flex-col gap-1">
                    <span class="flex text-sm">
                      <span class="min-w-0 flex-1 truncate font-medium">{author.name}</span>
                      <span class="text-xs text-muted">{projectsWording().times(number(author.commits))}</span>
                    </span>
                    <Bar share={author.commits / top()} color="#74a046" />
                  </div>
                </div>
              );
            }}
          </For>
        </div>
        <Show when={rest() > 0}>
          <p class="text-xs text-muted">{projectsWording().rest(authors().length - hands, number(rest()))}</p>
        </Show>
      </Card>
    </Show>
  );
}

/** The name follows the repository's until it is typed by hand; what would be refused is the server's answer. */
function NewProjectForm(props: { onDone: (made?: ProjectSummary) => void }) {
  const client = useQueryClient();
  const [importing, setImporting] = createSignal<"new" | "github">("github");
  const [github, setGithub] = createSignal("");
  const [name, setName] = createSignal("");
  const [named, setNamed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const canSubmit = () => !busy() && name().trim() !== "" && (importing() === "new" || github().trim() !== "");
  const submit = async () => {
    if (!canSubmit()) return;
    const request = { name: name().trim(), ...(importing() === "github" ? { github: github().trim() } : {}) };
    setBusy(true);
    setError(undefined);
    try {
      const problem = (await api.project.check({ body: request })).problem;
      if (problem) {
        setError(problem);
        return;
      }
      const made = await api.project.create({ body: request });
      await client.invalidateQueries({ queryKey: ["projects"] });
      props.onDone(made);
    } catch (e) {
      setError(reasonOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      class="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div>
        <Segmented
          label={projectsWording().how}
          value={importing()}
          options={[
            { value: "new", label: projectsWording().fresh, disabled: busy() },
            { value: "github", label: projectsWording().github, disabled: busy() },
          ]}
          onChange={(v) => {
            setImporting(v);
            setError(undefined);
          }}
        />
      </div>
      <Show when={importing() === "github"}>
        <Field label={projectsWording().githubAddress} hint={projectsWording().githubHint}>
          <TextInput
            ref={autofocus()}
            aria-label={projectsWording().githubAddress}
            disabled={busy()}
            placeholder="https://github.com/botiverse/raft-source"
            value={github()}
            onInput={(e) => {
              const typed = e.currentTarget.value;
              setGithub(typed);
              if (!named()) setName(githubRepository(typed)?.name ?? "");
              setError(undefined);
            }}
          />
        </Field>
      </Show>
      <Field label={projectsWording().name} hint={projectsWording().nameHint}>
        <TextInput
          aria-label={projectsWording().name}
          disabled={busy()}
          placeholder={projectsWording().nameExample}
          value={name()}
          onInput={(e) => {
            setNamed(true);
            setName(e.currentTarget.value);
            setError(undefined);
          }}
        />
      </Field>
      <Show when={error()}>
        <p role="alert" class="text-sm text-berry">
          {error()}
        </p>
      </Show>
      <Show when={busy()}>
        <p class="text-sm text-muted">{importing() === "github" ? projectsWording().downloading : projectsWording().making}</p>
      </Show>
      <div class="flex justify-end gap-2 pt-2">
        <Button disabled={busy()} onClick={() => props.onDone()}>
          {projectsWording().cancel}
        </Button>
        <Button type="submit" tone="primary" disabled={!canSubmit()}>
          {busy() ? projectsWording().busy : importing() === "github" ? projectsWording().download : projectsWording().create}
        </Button>
      </div>
    </form>
  );
}
