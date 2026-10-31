// 项目: the codebases in the work root; 全部 is the skin's map, a project the skin's head over its overview, its languages
// (tokei's count), the calendar of a year's commits and who committed. /projects/<name>.

import { type QueryObserverResult, useQueryClient } from "@tanstack/solid-query";
import { type Component, createMemo, createSignal, For, Match, Show, Switch, untrack } from "solid-js";

import { list, t } from "@vibevalley/i18n";
import type { ProjectActivity, ProjectLanguages, ProjectSummary } from "@vibevalley/protocol";

import { useWorkAgents } from "@/base/agents";
import { api, reasonOf } from "@/base/api";
import { ready, useProjects, useQuery } from "@/base/query";
import { useRouter } from "@/base/router";
import { autofocus, useNow } from "@/base/util";
import { Button } from "@/ui/Button";
import { Dialog } from "@/ui/Dialog";
import { AgentFace } from "@/ui/Face";
import { Field, TextInput } from "@/ui/Field";
import { Icon } from "@/ui/Icon";
import { Card, ListCard, ListRow, Quiet } from "@/ui/layout";
import { SpriteIcon } from "@/ui/pixel";
import { Segmented } from "@/ui/Segmented";
import { toast } from "@/ui/toasts";

import { calendarOf, type CalendarDay, dateText, dayText, type Recency, recencyOf, recencyText, since, streaksOf } from "./calendar";
import { langIcon, languageShares } from "./languages";
import { githubRepository, number, percent, sortProjects } from "./projects";

type Asked<A> = QueryObserverResult<A>;

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
  /** 全部: every project at once. */
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
      <div class="flex min-h-[480px] min-w-0 flex-1 flex-col md:min-h-0">
        {/* Keyed by the name, a plain value: the panel's queries are still settling when the page moves back to the map,
            and a read through a narrowed accessor then would halt the page. */}
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

