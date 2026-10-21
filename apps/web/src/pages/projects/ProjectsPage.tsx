// 项目: the codebases in the work root; 全部 is the whole map, a project its island, its
// deed, what is planted (tokei's count), the tilling calendar of a year's commits and who worked it. /projects/<name>.

import { createMemo, createSignal, For, Match, Show, Switch, untrack } from "solid-js";
import { type UseQueryResult, useQuery, useQueryClient } from "@tanstack/solid-query";
import type { ProjectActivity, ProjectLanguages, ProjectSummary } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
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
import { useRouter } from "../../app/router";
import { autofocus, useNow } from "../../app/util";
import { useWorkAgents } from "../../data/agents";
import { ready, useProjects } from "../../data/query";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { AgentFace } from "../../ui/Face";
import { Field, TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Segmented } from "../../ui/Segmented";
import { Card, ListCard, ListRow, Quiet } from "../kit";
import { IslandDetail, ProjectMap, useIslands } from "./ProjectMap";

type Asked<A> = UseQueryResult<A>;

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
          title="项目"
          label="项目列表"
          action={
            <Button icon="button-add" onClick={() => setCreating(true)}>
              新增项目
            </Button>
          }
        >
          <li class="px-2.5 pt-1 pb-1.5 text-xs text-muted">代码库</li>
          <Switch
            fallback={
              <>
                <ListRow to="/projects" active={!selected()} title="全部" line="整张地图：每个项目一座岛" />
                <For each={sorted()}>
                  {(p) => {
                    const growth = () => growthOf(p.last, now());
                    const line = () => (!p.git ? "还不是 git 仓库" : p.last !== undefined ? `${growth().label} · ${since(p.last, now())}` : growth().label);
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
              <li class="px-2.5 pb-2 text-sm text-muted">在找……</li>
            </Match>
            <Match when={sorted().length === 0}>
              <li class="px-2.5 pb-2 text-sm text-muted">工作目录下还没有项目。点「新增项目」开一块地，或从 GitHub 下载一个。</li>
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
      <Dialog open={creating()} onClose={() => setCreating(false)} title="新增项目">
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
    toast(`复制好了：${path}`);
  } catch {
    toast("复制不了：选中路径自己复制吧。");
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
        <Icon name={`plot-${growth().crop}`} size={80} label={`长势：${growth().label}`} />
      </span>
      <div class="flex min-w-0 flex-1 flex-col gap-3">
        <div class="flex flex-wrap items-center gap-3">
          <h2 class="truncate text-xl font-semibold">{props.project.name}</h2>
          <span class="rounded bg-leaf-300/50 px-1.5 text-xs">长势 · {growth().label}</span>
        </div>
        <div class="flex flex-wrap gap-x-6 gap-y-2">
          <Stat label="开垦于" value={worked()?.first !== undefined ? dateText(worked()!.first!) : worked() ? "还没动过土" : "…"} />
          <Stat label="耕作" value={worked() ? `${number(worked()!.total)} 次提交` : "…"} />
          <Stat label="庄稼" value={lines() !== undefined ? `${number(lines()!)} 行` : notCounted() ? "没数" : "…"} />
          <Stat label="种了" value={crops() !== undefined ? `${crops()} 样` : notCounted() ? "没数" : "…"} />
        </div>
        <div class="flex items-center gap-1.5">
          <Icon name="button-folder" size={14} />
          <span class="min-w-0 truncate font-mono text-xs text-muted" title={props.project.path}>
            {props.project.path}
          </span>
          <button
            type="button"
            title="复制路径"
            aria-label="复制路径"
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
          title={busy() ? "在数……" : "重新统计"}
          aria-label="重新统计"
          disabled={busy()}
          onClick={() => {
            void props.languages.refetch();
            void props.activity.refetch();
          }}
          class="cursor-pointer rounded-md border border-line p-1.5 hover:bg-hover disabled:opacity-50"
        >
          <Icon name="button-refresh" size={16} />
        </button>
        <Show when={counted()}>{(c) => <span class="text-xs text-muted">{since(c().at, props.now)}数过</span>}</Show>
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
    <Card title="种了什么" action={<span class="text-xs text-muted">按行数，不算空行 · tokei 数的</span>}>
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
                      <span class="text-xs text-muted">
                        {number(s.lines)} 行 · {number(s.files)} 个文件
                      </span>
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
          <Quiet>这块地还空着：没有数得出来的代码。</Quiet>
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
      <p>{install() ? "数庄稼要用 tokei，这台机器上还没有。" : props.reason}</p>
      <Show when={install()}>
        <p class="text-muted">
          在终端里装一个：{code("brew install tokei")}（或 {code("cargo install tokei")}），装好点上面的「重新统计」。
        </p>
      </Show>
    </div>
  );
}

const levelName = ["空地", "撒了种", "发了芽", "长了叶", "开了花"];
const tile = 12;
const tileGap = 3;

function TillingCalendar(props: { activity: Asked<ProjectActivity> }) {
  const [pointed, setPointed] = createSignal<CalendarDay>();
  const worked = () => ready(props.activity, undefined);
  const calendar = createMemo(() => calendarOf(worked()?.days ?? [], new Date()));
  const streaks = createMemo(() => streaksOf(calendar()));
  const aside = () => <span class="text-xs text-muted">过去一年 · 一格一天，提交越多长得越高</span>;
  const line = () => {
    const p = pointed();
    const busiest = streaks().busiest;
    return p && !p.future
      ? `${dayText(p.at)} · ${p.commits > 0 ? `${p.commits} 次提交，${levelName[p.level]}` : "没动土"}`
      : busiest
        ? `最忙的一天：${dayText(new Date(`${busiest.day}T12:00`))}，${busiest.commits} 次提交`
        : " ";
  };
  return (
    <Show
      when={!(props.activity.error && !worked())}
      fallback={
        <Card title="耕作日历" action={aside()}>
          <p class="text-sm">{reasonOf(props.activity.error)}</p>
        </Card>
      }
    >
      <Card title="耕作日历" action={aside()}>
        <div class="grid grid-cols-4 gap-6">
          <Stat label="一年里" value={worked() ? `${number(streaks().total)} 次提交` : "…"} />
          <Stat label="动过土的日子" value={worked() ? `${streaks().days} 天` : "…"} />
          <Stat label="最长连着干" value={worked() ? `${streaks().longest} 天` : "…"} />
          <Stat label="最近连着干" value={worked() ? `${streaks().current} 天` : "…"} />
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
              aria-label={worked() ? `过去一年 ${streaks().total} 次提交，${streaks().days} 天动过土` : "在读提交"}
              class="mt-1 flex"
              onMouseLeave={() => setPointed(undefined)}
            >
              <div class="flex w-5 flex-col" style={{ gap: `${tileGap}px` }}>
                <For each={["", "一", "", "三", "", "五", ""]}>
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
            少
            <For each={levelName}>
              {(n, l) => (
                <span title={n}>
                  <Icon name={`day-${l()}`} size={tile} />
                </span>
              )}
            </For>
            多
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
      <Card title="谁来干过活" action={<span class="text-xs text-muted">过去一年的提交</span>}>
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
                    {(a) => <AgentFace agentId={a().id} look={a().look} size={32} />}
                  </Show>
                  <div class="flex min-w-0 flex-1 flex-col gap-1">
                    <span class="flex text-sm">
                      <span class="min-w-0 flex-1 truncate font-medium">{author.name}</span>
                      <span class="text-xs text-muted">{number(author.commits)} 次</span>
                    </span>
                    <Bar share={author.commits / top()} color="#74a046" />
                  </div>
                </div>
              );
            }}
          </For>
        </div>
        <Show when={rest() > 0}>
          <p class="text-xs text-muted">
            还有 {authors().length - hands} 位，一共 {number(rest())} 次。
          </p>
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
          label="怎么来"
          value={importing()}
          options={[
            { value: "new", label: "开一块新地", disabled: busy() },
            { value: "github", label: "去别人家看看", disabled: busy() },
          ]}
          onChange={(v) => {
            setImporting(v);
            setError(undefined);
          }}
        />
      </div>
      <Show when={importing() === "github"}>
        <Field label="GitHub 地址" hint="公开仓库的主页地址。下载到本地后，就能查看项目和安排帮工。">
          <TextInput
            ref={autofocus()}
            aria-label="GitHub 地址"
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
      <Field label="项目名" hint="保存在工作目录里；已有同名项目不会被覆盖。">
        <TextInput
          aria-label="项目名"
          disabled={busy()}
          placeholder="比如 raft-source"
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
        <p class="text-sm text-muted">{importing() === "github" ? "正在下载仓库… 大仓库需要多等一会儿，最多 3 分钟。" : "正在开地…"}</p>
      </Show>
      <div class="flex justify-end gap-2 pt-2">
        <Button disabled={busy()} onClick={() => props.onDone()}>
          取消
        </Button>
        <Button type="submit" tone="primary" disabled={!canSubmit()}>
          {busy() ? "进行中…" : importing() === "github" ? "下载到农场" : "创建项目"}
        </Button>
      </div>
    </form>
  );
}