/** One project: the skin's head and its details. The project is the last one listed by this name, so it stays while the
 * list is asked again and while the page moves away. */
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
  const languageCount = () => {
    const c = counted();
    return c ? languageShares(c.languages, undefined).length : undefined;
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
          <Stat
            label={t("web.project.firstCommit")}
            value={worked()?.first !== undefined ? dateText(worked()!.first!) : worked() ? t("web.project.noCommits") : "…"}
          />
          <Stat label={t("web.project.commitCount")} value={worked() ? t("web.project.commits", { n: number(worked()!.total) }) : "…"} />
          <Stat
            label={t("web.project.code")}
            value={lines() !== undefined ? t("web.project.lines", { n: number(lines()!) }) : notCounted() ? t("web.project.uncounted") : "…"}
          />
          <Stat
            label={t("web.project.languages")}
            value={languageCount() !== undefined ? t("web.project.kinds", { n: languageCount()! }) : notCounted() ? t("web.project.uncounted") : "…"}
          />
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

/** A thin rounded bar, filled to its share. */
function Bar(props: { share: number; color: string }) {
  return (
    <span class="block h-1.5 overflow-hidden rounded-full bg-hover">
      <span class="block h-full rounded-full" style={{ width: `${Math.min(1, Math.max(0, props.share)) * 100}%`, background: props.color }} />
    </span>
  );
}

/** A share wide enough carries its language's picture in the bar. */
const logoInBar = 0.07;

function Languages(props: { languages: Asked<ProjectLanguages> }) {
  const data = () => ready(props.languages, undefined);
  const shares = () => {
    const d = data();
    return d ? languageShares(d.languages) : [];
  };
  return (
    <Card title={t("web.project.whatLanguages")} action={<span class="text-xs text-muted">{t("web.project.byLines")}</span>}>
      <Switch
        fallback={
          <>
            {/* Bark, not a token: the pixel logos are drawn to sit on it. */}
            <div role="img" aria-label={list(shares().map((s) => `${s.label} ${percent(s.share)}`))} class="flex h-14 overflow-hidden rounded-md bg-bark p-1">
              <For each={shares()}>
                {(s) => (
                  <span
                    title={`${s.label} · ${percent(s.share)}`}
                    class="flex min-w-1 items-center justify-center"
                    style={{ "flex-grow": Math.max(1, Math.round(s.share * 10000)), background: s.color }}
                  >
                    <Show when={s.share >= logoInBar}>
                      <SpriteIcon name={langIcon(s.id)} size={36} />
                    </Show>
                  </span>
                )}
              </For>
            </div>
            <div class="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              <For each={shares()}>
                {(s) => (
                  <div class="flex items-center gap-3">
                    <SpriteIcon name={langIcon(s.id)} size={32} />
                    <div class="flex min-w-0 flex-1 flex-col gap-1">
                      <span class="flex text-sm">
                        <span class="min-w-0 flex-1 truncate font-medium">{s.label}</span>
                        <span class="text-muted">{percent(s.share)}</span>
                      </span>
                      <Bar share={s.share < 0.02 ? 0.02 : s.share} color={s.color} />
                      <span class="text-xs text-muted">{t("web.project.linesAndFiles", { lines: number(s.lines), files: number(s.files) })}</span>
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
          <Quiet>{t("web.project.empty")}</Quiet>
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
      <p>{install() ? t("web.project.noTokei") : props.reason}</p>
      <Show when={install()}>
        <p class="text-muted">
          {t("web.project.install")}
          {code("brew install tokei")}
          {t("web.project.or")}
          {code("cargo install tokei")}
          {t("web.project.thenRecount")}
        </p>
      </Show>
    </div>
  );
}

const levelName = (level: number) => (level === 0 || level === 1 || level === 2 || level === 3 || level === 4 ? t(`web.project.level.${level}`) : "");
const tile = 12;
const tileGap = 3;

function CommitCalendar(props: { activity: Asked<ProjectActivity> }) {
  const [pointed, setPointed] = createSignal<CalendarDay>();
  const worked = () => ready(props.activity, undefined);
  const calendar = createMemo(() => calendarOf(worked()?.days ?? [], new Date()));
  const streaks = createMemo(() => streaksOf(calendar()));
  const aside = () => <span class="text-xs text-muted">{t("web.project.year")}</span>;
  const line = () => {
    const p = pointed();
    const busiest = streaks().busiest;
    return p && !p.future
      ? `${dayText(p.at)} · ${p.commits > 0 ? t("web.project.dayCommits", { n: p.commits, level: levelName(p.level) }) : t("web.project.noCommitsThatDay")}`
      : busiest
        ? t("web.project.busiest", { day: dayText(new Date(`${busiest.day}T12:00`)), n: busiest.commits })
        : " ";
  };
  return (
    <Show
      when={!(props.activity.error && !worked())}
      fallback={
        <Card title={t("web.project.calendar")} action={aside()}>
          <p class="text-sm">{reasonOf(props.activity.error)}</p>
        </Card>
      }
    >
      <Card title={t("web.project.calendar")} action={aside()}>
        <div class="grid grid-cols-4 gap-6">
          <Stat label={t("web.project.inYear")} value={worked() ? t("web.project.commits", { n: number(streaks().total) }) : "…"} />
          <Stat label={t("web.project.daysWorked")} value={worked() ? t("web.project.days", { n: streaks().days }) : "…"} />
          <Stat label={t("web.project.longest")} value={worked() ? t("web.project.days", { n: streaks().longest }) : "…"} />
          <Stat label={t("web.project.current")} value={worked() ? t("web.project.days", { n: streaks().current }) : "…"} />
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
              aria-label={worked() ? t("web.project.yearLabel", { commits: streaks().total, days: streaks().days }) : t("web.project.readingCommits")}
              class="mt-1 flex"
              onMouseLeave={() => setPointed(undefined)}
            >
              <div class="flex w-5 flex-col" style={{ gap: `${tileGap}px` }}>
                <For each={([0, 1, 2, 3, 4, 5, 6] as const).map((i) => t(`web.project.rows.${i}`))}>
                  {(d) => (
                    <span class="flex items-center text-2xs leading-none text-muted" style={{ height: `${tile}px` }}>
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
                          <SpriteIcon name={`day-${d.level}`} size={tile} />
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
            {t("web.project.fewer")}
            <For each={[0, 1, 2, 3, 4]}>
              {(l) => (
                <span title={levelName(l)}>
                  <SpriteIcon name={`day-${l}`} size={tile} />
                </span>
              )}
            </For>
            {t("web.project.more")}
          </span>
        </div>
      </Card>
    </Show>
  );
}

const hands = 8;

function Hands(props: { activity?: ProjectActivity | undefined }) {
  const agents = useWorkAgents();
  const authors = () => props.activity?.authors ?? [];
  const top = () => (authors()[0] && authors()[0]!.commits > 0 ? authors()[0]!.commits : 1);
  const rest = () =>
    authors()
      .slice(hands)
      .reduce((n, a) => n + a.commits, 0);
  return (
    <Show when={authors().length > 0}>
      <Card title={t("web.project.who")} action={<span class="text-xs text-muted">{t("web.project.whoWhen")}</span>}>
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
                      <span class="text-xs text-muted">{t("web.project.times", { n: number(author.commits) })}</span>
                    </span>
                    <Bar share={author.commits / top()} color="#74a046" />
                  </div>
                </div>
              );
            }}
          </For>
        </div>
        <Show when={rest() > 0}>
          <p class="text-xs text-muted">{t("web.project.rest", { people: authors().length - hands, commits: number(rest()) })}</p>
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
      const problem = (await api.project.validate(request)).problem;
      if (problem) {
        setError(problem);
        return;
      }
      const made = await api.project.create(request);
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
          label={t("web.project.how")}
          testid="project-how"
          value={importing()}
          options={[
            { value: "new", label: t("web.project.fresh"), disabled: busy() },
            { value: "github", label: t("web.project.github"), disabled: busy() },
          ]}
          onChange={(v) => {
            setImporting(v);
            setError(undefined);
          }}
        />
      </div>
      <Show when={importing() === "github"}>
        <Field label={t("web.project.githubAddress")} hint={t("web.project.githubHint")}>
          <TextInput
            ref={autofocus()}
            data-testid="project-github"
            aria-label={t("web.project.githubAddress")}
            disabled={busy()}
            placeholder={t("web.base.form.example", { value: "https://github.com/botiverse/raft-source" })}
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
      <Field label={t("web.project.name")} hint={t("web.project.nameHint")}>
        <TextInput
          data-testid="project-name"
          aria-label={t("web.project.name")}
          disabled={busy()}
          placeholder={t("web.project.nameExample")}
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
        <p class="text-sm text-muted">{importing() === "github" ? t("web.project.downloading") : t("web.project.making")}</p>
      </Show>
      <div class="flex justify-end gap-2 pt-2">
        <Button disabled={busy()} data-testid="cancel" onClick={() => props.onDone()}>
          {t("web.project.cancel")}
        </Button>
        <Button type="submit" tone="primary" data-testid="submit" disabled={!canSubmit()}>
          {busy() ? t("web.project.busy") : importing() === "github" ? t("web.project.download") : t("web.project.create")}
        </Button>
      </div>
    </form>
  );
}
